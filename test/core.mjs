import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import crypto from "node:crypto";
import { Effect } from "effect";
import { createScheduler } from "../scheduler.mjs";
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
    console, URLSearchParams, location: { search: "", reload() {} }, crypto, queueMicrotask, performance,
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
