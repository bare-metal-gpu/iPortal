import { expect, test } from "bun:test";
import net from "node:net";
import { Effect, Fiber, Schema } from "effect";
import {
  createAdb,
  locateAdb,
  parseDevices,
  parseMdns,
  serialFromTransport,
} from "../android/adb.mjs";
import { attachmentProblem, selectAndroidDevice } from "../android/devices.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Database } from "bun:sqlite";
import { commandContext, createScheduler } from "../scheduler.ts";
import { createCommands, fingerprint } from "../commands.ts";
import { createLiveTouch } from "../android/live-touch.ts";
import {
  admittedWhileLocked,
  androidLifecycle,
  lockedError,
  privateLedger,
} from "../android/lock.ts";
import {
  AndroidActionSchemas,
  AndroidRequestSchemas,
  androidHelperProtocol,
  androidOperations,
  parseAndroidRequest,
  validateAndroidResponse,
} from "../android/protocol.ts";
import { RequestSchemas } from "../schemas.ts";
import { startServer } from "../server.mjs";
import { createHelperAuthentication } from "../helper-auth.mjs";
import { helperOperations, iosHelperProtocol } from "../helper-protocol.ts";
import { validatePublicResponse } from "../responses.ts";

const listing =
  "25271JEGR16740         device usb:1048576X product:bluejay model:Pixel_6a device:bluejay transport_id:18\n" +
  "192.168.2.72:41811     device product:bluejay model:Pixel_6a device:bluejay transport_id:19\n" +
  "ABC123                 unauthorized usb:1048577X transport_id:20\n";

test("parses the adb device list", () => {
  expect(parseDevices(listing)).toEqual([
    { id: "25271JEGR16740", state: "device", usb: true, model: "Pixel 6a" },
    { id: "192.168.2.72:41811", state: "device", usb: false, model: "Pixel 6a" },
    { id: "ABC123", state: "unauthorized", usb: true, model: null },
  ]);
  expect(parseDevices("")).toEqual([]);
});

test("reads a hardware serial only from transports that carry one", () => {
  expect(serialFromTransport("25271JEGR16740", true)).toBe("25271JEGR16740");
  expect(serialFromTransport("adb-25271JEGR16740-ctLGh8._adb-tls-connect._tcp", false)).toBe(
    "25271JEGR16740",
  );
  expect(serialFromTransport("192.168.2.72:41811", false)).toBeNull();
  expect(serialFromTransport("emulator-5554", false)).toBeNull();
});

test("parses advertised wireless debugging services", () => {
  const output =
    "List of discovered mdns services\n" +
    "adb-25271JEGR16740-ctLGh8\t_adb-tls-connect._tcp\t192.168.2.72:41811\n" +
    "adb-OTHER-xyz\t_adb-tls-pairing._tcp\t192.168.2.80:40000\n";
  expect(parseMdns(output)).toEqual([{ serial: "25271JEGR16740", address: "192.168.2.72:41811" }]);
});

test("locates adb from the environment before well-known folders", () => {
  const exists = (file: string) => file === "/sdk/platform-tools/adb" || file === "/custom/adb";
  expect(locateAdb({ PATH: "/usr/bin", ANDROID_HOME: "/sdk" }, exists)).toBe(
    "/sdk/platform-tools/adb",
  );
  expect(locateAdb({ ADB: "/custom/adb", ANDROID_HOME: "/sdk" }, exists)).toBe("/custom/adb");
  expect(locateAdb({ PATH: "" }, () => false)).toBeNull();
});

const usb = {
  id: "25271JEGR16740",
  udid: "25271JEGR16740",
  connection: "USB",
  transport: "usb",
  model: "Pixel 6a",
} as const;
const wifi = {
  ...usb,
  id: "192.168.2.72:41811",
  connection: "Network",
  transport: "wifi",
} as const;
const other = { ...usb, id: "OTHER", udid: "OTHER" } as const;

