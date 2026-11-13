import { test } from "bun:test";
import assert from "node:assert/strict";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { createStatusEvents } from "../status-events.ts";
import { createUSBMonitor } from "../usb-events.ts";
const settle = () => new Promise((r) => setImmediate(r));
const decode = (data) => JSON.parse(new TextDecoder().decode(data).slice(6));

test("content revisions publish without probing and cannot roll back behind a stale probe", async () => {
  const reads = [];
  const hub = createStatusEvents({ read: () => new Promise((resolve) => reads.push(resolve)) });
  try {
    const ready = hub.refresh();
    reads[0]({ lifecycle: "ready", contentRevision: 0 });
    await ready;
    const reader = hub.stream().getReader();
    await reader.read();
    assert.equal(reads.length, 2);
    hub.patch({ contentRevision: 1 });
    assert.equal(decode((await reader.read()).value).contentRevision, 1);
    assert.equal(reads.length, 2, "No status probe for a content event");
    reads[1]({ lifecycle: "ready", contentRevision: 0 });
    assert.equal(decode((await reader.read()).value).contentRevision, 1);
    await reader.cancel();
  } finally {
    hub.stop();
  }
});

test("status events coalesce probes, cancel obsolete readiness, and publish detach immediately", async () => {
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

test("slow event readers retain a bounded latest snapshot and can cancel", async () => {
  let state = 0;
  const hub = createStatusEvents({ read: async () => ({ lifecycle: "ready", state: ++state }) });
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

test("one unanswered probe keeps a verified session; a second, or any real signal, ends it", async () => {
  const reads = [];
  let clock = 0;
  const hub = createStatusEvents({
    read: (signal, probe) => new Promise((resolve) => reads.push({ resolve, probe })),
    readyMs: 60000,
    retryMs: 60000,
    now: () => clock,
  });
  // Each step is one status read: answered, or with its helper probe unanswered.
  const answered = (value) => {
    const pending = hub.refresh();
    reads.at(-1).resolve(value);
    return pending;
  };
  const unanswered = (value = { lifecycle: "connecting", ok: false }) => {
    const pending = hub.refresh();
    reads.at(-1).probe.missed();
    reads.at(-1).resolve(value);
    return pending;
  };
  const ready = { lifecycle: "ready", ok: true };
  try {
    const verified = await answered(ready);
    const held = await unanswered();
    assert.equal(held.lifecycle, "ready");
    assert.equal(held.ok, true, "reachability is not withdrawn for one probe");
    assert.equal(held.eventSequence, verified.eventSequence, "nothing is published");
    const recovered = await answered(ready);
    assert.equal(recovered.eventSequence, held.eventSequence + 1);

    // A reset tunnel refuses several probes within the same moment.
    assert.equal((await unanswered()).lifecycle, "ready");
    clock += 20;
    assert.equal((await unanswered()).lifecycle, "ready", "an instant repeat is the same miss");
    clock += 1500;
    const lost = await unanswered();
    assert.equal(lost.lifecycle, "connecting", "a second unanswered probe is a lost helper");
    assert.equal(lost.ok, false);
    assert.equal((await unanswered()).lifecycle, "connecting");

    // Everything the read actually learned is published at once.
    await answered(ready);
    assert.equal(
      (await unanswered({ lifecycle: "disconnected", ok: false })).lifecycle,
      "disconnected",
      "a detached device is not a missed probe",
    );
    await answered(ready);
    assert.equal(
      (await answered({ lifecycle: "connecting", ok: false })).lifecycle,
      "connecting",
      "a helper that answered blocked, or was restarted, is not a missed probe",
    );
    await answered(ready);
    await unanswered();
    hub.invalidate({ lifecycle: "connecting", ok: false });
    reads.at(-1).resolve({ lifecycle: "connecting", ok: false });
    assert.equal((await hub.refresh()).lifecycle, "connecting", "a route change ends the hold");

    await answered({ lifecycle: "locked", ok: true });
    const locked = await unanswered({ lifecycle: "locked", ok: false });
    assert.deepEqual([locked.lifecycle, locked.ok], ["locked", true]);
    assert.equal(
      (await unanswered({ lifecycle: "connecting", ok: false })).lifecycle,
      "locked",
      "still the first miss",
    );
  } finally {
    hub.stop();
  }
});

test("a tolerated miss is probed again at the retry cadence, not the ready one", async () => {
  let reads = 0;
  const hub = createStatusEvents({
    read: async (signal, probe) => {
      if (++reads === 2) probe.missed();
      return { lifecycle: reads === 2 ? "connecting" : "ready" };
    },
    readyMs: 60000,
    retryMs: 5,
  });
  try {
    await hub.refresh();
    assert.equal((await hub.refresh())?.lifecycle, "ready");
    for (let i = 0; i < 100 && reads < 3; i++) await new Promise((r) => setTimeout(r, 5));
    assert.equal(reads, 3, "the held snapshot is settled promptly");
  } finally {
    hub.stop();
  }
});

test("stopping ends every open event stream and refuses new ones", async () => {
  const hub = createStatusEvents({ read: async () => ({ lifecycle: "ready" }) });
  await hub.refresh();
  const reader = hub.stream().getReader();
  assert.equal(decode((await reader.read()).value).lifecycle, "ready");
  const cancelled = hub.stream().getReader();
  await cancelled.cancel();
  hub.stop();
  // Drain whatever was queued before the stop; the stream must then end.
  let chunk = await reader.read();
  for (let i = 0; i < 5 && !chunk.done; i++) chunk = await reader.read();
  assert.equal(chunk.done, true, "an open stream would hold a closing HTTP server");
  assert.equal((await hub.stream().getReader().read()).done, true);
});

test("usbmux events handle fragmented/coalesced frames and fall back after listener failure", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "iportal-usb-"));
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
