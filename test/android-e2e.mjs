import { serverCommand, runtimeEnvironment } from "./server-command.mjs";
import { readJSON } from "./json.mjs";
// End-to-end test of the Android server against fake phones: adb discovery and
// tunnels, helper start, the public API, route changes and the inventory watcher.
// Nothing here reaches the real adb or a real device.
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { createJournal, startFakeAndroid } from "./fake-android.mjs";
import { claimDevice } from "../device-runtime.mjs";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "iportal-android-e2e-"));
const jar = path.join(scratch, "iportal-agent.jar");
fs.writeFileSync(jar, "a stand-in for the helper program");
const remoteJar = `/data/local/tmp/iportal-agent-${createHash("sha256")
  .update(fs.readFileSync(jar))
  .digest("hex")
  .slice(0, 16)}.jar`;

// Device leases are shared by every server of this user. Serials of this run
// only, so two runs at once (or a real phone) cannot refuse each other.
const unique = randomBytes(3).toString("hex").toUpperCase();
/** @param {number} number */
const serial = (number) => `FAKE${unique}N${number}`;

/** @type {Awaited<ReturnType<typeof startFakeAndroid>>[]} */
const fakes = [];
/** @type {{name: string, child: import("node:child_process").ChildProcess, exited: Promise<number | string | null>, output: () => string}[]} */
const children = [];
/** @type {Set<() => void>} */
const cleanups = new Set();

async function fakeAndroid() {
  const fake = await startFakeAndroid({ directory: fs.mkdtempSync(path.join(scratch, "adb-")) });
  fakes.push(fake);
  return fake;
}

/** @param {Awaited<ReturnType<typeof startFakeAndroid>>} fake @param {string} name @param {string[]} args */
function run(fake, name, args) {
  /** @type {NodeJS.ProcessEnv} */
  const env = {
    ...runtimeEnvironment(scratch),
    ...fake.env,
    IPORTAL_ANDROID_AGENT: jar,
    IPORTAL_COMMANDS_FILE: path.join(scratch, `${name}-commands.json`),
  };
  // The server makes its own credential; the test learns it only from the phone.
  delete env.IPORTAL_HELPER_TOKEN;
  const child = spawn(
    serverCommand[0],
    [...serverCommand.slice(1), "--platform", "android", ...args],
    { cwd: scratch, env, stdio: ["ignore", "pipe", "pipe"] },
  );
  /** Complete lines of standard output. */
  const lines = /** @type {ReturnType<typeof createJournal<string>>} */ (createJournal());
  let output = "",
    partial = "";
  child.stdout.on("data", (chunk) => {
    output += chunk;
    partial += chunk;
    const complete = partial.split("\n");
    partial = complete.pop() ?? "";
    for (const line of complete) lines.push(line);
  });
  child.stderr.on("data", (chunk) => {
    output += chunk;
  });
  /** @type {Promise<number | string | null>} */
  const exited = new Promise((resolve) =>
    child.once("exit", (code, signal) => resolve(code ?? signal)),
  );
  children.push({ name, child, exited, output: () => output });
  return { child, lines, exited, output: () => output };
}

