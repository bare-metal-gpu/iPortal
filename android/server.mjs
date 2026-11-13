// iPortal for an Android device. This composes the same server, queue, receipts,
// inspection, clipboard, keep-awake and status pipeline as the iPhone path. What
// is Android's own lives here: adb for discovery and tunnels, and a helper that
// is pushed and started with app_process instead of being built and signed.
import net from "node:net";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { createHash, randomUUID } from "node:crypto";
import { Schema } from "effect";
import { StatusSchema } from "../public-contracts.ts";
import { apiError } from "../errors.mjs";
import { createClipboard } from "../clipboard.ts";
import { createInspection } from "../inspection.ts";
import { createKeepAwake } from "../keep-awake.mjs";
import { createIPortalStatus } from "../iportal-status.mjs";
import { createScheduler } from "../scheduler.ts";
import { createCommands } from "../commands.ts";
import { startServer } from "../server.mjs";
import { createDispatch } from "../command-dispatch.mjs";
import { pinchPaths } from "../pinch.mjs";
import { createStatusEvents } from "../status-events.ts";
import { claimDevice } from "../device-runtime.mjs";
import { packaged, sourceRoot, statePath } from "../runtime-paths.mjs";
import { createHelperAuthentication } from "../helper-auth.mjs";
import { createHelperClient } from "../helper-client.ts";
import { unansweredProbe } from "../helper-lifecycle.ts";
import { loadIPortalHTML } from "../web-assets.mjs";
import { observability } from "../observability.ts";
import { createAdb } from "./adb.mjs";
import { attachmentProblem, createAndroidMonitor, selectAndroidDevice } from "./devices.mjs";
import {
  AndroidRequestSchemas,
  androidHelperProtocol,
  androidStrategies,
  executeAndroidAction,
  parseAndroidRequest,
  validateAndroidResponse,
} from "./protocol.ts";

const REMOTE_DIRECTORY = "/data/local/tmp";
const agentJar =
  process.env.IPORTAL_ANDROID_AGENT ??
  (packaged
    ? path.resolve(path.dirname(process.execPath), "../Resources/Android/iportal-agent.jar")
    : path.join(sourceRoot, "vendor/android/iportal-agent.jar"));

/** @param {string} serial */
const validSerial = (serial) => /^[A-Za-z0-9._-]{1,64}$/.test(serial);

// The Android gesture for each navigation shortcut the mirror offers. On the
// iPhone these are edge swipes; Android has a button or system command for each.
/** @type {Record<string, "appSwitch" | "quickSettings" | "notifications" | "search">} */
const SHORTCUT_BUTTONS = {
  switcher: "appSwitch",
  control: "quickSettings",
  notifications: "notifications",
  spotlight: "search",
};

/**
 * Prints the Android inventory as one JSON line per change, for the Mac app's
 * device list. One phone on two transports is one entry. Runs until ended; the
 * Mac app starts it under the lifetime supervisor, which ends it with its owner.
 * @param {ReturnType<typeof createAdb>} adb
 */
async function watchInventory(adb) {
  let last = "";
  /** @type {ReturnType<typeof createAndroidMonitor> | undefined} */
  let monitor;
  const emit = () => {
    /** @type {Map<string, {serial: string, name: string, transport: "usb" | "wifi", usb: boolean}>} */
    const phones = new Map();
    for (const device of monitor?.devices() ?? []) {
      const known = phones.get(device.udid);
      const usb = device.transport === "usb" || known?.usb === true;
      phones.set(device.udid, {
        serial: device.udid,
        name: device.model ?? known?.name ?? "Android",
        transport: usb ? "usb" : "wifi",
        usb,
      });
    }
    const line = JSON.stringify({ version: 1, adb: adb.available, devices: [...phones.values()] });
    if (line === last) return;
    last = line;
    process.stdout.write(`${line}\n`);
  };
  // The first line is the inventory as found, which the Mac app treats as
  // already-present devices rather than new connections. Print it only once
  // adb has answered, so it is never an empty placeholder.
  if (adb.available) {
    await adb.startServer().catch(() => {});
    monitor = createAndroidMonitor({ adb, pinned: () => null, onChange: emit });
  } else emit();
  await new Promise(() => {});
}

/**
 * Runs until the process exits.
 * @param {{port: string, udid?: string, "no-open": boolean, "no-autostart": boolean, managed: boolean, owner?: string, first: boolean, watch: boolean}} opts
 * @param {string[]} positionals
 */
