import test from "node:test";
import assert from "node:assert/strict";
import { Effect } from "effect";
import { decodeRequest } from "../schemas.mjs";
import { createPortalStatus } from "../portal-status.mjs";

function harness(wda) {
  let time = 0,
    next,
    awake = { enabled: false };
  const calls = [];
  const portal = createPortalStatus({
    wda: async (...args) => {
      calls.push(args);
      return wda?.(...args);
    },
    keepAwake: () => awake,
    now: () => time,
    later: (fn) => {
      next = fn;
      return 1;
    },
    cancel: () => {
      next = undefined;
    },
  });
  return {
    portal,
    calls,
    awake: (value) => {
      awake = value;
    },
    advance: async (ms) => {
      time += ms;
      const fn = next;
      next = undefined;
      await fn?.();
    },
    flush: () => new Promise((resolve) => setImmediate(resolve)),
  };
}
void test("viewer readiness expires and cannot be sustained by an idle server", async () => {
  const h = harness();
  h.portal.receive({ clientId: "a", ready: false });
  await h.flush();
  assert.equal(h.calls[0][2].ready, false);
  h.awake({ enabled: true, remainingMs: 12345 });
  h.portal.receive({ clientId: "a", ready: true });
  await h.advance(2000);
  assert.deepEqual(h.calls.at(-1)[2], { ready: true, keepAwakeMs: 12345 });
  await h.advance(4000);
  assert.equal(h.calls.length, 2, "no heartbeat after the viewer expires");
  h.portal.receive({ clientId: "b", ready: false });
  await h.advance(2000);
  assert.equal(h.calls.at(-1)[2].ready, false);
  h.portal.stop();
  await h.advance(2000);
  assert.equal(h.calls.length, 3);
});
void test("one ready viewer is sufficient; stale viewers are removed", async () => {
  const h = harness();
  h.portal.receive({ clientId: "ready", ready: true });
  await h.flush();
  h.portal.receive({ clientId: "loading", ready: false });
  await h.advance(2000);
  assert.equal(h.calls.at(-1)[2].ready, true);
  await h.advance(3000);
  h.portal.receive({ clientId: "loading", ready: false });
  await h.advance(2000);
  assert.equal(h.calls.at(-1)[2].ready, false);
  h.portal.stop();
});
void test("slow upstream does not overlap requests or delay receiving presence", async () => {
  let finish;
  const h = harness(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  h.portal.receive({ clientId: "a", ready: true });
  for (let i = 0; i < 100; i++) h.portal.receive({ clientId: String(i), ready: false });
  assert.equal(h.calls.length, 1);
  h.portal.stop();
  finish();
  await h.flush();
  await h.advance(2000);
  assert.equal(h.calls.length, 1);
});
void test("old helpers back off without preventing an eventual upgrade", async () => {
  const h = harness(() => {
    throw Object.assign(new Error("old helper"), { code: "unknown command" });
  });
  h.portal.receive({ clientId: "a", ready: true });
  await h.flush();
  for (let i = 0; i < 14; i++) {
    h.portal.receive({ clientId: "a", ready: true });
    await h.advance(2000);
  }
  assert.equal(h.calls.length, 1);
  h.portal.receive({ clientId: "a", ready: true });
  await h.advance(2000);
  assert.equal(h.calls.length, 2);
  h.portal.stop();
});
void test("presence schema rejects malformed or unexpected fields", async () => {
  assert.deepEqual(
    await Effect.runPromise(decodeRequest("presence", { clientId: "viewer", ready: true })),
    { clientId: "viewer", ready: true },
  );
  for (const body of [
    {},
    { clientId: "", ready: false },
    { clientId: "a", ready: 1 },
    { clientId: "a", ready: true, keepAwakeMs: 999 },
  ])
    await assert.rejects(Effect.runPromise(decodeRequest("presence", body)));
});

void test("readiness transitions publish immediately and changes during a send are coalesced", async () => {
  let finish;
  const h = harness(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  h.portal.receive({ clientId: "a", ready: false });
  h.portal.receive({ clientId: "a", ready: true });
  assert.equal(h.calls.length, 1);
  finish();
  await h.flush();
  assert.equal(h.calls.length, 2, "changed readiness is sent before the heartbeat");
  assert.equal(h.calls[1][2].ready, true);
  finish();
  await h.flush();
  h.portal.receive({ clientId: "a", ready: false });
  assert.equal(h.calls.length, 3, "disconnect cancels the scheduled heartbeat");
  assert.equal(h.calls[2][2].ready, false);
  h.portal.stop();
  finish();
  await h.flush();
});
