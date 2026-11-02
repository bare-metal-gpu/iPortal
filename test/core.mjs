import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import crypto from "node:crypto";
import { Effect } from "effect";
import { createScheduler, commandContext } from "../scheduler.mjs";
import { createCommands } from "../commands.mjs";
import { decodeRequest } from "../schemas.mjs";
import { checkRequest } from "../server.mjs";

const sleep = ms => new Promise(r => setTimeout(r, ms));

test("browser bootstrap supplies instance binding and request ID without prompts", async () => {
  const html = fs.readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const calls = [], nodes = new Map();
  function element(key) {
    if (!nodes.has(key)) nodes.set(key, { content: "instance", classList: { add() {}, remove() {}, toggle() {} }, addEventListener() {},
      removeAttribute() {}, querySelector: () => element("child"), style: {}, dataset: {}, value: "" });
    return nodes.get(key);
  }
  vm.runInNewContext(script, {
    console, AbortSignal, URLSearchParams, location: { search: "", reload() {} }, crypto, queueMicrotask, performance,
    document: { body: element("body"), getElementById: element, querySelector: element, querySelectorAll: () => [], activeElement: null },
    window: { addEventListener() {} }, setTimeout: () => 1, clearTimeout() {},
    fetch: async (url, options) => {
      calls.push([url, options]);
      return { json: async () => url === "/api/status" ? { service: "iphone-mirror", apiVersion: 2, instanceId: "instance", ok: false } : { ok: true } };
    },
  });
  await new Promise(resolve => setImmediate(resolve));
  const ensure = calls.find(([url]) => url === "/api/ensure");
  assert.ok(ensure);
  assert.equal(ensure[1].headers["x-mirror-instance"], "instance");
  assert.ok(JSON.parse(ensure[1].body).requestId);
});

test("native loading tracks queued input, reconnects and the first fallback frame", async () => {
  const html = fs.readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  const messages = [], releases = [], nodes = new Map();
  let offline = false;
  let remoteLifecycle = "ready";
  let dispatchedHomes = 0;
  function element(key) {
    if (!nodes.has(key)) nodes.set(key, { content: "instance", listeners: {},
      classList: { add() {}, remove() {}, toggle() {} },
      addEventListener(name, fn) { this.listeners[name] = fn; }, removeAttribute() {},
      querySelector: () => element("child"), style: {}, dataset: {}, value: "" });
    return nodes.get(key);
  }
  const context = vm.createContext({ console, AbortSignal, URLSearchParams, location: { search: "?app=1&video=native", reload() {} },
    crypto, queueMicrotask, performance, setTimeout: () => 1, clearTimeout() {},
    document: { body: element("body"), getElementById: element, querySelector: element, querySelectorAll: () => [], activeElement: null },
    window: { addEventListener() {}, webkit: { messageHandlers: { native: { postMessage: message => messages.push(message) } } } },
    fetch: async url => {
      if (url === "/api/status" && offline) throw new Error("offline");
      if (url === "/api/home") { dispatchedHomes++; await new Promise(resolve => releases.push(resolve)); }
      return { json: async () => url === "/api/status" ? { service: "iphone-mirror", apiVersion: 2, instanceId: "instance", ok: true, lifecycle: remoteLifecycle } : { ok: true } };
    },
  });
  vm.runInContext(html.match(/<script>([\s\S]*?)<\/script>/)[1], context);
  const settle = () => new Promise(resolve => setImmediate(resolve));
  const loading = () => messages.filter(m => "loading" in m).at(-1).loading;
  await settle(); assert.equal(loading(), true);
  vm.runInContext("setNativeVideoReady(true)", context); assert.equal(loading(), false);
  const first = vm.runInContext("api('home')", context);
  const second = vm.runInContext("api('home')", context);
  await settle(); assert.equal(loading(), true);
  assert.equal(messages.at(-1).waitingForVideo, false, "queued input must keep live video visible");
  releases.shift()(); await first; await settle(); assert.equal(loading(), true);
  releases.shift()(); await second; assert.equal(loading(), false);
  offline = true; await vm.runInContext("poll()", context); assert.equal(loading(), true);
  assert.equal(element("overlay").hidden, false);
  assert.equal(messages.at(-1).waitingForVideo, true, "lost connection reveals the native blur");
  offline = false; await vm.runInContext("poll()", context); assert.equal(loading(), true);
  vm.runInContext("setNativeVideoReady(true)", context); assert.equal(loading(), false);
  vm.runInContext("startStream()", context); assert.equal(loading(), true);
  element("screen").listeners.load(); assert.equal(loading(), false);
  element("screen").listeners.error(); assert.equal(loading(), true);
  await vm.runInContext("poll()", context);
  vm.runInContext("useNativeVideo(); setNativeVideoReady(true)", context);
  const running = vm.runInContext("api('home')", context);
  const queued = vm.runInContext("api('home')", context);
  await settle();
  remoteLifecycle = "locked";
  await vm.runInContext("poll()", context);
  assert.equal(messages.at(-1).lifecycle, "locked");
  assert.equal(vm.runInContext("canInteract()", context), false);
  await vm.runInContext("api('home')", context);
  releases.shift()(); await running; await queued;
  assert.equal(dispatchedHomes, 3, "lock drops queued and newly attempted input");
  remoteLifecycle = "ready";
  await vm.runInContext("poll()", context);
  assert.equal(vm.runInContext("canInteract()", context), false, "unlock waits for a fresh native frame");
  vm.runInContext("setNativeVideoReady(true)", context);
  assert.equal(vm.runInContext("canInteract()", context), true);
  vm.runInContext("typed = 'stale'; setNativeVideoReady(false)", context);
  assert.equal(vm.runInContext("typed", context), "", "stalled video clears buffered typing");
  remoteLifecycle = "disconnected";
  await vm.runInContext("poll()", context);
  assert.equal(messages.at(-1).lifecycle, "disconnected");
  remoteLifecycle = "ready";
  await vm.runInContext("poll()", context);
  assert.equal(vm.runInContext("canInteract()", context), false);
  vm.runInContext("setNativeVideoReady(true)", context);
  assert.equal(vm.runInContext("canInteract()", context), true);

});

