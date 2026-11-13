// Fake Android phones for development and tests without a device: a fake adb
// server (the local socket protocol), a fake `adb` executable that only talks to
// that server, and the versioned helper protocol with Android's vocabulary.
// bun test/fake-android.mjs prints the environment to start iPortal against it.
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

const TINY_JPEG = Buffer.from(
  "/9j/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAAAP/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AIEAD//Z",
  "base64",
);
// The service the fake executable uses to reach its server. Real adb has no
// such service, so a misdirected call fails instead of doing anything.
const EXEC = "fake:exec:";

/** @param {string} payload */
const frame = (payload) =>
  Buffer.concat([
    Buffer.from(Buffer.byteLength(payload).toString(16).padStart(4, "0")),
    Buffer.from(payload),
  ]);

/**
 * An append-only record the test can await, so it reacts to what the server
 * did instead of sleeping.
 * @template T
 */
export function createJournal() {
  /** @type {T[]} */
  const entries = [];
  /** @type {Set<() => void>} */
  const waiters = new Set();
  return {
    entries,
    /** @param {T} entry */
    push(entry) {
      entries.push(entry);
      for (const waiter of [...waiters]) waiter();
    },
    /**
     * The first entry at or after `from` that matches, now or later.
     * @param {(entry: T) => unknown} matches
     * @param {{from?: number, timeoutMs?: number, label?: string}} [options]
     * @returns {Promise<T>}
     */
    next(matches, { from = 0, timeoutMs = 5000, label = "entry" } = {}) {
      return new Promise((resolve, reject) => {
        const check = () => {
          const found = entries.slice(from).find(matches);
          if (found === undefined) return;
          waiters.delete(check);
          clearTimeout(timer);
          resolve(found);
        };
        const timer = setTimeout(() => {
          waiters.delete(check);
          reject(new Error(`Timed out waiting for ${label}`));
        }, timeoutMs);
        waiters.add(check);
        check();
      });
    },
  };
}