test("one phone on two transports is one device, preferring USB", () => {
  expect(selectAndroidDevice([wifi, usb], null)).toBe(usb);
  expect(selectAndroidDevice([wifi], "25271JEGR16740")).toBe(wifi);
  // Losing the pinned phone never selects another one.
  expect(selectAndroidDevice([other], "25271JEGR16740")).toBeNull();
  expect(selectAndroidDevice([], null)).toBeNull();
});

test("explains an attached device that cannot be used yet", () => {
  expect(attachmentProblem(parseDevices(listing))).toContain("Allow");
  expect(attachmentProblem([{ id: "x", state: "offline", usb: true, model: null }])).toContain(
    "Reconnect",
  );
  expect(attachmentProblem([])).toBeNull();
});

test("Android keeps its own vocabulary and the iPhone's is unchanged", () => {
  const decode = (schema: Schema.ConstraintDecoder<unknown>, value: unknown) =>
    Schema.decodeUnknownSync(schema, { onExcessProperty: "error" })(value);
  // Android: resource IDs and text, class names as types, a Back button, no Siri.
  expect(() =>
    decode(androidOperations.elements.request, { using: "text", value: "OK" }),
  ).not.toThrow();
  expect(() =>
    decode(androidOperations.elements.request, { using: "predicate string", value: "x" }),
  ).toThrow();
  expect(() => decode(androidOperations.button.request, { name: "back" })).not.toThrow();
  expect("siri" in androidOperations).toBe(false);
  expect(Object.hasOwn(AndroidRequestSchemas, "siri")).toBe(false);
  expect(() => parseAndroidRequest("button", { name: "back" })).not.toThrow();
  expect(() => parseAndroidRequest("siri", { text: "hello" })).toThrow();
  expect(
    androidHelperProtocol.decodeResult(
      "attribute",
      { id: "a1", name: "type" },
      "android.widget.Button",
    ),
  ).toBe("android.widget.Button");
  expect(() =>
    androidHelperProtocol.decodeResult("attribute", { id: "a1", name: "type" }, "not a class"),
  ).toThrow();

  // iPhone: exactly as before.
  expect(() =>
    decode(helperOperations.elements.request, { using: "predicate string", value: "x" }),
  ).not.toThrow();
  expect(() => decode(helperOperations.elements.request, { using: "text", value: "OK" })).toThrow();
  expect(() => decode(helperOperations.button.request, { name: "back" })).toThrow();
  expect(() => decode(RequestSchemas.button, { name: "back" })).toThrow();
  expect(Object.hasOwn(RequestSchemas, "siri")).toBe(true);
  expect(() =>
    iosHelperProtocol.decodeResult(
      "attribute",
      { id: "e1", name: "type" },
      "android.widget.Button",
    ),
  ).toThrow();
  expect(
    iosHelperProtocol.decodeResult(
      "attribute",
      { id: "e1", name: "type" },
      "XCUIElementTypeButton",
    ),
  ).toBe("XCUIElementTypeButton");
});

test("public responses are validated against the platform that produced them", () => {
  const element = (type: string) => ({ ok: true, value: { id: "1", type } });
  expect(() => validateAndroidResponse("element", element("android.widget.Button"))).not.toThrow();
  expect(() => validatePublicResponse("element", element("android.widget.Button"))).toThrow();
  expect(() => validatePublicResponse("element", element("XCUIElementTypeButton"))).not.toThrow();
});

test("Android selects by the XPath subset its helper implements", () => {
  const decode = (schema: Schema.ConstraintDecoder<unknown>, value: unknown) =>
    Schema.decodeUnknownSync(schema, { onExcessProperty: "error" })(value);
  // The path format the Mac accessibility bridge builds from the UI tree.
  for (const value of ["/*[1]/*[3]/*[2]", "//android.widget.Button[@text='OK']"]) {
    expect(() =>
      decode(androidOperations.elements.request, { using: "xpath", value }),
    ).not.toThrow();
    expect(() =>
      parseAndroidRequest("elements", { selector: { using: "xpath", value } }),
    ).not.toThrow();
    expect(() => parseAndroidRequest("tap", { selector: { using: "xpath", value } })).not.toThrow();
  }
  expect(() =>
    parseAndroidRequest("elements", { selector: { using: "class chain", value: "x" } }),
  ).toThrow();
});