test("Effect schemas reject malformed actions before device dispatch", async () => {
  for (const [name, body] of [
    ["type", {}], ["type", { text: 123 }], ["quality", { level: "constructor" }], ["shortcut", { name: "invalid" }],
    ["gesture", { points: [[]], end: 0 }], ["gesture", { points: [[2, 0, 0]], end: 50 }],
    ["gesture", { points: [[0, 0, 5]], end: 50 }], ["gesture", { points: [[0, 0, 0], [0, 1, 100], [0, 1, 50]], end: 100 }],
    ["gesture", { points: [[0, 0, 0], [0, 1, 100]], end: 50 }], ["gesture", { points: [[0, 0, 0]], end: 10001 }],
    ["home", { typo: true }], ["tap", {}], ["tap", { id: "a", selector: { using: "id", value: "a" } }],
  ]) await assert.rejects(Effect.runPromise(decodeRequest(name, body)), undefined, name);
  assert.deepEqual(await Effect.runPromise(decodeRequest("gesture", { points: [[0, 0, 0], [1, 1, 100]], end: 100 })), { points: [[0, 0, 0], [1, 1, 100]], end: 100 });
  assert.equal((await Effect.runPromise(decodeRequest("gesture", { points: [[0, 0, 0], [1, 1, 42.5]], end: 43.75 }))).end, 43.75);
});

test("continuous wheel input dispatches promptly, coalesces under load and preserves holds", async () => {
  const html = fs.readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  const calls = [], nodes = new Map(), timers = new Map(), releases = [];
  let now = 0, serial = 0;
  function element(key) {
    if (!nodes.has(key)) nodes.set(key, { content: "instance", listeners: {}, classList: { add() {}, remove() {}, toggle() {} },
      addEventListener(name, fn) { this.listeners[name] = fn; }, removeAttribute() {}, querySelector: () => element("child"),
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 400, height: 800 }), setPointerCapture() {},
      append() {}, remove() {}, style: {}, dataset: {}, value: "" });
    return nodes.get(key);
  }
  const context = vm.createContext({ console, AbortSignal, URLSearchParams, location: { search: "", reload() {} }, crypto, queueMicrotask,
    performance: { now: () => now }, document: { body: element("body"), getElementById: element, querySelector: element,
      createElement: () => element("ripple"), querySelectorAll: () => [], activeElement: null }, window: { addEventListener() {} },
    setTimeout: (fn, ms) => { const id = ++serial; timers.set(id, { fn, at: now + ms }); return id; },
    clearTimeout: id => timers.delete(id),
    fetch: async (url, options) => {
      calls.push([url, options]);
      if (url === "/api/gesture") await new Promise(resolve => releases.push(resolve));
      return { json: async () => url === "/api/status" ? { service: "iphone-mirror", apiVersion: 2, instanceId: "instance", ok: true, lifecycle: "ready" } : { ok: true } };
    },
  });
  vm.runInContext(html.match(/<script>([\s\S]*?)<\/script>/)[1], context);
  const settle = () => new Promise(resolve => setImmediate(resolve));
  async function advance(ms) {
    now += ms;
    for (const [id, timer] of [...timers]) if (timer.at <= now && timers.delete(id)) timer.fn();
    await settle();
  }
  await settle();
  const screen = vm.runInContext("screen", context);
  screen.listeners.load();
  const wheel = () => screen.listeners.wheel({ clientX: 200, clientY: 400, deltaX: 0, deltaY: 40, preventDefault() {} });
  const gestures = () => calls.filter(([url]) => url === "/api/gesture").map(([, opts]) => JSON.parse(opts.body));
  wheel(); await advance(8); wheel(); await advance(8);
  assert.equal(gestures().length, 1, "continuous movement must not postpone first dispatch");
  assert.equal(gestures()[0].end, 120);
  for (let i = 0; i < 20; i++) { wheel(); await advance(10); }
  assert.equal(gestures().length, 1, "one in-flight scroll with coalesced pending movement");
  releases.shift()(); await settle();
  assert.equal(gestures().length, 2);
  releases.shift()(); await settle();
  const event = { button: 0, pointerId: 1, clientX: 200, clientY: 400, preventDefault() {} };
  screen.listeners.pointerdown(event); await advance(120); screen.listeners.pointerup(event); await settle();
  assert.equal(gestures().at(-1).end, 40, "ordinary click does not replay mouse hold time");
  releases.shift()(); await settle();
  screen.listeners.pointerdown(event); await advance(600); screen.listeners.pointerup(event); await settle();
  assert.equal(gestures().at(-1).end, 600, "long press duration is preserved");
  releases.shift()(); await settle();
});