/** @param {string} base */
function client(base) {
  /** @returns {Promise<Record<string, any> & {status: number}>} */
  const post = async (name, body = {}) => {
    const response = await fetch(`${base}/api/${name}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return {
      .../** @type {Record<string, any>} */ (await response.json()),
      status: response.status,
    };
  };
  /** @returns {Promise<Record<string, any> & {status: number}>} */
  const get = async (route) => {
    const response = await fetch(base + route);
    return { ...(await readJSON(response)), status: response.status };
  };
  // Every status the server publishes, so the test waits for a state to be
  // reported instead of sleeping. Each snapshot is judged once, as it arrives:
  // a later change on the phone must not make an older snapshot match.
  const controller = new AbortController();
  cleanups.add(() => controller.abort());
  /** @type {Record<string, any> | undefined} */
  let latest;
  /** @type {Set<(snapshot: Record<string, any>) => void>} */
  const listeners = new Set();
  void (async () => {
    const response = await fetch(`${base}/api/events`, { signal: controller.signal });
    assert(response.body);
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true });
      for (let end; (end = buffer.indexOf("\n\n")) >= 0; buffer = buffer.slice(end + 2)) {
        if (!buffer.startsWith("data: ")) continue;
        const snapshot = /** @type {Record<string, any>} */ (JSON.parse(buffer.slice(6, end)));
        latest = snapshot;
        for (const listener of [...listeners]) listener(snapshot);
      }
    }
  })().catch(() => {});
  /**
   * @param {string} label
   * @param {(snapshot: Record<string, any>) => unknown} matches
   * @param {{timeoutMs?: number, fresh?: boolean}} [options] `fresh` ignores the status already published
   * @returns {Promise<Record<string, any>>}
   */
  const until = (label, matches, { timeoutMs = 8000, fresh = false } = {}) =>
    new Promise((resolve, reject) => {
      const listener = (snapshot) => {
        if (!matches(snapshot)) return;
        listeners.delete(listener);
        clearTimeout(timer);
        resolve(snapshot);
      };
      const timer = setTimeout(() => {
        listeners.delete(listener);
        reject(new Error(`Timed out waiting for ${label}; last status ${JSON.stringify(latest)}`));
      }, timeoutMs);
      listeners.add(listener);
      if (!fresh && latest) listener(latest);
    });
  /** The start of the video stream: enough to hold one frame. */
  const video = async (query = "") => {
    const response = await fetch(`${base}/stream${query}`);
    assert(response.body);
    const reader = response.body.getReader();
    let bytes = Buffer.alloc(0);
    while (!bytes.includes(Buffer.from([0xff, 0xd9]))) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes = Buffer.concat([bytes, value]);
    }
    await reader.cancel();
    return { type: response.headers.get("content-type") ?? "", bytes };
  };
  // TODO: a server with a stream still open takes 20 seconds to end after
  // SIGTERM, because the shared HTTP layer (server.mjs) waits for its
  // connections. Until that is fixed there, the test ends its own stream first.
  const close = () => controller.abort();
  return { post, get, until, video, close };
}

/** @param {{args: string[]}} call */
const shellText = (call) => (call.args[2] === "shell" ? call.args.slice(3).join(" ") : "");
/** @param {{args: string[]}} call */
const startsHelper = (call) => shellText(call).includes("app_process");

// ---- one mirror session, from an unauthorized phone to shutdown ----

async function mirrorSession() {
  const SERIAL = serial(1),
    BYSTANDER = serial(2),
    WIFI = "192.168.77.21:37021";
  const fake = await fakeAndroid();
  const phone = fake.addPhone(SERIAL, { wireless: WIFI });
  fake.attach(SERIAL, { state: "unauthorized" });
  const server = run(fake, "session", ["--port", "0", "--no-open"]);
  const listening = await server.lines.next(
    (line) => /running at http:\/\/localhost:\d+/.test(line),
    {
      label: "the server to listen",
      timeoutMs: 10000,
    },
  );
  const base = `http://127.0.0.1:${listening.match(/localhost:(\d+)/)?.[1]}`;
  const { post, get, until, video, close } = client(base);
  const count = (operation) =>
    phone.log.entries.filter((entry) => entry.operation === operation).length;
  /** @returns {Record<string, any>} */
  const last = (operation) => {
    const entry = phone.log.entries.findLast((item) => item.operation === operation);
    assert(entry, `the phone received no ${operation}`);
    return entry;
  };

  // An attached phone that has not allowed this Mac says what to do, and is
  // not touched.
  const unauthorized = await until("the Allow prompt", (s) => s.error?.includes("tap Allow"));
  assert.equal(
    unauthorized.error,
    "Unlock your Android device and tap Allow to permit USB debugging.",
  );
  assert.equal(unauthorized.platform, "android");
  assert.equal(unauthorized.lifecycle, "disconnected");
  assert.equal(unauthorized.device, null);
  assert.equal(unauthorized.pinnedUdid, null);
  assert.deepEqual(
    fake.calls.entries.map((call) => call.args),
    [["start-server"]],
  );

  // Allowing it is enough: the helper is pushed and started with no other step.
  fake.setState(SERIAL, "device");
  const ready = await until("ready", (s) => s.lifecycle === "ready", { timeoutMs: 10000 });
  assert.equal(ready.ok, true);
  assert.equal(ready.locked, false);
  assert.deepEqual(ready.device, {
    id: SERIAL,
    udid: SERIAL,
    connection: "USB",
    transport: "usb",
  });
  assert.equal(ready.pinnedUdid, SERIAL);
  assert.equal(ready.orientation, "PORTRAIT");
  assert.deepEqual(ready.displayPixels, { width: 1080, height: 2400 });
  assert.deepEqual(ready.captureIdentity, { singleUsbDevice: false });
  assert.equal(ready.error, null);
  assert.deepEqual(
    fake.calls.entries.filter((call) => call.args[0] === "-s").map((call) => call.args[2]),
    ["shell", "shell", "push", "shell", "shell", "shell"],
  );
  assert.deepEqual(fake.calls.entries.find((call) => call.args[2] === "push")?.args, [
    "-s",
    SERIAL,
    "push",
    jar,
    remoteJar,
  ]);
  assert.ok(phone.files.has(remoteJar));
  const launches = () => fake.calls.entries.filter(startsHelper);
  const kills = () => fake.shells(/pkill/);
  assert.equal(launches().length, 1);
  assert.equal(kills().length, 1, "a previous server's helper is ended before the start");
  assert.ok(fake.calls.entries.indexOf(kills()[0]) < fake.calls.entries.indexOf(launches()[0]));
  // The credential reaches the phone on standard input and is on no command line.
  assert(phone.helper);
  const token = phone.helper.token;
  assert.match(token, /^[a-f0-9]{64}$/);
  assert.equal(launches()[0].input, `${token}\n`);
  for (const call of fake.calls.entries) {
    assert.ok(!call.args.join(" ").includes(token), "the credential is on a command line");
    if (call !== launches()[0]) assert.equal(call.input, "");
  }
  assert.ok(!fake.services.some((service) => service.includes(token)));
  assert.match(phone.helper.socketName, /^iportal_[0-9a-f]{16}$/);
  assert.ok(fake.services.includes(`host:transport:${SERIAL}`));
  assert.ok(fake.services.includes(`localabstract:${phone.helper.socketName}`));
  assert.equal(count("unauthorized"), 0, "every helper request carries the credential");
  let generation = phone.helper.generation;

  assert.deepEqual(await get("/api/health"), {
    service: "iportal",
    apiVersion: 2,
    instanceId: ready.instanceId,
    ok: true,
    platform: "android",
    status: 200,
  });
  assert.match(
    await (await fetch(base)).text(),
    /<meta name="iportal-platform" content="android">/,
  );
  const diagnostics = JSON.stringify(await get("/api/diagnostics"));
  assert.ok(!diagnostics.includes(token));
  assert.ok(!diagnostics.includes(SERIAL));

  // ---- public API ----

  assert.deepEqual((await post("state")).value, {
    locked: false,
    app: { pid: 4321, bundleId: "com.android.settings", name: "com.android.settings" },
    orientation: "PORTRAIT",
    screen: { width: 1080, height: 2400 },
  });
  // Android's selectors reach the helper as written; none is translated.
  for (const [selector, id] of /** @type {const} */ ([
    [{ using: "text", value: "Continue" }, "node-1"],
    [{ using: "accessibility id", value: "Continue setup" }, "node-1"],
    [{ using: "id", value: "continue_button" }, "node-1"],
    [{ using: "id", value: "com.android.settings:id/search" }, "node-2"],
    [{ using: "name", value: "Search settings" }, "node-2"],
    [{ using: "class name", value: "android.widget.EditText" }, "node-2"],
  ])) {
    assert.deepEqual((await post("elements", { selector })).value, [{ id }], selector.using);
    assert.deepEqual(last("elements").body, selector);
  }
  assert.deepEqual(
    (await post("elements", { selector: { using: "text", value: "Missing" } })).value,
    [],
  );
  const button = { using: "id", value: "continue_button" };
  const element = (await post("element", { selector: button })).value;
  assert.equal(element.type, "android.widget.Button");
  assert.equal(element.label, "Continue");
  assert.equal(element.hittable, true);
  assert.deepEqual(element.rect, { x: 40, y: 2000, width: 1000, height: 140 });
  assert.equal(
    (await post("element", { selector: { using: "text", value: "Missing" } })).code,
    "no such element",
  );

  // The iPhone's vocabulary is refused before anything is sent to the phone.
  const lookups = count("elements");
  for (const using of ["predicate string", "class chain", "xpath"]) {
    for (const [name, body] of /** @type {const} */ ([
      ["elements", { selector: { using, value: "label == 'Continue'" } }],
      ["tap", { selector: { using, value: "label == 'Continue'" } }],
    ])) {
      const refused = await post(name, body);
      assert.equal(refused.status, 400, `${name} with ${using}`);
      assert.equal(refused.code, "invalid argument");
    }
  }
  assert.equal(count("elements"), lookups);
  assert.equal((await post("siri", { text: "What time is it?" })).status, 404);
  assert.equal(count("siri"), 0);

  const tapped = await post("tap", { selector: button });
  assert.equal(tapped.outcome, "executed");
  assert.deepEqual(phone.ui.taps, ["node-1"]);
  assert.deepEqual(last("tapElement").body, { id: "node-1" });

  const tap = { points: [[0.5, 0.5, 0]], end: 80 };
  const gesture = await post("gesture", tap);
  assert.equal(gesture.outcome, "executed");
  assert.equal(gesture.timing.native.playbackMs, 80);
  assert.deepEqual(last("touch").body, tap);
  assert.equal((await post("pinch", { x: 0.5, y: 0.5, scale: 2 })).ok, true);
  assert.equal(last("touch").body.fingers.length, 2);

  assert.equal((await post("type", { text: "héllo 👋" })).ok, true);
  assert.equal(phone.ui.typed, "héllo 👋");
  assert.equal(
    (await post("type", { text: "wifi", selector: { using: "name", value: "Search settings" } }))
      .ok,
    true,
  );
  assert.deepEqual(last("typeElement").body, { id: "node-2", text: "wifi" });

  // A copy is detected from the phone's clipboard counter, not by reading it.
  const reads = count("clipboardRead");
  phone.ui.selection = "copied on the phone";
  const copied = await post("key", { key: "c", modifiers: ["command"] });
  assert.equal(copied.clipboardChanged, true);
  assert.deepEqual(last("key").body, { key: "c", modifiers: ["command"] });
  phone.ui.selection = null;
  assert.equal((await post("key", { key: "c", modifiers: ["command"] })).clipboardChanged, false);
  const statusReads = count("clipboardStatus");
  const plain = await post("key", { key: "ArrowLeft", modifiers: ["shift"] });
  assert.equal(plain.ok, true);
  assert.ok(!("clipboardChanged" in plain));
  assert.equal(count("clipboardStatus"), statusReads);
  assert.equal(count("clipboardRead"), reads);

  const text = (value) => Buffer.from(value).toString("base64");
  assert.deepEqual((await post("clipboard-read")).value, {
    format: "text",
    content: text("copied on the phone"),
  });
  assert.deepEqual(
    (await post("clipboard-write", { format: "text", content: text("from the Mac") })).value,
    { format: "text", bytes: 12 },
  );
  assert.deepEqual(phone.ui.clipboard, { format: "text", content: text("from the Mac") });
  assert.equal(
    (await post("clipboard-write", { format: "text", content: "not base64!" })).status,
    400,
  );

  assert.equal((await post("button", { name: "back" })).outcome, "executed");
  assert.deepEqual(last("button").body, { name: "back" });
  assert.equal((await post("shortcut", { name: "switcher" })).ok, true);
  assert.deepEqual(last("button").body, { name: "appSwitch" });
  assert.equal((await post("button", { name: "mute" })).status, 400);
  assert.equal((await post("launch", { bundleId: "com.android.chrome" })).ok, true);
  assert.equal(phone.ui.app, "com.android.chrome");
  assert.equal((await post("home")).ok, true);

  const source = (await post("source")).value;
  assert.equal(source.type, "android.widget.FrameLayout");
  assert.equal(source.children[0].type, "android.widget.Button");
  assert.equal((await post("screenshot")).value.mimeType, "image/jpeg");
  assert.equal((await post("wait", { selector: button })).value.matched, true);
  assert.equal((await post("keep-awake", { enabled: true, durationMs: 30000 })).value.pulses, 1);
  assert.equal(count("keepAlive"), 1);
  assert.equal((await post("keep-awake", { enabled: false })).value.enabled, false);

  // ---- locked lifecycle, lock guard, app guard ----

  phone.update({ locked: true });
  const locked = await until("locked", (s) => s.lifecycle === "locked");
  assert.equal(locked.ok, true, "a reachable helper on a locked phone is not a failure");
  assert.equal(locked.locked, true);
  const touches = count("touch");
  const guarded = await post("gesture", tap);
  assert.equal(guarded.status, 409);
  assert.equal(guarded.code, "device locked");
  assert.equal(guarded.outcome, "not executed");
  assert.equal(count("touch"), touches + 1, "input is guarded on the phone at dispatch");
  assert.ok(!last("touch").executed);
  const url = { url: "https://example.com/" };
  const lockedURL = await post("open-url", url);
  assert.equal(lockedURL.status, 409);
  assert.equal(lockedURL.code, "device locked");
  assert.equal(lockedURL.error, "Unlock your Android device");
  assert.equal(lockedURL.outcome, "not executed");
  assert.equal(count("openURL"), 0);
  assert.equal((await post("unlock")).ok, true);
  await until("ready after unlock", (s) => s.lifecycle === "ready" && s.locked === false);
  assert.equal((await post("lock")).ok, true);
  await until("locked by request", (s) => s.lifecycle === "locked");
  phone.update({ locked: false });
  await until("ready after the owner unlocks", (s) => s.lifecycle === "ready");

  const foreign = "com.example.elsewhere";
  for (const [name, body, operation] of /** @type {const} */ ([
    ["gesture", tap, "touch"],
    ["tap", { selector: button }, "tapElement"],
    ["key", { key: "a" }, "key"],
  ])) {
    const rejected = await post(name, { ...body, expectedApp: foreign });
    assert.equal(rejected.status, 409, name);
    assert.equal(rejected.code, "app changed");
    assert.equal(rejected.outcome, "not executed");
    assert.equal(last(operation).body.expectedBundleId, foreign);
    assert.equal((await post(name, { ...body, expectedApp: phone.ui.app })).outcome, "executed");
  }
  assert.deepEqual(phone.ui.taps, ["node-1", "node-1"]);
  const foreignURL = await post("open-url", { ...url, expectedApp: foreign });
  assert.equal(foreignURL.status, 409);
  assert.equal(foreignURL.code, "app changed");
  assert.equal(count("openURL"), 0);
  assert.equal((await post("open-url", { ...url, expectedApp: phone.ui.app })).ok, true);
  assert.equal(last("openURL").body.url, url.url);

  // ---- command receipts ----

  const back = { name: "back", requestId: "back-once" };
  const buttons = count("button");
  const first = await post("button", back);
  assert.equal(first.outcome, "executed");
  const replayed = await post("button", back);
  assert.equal(replayed.requestId, "back-once");
  assert.equal(replayed.outcome, "executed");
  assert.equal(count("button"), buttons + 1, "a repeated request ID is answered from its receipt");
  assert.equal((await post("button", { ...back, name: "home" })).code, "request conflict");
  const receipt = await get("/api/commands/back-once");
  assert.equal(receipt.value.state, "executed");
  assert.equal(receipt.value.response.body.outcome, "executed");
  assert.equal((await get("/api/commands/never-sent")).status, 404);
  // The phone received the command and the answer was lost: it may have run.
  const lostBody = { name: "back", requestId: "back-lost" };
  phone.faults.drop = "button";
  const lost = await post("button", lostBody);
  assert.equal(lost.ok, false);
  assert.equal(lost.outcome, "unknown");
  assert.equal(last("button").dropped, true);
  const again = await post("button", lostBody);
  assert.equal(again.outcome, "unknown");
  assert.equal(again.requestId, "back-lost");
  assert.equal(count("button"), buttons + 2, "an unknown outcome is never sent again");
  assert.equal((await get("/api/commands/back-lost")).value.state, "unknown");

  // ---- video ----

  const stream = await video();
  assert.match(stream.type, /multipart\/x-mixed-replace/);
  assert.ok(stream.bytes.includes("--frame\r\nContent-Type: image/jpeg"));
  assert.ok(stream.bytes.includes(Buffer.from([0xff, 0xd8])), "the stream carries a JPEG frame");
  assert.equal((await video("?raw=1")).type, "application/octet-stream");
  assert.equal(
    (await fetch(`${base}/stream`, { headers: { origin: "https://foreign.example" } })).status,
    403,
  );

  // ---- routes ----

  // Another phone does not change which one this session serves.
  const bystander = fake.addPhone(BYSTANDER);
  fake.attach(BYSTANDER);
  // Once the phone is known over USB the server connects its advertised Wi-Fi
  // route itself, as a standby.
  const connect = await fake.calls.next((call) => call.args[0] === "connect", {
    label: "the standby Wi-Fi connection",
    timeoutMs: 10000,
  });
  assert.deepEqual(connect.args, ["connect", WIFI]);
  assert.ok(fake.calls.entries.some((call) => call.args.join(" ") === "mdns services"));
  await fake.calls.next(
    (call) => call.args[1] === WIFI && shellText(call) === "getprop ro.serialno",
    {
      label: "the Wi-Fi transport to be identified",
    },
  );
  const both = await get("/api/status");
  assert.equal(both.device.transport, "usb", "USB stays the route while it is present");
  assert.equal(both.pinnedUdid, SERIAL);

  // Pulling the cable changes the route. The helper and the session continue.
  fake.detach(SERIAL);
  const wifi = await until(
    "the Wi-Fi route",
    (s) => s.lifecycle === "ready" && s.device?.transport === "wifi",
  );
  assert.deepEqual(wifi.device, {
    id: WIFI,
    udid: SERIAL,
    connection: "Network",
    transport: "wifi",
  });
  assert.equal(wifi.pinnedUdid, SERIAL);
  assert.equal(wifi.instanceId, ready.instanceId);
  assert.equal(phone.helper?.generation, generation);
  assert.equal(launches().length, 1, "a route change does not restart the helper");
  assert.ok(fake.services.includes(`host:transport:${WIFI}`));
  assert.equal((await post("button", { name: "back" })).outcome, "executed");
  assert.equal(last("button").generation, generation);
  assert.equal((await get("/api/commands/back-once")).value.state, "executed");
  assert.equal((await post("button", back)).outcome, "executed");
  assert.equal(last("button").body.requestId, undefined);
  assert.ok((await video()).bytes.includes(Buffer.from([0xff, 0xd8])), "video follows the route");
  fake.attach(SERIAL);
  const usb = await until(
    "the USB route",
    (s) => s.lifecycle === "ready" && s.device?.transport === "usb",
  );
  assert.equal(usb.device.id, SERIAL);
  assert.equal(phone.helper?.generation, generation);
  assert.equal(launches().length, 1);

  // ---- helper recovery ----

  // One failed probe is not a dead helper: the server sees its helper still
  // running and leaves it alone.
  let mark = fake.calls.entries.length;
  phone.faults.failStatus = 1;
  void get("/api/status").catch(() => {});
  await until("a failed probe", (s) => s.lifecycle === "connecting", { fresh: true });
  await fake.calls.next((call) => shellText(call).includes("pgrep"), {
    from: mark,
    label: "the check that the helper is still running",
  });
  await until("ready after a failed probe", (s) => s.lifecycle === "ready", { fresh: true });
  assert.equal((await post("state")).ok, true);
  assert.equal(fake.calls.entries.slice(mark).filter(startsHelper).length, 0);
  assert.equal(
    fake.shells(/pkill/, mark).length,
    0,
    "a healthy helper was ended after one failed probe",
  );
  assert.equal(phone.helper?.generation, generation);

  // A helper that is gone is started again, with the same credential.
  mark = fake.calls.entries.length;
  phone.kill();
  await until(
    "ready on a new helper",
    (s) => s.lifecycle === "ready" && phone.helper && phone.helper.generation !== generation,
    { fresh: true, timeoutMs: 15000 },
  );
  assert(phone.helper);
  assert.equal(fake.calls.entries.slice(mark).filter(startsHelper).length, 1);
  assert.equal(launches().at(-1)?.input, `${token}\n`);
  assert.equal(fake.calls.entries.filter((call) => call.args[2] === "push").length, 1);
  generation = phone.helper.generation;
  assert.equal((await post("button", { name: "back" })).outcome, "executed");
  assert.equal(last("button").generation, generation);

  // ---- removal ----

  // The pinned phone going away ends in `disconnected`. The other phone is
  // attached and usable, and is not taken instead.
  phone.wireless = null;
  fake.detach(SERIAL, WIFI);
  // The route change is published at once; the reason follows with the next read.
  const removed = await until("disconnected", (s) => s.lifecycle === "disconnected" && s.error);
  assert.equal(removed.ok, false);
  assert.equal(removed.device, null);
  assert.equal(removed.pinnedUdid, SERIAL);
  assert.equal(removed.error, "Connect your Android device and turn on USB debugging.");
  const stranded = await post("home");
  assert.equal(stranded.ok, false);
  assert.equal(stranded.outcome, "not executed");
  assert.equal((await get("/api/status")).device, null);
  fake.attach(SERIAL, { state: "unauthorized" });
  await until("the Allow prompt on return", (s) => s.error?.includes("tap Allow"));
  fake.setState(SERIAL, "device");
  const returned = await until("ready on return", (s) => s.lifecycle === "ready");
  assert.equal(returned.device.udid, SERIAL);
  assert.equal(phone.helper.generation, generation, "the helper outlives its connection");
  assert.equal(launches().length, 2);
  assert.equal(bystander.log.entries.length, 0);
  assert.equal(bystander.processes.length, 0);
  assert.ok(!fake.calls.entries.some((call) => call.args[1] === BYSTANDER));

  // ---- one session per phone ----

  const second = run(fake, "second", ["--port", "0", "--no-open", "--udid", SERIAL]);
  assert.notEqual(await second.exited, 0);
  assert.match(second.output(), /This device already has a mirror session/);
  assert.equal((await get("/api/status")).lifecycle, "ready");
  assert.equal(launches().length, 2);

  // ---- shutdown ----

  close();
  server.child.kill("SIGTERM");
  assert.equal(await server.exited, 0);
  await phone.log.next((entry) => entry.operation === "shutdown", { label: "helper shutdown" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(phone.processes.length, 0, "closing the mirror ends its helper");
  assert.equal(kills().length, 2, "the helper was ended only to start one");
  assert.deepEqual(
    fake.calls.entries.filter((call) => call.unsupported).map((call) => call.args),
    [],
  );
  // The device lease ends with the server.
  const lease = `android-${createHash("sha256").update(SERIAL).digest("hex").slice(0, 32)}`;
  (await claimDevice(lease))();
}

// ---- a helper that never answers ----

async function unreachableHelper() {
  const SERIAL = serial(3);
  const fake = await fakeAndroid();
  const phone = fake.addPhone(SERIAL);
  phone.files.add(remoteJar);
  // The first helper runs but never listens.
  phone.faults.wedge = 1;
  fake.attach(SERIAL);
  const server = run(fake, "unreachable", [
    "--port",
    "0",
    "--no-open",
    "--managed",
    "--owner",
    "android-e2e",
    "--udid",
    SERIAL,
  ]);
  const listening = JSON.parse(
    await server.lines.next((line) => line.startsWith('{"event":"iportal-listening"'), {
      label: "the managed server to listen",
      timeoutMs: 10000,
    }),
  );
  assert.equal(listening.udid, SERIAL);
  assert.equal(listening.platform, "android");
  const { get, until, close } = client(`http://127.0.0.1:${listening.port}`);
  const health = await get("/api/health");
  assert.equal(health.owner, "android-e2e");
  assert.equal(health.pinnedUdid, SERIAL);

  const firstCheck = await fake.calls.next((call) => call.args[0] === "-s", {
    label: "the first helper check",
  });
  const firstStart = await fake.calls.next(startsHelper, { label: "the first helper start" });
  assert.ok(
    !fake.calls.entries.some((call) => call.args[2] === "push"),
    "a helper file already on the phone is not pushed again",
  );
  const connecting = await until("connecting", (s) => s.lifecycle === "connecting");
  assert.equal(connecting.device.udid, SERIAL);
  assert.equal(connecting.ok, false);
  // Its replacement takes longer to listen than the server waits between checks.
  phone.faults.startDelayMs = 3500;

  // The running helper is replaced only once it has stayed unreachable.
  const secondStart = await fake.calls.next(startsHelper, {
    from: fake.calls.entries.indexOf(firstStart) + 1,
    label: "the replacement of an unreachable helper",
    timeoutMs: 30000,
  });
  assert.ok(
    secondStart.at - firstCheck.at >= 19000,
    `replaced after only ${secondStart.at - firstCheck.at} ms`,
  );
  const between = fake.calls.entries.slice(
    fake.calls.entries.indexOf(firstStart) + 1,
    fake.calls.entries.indexOf(secondStart),
  );
  assert.ok(between.filter((call) => shellText(call).includes("pgrep")).length >= 2);
  assert.equal(between.filter((call) => shellText(call).includes("pkill")).length, 1);

  // A helper that was just started gets time to come up before it is judged.
  const ready = await until("ready on the replacement", (s) => s.lifecycle === "ready", {
    timeoutMs: 15000,
  });
  assert.equal(ready.device.udid, SERIAL);
  assert.equal(
    fake.calls.entries.filter(startsHelper).length,
    2,
    "a starting helper was ended before it could listen",
  );
  assert.deepEqual(
    fake.calls.entries.filter((call) => call.unsupported).map((call) => call.args),
    [],
  );
  close();
  server.child.kill("SIGTERM");
  assert.equal(await server.exited, 0);
}

// ---- the inventory the Mac app reads ----

async function inventoryWatch() {
  const FIRST = serial(4),
    SECOND = serial(5),
    WIFI = "192.168.77.40:5555";
  const fake = await fakeAndroid();
  fake.addPhone(FIRST);
  fake.addPhone(SECOND, { model: "Pixel 9" });
  fake.attach(FIRST);
  fake.attach(FIRST, { id: WIFI, usb: false });

  const listed = run(fake, "list", ["devices"]);
  assert.equal(await listed.exited, 0);
  assert.deepEqual(listed.lines.entries, [`${FIRST}  device  USB`, `${WIFI}  device  Network`]);

  const watch = run(fake, "watch", ["devices", "--watch"]);
  let read = 0;
  const inventory = async (label) =>
    JSON.parse(await watch.lines.next(() => true, { from: read++, label, timeoutMs: 10000 }));
  const row = (serial, name, transport) => ({ serial, name, transport, usb: transport === "usb" });
  const lines = (devices) => ({ version: 1, adb: true, devices });

  // One phone on two transports is one row.
  assert.deepEqual(await inventory("the first inventory"), lines([row(FIRST, "Pixel 6a", "usb")]));
  fake.detach(FIRST);
  assert.deepEqual(await inventory("the cable pull"), lines([row(FIRST, "Pixel 6a", "wifi")]));
  // A phone that cannot be used yet is not a row, and prints nothing.
  fake.attach(SECOND, { state: "unauthorized" });
  fake.setState(SECOND, "device");
  assert.deepEqual(
    await inventory("the second phone"),
    lines([row(FIRST, "Pixel 6a", "wifi"), row(SECOND, "Pixel 9", "usb")]),
  );
  // Losing the adb server empties the list until the watcher has it back.
  const restarts = () =>
    fake.calls.entries.filter((call) => call.args[0] === "start-server").length;
  const before = restarts();
  fake.dropTracking();
  assert.deepEqual(await inventory("the lost adb server"), lines([]));
  assert.deepEqual(
    await inventory("the adb server's return"),
    lines([row(FIRST, "Pixel 6a", "wifi"), row(SECOND, "Pixel 9", "usb")]),
  );
  assert.ok(restarts() > before);
  fake.detach(WIFI, SECOND);
  assert.deepEqual(await inventory("every phone leaving"), lines([]));
  assert.equal(watch.lines.entries.length, read, "one line for each change, and no other");
  assert.deepEqual(
    fake.calls.entries.filter((call) => call.unsupported).map((call) => call.args),
    [],
  );
  watch.child.kill("SIGTERM");
  await watch.exited;
}

const started = performance.now();
let failure;
try {
  await Promise.all([mirrorSession(), unreachableHelper(), inventoryWatch()]);
} catch (error) {
  failure = error;
}
for (const cleanup of cleanups) cleanup();
for (const { child } of children) if (child.exitCode === null) child.kill("SIGTERM");
await Promise.all(children.map(({ exited }) => exited));
for (const fake of fakes) fake.close();
fs.rmSync(scratch, { recursive: true, force: true });
if (failure) {
  for (const { name, output } of children) console.error(`--- ${name} ---\n${output()}`);
  console.error(failure);
  // Waits that can no longer be met would otherwise hold the process open.
  process.exit(1);
}
console.log(
  `✓ Android end-to-end passed in ${((performance.now() - started) / 1000).toFixed(1)} s`,
);