export async function runAndroid(opts, positionals) {
  const adb = createAdb();
  if (positionals[0] === "devices") {
    if (opts.watch && !adb.available) return watchInventory(adb);
    if (!adb.available) {
      console.error("adb is not installed. Install Android platform-tools.");
      process.exit(1);
    }
    if (opts.watch) return watchInventory(adb);
    await adb.startServer().catch(() => {});
    const transports = await adb.devices().catch(() => []);
    if (!transports.length) console.log("no devices");
    for (const transport of transports)
      console.log(`${transport.id}  ${transport.state}${transport.usb ? "  USB" : "  Network"}`);
    process.exit(0);
  }
  if (opts.udid && !validSerial(opts.udid)) throw new Error("Invalid device identity");
  if (opts.managed && (!opts.udid || !opts.owner))
    throw new Error("Managed sessions require a device and owner");

  const instanceId = randomUUID();
  const helperAuth = createHelperAuthentication();
  const token = helperAuth.runnerEnvironment.TEST_RUNNER_IPORTAL_HELPER_TOKEN;
  const socketName = `iportal_${instanceId.replaceAll("-", "").slice(0, 16)}`;
  let pinned = opts.udid ?? null;
  let transport = new AbortController();
  let quality = "balanced";
  let shuttingDown = false;
  // Ends the long-lived HTTP responses (status events, video) when the server
  // closes, so an open mirror page cannot hold the process and its device lease.
  const closing = new AbortController();
  /** @type {string | null} */
  let problem = adb.available
    ? null
    : "Install Android platform-tools (adb) on your Mac, then reopen iPortal.";

  /** @type {Promise<void> | undefined} */
  let lease;
  /** @type {string | null} */
  let leaseProblem = null;
  const ensureLease = async () => {
    if (pinned && !lease) {
      // Device leases are keyed by a fixed-shape name; Android serials vary.
      const key = `android-${createHash("sha256").update(pinned).digest("hex").slice(0, 32)}`;
      const claim = claimDevice(key).then(
        (release) => {
          process.on("exit", release);
          leaseProblem = null;
        },
        (error) => {
          // Another server may be closing. Do not remember the refusal: the
          // next status read asks again.
          if (lease === claim) lease = undefined;
          leaseProblem = "This device already has a mirror session.";
          throw error;
        },
      );
      lease = claim;
    }
    await lease;
  };

  // ---- device route ----

  /** @type {ReturnType<typeof createAndroidMonitor> | undefined} */
  let monitor;
  const pick = async () => {
    const device = selectAndroidDevice(monitor?.devices() ?? [], pinned);
    if (!pinned && device) pinned = device.udid;
    await ensureLease();
    return device;
  };

  /** @type {Set<net.Socket>} */
  const tunnels = new Set();
  // A private Unix socket on the Mac, piped to the helper's socket on the
  // device. Device endpoints stay unreachable by browsers.
  /** @param {string} socketPath */
  const forward = async (socketPath) => {
    /** @param {net.Socket} client */
    const connect = async (client) => {
      client.pause();
      client.on("error", () => {});
      try {
        const device = await pick();
        if (!device) throw new Error("no device");
        const generation = transport.signal;
        const remote = await adb.connect(device.id, `localabstract:${socketName}`);
        if (generation.aborted || client.destroyed) {
          remote.destroy();
          client.destroy();
          return;
        }
        tunnels.add(client);
        client.on("close", () => tunnels.delete(client));
        remote.on("error", () => client.destroy());
        client.on("close", () => remote.destroy());
        remote.on("close", () => client.destroy());
        client.pipe(remote).pipe(client);
      } catch {
        client.destroy();
      }
    };
    const server = net.createServer((client) => void connect(client));
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => resolve(undefined));
    });
    return socketPath;
  };

  // ---- helper ----

  const helper = createHelperClient({
    url: "http://android-helper",
    socket: () => helperSocket,
    authentication: helperAuth,
    protocol: androidHelperProtocol,
    onGeneration: () => inspection.invalidateObservations(),
  });
  const scheduler = createScheduler();
  const enqueue = scheduler.enqueue;

  /** @type {Promise<void> | null} */
  let launching = null;
  /** When the helper was first found unreachable, or 0 while it answers. */
  let downSince = 0;
  let retryAt = 0;
  let failures = 0;
  /** Set once this server has ended a helper, until the next one answers. */
  let replaced = false;
  // The helper is not installed: one small file is pushed to temporary storage
  // and run as the adb shell user. It outlives the adb connection that started
  // it, so a cable pull does not end the session.
  /** @param {import("./devices.mjs").AndroidDevice} device */
  const launchHelper = async (device) => {
    if (!fs.existsSync(agentJar)) {
      problem = "Build the Android helper: run `bun run setup:android`.";
      throw new Error("missing helper");
    }
    const digest = createHash("sha256").update(fs.readFileSync(agentJar)).digest("hex");
    const remote = `${REMOTE_DIRECTORY}/iportal-agent-${digest.slice(0, 16)}.jar`;
    /** @param {string[]} args @param {{input?: string}} [options] */
    const shell = (args, options) => adb.run(["-s", device.id, "shell", ...args], options);
    const present = await shell([`[ -f ${remote} ] && echo present || echo absent`]);
    if (!present.includes("present")) {
      await shell([`rm -f ${REMOTE_DIRECTORY}/iportal-agent-*.jar`]);
      await adb.run(["-s", device.id, "push", agentJar, remote], { timeoutMs: 30000 });
    }
    // A failed probe is not a dead helper. While this server's own helper is
    // still running, a brief route problem must not restart it: that would
    // discard a healthy session. Only a helper that stays unreachable is replaced.
    const mine = await shell([`pgrep -f "[i]portal.Agent --socket ${socketName}" || true`]);
    if (mine.trim() && Date.now() - downSince < 20000) return;
    observability.event("helper-launch", { replacing: Boolean(mine.trim()) });
    replaced = true;
    // One helper per device: a previous server's helper may still be running.
    // The pattern's bracket keeps this shell's own command line from matching.
    await shell(['pkill -f "[i]portal.Agent" ; true']);
    // The credential arrives on standard input, never on a command line.
    await shell(
      [
        // `read` must run in the foreground: a background job's input is /dev/null.
        `read -r IPORTAL_HELPER_TOKEN || exit 1; export IPORTAL_HELPER_TOKEN; CLASSPATH=${remote} ` +
          `nohup app_process / iportal.Agent --socket ${socketName} ` +
          `>${REMOTE_DIRECTORY}/iportal-agent.log 2>&1 &`,
      ],
      { input: `${token}\n` },
    );
  };
  /** @param {import("./devices.mjs").AndroidDevice} device */
  const ensureHelper = (device) => {
    if (launching || shuttingDown || opts["no-autostart"] || Date.now() < retryAt || !adb.available)
      return;
    const span = observability.startSpan("helper.startup");
    launching = span
      .run(() => observability.promise("helper.prepare", () => launchHelper(device)))
      .then(
        () => {
          failures = 0;
          // Give the new process a moment to bind before the next launch check.
          retryAt = Date.now() + 2500;
          span.end();
        },
        (error) => {
          retryAt = Date.now() + (++failures >= 3 ? 15000 : 1500);
          problem ??= "Reconnect your Android device.";
          void error; // Diagnostics carry enumerated values only, never error text.
          observability.event("helper-ended", { reason: "transient" }, "Warning");
          span.end("failure");
        },
      )
      .finally(() => {
        launching = null;
        statusEvents.invalidate();
      });
  };

  /** @param {AbortSignal} [signal] @param {import("../status-events.ts").StatusProbe} [probe] */
  const helperUp = async (signal, probe) => {
    try {
      const state = await helper.status(signal);
      downSince = 0;
      replaced = false;
      return state.automationReady === true || state.locked === true;
    } catch (error) {
      if (!signal?.aborted) {
        // Silence from a helper this server has not replaced may be one slow
        // probe. The status stream decides whether to wait for a second.
        if (unansweredProbe(error) && !replaced) probe?.missed();
        if (!downSince) observability.event("helper-unreachable", {}, "Warning");
        downSince ||= Date.now();
      }
      return false;
    }
  };

  /** @param {{expectedApp?: string, expectedOrientation?: import("../public-contracts.ts").PublicStatus["orientation"] & string}} body */
  const guards = (body) => ({
    expectedBundleId: body.expectedApp,
    expectedOrientation: body.expectedOrientation,
  });
  /** @type {import("./protocol.ts").AndroidActionHandlers} */
  const actions = {
    key: async (body) => {
      const copying =
        body.modifiers?.includes("command") && ["c", "x"].includes(body.key.toLowerCase());
      const before = copying ? (await helper.command("clipboardStatus")).changeCount : null;
      await helper.command("key", {
        key: body.key,
        modifiers: body.modifiers ?? [],
        ...guards(body),
      });
      if (!copying) return;
      // Android reports a clipboard change shortly after the key is handled.
      for (let attempt = 0; attempt < 8; attempt++) {
        if ((await helper.command("clipboardStatus")).changeCount !== before)
          return { clipboardChanged: true };
        await sleep(25);
      }
      return { clipboardChanged: false };
    },
    pinch: async (body) => {
      if (body.scale === 1) return;
      return helper.command("touch", { ...pinchPaths(body), ...guards(body) });
    },
    gesture: (body) =>
      helper.command("touch", { points: body.points, end: body.end, ...guards(body) }),
    shortcut: (body) => button(SHORTCUT_BUTTONS[body.name], body),
    type: (body) =>
      body.id || body.selector
        ? inspection.type(/** @type {never} */ (body))
        : helper.command("text", { text: body.text, ...guards(body) }),
    tap: (body) => inspection.tap(/** @type {never} */ (body)),
    "element-action": (body) => inspection.elementAction(/** @type {never} */ (body)),
    home: (body) => helper.command("home", guards(body)),
    button: (body) => button(body.name, body),
    lock: (body) => helper.command("lock", guards(body)),
    unlock: (body) => helper.command("unlock", guards(body)),
    launch: (body) => helper.command("launch", { bundleId: body.bundleId, ...guards(body) }),
    "open-url": (body) => helper.command("openURL", { url: body.url, ...guards(body) }),
    ensure: async () => {},
    quality: ({ level }) => {
      quality = level;
      return helper.command("quality", { preset: level });
    },
  };
  // The Android button set is wider than the shared client type knows.
  /** @param {string} name @param {Parameters<typeof guards>[0]} body */
  const button = (name, body) =>
    /** @type {(operation: string, args: object) => Promise<unknown>} */ (helper.command)(
      "button",
      { name, ...guards(body) },
    );

  // ---- status ----

  /** @param {AbortSignal} [signal] @param {import("../status-events.ts").StatusProbe} [probe] */
  async function status(signal, probe) {
    const observedAt = Date.now();
    const device = await pick().catch(() => null);
    /** @type {string | null} */
    let error = null;
    if (!device)
      error =
        leaseProblem ??
        (adb.available ? null : problem) ??
        attachmentProblem(monitor?.transports() ?? []) ??
        "Connect your Android device and turn on USB debugging.";
    signal?.throwIfAborted();
    const up = Boolean(device) && (await helperUp(signal, probe));
    signal?.throwIfAborted();
    let locked = null;
    /** @type {import("../public-contracts.ts").PublicStatus["orientation"]} */
    let orientation = null;
    if (up) {
      problem = null;
      locked = helper.cached?.locked ?? null;
      if (locked) keepAwake.stop("locked");
      if (locked === false) {
        try {
          orientation = await helper.command("orientation", {}, { timeout: 1200, signal });
        } catch {
          /* Keep the last confirmed frame orientation during a transient failure. */
        }
      }
    } else if (device) {
      ensureHelper(device);
      error = problem;
    }
    return {
      service: "iportal",
      apiVersion: 2,
      platform: "android",
      instanceId,
      observedAt,
      ok: up,
      device: device && {
        id: device.id,
        udid: device.udid,
        connection: device.connection,
        transport: device.transport,
      },
      pinnedUdid: pinned,
      locked,
      lifecycle: !device
        ? "disconnected"
        : locked === true
          ? "locked"
          : up && locked === false
            ? "ready"
            : "connecting",
      orientation,
      displayPixels: up ? (helper.cached?.displayPixels ?? null) : null,
      // Android has no Mac capture device; video always comes from the helper.
      captureIdentity: { singleUsbDevice: false },
      error,
      quality,
      queue: scheduler.stats(),
      keepAwake: keepAwake.status(),
    };
  }

  const clipboard = createClipboard({ helper });
  const inspection = createInspection({ helper, enqueue, strategies: new Set(androidStrategies) });
  const keepAwake = createKeepAwake({ helper, enqueue: (fn) => scheduler.maintenance(fn) });
  const portalStatus = createIPortalStatus({ helper, keepAwake: keepAwake.status });
  const statusEvents = createStatusEvents({
    read: async (signal, probe) =>
      Schema.decodeUnknownSync(StatusSchema)(await status(signal, probe)),
  });
  let contentRevision = 0;
  /** @type {ReturnType<typeof createCommands> | undefined} */
  let commands;
  const dispatch = createDispatch({
    instanceId,
    transportSignal: () => transport.signal,
    statusEvents,
    commandLedger: () =>
      (commands ??= createCommands({
        file:
          process.env.IPORTAL_COMMANDS_FILE ??
          statePath(
            opts.udid
              ? `commands-android-${createHash("sha256").update(opts.udid).digest("hex").slice(0, 24)}.json`
              : `commands-android-${opts.port}.json`,
          ),
      })),
    parse: /** @type {never} */ (parseAndroidRequest),
    execute: (name, body) =>
      /** @type {Promise<import("../schemas.ts").ActionResult>} */ (
        executeAndroidAction(actions, name, body)
      ),
    portalStatus,
    keepAwake,
    enqueue,
    inspection,
    clipboard,
    helper,
    lockedMessage: "Unlock your Android device",
    onFailure() {},
    contentChanged: () => statusEvents.patch({ contentRevision: ++contentRevision }),
  });

  // ---- lifetime ----

  let stopHelperEvents = () => {};
  async function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    observability.event("server-stopping");
    keepAwake.stop("mirror closed");
    portalStatus.stop();
    stopHelperEvents();
    statusEvents.stop();
    closing.abort();
    monitor?.stop();
    // The helper would exit by itself once nothing talks to it; ending it now
    // releases the device's automation connection immediately.
    if (helper.cached) await helper.command("shutdown", {}, { timeout: 750 }).catch(() => {});
    transport.abort(apiError("Mirror closed", 409, "session closed"));
    for (const tunnel of tunnels) tunnel.destroy();
    // Receipts are already durable: an unfinished command is marked unknown by
    // the next server. Nothing else is worth holding the lease for.
    await observability.close(1000);
    process.exit();
  }
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  // With an explicit device, a second session must fail at once, as on iPhone.
  if (pinned) await ensureLease();
  // /tmp keeps paths within Darwin's Unix-socket length limit. mkdtemp is
  // atomic and creates mode 0700, so another user cannot pre-create a link.
  const directory = fs.mkdtempSync(
    path.join(process.platform === "darwin" ? "/tmp" : os.tmpdir(), "iportal-adb-"),
  );
  process.on("exit", () => fs.rmSync(directory, { recursive: true, force: true }));
  const helperSocket = await forward(path.join(directory, "helper.sock"));

  startServer({
    port: +opts.port,
    instanceId,
    // The page is shared. The mark lets it name the device correctly and show
    // the controls Android has (Back) instead of the ones it lacks (Siri).
    html: loadIPortalHTML().replace(
      "<head>",
      '<head><meta name="iportal-platform" content="android">',
    ),
    mjpeg: "http://android-helper/v1/video",
    mjpegSocket: helperSocket,
    helperAuth,
    dispatch,
    statusEvents,
    closing: closing.signal,
    identity: opts.owner
      ? { owner: opts.owner, pinnedUdid: pinned, platform: "android" }
      : { platform: "android" },
    fallbackPort: opts.managed,
    requests: AndroidRequestSchemas,
    validateResponse: validateAndroidResponse,
    onListening: (port) => {
      const url = `http://localhost:${port}`;
      if (opts.managed)
        console.log(
          JSON.stringify({
            event: "iportal-listening",
            owner: opts.owner,
            udid: pinned,
            port,
            platform: "android",
          }),
        );
      console.log(`\n  iPortal (Android) running at ${url}\n`);
      if (process.platform === "darwin" && !opts["no-open"])
        spawn("open", [url], { stdio: "ignore" });
    },
  });

  if (adb.available) {
    await adb.startServer().catch(() => {
      problem = "adb could not start. Check your Android platform-tools installation.";
    });
    /** @type {string | null | undefined} */
    let observedRoute;
    monitor = createAndroidMonitor({
      adb,
      pinned: () => pinned,
      onChange() {
        const device = selectAndroidDevice(monitor?.devices() ?? [], pinned);
        if (!pinned && device) pinned = device.udid;
        if (!device) keepAwake.stop("disconnected");
        const route = device?.id ?? null;
        if (observedRoute === route) {
          statusEvents.invalidate();
          return;
        }
        if (observedRoute !== undefined) {
          // The route changed, not the helper: it keeps running on the device and
          // keeps its generation, so the session continues over the new route.
          transport.abort(apiError("Device connection changed", 409, "device changed"));
          transport = new AbortController();
          for (const tunnel of tunnels) tunnel.destroy();
          helper.reset();
          observability.event("server-device-selected", {
            connection: device?.connection ?? "unavailable",
          });
        }
        observedRoute = route;
        statusEvents.invalidate({
          device: device && {
            id: device.id,
            udid: device.udid,
            connection: device.connection,
            transport: device.transport,
          },
          pinnedUdid: pinned,
          observedAt: Date.now(),
          ok: false,
          locked: null,
          lifecycle: device ? "connecting" : "disconnected",
        });
      },
    });
    process.on("exit", () => monitor?.stop());
  }
  stopHelperEvents = helper.watch(() => statusEvents.invalidate());
  void statusEvents.refresh();
  process.on("exit", () => statusEvents.stop());
  await new Promise(() => {});
}
