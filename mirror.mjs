#!/usr/bin/env node
// iphone-mirror: control your iPhone from your computer.
// Video comes from WebDriverAgent's MJPEG stream, input goes back through WDA's W3C actions API.
// USB forwarding talks to usbmuxd directly, so no iproxy / libimobiledevice is needed.

import http from "node:http";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

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

async function pickDevice() {
  const devices = (await listDevices()).filter((d) => !opts.udid || d.udid === opts.udid);
  return devices.find((d) => d.connection === "USB") ?? devices[0] ?? null;
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

async function wda(method, p, body, timeout = 30000) {
  const res = await fetch(WDA + p, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeout),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.value?.error) {
    const err = new Error(json.value?.message || `WDA returned ${res.status}`);
    err.code = json.value?.error;
    throw err;
  }
  return json;
}

const wdaUp = () => wda("GET", "/status", null, 1500).then(() => true, () => false);

const QUALITY = {
  low: { mjpegServerFramerate: 20, mjpegServerScreenshotQuality: 25, mjpegScalingFactor: 40 },
  balanced: { mjpegServerFramerate: 30, mjpegServerScreenshotQuality: 50, mjpegScalingFactor: 50 },
  high: { mjpegServerFramerate: 60, mjpegServerScreenshotQuality: 70, mjpegScalingFactor: 75 },
};
let quality = "balanced";
let sid = null;
let size = null;
let sizeAt = 0;

async function session() {
  if (sid) return sid;
  const res = await wda("POST", "/session", {
    capabilities: { alwaysMatch: { shouldWaitForQuiescence: false, shouldUseCompactResponses: true }, firstMatch: [{}] },
  });
  sid = res.sessionId ?? res.value?.sessionId;
  await wda("POST", `/session/${sid}/appium/settings`, {
    settings: { ...QUALITY[quality], waitForIdleTimeout: 0, animationCoolOffTimeout: 0, snapshotMaxDepth: 1 },
  }).catch(() => {});
  return sid;
}

// Runs fn with a live session, recreating it once if WDA restarted.
async function withSession(fn) {
  try {
    return await fn(await session());
  } catch (e) {
    if (!/session/i.test(`${e.code} ${e.message}`)) throw e;
    sid = null;
    return fn(await session());
  }
}

// Screen size in points (what WDA taps in). Rechecked every few seconds to follow rotation.
async function screenSize(s) {
  if (!size || Date.now() - sizeAt > 3000) {
    size = (await wda("GET", `/session/${s}/window/size`)).value;
    sizeAt = Date.now();
  }
  return size;
}

// Taps and swipes are serialized so gestures never overlap on the device.
let chain = Promise.resolve();
const enqueue = (fn) => {
  const p = chain.then(fn);
  chain = p.catch(() => {});
  return p;
};

const clamp = (v) => Math.min(1, Math.max(0, v));

let fastTouch = true; // false once we learn this WDA build lacks /wda/mirror/touch (see scripts/wda-fast-touch.patch)

