import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startFakeIphone, SOCKET } from "./fake-iphone.mjs";

const fake = startFakeIphone({ guardedTouch: true });
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "mirror-guarded-"));
const server = spawn(process.execPath, ["mirror.mjs", "--port", "7199", "--wda-port", "18200", "--mjpeg-port", "19200", "--no-open"], {
  env: { ...process.env, USBMUXD_SOCKET_ADDRESS: SOCKET, MIRROR_COMMANDS_FILE: path.join(scratch, "commands.json") }, stdio: "inherit",
});
const base = "http://127.0.0.1:7199";
const post = async (name, body = {}) => {
  const r = await fetch(`${base}/api/${name}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, ...await r.json() };
};
try {
  for (let i = 0; i < 50; i++) {
    try { await fetch(base); break; } catch { await new Promise(r => setTimeout(r, 100)); }
  }
  const body = { points: [[.5, .5, 0]], end: 40, expectedApp: fake.ui.app, expectedOrientation: "PORTRAIT" };
  assert.equal((await post("gesture", body)).ok, true);
  const first = fake.log.filter(l => l.path?.startsWith("/wda/"));
  assert.deepEqual(first.map(l => l.path), ["/wda/mirror/capabilities", "/wda/mirror/touch"]);
  assert.equal(first[1].body.expectedBundleId, fake.ui.app);
  assert.equal((await post("gesture", { ...body, expectedApp: "wrong" })).status, 409);
  fake.ui.locked = true;
  assert.equal((await post("gesture", body)).status, 409);
  fake.ui.locked = false;
  const fast = await post("gesture", body);
  assert.equal(fast.timing.native.confirmationMs, 50);

  // Replacing a capable helper with an old helper must never bypass host guards.
  fake.ui.removeTouch = true;
  assert.equal((await post("gesture", { ...body, expectedApp: "wrong" })).status, 409);
  assert.equal(fake.log.filter(l => l.path?.endsWith("/actions")).length, 0);
  assert.equal((await post("gesture", body)).ok, true);
  assert.equal(fake.log.filter(l => l.path?.endsWith("/actions")).length, 1);

  // Input can interrupt a multi-sample observation, which must then report instability.
  fake.ui.delayMs = 60;
  const from = fake.log.length;
  const observing = post("observe", { screenshot: false });
  await new Promise(r => setTimeout(r, 30));
  const input = post("home");
  const observation = await observing;
  await input;
  assert.equal(observation.value.stable, false);
  const trace = fake.log.slice(from).map(l => l.path?.replace(/^\/session\/[^/]+/, ""));
  const home = trace.indexOf("/wda/homescreen");
  const snapshots = trace.flatMap((p, i) => p?.startsWith("/source?") ? [i] : []);
  assert.ok(snapshots[0] < home && home < snapshots[1], JSON.stringify(trace));
  console.log("✓ guarded touch, fallback checks and interruptible observation passed");
} finally {
  server.kill("SIGTERM");
  await new Promise(resolve => server.once("exit", resolve));
  await fake.close();
  fs.rmSync(scratch, { recursive: true, force: true });
}
