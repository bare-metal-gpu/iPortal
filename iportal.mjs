#!/usr/bin/env bun
import {
  awaitInitialPairedDiscovery,
  createPairedMonitor,
  selectDevice,
} from "./paired-devices.ts";
import { Schema } from "effect";
import { StatusSchema } from "./public-contracts.ts";
import { createClipboard } from "./clipboard.ts";
// iportal: control your iPhone from your computer.
// The owned XCTest helper provides commands, inspection, and fallback video.
// USB forwarding talks to usbmuxd directly, so no iproxy / libimobiledevice is needed.

import net from "node:net";
import os from "node:os";
import path from "node:path";
import { loadIPortalHTML } from "./web-assets.mjs";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { parseArgs } from "node:util";
import { apiError, errorInfo } from "./errors.mjs";
import { createInspection } from "./inspection.ts";
import { createKeepAwake } from "./keep-awake.mjs";
import { createIPortalStatus } from "./iportal-status.mjs";
import { randomUUID } from "node:crypto";
import { createScheduler } from "./scheduler.ts";
import { createCommands } from "./commands.ts";
import { parseNamedRequest, executeAction } from "./schemas.ts";
import { startServer } from "./server.mjs";
import { createDispatch } from "./command-dispatch.mjs";
import { pinchPaths } from "./pinch.mjs";
import { createUSBMonitor } from "./usb-events.ts";
import { createStatusEvents } from "./status-events.ts";
import { createStartupLock } from "./startup-lock.mjs";
import { claimDevice, canonicalUDID } from "./device-runtime.mjs";
import { deviceBuild, runtimeCommand, statePath } from "./runtime-paths.mjs";
import {
  prepareHelperCommand,
  confirmHelperInstallation,
  forgetHelperInstallation,
} from "./helper-launch.mjs";
import { startupFailure } from "./helper-startup.ts";
import { createHelperAuthentication } from "./helper-auth.mjs";
import { createHelperClient } from "./helper-client.ts";
import { readHelperBuild } from "./helper-build.mjs";
import { createHelperLifecycle, unansweredProbe } from "./helper-lifecycle.ts";
import { startupTrace } from "./startup-trace.ts";
import { observability } from "./observability.ts";

const instanceId = randomUUID();
startupTrace("server-entered");
const helperLifecycle = createHelperLifecycle(instanceId);
const helperAuth = createHelperAuthentication();
const { values: opts, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    port: { type: "string", default: "7100" },
    udid: { type: "string" },
    "helper-url": { type: "string" },
    "helper-port": { type: "string", default: "8100" },
    first: { type: "boolean", default: false },
    "no-open": { type: "boolean", default: false },
    "no-autostart": { type: "boolean", default: false },
    managed: { type: "boolean", default: false },
    owner: { type: "string" },
    "device-kind": { type: "string", default: "iPhone" },
    platform: { type: "string", default: "ios" },
    watch: { type: "boolean", default: false },
  },
});
if (opts.platform === "android") {
  // Android has its own device layer and helper; it shares everything above
  // them. This call serves until the process exits, so nothing below runs.
  const { runAndroid } = await import("./android/server.mjs");
  await runAndroid(opts, positionals);
} else if (opts.platform !== "ios") throw new Error("Unknown platform");

const HELPER_PORT = Number(opts["helper-port"]);
if (!Number.isInteger(HELPER_PORT) || HELPER_PORT < 1 || HELPER_PORT > 65535)
  throw new Error("Invalid helper port");
const MANUAL = Boolean(opts["helper-url"]);
const HELPER_URL = (opts["helper-url"] ?? `http://127.0.0.1:${HELPER_PORT}`).replace(/\/$/, "");
const MJPEG = HELPER_URL + "/v1/video";
/** @type {string | undefined} */
let helperSocket;
if (!Bun.semver.satisfies(Bun.version, ">=1.4.4")) throw new Error("Bun 1.4.4+ is required");
if (opts.managed && (!opts.udid || !opts.owner))
  throw new Error("Managed sessions require a device and owner");

// ---------- usbmuxd ----------

const USBMUXD = process.env.USBMUXD_SOCKET_ADDRESS || "/var/run/usbmuxd";

