import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { createStatusEvents } from "../status-events.mjs";
import { createUSBMonitor } from "../usb-events.mjs";
const settle = () => new Promise((r) => setImmediate(r));
const decode = (data) => JSON.parse(new TextDecoder().decode(data).slice(6));

void test("status events coalesce probes, cancel obsolete readiness, and publish detach immediately", async () => {
  const reads = [];
  const hub = createStatusEvents({
    read: (signal) => new Promise((resolve) => reads.push({ signal, resolve })),
  });
  try {
    const first = hub.refresh();
    assert.equal(hub.refresh(), first);
    reads[0].resolve({ lifecycle: "ready" });
    await first;
    const reader = hub.stream().getReader();
    assert.equal(decode((await reader.read()).value).lifecycle, "ready");
    assert.equal(reads.length, 2);
    hub.invalidate({ lifecycle: "disconnected" });
    assert.equal(reads[1].signal.aborted, true);
    assert.equal(decode((await reader.read()).value).lifecycle, "disconnected");
    reads[1].resolve({ lifecycle: "ready" });
    await settle();
    assert.equal(reads.length, 3);
    reads[2].resolve({ lifecycle: "disconnected" });
    assert.equal(decode((await reader.read()).value).lifecycle, "disconnected");
    await reader.cancel();
  } finally {
    hub.stop();
  }
});

void test("slow event readers retain a bounded latest snapshot and can cancel", async () => {
  let state = 0;
  const hub = createStatusEvents({ read: async () => ({ state: ++state }) });
  try {
    await hub.refresh();
    const reader = hub.stream().getReader();
    await settle();
    for (let i = 0; i < 100; i++) hub.invalidate({ state: i });
    await settle();
    await reader.read();
    const latest = decode((await reader.read()).value);
    assert.ok(latest.eventSequence > 100);
    await reader.cancel();
  } finally {
    hub.stop();
  }
});

void test("usbmux events handle fragmented/coalesced frames and fall back after listener failure", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "portal-usb-"));
  const address = path.join(directory, "mux");
  let socket,
    lists = 0,
    devices = [];
  const changed = [];
  const server = net.createServer((s) => {
    socket = s;
    s.on("data", () => {});
  });
  await new Promise((r) => server.listen(address, () => r(undefined)));
  const monitor = createUSBMonitor({
    address,
    list: async () => {
      lists++;
      return devices;
    },
    onChange: (d) => changed.push(d),
    retryMs: 10000,
  });
  function packet(body) {
    const bytes = Buffer.from(`<plist><dict>${body}</dict></plist>`),
      header = Buffer.alloc(16);
    header.writeUInt32LE(bytes.length + 16);
    header.writeUInt32LE(1, 4);
    header.writeUInt32LE(8, 8);
    return Buffer.concat([header, bytes]);
  }
  async function until(predicate) {
    for (let i = 0; i < 100 && !predicate(); i++) await new Promise((r) => setTimeout(r, 5));
    assert.ok(predicate());
  }
  try {
    await until(() => socket);
    const result = packet(
      "<key>MessageType</key><string>Result</string><key>Number</key><integer>0</integer>",
    );
    socket.write(result.subarray(0, 7));
    socket.write(result.subarray(7));
    await until(() => lists === 1);
    const attached = packet(
      "<key>MessageType</key><string>Attached</string><key>DeviceID</key><integer>9</integer><key>SerialNumber</key><string>phone</string><key>ConnectionType</key><string>USB</string>",
    );
    const detached = packet(
      "<key>MessageType</key><string>Detached</string><key>DeviceID</key><integer>9</integer>",
    );
    socket.write(Buffer.concat([attached, detached, attached]));
    await until(() => changed.length === 3);
    assert.equal((await monitor.devices())[0].id, 9);
    assert.equal(lists, 1, "new tunnels use the event cache");
    devices = [{ id: 10, udid: "phone", connection: "USB" }];
    socket.destroy();
    await until(() => lists > 1);
    assert.equal((await monitor.devices())[0].id, 10, "failed subscription uses ListDevices");
  } finally {
    monitor.stop();
    socket?.destroy();
    await new Promise((r) => server.close(r));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