// The helper's XPath evaluator has no Android dependency, so the real code runs here.
test.skipIf(!Bun.which("javac") || !Bun.which("java"))(
  "the helper's XPath subset selects correctly and refuses what it does not support",
  () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), "iportal-xpath-"));
    try {
      const source = (name: string) =>
        fileURLToPath(new URL(`../android/agent/${name}`, import.meta.url));
      const compiled = Bun.spawnSync([
        "javac",
        "-nowarn",
        "-d",
        out,
        source("src/iportal/XPath.java"),
        source("src/iportal/Failure.java"),
        source("test/iportal/XPathCheck.java"),
      ]);
      expect(compiled.stderr.toString()).toBe("");
      const ran = Bun.spawnSync(["java", "-cp", out, "iportal.XPathCheck"]);
      expect(ran.stdout.toString().trim()).toBe("ok");
      expect(ran.exitCode).toBe(0);
    } finally {
      fs.rmSync(out, { recursive: true, force: true });
    }
  },
);

// ---- live touch ----

test("live touch has its own route and contract, on Android only", () => {
  const decode = (schema: Schema.ConstraintDecoder<unknown>, value: unknown) =>
    Schema.decodeUnknownSync(schema, { onExcessProperty: "error" })(value);
  const stroke = "s-1";
  const one = [[0.25, 0.5]];
  const two = [
    [0.4, 0.5],
    [0.6, 0.5],
  ];
  for (const body of [
    { stroke, phase: "down", points: one },
    { stroke, phase: "down", points: two, expectedApp: "com.android.settings" },
    { stroke, phase: "down", points: one, expectedOrientation: "PORTRAIT" },
    { stroke, phase: "move", points: two },
    { stroke, phase: "up" },
    { stroke, phase: "up", points: one },
    { stroke, phase: "cancel" },
  ])
    expect(() => parseAndroidRequest("pointer", body)).not.toThrow();
  for (const body of [
    { stroke, phase: "down" },
    { stroke, phase: "move" },
    { stroke, phase: "cancel", points: one },
    { stroke, phase: "move", points: one, expectedApp: "com.android.settings" },
    { stroke, phase: "down", points: [] },
    { stroke, phase: "down", points: [...two, [0.5, 0.5]] },
    { stroke, phase: "down", points: [[1.2, 0.5]] },
    { stroke, phase: "down", points: [[0.5, 0.5, 40]] },
    { stroke, phase: "press", points: one },
    { phase: "down", points: one },
    { stroke: "not an id", phase: "down", points: one },
    // A stroke is never replayed, so it takes no receipt and no postcondition.
    { stroke, phase: "down", points: one, requestId: "r1" },
    { stroke, phase: "down", points: one, waitFor: { selector: { using: "text", value: "OK" } } },
  ])
    expect(() => parseAndroidRequest("pointer", body)).toThrow();
  expect(Object.hasOwn(AndroidActionSchemas, "pointer")).toBe(false);
  expect(Object.hasOwn(RequestSchemas, "pointer")).toBe(false);
  expect("pointer" in helperOperations).toBe(false);

  expect(androidOperations.pointer.mutates).toBe(true);
  expect(() =>
    decode(androidOperations.pointer.request, {
      stroke,
      phase: "down",
      points: one,
      expectedBundleId: "com.android.settings",
    }),
  ).not.toThrow();
  expect(() => decode(androidOperations.pointer.request, { stroke, phase: "move" })).toThrow();
  expect(androidHelperProtocol.decodeResult("pointer", {}, null)).toBeNull();

  expect(() => validateAndroidResponse("pointer", { ok: true })).not.toThrow();
  expect(() =>
    validateAndroidResponse("pointer", { ok: false, error: "ended", code: "stroke ended" }),
  ).not.toThrow();
  expect(() => validateAndroidResponse("pointer", { ok: "yes" })).toThrow();
  expect(() => validatePublicResponse("pointer", { ok: true })).toThrow();
});