function sourceNode(type, element, children) {
  return {
    type,
    label: element?.description ?? null,
    value: element?.text ?? null,
    name: element?.text ?? element?.description ?? null,
    rawIdentifier: element?.resourceId ?? null,
    frame: "{{0,0},{0,0}}",
    nativeFrame: "{{0,0},{0,0}}",
    rect: element?.rect ?? { x: 0, y: 0, width: 1080, height: 2400 },
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

/** @param {string} serial @param {{model?: string, wireless?: string | null, build: string}} options */
function createPhone(serial, { model = "Pixel 6a", wireless = null, build }) {
  let nextPid = 4000;
  const ui = {
    locked: /** @type {boolean | null} */ (false),
    // Screen on. A locked phone with its screen on shows the keyguard and takes input.
    interactive: true,
    app: "com.android.settings",
    orientation: "PORTRAIT",
    size: { width: 1080, height: 2400 },
    quality: "balanced",
    typed: "",
    /** What a copy or cut would put on the clipboard. */
    selection: /** @type {string | null} */ (null),
    clipboard: /** @type {{format: string, content: string} | null} */ (null),
    clipboardChanges: 0,
    taps: /** @type {string[]} */ ([]),
    elements: [
      {
        id: "node-1",
        type: "android.widget.Button",
        text: "Continue",
        description: "Continue setup",
        resourceId: "com.android.settings:id/continue_button",
        enabled: true,
        visible: true,
        hittable: true,
        rect: { x: 40, y: 2000, width: 1000, height: 140 },
      },
      {
        id: "node-2",
        type: "android.widget.EditText",
        text: "",
        description: "Search settings",
        resourceId: "com.android.settings:id/search",
        enabled: true,
        visible: true,
        hittable: true,
        rect: { x: 40, y: 200, width: 1000, height: 120 },
      },
    ],
  };
  const phone = {
    serial,
    model,
    /** The address this phone advertises for wireless debugging, if any. */
    wireless,
    /** Files in the phone's temporary storage. */
    files: /** @type {Set<string>} */ (new Set()),
    /** Every helper request received, across helper restarts. */
    log: /** @type {ReturnType<typeof createJournal<Record<string, any>>>} */ (createJournal()),
    /** Running helper processes. */
    processes: /** @type {Record<string, any>[]} */ ([]),
    ui,
    faults: {
      /** Upcoming helper starts that run but never listen. */
      wedge: 0,
      /** How long a started helper takes to listen. */
      startDelayMs: 0,
      /** Upcoming status requests that are answered with a failure. */
      failStatus: 0,
      /** An operation whose next command is received and then never answered. */
      drop: /** @type {string | null} */ (null),
      /** An error code every command fails with. */
      error: /** @type {string | null} */ (null),
    },
    /** The helper that is running, or null. */
    get helper() {
      return phone.processes.at(-1) ?? null;
    },
    /** Changes what the phone shows and tells the helper's listeners at once. */
    update(/** @type {Partial<typeof ui>} */ patch) {
      Object.assign(ui, patch);
      notify();
    },
    /** @param {string} classpath @param {string} socketName @param {string} token */
    start(classpath, socketName, token) {
      // A missing program file or credential ends the real helper at once.
      if (!phone.files.has(classpath) || !/^[a-f0-9]{64}$/.test(token)) return;
      const helper = {
        pid: nextPid++,
        command: `app_process / iportal.Agent --socket ${socketName}`,
        socketName,
        token,
        generation: randomUUID(),
        listening: false,
        tunnels: /** @type {Set<net.Socket>} */ (new Set()),
        subscribers: /** @type {Set<() => void>} */ (new Set()),
        timer: /** @type {ReturnType<typeof setTimeout> | undefined} */ (undefined),
      };
      phone.processes.push(helper);
      if (phone.faults.wedge > 0) return void phone.faults.wedge--;
      const listen = () => (helper.listening = phone.processes.includes(helper));
      if (phone.faults.startDelayMs) helper.timer = setTimeout(listen, phone.faults.startDelayMs);
      else listen();
    },
    /** Ends helper processes whose command line matches, as `pkill -f` does. */
    kill(/** @type {RegExp} */ pattern = /./) {
      for (const helper of phone.processes.filter((item) => pattern.test(item.command))) {
        phone.processes.splice(phone.processes.indexOf(helper), 1);
        clearTimeout(helper.timer);
        helper.listening = false;
        for (const tunnel of helper.tunnels) tunnel.destroy();
      }
    },
    /** One connection to a helper's socket, speaking HTTP as the helper does. */
    serve(/** @type {Record<string, any>} */ helper, /** @type {net.Socket} */ socket, initial) {
      helper.tunnels.add(socket);
      /** @type {Set<() => void>} */
      const closing = new Set();
      socket.on("close", () => {
        helper.tunnels.delete(socket);
        for (const close of closing) close();
      });
      const head = (status, type, length, authenticated = true) =>
        socket.write(
          `HTTP/1.1 ${status} ${status === 200 ? "OK" : "Error"}\r\ncontent-type: ${type}\r\n` +
            "cache-control: no-store\r\n" +
            (authenticated ? "x-iportal-helper-auth: 1\r\n" : "") +
            (length >= 0 ? `content-length: ${length}` : "connection: close") +
            "\r\n\r\n",
        );
      const json = (status, body, authenticated = true) => {
        const bytes = Buffer.from(JSON.stringify(body));
        head(status, "application/json", bytes.length, authenticated);
        socket.write(bytes);
      };
      const status = () => ({
        protocol: 1,
        build,
        generation: helper.generation,
        phase: ui.locked ? "locked" : "ready",
        automationReady: true,
        locked: ui.locked,
        activeOperation: null,
        displayPixels: ui.size,
        capabilities: {
          touch: true,
          multiTouch: true,
          keyboard: true,
          inspection: true,
          clipboard: true,
          video: true,
        },
      });
      /** @param {string} method @param {string} url @param {string} body @returns {boolean} whether the connection takes another request */
      const handle = (method, url, body) => {
        if (method === "GET" && url === "/v1/status") {
          phone.log.push({ operation: "status", monitor: true });
          if (phone.faults.failStatus > 0) {
            phone.faults.failStatus--;
            json(503, { error: "unavailable" });
            return true;
          }
          json(200, status());
          return true;
        }
        if (method === "GET" && url === "/v1/events") {
          head(200, "text/event-stream", -1);
          const send = () => socket.write(`event: status\ndata: ${JSON.stringify(status())}\n\n`);
          send();
          helper.subscribers.add(send);
          const timer = setInterval(send, 1000);
          closing.add(() => (clearInterval(timer), helper.subscribers.delete(send)));
          return false;
        }
        if (method === "GET" && url === "/v1/video") {
          head(200, "multipart/x-mixed-replace; boundary=frame", -1);
          const send = () => {
            socket.write(
              `--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${TINY_JPEG.length}\r\n\r\n`,
            );
            socket.write(TINY_JPEG);
            socket.write("\r\n");
          };
          send();
          const timer = setInterval(send, 100);
          closing.add(() => clearInterval(timer));
          return false;
        }
        if (method !== "POST" || url !== "/v1/commands") {
          json(404, { error: "not found" });
          return true;
        }
        const command = JSON.parse(body),
          args = command.arguments ?? {},
          operation = command.operation;
        const entry = {
          operation,
          body: args,
          id: command.id,
          budgetMs: command.budgetMs,
          generation: command.generation,
          monitor: operation === "presence",
        };
        phone.log.push(entry);
        const reply = (result, error) =>
          json(200, {
            id: command.id,
            generation: helper.generation,
            ...(error ? { error } : { result }),
          });
        const fail = (code, message = code) =>
          reply(undefined, { code, message, outcome: "notExecuted" });
        const answer = () => {
          if (command.generation !== helper.generation)
            return fail("stale generation", "The helper restarted");
          if (phone.faults.error) return fail(phone.faults.error);
          // "screen": needs the screen on only (touch, typing, keys, Home).
          // true: needs the phone unlocked. false: allowed in any state.
          const guarded = (/** @type {boolean | "screen"} */ needs = true) => {
            if (needs === "screen" && !ui.interactive) fail("device locked", "Wake the device");
            else if (needs === true && ui.locked) fail("device locked", "Unlock the device");
            else if (args.expectedBundleId && args.expectedBundleId !== ui.app)
              fail("app changed", "Foreground app changed");
            else if (args.expectedOrientation && args.expectedOrientation !== ui.orientation)
              fail("orientation changed", "Screen orientation changed");
            else return true;
            return false;
          };
          const app = { pid: 4321, bundleId: ui.app, name: ui.app };
          const element = () => ui.elements.find((item) => item.id === args.id);
          const attributes = (item, index = 0) => ({
            type: item.type,
            name: item.text || item.description || null,
            label: item.text || item.description || "",
            value: item.type.endsWith("EditText") ? item.text : null,
            enabled: item.enabled,
            visible: item.visible,
            selected: false,
            hittable: item.hittable,
            accessible: true,
            rect: item.rect,
            identifier: item.resourceId ?? "",
            ...item.rect,
            index,
          });
          switch (operation) {
            case "power":
              return reply({ interactive: ui.interactive });
            case "touch":
              if (!guarded("screen")) return;
              entry.executed = true;
              return reply({
                completed: true,
                timing: { guardMs: 1, playbackMs: args.end, confirmationMs: 0 },
              });
            case "text":
              if (!guarded("screen")) return;
              ui.typed += args.text;
              return reply(null);
            case "key":
              if (!guarded("screen")) return;
              // The server sends the Mac's Command; the helper maps it to Control.
              if (args.modifiers.includes("command") && "cx".includes(args.key) && ui.selection) {
                ui.clipboard = {
                  format: "text",
                  content: Buffer.from(ui.selection).toString("base64"),
                };
                ui.clipboardChanges++;
              }
              return reply(null);
            case "home":
              if (!guarded("screen")) return;
              ui.app = "com.google.android.apps.nexuslauncher";
              return reply(null);
            case "button":
              if (!guarded(false)) return;
              return reply(null);
            case "lock":
            case "unlock":
              if (!guarded(false)) return;
              // Power off locks; Wake turns the screen on and an insecure keyguard goes.
              ui.locked = operation === "lock";
              ui.interactive = operation === "unlock";
              reply(null);
              return notify();
            case "launch":
              if (!guarded()) return;
              ui.app = args.bundleId;
              return reply(null);
            case "openURL":
              if (!guarded()) return;
              ui.app = "com.android.chrome";
              return reply(null);
            case "keepAlive":
              return reply({ completed: true });
            case "state":
              return reply({
                locked: ui.locked,
                app,
                orientation: ui.orientation,
                screen: ui.size,
              });
            case "app":
              return reply(app);
            case "orientation":
              return reply(ui.orientation);
            case "geometry":
              return reply(ui.size);
            case "elements": {
              /** @type {Record<string, (item: typeof ui.elements[number]) => boolean>} */
              const strategies = {
                "accessibility id": (item) => item.description === args.value,
                id: (item) =>
                  item.resourceId === args.value || item.resourceId.endsWith(`:id/${args.value}`),
                name: (item) => item.text === args.value || item.description === args.value,
                text: (item) => item.text === args.value,
                "class name": (item) => item.type === args.value,
              };
              if (!Object.hasOwn(strategies, args.using)) return fail("invalid selector");
              return reply(
                ui.elements
                  .filter(strategies[args.using])
                  .map((item, index) => ({ id: item.id, attributes: attributes(item, index) })),
              );
            }
            case "attribute": {
              const item = element();
              return item
                ? reply(attributes(item)[args.name] ?? null)
                : fail("stale element reference");
            }
            case "tapElement":
            case "typeElement":
            case "elementAction": {
              if (!guarded()) return;
              const item = element();
              if (!item) return fail("stale element reference");
              if (operation === "tapElement") ui.taps.push(item.id);
              else if (operation === "typeElement" || args.action === "replaceText")
                item.text = args.text;
              return reply(null);
            }
            case "source":
              return reply(
                args.format === "json"
                  ? sourceNode(
                      "android.widget.FrameLayout",
                      null,
                      ui.elements.map((item) => sourceNode(item.type, item, [])),
                    )
                  : "<hierarchy/>",
              );
            case "screenshot":
              if (args.id && !element()) return fail("stale element reference");
              return reply(TINY_JPEG.toString("base64"));
            case "clipboardPrepare":
              // Android needs no foreground handoff, so nothing is restored.
              return reply({
                lease: randomUUID(),
                helperBundleId: "com.android.shell",
                restoreBundleId: null,
              });
            case "clipboardStatus":
              return reply({ changeCount: ui.clipboardChanges });
            case "clipboardRead":
              return reply(ui.clipboard ?? { empty: true });
            case "clipboardWrite":
              ui.clipboard = { format: args.format, content: args.content };
              ui.clipboardChanges++;
              return reply({
                format: args.format,
                bytes: Buffer.from(args.content, "base64").length,
              });
            case "clipboardRestore":
            case "clipboardCancel":
              return reply({ cancelled: true });
            case "presence":
            case "portal":
              return reply({
                phase: args.ready ? "connected" : "waiting",
                message: args.ready ? "Connected" : "Waiting",
                detail: "",
                keepAwakeRemainingMs: args.keepAwakeMs ?? 0,
                screenInstalled: false,
                ...ui.size,
                foreground: false,
                usbEvents: [],
                phaseEvents: [],
              });
            case "quality":
              ui.quality = args.preset;
              return reply(null);
            case "shutdown":
              reply(null);
              // The reply is written before the process ends, as on the phone.
              return void setImmediate(() =>
                phone.kill(new RegExp(`--socket ${helper.socketName}$`)),
              );
            default:
              return fail("unsupported operation", `Unsupported on Android: ${operation}`);
          }
        };
        if (phone.faults.drop === operation) {
          phone.faults.drop = null;
          entry.dropped = true;
          socket.destroy();
          return false;
        }
        answer();
        return true;
      };
      let buffer = Buffer.from(initial);
      let open = true;
      const read = () => {
        while (open) {
          const end = buffer.indexOf("\r\n\r\n");
          if (end < 0) return;
          const [request, ...lines] = buffer.subarray(0, end).toString("latin1").split("\r\n");
          const headers = Object.fromEntries(
            lines.map((line) => {
              const colon = line.indexOf(":");
              return [line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim()];
            }),
          );
          const length = Number(headers["content-length"] ?? 0);
          if (buffer.length < end + 4 + length) return;
          const body = buffer.subarray(end + 4, end + 4 + length).toString("utf8");
          buffer = buffer.subarray(end + 4 + length);
          const [method, url] = request.split(" ");
          if (headers.authorization !== `Bearer ${helper.token}`) {
            phone.log.push({ operation: "unauthorized", monitor: true });
            json(401, { error: "unauthorized" }, false);
            socket.end();
            open = false;
          } else open = handle(method, url, body);
        }
      };
      socket.on("data", (chunk) => {
        buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
        read();
      });
      read();
    },
  };
  const notify = () => {
    for (const helper of phone.processes) for (const send of helper.subscribers) send();
  };
  return phone;
}

/**
 * @param {{directory: string}} options a private folder for the fake executable
 */
export async function startFakeAndroid({ directory }) {
  // The fake stands in for the helper built from this tree.
  const { androidHelperBuild: build } = await import("../android/protocol.ts");
  /** @type {Map<string, ReturnType<typeof createPhone>>} */
  const phones = new Map();
  /** @type {{id: string, serial: string, usb: boolean, state: string, number: number, tunnels: Set<net.Socket>}[]} */
  const transports = [];
  /** Every call of the fake executable: its arguments and standard input. */
  const calls =
    /** @type {ReturnType<typeof createJournal<{args: string[], input: string, at: number, unsupported?: boolean}>>} */ (
      createJournal()
    );
  /** Every service asked of the adb server socket. */
  const services = /** @type {string[]} */ ([]);
  /** @type {Set<net.Socket>} */
  const trackers = new Set();
  /** @type {Set<net.Socket>} */
  const sockets = new Set();
  let nextTransport = 1;

  const listing = () =>
    transports
      .map((transport) =>
        [
          transport.id.padEnd(22),
          transport.state,
          ...(transport.usb ? ["usb:1048576X"] : []),
          ...(transport.state === "device"
            ? [
                "product:fake",
                `model:${phones.get(transport.serial)?.model.replaceAll(" ", "_")}`,
                "device:fake",
              ]
            : []),
          `transport_id:${transport.number}`,
        ].join(" "),
      )
      .join("\n")
      .concat(transports.length ? "\n" : "");
  const changed = () => {
    for (const tracker of trackers) tracker.write(frame(listing()));
  };
  /** @param {string} id */
  const drop = (id) => {
    const index = transports.findIndex((transport) => transport.id === id);
    if (index < 0) return false;
    for (const tunnel of transports.splice(index, 1)[0].tunnels) tunnel.destroy();
    return true;
  };

  /** @param {string} command @param {string} input @param {ReturnType<typeof createPhone>} phone */
  const shell = (command, input, phone) => {
    /** @type {RegExpMatchArray | null} */
    let match;
    if (command === "getprop ro.serialno") return { code: 0, output: `${phone.serial}\n` };
    if ((match = command.match(/^\[ -f (\S+) \] && echo present \|\| echo absent$/)))
      return { code: 0, output: phone.files.has(match[1]) ? "present\n" : "absent\n" };
    if ((match = command.match(/^rm -f (\S+)$/))) {
      const pattern = new RegExp(`^${match[1].replaceAll(".", "\\.").replaceAll("*", ".*")}$`);
      for (const file of phone.files) if (pattern.test(file)) phone.files.delete(file);
      return { code: 0, output: "" };
    }
    if ((match = command.match(/^pgrep -f "([^"]+)" \|\| true$/))) {
      const pattern = new RegExp(match[1]);
      return {
        code: 0,
        output: phone.processes
          .filter((helper) => pattern.test(helper.command))
          .map((helper) => `${helper.pid}\n`)
          .join(""),
      };
    }
    if ((match = command.match(/^pkill -f "([^"]+)" ; true$/))) {
      phone.kill(new RegExp(match[1]));
      return { code: 0, output: "" };
    }
    if (
      (match = command.match(
        /^read -r IPORTAL_HELPER_TOKEN \|\| exit 1; export IPORTAL_HELPER_TOKEN; CLASSPATH=(\S+) nohup app_process \/ iportal\.Agent --socket (\S+) >\S+ 2>&1 &$/,
      ))
    ) {
      // `read` fails without a complete line, and the helper is never started.
      if (!input.includes("\n")) return { code: 1, output: "" };
      phone.start(match[1], match[2], input.slice(0, input.indexOf("\n")));
      return { code: 0, output: "" };
    }
    return null;
  };

  /** @param {string[]} args @param {string} input */
  const execute = (args, input) => {
    if (args[0] === "start-server") return { code: 0, output: "" };
    if (args[0] === "mdns" && args[1] === "services")
      return {
        code: 0,
        output:
          "List of discovered mdns services\n" +
          [...phones.values()]
            .filter((phone) => phone.wireless)
            .map(
              (phone) => `adb-${phone.serial}-fAkE01\t_adb-tls-connect._tcp\t${phone.wireless}\n`,
            )
            .join(""),
      };
    if (args[0] === "connect" && args.length === 2) {
      const phone = [...phones.values()].find((item) => item.wireless === args[1]);
      if (!phone) return { code: 1, output: `failed to connect to ${args[1]}\n` };
      api.attach(phone.serial, { id: args[1], usb: false });
      return { code: 0, output: `connected to ${args[1]}\n` };
    }
    if (args[0] !== "-s") return null;
    const transport = transports.find((item) => item.id === args[1]);
    if (!transport) return { code: 1, output: `adb: device '${args[1]}' not found\n` };
    if (transport.state !== "device")
      return { code: 1, output: `adb: device ${transport.state}.\n` };
    const phone = /** @type {ReturnType<typeof createPhone>} */ (phones.get(transport.serial));
    if (args[2] === "shell") return shell(args.slice(3).join(" "), input, phone);
    if (args[2] === "push" && args.length === 5) {
      if (!fs.existsSync(args[3]))
        return { code: 1, output: `adb: error: cannot stat '${args[3]}'\n` };
      phone.files.add(args[4]);
      return { code: 0, output: `${args[3]}: 1 file pushed\n` };
    }
    return null;
  };

  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    let buffer = Buffer.alloc(0);
    /** @type {(typeof transports)[number] | undefined} */
    let transport;
    /** @param {string} message */
    const refuse = (message) => socket.end(Buffer.concat([Buffer.from("FAIL"), frame(message)]));
    /** @param {Buffer} chunk */
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        if (buffer.length < 4) return;
        const length = parseInt(buffer.subarray(0, 4).toString("latin1"), 16);
        if (Number.isNaN(length)) return void socket.destroy();
        if (buffer.length < 4 + length) return;
        const service = buffer.subarray(4, 4 + length).toString("utf8");
        buffer = buffer.subarray(4 + length);
        if (service.startsWith(EXEC)) {
          const { args, input } = JSON.parse(service.slice(EXEC.length));
          const result = execute(args, input);
          calls.push({ args, input, at: Date.now(), ...(result ? {} : { unsupported: true }) });
          return void socket.end(
            JSON.stringify(result ?? { code: 1, output: "fake adb: unsupported command\n" }),
          );
        }
        services.push(service);
        if (service === "host:devices-l")
          return void socket.end(Buffer.concat([Buffer.from("OKAY"), frame(listing())]));
        if (service === "host:track-devices-l") {
          trackers.add(socket);
          socket.on("close", () => trackers.delete(socket));
          socket.write(Buffer.concat([Buffer.from("OKAY"), frame(listing())]));
        } else if (service.startsWith("host:transport:")) {
          const id = service.slice("host:transport:".length);
          transport = transports.find((item) => item.id === id);
          if (!transport) return void refuse(`device '${id}' not found`);
          if (transport.state !== "device") return void refuse(`device ${transport.state}`);
          socket.write("OKAY");
        } else if (transport && service.startsWith("localabstract:")) {
          const phone = /** @type {ReturnType<typeof createPhone>} */ (
            phones.get(transport.serial)
          );
          const name = service.slice("localabstract:".length);
          const helper = phone.processes.find((item) => item.socketName === name && item.listening);
          if (!helper) return void refuse("closed");
          // From here the connection is a raw stream to the helper's socket.
          socket.off("data", onData);
          const route = transport;
          route.tunnels.add(socket);
          socket.on("close", () => route.tunnels.delete(socket));
          socket.write("OKAY");
          return phone.serve(helper, socket, buffer);
        } else return void refuse("unknown host service");
      }
    };
    socket.on("data", onData);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(undefined));
  });
  const { port } = /** @type {net.AddressInfo} */ (server.address());

  // The server under test starts `adb` by path. This one never runs the real
  // adb and never starts an adb server: it only asks the fake server above.
  const executable = path.join(directory, "adb");
  fs.writeFileSync(
    executable,
    `#!/bin/sh\nexec "${process.execPath}" "${import.meta.filename}" --adb "$@"\n`,
    { mode: 0o755 },
  );

  const api = {
    port,
    executable,
    /** The environment that points iPortal at this fake instead of the real adb. */
    env: { ADB: executable, ANDROID_ADB_SERVER_PORT: String(port) },
    phones,
    calls,
    services,
    /** Calls with a transport, as `-s <id> <command> ...`, by command text. */
    /** @param {RegExp} pattern @param {number} [from] */
    shells: (pattern, from = 0) =>
      calls.entries
        .slice(from)
        .filter((call) => call.args[2] === "shell" && pattern.test(call.args.slice(3).join(" "))),
    /** @param {string} serial @param {{model?: string, wireless?: string | null}} [options] */
    addPhone(serial, options = {}) {
      const phone = createPhone(serial, { ...options, build });
      phones.set(serial, phone);
      return phone;
    },
    /** @param {string} serial @param {{id?: string, usb?: boolean, state?: string}} [options] */
    attach(serial, { id = serial, usb = true, state = "device" } = {}) {
      if (transports.some((transport) => transport.id === id)) return;
      transports.push({ id, serial, usb, state, number: nextTransport++, tunnels: new Set() });
      changed();
    },
    /** @param {...string} ids removed together, as one device-list change */
    detach(...ids) {
      if (ids.map(drop).some(Boolean)) changed();
    },
    /** @param {string} id @param {string} state */
    setState(id, state) {
      const transport = transports.find((item) => item.id === id);
      if (!transport || transport.state === state) return;
      transport.state = state;
      if (state !== "device") for (const tunnel of transport.tunnels) tunnel.destroy();
      changed();
    },
    /** The adb server going away, as when it is killed or restarted. */
    dropTracking() {
      for (const tracker of trackers) tracker.destroy();
    },
    close() {
      for (const phone of phones.values()) phone.kill();
      for (const socket of sockets) socket.destroy();
      server.close();
    },
  };
  return api;
}

