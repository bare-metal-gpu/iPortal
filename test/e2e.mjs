// End-to-end test against the fake iPhone: usbmuxd forwarding, status, MJPEG stream and input commands.
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import { startFakeIphone, SOCKET } from "./fake-iphone.mjs";

const fake = startFakeIphone();
const PORT = 7199;
const server = spawn(process.execPath, ["mirror.mjs", "--port", PORT, "--wda-port", "18200", "--mjpeg-port", "19200", "--no-open"], {
  env: { ...process.env, USBMUXD_SOCKET_ADDRESS: SOCKET },
  stdio: "inherit",
});
const base = `http://127.0.0.1:${PORT}`;
const post = (name, body = {}) =>
  fetch(`${base}/api/${name}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());

try {
  for (let i = 0; i < 50; i++) {
    try { await fetch(base); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }

  const status = await (await fetch(`${base}/api/status`)).json();
  assert.equal(status.ok, true, JSON.stringify(status));
  assert.equal(status.device.udid, "00008110-FAKEFAKEFAKE");

  const res = await fetch(`${base}/stream`);
  assert.match(res.headers.get("content-type"), /multipart\/x-mixed-replace/);
  const reader = res.body.getReader();
  const { value } = await reader.read();
  assert.ok(value.length > 0, "stream sends bytes");
  await reader.cancel();

  assert.equal((await post("gesture", { points: [[0.5, 0.5, 0]], end: 80 })).ok, true);
  const tap = fake.log.findLast((l) => l.path === "/session/S1/actions").body.actions[0].actions;
  assert.deepEqual(tap[0], { type: "pointerMove", duration: 0, x: 195, y: 422 });
  assert.equal(tap.find((a) => a.type === "pause").duration, 80);

  await post("gesture", { points: [[0.5, 0.8, 0], [0.5, 0.2, 120]], end: 120 });
  const swipe = fake.log.findLast((l) => l.path === "/session/S1/actions").body.actions[0].actions;
  assert.equal(swipe[2].duration, 120);
  assert.equal(swipe[2].y, Math.round(0.2 * 843));

  await post("type", { text: "hi\n" });
  assert.deepEqual(fake.log.findLast((l) => l.path === "/session/S1/wda/keys").body.value, ["h", "i", "\n"]);

  await post("home");
  assert.ok(fake.log.some((l) => l.path === "/wda/homescreen"));

  await post("launch", { bundleId: "com.apple.Preferences" });
  assert.equal(fake.log.findLast((l) => l.path.endsWith("/apps/launch")).body.bundleId, "com.apple.Preferences");

  console.log("✓ all e2e checks passed");
} catch (e) {
  console.error(e);
  process.exitCode = 1;
} finally {
  server.kill();
  fake.close();
  setTimeout(() => process.exit(), 100);
}
