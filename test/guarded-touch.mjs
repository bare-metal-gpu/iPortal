import { serverCommand, runtimeEnvironment } from "./server-command.mjs";
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startFakeIphone, SOCKET } from "./fake-iphone.mjs";

const fake = startFakeIphone({ guardedTouch: true });
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "mirror-guarded-"));
const server = spawn(
  serverCommand[0],
  [
    ...serverCommand.slice(1),
    "--port",
    "7199",
    "--wda-port",
    "18200",
    "--mjpeg-port",
    "19200",
    "--no-open",
  ],
  {
    cwd: scratch,
    env: {
      ...runtimeEnvironment(scratch),
      USBMUXD_SOCKET_ADDRESS: SOCKET,
      IPORTAL_COMMANDS_FILE: path.join(scratch, "commands.json"),
    },
    stdio: "inherit",
  },
);
const base = "http://127.0.0.1:7199";
/** @returns {Promise<Record<string, any> & {status: number}>} */
const post = async (name, body = {}) => {
  const r = await fetch(`${base}/api/${name}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: r.status, .../** @type {Record<string, any>} */ (await r.json()) };
};
try {
  for (let i = 0; i < 50; i++) {
    try {
      await fetch(base);
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  const body = {
    points: [[0.5, 0.5, 0]],
    end: 40,
    expectedApp: fake.ui.app,
    expectedOrientation: "PORTRAIT",
  };
  assert.equal((await post("gesture", body)).ok, true);
  const first = fake.log.filter((l) => !l.monitor && l.path?.startsWith("/wda/"));
  assert.deepEqual(
    first.map((l) => l.path),
    ["/wda/mirror/capabilities", "/wda/mirror/touch"],
  );
  assert.equal(first[1].body.expectedBundleId, fake.ui.app);
  assert.equal((await post("gesture", { ...body, expectedApp: "wrong" })).status, 409);
  fake.ui.locked = true;
  assert.equal((await post("gesture", body)).status, 409);
  fake.ui.locked = false;
  const fast = await post("gesture", body);
  assert.equal(fast.timing.native.confirmationMs, 50);

  const pinchBody = { x: 0.5, y: 0.5, scale: 2, expectedApp: fake.ui.app };
  const beforePinch = fake.log.length;
  assert.equal((await post("pinch", pinchBody)).timing.native.confirmationMs, 50);
  const pinchCalls = fake.log.slice(beforePinch).filter((l) => !l.monitor);
  assert.deepEqual(
    pinchCalls.map((l) => l.path),
    ["/wda/mirror/touch"],
    "two fingers share one guarded on-device dispatch",
  );
  assert.equal(pinchCalls[0].body.fingers.length, 2);
  assert.equal(pinchCalls[0].body.expectedBundleId, fake.ui.app);
  assert.equal((await post("pinch", { ...pinchBody, expectedApp: "wrong" })).status, 409);

  // Replacing a capable helper with an old helper must never bypass host guards.
  fake.ui.removeTouch = true;
  assert.equal((await post("pinch", { ...pinchBody, expectedApp: "wrong" })).status, 409);
  assert.equal(fake.log.filter((l) => l.path?.endsWith("/actions")).length, 0);
  assert.equal((await post("gesture", { ...body, expectedApp: "wrong" })).status, 409);
  assert.equal(fake.log.filter((l) => l.path?.endsWith("/actions")).length, 0);
  assert.equal((await post("gesture", body)).ok, true);
  assert.equal(fake.log.filter((l) => l.path?.endsWith("/actions")).length, 1);

  // Input can interrupt a multi-sample observation, which must then report instability.
  fake.ui.delayMs = 60;
  const from = fake.log.length;
  const observing = post("observe", { screenshot: false });
  await new Promise((r) => setTimeout(r, 30));
  const input = post("home");
  const observation = await observing;
  await input;
  assert.equal(observation.value.stable, false);
  const trace = fake.log.slice(from).map((l) => l.path?.replace(/^\/session\/[^/]+/, ""));
  const home = trace.indexOf("/wda/homescreen");
  const snapshots = trace.flatMap((p, i) => (p?.startsWith("/source?") ? [i] : []));
  assert.ok(snapshots[0] < home && home < snapshots[1], JSON.stringify(trace));
  console.log("✓ guarded touch, fallback checks and interruptible observation passed");
} finally {
  server.kill("SIGTERM");
  await new Promise((resolve) => server.once("exit", resolve));
  fake.close();
  fs.rmSync(scratch, { recursive: true, force: true });
}
