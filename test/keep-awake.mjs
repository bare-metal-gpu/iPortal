import assert from "node:assert/strict";
import { test } from "node:test";
import { createKeepAwake } from "../keep-awake.mjs";

function fixture() {
  let time = 0, serial = 0;
  const timers = new Map(), calls = [], pending = [];
  const device = { locked: false, fail: false, blocked: false };
  const api = createKeepAwake({
    now: () => time,
    later: (fn, ms) => { const id = ++serial; timers.set(id, { at: time + ms, fn }); return id; },
    cancel: id => timers.delete(id),
    enqueue: fn => device.blocked ? new Promise((resolve, reject) => pending.push(() => fn().then(resolve, reject))) : fn(),
    withSession: fn => fn("S1"),
    wda: async (method, path, body) => {
      calls.push({ method, path, body });
      if (device.fail) throw Error("disconnected");
      if (path === "/wda/mirror/keepalive") return { value: { completed: true } };
      return { value: path.endsWith("/locked") ? device.locked : null };
    },
  });
  async function advance(ms) {
    time += ms;
    for (const [id, timer] of [...timers]) if (timer.at <= time && timers.delete(id)) await timer.fn();
  }
  return { api, calls, device, advance, pending, timers };
}

test("bounded lease pulses, renews, expires, and leaves no background timers", async () => {
  const f = fixture();
  assert.equal(f.api.status().enabled, false);
  assert.equal((await f.api.configure({ enabled: true, durationMs: 40000, method: "volume" })).pulses, 1);
  assert.deepEqual(f.calls.slice(1).map(c => c.body.name), ["volumeUp", "volumeDown"]);
  await f.advance(15000);
  assert.equal(f.api.status().pulses, 2);
  await f.api.configure({ enabled: true, durationMs: 20000, method: "hid" });
  assert.equal(f.calls.at(-1).path, "/wda/mirror/keepalive");
  assert.equal(f.api.status().backend, "hid-event-stream");
  await f.advance(15000);
  assert.equal(f.api.status().pulses, 2);
  await f.advance(5000);
  assert.equal(f.api.status().reason, "expired");
  assert.equal(f.timers.size, 0);
  const count = f.calls.length;
  await f.advance(60000);
  assert.equal(f.calls.length, count);
});

test("locked phone, malformed state and upstream failure stop without unlocking", async () => {
  const f = fixture();
  f.device.locked = true;
  await assert.rejects(f.api.configure({ enabled: true }), { code: "device locked" });
  assert.equal(f.calls.length, 1);
  assert.equal(f.api.status().reason, "locked");
  f.device.locked = null;
  await assert.rejects(f.api.configure({ enabled: true }), { code: "invalid response" });
  f.device.locked = false;
  await f.api.configure({ enabled: true });
  f.device.fail = true;
  await f.advance(15000);
  assert.equal(f.api.status().enabled, false);
  assert.equal(f.api.status().error, "disconnected");
  assert.equal(f.timers.size, 0);
});

test("disable and expiry invalidate queued work before it touches the phone", async () => {
  for (const expire of [true, false]) {
    const f = fixture();
    f.device.blocked = true;
    const enabling = f.api.configure({ enabled: true, durationMs: 1000 });
    if (expire) await f.advance(1000);
    else await f.api.configure({ enabled: false });
    await f.pending.shift()();
    assert.equal((await enabling).enabled, false);
    assert.equal(f.calls.length, 0);
    assert.equal(f.timers.size, 0);
  }
});

test("manual locking ends an active lease without sending another event", async () => {
  const f = fixture();
  await f.api.configure({ enabled: true });
  const count = f.calls.length;
  f.device.locked = true;
  await f.advance(15000);
  assert.equal(f.api.status().reason, "locked");
  assert.equal(f.calls.length, count + 1);
  assert.ok(f.calls.at(-1).path.endsWith("/locked"));
  assert.equal(f.timers.size, 0);
});

test("replacing a queued lease cannot restart the old one", async () => {
  const f = fixture();
  f.device.blocked = true;
  const old = f.api.configure({ enabled: true, method: "volume" });
  const fresh = f.api.configure({ enabled: true, method: "hid" });
  await f.pending.shift()();
  await old;
  assert.equal(f.calls.length, 0);
  await f.pending.shift()();
  await fresh;
  assert.equal(f.api.status().method, "hid");
  assert.equal(f.api.status().pulses, 1);
  assert.equal(f.calls.length, 2);
  f.api.stop();
});

test("invalid options do not replace an active lease; status is read-only", async () => {
  const f = fixture();
  await f.api.configure({ enabled: true });
  for (const body of [{ enabled: "true" }, { durationMs: 1000 }, { enabled: true, durationMs: 0 },
    { enabled: true, durationMs: 7200001 }, { enabled: true, method: "unknown" }, { enabled: true, typo: 1 }]) {
    await assert.rejects(f.api.configure(body), { status: 400 });
    assert.equal(f.api.status().enabled, true);
  }
  assert.deepEqual(await f.api.configure({}), f.api.status());
  await f.api.configure({ enabled: false });
  const count = f.calls.length;
  await f.advance(30000);
  assert.equal(f.calls.length, count);
});

test("successful input defers maintenance, drops obsolete queued pulses and preserves expiry", async () => {
  const f = fixture();
  await f.api.configure({ enabled: true, durationMs: 40000 });
  await f.advance(14000);
  f.api.activity();
  await f.advance(1000);
  assert.equal(f.api.status().pulses, 1);
  await f.advance(14000);
  assert.equal(f.api.status().pulses, 2);
  f.api.activity();
  await f.advance(11000);
  assert.equal(f.api.status().reason, "expired");
  assert.equal(f.timers.size, 0);

  const queued = fixture();
  await queued.api.configure({ enabled: true });
  queued.device.blocked = true;
  const due = queued.advance(15000);
  queued.api.activity();
  const count = queued.calls.length;
  await queued.pending.shift()();
  await due;
  assert.equal(queued.calls.length, count);
  queued.device.blocked = false;
  await queued.advance(14999);
  assert.equal(queued.calls.length, count);
  await queued.advance(1);
  assert.equal(queued.api.status().pulses, 2);
});
