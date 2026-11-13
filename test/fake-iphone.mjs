// A fake iPhone for development without a device: a fake usbmuxd socket plus the versioned helper protocol.
// Set the same IPORTAL_HELPER_TOKEN in both shells, then run:
// bun test/fake-iphone.mjs [frame.jpg]; USBMUXD_SOCKET_ADDRESS=/tmp/fake-usbmuxd.sock bun start
import http from "node:http";
import net from "node:net";
import fs from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";

function sourceNode(type, element, children) {
  return {
    type,
    label: element?.label ?? null,
    value: element?.value ?? null,
    name: element?.name ?? null,
    rawIdentifier: element?.name ?? null,
    frame: "{{0,0},{0,0}}",
    nativeFrame: "{{0,0},{0,0}}",
    rect: element?.rect ?? { x: 0, y: 0, width: 390, height: 844 },
    isEnabled: element?.enabled === false ? "0" : "1",
    isVisible: element?.visible === false ? "0" : "1",
    isAccessible: "1",
    isNativeAccessibilityElement: "1",
    isFocused: "0",
    traits: "",
    customActions: null,
    children,
  };
}
export const SOCKET = "/tmp/fake-usbmuxd.sock";
const TINY_JPEG = Buffer.from(
  "/9j/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAAAP/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AIEAD//Z",
  "base64",
);