/** A helper stand-in that records pointer operations and can fail or stall them. */
function strokeRig(options: { idleMs?: number; maxMs?: number; admitMs?: number } = {}) {
  const sent: string[] = [];
  const scheduler = createScheduler();
  let transport = new AbortController();
  let fail: ((phase: string) => unknown) | undefined;
  let ended = 0;
  const live = createLiveTouch({
    send: async (args) => {
      sent.push(`${args.phase}:${args.stroke}`);
      // Only the down may carry its request's deadline; see live-touch.ts.
      if ((args.phase === "down") !== Boolean(commandContext.getStore()?.deadline))
        sent.push("wrong context");
      const failure = fail?.(args.phase);
      if (failure) throw failure;
    },
    enqueue: scheduler.enqueue,
    transportSignal: () => transport.signal,
    onEnd: () => ended++,
    ...options,
  });
  const point = [[0.5, 0.5]] as const;
  const request = new AbortController().signal;
  return {
    sent,
    scheduler,
    live,
    ended: () => ended,
    failing(next: typeof fail) {
      fail = next;
    },
    reroute() {
      transport.abort(new Error("Device connection changed"));
      transport = new AbortController();
    },
    down: (stroke: string) => live.handle({ stroke, phase: "down", points: point }, request),
    move: (stroke: string) => live.handle({ stroke, phase: "move", points: point }, request),
    up: (stroke: string) => live.handle({ stroke, phase: "up" }, request),
    cancel: (stroke: string) => live.handle({ stroke, phase: "cancel" }, request),
  };
}
const code = (promise: Promise<unknown>) =>
  promise.then(
    () => "resolved",
    (error: { code?: string }) => error.code ?? "error",
  );
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
/** Whether the stroke has handed the queue back. The scheduler notices a moment after. */
const released = async (rig: ReturnType<typeof strokeRig>) => {
  await tick();
  const { active, queued } = rig.scheduler.stats();
  return !active && queued === 0;
};

test("a live stroke owns the queue from down to up, so nothing runs between its events", async () => {
  const rig = strokeRig();
  const order: string[] = [];
  await rig.down("a");
  const inspection = rig.scheduler.enqueue(() => {
    order.push("inspection");
  });
  await rig.move("a");
  await rig.move("a");
  await tick();
  expect(order).toEqual([]);
  expect(rig.scheduler.stats()).toMatchObject({ active: true, queued: 1 });
  await rig.up("a");
  await inspection;
  expect(order).toEqual(["inspection"]);
  expect(rig.sent).toEqual(["down:a", "move:a", "move:a", "up:a"]);
  expect(rig.ended()).toBe(1);
  expect(rig.live.active).toBe(false);
  // The stroke is over: its ID addresses nothing, and nothing is replayed.
  expect(await code(rig.move("a"))).toBe("stroke ended");
  expect(await code(rig.up("a"))).toBe("stroke ended");
  expect(await code(rig.cancel("a"))).toBe("resolved");
  expect(rig.sent).toHaveLength(4);
});

