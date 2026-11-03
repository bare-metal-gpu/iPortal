import { loadMirrorHTML } from "../web-assets.mjs";
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
import { pinchActions } from "../pinch.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function trackedClasses() {
  const values = new Set();
  return {
    add: (...names) => names.forEach((name) => values.add(name)),
    remove: (...names) => names.forEach((name) => values.delete(name)),
    contains: (name) => values.has(name),
    toggle(name, force) {
      const on = force ?? !values.has(name);
      if (on) values.add(name);
      else values.delete(name);
      return on;
    },
  };
}

void test("browser bootstrap supplies instance binding and request ID without prompts", async () => {
  const html = loadMirrorHTML();
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? "";
  const calls = [],
    nodes = new Map();
  function element(key) {
    if (!nodes.has(key))
      nodes.set(key, {
        content: "instance",
        classList: trackedClasses(),
        addEventListener() {},
        removeAttribute() {},
        querySelector: () => element("child"),
        getContext: () => ({ drawImage() {}, clearRect() {} }),
        width: 400,
        height: 800,
        style: {},
        dataset: {},
        value: "",
      });
    return nodes.get(key);
  }
  vm.runInNewContext(script, {
    console,
    AbortSignal,
    AbortController,
    TextDecoder,
    Blob,
    URLSearchParams,
    location: { search: "", reload() {} },
    crypto,
    queueMicrotask,
    performance,
    document: {
      body: element("body"),
      getElementById: element,
      querySelector: element,
      querySelectorAll: () => [],
      activeElement: null,
    },
    window: { addEventListener() {} },
    setTimeout: () => 1,
    clearTimeout() {},
    fetch: async (url, options) => {
      if (url.startsWith("/stream")) return new Promise(() => {});
      calls.push([url, options]);
      return {
        json: async () =>
          url === "/api/status"
            ? { service: "iphone-mirror", apiVersion: 2, instanceId: "instance", ok: false }
            : { ok: true },
      };
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  const ensure = calls.find(([url]) => url === "/api/ensure");
  assert.ok(ensure);
  assert.equal(ensure[1].headers["x-mirror-instance"], "instance");
  assert.ok(JSON.parse(ensure[1].body).requestId);
});

void test("native loading tracks queued input, reconnects and the first fallback frame", async () => {
  const html = loadMirrorHTML();
  const messages = [],
    releases = [],
    nodes = new Map();
  let offline = false;
  let remoteLifecycle = "ready";
  let dispatchedHomes = 0;
  function element(key) {
    if (!nodes.has(key))
      nodes.set(key, {
        content: "instance",
        listeners: {},
        classList: trackedClasses(),
        addEventListener(name, fn) {
          this.listeners[name] = fn;
        },
        removeAttribute() {},
        querySelector: () => element("child"),
        getContext: () => ({ drawImage() {}, clearRect() {} }),
        width: 400,
        height: 800,
        style: {},
        dataset: {},
        value: "",
      });
    return nodes.get(key);
  }
  const context = vm.createContext({
    console,
    AbortSignal,
    AbortController,
    TextDecoder,
    Blob,
    URLSearchParams,
    location: { search: "?app=1&video=native", reload() {} },
    crypto,
    queueMicrotask,
    performance,
    setTimeout: () => 1,
    clearTimeout() {},
    document: {
      body: element("body"),
      getElementById: element,
      querySelector: element,
      querySelectorAll: () => [],
      activeElement: null,
    },
    window: {
      addEventListener() {},
      webkit: { messageHandlers: { native: { postMessage: (message) => messages.push(message) } } },
    },
    fetch: async (url) => {
      if (url.startsWith("/stream")) return new Promise(() => {});
      if (url === "/api/status" && offline) throw new Error("offline");
      if (url === "/api/home") {
        dispatchedHomes++;
        await new Promise((resolve) => releases.push(resolve));
      }
      return {
        json: async () =>
          url === "/api/status"
            ? {
                service: "iphone-mirror",
                apiVersion: 2,
                instanceId: "instance",
                ok: true,
                lifecycle: remoteLifecycle,
              }
            : { ok: true },
      };
    },
  });
  vm.runInContext(html.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? "", context);
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  const loading = () => messages.filter((m) => "loading" in m).at(-1).loading;
  await settle();
  assert.equal(loading(), true);
  vm.runInContext("setNativeVideoReady(true, videoEpoch, bridgeId)", context);
  assert.equal(loading(), false);
  assert.equal(
    element("body").classList.contains("unavailable"),
    false,
    "ready native input must not retain pointer-events:none",
  );
  const first = vm.runInContext("api('home')", context);
  const second = vm.runInContext("api('home')", context);
  await settle();
  assert.equal(loading(), true);
  assert.equal(messages.at(-1).waitingForVideo, false, "queued input must keep live video visible");
  releases.shift()();
  await first;
  await settle();
  assert.equal(loading(), true);
  releases.shift()();
  await second;
  assert.equal(loading(), false);
  const previousEpoch = vm.runInContext("videoEpoch", context);
  const previousRevision = vm.runInContext("statusRevision", context);
  vm.runInContext("reportLoading(); setNativeVideoReady(true, videoEpoch, bridgeId)", context);
  assert.equal(
    vm.runInContext("statusRevision", context),
    previousRevision,
    "loading/readiness callbacks cannot fake a fresh status observation",
  );
  offline = true;
  await vm.runInContext("poll()", context);
  assert.equal(loading(), true);
  assert.equal(element("overlay").hidden, false);
  assert.equal(messages.at(-1).waitingForVideo, true, "lost connection reveals the native blur");
  assert.equal(
    messages.at(-1).lifecycle,
    "connecting",
    "failures must notify the native lifecycle immediately",
  );
  assert.equal(
    messages.at(-1).statusRevision,
    previousRevision + 1,
    "failed poll is a completed fresh observation",
  );
  assert.ok("deviceUdid" in messages.at(-1));
  offline = false;
  await vm.runInContext("poll()", context);
  assert.equal(loading(), true);
  assert.equal(
    messages.at(-1).statusRevision,
    previousRevision + 2,
    "successful poll advances observation revision",
  );
  vm.runInContext(`setNativeVideoReady(true, ${previousEpoch}, bridgeId)`, context);
  assert.equal(loading(), true, "stale native readiness cannot unfreeze a new epoch");
  vm.runInContext("setNativeVideoReady(true, videoEpoch, 'obsolete-document')", context);
  assert.equal(loading(), true, "stale document readiness cannot unfreeze a new page");
  vm.runInContext("startStream(videoEpoch, 'obsolete-document')", context);
  assert.equal(
    vm.runInContext("nativeVideo", context),
    true,
    "obsolete native fallback cannot switch a new page",
  );
  vm.runInContext("setNativeVideoReady(true, videoEpoch, bridgeId)", context);
  assert.equal(loading(), false);
  assert.equal(
    element("body").classList.contains("unavailable"),
    false,
    "ready native input must not retain pointer-events:none",
  );
  vm.runInContext("startStream()", context);
  assert.equal(loading(), true);
  vm.runInContext("presentStreamFrame({width:400,height:800}, streamGeneration)", context);
  assert.equal(loading(), false);
  vm.runInContext("stopStream(); reportLoading()", context);
  assert.equal(loading(), true);
  await vm.runInContext("poll()", context);
  vm.runInContext("useNativeVideo(); setNativeVideoReady(true, videoEpoch, bridgeId)", context);
  const running = vm.runInContext("api('home')", context);
  const queued = vm.runInContext("api('home')", context);
  await settle();
  remoteLifecycle = "locked";
  await vm.runInContext("poll()", context);
  assert.equal(messages.at(-1).lifecycle, "locked");
  assert.equal(vm.runInContext("canInteract()", context), false);
  await vm.runInContext("api('home')", context);
  releases.shift()();
  await running;
  await queued;
  assert.equal(dispatchedHomes, 3, "lock drops queued and newly attempted input");
  remoteLifecycle = "ready";
  await vm.runInContext("poll()", context);
  assert.equal(
    vm.runInContext("canInteract()", context),
    false,
    "unlock waits for a fresh native frame",
  );
  vm.runInContext("setNativeVideoReady(true, videoEpoch, bridgeId)", context);
  assert.equal(vm.runInContext("canInteract()", context), true);
  assert.equal(element("body").classList.contains("unavailable"), false);
  vm.runInContext("typed = 'stale'; setNativeVideoReady(false, videoEpoch, bridgeId)", context);
  assert.equal(vm.runInContext("typed", context), "", "stalled video clears buffered typing");
  remoteLifecycle = "disconnected";
  await vm.runInContext("poll()", context);
  assert.equal(messages.at(-1).lifecycle, "disconnected");
  remoteLifecycle = "ready";
  await vm.runInContext("poll()", context);
  assert.equal(vm.runInContext("canInteract()", context), false);
  vm.runInContext("setNativeVideoReady(true, videoEpoch, bridgeId)", context);
  assert.equal(vm.runInContext("canInteract()", context), true);
  assert.equal(element("body").classList.contains("unavailable"), false);
});

// Stateful browser harness: classes, canvas contents, time and network liveness
// remain observable, so readiness tests cannot bypass CSS or native handshakes.
/** @param {{fetchAction?: Function, decodeFrame?: Function, beforeStatus?: Function}} [options] */
function browserHarness({ fetchAction, decodeFrame, beforeStatus } = {}) {
  const nodes = new Map(),
    timers = new Map(),
    messages = [],
    draws = [],
    calls = [],
    streams = [];
  let now = 100,
    serial = 0,
    remoteLifecycle = "ready",
    udid = "phone-a",
    usbID = 7;
  function element(key) {
    if (!nodes.has(key))
      nodes.set(key, {
        content: "instance",
        width: 400,
        height: 800,
        classList: trackedClasses(),
        listeners: {},
        addEventListener(name, fn) {
          this.listeners[name] = fn;
        },
        querySelector: () => element("child"),
        removeAttribute() {},
        getBoundingClientRect: () => ({ left: 0, top: 0, width: 400, height: 800 }),
        setPointerCapture() {},
        append() {},
        remove() {},
        style: {},
        dataset: {},
        value: "",
        getContext: () => ({
          drawImage: (frame) => draws.push(frame.id),
          clearRect: () => draws.push("clear"),
        }),
      });
    return nodes.get(key);
  }
  const context = vm.createContext({
    console,
    AbortSignal,
    AbortController,
    TextDecoder,
    Blob,
    URLSearchParams,
    crypto,
    queueMicrotask,
    location: { search: "?app=1&video=native", reload() {} },
    performance: { now: () => now },
    document: {
      body: element("body"),
      getElementById: element,
      querySelector: element,
      querySelectorAll: () => [],
      createElement: () => element("ripple"),
      activeElement: null,
    },
    window: {
      addEventListener() {},
      webkit: { messageHandlers: { native: { postMessage: (message) => messages.push(message) } } },
    },
    setTimeout: (fn, ms) => {
      const id = ++serial;
      timers.set(id, { fn, at: now + ms });
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
    createImageBitmap:
      decodeFrame ??
      (async (blob) => ({
        width: 400,
        height: 800,
        id: new Uint8Array(await blob.arrayBuffer())[0],
        close() {},
      })),
    fetch: async (url, options = {}) => {
      calls.push([url, options]);
      if (url === "/api/status") {
        await beforeStatus?.();
        return {
          json: async () => ({
            service: "iphone-mirror",
            apiVersion: 2,
            instanceId: "instance",
            ok: true,
            lifecycle: remoteLifecycle,
            device: { udid, id: usbID },
            captureIdentity: { singleUsbDevice: true },
          }),
        };
      }
      if (url.startsWith("/stream")) {
        let waiting;
        const stream = {
          push: (bytes) => {
            const pending = waiting;
            waiting = null;
            pending.resolve({ value: bytes, done: false });
          },
          reader: {
            read: () =>
              new Promise((resolve, reject) => {
                waiting = { resolve, reject };
              }),
            cancel: async () => {},
          },
        };
        streams.push(stream);
        options.signal.addEventListener("abort", () => waiting?.reject(new Error("aborted")), {
          once: true,
        });
        return {
          ok: true,
          headers: { get: () => "multipart/x-mixed-replace; boundary=--BoundaryString" },
          body: { getReader: () => stream.reader },
        };
      }
      const response = fetchAction?.(url, options);
      return response ?? { json: async () => ({ ok: true }) };
    },
  });
  vm.runInContext(loadMirrorHTML().match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? "", context);
  const run = (code) => vm.runInContext(code, context);
  const settle = async () => {
    for (let i = 0; i < 4; i++) await new Promise((resolve) => setImmediate(resolve));
  };
  return {
    run,
    settle,
    element,
    messages,
    draws,
    calls,
    streams,
    lifecycle: (value) => {
      remoteLifecycle = value;
    },
    device: (value) => {
      udid = value;
    },
    attachment: (value) => {
      usbID = value;
    },
    async advance(ms) {
      now += ms;
      for (const [id, timer] of [...timers]) if (timer.at <= now && timers.delete(id)) timer.fn();
      await settle();
    },
  };
}
function mjpegPart(bytes) {
  return Buffer.concat([
    Buffer.from(
      `--BoundaryString\r\nContent-Type: image/jpeg\r\nContent-Length: ${bytes.length}\r\n\r\n`,
    ),
    Buffer.from(bytes),
    Buffer.from("\r\n"),
  ]);
}

void test("native refreshes wake connection polling without overlapping requests", async () => {
  let finish;
  const h = browserHarness({
    beforeStatus: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  });
  await h.settle();
  for (let i = 0; i < 10; i++) await h.run("poll()");
  assert.equal(h.calls.filter(([url]) => url === "/api/status").length, 1);
  finish();
  await h.settle();
  const refresh = h.run("poll()");
  await h.settle();
  assert.equal(h.calls.filter(([url]) => url === "/api/status").length, 2);
  finish();
  await refresh;
  assert.equal(h.run("pollInFlight"), false);
});

void test("USB events immediately freeze input and stale status cannot undo a detach", async () => {
  let hold = false,
    finish;
  const h = browserHarness({
    beforeStatus: () =>
      hold
        ? new Promise((resolve) => {
            finish = resolve;
          })
        : undefined,
  });
  await h.settle();
  h.run("setNativeVideoReady(true, videoEpoch, bridgeId)");
  assert.equal(h.run("canInteract()"), true);
  hold = true;
  const pending = h.run("poll()");
  await h.settle();
  h.run("usbConnectionChanged(false, videoEpoch, bridgeId)");
  assert.equal(h.run("lifecycle"), "disconnected", "no timeout/poll needed to freeze the UI");
  assert.equal(
    h.messages.at(-1).usbDevicePresent,
    false,
    "a hardware event cannot reuse the previous USB identity",
  );
  assert.equal(h.run("canInteract()"), false);
  finish();
  await pending;
  assert.equal(
    h.run("lifecycle"),
    "disconnected",
    "a ready response from before detach is discarded",
  );
  h.run("usbConnectionChanged(true, videoEpoch, 'old-page')");
  assert.equal(h.run("lifecycle"), "disconnected");
  h.run("usbConnectionChanged(true, videoEpoch - 1, bridgeId)");
  assert.equal(
    h.run("lifecycle"),
    "connecting",
    "hardware reattach acts immediately even across video epochs",
  );
  assert.equal(h.run("canInteract()"), false, "attachment alone never grants input readiness");
  finish();
  await h.settle();
});

void test("USB reattachment invalidates old readiness, retains the frame and bypasses stale stream cooldown", async () => {
  const h = browserHarness();
  await h.settle();
  h.run("startStream()");
  await h.settle();
  h.streams[0].push(mjpegPart([41]));
  await h.settle();
  const before = h.run("videoEpoch");
  const draws = [...h.draws];
  h.run("streamRetryAt = performance.now() + 5000; streamFailures = 4");
  h.attachment(9);
  await h.run("poll()");
  await h.settle();
  assert.ok(
    h.run("videoEpoch") > before,
    "quick unplug/replug is detected even between status polls",
  );
  assert.equal(h.run("canInteract()"), false);
  assert.equal(h.messages.at(-1).usbConnectionID, "9");
  assert.deepEqual(h.draws, draws, "same phone keeps the frozen frame");
  assert.equal(h.streams.length, 2, "new USB attachment gets an immediate stream attempt");
  assert.equal(h.run(`presentStreamFrame({width:400,height:800,id:42}, 0)`), false);
  h.streams[1].push(mjpegPart([43]));
  await h.settle();
  assert.equal(h.run("canInteract()"), true);
  assert.equal(h.draws.at(-1), 43);
});

void test("MJPEG parsing handles split headers/frames and rejects unbounded or malformed parts", async () => {
  const h = browserHarness();
  await h.settle();
  const parser = h.run("new MjpegFrames()");
  const body = Buffer.concat([mjpegPart([1, 2, 3]), mjpegPart([4, 5])]);
  const frames = [];
  for (let i = 0; i < body.length; i += 7) frames.push(...parser.push(body.subarray(i, i + 7)));
  assert.deepEqual(
    frames.map((frame) => [...frame]),
    [
      [1, 2, 3],
      [4, 5],
    ],
  );
  assert.throws(
    () => h.run("new MjpegFrames()").push(Buffer.from("Content-Length: 99999999\r\n\r\n")),
    /size/,
  );
  assert.throws(
    () => h.run("new MjpegFrames()").push(Buffer.from("Content-Type: image/jpeg\r\n\r\n")),
    /size/,
  );
  assert.throws(() => h.run("new MjpegFrames()").push(Buffer.alloc(16385, 65)), /header/);
});

void test("MJPEG freezes its last presented frame, rejects stale decodes and recovers from silent stalls", async () => {
  const h = browserHarness();
  await h.settle();
  h.run("startStream()");
  await h.settle();
  assert.equal(h.streams.length, 1);
  h.streams[0].push(mjpegPart([11]));
  await h.settle();
  assert.equal(h.run("canInteract()"), true);
  assert.equal(h.element("body").classList.contains("unavailable"), false);
  const oldGeneration = h.run("streamGeneration");
  const oldDraws = [...h.draws];
  h.lifecycle("locked");
  await h.run("poll()");
  await h.settle();
  assert.equal(h.run("canInteract()"), false);
  assert.equal(h.element("body").classList.contains("unavailable"), true);
  assert.deepEqual(h.draws, oldDraws, "locking freezes rather than clears/replaces the canvas");
  assert.equal(h.run(`presentStreamFrame({width:400,height:800,id:99}, ${oldGeneration})`), false);
  h.lifecycle("ready");
  await h.run("poll()");
  await h.settle();
  assert.equal(h.run("canInteract()"), false, "unlock requires a new presented frame");
  h.streams[1].push(mjpegPart([12]));
  await h.settle();
  assert.equal(h.run("canInteract()"), true);
  assert.equal(h.draws.at(-1), 12);
  await h.advance(3001);
  assert.equal(h.run("streamReady"), false, "open but silent stream becomes unavailable");
  assert.equal(h.element("body").classList.contains("unavailable"), true);
  assert.equal(h.draws.at(-1), 12, "stall retains the last frame beneath blur");
  await h.advance(501);
  await h.run("poll()");
  await h.settle();
  assert.equal(
    h.streams.length,
    3,
    "healthy control plane retries the video channel independently",
  );
  h.streams[2].push(mjpegPart([13]));
  await h.settle();
  assert.equal(h.run("canInteract()"), true);
  h.run("useNativeVideo()");
  await h.settle();
  assert.equal(
    h.element("body").classList.contains("preserve-stream-frame"),
    true,
    "native retry keeps the blurred canvas visible until first native frame",
  );
  assert.equal(h.element("body").classList.contains("unavailable"), true);
  h.run("setNativeVideoReady(true, videoEpoch, bridgeId)");
  assert.equal(h.element("body").classList.contains("preserve-stream-frame"), false);
});

void test("native unlock restores CSS hit testing and real pointer handlers; device changes reject old readiness", async () => {
  const h = browserHarness();
  await h.settle();
  h.run("setNativeVideoReady(true, videoEpoch, bridgeId)");
  h.lifecycle("locked");
  await h.run("poll()");
  h.lifecycle("ready");
  await h.run("poll()");
  h.run("setNativeVideoReady(true, videoEpoch, bridgeId)");
  assert.equal(h.element("body").classList.contains("unavailable"), false);
  assert.equal(h.element("body").classList.contains("loading"), false);
  const e = { button: 0, pointerId: 1, clientX: 200, clientY: 400, preventDefault() {} };
  h.element("screen").listeners.pointerdown(e);
  await h.advance(40);
  h.element("screen").listeners.pointerup(e);
  await h.settle();
  assert.equal(h.calls.filter(([url]) => url === "/api/gesture").length, 1);
  h.element("screen").listeners.pointerdown(e);
  await h.advance(50);
  h.element("screen").listeners.pointermove({ ...e, clientX: 100 });
  await h.advance(50);
  h.element("screen").listeners.pointerup({ ...e, clientX: 40 });
  await h.settle();
  const drag = JSON.parse(h.calls.filter(([url]) => url === "/api/gesture").at(-1)[1].body);
  assert.ok(drag.points.length >= 3, "drag continues to deliver points after lock/unlock");
  assert.equal(drag.points.at(-1)[0], 0.1);
  const epoch = h.run("videoEpoch");
  h.device("phone-b");
  await h.run("poll()");
  assert.equal(h.run("canInteract()"), false);
  assert.ok(h.run("videoEpoch") > epoch);
  h.run(`setNativeVideoReady(true, ${epoch}, bridgeId)`);
  assert.equal(h.run("canInteract()"), false);
  h.run("setLifecycle('connecting', '', 'new-server')");
  assert.equal(
    h.run("deviceUdid"),
    "",
    "new-server observation without a target cannot retain the old device",
  );
  assert.equal(h.element("body").classList.contains("preserve-stream-frame"), false);
});

void test("hung action and receipt requests expire without retrying input or blocking the queue forever", async () => {
  let homes = 0;
  const h = browserHarness({
    fetchAction: (url, options) => {
      if ((url === "/api/home" && ++homes === 1) || url.startsWith("/api/commands/"))
        return new Promise(() => {});
    },
  });
  await h.settle();
  h.run("setNativeVideoReady(true, videoEpoch, bridgeId)");
  const first = h.run("api('home')");
  const second = h.run("api('home')");
  await h.settle();
  assert.equal(homes, 1);
  await h.advance(18000);
  assert.equal(h.calls.find(([url]) => url === "/api/home")[1].signal.aborted, true);
  await h.advance(3000);
  await first;
  await second;
  assert.equal(homes, 2, "next distinct action can run after bounded receipt recovery");
  const ids = h.calls
    .filter(([url]) => url === "/api/home")
    .map(([, opts]) => JSON.parse(opts.body).requestId);
  assert.notEqual(ids[0], ids[1], "no ambiguous action is replayed");
  assert.equal(h.run("pendingActions"), 0);
});

void test("Effect schemas reject malformed actions before device dispatch", async () => {
  for (const [
    name,
    body,
  ] of /** @type {[keyof typeof import("../schemas.mjs").RequestSchemas, unknown][]} */ ([
    ["type", {}],
    ["type", { text: 123 }],
    ["quality", { level: "constructor" }],
    ["shortcut", { name: "invalid" }],
    ["gesture", { points: [[]], end: 0 }],
    ["gesture", { points: [[2, 0, 0]], end: 50 }],
    ["gesture", { points: [[0, 0, 5]], end: 50 }],
    [
      "gesture",
      {
        points: [
          [0, 0, 0],
          [0, 1, 100],
          [0, 1, 50],
        ],
        end: 100,
      },
    ],
    [
      "gesture",
      {
        points: [
          [0, 0, 0],
          [0, 1, 100],
        ],
        end: 50,
      },
    ],
    ["gesture", { points: [[0, 0, 0]], end: 10001 }],
    ["home", { typo: true }],
    ["tap", {}],
    ["tap", { id: "a", selector: { using: "id", value: "a" } }],
    ...[0, -1, 5, NaN, Infinity, "2"].map((scale) => ["pinch", { x: 0.5, y: 0.5, scale }]),
    ["pinch", { x: 2, y: 0.5, scale: 2 }],
    ["pinch", { x: 0.5, scale: 2 }],
    ["pinch", { x: 0.5, y: 0.5, scale: 2, durationMs: 0 }],
  ]))
    await assert.rejects(
      Effect.runPromise(
        decodeRequest(
          /** @type {keyof typeof import("../schemas.mjs").RequestSchemas} */ (name),
          body,
        ),
      ),
      String(name),
    );
  assert.deepEqual(
    await Effect.runPromise(
      decodeRequest("gesture", {
        points: [
          [0, 0, 0],
          [1, 1, 100],
        ],
        end: 100,
      }),
    ),
    {
      points: [
        [0, 0, 0],
        [1, 1, 100],
      ],
      end: 100,
    },
  );
  assert.equal(
    (
      await Effect.runPromise(
        decodeRequest("gesture", {
          points: [
            [0, 0, 0],
            [1, 1, 42.5],
          ],
          end: 43.75,
        }),
      )
    ).end,
    43.75,
  );
  assert.equal(
    (await Effect.runPromise(decodeRequest("pinch", { x: 0.5, y: 0.5, scale: 2 }))).scale,
    2,
  );
});

void test("pinch paths are simultaneous, preserve scale and stay on screen in portrait and landscape", () => {
  for (const [width, height] of [
    [390, 844],
    [844, 390],
  ]) {
    for (const scale of [0.25, 0.5, 1.5, 2, 4])
      for (const x of [0, 0.5, 1])
        for (const y of [0, 0.5, 1]) {
          const fingers = pinchActions({ x, y, scale, durationMs: 333 }, { width, height });
          assert.equal(new Set(fingers.map((f) => f.id)).size, 2);
          const [left, right] = fingers.map((f) => f.actions);
          assert.deepEqual(
            left.map((a) => [a.type, a.duration]),
            right.map((a) => [a.type, a.duration]),
          );
          assert.equal(
            left.reduce((total, a) => total + (a.duration ?? 0), 0),
            373,
          );
          for (const finger of fingers)
            for (const point of finger.actions.filter((a) => a.type === "pointerMove")) {
              assert.ok("x" in point && "y" in point);
              assert.ok(point.x >= 0 && point.x < width && point.y >= 0 && point.y < height);
            }
          const startLeft = left[0],
            startRight = right[0],
            endLeft = left.at(-2),
            endRight = right.at(-2);
          assert(startLeft && startRight && endLeft && endRight);
          assert("x" in startLeft && "x" in startRight && "x" in endLeft && "x" in endRight);
          const startDistance = startRight.x - startLeft.x;
          const endDistance = endRight.x - endLeft.x;
          assert.ok(Math.abs(endDistance / startDistance - scale) < 0.06);
          assert.ok(
            Math.abs(startRight.x + startLeft.x - (endRight.x + endLeft.x)) <= 1,
            "zoom must not also pan",
          );
        }
  }
});

void test("native pinch adds deltas once, cancels stale tails and cannot also scroll", async () => {
  const h = browserHarness();
  await h.settle();
  h.run("setNativeVideoReady(true, videoEpoch, bridgeId)");
  const send = (event) =>
    h.run(
      `nativePinch(${JSON.stringify({ x: 0.4, y: 0.6, delta: 0, ...event })}, videoEpoch, bridgeId)`,
    );
  const pinches = () =>
    h.calls.filter(([url]) => url === "/api/pinch").map(([, opts]) => JSON.parse(opts.body));
  h.run("nativeScroll({phase:'began',x:0.5,y:0.5,dx:0,dy:0.2}, videoEpoch, bridgeId)");
  send({ phase: "began" });
  send({ phase: "changed", delta: 0.25 });
  send({ phase: "changed", delta: 0.25 });
  await h.settle();
  assert.equal(pinches().length, 0);
  h.run("nativeScroll({phase:'ended',x:0.5,y:0.5,dx:0,dy:0.2}, videoEpoch, bridgeId)");
  send({ phase: "ended" });
  send({ phase: "ended" });
  await h.settle();
  assert.equal(pinches().length, 1);
  assert.equal(pinches()[0].scale, 1.5);
  assert.equal(pinches()[0].x, 0.4);
  assert.equal(pinches()[0].y, 0.6);
  assert.equal(h.calls.filter(([url]) => url === "/api/gesture").length, 0);
  send({ phase: "began" });
  send({ phase: "changed", delta: -0.5 });
  send({ phase: "ended" });
  await h.settle();
  assert.equal(pinches().at(-1).scale, 0.5);
  send({ phase: "began" });
  send({ phase: "changed", delta: 1 });
  send({ phase: "cancelled" });
  send({ phase: "ended" });
  send({ phase: "began" });
  send({ phase: "changed", delta: 1 });
  h.lifecycle("locked");
  await h.run("poll()");
  h.lifecycle("ready");
  await h.run("poll()");
  h.run("setNativeVideoReady(true, videoEpoch, bridgeId)");
  send({ phase: "changed", delta: 1 });
  send({ phase: "ended" });
  await h.settle();
  assert.equal(pinches().length, 2);
  h.run("nativePinch({phase:'began',x:0.5,y:0.5,delta:1}, videoEpoch-1, bridgeId)");
  send({ phase: "ended" });
  await h.settle();
  assert.equal(pinches().length, 2);
  send({ phase: "began" });
  send({ phase: "changed", delta: 2 });
  send({ phase: "began" });
  send({ phase: "changed", delta: 0.5 });
  await h.run("api('home')");
  send({ phase: "changed", delta: 1 });
  send({ phase: "ended" });
  await h.settle();
  assert.equal(pinches().length, 3);
  assert.equal(pinches().at(-1).scale, 1.5, "early flush cannot replay or add its tail");
});

void test("Command-scroll zooms once per burst, latches its trackpad mode and Safari scales are cumulative", async () => {
  const h = browserHarness();
  await h.settle();
  h.run("setNativeVideoReady(true, videoEpoch, bridgeId)");
  const screen = h.element("screen");
  const pinches = () =>
    h.calls.filter(([url]) => url === "/api/pinch").map(([, opts]) => JSON.parse(opts.body));
  const wheel = (deltaY, modifiers = {}) =>
    screen.listeners.wheel({
      clientX: 200,
      clientY: 400,
      deltaX: 0,
      deltaY,
      preventDefault() {},
      ...modifiers,
    });
  wheel(-50, { metaKey: true });
  wheel(-50, { metaKey: true });
  await h.advance(80);
  assert.equal(pinches().length, 1);
  assert.ok(pinches()[0].scale > 1);
  wheel(100, { ctrlKey: true });
  await h.advance(80);
  assert.equal(pinches().length, 2);
  assert.ok(pinches()[1].scale < 1);
  for (const event of [
    { phase: "began", zoom: true },
    { phase: "changed", zoom: true, dy: -0.1 },
    { phase: "ended", zoom: false },
  ]) {
    h.run(
      `nativeScroll(${JSON.stringify({ x: 0.5, y: 0.5, dx: 0, dy: 0, ...event })}, videoEpoch, bridgeId)`,
    );
  }
  await h.settle();
  assert.equal(pinches().length, 3);
  assert.equal(h.calls.filter(([url]) => url === "/api/gesture").length, 0);
  const gesture = (name, scale) =>
    screen.listeners[name]({ clientX: 200, clientY: 400, scale, preventDefault() {} });
  gesture("gesturestart", 1);
  gesture("gesturechange", 1.5);
  gesture("gesturechange", 2);
  gesture("gestureend", 2);
  await h.settle();
  assert.equal(pinches().at(-1).scale, 2);
  wheel(100);
  await h.advance(80);
  assert.equal(
    h.calls.filter(([url]) => url === "/api/gesture").length,
    1,
    "ordinary scrolling still swipes",
  );
});

void test("wheel bursts dispatch once and preserve click/long-press durations", async () => {
  const h = browserHarness();
  await h.settle();
  h.run("setNativeVideoReady(true, videoEpoch, bridgeId)");
  const screen = h.element("screen");
  const gestures = () =>
    h.calls.filter(([url]) => url === "/api/gesture").map(([, opts]) => JSON.parse(opts.body));
  const wheel = () =>
    screen.listeners.wheel({
      clientX: 200,
      clientY: 400,
      deltaX: 0,
      deltaY: 40,
      preventDefault() {},
    });
  for (let i = 0; i < 20; i++) {
    wheel();
    await h.advance(10);
  }
  assert.equal(gestures().length, 0, "a physical burst must not be split while still moving");
  await h.advance(80);
  assert.equal(gestures().length, 1);
  await h.advance(300);
  assert.equal(gestures().length, 1, "completion must not replay accumulated movement");
  wheel();
  await h.advance(80);
  assert.equal(gestures().length, 2, "the next distinct burst still works");
  const event = { button: 0, pointerId: 1, clientX: 200, clientY: 400, preventDefault() {} };
  screen.listeners.pointerdown(event);
  await h.advance(120);
  screen.listeners.pointerup(event);
  await h.settle();
  assert.equal(gestures().at(-1).end, 40);
  screen.listeners.pointerdown(event);
  await h.advance(600);
  screen.listeners.pointerup(event);
  await h.settle();
  assert.equal(gestures().at(-1).end, 600);
});

void test("native scroll sends exactly one swipe in each direction and ignores momentum/cancelled tails", async () => {
  const h = browserHarness();
  await h.settle();
  h.run("setNativeVideoReady(true, videoEpoch, bridgeId)");
  const send = (event) =>
    h.run(
      `nativeScroll(${JSON.stringify({ x: 0.5, y: 0.5, dx: 0, dy: 0, ...event })}, videoEpoch, bridgeId)`,
    );
  const gestures = () =>
    h.calls.filter(([url]) => url === "/api/gesture").map(([, opts]) => JSON.parse(opts.body));
  for (const [dx, dy] of [
    [0.04, 0],
    [-0.04, 0],
    [0, 0.04],
    [0, -0.04],
  ]) {
    const count = gestures().length;
    send({ phase: "began" });
    for (let i = 0; i < 6; i++) {
      send({ phase: "changed", dx, dy });
      await h.advance(20);
    }
    assert.equal(gestures().length, count);
    send({ phase: "ended" });
    await h.settle();
    assert.equal(gestures().length, count + 1);
    const points = gestures().at(-1).points;
    assert.equal(Math.sign(points.at(-1)[0] - points[0][0]), dx ? -Math.sign(dx) : 0);
    assert.equal(Math.sign(points.at(-1)[1] - points[0][1]), dy ? -Math.sign(dy) : 0);
    for (let i = 0; i < 10; i++) {
      send({ phase: "momentum", dx, dy });
      await h.advance(20);
    }
    send({ phase: "ended" });
    await h.settle();
    assert.equal(
      gestures().length,
      count + 1,
      "momentum and duplicate end cannot create another swipe",
    );
  }
  send({ phase: "began" });
  send({ phase: "changed", dy: 0.2 });
  send({ phase: "cancelled" });
  await h.settle();
  assert.equal(gestures().length, 4);
  send({ phase: "began" });
  send({ phase: "changed", dy: 0.2 });
  h.lifecycle("locked");
  await h.run("poll()");
  h.lifecycle("ready");
  await h.run("poll()");
  h.run("setNativeVideoReady(true, videoEpoch, bridgeId)");
  send({ phase: "changed", dy: 0.2 });
  send({ phase: "ended" });
  await h.settle();
  assert.equal(gestures().length, 4, "an interrupted gesture's tail cannot swipe after unlock");
  send({ phase: "began" });
  send({ phase: "changed", dx: 0.2 });
  send({ phase: "began" });
  send({ phase: "changed", dx: -0.2 });
  send({ phase: "ended" });
  await h.settle();
  assert.equal(
    gestures().length,
    5,
    "a new begin discards an abandoned gesture instead of replaying it",
  );
});

void test("flushing scroll before another action cannot replay its remaining tail", async () => {
  const h = browserHarness();
  await h.settle();
  h.run("setNativeVideoReady(true, videoEpoch, bridgeId)");
  const wheel = () =>
    h
      .element("screen")
      .listeners.wheel({ clientX: 200, clientY: 400, deltaX: 0, deltaY: 40, preventDefault() {} });
  wheel();
  await h.run("api('home')");
  wheel();
  await h.advance(80);
  assert.equal(h.calls.filter(([url]) => url === "/api/gesture").length, 1);
  wheel();
  await h.advance(80);
  assert.equal(
    h.calls.filter(([url]) => url === "/api/gesture").length,
    2,
    "subsequent scrolling is not stuck",
  );
});

void test("automatic browser binding blocks foreign origins and rebinding without CLI credentials", () => {
  const request = (headers) => ({
    method: "POST",
    headers: { host: "localhost:7100", "content-type": "application/json", ...headers },
  });
  checkRequest(request({}), 7100, "instance");
  checkRequest(
    request({ origin: "http://localhost:7100", "x-mirror-instance": "instance" }),
    7100,
    "instance",
  );
  for (const headers of [
    { origin: "https://evil.example" },
    { host: "evil.example:7100" },
    { "content-type": "text/plain" },
    { origin: "null" },
    { origin: "http://localhost:7101" },
    { "sec-fetch-site": "cross-site" },
    { origin: "http://localhost:7100", "x-mirror-instance": "old-instance" },
  ])
    assert.throws(() => checkRequest(request(headers), 7100, "instance"));
});

void test("queue removes cancelled work and prioritizes keepalive while preserving FIFO input order", async () => {
  const scheduler = createScheduler();
  const events = [];
  let release;
  const busy = scheduler.enqueue(
    () =>
      new Promise((r) => {
        release = r;
      }),
  );
  await sleep(1);
  const cancelled = new AbortController();
  const skip = scheduler
    .enqueue(() => events.push("cancelled"), { signal: cancelled.signal })
    .catch((e) => e.name);
  const first = scheduler.enqueue(() => events.push("first"));
  const next = scheduler.enqueue(() => events.push("next"), { deadline: performance.now() + 1000 });
  const pulse = scheduler.enqueue(() => events.push("keepalive"), { priority: 10 });
  cancelled.abort();
  release();
  await Promise.all([busy, skip, first, next, pulse]);
  assert.deepEqual(events, ["keepalive", "first", "next"]);
});

void test("queue deadlines expire before dispatch, and capacity bounds backlog", async () => {
  const scheduler = createScheduler({ maxQueued: 1 });
  let release,
    executed = false;
  const busy = scheduler.enqueue(
    () =>
      new Promise((r) => {
        release = r;
      }),
  );
  await sleep(1);
  const queued = scheduler.enqueue(
    () => {
      executed = true;
    },
    { deadline: performance.now() + 20 },
  );
  await assert.rejects(
    scheduler.enqueue(() => {}),
    { code: "queue full" },
  );
  await Promise.all([assert.rejects(queued, { code: "timeout" }), sleep(30)]);
  release();
  await busy;
  assert.equal(executed, false);
});

void test("maintenance gets its own deadline after the originating input is cancelled", async () => {
  const scheduler = createScheduler();
  const controller = new AbortController();
  controller.abort();
  let dispatched = false;
  await commandContext.run(
    {
      signal: controller.signal,
      deadline: performance.now() - 100,
      insideQueue: true,
      onDispatch() {
        throw Error("inherited input receipt");
      },
    },
    () =>
      scheduler.maintenance(() => {
        const context = commandContext.getStore();
        context.signal.throwIfAborted();
        assert.ok(context.deadline > performance.now());
        assert.equal(context.onDispatch, undefined);
        dispatched = true;
      }),
  );
  assert.equal(dispatched, true);
});

void test("receipts deduplicate concurrent/retried commands, survive restart and reject conflicting IDs", async () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "mirror-receipts-"));
  try {
    const file = path.join(scratch, "commands.json");
    const ledger = createCommands({ file });
    let calls = 0;
    const input = { name: "type", body: { text: "private input" } };
    const run = async (mark) => {
      calls++;
      mark("running");
      await sleep(10);
      return { status: 200, body: { ok: true, outcome: "executed" } };
    };
    await Promise.all([ledger.execute("one", input, run), ledger.execute("one", input, run)]);
    assert.equal(calls, 1);
    const restored = createCommands({ file });
    assert.equal((await restored.execute("one", input, run)).body.ok, true);
    assert.equal(calls, 1);
    await assert.rejects(restored.execute("one", { different: true }, run), {
      code: "request conflict",
    });
    assert.equal(fs.readFileSync(file, "utf8").includes("private input"), false);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    data[0].state = "running";
    delete data[0].response;
    fs.writeFileSync(file, JSON.stringify(data));
    const afterCrash = createCommands({ file });
    assert.equal((await afterCrash.execute("one", input, run)).body.code, "outcome unknown");
    assert.equal(calls, 1);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

void test("pushed status wakes readiness without a poll and rejects old events/documents", async () => {
  const h = browserHarness();
  await h.settle();
  h.run("setNativeVideoReady(true, videoEpoch, bridgeId)");
  await h.settle();
  const presence = h.calls.filter(([url]) => url === "/api/presence");
  assert.equal(
    JSON.parse(presence.at(-1)[1].body).ready,
    true,
    "first frame publishes presence immediately",
  );
  const count = h.calls.filter(([url]) => url === "/api/status").length;
  const event = (sequence) =>
    `({service:'iphone-mirror',apiVersion:2,instanceId:'instance',eventSequence:${sequence},observedAt:Date.now(),ok:false,lifecycle:'disconnected',pinnedUdid:'phone-a'})`;
  h.run(`receiveServerStatus(${event(20)}, 'retired-page')`);
  assert.equal(h.run("canInteract()"), true);
  h.run(`receiveServerStatus(${event(20)}, bridgeId)`);
  assert.equal(h.run("canInteract()"), false);
  assert.equal(h.run("lifecycle"), "disconnected");
  h.run(`receiveServerStatus({...${event(19)},lifecycle:'ready',ok:true}, bridgeId)`);
  assert.equal(h.run("lifecycle"), "disconnected");
  await h.advance(2000);
  assert.equal(
    h.calls.filter(([url]) => url === "/api/status").length,
    count,
    "healthy events suppress the fallback timer",
  );
  await h.advance(13000);
  assert.ok(
    h.calls.filter(([url]) => url === "/api/status").length > count,
    "silence restores polling",
  );
});

void test("physical attachment waits for fresh USB selection data before native capture preparation", async () => {
  let hold = false,
    finish;
  const h = browserHarness({
    beforeStatus: () =>
      hold
        ? new Promise((resolve) => {
            finish = resolve;
          })
        : undefined,
  });
  await h.settle();
  assert.equal(h.messages.at(-1).usbDevicePresent, true);
  hold = true;
  h.run("usbConnectionChanged(false, videoEpoch, bridgeId)");
  await h.settle();
  h.run("usbConnectionChanged(true, videoEpoch, bridgeId)");
  assert.equal(h.messages.at(-1).lifecycle, "connecting");
  assert.equal(
    h.messages.at(-1).usbDevicePresent,
    false,
    "attach cannot reuse the old USB presence/fallback policy",
  );
  finish();
  await h.settle();
  hold = false;
  h.attachment(20);
  await h.advance(0);
  assert.equal(h.messages.at(-1).usbDevicePresent, true);
  assert.equal(h.messages.at(-1).usbConnectionID, "20");
  assert.equal(h.messages.at(-1).singleUsbDevice, true);
});
