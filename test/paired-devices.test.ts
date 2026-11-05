import { expect, test } from "bun:test";
import { decodePairedInventory, selectDevice } from "../paired-devices.ts";

const phone = {
  udid: "00000000-0000000000000001",
  identifier: "fixture-1",
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
const decode = (devices: unknown[]) => decodePairedInventory(JSON.stringify({ devices }));

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
