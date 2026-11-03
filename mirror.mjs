#!/usr/bin/env node
// iphone-mirror: control your iPhone from your computer.
// Video comes from WebDriverAgent's MJPEG stream, input goes back through WDA's W3C actions API.
// USB forwarding talks to usbmuxd directly, so no iproxy / libimobiledevice is needed.

import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { apiError, createInspection } from "./inspection.mjs";
import { createKeepAwake } from "./keep-awake.mjs";
import { createPortalStatus } from "./portal-status.mjs";
import { randomUUID } from "node:crypto";
import { commandContext, createScheduler } from "./scheduler.mjs";
import { createCommands } from "./commands.mjs";
import { ActionSchemas } from "./schemas.mjs";
import { errorResponse, startServer } from "./server.mjs";
import { pinchActions, pinchPaths } from "./pinch.mjs";
import { createUSBMonitor } from "./usb-events.mjs";
import { createStatusEvents } from "./status-events.mjs";
import { createStartupLock } from "./startup-lock.mjs";

const instanceId = randomUUID();
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const { values: opts, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    port: { type: "string", default: "7100" },
    udid: { type: "string" },
    wda: { type: "string" }, // e.g. http://192.168.1.20:8100 to skip USB and go over WiFi
    "wda-port": { type: "string", default: "8100" },
    "mjpeg-port": { type: "string", default: "9100" },
    first: { type: "boolean", default: false },
    "no-open": { type: "boolean", default: false },
    "no-autostart": { type: "boolean", default: false },
  },
});

const WDA_PORT = +opts["wda-port"];
const MJPEG_PORT = +opts["mjpeg-port"];
const MANUAL = Boolean(opts.wda);
const WDA = (opts.wda ?? `http://127.0.0.1:${WDA_PORT}`).replace(/\/$/, "");
const MJPEG = MANUAL ? `${new URL(WDA).protocol}//${new URL(WDA).hostname}:${MJPEG_PORT}` : `http://127.0.0.1:${MJPEG_PORT}`;

// ---------- usbmuxd ----------

const USBMUXD = process.env.USBMUXD_SOCKET_ADDRESS || "/var/run/usbmuxd";