/** @param {Record<string, string | number>} d */
const plist = (d) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>` +
  Object.entries(d)
    .map(
      ([k, v]) =>
        `<key>${k}</key>` +
        (typeof v === "number" ? `<integer>${v}</integer>` : `<string>${v}</string>`),
    )
    .join("") +
  `</dict></plist>\n`;

/** @param {string} xml @param {string} key */
const plistValue = (xml, key) =>
  xml.match(new RegExp(`<key>${key}</key>\\s*<(?:integer|string)>([^<]*)<`))?.[1];

/** @returns {Promise<net.Socket>} */
function muxOpen() {
  return new Promise((resolve, reject) => {
    const sock = net.connect(USBMUXD);
    sock.once("connect", () => resolve(sock));
    sock.once("error", reject);
  });
}

/** @param {net.Socket} sock @param {Record<string,string|number>} dict */
function muxSend(sock, dict) {
  const body = Buffer.from(plist({ ClientVersionString: "iportal", ProgName: "iportal", ...dict }));
  const head = Buffer.alloc(16);
  head.writeUInt32LE(16 + body.length, 0);
  head.writeUInt32LE(1, 4); // protocol version: plist
  head.writeUInt32LE(8, 8); // message type: plist
  head.writeUInt32LE(1, 12); // tag
  sock.write(Buffer.concat([head, body]));
}

// Reads exactly one usbmuxd message without putting the socket into flowing mode,
// so after a Connect the raw tunnel bytes stay buffered for pipe().
/** @param {net.Socket} sock @returns {Promise<string>} */
function muxRead(sock) {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const onReadable = () => {
      let chunk;
      while ((chunk = sock.read()) !== null) buf = Buffer.concat([buf, chunk]);
      if (buf.length < 4 || buf.length < buf.readUInt32LE(0)) return;
      const len = buf.readUInt32LE(0);
      cleanup();
      if (buf.length > len) sock.unshift(buf.subarray(len));
      resolve(buf.subarray(16, len).toString());
    };
    /** @param {Error} e */
    const onError = (e) => (cleanup(), reject(e));
    const onEnd = () => (cleanup(), reject(new Error("usbmuxd closed the connection")));
    const cleanup = () => {
      sock.off("readable", onReadable);
      sock.off("error", onError);
      sock.off("end", onEnd);
    };
    sock.on("readable", onReadable);
    sock.on("error", onError);
    sock.on("end", onEnd);
  });
}

async function listDevices() {
  const sock = await muxOpen();
  try {
    muxSend(sock, { MessageType: "ListDevices" });
    const xml = await muxRead(sock);
    return [...xml.matchAll(/<key>Properties<\/key>\s*<dict>([\s\S]*?)<\/dict>/g)].map(([, p]) => ({
      id: Number(plistValue(p, "DeviceID")),
      udid: canonicalUDID(plistValue(p, "SerialNumber") ?? ""),
      connection: plistValue(p, "ConnectionType") ?? "Unknown",
    }));
  } finally {
    sock.destroy();
  }
}

let pinnedUdid = opts.udid ? canonicalUDID(opts.udid) : null;
/** @type {string[]} */
let connectedUsbUdids = [];
/** @type {ReturnType<typeof createUSBMonitor> | undefined} */
let usbMonitor;
/** @type {ReturnType<typeof createPairedMonitor> | undefined} */
let pairedMonitor;
const pairedDiscoveryStartedAt = Date.now();
/** @type {ReturnType<typeof selectDevice>} */
let selectedDevice = null;
let lastControlSuccess = 0;
let reconcileConnection = () => {};
/** @param {import("./usb-events.ts").USBDevice[]} devices */
function chooseDevice(devices) {
  return selectDevice(devices, pairedMonitor?.devices() ?? [], pinnedUdid, {
    previous: selectedDevice,
    retainPaired: pairedMonitor?.health() !== "ready" && Date.now() - lastControlSuccess < 5000,
  });
}
/** @type {Promise<void> | undefined} */
let deviceLease;
async function ensureDeviceLease() {
  if (pinnedUdid && !deviceLease) {
    deviceLease = claimDevice(pinnedUdid).then((release) => {
      process.on("exit", release);
    });
  }
  await deviceLease;
}
async function pickDevice() {
  const devices = (await (usbMonitor ? usbMonitor.devices() : listDevices())).map((d) => ({
    ...d,
    udid: canonicalUDID(d.udid),
  }));
  connectedUsbUdids = [
    ...new Set(devices.filter((d) => d.connection === "USB").map((d) => d.udid)),
  ];
  const device = chooseDevice(devices);
  if (!pinnedUdid) pinnedUdid = device?.udid ?? null;
  await ensureDeviceLease();
  return device;
}

/** @param {number} deviceId @param {number} port */
async function muxConnect(deviceId, port) {
  const sock = await muxOpen();
  muxSend(sock, {
    MessageType: "Connect",
    DeviceID: deviceId,
    PortNumber: ((port & 0xff) << 8) | (port >> 8),
  });
  const code = Number(plistValue(await muxRead(sock), "Number"));
  if (code !== 0) {
    sock.destroy();
    throw new Error(
      code === 3
        ? `nothing is listening on device port ${port}`
        : `usbmuxd connect failed (${code})`,
    );
  }
  return sock;
}

/** @param {string} host @param {number} port */
async function pairedConnect(host, port) {
  const socket = net.connect({ host, port });
  const timer = setTimeout(() => socket.destroy(new Error("Paired connection timed out")), 3000);
  try {
    await once(socket, "connect");
    return socket;
  } finally {
    clearTimeout(timer);
  }
}

// Private Unix socket -> device port. Keep device endpoints unreachable by browsers;
// only the guarded API may expose a TCP listener on the Mac.
/** @type {Set<net.Socket>} */
const tunnels = new Set();
/** @param {string} socketPath @param {number} devicePort */
async function forward(socketPath, devicePort) {
  /** @param {net.Socket} client */
  const connect = async (client) => {
    client.pause();
    client.on("error", () => {});
    try {
      const dev = await pickDevice();
      if (!dev) throw new Error("no device");
      const generation = transport.signal;
      const remote = dev.address
        ? await pairedConnect(dev.address, devicePort)
        : await muxConnect(Number(dev.id), devicePort);
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
  const server = net.createServer((client) => {
    void connect(client);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => resolve(undefined));
  });
  return socketPath;
}

// ---------- iPortal helper ----------

let quality = "balanced";
let transport = new AbortController();
const helper = createHelperClient({
  url: HELPER_URL,
  socket: () => helperSocket,
  authentication: helperAuth,
  expectedBuild: readHelperBuild(deviceBuild) ?? "native-1",
  onGeneration: () => inspection.invalidateObservations(),
});
let replacedIncompatibleHelper = false;
let confirmedHelperInstallation = false;
/** @param {AbortSignal} [signal] @param {import("./status-events.ts").StatusProbe} [probe] */
const helperUp = async (signal, probe) => {
  try {
    const wasReady = helperLifecycle.state.phase === "ready";
    const state = await helper.status(signal);
    helperLifecycle.observe(state);
    if (state.automationReady && !confirmedHelperInstallation && pinnedUdid && !MANUAL) {
      confirmHelperInstallation(pinnedUdid);
      confirmedHelperInstallation = true;
    }
    if (!wasReady && state.automationReady && state.locked === false) startupTrace("helper-ready");
    if (state.automationReady) {
      helperStartup?.end();
      helperStartup = null;
    }
    if (state.phase === "blocked") {
      restartHelper();
      return false;
    }
    return state.automationReady === true || state.locked === true;
  } catch (error) {
    if (!signal?.aborted) helperLifecycle.unavailable();
    // Silence from a helper that was verified, and that nothing here has since
    // restarted, stopped or seen exit, may be one slow probe. The status stream
    // decides whether to wait for a second; every other failure is published.
    if (
      !signal?.aborted &&
      unansweredProbe(error) &&
      ["ready", "locked"].includes(helperLifecycle.state.phase)
    )
      probe?.missed();
    if (errorInfo(error).code === "incompatible helper" && !MANUAL && !replacedIncompatibleHelper) {
      replacedIncompatibleHelper = true;
      forceHelperInstall = true;
      restartHelper();
    }
    return false;
  }
};
const scheduler = createScheduler();
const enqueue = scheduler.enqueue;
/** @param {import("./helper-protocol.ts").HelperArguments<"touch">["points"]} points @param {number} end @param {{expectedBundleId?:string,expectedOrientation?:import("./helper-protocol.ts").HelperResult<"orientation">}} [guards] */
const gesture = (points, end, guards = {}) => helper.command("touch", { points, end, ...guards });
/** @param {import("./schemas.ts").RequestBody<"pinch">} body */
async function pinch(body) {
  if (body.scale === 1) return;
  if (!(await helper.ready()).capabilities.multiTouch)
    throw apiError("Multi-touch is unavailable", 501, "unsupported operation");
  return helper.command("touch", {
    ...pinchPaths(body),
    expectedBundleId: body.expectedApp,
    expectedOrientation: body.expectedOrientation,
  });
}

/** @type {Record<import("./schemas.ts").RequestBody<"shortcut">["name"], {points:[number,number,number][],end:number}>} */
const SHORTCUTS = {
  switcher: {
    points: [
      [0.5, 0.998, 0],
      [0.5, 0.75, 250],
      [0.5, 0.6, 500],
    ],
    end: 1300,
  },
  control: {
    points: [
      [0.93, 0.004, 0],
      [0.93, 0.45, 250],
    ],
    end: 300,
  },
  notifications: {
    points: [
      [0.3, 0.004, 0],
      [0.3, 0.6, 250],
    ],
    end: 300,
  },
  spotlight: {
    points: [
      [0.5, 0.3, 0],
      [0.5, 0.55, 200],
    ],
    end: 250,
  },
};

/** @type {import("./schemas.ts").ActionHandlers} */
const actions = {
  key: async (body) => {
    const copying =
      body.modifiers?.includes("command") && ["c", "x"].includes(body.key.toLowerCase());
    const before = copying ? (await helper.command("clipboardStatus")).changeCount : null;
    await helper.command("key", {
      key: body.key,
      modifiers: body.modifiers ?? [],
      ...inputGuards(body),
    });
    if (!copying) return;
    const after = (await helper.command("clipboardStatus")).changeCount;
    return {
      clipboardChanged:
        Number.isSafeInteger(before) && Number.isSafeInteger(after) && after !== before,
    };
  },
  pinch,
  gesture: (body) =>
    gesture(body.points, body.end, {
      expectedBundleId: body.expectedApp,
      expectedOrientation: body.expectedOrientation,
    }),
  shortcut: (body) =>
    gesture(SHORTCUTS[body.name].points, SHORTCUTS[body.name].end, {
      expectedBundleId: body.expectedApp,
      expectedOrientation: body.expectedOrientation,
    }),
  type: (body) =>
    body.id || body.selector
      ? inspection.type(body)
      : helper.command("text", { text: body.text, ...inputGuards(body) }),
  tap: (body) => inspection.tap(body),
  "element-action": (body) => inspection.elementAction(body),
  home: (body) => helper.command("home", inputGuards(body)),
  button: (body) => helper.command("button", { name: body.name, ...inputGuards(body) }),
  lock: (body) => helper.command("lock", inputGuards(body)),
  unlock: (body) => helper.command("unlock", inputGuards(body)),
  launch: (body) => helper.command("launch", { bundleId: body.bundleId, ...inputGuards(body) }),
  "open-url": (body) => helper.command("openURL", { url: body.url, ...inputGuards(body) }),
  siri: (body) => helper.command("siri", { text: body.text, ...inputGuards(body) }),
  // Called when the UI opens, so opening the mirror turns automation back on if it was stopped.
  ensure: async () => {
    if (!(await automationAllowed())) restartHelper();
  },
  quality: ({ level }) => {
    quality = level;
    return helper.command("quality", { preset: level });
  },
};
/** @param {{expectedApp?:string,expectedOrientation?:import("./helper-protocol.ts").HelperResult<"orientation">}} body */
const inputGuards = (body) => ({
  expectedBundleId: body.expectedApp,
  expectedOrientation: body.expectedOrientation,
});

// ---------- Auto-start the helper on macOS ----------

/** @type {import("node:child_process").ChildProcessWithoutNullStreams | null} */
let helperProcess = null;
/** @type {AbortController | null} */
let helperPreparation = null;
/** @type {ReturnType<typeof observability.startSpan> | null} */
let helperStartup = null;
/** @type {string | null} */
let helperProblem = null;
let forceHelperInstall = false;
let repairedHelperInstall = false;
let shuttingDown = false;
const startupLock = createStartupLock({ changed: () => statusEvents.invalidate() });
/** @param {string} udid @param {string | number} connectionID @param {string} [address] */
async function maybeStartHelper(udid, connectionID, address) {
  if (awaitInitialPairedDiscovery(pairedMonitor?.health(), Date.now() - pairedDiscoveryStartedAt))
    return;
  if (
    shuttingDown ||
    helperProcess ||
    helperPreparation ||
    !helperLifecycle.canLaunch ||
    opts["no-autostart"] ||
    MANUAL ||
    process.platform !== "darwin" ||
    startupLock.value({ udid, id: connectionID }) === true
  )
    return;
  if (!fs.existsSync(deviceBuild)) return;
  const ticket = helperLifecycle.begin();
  if (!ticket) return;
  helperStartup?.end("interrupted");
  const startup = (helperStartup = observability.startSpan("helper.startup"));
  startupTrace("helper-prepare-start");
  const preparation = new AbortController();
  helperPreparation = preparation;
  let prepared;
  try {
    prepared = await startup.run(() =>
      observability.promise("helper.prepare", () =>
        prepareHelperCommand(udid, {
          signal: AbortSignal.any([preparation.signal, AbortSignal.timeout(9000)]),
          forceInstall: forceHelperInstall,
        }),
      ),
    );
  } catch (error) {
    startup.end(preparation.signal.aborted ? "interrupted" : "failure");
    if (!preparation.signal.aborted && helperLifecycle.owns(ticket)) {
      helperLifecycle.failed(ticket, startupFailure(error instanceof Error ? error.message : ""));
      statusEvents.invalidate();
    }
    return;
  } finally {
    if (helperPreparation === preparation) helperPreparation = null;
  }
  // A route change or close while inventory was in flight must not launch an
  // obsolete runner. The new owner will prepare against its own endpoint.
  if (preparation.signal.aborted || shuttingDown || !helperLifecycle.owns(ticket)) {
    startup.end("interrupted");
    return;
  }
  if (startupLock.value({ udid, id: connectionID }) === true) {
    startup.end("failure");
    helperLifecycle.failed(ticket, startupFailure("device is locked"));
    statusEvents.invalidate();
    return;
  }
  forceHelperInstall = false;
  const logPath = statePath(`helper-${udid}.log`);
  const log = fs.openSync(
    logPath,
    fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW,
    0o600,
  );
  fs.fchmodSync(log, 0o600);
  startup.run(() => startupTrace("helper-launch", { mode: prepared.mode }));
  const [executable, ...args] = runtimeCommand("--owned-command", ...prepared.command);
  const child = spawn(executable, args, {
    env: {
      ...process.env,
      UDID: udid,
      TEST_RUNNER_USE_IP: address ?? "127.0.0.1",
      TEST_RUNNER_IPORTAL_PAIRED: address ? "1" : "0",
      TEST_RUNNER_IPORTAL_AUTOMATION: "1",
      ...helperAuth.runnerEnvironment,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  helperProcess = child;
  helperLifecycle.launched(ticket, prepared.mode === "install");
  child.stdin.on("error", () => {});
  let tail = "";
  let timedOut = false;
  let stopping = false;
  const deadline = setInterval(() => {
    if (stopping || helperProcess !== child || !helperLifecycle.timedOut(ticket)) return;
    stopping = timedOut = true;
    // Keep ownership until the supervisor has reaped its launcher. Never
    // overlap a replacement with a launch that merely exceeded our deadline.
    child.stdin.end();
    child.kill();
  }, 500);
  const redactors = [helperAuth.redactor(), helperAuth.redactor()];
  /** @param {ReturnType<typeof helperAuth.redactor>} redactor @returns {(chunk:Buffer|string)=>void} */
  const output = (redactor) => (chunk) => {
    const text = redactor.write(chunk);
    fs.writeSync(log, text);
    tail = (tail + text).slice(-16384);
    if (
      helperProcess === child &&
      helperLifecycle.owns(ticket) &&
      /device is locked|DeviceLocked/i.test(text)
    ) {
      startupLock.reset();
      statusEvents.invalidate();
    }
  };
  child.stdout.on("data", output(redactors[0]));
  child.stderr.on("data", output(redactors[1]));
  child.on("error", (error) => {
    tail = (tail + error.message).slice(-16384);
  });
  child.on("close", () => {
    startup.end("failure");
    clearInterval(deadline);
    for (const redactor of redactors) {
      const text = redactor.end();
      fs.writeSync(log, text);
      tail = (tail + text).slice(-16384);
    }
    fs.closeSync(log);
    if (helperProcess !== child) return;
    helperProcess = null;
    if (!helperLifecycle.owns(ticket)) return;
    helperAuth.reset();
    helper.retire();
    if (helperLifecycle.state.phase === "recovering") {
      helperLifecycle.exit(ticket);
      statusEvents.invalidate();
      return;
    }
    let failure = startupFailure(tail, timedOut);
    if (!["locked", "developer"].includes(failure.kind)) {
      forgetHelperInstallation(udid);
      confirmedHelperInstallation = false;
    }
    if (failure.kind === "locked" && startupLock.value({ udid, id: connectionID }) === false)
      failure = startupFailure("", timedOut);
    if (
      prepared.mode === "installed" &&
      (failure.kind === "verification" || failure.kind === "artifacts") &&
      !repairedHelperInstall
    ) {
      // Same-version re-signing can leave an expired copy on the phone. Repair
      // once, never repeatedly reinstall an already trusted build.
      repairedHelperInstall = forceHelperInstall = true;
    }
    helperLifecycle.failed(ticket, failure);
    observability.event("helper-ended", { reason: failure.kind }, "Warning");
    statusEvents.invalidate();
  });
}
/** @param {{udid:string, id:string|number, address?:string}} device */
function startHelper(device) {
  void maybeStartHelper(device.udid, device.id, device.address).catch(() => {
    helperProblem = "Finish setting up iPortal on your Mac.";
    statusEvents.invalidate();
  });
}
process.on("exit", () => helperProcess?.kill());

// Holding both volume buttons on the iPhone stops automation: the helper keeps running but every input fails with
// XCTest error 41. Restarting the helper asks iOS for automation again (and brings back its "Automation Running" banner).
const NOT_AUTHORIZED = /Code=41|Not authorized for performing UI testing/;

function restartHelper() {
  if (helperLifecycle.state.phase === "recovering" || shuttingDown) return;
  if (!helperLifecycle.recover()) {
    helperProblem = "Reconnect your iPhone.";
    return;
  }
  observability.event("helper-restarting");
  if (helperProcess) {
    const child = helperProcess;
    const shutdown = helper.command("shutdown", {}, { timeout: 750 });
    helper.retire();
    void shutdown.catch(() => {}).finally(() => child.kill());
  } else {
    helper.retire();
    void pickDevice()
      .then((device) => {
        if (device) startHelper(device);
      })
      .catch(() => {});
  }
  // The next status poll sees the helper down and starts it again.
}

// Without automation the helper can't see any app, so the foreground app comes back as pid 0.
async function automationAllowed() {
  try {
    return (await helper.status()).automationReady !== false;
  } catch {
    return true;
  }
}
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  observability.event("server-stopping");
  helperStartup?.end("interrupted");
  helperLifecycle.stop();
  helperPreparation?.abort();
  keepAwake.stop("mirror closed");
  portalStatus.stop();
  stopHelperEvents();
  statusEvents.stop();
  usbMonitor?.stop();
  pairedMonitor?.stop();
  if (helperProcess) await helper.command("shutdown", {}, { timeout: 750 }).catch(() => {});
  transport.abort(apiError("Mirror closed", 409, "session closed"));
  for (const tunnel of tunnels) tunnel.destroy();
  // Retain the per-device lease until its owned test launcher has exited. A
  // quick close/reopen cannot race an old launcher tearing down the new runner.
  const child = helperProcess;
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = once(child, "exit");
    const timer = setTimeout(() => child.kill("SIGKILL"), 2000);
    child.stdin.end();
    child.kill();
    try {
      await exited;
    } finally {
      clearTimeout(timer);
    }
  }
  await observability.close();
  process.exit();
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

// ---------- HTTP server ----------

/** @param {AbortSignal} [signal] @param {import("./status-events.ts").StatusProbe} [probe] */
async function status(signal, probe) {
  const observedAt = Date.now();
  /** @type {Awaited<ReturnType<typeof pickDevice>>} */
  let device = null;
  /** @type {string | null} */
  let error = null;
  if (!MANUAL) {
    try {
      device = await pickDevice();
      if (!device) error = "Connect your iPhone and tap Trust if asked.";
    } catch {
      error = "Reconnect your iPhone.";
    }
  }
  signal?.throwIfAborted();
  // Launch preparation is owner-scoped, not tied to a cancellable status read.
  // A missing helper's event reconnects can invalidate probes faster than their
  // timeout; waiting for a failed probe first could starve startup entirely.
  if (!MANUAL && device && !helper.cached && process.platform === "darwin") {
    startupLock.observe(device);
    startHelper(device);
  }
  const up = (MANUAL || device) && (await helperUp(signal, probe));
  if (up) lastControlSuccess = Date.now();
  else {
    lastControlSuccess = 0;
    if (
      selectedDevice?.connection === "Paired" &&
      pairedMonitor?.health() !== "ready" &&
      !pairedMonitor?.devices().length
    )
      queueMicrotask(reconcileConnection);
  }
  if (!MANUAL && process.platform === "darwin" && !up) startupLock.observe(device);
  let locked = !MANUAL && device ? startupLock.value(device) : null;
  helperLifecycle.lockObserved(locked);
  if (up) {
    try {
      const value = helper.cached?.locked;
      if (typeof value !== "boolean") throw new Error("Invalid lock state");
      locked = value;
      if (locked) keepAwake.stop("locked");
    } catch {
      error = "Waiting for your iPhone…";
    }
  }
  signal?.throwIfAborted();
  if (up) {
    helperProblem = null;
    startupLock.reset();
  }
  /** @type {import('./helper-protocol.ts').HelperResult<'orientation'> | null} */
  let orientation = null;
  if (device?.connection === "Paired" && up && locked === false) {
    try {
      const value = await helper.command("orientation", {}, { timeout: 1200, signal });
      if (
        [
          "PORTRAIT",
          "LANDSCAPE",
          "UIA_DEVICE_ORIENTATION_LANDSCAPERIGHT",
          "UIA_DEVICE_ORIENTATION_PORTRAIT_UPSIDEDOWN",
        ].includes(value)
      )
        orientation = value;
    } catch {
      /* Keep the last confirmed frame orientation during a transient query failure. */
    }
  }
  if (device && !up) {
    startHelper(device);
    const problem = helperProblem ?? helperLifecycle.problem?.message;
    error = problem
      ? problem
      : helperProcess || (fs.existsSync(deviceBuild) && !opts["no-autostart"])
        ? null
        : "Finish setting up iPortal on your Mac.";
  } else if (MANUAL && !up) error = "Reconnect your iPhone.";
  const lifecycle =
    !MANUAL && !device
      ? "disconnected"
      : locked === true
        ? "locked"
        : up && locked === false
          ? "ready"
          : "connecting";
  if (opts["device-kind"] === "iPad" && error)
    error = error.replaceAll(/iPhone(?! iPortal)/g, "iPad");
  return {
    service: "iportal",
    apiVersion: 2,
    instanceId,
    observedAt,
    ok: Boolean(up),
    device,
    pinnedUdid,
    locked,
    lifecycle,
    orientation,
    displayPixels: up ? (helper.cached?.displayPixels ?? null) : null,
    captureIdentity: {
      singleUsbDevice: Boolean(
        pinnedUdid && connectedUsbUdids.length === 1 && connectedUsbUdids[0] === pinnedUdid,
      ),
    },
    error,
    quality,
    queue: scheduler.stats(),
    keepAwake: keepAwake.status(),
  };
}

// ---------- CLI ----------

if (positionals[0] === "devices") {
  const devices = await listDevices().catch((e) => {
    console.error(`can't reach usbmuxd: ${e.message}`);
    process.exit(1);
  });
  if (opts.first) {
    const d = devices.find((d) => d.connection === "USB") ?? devices[0];
    if (!d) process.exit(1);
    console.log(d.udid);
  } else if (!devices.length) console.log("no devices");
  else for (const d of devices) console.log(`${d.udid}  ${d.connection}`);
  process.exit(0);
}

