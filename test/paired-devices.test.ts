import { expect, test } from "bun:test";
import {
  awaitInitialPairedDiscovery,
  createPairedMonitor,
  decodePairedInventory,
  selectDevice,
} from "../paired-devices.ts";

import fixtures from "./fixtures/paired-inventory.json" with { type: "json" };
import { EventEmitter } from "node:events";
import type { spawn } from "node:child_process";

const phone = {
  udid: "00000000-0000000000000001",
  identifier: "fixture-1",
  osVersion: "27.3",
  capabilities: { control: "eligible", video: "eligible", audio: "eligible" },
  name: "Test iPhone",
  kind: "iPhone",
  transport: "wifi",
  address: "fd00:1234::1",
};
const pad = {
  ...phone,
  udid: "00000000-0000000000000002",
  identifier: "fixture-2",
  name: "Test iPad",
  kind: "iPad",
  address: "fd00:5678::1",
};
const decode = (devices: unknown[]) =>
  decodePairedInventory(JSON.stringify({ version: 1, devices }));

test("only bounded paired tunnel endpoints enter discovery", () => {
  expect(decode([phone])[0]?.name).toBe("Test iPhone");
  for (const address of ["127.0.0.1", "192.168.1.2", "example.com", "fe80::1", "fd00::bad::1"])
    expect(() => decode([{ ...phone, address }])).toThrow();
  expect(() => decode([phone, phone])).toThrow();
  expect(() => decode([{ ...phone, udid: "../device" }])).toThrow();
  expect(() => decode([{ ...phone, transport: "internet" }])).toThrow();
  expect(() => decodePairedInventory(" ".repeat(65537))).toThrow();
});

test("one physical identity survives USB removal and reattachment", () => {
  const paired = decode([phone]);
  const udid = paired[0]!.udid;
  const wired = [{ id: 3, udid, connection: "USB" }];
  const before = selectDevice(wired, paired, udid);
  expect(selectDevice([], paired, udid)).toEqual(before);
  expect(selectDevice([{ ...wired[0]!, id: 99 }], paired, udid)).toEqual(before);
  expect(selectDevice(wired, [], udid)?.id).toBe(3);
  expect(selectDevice([], [], udid)).toBeNull();
});

test("USB / Wi-Fi handover updates route metadata without changing session identity", () => {
  const wireless = decode([phone]);
  const udid = wireless[0]!.udid;
  const before = selectDevice([], wireless, udid)!;
  const wired = selectDevice(
    [{ id: 3, udid, connection: "USB" }],
    decode([{ ...phone, transport: "usb" }]),
    udid,
  )!;
  expect(wired.transport).toBe("usb");
  expect(wired.id).toBe(before.id);
  expect(wired.address).toBe(before.address);
  expect(selectDevice([], wireless, udid)).toEqual(before);
  // A cable alone must not mislabel an actual network route as wired.
  expect(selectDevice([{ id: 3, udid, connection: "USB" }], wireless, udid)?.transport).toBe(
    "wifi",
  );
});

test("a lost selected phone never migrates to the other paired device", () => {
  const paired = decode([phone, pad]);
  expect(selectDevice([], paired, paired[1]!.udid)?.address).toBe(pad.address);
  expect(selectDevice([], [paired[1]!], paired[0]!.udid)).toBeNull();
});

for (const fixture of fixtures)
  test(`shared contract: ${fixture.name}`, () => {
    const decode = () => decodePairedInventory(JSON.stringify(fixture.inventory));
    if (fixture.valid) expect(decode).not.toThrow();
    else expect(decode).toThrow();
  });
class FakeChild extends EventEmitter {
  stdout = Object.assign(new EventEmitter(), { setEncoding() {} });
  stdin = Object.assign(new EventEmitter(), { end() {} });
  killed = false;
  kill() {
    this.killed = true;
    this.emit("close", 1);
    return true;
  }
  inventory(devices: unknown[]) {
    this.stdout.emit("data", JSON.stringify({ version: 1, devices }) + "\n");
  }
}
function monitorFixture() {
  const children: FakeChild[] = [];
  const monitor = createPairedMonitor(() => {}, {
    launch: () => {
      const child = new FakeChild();
      children.push(child);
      return child as unknown as ReturnType<typeof spawn>;
    },
    restartMs: 5,
    staleMs: 40,
    watchdogMs: 100,
  });
  return { children, monitor };
}
test("observer restart retains inventory; replacement and stop reject old callbacks", async () => {
  const { children, monitor } = monitorFixture();
  try {
    await Bun.sleep(1);
    const first = children[0]!;
    first.inventory([phone]);
    first.kill();
    expect(monitor.health()).toBe("recovering");
    expect(monitor.devices()).toHaveLength(1);
    await Bun.sleep(15);
    const second = children[1]!;
    second.inventory([pad]);
    first.inventory([phone]);
    expect(monitor.devices()[0]?.kind).toBe("iPad");
    monitor.stop();
    second.inventory([phone]);
    expect(monitor.devices()).toHaveLength(0);
  } finally {
    monitor.stop();
  }
});
test("silent observer expires stale availability and is restarted", async () => {
  const { children, monitor } = monitorFixture();
  try {
    await Bun.sleep(1);
    children[0]!.inventory([phone]);
    children[0]!.kill();
    await Bun.sleep(65);
    expect(monitor.devices()).toHaveLength(0);
    expect(children.length).toBeGreaterThan(1);
    await Bun.sleep(110);
    expect(children.length).toBeGreaterThan(2);
  } finally {
    monitor.stop();
  }
});
test("malformed snapshot is unhealthy, never a synthetic device disconnect", async () => {
  const { children, monitor } = monitorFixture();
  try {
    await Bun.sleep(1);
    children[0]!.inventory([phone]);
    children[0]!.stdout.emit("data", '{"devices":[]}\n');
    expect(monitor.health()).toBe("recovering");
    expect(monitor.devices()).toHaveLength(1);
  } finally {
    monitor.stop();
  }
});
test("authenticated connection survives observer failure; real loss still falls back", () => {
  const paired = decode([phone]);
  const udid = paired[0]!.udid;
  const usb = [{ id: 3, udid, connection: "USB" }];
  const previous = selectDevice(usb, paired, udid);
  expect(selectDevice(usb, [], udid, { previous, retainPaired: true })).toEqual(previous);
  expect(selectDevice(usb, [], udid, { previous, retainPaired: false })?.id).toBe(3);
  expect(selectDevice([], [], udid, { previous, retainPaired: false })).toBeNull();
  const legacy = selectDevice(usb, [], udid);
  expect(selectDevice(usb, paired, udid, { previous: legacy, retainPaired: false })).toEqual(
    previous,
  );
  const old = decode([
    {
      ...phone,
      osVersion: "26.5",
      capabilities: { control: "unavailable", video: "unavailable", audio: "unavailable" },
    },
  ]);
  expect(selectDevice([], old, udid)).toBeNull();
  expect(selectDevice(usb, old, udid)?.id).toBe(3);
});

test("startup waits only for initial discovery before binding the helper", () => {
  expect(awaitInitialPairedDiscovery("starting", 0)).toBe(true);
  expect(awaitInitialPairedDiscovery("ready", 20)).toBe(false);
  expect(awaitInitialPairedDiscovery("unavailable", 20)).toBe(false);
  expect(awaitInitialPairedDiscovery("starting", 1500)).toBe(false);
  expect(awaitInitialPairedDiscovery("recovering", 100)).toBe(false);
});
