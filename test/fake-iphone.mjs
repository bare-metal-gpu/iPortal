// A fake iPhone for development without a device: a fake usbmuxd socket plus a fake WebDriverAgent.
// Usage: node test/fake-iphone.mjs [frame.jpg]   then   USBMUXD_SOCKET_ADDRESS=/tmp/fake-usbmuxd.sock npm start
import http from "node:http";
import net from "node:net";
import fs from "node:fs";

export const SOCKET = "/tmp/fake-usbmuxd.sock";
const TINY_JPEG = Buffer.from(
  "/9j/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAAAP/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AIEAD//Z",
  "base64",
);

export function startFakeIphone({ frame, wdaPort = 18100, mjpegPort = 19100, guardedTouch = false } = {}) {
  const log = [];
  const jpeg = frame ? fs.readFileSync(frame) : TINY_JPEG;
  const ui = {
    elements: [{ id: "button-1", type: "XCUIElementTypeButton", name: "Continue", label: "Continue", value: null, enabled: true, visible: true, hittable: true, rect: { x: 20, y: 40, width: 100, height: 44 } }],
    error: null,
    expireSession: false,
    staleOnce: false,
    staleLookupOnce: false,
    delayMs: 0,
    locked: false,
    app: "com.apple.Preferences",
    orientation: "PORTRAIT",
    settings: {},
    guardedTouch,
    removeTouch: false,
    devices: [{ id: 7, udid: "00008110-FAKEFAKEFAKE", connection: "USB" }],
  };
  let sessionId = "S1";
  let generation = 1;

  const wda = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const json = body ? JSON.parse(body) : null;
      log.push({ method: req.method, path: req.url, body: json });
      const reply = (value, extra = {}, status = 200) => {
        const send = () => {
          res.writeHead(status, { "content-type": "application/json" });
          res.end(JSON.stringify({ value, sessionId, ...extra }));
        };
        if (ui.delayMs) setTimeout(send, ui.delayMs); else send();
      };
      const fail = (error, message = error) => reply({ error, message }, {}, 404);
      if (req.url === "/status") return reply({ ready: true });
      if (req.url === "/session") return reply({ sessionId, capabilities: {} });
      if (req.url === "/wda/mirror/capabilities") return reply({ version: ui.guardedTouch ? 3 : 1, guardedTouch: ui.guardedTouch });
      if (req.url === "/wda/mirror/touch") {
        if (!ui.guardedTouch || ui.removeTouch) return fail("unknown command");
        if (ui.locked || (json.expectedBundleId && json.expectedBundleId !== ui.app) || (json.expectedOrientation && json.expectedOrientation !== ui.orientation)) return fail("invalid element state");
        return reply({ completed: true, timing: { guardMs: 2, playbackMs: 70, confirmationMs: 50 } });
      }
      if (ui.expireSession && req.url.startsWith("/session/")) {
        ui.expireSession = false;
        sessionId = `S${++generation}`;
        return fail("invalid session id");
      }
      if (req.url.startsWith("/session/") && !req.url.startsWith(`/session/${sessionId}/`)) return fail("invalid session id");
      const route = req.url.replace(/^\/session\/[^/]+/, "");
      if (ui.error && route !== "/appium/settings") return fail(ui.error);
      if (route === "/elements") {
        if (ui.staleLookupOnce) { ui.staleLookupOnce = false; return fail("stale element reference"); }
        if (json.value === "INVALID") return fail("invalid selector");
        const found = ui.elements.filter((e) => json.using === "class name" ? e.type === json.value : e.name === json.value);
        return reply(found.map((e) => ({ "element-6066-11e4-a52e-4f735466cecf": e.id,
          ...(ui.settings.shouldUseCompactResponses === false ? { type: e.type, label: e.label, rect: e.rect, enabled: e.enabled, displayed: e.visible, "attribute/name": e.name, "attribute/value": e.value } : {}) })));
      }
      if (route.startsWith("/source?")) return reply(new URL(req.url, "http://x").searchParams.get("format") === "json" ? { type: "Application", children: ui.elements } : "<Application/>");
      if (route === "/screenshot") return reply(jpeg.toString("base64"));
      if (route === "/wda/locked") return reply(ui.locked);
      if (route === "/wda/activeAppInfo") return reply({ bundleId: ui.app, pid: 123 });
      if (route === "/orientation") return reply(ui.orientation);
      const elementRoute = route.match(/^\/element\/([^/]+)\/(.+)$/);
      if (elementRoute) {
        if (ui.staleOnce) { ui.staleOnce = false; return fail("stale element reference"); }
        const element = ui.elements.find((e) => e.id === decodeURIComponent(elementRoute[1]));
        if (!element) return fail("stale element reference");
        if (elementRoute[2] === "click") { ui.onClick?.(element); return reply(null); }
        if (elementRoute[2] === "value") { element.value = json.value.join(""); return reply(null); }
        if (elementRoute[2] === "screenshot") return reply(jpeg.toString("base64"));
        const attr = elementRoute[2].replace(/^attribute\//, "");
        return reply(element[attr] ?? null);
      }
      if (req.url.endsWith("/window/size")) return reply({ width: 390, height: 844 });
      if (route === "/wda/lock") { ui.locked = true; return reply(null); }
      if (route === "/wda/unlock") { ui.locked = false; return reply(null); }
      if (route === "/wda/apps/launch") { ui.app = json.bundleId; return reply(null); }
      if (route === "/wda/homescreen") { ui.app = "com.apple.springboard"; return reply(null); }
      if (route === "/appium/settings") { Object.assign(ui.settings, json.settings); return reply(ui.settings); }
      if (["/appium/settings", "/actions", "/wda/keys", "/wda/pressButton", "/wda/performIoHidEvent", "/wda/siri/activate"].includes(route) && req.method === "POST") return reply(null);
      fail("unknown command", `Unimplemented fake route: ${req.method} ${route}`);
    });
  });

  const mjpeg = net.createServer((sock) => {
    sock.on("error", () => {});
    sock.write("HTTP/1.0 200 OK\r\nServer: WDA MJPEG Server\r\nConnection: close\r\nContent-Type: multipart/x-mixed-replace; boundary=--BoundaryString\r\n\r\n");
    const tick = setInterval(() => {
      sock.write(`--BoundaryString\r\nContent-type: image/jpg\r\nContent-Length: ${jpeg.length}\r\n\r\n`);
      sock.write(jpeg);
      sock.write("\r\n\r\n");
    }, 100);
    sock.on("close", () => clearInterval(tick));
  });

  // Speaks enough of the usbmuxd plist protocol for ListDevices and Connect.
  fs.rmSync(SOCKET, { force: true });
  const mux = net.createServer((sock) => {
    sock.on("error", () => {});
    let buf = Buffer.alloc(0);
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length < 16 || buf.length < buf.readUInt32LE(0)) return;
      const xml = buf.subarray(16, buf.readUInt32LE(0)).toString();
      const msg = (dict) => {
        const b = Buffer.from(`<?xml version="1.0"?><plist version="1.0"><dict>${dict}</dict></plist>`);
        const h = Buffer.alloc(16);
        h.writeUInt32LE(16 + b.length, 0);
        h.writeUInt32LE(1, 4);
        h.writeUInt32LE(8, 8);
        h.writeUInt32LE(1, 12);
        sock.write(Buffer.concat([h, b]));
      };
      if (xml.includes("<string>ListDevices</string>")) {
        msg(`<key>DeviceList</key><array>${ui.devices.map(d => `<dict><key>DeviceID</key><integer>${d.id}</integer><key>MessageType</key><string>Attached</string><key>Properties</key><dict><key>ConnectionType</key><string>${d.connection}</string><key>DeviceID</key><integer>${d.id}</integer><key>SerialNumber</key><string>${d.udid}</string></dict></dict>`).join("")}</array>`);
        return;
      }
      if (xml.includes("<string>Connect</string>")) {
        sock.off("data", onData);
        const p = +xml.match(/<key>PortNumber<\/key><integer>(\d+)</)[1];
        const port = ((p & 0xff) << 8) | (p >> 8);
        const deviceId = +xml.match(/<key>DeviceID<\/key><integer>(\d+)</)[1];
        log.push({ mux: "connect", port, deviceId });
        if (!ui.devices.some(d => d.id === deviceId)) return msg(`<key>Number</key><integer>2</integer>`);
        const target = { 8100: wdaPort, 9100: mjpegPort }[port];
        if (!target) return msg(`<key>MessageType</key><string>Result</string><key>Number</key><integer>3</integer>`);
        const up = net.connect(target, "127.0.0.1", () => {
          msg(`<key>MessageType</key><string>Result</string><key>Number</key><integer>0</integer>`);
          sock.pipe(up).pipe(sock);
        });
        up.on("error", () => sock.destroy());
      }
    };
    sock.on("data", onData);
  });

  wda.listen(wdaPort, "127.0.0.1");
  mjpeg.listen(mjpegPort, "127.0.0.1");
  mux.listen(SOCKET);
  return { log, ui, close: () => [wda, mjpeg, mux].forEach((s) => s.close()) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { log } = startFakeIphone({ frame: process.argv[2] });
  console.log(`fake iPhone up. Run: USBMUXD_SOCKET_ADDRESS=${SOCKET} npm start`);
  setInterval(() => {
    while (log.length) console.log(JSON.stringify(log.shift()));
  }, 200);
}