const clipboard = createClipboard({ helper });
const inspection = createInspection({ helper, enqueue });
const keepAwake = createKeepAwake({ helper, enqueue: (fn) => scheduler.maintenance(fn) });
const portalStatus = createIPortalStatus({ helper, keepAwake: keepAwake.status });
const statusEvents = createStatusEvents({
  read: async (signal, probe) =>
    Schema.decodeUnknownSync(StatusSchema)(await status(signal, probe)),
});
let contentRevision = 0;
const contentChanged = () => statusEvents.patch({ contentRevision: ++contentRevision });
let stopHelperEvents = () => {};
process.on("exit", () => portalStatus.stop());
/** @type {ReturnType<typeof createCommands> | undefined} */
let commands;
const commandLedger = () =>
  (commands ??= createCommands({
    file:
      process.env.IPORTAL_COMMANDS_FILE ??
      statePath(
        opts.udid
          ? `commands-${canonicalUDID(opts.udid)}.json`
          : opts.port === "7100"
            ? "commands.json"
            : `commands-${opts.port}.json`,
      ),
  }));

const dispatch = createDispatch({
  instanceId,
  transportSignal: () => transport.signal,
  statusEvents,
  commandLedger,
  parse: parseNamedRequest,
  execute: (name, body) => executeAction(actions, name, body),
  portalStatus,
  keepAwake,
  enqueue,
  inspection,
  clipboard,
  helper,
  lockedMessage: "Unlock your iPhone",
  onFailure(failure) {
    if (failure.code === "automation denied" || NOT_AUTHORIZED.test(failure.message)) {
      keepAwake.stop("automation unavailable");
      restartHelper();
    }
  },
  contentChanged,
});