// points: [[x, y, ms], ...] with x/y as 0..1 fractions of the screen; end: ms when the finger lifts.
async function gesture(points, end) {
  if (fastTouch) {
    try {
      // Skips WDA's per-action app lookup and snapshots, so the touch lands ~150 ms sooner than /actions.
      await wda("POST", "/wda/mirror/touch", { points, end });
      return;
    } catch (e) {
      if (e.code !== "unknown command") throw e;
      fastTouch = false;
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

const SHORTCUTS = {
  switcher: { points: [[0.5, 0.998, 0], [0.5, 0.75, 250], [0.5, 0.6, 500]], end: 1300 },
  control: { points: [[0.93, 0.004, 0], [0.93, 0.45, 250]], end: 300 },
  notifications: { points: [[0.3, 0.004, 0], [0.3, 0.6, 250]], end: 300 },
  spotlight: { points: [[0.5, 0.3, 0], [0.5, 0.55, 200]], end: 250 },
};

const actions = {
  gesture: ({ points, end }) => gesture(points, end),
  shortcut: ({ name }) => gesture(SHORTCUTS[name].points, SHORTCUTS[name].end),
  type: ({ text }) => withSession((s) => wda("POST", `/session/${s}/wda/keys`, { value: [...text] })),
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
  [/not trusted|explicitly trusted/, "Trust the developer on your iPhone: Settings → General → VPN & Device Management → your Apple ID → Trust."],
  [/cannot be installed on this device|doesn't include the currently selected device/, "This iPhone isn't set up yet. Keep it plugged in and run npm run setup."],
  [/Developer Mode is (disabled|not enabled)|enable Developer Mode/i, "Turn on Developer Mode on your iPhone: Settings → Privacy & Security → Developer Mode."],
  [/device is locked|DeviceLocked/i, "Unlock your iPhone."],
];

let wdaProcess = null;
let wdaProblem = null;
let wdaRetryAt = 0;
function maybeStartWda(udid) {
  if (wdaProcess || Date.now() < wdaRetryAt || opts["no-autostart"] || MANUAL || process.platform !== "darwin") return;
  if (!fs.existsSync(path.join(ROOT, "vendor/build"))) return;
  const logPath = path.join(ROOT, "vendor/wda.log");
  const from = fs.existsSync(logPath) ? fs.statSync(logPath).size : 0;
  const log = fs.openSync(logPath, "a");
  console.log(`  starting WebDriverAgent on ${udid} (log: vendor/wda.log)`);
  wdaProcess = spawn("bash", [path.join(ROOT, "scripts/run-wda.sh")], { env: { ...process.env, UDID: udid }, stdio: ["ignore", log, log] });
  wdaProcess.on("exit", () => {
    wdaProcess = null;
    sid = null;
    const output = fs.readFileSync(logPath).subarray(from).toString();
    wdaProblem = WDA_PROBLEMS.find(([re]) => re.test(output))?.[1] ?? null;
    wdaRetryAt = Date.now() + (wdaProblem ? 30000 : 3000);
    if (wdaProblem) console.log(`  ${wdaProblem} (retrying in 30 s)`);
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

const readBody = (req) =>
  new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data ? JSON.parse(data) : {}));
  });

const send = (res, code, obj) => {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(obj));
};

async function status() {
  let device = null;
  let error = null;
  if (!MANUAL) {
    try {
      device = await pickDevice();
      if (!device) error = "No iPhone found. Plug it in via USB and tap Trust.";
    } catch {
      error = "Can't reach usbmuxd. Is this a Mac (or Linux with usbmuxd running)?";
    }
  }
  const up = (MANUAL || device) && (await wdaUp());
  if (up) wdaProblem = null;
  if (device && !up) {
    maybeStartWda(device.udid);
    error = wdaProblem
      ? wdaProblem
      : wdaProcess
      ? "Starting WebDriverAgent on your iPhone… (keep it unlocked)"
      : "WebDriverAgent isn't running on the iPhone. Run scripts/setup-wda.sh once, then restart.";
  } else if (MANUAL && !up) error = `Can't reach WebDriverAgent at ${WDA}`;
  return { ok: Boolean(up), device, error, quality };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");

  if (url.pathname === "/") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return fs.createReadStream(path.join(ROOT, "public/index.html")).pipe(res);
  }

  if (url.pathname === "/stream") {
    const upstream = http.get(MJPEG, (r) => {
      res.writeHead(200, { "content-type": r.headers["content-type"] ?? "multipart/x-mixed-replace", "cache-control": "no-store" });
      r.pipe(res);
    });
    upstream.on("error", () => res.destroy());
    req.on("close", () => upstream.destroy());
    return;
  }

  if (url.pathname === "/api/status") return send(res, 200, await status());

  const name = url.pathname.match(/^\/api\/(\w+)$/)?.[1];
  if (req.method === "POST" && name && actions[name]) {
    try {
      const body = await readBody(req);
      await enqueue(() => actions[name](body));
      return send(res, 200, { ok: true });
    } catch (e) {
      if (NOT_AUTHORIZED.test(e.message)) {
        restartWda();
        return send(res, 503, { ok: false, error: "Automation was off on your iPhone. Turning it back on, try again in a few seconds." });
      }
      return send(res, 500, { ok: false, error: e.message });
    }
  }

  send(res, 404, { error: "not found" });
});

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

if (!MANUAL) {
  forward(WDA_PORT, 8100);
  forward(MJPEG_PORT, 9100);
}
server.listen(+opts.port, "127.0.0.1", () => {
  const url = `http://localhost:${opts.port}`;
  console.log(`\n  iPhone Mirror running at ${url}\n`);
  if (process.platform === "darwin" && !opts["no-open"]) spawn("open", [url], { stdio: "ignore" });
});