/** @param {{frame?: string, frameTag?: string, helperPort?: number, socketPath?: string, guardedTouch?: boolean, multiTouch?: boolean, helperToken?: string}} [options] */
export function startFakeIphone({
  frame,
  frameTag,
  helperPort = 18100,
  socketPath = SOCKET,
  guardedTouch = true,
  multiTouch = guardedTouch,
  helperToken = randomBytes(32).toString("hex"),
} = {}) {
  const log = [];
  let jpeg = frame ? fs.readFileSync(frame) : TINY_JPEG;
  if (frameTag) {
    const comment = Buffer.from(frameTag);
    const header = Buffer.from([0xff, 0xfe, 0, 0]);
    header.writeUInt16BE(comment.length + 2, 2);
    jpeg = Buffer.concat([jpeg.subarray(0, 2), header, comment, jpeg.subarray(2)]);
  }
  const ui = {
    helperToken,
    authMarker: true,
    elements: [
      {
        id: "button-1",
        type: "XCUIElementTypeButton",
        name: "Continue",
        label: "Continue",
        value: null,
        enabled: true,
        visible: true,
        hittable: true,
        rect: { x: 20, y: 40, width: 100, height: 44 },
      },
    ],
    error: /** @type {string | null} */ (null),
    restartBoot: false,
    staleOnce: false,
    staleLookupOnce: false,
    delayMs: 0,
    // Status probes to leave unanswered, as a busy helper or a stalled tunnel does.
    dropStatus: 0,
    locked: /** @type {boolean | null} */ (false),
    app: "com.apple.Preferences",
    orientation: "PORTRAIT",
    quality: "balanced",
    guardedTouch,
    multiTouch,
    removeTouch: false,
    devices: [{ id: 7, udid: "00008110-FAKEFAKEFAKE", connection: "USB" }],
    targets: {},
    size: { width: 390, height: 844 },
  };
  const subscribers = new Set();
  const attached = (d) =>
    `<key>MessageType</key><string>Attached</string><key>DeviceID</key><integer>${d.id}</integer><key>Properties</key><dict><key>ConnectionType</key><string>${d.connection}</string><key>DeviceID</key><integer>${d.id}</integer><key>SerialNumber</key><string>${d.udid}</string></dict>`;
  let devices = ui.devices;
  Object.defineProperty(ui, "devices", {
    get: () => devices,
    set(next) {
      const previous = devices;
      devices = next;
      for (const send of subscribers) {
        for (const d of previous)
          if (!next.some((n) => n.id === d.id))
            send(
              `<key>MessageType</key><string>Detached</string><key>DeviceID</key><integer>${d.id}</integer>`,
            );
        for (const d of next) if (!previous.some((p) => p.id === d.id)) send(attached(d));
      }
    },
  });
  let generation = randomUUID();
  const status = () => ({
    protocol: 1,
    build: "native-1",
    generation,
    phase: ui.locked ? "locked" : "ready",
    automationReady: true,
    locked: ui.locked,
    activeOperation: null,
    capabilities: {
      touch: ui.guardedTouch,
      multiTouch: ui.multiTouch,
      keyboard: true,
      inspection: true,
      clipboard: true,
      video: true,
    },
  });
  const helper = http.createServer((req, res) => {
    if (ui.authMarker) res.setHeader("x-iportal-helper-auth", "1");
    if (
      req.headers.authorization !== `Bearer ${ui.helperToken}` ||
      req.headers.origin ||
      req.headers["sec-fetch-site"]
    ) {
      res.writeHead(401);
      res.end();
      return;
    }
    if (req.url === "/v1/video") {
      res.writeHead(200, { "content-type": "multipart/x-mixed-replace; boundary=frame" });
      res.flushHeaders();
      const timer = setInterval(() => {
        res.write(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpeg.length}\r\n\r\n`);
        res.write(jpeg);
        res.write("\r\n");
      }, 100);
      res.on("close", () => clearInterval(timer));
      return;
    }
    if (req.url === "/v1/events") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.flushHeaders();
      const timer = setInterval(
        () => res.write(`event: status\ndata: ${JSON.stringify(status())}\n\n`),
        100,
      );
      res.on("close", () => clearInterval(timer));
      return;
    }
    if (req.url === "/v1/status") {
      if (ui.dropStatus > 0) {
        ui.dropStatus--;
        log.push({ operation: "status", monitor: true, dropped: true });
        return;
      }
      log.push({ operation: "status", monitor: true });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(status()));
      return;
    }
    if (req.url !== "/v1/commands" || req.method !== "POST") {
      res.writeHead(404);
      res.end();
      return;
    }
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const command = JSON.parse(body),
        json = command.arguments,
        operation = command.operation;
      log.push({
        operation,
        body: json,
        id: command.id,
        budgetMs: command.budgetMs,
        generation: command.generation,
        monitor: operation === "presence",
      });
      const reply = (result, error) => {
        const send = () => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              id: command.id,
              generation: command.generation,
              ...(error ? { error } : { result }),
            }),
          );
        };
        if (ui.delayMs) setTimeout(send, ui.delayMs);
        else send();
      };
      const fail = (code, message = code) =>
        reply(undefined, { code, message, outcome: "notExecuted" });
      if (ui.restartBoot) {
        ui.restartBoot = false;
        generation = randomUUID();
      }
      if (command.generation !== generation) return fail("stale generation");
      if (ui.error) return fail(ui.error);
      if (
        [
          "text",
          "key",
          "tapElement",
          "typeElement",
          "home",
          "button",
          "lock",
          "unlock",
          "launch",
          "siri",
        ].includes(operation)
      ) {
        if (ui.locked && !["lock", "unlock"].includes(operation)) return fail("device locked");
        if (json.expectedBundleId && json.expectedBundleId !== ui.app) return fail("app changed");
        if (json.expectedOrientation && json.expectedOrientation !== ui.orientation)
          return fail("orientation changed");
      }
      if (operation === "touch") {
        if (!ui.guardedTouch || ui.removeTouch || (json.fingers && !ui.multiTouch))
          return fail("unsupported operation");
        if (ui.locked) return fail("device locked");
        if (json.expectedBundleId && json.expectedBundleId !== ui.app) return fail("app changed");
        if (json.expectedOrientation && json.expectedOrientation !== ui.orientation)
          return fail("orientation changed");
        log.at(-1).executed = true;
        return reply({
          completed: true,
          timing: { guardMs: 2, playbackMs: 70, confirmationMs: 50 },
        });
      }
      if (operation === "elements") {
        if (ui.staleLookupOnce) {
          ui.staleLookupOnce = false;
          return fail("stale element reference");
        }
        if (json.value === "INVALID") return fail("invalid selector");
        const found = ui.elements.filter((e) =>
          json.using === "class name" ? e.type === json.value : e.name === json.value,
        );
        return reply(
          found.map(({ id, hittable, ...attributes }, index) => ({
            id,
            attributes: {
              identifier: attributes.name,
              selected: false,
              accessible: true,
              ...attributes.rect,
              index,
              ...attributes,
            },
          })),
        );
      }
      if (
        ["attribute", "tapElement", "typeElement"].includes(operation) ||
        (operation === "screenshot" && json.id)
      ) {
        if (ui.staleOnce) {
          ui.staleOnce = false;
          return fail("stale element reference");
        }
        const element = ui.elements.find((e) => e.id === json.id);
        if (!element) return fail("stale element reference");
        if (operation === "tapElement") {
          ui.onClick?.(element);
          return reply(null);
        }
        if (operation === "typeElement") {
          element.value = json.text;
          return reply(null);
        }
        if (operation === "screenshot") return reply(jpeg.toString("base64"));
        return reply(element[json.name] ?? null);
      }
      const app = { bundleId: ui.app, pid: 123, name: "Fixture" };
      switch (operation) {
        case "source":
          return reply(
            json.format === "json"
              ? sourceNode(
                  "Application",
                  null,
                  ui.elements.map((e) => sourceNode(e.type.replace("XCUIElementType", ""), e, [])),
                )
              : "<Application/>",
          );
        case "screenshot":
          return reply(jpeg.toString("base64"));
        case "state":
          return reply({ locked: ui.locked, app, orientation: ui.orientation, screen: ui.size });
        case "app":
          return reply(app);
        case "orientation":
          return reply(ui.orientation);
        case "geometry":
          return reply(ui.size);
        case "lock":
          ui.locked = true;
          return reply(null);
        case "unlock":
          ui.locked = false;
          return reply(null);
        case "launch":
          ui.app = json.bundleId;
          return reply(null);
        case "home":
          ui.app = "com.apple.springboard";
          return reply(null);
        case "quality":
          ui.quality = json.preset;
          return reply(null);
        case "keepAlive":
          return reply({ completed: true });
        case "clipboardStatus":
          return reply({ changeCount: 0 });
        case "text":
        case "key":
        case "button":
        case "siri":
        case "openURL":
          return reply(null);
        case "presence":
        case "portal":
          return reply({
            phase: json.ready ? "connected" : "connecting",
            message: "",
            detail: "",
            keepAwakeRemainingMs: json.keepAwakeMs ?? 0,
            screenInstalled: true,
            width: 390,
            height: 844,
            foreground: true,
            usbEvents: [],
            phaseEvents: [],
          });
        default:
          return fail("unsupported operation");
      }
    });
  });

  // Speaks enough of the usbmuxd plist protocol for ListDevices and Connect.
  fs.rmSync(socketPath, { force: true });
  const mux = net.createServer((sock) => {
    sock.on("error", () => {});
    let buf = Buffer.alloc(0);
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length < 16 || buf.length < buf.readUInt32LE(0)) return;
      const xml = buf.subarray(16, buf.readUInt32LE(0)).toString();
      const msg = (dict) => {
        const b = Buffer.from(
          `<?xml version="1.0"?><plist version="1.0"><dict>${dict}</dict></plist>`,
        );
        const h = Buffer.alloc(16);
        h.writeUInt32LE(16 + b.length, 0);
        h.writeUInt32LE(1, 4);
        h.writeUInt32LE(8, 8);
        h.writeUInt32LE(1, 12);
        sock.write(Buffer.concat([h, b]));
      };
      if (xml.includes("<string>ListDevices</string>")) {
        msg(
          `<key>DeviceList</key><array>${ui.devices.map((d) => `<dict><key>DeviceID</key><integer>${d.id}</integer><key>MessageType</key><string>Attached</string><key>Properties</key><dict><key>ConnectionType</key><string>${d.connection}</string><key>DeviceID</key><integer>${d.id}</integer><key>SerialNumber</key><string>${d.udid}</string></dict></dict>`).join("")}</array>`,
        );
        return;
      }
      if (xml.includes("<string>Listen</string>")) {
        sock.off("data", onData);
        msg("<key>MessageType</key><string>Result</string><key>Number</key><integer>0</integer>");
        subscribers.add(msg);
        ui.devices.forEach((d) => msg(attached(d)));
        sock.on("close", () => subscribers.delete(msg));
        return;
      }
      if (xml.includes("<string>Connect</string>")) {
        sock.off("data", onData);
        const p = +(xml.match(/<key>PortNumber<\/key><integer>(\d+)</)?.[1] ?? "0");
        const port = ((p & 0xff) << 8) | (p >> 8);
        const deviceId = +(xml.match(/<key>DeviceID<\/key><integer>(\d+)</)?.[1] ?? "0");
        log.push({ mux: "connect", port, deviceId });
        if (!ui.devices.some((d) => d.id === deviceId))
          return msg(`<key>Number</key><integer>2</integer>`);
        const target = (ui.targets[deviceId] ?? { 8100: helperPort })[port];
        if (!target)
          return msg(
            `<key>MessageType</key><string>Result</string><key>Number</key><integer>3</integer>`,
          );
        const up = net.connect(target, "127.0.0.1", () => {
          msg(`<key>MessageType</key><string>Result</string><key>Number</key><integer>0</integer>`);
          sock.pipe(up).pipe(sock);
        });
        up.on("error", () => sock.destroy());
        sock.on("close", () => up.destroy());
        up.on("close", () => sock.destroy());
      }
    };
    sock.on("data", onData);
  });

  helper.listen(helperPort, "127.0.0.1");
  mux.listen(socketPath);
  return { log, ui, helperToken, close: () => [helper, mux].forEach((s) => s.close()) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (!/^[a-f0-9]{64}$/.test(process.env.IPORTAL_HELPER_TOKEN ?? ""))
    throw new Error("Set IPORTAL_HELPER_TOKEN to the same 64-character hex value as the server.");
  const { log } = startFakeIphone({
    frame: process.argv[2],
    helperToken: process.env.IPORTAL_HELPER_TOKEN,
  });
  console.log(`fake iPhone up. Run: USBMUXD_SOCKET_ADDRESS=${SOCKET} bun start`);
  setInterval(() => {
    while (log.length) console.log(JSON.stringify(log.shift()));
  }, 200);
}