if (!MANUAL) {
  if (pinnedUdid) {
    await ensureDeviceLease();
  }
  // /tmp keeps paths within Darwin's Unix-socket length limit. mkdtemp is
  // atomic and creates mode 0700, so another user cannot pre-create a link.
  const directory = fs.mkdtempSync(
    path.join(process.platform === "darwin" ? "/tmp" : os.tmpdir(), "iportal-usb-"),
  );
  process.on("exit", () => fs.rmSync(directory, { recursive: true, force: true }));
  helperSocket = await forward(path.join(directory, "helper.sock"), HELPER_PORT);
}
startServer({
  port: +opts.port,
  instanceId,
  html: loadIPortalHTML(),
  mjpeg: MJPEG,
  mjpegSocket: helperSocket,
  helperAuth,
  dispatch,
  statusEvents,
  identity: opts.owner ? { owner: opts.owner, pinnedUdid } : {},
  fallbackPort: opts.managed,
  onListening: (port) => {
    startupTrace("server-listening");
    const url = `http://localhost:${port}`;
    if (opts.managed)
      console.log(
        JSON.stringify({ event: "iportal-listening", owner: opts.owner, udid: pinnedUdid, port }),
      );
    console.log(`\n  iPortal running at ${url}\n`);
    if (process.platform === "darwin" && !opts["no-open"])
      spawn("open", [url], { stdio: "ignore" });
  },
});
if (!MANUAL) {
  /** @type {string | number | null | undefined} */
  let observedDeviceID;
  /** @type {import("./usb-events.ts").USBDevice[]} */
  let usbInventory = [];
  const onDevicesChanged = () => {
    let devices = usbInventory;
    devices = devices.map((d) => ({ ...d, udid: canonicalUDID(d.udid) }));

    connectedUsbUdids = [
      ...new Set(devices.filter((d) => d.connection === "USB").map((d) => d.udid)),
    ];
    const device = chooseDevice(devices);
    if (observedDeviceID !== (device?.id ?? null))
      startupTrace("server-device-selected", {
        connection: device?.connection ?? "unavailable",
        pairedHealth: pairedMonitor?.health() ?? "starting",
      });
    if (!pinnedUdid) pinnedUdid = device?.udid ?? null;
    if (!device) {
      keepAwake.stop("disconnected");
      startupLock.reset();
    }
    if (observedDeviceID === (device?.id ?? null)) {
      selectedDevice = device;
      statusEvents.invalidate();
      return;
    }
    if (observedDeviceID !== undefined) {
      helperPreparation?.abort();
      helperLifecycle.routeChanged();
      transport.abort(apiError("Device connection changed", 409, "device changed"));
      transport = new AbortController();
      helperAuth.reset();
      for (const tunnel of tunnels) tunnel.destroy();
      if (helperProcess && device?.address !== observedAddress) {
        helperProcess.stdin.end();
        helperProcess.kill();
      }
      helper.reset();
    }
    selectedDevice = device;
    observedDeviceID = device?.id ?? null;
    observedAddress = device?.address;
    statusEvents.invalidate({
      device,
      pinnedUdid,
      observedAt: Date.now(),
      ok: false,
      locked: null,
      lifecycle: device ? "connecting" : "disconnected",
      captureIdentity: {
        singleUsbDevice: connectedUsbUdids.length === 1 && connectedUsbUdids[0] === pinnedUdid,
      },
    });
  };
  /** @type {string | undefined} */
  let observedAddress;
  reconcileConnection = onDevicesChanged;
  pairedMonitor = createPairedMonitor(onDevicesChanged);
  usbMonitor = createUSBMonitor({
    address: USBMUXD,
    list: listDevices,
    onChange(devices) {
      usbInventory = devices;
      onDevicesChanged();
    },
  });
  process.on("exit", () => {
    usbMonitor?.stop();
    pairedMonitor?.stop();
  });
}
stopHelperEvents = helper.watch(() => statusEvents.invalidate());
void statusEvents.refresh();
process.on("exit", () => statusEvents.stop());
