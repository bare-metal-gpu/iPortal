import { serverCommand, runtimeEnvironment } from "./server-command.mjs";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { startFakeIphone } from "./fake-iphone.mjs";
import { claimDevice, canonicalUDID } from "../device-runtime.mjs";

const scratch = fs.mkdtempSync("/tmp/iportal-multi-");
const socketPath = path.join(scratch, "mux.sock");
const phoneID = "00008140-0000000000000001",
  padID = "00008140-0000000000000002";
const phone = startFakeIphone({
  frameTag: "phone-frame",
  helperPort: 18310,
  socketPath,
});
const pad = startFakeIphone({
  frameTag: "ipad-frame",
  helperPort: 18311,
  socketPath: path.join(scratch, "unused.sock"),
});
const phoneDevice = { id: 7, udid: phoneID, connection: "USB" };
const padDevice = { id: 8, udid: padID, connection: "USB" };
phone.ui.devices = [phoneDevice, padDevice];
phone.ui.targets[8] = { 8100: 18311 };
pad.ui.size = { width: 1024, height: 1366 };
pad.ui.app = "com.apple.mobilesafari";
const children = [];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const blocker = net.createServer((socket) => socket.end());

async function start(udid, kind) {
  const child = spawn(
    serverCommand[0],
    [
      ...serverCommand.slice(1),
      "--no-open",
      "--no-autostart",
      "--managed",
      "--owner",
      kind,
      "--udid",
      udid,
      "--device-kind",
      kind,
      "--port",
      String(/** @type {import("node:net").AddressInfo} */ (blocker.address()).port),
    ],
    {
      cwd: scratch,
      env: {
        ...runtimeEnvironment(scratch),
        IPORTAL_HELPER_TOKEN: udid === phoneID ? phone.helperToken : pad.helperToken,
        USBMUXD_SOCKET_ADDRESS: socketPath,
        IPORTAL_COMMANDS_FILE: path.join(scratch, `${kind}-commands.json`),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  children.push(child);
  let output = "",
    errors = "";
  child.stdout.on("data", (c) => {
    output += c;
  });
  child.stderr.on("data", (c) => {
    errors += c;
  });
  for (let i = 0; i < 100; i++) {
    const ready = output
      .split("\n")
      .find((line) => line.startsWith('{"event":"iportal-listening"'));
    if (ready) {
      const event = JSON.parse(ready);
      assert.equal(event.udid, udid);
      return { child, base: `http://127.0.0.1:${event.port}` };
    }
    if (child.exitCode !== null) throw new Error(`Server exited: ${errors}`);
    await wait(50);
  }
  throw new Error(`Server never became ready: ${output}\n${errors}`);
}
const get = (server, route) =>
  fetch(`${server.base}/api/${route}`).then((r) =>
    r.json().then((value) => /** @type {Record<string, any>} */ (value)),
  );
const post = (server, route, body = {}) =>
  fetch(`${server.base}/api/${route}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).then((r) => r.json().then((value) => /** @type {Record<string, any>} */ (value)));
async function until(server, predicate) {
  for (let i = 0; i < 60; i++) {
    const value = await get(server, "status");
    if (predicate(value)) return value;
    await wait(50);
  }
  throw new Error("Lifecycle did not converge");
}
async function firstFrame(response) {
  const reader = response.body.getReader();
  let buffered = Buffer.alloc(0);
  try {
    // HTTP chunks may split either the multipart header or the JPEG itself.
    for (;;) {
      const { value, done } = await reader.read();
      assert.ok(!done, "stream ended before its first complete frame");
      buffered = Buffer.concat([buffered, value]);
      assert.ok(buffered.length <= 1024 * 1024, "first frame exceeded the test's size limit");
      const headerEnd = buffered.indexOf("\r\n\r\n");
      if (headerEnd === -1) continue;
      const length = Number(
        buffered
          .subarray(0, headerEnd)
          .toString()
          .match(/Content-Length:\s*(\d+)/i)?.[1],
      );
      assert.ok(Number.isSafeInteger(length) && length > 0, "frame must declare its JPEG length");
      const start = headerEnd + 4;
      if (buffered.length >= start + length) return buffered.subarray(start, start + length);
    }
  } finally {
    await reader.cancel();
  }
}
try {
  assert.equal(canonicalUDID("A".repeat(40)), "a".repeat(40));
  await new Promise((r) => blocker.listen(0, "127.0.0.1", () => r(undefined)));
  const release = await claimDevice(phoneID, path.join(scratch, "leases"));
  await assert.rejects(
    claimDevice(phoneID.replaceAll("-", "").toLowerCase(), path.join(scratch, "leases")),
    /already has/,
  );
  release();
  const again = await claimDevice(phoneID, path.join(scratch, "leases"));
  again();
  const a = await start(phoneID, "iPhone"),
    b = await start(padID, "iPad");
  assert.notEqual(
    a.base,
    b.base,
    "occupied preferred API ports are allocated atomically, without attaching to another server",
  );
  assert.equal((await get(a, "health")).pinnedUdid, phoneID);
  assert.equal((await get(b, "health")).pinnedUdid, padID);
  await until(a, (s) => s.lifecycle === "ready");
  await until(b, (s) => s.lifecycle === "ready");
  assert.equal((await get(a, "status")).captureIdentity.singleUsbDevice, false);
  const command = { points: [[0.5, 0.5, 0]], end: 50, requestId: "same-receipt-on-two-devices" };
  assert.equal((await post(a, "gesture", command)).outcome, "executed");
  assert.equal((await post(b, "gesture", command)).outcome, "executed");
  const lastMove = (device) => device.log.findLast((x) => x.operation === "touch").body.points[0];
  assert.equal(lastMove(phone)[0], 0.5);
  assert.equal(lastMove(pad)[0], 0.5, "each helper receives normalized device-local coordinates");
  const streams = await Promise.all(
    [a, b].map((server) => fetch(`${server.base}/stream`, { signal: AbortSignal.timeout(5000) })),
  );
  for (const [i, tag] of ["phone-frame", "ipad-frame"].entries()) {
    assert.match(streams[i].headers.get("content-type") ?? "", /multipart/);
    const frame = await firstFrame(streams[i]);
    assert.ok(frame.includes(tag), "simultaneous streams must carry the correct device's pixels");
    const screenshot = await post([a, b][i], "screenshot");
    assert.ok(
      Buffer.from(screenshot.value.data, "base64").includes(tag),
      "screenshots are device-scoped too",
    );
  }
  await post(b, "lock");
  await until(b, (s) => s.lifecycle === "locked");
  assert.equal(
    (await get(a, "status")).lifecycle,
    "ready",
    "one locked device cannot lock the other window",
  );
  await post(b, "unlock");
  await until(b, (s) => s.lifecycle === "ready");
  // Hold one request, queue another, then physically detach only that device.
  phone.ui.delayMs = 500;
  const inFlight = post(a, "gesture", { ...command, requestId: "in-flight" });
  await wait(50);
  const queued = post(a, "home", { requestId: "before-detach" });
  phone.ui.devices = [padDevice];
  await until(a, (s) => s.lifecycle === "disconnected");
  assert.equal((await get(b, "status")).lifecycle, "ready");
  assert.equal(
    (await queued).outcome,
    "not executed",
    "queued input cannot migrate across an attachment",
  );
  await inFlight;
  phone.ui.delayMs = 0;
  phone.ui.devices = [{ ...phoneDevice, id: 9 }, padDevice];
  const recovered = await until(a, (s) => s.lifecycle === "ready" && s.device.id === 9);
  assert.equal(recovered.pinnedUdid, phoneID);
  assert.equal((await post(a, "home", { requestId: "after-reattach" })).outcome, "executed");
  const bInstance = (await get(b, "health")).instanceId;
  a.child.kill();
  await once(a.child, "exit");
  assert.equal((await get(b, "health")).instanceId, bInstance);
  assert.equal((await post(b, "home", { requestId: "survives-other-close" })).outcome, "executed");
  const reopened = await start(phoneID, "iPhone");
  await until(reopened, (s) => s.lifecycle === "ready");
  assert.equal((await get(b, "health")).instanceId, bInstance);
  reopened.child.kill("SIGKILL");
  await once(reopened.child, "exit");
  const afterCrash = await start(phoneID, "iPhone");
  await until(afterCrash, (s) => s.lifecycle === "ready");
  assert.equal(
    (await get(b, "health")).instanceId,
    bInstance,
    "a crashed peer and stale lease recovery leave the other server untouched",
  );
  console.log(
    "Multi-device targeting, ports, receipts, iPad geometry, streams, lock, detach cancellation, reconnect and close/reopen passed.",
  );
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  for (const child of children) if (child.exitCode === null) child.kill();
  phone.close();
  pad.close();
  blocker.close();
  fs.rmSync(scratch, { recursive: true, force: true });
  setTimeout(() => process.exit(), 200);
}