test("a live stroke waits its turn, and events sent early keep their order", async () => {
  const rig = strokeRig();
  let finish = () => {};
  const running = rig.scheduler.enqueue(() => new Promise<void>((resolve) => (finish = resolve)));
  const down = rig.down("a");
  const move = rig.move("a");
  await tick();
  expect(rig.sent).toEqual([]);
  finish();
  await Promise.all([running, down, move]);
  await rig.up("a");
  expect(rig.sent).toEqual(["down:a", "move:a", "up:a"]);

  // A down that cannot start in time is refused; it never lands late.
  const slow = strokeRig({ admitMs: 20 });
  const blocked = slow.scheduler.enqueue(() => new Promise<void>((resolve) => (finish = resolve)));
  expect(await code(slow.down("late"))).toBe("timeout");
  finish();
  await blocked;
  expect(slow.sent).toEqual([]);
  expect(await released(slow)).toBe(true);
});

test("a live stroke always ends with the finger up", async () => {
  // An event that fails is not retried: the stroke is cancelled and the queue released.
  const failed = strokeRig();
  await failed.down("a");
  failed.failing((phase) => (phase === "move" ? new Error("Helper request failed") : undefined));
  expect(await code(failed.move("a"))).toBe("error");
  expect(failed.sent).toEqual(["down:a", "move:a", "cancel:a"]);
  expect(await released(failed)).toBe(true);
  expect(await code(failed.move("a"))).toBe("stroke ended");

  // The helper already lifted the finger: nothing is left to cancel.
  const gone = strokeRig();
  await gone.down("a");
  gone.failing(() => Object.assign(new Error("lifted"), { code: "stroke ended" }));
  expect(await code(gone.move("a"))).toBe("stroke ended");
  expect(gone.sent).toEqual(["down:a", "move:a"]);
  expect(await released(gone)).toBe(true);

  // A refused down touched nothing; one of unknown outcome may have.
  const refused = strokeRig();
  refused.failing(() =>
    Object.assign(new Error("Unlock"), { code: "device locked", outcome: "notExecuted" }),
  );
  expect(await code(refused.down("a"))).toBe("device locked");
  expect(refused.sent).toEqual(["down:a"]);
  expect(refused.ended()).toBe(0);
  const unknown = strokeRig();
  unknown.failing((phase) =>
    phase === "down" ? Object.assign(new Error("lost"), { outcome: "unknown" }) : undefined,
  );
  expect(await code(unknown.down("a"))).toBe("error");
  expect(unknown.sent).toEqual(["down:a", "cancel:a"]);
  expect(await released(unknown)).toBe(true);

  // Silence, a stroke that never ends, a new stroke and a route change all cancel.
  const silent = strokeRig({ idleMs: 30 });
  await silent.down("a");
  await new Promise((resolve) => setTimeout(resolve, 80));
  expect(silent.sent).toEqual(["down:a", "cancel:a"]);
  expect(await released(silent)).toBe(true);
  const endless = strokeRig({ maxMs: 60, idleMs: 40 });
  await endless.down("a");
  for (let i = 0; i < 8 && endless.live.active; i++) {
    await endless.move("a").catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  expect(endless.sent.at(-1)).toBe("cancel:a");
  const replaced = strokeRig();
  await replaced.down("a");
  await replaced.down("b");
  expect(replaced.sent).toEqual(["down:a", "cancel:a", "down:b"]);
  expect(await code(replaced.move("a"))).toBe("stroke ended");
  await replaced.cancel("b");
  expect(replaced.sent.at(-1)).toBe("cancel:b");
  const rerouted = strokeRig();
  await rerouted.down("a");
  rerouted.reroute();
  await tick();
  expect(rerouted.sent).toEqual(["down:a", "cancel:a"]);
  expect(await released(rerouted)).toBe(true);
  await rerouted.live.stop();
});

// ---- the lock screen ----

test("a locked Android phone is usable while its lock screen is showing", () => {
  const base = { device: true, up: true };
  expect(androidLifecycle({ ...base, locked: false, interactive: null })).toBe("ready");
  // Keyguard showing, screen on: usable, and still reported as locked elsewhere.
  expect(androidLifecycle({ ...base, locked: true, interactive: true })).toBe("ready");
  // Screen off, or not known to be on: locked until woken.
  expect(androidLifecycle({ ...base, locked: true, interactive: false })).toBe("locked");
  expect(androidLifecycle({ ...base, locked: true, interactive: null })).toBe("locked");
  expect(androidLifecycle({ ...base, locked: null, interactive: null })).toBe("connecting");
  expect(androidLifecycle({ ...base, up: false, locked: null, interactive: null })).toBe(
    "connecting",
  );
  expect(androidLifecycle({ device: false, up: false, locked: null, interactive: null })).toBe(
    "disconnected",
  );
  expect(Schema.decodeUnknownSync(androidOperations.power.result)({ interactive: true })).toEqual({
    interactive: true,
  });
});

test("the lock screen takes input but is not read, and nothing starts behind it", () => {
  const selector = { using: "text", value: "1" };
  for (const [name, body] of [
    ["type", { text: "1234" }],
    ["key", { key: "Enter" }],
    ["gesture", { points: [[0.5, 0.8, 0]], end: 40 }],
    ["pinch", { x: 0.5, y: 0.5, scale: 2 }],
    ["pointer", { stroke: "s", phase: "down", points: [[0.5, 0.5]] }],
    ["home", {}],
    ["button", { name: "back" }],
    ["shortcut", { name: "notifications" }],
    ["lock", {}],
    ["unlock", {}],
    ["state", {}],
    ["status", {}],
    ["presence", { clientId: "c", ready: true }],
    ["keep-awake", {}],
    ["quality", { level: "low" }],
  ] as const)
    expect([name, admittedWhileLocked(name, body)]).toEqual([name, true]);
  for (const [name, body] of [
    ["launch", { bundleId: "com.android.settings" }],
    ["open-url", { url: "https://example.com/" }],
    ["tap", { selector }],
    ["element-action", { selector, action: "focus" }],
    ["type", { text: "1234", selector }],
    ["type", { text: "1234", id: "a1" }],
    ["elements", { selector }],
    ["element", { selector }],
    ["source", {}],
    ["screenshot", {}],
    ["observe", {}],
    ["wait", { selector }],
    ["clipboard-read", {}],
    ["clipboard-write", { format: "text", content: "eA==" }],
    // A postcondition or an observation guard would read the lock screen.
    ["key", { key: "Enter", waitFor: { selector } }],
    ["type", { text: "1234", observationId: "o1" }],
  ] as const)
    expect([name, admittedWhileLocked(name, body)]).toEqual([name, false]);
  expect(lockedError()).toMatchObject({ status: 409, code: "device locked" });
});

test("nothing typed or drawn on a lock screen can be recovered from a receipt", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "iportal-lock-"));
  const file = path.join(directory, "commands.sqlite");
  try {
    let locked: boolean | null = true;
    let asked = 0;
    const commands = createCommands({ file });
    const ledger = privateLedger(commands, async () => {
      asked++;
      if (locked === undefined) throw new Error("helper unreachable");
      return locked;
    });
    const ok = (id: string) => async () => ({
      status: 200,
      body: { ok: true, requestId: id, outcome: "executed" as const, verified: false },
    });
    const inputs = {
      pin: { name: "type", body: { text: "4821", requestId: "pin" } },
      enter: { name: "key", body: { key: "Enter", modifiers: [], requestId: "enter" } },
      digit: { name: "key", body: { key: "7", requestId: "digit" } },
      pattern: {
        name: "gesture",
        body: {
          points: [
            [0.2, 0.6, 0],
            [0.8, 0.6, 200],
          ],
          end: 200,
          requestId: "pattern",
        },
      },
      zoom: { name: "pinch", body: { x: 0.5, y: 0.5, scale: 2, requestId: "zoom" } },
    };
    for (const [id, input] of Object.entries(inputs)) await ledger.execute(id, input, ok(id));
    // The lock state is not known: treated as locked.
    locked = null;
    await ledger.execute("unknown", { name: "type", body: { text: "9999" } }, ok("unknown"));
    locked = undefined as unknown as null;
    await ledger.execute(
      "unreachable",
      { name: "type", body: { text: "0000" } },
      ok("unreachable"),
    );
    expect(asked).toBe(7);

    const db = new Database(commands.databasePath, { readonly: true });
    const rows = db.query<{ id: string; hash: string }, []>("SELECT id, hash FROM receipts").all();
    db.close();
    expect(rows).toHaveLength(7);
    for (const row of rows) {
      const name = row.id in inputs ? inputs[row.id as keyof typeof inputs].name : "type";
      // The stored hash depends on nothing but the kind of input.
      expect(row.hash).toBe(fingerprint({ name, locked: true }));
    }
    // A four-digit PIN is found from an ordinary hash by trying them all.
    const pinRow = rows.find((row) => row.id === "pin")!;
    const guessed = Array.from({ length: 10000 }, (_, i) => String(i).padStart(4, "0")).some(
      (text) => fingerprint({ name: "type", body: { text, requestId: "pin" } }) === pinRow.hash,
    );
    expect(guessed).toBe(false);
    for (const text of ["4821", "9999", "0000"])
      for (const suffix of ["", "-wal"])
        if (fs.existsSync(commands.databasePath + suffix))
          expect(fs.readFileSync(commands.databasePath + suffix).includes(text)).toBe(false);

    // The receipt still answers for its ID and still never runs it twice.
    expect(ledger.get("pin")).toMatchObject({ state: "executed" });
    let reran = false;
    const again = await ledger.execute("pin", inputs.pin, async () => {
      reran = true;
      return ok("pin")();
    });
    expect(reran).toBe(false);
    expect(again.body.outcome).toBe("executed");

    // Unlocked input and input that carries no secret keep their ordinary fingerprint.
    locked = false;
    const text = { name: "type", body: { text: "hello", requestId: "text" } };
    await ledger.execute("text", text, ok("text"));
    expect(
      await code(ledger.execute("text", { name: "type", body: { text: "other" } }, ok("text"))),
    ).toBe("request conflict");
    locked = true;
    const before = asked;
    await ledger.execute("home", { name: "home", body: {} }, ok("home"));
    expect(asked).toBe(before);
    commands.close();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

// A stand-in for the adb server's local socket protocol.
async function fakeAdb(handle: (service: string, socket: net.Socket) => void) {
  const server = net.createServer((socket) => {
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
      for (;;) {
        if (buffer.length < 4) return;
        const length = parseInt(buffer.subarray(0, 4).toString(), 16);
        if (Number.isNaN(length) || buffer.length < 4 + length) return;
        const service = buffer.subarray(4, 4 + length).toString();
        buffer = buffer.subarray(4 + length);
        handle(service, socket);
      }
    });
    socket.on("error", () => {});
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as net.AddressInfo;
  return { port, close: () => server.close() };
}
const framed = (payload: string) => payload.length.toString(16).padStart(4, "0") + payload;

test("talks to the adb server: list, track and tunnel", async () => {
  const seen: string[] = [];
  const server = await fakeAdb((service, socket) => {
    seen.push(service);
    if (service === "host:devices-l") socket.end("OKAY" + framed(listing));
    else if (service === "host:track-devices-l") socket.write("OKAY" + framed(listing));
    else if (service === "host:transport:25271JEGR16740") socket.write("OKAY");
    else if (service === "localabstract:iportal_test") socket.write("OKAYhello from the device");
    else socket.end("FAIL" + framed("device offline"));
  });
  try {
    const adb = createAdb({ executable: null, port: server.port });
    expect(adb.available).toBe(false);
    expect((await adb.devices()).map((device) => device.id)).toEqual([
      "25271JEGR16740",
      "192.168.2.72:41811",
      "ABC123",
    ]);

    const tracked = await new Promise<number>((resolve) => {
      const stop = adb.track(
        (devices) => {
          stop();
          resolve(devices.length);
        },
        () => {},
      );
    });
    expect(tracked).toBe(3);

    // Bytes after the handshake belong to the tunnel, not to the handshake.
    const tunnel = await adb.connect("25271JEGR16740", "localabstract:iportal_test");
    const received = await new Promise<string>((resolve) => {
      let text = "";
      tunnel.on("data", (chunk) => {
        text += chunk;
        if (text.length >= "hello from the device".length) resolve(text);
      });
      tunnel.resume();
    });
    tunnel.destroy();
    expect(received).toBe("hello from the device");
    const refused = await adb.connect("MISSING", "localabstract:iportal_test").then(
      () => null,
      (error: Error) => error.message,
    );
    expect(refused).toBe("device offline");
    expect(seen).toContain("host:transport:25271JEGR16740");
  } finally {
    server.close();
  }
});

test("the media route proxies the helper's framed stream with its credential, only where a helper has one", async () => {
  // Two records as the Android helper frames them: capabilities, then PCM.
  const record = (kind: number, time: number, body: Uint8Array) => {
    const bytes = new Uint8Array(16 + body.length);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, kind);
    view.setUint32(8, time);
    view.setUint32(12, body.length);
    bytes.set(body, 16);
    return bytes;
  };
  const records = [
    record(
      7,
      0,
      new TextEncoder().encode('{"control":"eligible","video":"supported","audio":"supported"}'),
    ),
    record(9, 480, new Uint8Array(1920).fill(3)),
  ];
  const helperAuth = createHelperAuthentication();
  const seen: { path: string; authorization: string | null }[] = [];
  const queries: string[] = [];
  let authenticated = true;
  const helper = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request) {
      queries.push(new URL(request.url).search);
      seen.push({
        path: new URL(request.url).pathname,
        authorization: request.headers.get("authorization"),
      });
      return new Response(
        new ReadableStream({
          start(controller) {
            for (const bytes of records) controller.enqueue(bytes);
            controller.close();
          },
        }),
        { headers: authenticated ? { "x-iportal-helper-auth": "1" } : {} },
      );
    },
  });
  const start = (media?: string) => {
    const listening = Promise.withResolvers<number>();
    const server = startServer({
      port: 0,
      instanceId: "media-test",
      html: "",
      mjpeg: "http://127.0.0.1:1",
      media,
      helperAuth,
      dispatch: async () => ({ status: 200, body: { ok: true } }),
      onListening: listening.resolve,
    });
    return { server, port: listening.promise };
  };
  const android = start(`http://127.0.0.1:${helper.port}/v1/media`);
  const iphone = start();
  try {
    const base = `http://127.0.0.1:${await android.port}`;
    const response = await fetch(`${base}/media`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/octet-stream");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(
      new Uint8Array(Buffer.concat(records)),
    );
    expect(seen).toEqual([{ path: "/v1/media", authorization: helperAuth.headers.authorization }]);

    // Only the one switch the helper knows is passed on.
    await (await fetch(`${base}/media?audio=0&other=1`)).arrayBuffer();
    expect(queries).toEqual(["", "?audio=0"]);
    seen.length = 1;

    // The same host protections as every other route.
    const foreign = await fetch(`${base}/media`, { headers: { origin: "https://evil.example" } });
    expect(foreign.status).toBe(403);
    expect(seen.length).toBe(1);

    // A stream from something that is not this session's helper is refused.
    authenticated = false;
    const impostor = await fetch(`${base}/media`);
    expect(impostor.status).toBe(503);
    await impostor.body?.cancel();

    // The iPhone composition passes no media source and keeps answering 404.
    const absent = await fetch(`http://127.0.0.1:${await iphone.port}/media`);
    expect(absent.status).toBe(404);
  } finally {
    await helper.stop(true);
    await Effect.runPromise(Fiber.interrupt(android.server));
    await Effect.runPromise(Fiber.interrupt(iphone.server));
  }
});
