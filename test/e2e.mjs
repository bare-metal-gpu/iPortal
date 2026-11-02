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

  const selector = { using: "accessibility id", value: "Continue" };
  const absent = { using: "accessibility id", value: "Missing" };
  assert.deepEqual((await post("state")).value, { locked: false, app: { bundleId: "com.apple.Preferences", pid: 123 }, orientation: "PORTRAIT", screen: { width: 390, height: 844 } });
  assert.deepEqual((await post("elements", { selector })).value, [{ id: "button-1" }]);
  assert.deepEqual((await post("elements", { selector: absent })).value, []);
  const state = (await post("element", { selector })).value;
  assert.equal(state.label, "Continue");
  assert.equal(state.hittable, true);
  assert.deepEqual(state.rect, { x: 20, y: 40, width: 100, height: 44 });
  assert.equal((await post("element", { id: state.id, attributes: ["enabled"] })).value.enabled, true);
  assert.equal((await post("element", { selector: absent })).code, "no such element");
  assert.equal((await post("element", { id: "stale-id" })).code, "stale element reference");
  assert.equal((await post("source")).value.children[0].name, "Continue");
  assert.equal((await post("source", { format: "xml" })).value, "<Application/>");
  assert.ok(fake.log.some((l) => l.body?.settings?.snapshotMaxDepth === 50));
  for (const body of [{}, { id: state.id }, { selector }]) {
    const shot = (await post("screenshot", body)).value;
    assert.equal(shot.mimeType, "image/jpeg");
    assert.equal(Buffer.from(shot.data, "base64")[0], 0xff);
  }

  assert.equal((await post("wait", { selector })).value.matched, true);
  assert.equal((await post("wait", { selector: absent, condition: "absent" })).value.matched, true);
  fake.ui.staleLookupOnce = true;
  assert.equal((await post("wait", { selector: absent, condition: "absent", intervalMs: 50 })).value.matched, true);
  fake.ui.staleOnce = true;
  assert.equal((await post("wait", { selector, condition: "attribute", attribute: "enabled", equals: true, intervalMs: 50 })).value.matched, true);
  const request = (name, body) => fetch(`${base}/api/${name}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const timedOut = await request("wait", { selector: absent, timeoutMs: 150, intervalMs: 50 });
  assert.equal(timedOut.status, 408);
  assert.equal((await timedOut.json()).details.last.count, 0);

  // A pending wait must allow another action to run; re-query each time after UI changes.
  let finished = false;
  const pending = post("wait", { selector: absent, timeoutMs: 2000, intervalMs: 50 }).then((r) => { finished = true; return r; });
  await new Promise((r) => setTimeout(r, 80));
  assert.equal((await post("home")).ok, true);
  assert.equal(finished, false, "wait must not monopolize the command queue");
  fake.ui.elements.push({ ...fake.ui.elements[0], id: "button-2", name: "Missing" });
  assert.equal((await pending).value.matched, true);
  const disappears = post("wait", { selector: absent, condition: "absent", intervalMs: 50 });
  setTimeout(() => fake.ui.elements.pop(), 80);
  assert.equal((await disappears).value.matched, true);

  fake.ui.elements[0].enabled = false;
  const enabled = post("wait", { selector, condition: "attribute", attribute: "enabled", equals: true, intervalMs: 50 });
  setTimeout(() => { fake.ui.elements[0].enabled = true; }, 80);
  assert.equal((await enabled).value.value, true);

  fake.ui.error = "unknown error";
  assert.equal((await post("wait", { selector: absent, condition: "absent" })).code, "unknown error", "WDA failure is not proof of absence");
  fake.ui.error = null;
  fake.ui.expireSession = true;
  assert.equal((await post("elements", { selector })).value[0].id, "button-1");
  fake.ui.elements.push({ ...fake.ui.elements[0], id: "duplicate" });
  assert.equal((await post("element", { selector })).code, "ambiguous element");
  assert.equal((await post("wait", { selector, condition: "attribute", attribute: "enabled", equals: true })).code, "ambiguous element");
  fake.ui.elements.pop();

  fake.ui.delayMs = 500;
  const t = performance.now();
  const slow = await request("wait", { selector, timeoutMs: 100 });
  assert.equal(slow.status, 408);
  assert.ok(performance.now() - t < 450, "deadline must bound upstream requests");
  fake.ui.delayMs = 0;

  for (const [name, body] of [["elements", {}], ["element", { selector, attributes: ["bad"] }], ["source", { format: "bad" }], ["wait", { selector, timeoutMs: -1 }], ["wait", { selector, condition: "attribute", attribute: "value" }], ["elements", { selector: { using: "xpath", value: "INVALID" } }]]) {
    assert.equal((await request(name, body)).status, 400, `${name} rejects invalid input`);
  }
  const malformed = await fetch(`${base}/api/elements`, { method: "POST", body: "{" });
  assert.equal(malformed.status, 400);
  assert.equal((await request("elements", { padding: "x".repeat(1024 * 1024) })).status, 413);
  assert.equal((await fetch(`${base}/api/status`)).status, 200, "malformed JSON must not crash server");
  assert.equal((await request("constructor", {})).status, 404);

  const cancelled = new AbortController();
  const cancelledWait = fetch(`${base}/api/wait`, { method: "POST", body: JSON.stringify({ selector: absent, timeoutMs: 10000, intervalMs: 50 }), signal: cancelled.signal }).catch(() => {});
  await new Promise((r) => setTimeout(r, 80));
  cancelled.abort();
  await cancelledWait;
  await new Promise((r) => setTimeout(r, 80));
  const count = fake.log.length;
  await new Promise((r) => setTimeout(r, 160));
  assert.equal(fake.log.length, count, "disconnected waits must stop polling");

  console.log("✓ all e2e checks passed");
} catch (e) {
  console.error(e);
  process.exitCode = 1;
} finally {
  server.kill();
  fake.close();
  setTimeout(() => process.exit(), 100);
}