test("automatic browser binding blocks foreign origins and rebinding without CLI credentials", () => {
  const request = headers => ({ method: "POST", headers: { host: "localhost:7100", "content-type": "application/json", ...headers } });
  checkRequest(request({}), 7100, "instance");
  checkRequest(request({ origin: "http://localhost:7100", "x-mirror-instance": "instance" }), 7100, "instance");
  for (const headers of [{ origin: "https://evil.example" }, { host: "evil.example:7100" }, { "content-type": "text/plain" },
    { origin: "null" }, { origin: "http://localhost:7101" }, { "sec-fetch-site": "cross-site" },
    { origin: "http://localhost:7100", "x-mirror-instance": "old-instance" }]) assert.throws(() => checkRequest(request(headers), 7100, "instance"));
});

test("queue removes cancelled work and prioritizes keepalive while preserving FIFO input order", async () => {
  const scheduler = createScheduler();
  const events = [];
  let release;
  const busy = scheduler.enqueue(() => new Promise(r => { release = r; }));
  await sleep(1);
  const cancelled = new AbortController();
  const skip = scheduler.enqueue(() => events.push("cancelled"), { signal: cancelled.signal }).catch(e => e.name);
  const first = scheduler.enqueue(() => events.push("first"));
  const next = scheduler.enqueue(() => events.push("next"), { deadline: performance.now() + 1000 });
  const pulse = scheduler.enqueue(() => events.push("keepalive"), { priority: 10 });
  cancelled.abort(); release();
  await Promise.all([busy, skip, first, next, pulse]);
  assert.deepEqual(events, ["keepalive", "first", "next"]);
});

test("queue deadlines expire before dispatch, and capacity bounds backlog", async () => {
  const scheduler = createScheduler({ maxQueued: 1 });
  let release, executed = false;
  const busy = scheduler.enqueue(() => new Promise(r => { release = r; }));
  await sleep(1);
  const queued = scheduler.enqueue(() => { executed = true; }, { deadline: performance.now() + 20 });
  await assert.rejects(scheduler.enqueue(() => {}), { code: "queue full" });
  await Promise.all([assert.rejects(queued, { code: "timeout" }), sleep(30)]);
  release(); await busy;
  assert.equal(executed, false);
});

test("maintenance gets its own deadline after the originating input is cancelled", async () => {
  const scheduler = createScheduler();
  const controller = new AbortController();
  controller.abort();
  let dispatched = false;
  await commandContext.run({ signal: controller.signal, deadline: performance.now() - 100, insideQueue: true, onDispatch() { throw Error("inherited input receipt"); } }, () =>
    scheduler.maintenance(() => {
      const context = commandContext.getStore();
      context.signal.throwIfAborted();
      assert.ok(context.deadline > performance.now());
      assert.equal(context.onDispatch, undefined);
      dispatched = true;
    }));
  assert.equal(dispatched, true);
});

test("receipts deduplicate concurrent/retried commands, survive restart and reject conflicting IDs", async () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "mirror-receipts-"));
  try {
    const file = path.join(scratch, "commands.json");
    const ledger = createCommands({ file });
    let calls = 0;
    const input = { name: "type", body: { text: "private input" } };
    const run = async mark => { calls++; mark("running"); await sleep(10); return { status: 200, body: { ok: true, outcome: "executed" } }; };
    await Promise.all([ledger.execute("one", input, run), ledger.execute("one", input, run)]);
    assert.equal(calls, 1);
    const restored = createCommands({ file });
    assert.equal((await restored.execute("one", input, run)).body.ok, true);
    assert.equal(calls, 1);
    await assert.rejects(restored.execute("one", { different: true }, run), { code: "request conflict" });
    assert.equal(fs.readFileSync(file, "utf8").includes("private input"), false);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    data[0].state = "running"; delete data[0].response;
    fs.writeFileSync(file, JSON.stringify(data));
    const afterCrash = createCommands({ file });
    assert.equal((await afterCrash.execute("one", input, run)).body.code, "outcome unknown");
    assert.equal(calls, 1);
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
});
