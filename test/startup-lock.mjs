import { test } from "node:test";
import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { createStartupLock } from "../startup-lock.mjs";

void test("startup lock is published without waiting for the UI helper", async () => {
  let calls = 0,
    updates = 0;
  const probe = createStartupLock({
    read: async () => {
      calls++;
      return true;
    },
    changed: () => updates++,
  });
  const device = { udid: "phone", id: 1 };
  probe.observe(device);
  probe.observe(device);
  assert.equal(probe.value(device), null);
  await setImmediate();
  assert.equal(probe.value(device), true);
  assert.equal(updates, 1);
  probe.observe(device);
  assert.equal(calls, 1, "status refreshes must not poll CoreDevice");
});

void test("a late result cannot label a replacement connection locked", async () => {
  const resolvers = [];
  const probe = createStartupLock({
    read: () => new Promise((resolve) => resolvers.push(resolve)),
  });
  const first = { udid: "phone", id: 1 },
    second = { udid: "phone", id: 2 };
  probe.observe(first);
  await setImmediate();
  probe.observe(second);
  await setImmediate();
  resolvers[0](true);
  await setImmediate();
  assert.equal(probe.value(second), null);
  resolvers[1](false);
  await setImmediate();
  assert.equal(probe.value(second), false);
  probe.reset();
  assert.equal(probe.value(second), null);
});

void test("probe errors stay unknown, never assume the phone is locked", async () => {
  const probe = createStartupLock({
    read: async () => {
      throw new Error("unavailable");
    },
  });
  const device = { udid: "phone", id: 1 };
  probe.observe(device);
  await setImmediate();
  assert.equal(probe.value(device), null);
});
