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

export function startFakeIphone({ frame, wdaPort = 18100, mjpegPort = 19100 } = {}) {
  const log = [];
  const jpeg = frame ? fs.readFileSync(frame) : TINY_JPEG;

  const wda = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const json = body ? JSON.parse(body) : null;
      log.push({ method: req.method, path: req.url, body: json });
      const reply = (value, extra = {}) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ value, sessionId: "S1", ...extra }));
      };
      if (req.url === "/status") return reply({ ready: true });
      if (req.url === "/session") return reply({ sessionId: "S1", capabilities: {} });
      if (req.url.endsWith("/window/size")) return reply({ width: 390, height: 844 });
      if (req.url.startsWith("/session/") && !req.url.startsWith("/session/S1/")) {
        res.writeHead(404, { "content-type": "application/json" });
        return res.end(JSON.stringify({ value: { error: "invalid session id", message: "Session does not exist" } }));
      }
      reply(null);
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
        msg(`<key>DeviceList</key><array><dict><key>DeviceID</key><integer>7</integer><key>MessageType</key><string>Attached</string><key>Properties</key><dict><key>ConnectionType</key><string>USB</string><key>DeviceID</key><integer>7</integer><key>SerialNumber</key><string>00008110-FAKEFAKEFAKE</string></dict></dict></array>`);
        return;
      }
      if (xml.includes("<string>Connect</string>")) {
        sock.off("data", onData);
        const p = +xml.match(/<key>PortNumber<\/key><integer>(\d+)</)[1];
        const port = ((p & 0xff) << 8) | (p >> 8);
        log.push({ mux: "connect", port });
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
  return { log, close: () => [wda, mjpeg, mux].forEach((s) => s.close()) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { log } = startFakeIphone({ frame: process.argv[2] });
  console.log(`fake iPhone up. Run: USBMUXD_SOCKET_ADDRESS=${SOCKET} npm start`);
  setInterval(() => {
    while (log.length) console.log(JSON.stringify(log.shift()));
  }, 200);
}