/** The fake `adb` executable: forwards its arguments and input to the fake server. */
async function runAsAdb(/** @type {string[]} */ args) {
  const port = Number(process.env.ANDROID_ADB_SERVER_PORT);
  // Without a fake server there is nothing to ask. Never fall through to the
  // real adb server's port, where `start-server` and `connect` would be real.
  if (!Number.isInteger(port) || port <= 0 || port === 5037) {
    process.stderr.write("fake adb: ANDROID_ADB_SERVER_PORT does not name a fake server\n");
    process.exit(1);
  }
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  const socket = net.connect({ host: "127.0.0.1", port });
  socket.write(frame(EXEC + JSON.stringify({ args, input })));
  let reply = "";
  for await (const chunk of socket) reply += chunk;
  const { code, output } = JSON.parse(reply);
  process.stdout.write(output);
  process.exitCode = code;
}

if (import.meta.main) {
  if (process.argv[2] === "--adb") await runAsAdb(process.argv.slice(3));
  else {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fake-android-"));
    process.on("exit", () => fs.rmSync(directory, { recursive: true, force: true }));
    process.on("SIGINT", () => process.exit());
    const jar = path.join(directory, "iportal-agent.jar");
    fs.writeFileSync(jar, "not a real helper");
    const fake = await startFakeAndroid({ directory });
    const phone = fake.addPhone("FAKEANDROID0001");
    fake.attach(phone.serial);
    console.log(
      `fake Android phone up. Run: ADB=${fake.executable} ANDROID_ADB_SERVER_PORT=${fake.port} ` +
        `IPORTAL_ANDROID_AGENT=${jar} bun iportal.mjs --platform android`,
    );
    let printed = 0;
    setInterval(() => {
      for (const entry of phone.log.entries.slice(printed))
        if (!entry.monitor) console.log(JSON.stringify(entry));
      printed = phone.log.entries.length;
    }, 200);
  }
}
