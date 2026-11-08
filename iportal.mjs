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
import { commandContext, createScheduler } from "./scheduler.ts";
import { createCommands } from "./commands.ts";
import { parseNamedRequest, executeAction } from "./schemas.ts";
import { errorResponse, startServer } from "./server.mjs";
import { pinchPaths } from "./pinch.mjs";
import { createUSBMonitor } from "./usb-events.ts";
import { createStatusEvents } from "./status-events.ts";
import { createStartupLock } from "./startup-lock.mjs";
import { claimDevice, canonicalUDID } from "./device-runtime.mjs";
import { deviceBuild, runtimeCommand, statePath } from "./runtime-paths.mjs";
import { helperCommand } from "./helper-launch.mjs";
import { createHelperAuthentication } from "./helper-auth.mjs";
import { createHelperClient } from "./helper-client.ts";
import { readHelperBuild } from "./helper-build.mjs";
import { createHelperLifecycle } from "./helper-lifecycle.ts";

const instanceId = randomUUID();
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
  },
});

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
/** @param {AbortSignal} [signal] */
const helperUp = async (signal) => {
  try {
    const state = await helper.status(signal);
    helperLifecycle.observe(state);
    if (state.phase === "blocked") {
      restartHelper();
      return false;
    }
    return state.automationReady === true || state.locked === true;
  } catch (error) {
    if (errorInfo(error).code === "incompatible helper" && !MANUAL && !replacedIncompatibleHelper) {
      replacedIncompatibleHelper = true;
      restartHelper();
    }
    return false;
  }
};
const scheduler = createScheduler();
const enqueue = scheduler.enqueue;
/** @param {import("./helper-protocol.ts").HelperArguments<"touch">["points"]} points @param {number} end @param {{expectedBundleId?:string,expectedOrientation?:import("./helper-protocol.ts").HelperResult<"orientation">}} [guards] */
const gesture = (points, end, guards = {}) => helper.command("touch", { points, end, ...guards });
const supportsGuardedTouch = async () => (await helper.ready()).capabilities.touch;
const supportsMultiTouch = async () => (await helper.ready()).capabilities.multiTouch;
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

// Launch failures that need the user to do something on the phone or Mac. Every launch reinstalls the helper, which
// also hides the trust entry in Settings for a moment, so these back off instead of retrying right away.
/** @type {[RegExp, string][]} */
const HELPER_PROBLEMS = [
  [
    /not trusted|explicitly trusted/,
    "On your iPhone: Settings → General → VPN & Device Management → your Apple ID → Trust.",
  ],
  [
    /cannot be installed on this device|doesn't include the currently selected device/,
    "Finish setting up iPortal on your Mac.",
  ],
  [
    /Developer Mode is (disabled|not enabled)|enable Developer Mode/i,
    "On your iPhone, turn on Developer Mode in Settings → Privacy & Security.",
  ],
  [/device is locked|DeviceLocked/i, "Unlock your iPhone."],
];

