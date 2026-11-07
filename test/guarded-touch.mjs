import { serverCommand, runtimeEnvironment } from "./server-command.mjs";
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startFakeIphone, SOCKET } from "./fake-iphone.mjs";

const fake = startFakeIphone({ guardedTouch: true });
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "mirror-guarded-"));
const server = spawn(serverCommand[0], [...serverCommand.slice(1), "--port", "7199", "--no-open"], {
  cwd: scratch,
  env: {
    ...runtimeEnvironment(scratch),
    IPORTAL_HELPER_TOKEN: fake.helperToken,
    USBMUXD_SOCKET_ADDRESS: SOCKET,
    IPORTAL_COMMANDS_FILE: path.join(scratch, "commands.json"),
  },
  stdio: "inherit",
});
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
  const first = fake.log.filter((l) => !l.monitor && l.operation && l.operation !== "status");
  assert.deepEqual(
    first.map((l) => l.operation),
    ["touch"],
  );
  assert.equal(first[0].body.expectedBundleId, fake.ui.app);
  for (const { name, args } of [
    { name: "type", args: { text: "synthetic" } },
    { name: "key", args: { key: "ArrowLeft" } },
  ]) {
    const rejected = await post(name, { ...args, expectedApp: "wrong" });
    assert.equal(rejected.status, 409);
    assert.equal(rejected.outcome, "not executed");
    assert.equal(
      fake.log.findLast((entry) => entry.operation === (name === "type" ? "text" : "key")).body
        .expectedBundleId,
      "wrong",
    );
  }
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
    pinchCalls.map((l) => l.operation),
    ["touch"],
    "two fingers share one guarded on-device dispatch",
  );
  assert.equal(pinchCalls[0].body.fingers.length, 2);
  assert.equal(pinchCalls[0].body.expectedBundleId, fake.ui.app);
  assert.equal((await post("pinch", { ...pinchBody, expectedApp: "wrong" })).status, 409);

  // An unavailable operation fails explicitly; it must never dispatch a fallback.
  fake.ui.removeTouch = true;
  const touchCount = fake.log.filter((l) => l.operation === "touch").length;
  assert.equal((await post("gesture", body)).code, "unsupported operation");
  assert.equal(fake.log.filter((l) => l.operation === "touch").length, touchCount + 1);
  fake.ui.removeTouch = false;

  // Input can interrupt a multi-sample observation, which must then report instability.
  fake.ui.delayMs = 60;
  const from = fake.log.length;
  const observing = post("observe", { screenshot: false });
  await new Promise((r) => setTimeout(r, 30));
  const input = post("home");
  const observation = await observing;
  await input;
  assert.equal(observation.value.stable, false);
  const trace = fake.log.slice(from).map((l) => l.operation);
  const home = trace.indexOf("home");
  const snapshots = trace.flatMap((p, i) => (p === "source" ? [i] : []));
  assert.ok(snapshots[0] < home && home < snapshots[1], JSON.stringify(trace));
  console.log("✓ guarded touch, no-replay checks and interruptible observation passed");
} finally {
  server.kill("SIGTERM");
  await new Promise((resolve) => server.once("exit", resolve));
  fake.close();
  fs.rmSync(scratch, { recursive: true, force: true });
}