const plist = (d) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>` +
  Object.entries(d)
    .map(([k, v]) => `<key>${k}</key>` + (typeof v === "number" ? `<integer>${v}</integer>` : `<string>${v}</string>`))
    .join("") +
  `</dict></plist>\n`;

const plistValue = (xml, key) => xml.match(new RegExp(`<key>${key}</key>\\s*<(?:integer|string)>([^<]*)<`))?.[1];

function muxOpen() {
  return new Promise((resolve, reject) => {
    const sock = net.connect(USBMUXD);
    sock.once("connect", () => resolve(sock));
    sock.once("error", reject);
  });
}

function muxSend(sock, dict) {
  const body = Buffer.from(plist({ ClientVersionString: "iphone-mirror", ProgName: "iphone-mirror", ...dict }));
  const head = Buffer.alloc(16);
  head.writeUInt32LE(16 + body.length, 0);
  head.writeUInt32LE(1, 4); // protocol version: plist
  head.writeUInt32LE(8, 8); // message type: plist
  head.writeUInt32LE(1, 12); // tag
  sock.write(Buffer.concat([head, body]));
}

// Reads exactly one usbmuxd message without putting the socket into flowing mode,
// so after a Connect the raw tunnel bytes stay buffered for pipe().
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
      id: +plistValue(p, "DeviceID"),
      udid: plistValue(p, "SerialNumber"),
      connection: plistValue(p, "ConnectionType"),
    }));
  } finally {
    sock.destroy();
  }
}

let pinnedUdid = opts.udid ?? null;
let connectedUsbUdids = [];
let usbMonitor;
async function pickDevice() {
  const devices = await (usbMonitor ? usbMonitor.devices() : listDevices());
  connectedUsbUdids = [...new Set(devices.filter(d => d.connection === "USB").map(d => d.udid))];
  if (!pinnedUdid) pinnedUdid = devices.find(d => d.connection === "USB")?.udid ?? null;
  return devices.find(d => d.udid === pinnedUdid && d.connection === "USB") ?? null;
}

async function muxConnect(deviceId, port) {
  const sock = await muxOpen();
  muxSend(sock, { MessageType: "Connect", DeviceID: deviceId, PortNumber: ((port & 0xff) << 8) | (port >> 8) });
  const code = +plistValue(await muxRead(sock), "Number");
  if (code !== 0) {
    sock.destroy();
    throw new Error(code === 3 ? `nothing is listening on device port ${port}` : `usbmuxd connect failed (${code})`);
  }
  return sock;
}

// Local TCP port -> device port, like iproxy.
function forward(localPort, devicePort) {
  const server = net.createServer(async (client) => {
    client.pause();
    client.on("error", () => {});
    try {
      const dev = await pickDevice();
      if (!dev) throw new Error("no device");
      const remote = await muxConnect(dev.id, devicePort);
      remote.on("error", () => client.destroy());
      client.on("close", () => remote.destroy());
      remote.on("close", () => client.destroy());
      client.pipe(remote).pipe(client);
    } catch {
      client.destroy();
    }
  });
  server.on("error", (e) => {
    console.error(`  ! could not listen on 127.0.0.1:${localPort}: ${e.message}`);
    process.exit(1);
  });
  server.listen(localPort, "127.0.0.1");
}

// ---------- WebDriverAgent ----------

async function wda(method, p, body, timeout = 8000, signal, headers = {}) {
  const context = commandContext.getStore();
  if (context?.signal) signal = signal ? AbortSignal.any([signal, context.signal]) : context.signal;
  signal?.throwIfAborted();
  if (context?.deadline !== undefined) timeout = Math.min(timeout, Math.ceil(context.deadline - performance.now()));
  if (timeout <= 0) throw apiError("Command deadline expired", 408, "timeout");
  if (method === "POST" && /\/(?:actions|click|value)$|\/wda\/(?:mirror\/touch|keys|homescreen|pressButton|lock|unlock|apps\/launch|siri\/activate)$/.test(p)) context?.onDispatch?.();
  const res = await fetch(WDA + p, {
    method,
    headers: { ...headers, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout),
  });
  const json = await res.json();
  if (!res.ok || json.value?.error) {
    const err = new Error(json.value?.message || `WDA returned ${res.status}`);
    err.code = json.value?.error;
    throw err;
  }
  return json;
}

const wdaUp = signal => wda("GET", "/status", null, 1500, signal, { "x-mirror-purpose": "lifecycle" }).then(() => true, () => false);

const QUALITY = {
  low: { mjpegServerFramerate: 20, mjpegServerScreenshotQuality: 25, mjpegScalingFactor: 40 },
  balanced: { mjpegServerFramerate: 30, mjpegServerScreenshotQuality: 50, mjpegScalingFactor: 50 },
  high: { mjpegServerFramerate: 60, mjpegServerScreenshotQuality: 70, mjpegScalingFactor: 75 },
};
let quality = "balanced";
let sid = null;

async function session({ deadline, signal } = {}) {
  if (sid) return sid;
  const remaining = () => {
    const ms = deadline === undefined ? 30000 : Math.ceil(deadline - performance.now());
    if (ms <= 0) throw apiError("Wait timed out", 408, "timeout");
    return ms;
  };
  const res = await wda("POST", "/session", {
    capabilities: { alwaysMatch: { shouldWaitForQuiescence: false, shouldUseCompactResponses: false }, firstMatch: [{}] },
  }, remaining(), signal);
  sid = res.sessionId ?? res.value?.sessionId;
  if (!sid) throw apiError("WDA did not return a session ID", 502, "invalid response");
  try {
    await wda("POST", `/session/${sid}/appium/settings`, {
      settings: { ...QUALITY[quality], waitForIdleTimeout: 0, animationCoolOffTimeout: 0, snapshotMaxDepth: 50,
        shouldUseCompactResponses: false, elementResponseAttributes: "type,label,rect,enabled,displayed,selected,attribute/name,attribute/value,attribute/accessible" },
    }, remaining(), signal);
  } catch (e) {
    sid = null;
    throw e;
  }
  return sid;
}

// Runs fn with a live session, recreating it once if WDA restarted.
async function withSession(fn, options) {
  try {
    return await fn(await session(options));
  } catch (e) {
    if (e.code !== "invalid session id") throw e;
    sid = null;
    return fn(await session(options));
  }
}

// Legacy WDA fallback: re-read dimensions for every gesture to follow rotation.
async function screenSize(s) {
  return (await wda("GET", `/session/${s}/window/size`)).value;
}

// Taps and swipes are serialized so gestures never overlap on the device.
const scheduler = createScheduler();
const enqueue = scheduler.enqueue;

const clamp = (v) => Math.min(1, Math.max(0, v));

let fastTouch = true; // false once we learn this WDA build lacks /wda/mirror/touch (see scripts/wda-fast-touch.patch)
let guardedTouch;
let multiTouch;
async function supportsGuardedTouch() {
  if (guardedTouch !== undefined) return guardedTouch;
  try {
    const capabilities = (await wda("GET", "/wda/mirror/capabilities")).value;
    guardedTouch = capabilities?.guardedTouch === true;
    multiTouch = guardedTouch && capabilities?.multiTouch === true;
  }
  catch (e) { if (e.code !== "unknown command") throw e; guardedTouch = false; multiTouch = false; }
  return guardedTouch;
}
async function supportsMultiTouch() { await supportsGuardedTouch(); return multiTouch === true; }
async function legacyGestureGuards(guards) {
  if ((await wda("GET", "/wda/locked")).value) throw apiError("Unlock your iPhone", 409, "device locked");
  if (guards.expectedBundleId && (await wda("GET", "/wda/activeAppInfo")).value.bundleId !== guards.expectedBundleId) throw apiError("Foreground app changed", 409, "app changed");
  if (guards.expectedOrientation && (await withSession(s => wda("GET", `/session/${s}/orientation`))).value !== guards.expectedOrientation) throw apiError("Screen orientation changed", 409, "orientation changed");
}

// points: [[x, y, ms], ...] with x/y as 0..1 fractions of the screen; end: ms when the finger lifts.
async function gesture(points, end, guards = {}) {
  if (fastTouch) {
    try {
      // Skips WDA's per-action app lookup and snapshots, so the touch lands ~150 ms sooner than /actions.
      return (await wda("POST", "/wda/mirror/touch", { points, end, ...guards })).value;
    } catch (e) {
      if (e.code !== "unknown command") throw e;
      fastTouch = false; guardedTouch = false; multiTouch = false;
      // A helper replacement may have removed the guarded route. The fallback
      // must perform its own checks before dispatch rather than trust cached capability.
      await legacyGestureGuards(guards);
      console.log("  WDA has no fast touch endpoint; rerun npm run setup for lower latency");
    }
  }
  return withSession(async (s) => {
    const { width, height } = await screenSize(s);
    const at = ([x, y]) => ({ x: Math.round(clamp(x) * (width - 1)), y: Math.round(clamp(y) * (height - 1)) });
    const steps = [{ type: "pointerMove", duration: 0, ...at(points[0]) }, { type: "pointerDown", button: 0 }];
    for (let i = 1; i < points.length; i++) {
      steps.push({ type: "pointerMove", duration: Math.max(0, Math.round(points[i][2] - points[i - 1][2])), ...at(points[i]) });
    }
    const hold = Math.round(end - points.at(-1)[2]);
    steps.push({ type: "pause", duration: Math.max(points.length === 1 ? 40 : 0, hold) });
    steps.push({ type: "pointerUp", button: 0 });
    await wda("POST", `/session/${s}/actions`, {
      actions: [{ type: "pointer", id: "finger1", parameters: { pointerType: "touch" }, actions: steps }],
    });
  });
}

async function pinch(body) {
  if (body.scale === 1) return;
  if (await supportsMultiTouch()) {
    const guards = { expectedBundleId: body.expectedApp, expectedOrientation: body.expectedOrientation };
    try { return (await wda("POST", "/wda/mirror/touch", { ...pinchPaths(body), ...guards })).value; }
    catch (e) {
      if (e.code !== "unknown command") throw e; // Never replay an uncertain gesture.
      fastTouch = false; guardedTouch = false; multiTouch = false;
      await legacyGestureGuards(guards);
    }
  }
  return withSession(async s => (await wda("POST", `/session/${s}/actions`, {
    actions: pinchActions(body, await screenSize(s)),
  })).value);
}

const SHORTCUTS = {
  switcher: { points: [[0.5, 0.998, 0], [0.5, 0.75, 250], [0.5, 0.6, 500]], end: 1300 },
  control: { points: [[0.93, 0.004, 0], [0.93, 0.45, 250]], end: 300 },
  notifications: { points: [[0.3, 0.004, 0], [0.3, 0.6, 250]], end: 300 },
  spotlight: { points: [[0.5, 0.3, 0], [0.5, 0.55, 200]], end: 250 },
};

const actions = {
  pinch,
  gesture: body => gesture(body.points, body.end, { expectedBundleId: body.expectedApp, expectedOrientation: body.expectedOrientation }),
  shortcut: body => gesture(SHORTCUTS[body.name].points, SHORTCUTS[body.name].end, { expectedBundleId: body.expectedApp, expectedOrientation: body.expectedOrientation }),
  type: (body) => body.id || body.selector ? inspection.type(body) : withSession((s) => wda("POST", `/session/${s}/wda/keys`, { value: [...body.text] })),
  tap: (body) => inspection.tap(body),
  home: () => wda("POST", "/wda/homescreen"),
  button: ({ name }) => withSession((s) => wda("POST", `/session/${s}/wda/pressButton`, { name })),
  lock: () => withSession((s) => wda("POST", `/session/${s}/wda/lock`)),
  unlock: () => withSession((s) => wda("POST", `/session/${s}/wda/unlock`)),
  launch: ({ bundleId }) => withSession((s) => wda("POST", `/session/${s}/wda/apps/launch`, { bundleId })),
  siri: ({ text }) => withSession((s) => wda("POST", `/session/${s}/wda/siri/activate`, { text })),
  // Called when the UI opens, so opening the mirror turns automation back on if it was stopped.
  ensure: async () => {
    if (!(await automationAllowed())) restartWda();
  },
  quality: ({ level }) => {
    if (!QUALITY[level]) throw new Error("unknown quality");
    quality = level;
    return withSession((s) => wda("POST", `/session/${s}/appium/settings`, { settings: QUALITY[level] }));
  },
};

// ---------- Auto-start WDA on macOS ----------

// Launch failures that need the user to do something on the phone or Mac. Every launch reinstalls WDA, which
// also hides the trust entry in Settings for a moment, so these back off instead of retrying right away.
const WDA_PROBLEMS = [
  [/not trusted|explicitly trusted/, "On your iPhone: Settings → General → VPN & Device Management → your Apple ID → Trust."],
  [/cannot be installed on this device|doesn't include the currently selected device/, "Finish setting up iPhone Portal on your Mac."],
  [/Developer Mode is (disabled|not enabled)|enable Developer Mode/i, "On your iPhone, turn on Developer Mode in Settings → Privacy & Security."],
  [/device is locked|DeviceLocked/i, "Unlock your iPhone."],
];

let wdaProcess = null;
let wdaProblem = null;
let wdaRetryAt = 0;
let launchLockedDevice = null;
const startupLock = createStartupLock({ changed: () => statusEvents.invalidate() });
function maybeStartWda(udid, connectionID) {
  if (wdaProcess || Date.now() < wdaRetryAt || opts["no-autostart"] || MANUAL || process.platform !== "darwin") return;
  if (!fs.existsSync(path.join(ROOT, "vendor/build"))) return;
  const logPath = path.join(ROOT, "vendor/wda.log");
  const from = fs.existsSync(logPath) ? fs.statSync(logPath).size : 0;
  const log = fs.openSync(logPath, "a");
  console.log(`  starting WebDriverAgent on ${udid} (log: vendor/wda.log)`);
  wdaProcess = spawn("bash", [path.join(ROOT, "scripts/run-wda.sh")], { env: { ...process.env, UDID: udid }, stdio: ["ignore", "pipe", "pipe"] });
  let tail = "";
  const output = chunk => {
    fs.writeSync(log, chunk);
    tail = (tail + chunk.toString()).slice(-4096);
    if (/device is locked|DeviceLocked/i.test(tail)) {
      launchLockedDevice = `${udid}:${connectionID}`;
      wdaProblem = "Unlock your iPhone.";
      statusEvents.invalidate();
      tail = "";
    }
    if (/ServerURLHere/.test(tail)) { launchLockedDevice = null; tail = ""; statusEvents.invalidate(); }
  };
  wdaProcess.stdout.on("data", output);
  wdaProcess.stderr.on("data", output);
  wdaProcess.on("close", () => fs.closeSync(log));
  wdaProcess.on("exit", () => {
    wdaProcess = null;
    sid = null;
    guardedTouch = undefined; fastTouch = true;
    const output = fs.readFileSync(logPath).subarray(from).toString();
    wdaProblem = WDA_PROBLEMS.find(([re]) => re.test(output))?.[1] ?? null;
    wdaRetryAt = Date.now() + (wdaProblem ? 30000 : 3000);
    if (wdaProblem) console.log(`  ${wdaProblem} (retrying in 30 s)`);
    statusEvents.invalidate();
  });
}
process.on("exit", () => wdaProcess?.kill());

// Holding both volume buttons on the iPhone stops automation: WDA keeps running but every input fails with
// XCTest error 41. Restarting WDA asks iOS for automation again (and brings back its "Automation Running" banner).
const NOT_AUTHORIZED = /Code=41|Not authorized for performing UI testing/;

function restartWda() {
  console.log("  automation is off on the iPhone, restarting WebDriverAgent");
  sid = null;
  if (wdaProcess) wdaProcess.kill();
  else spawn("pkill", ["-f", "test-without-building.*WebDriverAgent"], { stdio: "ignore" });
  // The next status poll sees WDA down and starts it again.
}

// Without automation WDA can't see any app, so the foreground app comes back as pid 0.
async function automationAllowed() {
  try {
    return (await wda("GET", "/wda/activeAppInfo", null, 5000)).value?.pid > 0;
  } catch {
    return true; // WDA isn't up yet; status() takes care of starting it
  }
}
process.on("SIGINT", () => process.exit());
process.on("SIGTERM", () => process.exit()); // the Mac app stops the server this way

// ---------- HTTP server ----------

async function status(signal) {
  const observedAt = Date.now();
  let device = null;
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
  const up = (MANUAL || device) && (await wdaUp(signal));
  if (!MANUAL && process.platform === "darwin" && !up) startupLock.observe(device);
  let locked = !MANUAL && device
    ? launchLockedDevice === `${device.udid}:${device.id}` ? true : startupLock.value(device)
    : null;
  if (up) {
    try {
      const value = (await wda("GET", "/wda/locked", null, 1200, signal, { "x-mirror-purpose": "lifecycle" })).value;
      if (typeof value !== "boolean") throw new Error("Invalid lock state");
      locked = value;
      if (locked) keepAwake.stop("locked");
    } catch { error = "Waiting for your iPhone…"; }
  }
  signal?.throwIfAborted();
  if (up) { wdaProblem = null; launchLockedDevice = null; startupLock.reset(); }
  if (device && !up) {
    maybeStartWda(device.udid, device.id);
    error = wdaProblem
      ? wdaProblem
      : wdaProcess || (fs.existsSync(path.join(ROOT, "vendor/build")) && !opts["no-autostart"])
      ? null
      : "Finish setting up iPhone Portal on your Mac.";
  } else if (MANUAL && !up) error = "Reconnect your iPhone.";
  const lifecycle = !MANUAL && !device ? "disconnected" : locked === true ? "locked" : up && locked === false ? "ready" : "connecting";
  return { service: "iphone-mirror", apiVersion: 2, instanceId, observedAt, ok: Boolean(up), device, pinnedUdid, locked, lifecycle,
    captureIdentity: { singleUsbDevice: Boolean(pinnedUdid && connectedUsbUdids.length === 1 && connectedUsbUdids[0] === pinnedUdid) },
    error, quality, queue: scheduler.stats(), keepAwake: keepAwake.status() };
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


const inspection = createInspection({ wda, withSession, enqueue });
const keepAwake = createKeepAwake({ wda, withSession, enqueue: fn => scheduler.maintenance(fn) });
const portalStatus = createPortalStatus({ wda, keepAwake: keepAwake.status });
const statusEvents = createStatusEvents({ read: status });
process.on("exit", () => portalStatus.stop());
let commands;
const commandLedger = () => commands ??= createCommands({ file: process.env.MIRROR_COMMANDS_FILE ?? path.join(ROOT, "vendor", opts.port === "7100" ? "commands.json" : `commands-${opts.port}.json`) });

async function dispatch(name, body, signal) {
  const started = performance.now();
  if (name === "status") return { status: 200, body: await statusEvents.refresh() };
  if (name === "presence") {
    portalStatus.receive(body);
    return { status: 200, body: { ok: true } };
  }
  if (name === "command-status") {
    const value = commandLedger().get(body.requestId);
    return { status: value ? 200 : 404, body: value ? { ok: true, value } : { ok: false, code: "not found", error: "Unknown request ID" } };
  }
  if (name === "keep-awake") return { status: 200, body: { ok: true, value: await keepAwake.configure(body) } };
  const deadline = performance.now() + (body.timeoutMs ?? (name === "wait" ? 10000 : 15000));
  if (!Object.hasOwn(ActionSchemas, name)) {
    const value = await commandContext.run({ signal, deadline }, () => inspection[name](body, signal));
    return { status: 200, body: { ok: true, value, meta: { instanceId, observedAt: new Date().toISOString() } } };
  }
  const requestId = body.requestId ?? randomUUID();
  return commandLedger().execute(requestId, { name, body }, async mark => {
    if (name === "lock") keepAwake.stop("lock requested");
    let dispatched = false, executed = false;
    const timing = {};
    const onDispatch = () => { if (!dispatched) { dispatched = true; mark("running"); inspection.invalidateObservations(); } };
    try {
      await commandContext.run({ signal, deadline, onDispatch, priority: 5, operationTimeoutMs: Math.max(8000, (body.end ?? 0) + 2000) }, async () => {
        await enqueue(async () => {
          timing.queueMs = Math.round(performance.now() - started);
          const nativeGuards = name === "pinch" ? await supportsMultiTouch() : ["gesture", "shortcut"].includes(name) && await supportsGuardedTouch();
          if (!nativeGuards && !["unlock", "lock", "ensure", "quality"].includes(name)) {
            if ((await wda("GET", "/wda/locked")).value) throw apiError("Unlock your iPhone", 409, "device locked");
          }
          if (!nativeGuards && body.expectedApp) {
            const active = (await wda("GET", "/wda/activeAppInfo")).value;
            if (active.bundleId !== body.expectedApp) throw apiError("Foreground app changed", 409, "app changed");
          }
          if (!nativeGuards && body.expectedOrientation && (await withSession(s => wda("GET", `/session/${s}/orientation`))).value !== body.expectedOrientation) throw apiError("Screen orientation changed", 409, "orientation changed");
          if (body.observationId) await inspection.verifyObservation(body.observationId, signal);
          signal?.throwIfAborted();
          const actionStarted = performance.now();
          timing.preflightMs = Math.round(actionStarted - started - timing.queueMs);
          const result = await actions[name](body);
          timing.actionMs = Math.round(performance.now() - actionStarted);
          if (result?.timing) timing.native = result.timing;
          executed = true;
          if (["gesture", "pinch", "shortcut", "tap", "type", "home", "button"].includes(name)) keepAwake.activity();
        });
        if (body.waitFor) await inspection.wait(body.waitFor, signal);
      });
      timing.totalMs = Math.round(performance.now() - started);
      return { status: 200, body: { ok: true, requestId, outcome: body.waitFor ? "verified" : "executed", verified: Boolean(body.waitFor), timing } };
    } catch (e) {
      const result = errorResponse(e);
      result.body = { ...result.body, requestId, outcome: executed ? "executed" : dispatched ? "unknown" : "not executed", verified: false };
      if (NOT_AUTHORIZED.test(e.message)) { keepAwake.stop("automation unavailable"); restartWda(); }
      return result;
    }
  });
}

if (!MANUAL) {
  forward(WDA_PORT, 8100);
  forward(MJPEG_PORT, 9100);
}
startServer({ port: +opts.port, instanceId, html: fs.readFileSync(path.join(ROOT, "public/index.html"), "utf8"), mjpeg: MJPEG, dispatch,
  statusEvents,
  onListening: () => {
    const url = `http://localhost:${opts.port}`;
    console.log(`\n  iPhone Mirror running at ${url}\n`);
    if (process.platform === "darwin" && !opts["no-open"]) spawn("open", [url], { stdio: "ignore" });
  },
});
if (!MANUAL) {
  let observedDeviceID;
  usbMonitor = createUSBMonitor({ address: USBMUXD, list: listDevices, onChange(devices) {
    if (!pinnedUdid) pinnedUdid = devices.find(d => d.connection === "USB")?.udid ?? null;
    connectedUsbUdids = [...new Set(devices.filter(d => d.connection === "USB").map(d => d.udid))];
    const device = devices.find(d => d.udid === pinnedUdid && d.connection === "USB") ?? null;
    if (!device) { keepAwake.stop("disconnected"); startupLock.reset(); launchLockedDevice = null; }
    if (observedDeviceID === (device?.id ?? null)) { statusEvents.invalidate(); return; }
    observedDeviceID = device?.id ?? null;
    statusEvents.invalidate({ device, pinnedUdid, observedAt: Date.now(), ok: false, locked: null,
      lifecycle: device ? "connecting" : "disconnected",
      captureIdentity: { singleUsbDevice: connectedUsbUdids.length === 1 && connectedUsbUdids[0] === pinnedUdid } });
  } });
  process.on("exit", () => usbMonitor.stop());
}
void statusEvents.refresh();
process.on("exit", () => statusEvents.stop());