/** @type {import("node:child_process").ChildProcessWithoutNullStreams | null} */
let helperProcess = null;
/** @type {string | null} */
let helperProblem = null;
let helperRetryAt = 0;
/** @type {string | null} */
let launchLockedDevice = null;
let shuttingDown = false;
const startupLock = createStartupLock({ changed: () => statusEvents.invalidate() });
/** @param {string} udid @param {string | number} connectionID @param {string} [address] */
function maybeStartHelper(udid, connectionID, address) {
  // Select the migratable endpoint before binding a helper to legacy loopback.
  // Only the first snapshot is awaited; unsupported hosts proceed immediately.
  if (awaitInitialPairedDiscovery(pairedMonitor?.health(), Date.now() - pairedDiscoveryStartedAt))
    return;
  if (
    shuttingDown ||
    helperProcess ||
    Date.now() < helperRetryAt ||
    opts["no-autostart"] ||
    MANUAL ||
    process.platform !== "darwin"
  )
    return;
  if (!fs.existsSync(deviceBuild)) return;
  let command;
  try {
    command = helperCommand(udid);
  } catch {
    helperProblem = "Finish setting up iPortal on your Mac.";
    helperRetryAt = Date.now() + 30000;
    return;
  }
  const logPath = statePath(`helper-${udid}.log`);
  const from = fs.existsSync(logPath) ? fs.statSync(logPath).size : 0;
  const log = fs.openSync(
    logPath,
    fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW,
    0o600,
  );
  fs.fchmodSync(log, 0o600);
  console.log(`  starting iPortal helper on ${udid}`);
  const [executable, ...args] = runtimeCommand("--owned-command", ...command);
  helperProblem = null;
  const ticket = helperLifecycle.begin();
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
  child.stdin.on("error", () => {});
  let tail = "";
  const redactors = [helperAuth.redactor(), helperAuth.redactor()];
  /** @param {ReturnType<typeof helperAuth.redactor>} redactor @returns {(chunk:Buffer|string)=>void} */
  const output = (redactor) => (chunk) => {
    const text = redactor.write(chunk);
    fs.writeSync(log, text);
    tail = (tail + text).slice(-4096);
    if (
      helperProcess === child &&
      helperLifecycle.owns(ticket) &&
      /device is locked|DeviceLocked/i.test(tail)
    ) {
      launchLockedDevice = `${udid}:${connectionID}`;
      helperProblem = "Unlock your iPhone.";
      statusEvents.invalidate();
      tail = "";
    }
  };
  child.stdout.on("data", output(redactors[0]));
  child.stderr.on("data", output(redactors[1]));
  child.on("close", () => {
    for (const redactor of redactors) fs.writeSync(log, redactor.end());
    fs.closeSync(log);
  });
  child.on("exit", () => {
    if (helperProcess !== child || !helperLifecycle.exit(ticket)) return;
    helperProcess = null;
    helperAuth.reset();
    helper.reset();
    const output = fs.readFileSync(logPath).subarray(from).toString();
    helperProblem = HELPER_PROBLEMS.find(([re]) => re.test(output))?.[1] ?? null;
    helperRetryAt = Date.now() + (helperProblem ? 30000 : 3000);
    if (helperProblem) console.log(`  ${helperProblem} (retrying in 30 s)`);
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
  console.log("  restarting iPortal helper");
  helper.reset();
  if (helperProcess) {
    const child = helperProcess;
    void helper
      .command("shutdown", {}, { timeout: 750 })
      .catch(() => {})
      .finally(() => child.kill());
  } else {
    helperRetryAt = 0;
    void pickDevice()
      .then((device) => {
        if (device) maybeStartHelper(device.udid, device.id, device.address);
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
  helperLifecycle.stop();
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
  process.exit();
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

// ---------- HTTP server ----------

/** @param {AbortSignal} [signal] */
async function status(signal) {
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
  const up = (MANUAL || device) && (await helperUp(signal));
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
  let locked =
    !MANUAL && device
      ? launchLockedDevice === `${device.udid}:${device.id}`
        ? true
        : startupLock.value(device)
      : null;
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
    launchLockedDevice = null;
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
    maybeStartHelper(device.udid, device.id, device.address);
    error = helperProblem
      ? helperProblem
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
  read: async (signal) => Schema.decodeUnknownSync(StatusSchema)(await status(signal)),
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

/** @param {string} rawName @param {unknown} rawBody @param {AbortSignal} [signal] */
async function dispatch(rawName, rawBody, signal) {
  // A command submitted before detach must never execute after reattachment.
  signal = signal ? AbortSignal.any([signal, transport.signal]) : transport.signal;
  const started = performance.now();
  if (rawName === "status") return { status: 200, body: await statusEvents.refresh() };
  if (rawName === "command-status") {
    if (
      !rawBody ||
      typeof rawBody !== "object" ||
      !("requestId" in rawBody) ||
      typeof rawBody.requestId !== "string"
    )
      throw apiError("Missing request ID");
    const value = commandLedger().get(rawBody.requestId);
    return {
      status: value ? 200 : 404,
      body: value
        ? { ok: true, value }
        : { ok: false, code: "not found", error: "Unknown request ID" },
    };
  }
  const { name, body } = parseNamedRequest(rawName, rawBody);
  if (name === "presence") {
    portalStatus.receive(body);
    return { status: 200, body: { ok: true } };
  }
  if (name === "keep-awake")
    return { status: 200, body: { ok: true, value: await keepAwake.configure(body) } };
  if (name === "clipboard-read" || name === "clipboard-write") {
    // Clipboard contents never enter the command receipt cache or disk ledger.
    const value = await commandContext.run(
      { signal, deadline: performance.now() + 25000, operationTimeoutMs: 25000, priority: 5 },
      () =>
        enqueue(async () => {
          inspection.invalidateObservations();
          const value = await clipboard.transfer(
            name === "clipboard-write" ? { operation: "write", ...body } : { operation: "read" },
          );
          keepAwake.activity();
          return value;
        }),
    );
    return { status: 200, body: { ok: true, value, meta: { instanceId } } };
  }
  const timeoutMs =
    ("timeoutMs" in body ? body.timeoutMs : undefined) ?? (name === "wait" ? 10000 : 15000);
  const deadline = performance.now() + timeoutMs;
  if (
    name === "state" ||
    name === "elements" ||
    name === "element" ||
    name === "source" ||
    name === "screenshot" ||
    name === "observe" ||
    name === "wait"
  ) {
    const value = await commandContext.run(
      { signal, deadline, operationTimeoutMs: timeoutMs },
      () => {
        switch (name) {
          case "state":
            return inspection.state(body, signal);
          case "elements":
            return inspection.elements(body, signal);
          case "element":
            return inspection.element(body, signal);
          case "source":
            return inspection.source(body, signal);
          case "screenshot":
            return inspection.screenshot(body, signal);
          case "observe":
            return inspection.observe(body, signal);
          case "wait":
            return inspection.wait(body, signal);
        }
      },
    );
    return {
      status: 200,
      body: { ok: true, value, meta: { instanceId, observedAt: new Date().toISOString() } },
    };
  }
  const requestId = body.requestId ?? randomUUID();
  return commandLedger().execute(requestId, { name, body }, async (mark) => {
    if (name === "lock") keepAwake.stop("lock requested");
    let dispatched = false,
      executed = false;
    let nativeStarted = 0,
      nativeCompleted = 0;
    /** @type {{queueMs?:number,preflightMs?:number,actionMs?:number,totalMs?:number,native?:unknown}} */
    const timing = {};
    let clipboardChanged;
    const onDispatch = () => {
      nativeStarted++;
      if (!dispatched) {
        dispatched = true;
        mark("running");
        inspection.invalidateObservations();
      }
    };
    try {
      await commandContext.run(
        {
          signal,
          deadline,
          onDispatch,
          onComplete: () => {
            nativeCompleted++;
          },
          priority: 5,
          operationTimeoutMs:
            ("timeoutMs" in body ? body.timeoutMs : undefined) ??
            Math.max(8000, (("end" in body ? body.end : undefined) ?? 0) + 2000),
        },
        async () => {
          await enqueue(async () => {
            timing.queueMs = Math.round(performance.now() - started);
            const nativeGuards =
              ["type", "key", "tap", "element-action", "home", "button", "launch", "siri"].includes(
                name,
              ) ||
              (name === "pinch"
                ? await supportsMultiTouch()
                : ["gesture", "shortcut"].includes(name) && (await supportsGuardedTouch()));
            if (!nativeGuards && !["unlock", "lock", "ensure", "quality"].includes(name)) {
              if ((await helper.status()).locked)
                throw apiError("Unlock your iPhone", 409, "device locked");
            }
            if (!nativeGuards && body.expectedApp) {
              const active = await helper.command("app");
              if (active.bundleId !== body.expectedApp)
                throw apiError("Foreground app changed", 409, "app changed");
            }
            if (
              !nativeGuards &&
              body.expectedOrientation &&
              (await helper.command("orientation")) !== body.expectedOrientation
            )
              throw apiError("Screen orientation changed", 409, "orientation changed");
            if (body.observationId) await inspection.verifyObservation(body.observationId, signal);
            signal?.throwIfAborted();
            const actionStarted = performance.now();
            timing.preflightMs = Math.round(actionStarted - started - (timing.queueMs ?? 0));
            const result = await executeAction(actions, name, body);
            timing.actionMs = Math.round(performance.now() - actionStarted);
            if (result && "timing" in result) timing.native = result.timing;
            if (
              result &&
              "clipboardChanged" in result &&
              typeof result.clipboardChanged === "boolean"
            )
              clipboardChanged = result.clipboardChanged;
            executed = true;
            if (
              [
                "gesture",
                "pinch",
                "shortcut",
                "tap",
                "element-action",
                "type",
                "key",
                "home",
                "button",
              ].includes(name)
            )
              keepAwake.activity();
          });
          if (body.waitFor) await inspection.wait(body.waitFor, signal);
        },
      );
      timing.totalMs = Math.round(performance.now() - started);
      return {
        status: 200,
        body: {
          ok: true,
          requestId,
          outcome: body.waitFor ? "verified" : "executed",
          verified: Boolean(body.waitFor),
          timing,
          ...(clipboardChanged !== undefined ? { clipboardChanged } : {}),
        },
      };
    } catch (e) {
      const failure = errorInfo(e);
      const result = errorResponse(e);
      result.body = {
        ...result.body,
        requestId,
        outcome:
          executed ||
          (nativeCompleted > 0 &&
            (nativeStarted === nativeCompleted || failure.outcome === "notExecuted"))
            ? "executed"
            : failure.outcome === "notExecuted" || !dispatched
              ? "not executed"
              : "unknown",
        verified: false,
      };
      if (failure.code === "automation denied" || NOT_AUTHORIZED.test(failure.message)) {
        keepAwake.stop("automation unavailable");
        restartHelper();
      }
      return result;
    } finally {
      // Include uncertain outcomes: pixels may have changed even when the
      // response was lost. The event never replays the input.
      if (dispatched) contentChanged();
    }
  });
}

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
    if (!pinnedUdid) pinnedUdid = device?.udid ?? null;
    if (!device) {
      keepAwake.stop("disconnected");
      startupLock.reset();
      launchLockedDevice = null;
    }
    if (observedDeviceID === (device?.id ?? null)) {
      selectedDevice = device;
      statusEvents.invalidate();
      return;
    }
    if (observedDeviceID !== undefined) {
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
