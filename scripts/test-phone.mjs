// Explicit opt-in: opens Settings on a real, unlocked phone. No settings are changed.
// Usage: node scripts/test-phone.mjs [base-url] [local-output-directory]
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
const base = process.argv[2] ?? "http://127.0.0.1:7100";
const output = process.argv[3];
const checks = [];
/** @returns {Promise<Record<string, any> & {status: number}>} */
async function request(name, body = {}) {
  const r = await fetch(`${base}/api/${name}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(65000),
  });
  const json = /** @type {Record<string, any>} */ (await r.json());
  return { status: r.status, ...json };
}
async function post(name, body) {
  const r = await request(name, body);
  assert.equal(r.ok, true, `${name}: ${r.error}`);
  return r.value;
}
function pass(name) {
  checks.push(name);
  console.log(`✓ ${name}`);
}
const initial = await post("state");
assert.equal(initial.locked, false, "Unlock the iPhone before running live tests");
await post("launch", { bundleId: "com.apple.Preferences" });
const nav = { using: "class name", value: "XCUIElementTypeNavigationBar" };
await post("wait", { selector: nav, timeoutMs: 15000 });
const device = await post("state");
assert.equal(device.locked, false);
assert.equal(device.app.bundleId, "com.apple.Preferences");
assert.ok(device.screen.width > 0 && device.screen.height > 0);
pass("unlocked device and foreground Settings state");
const elements = await post("elements", { selector: nav });
assert.ok(elements.length > 0);
const state = await post("element", { id: elements[0].id });
assert.equal(state.type, "XCUIElementTypeNavigationBar");
assert.equal(typeof state.enabled, "boolean");
assert.ok(state.rect.width > 0);
pass("element lookup and typed attributes/bounds");
// Native class-chain indexing selects one navigation bar without language assumptions.
const firstNav = { using: "class chain", value: "**/XCUIElementTypeNavigationBar[1]" };
const bySelector = await post("element", { selector: firstNav, attributes: ["type", "enabled"] });
assert.equal(bySelector.type, state.type);
await post("wait", {
  selector: firstNav,
  condition: "attribute",
  attribute: "enabled",
  equals: state.enabled,
  timeoutMs: 5000,
});
pass("selector-based state and attribute wait");
const source = await post("source");
let nodes = 0;
function count(n) {
  nodes++;
  for (const child of n.children ?? []) count(child);
}
count(source);
assert.ok(nodes > 5, "source must include descendants");
pass("hierarchy inspection with descendants");
for (const [name, body] of /** @type {[string, object][]} */ ([
  ["screen", {}],
  ["element", { selector: firstNav }],
])) {
  const shot = await post("screenshot", body);
  const bytes = Buffer.from(shot.data, "base64");
  assert.ok(bytes.length > 100);
  assert.ok(["image/png", "image/jpeg", "image/heic"].includes(shot.mimeType));
  if (output) {
    await fs.mkdir(output, { recursive: true });
    await fs.writeFile(path.join(output, `${name}.${shot.mimeType.split("/")[1]}`), bytes);
  }
  pass(`${name} screenshot (${shot.mimeType}, ${bytes.length} bytes)`);
}
const absent = {
  using: "accessibility id",
  value: `iphone-mirror-test-absent-${crypto.randomUUID()}`,
};
assert.equal((await post("elements", { selector: absent })).length, 0);
await post("wait", { selector: absent, condition: "absent", timeoutMs: 5000 });
const timeout = await request("wait", { selector: absent, timeoutMs: 800, intervalMs: 100 });
assert.equal(timeout.status, 408);
assert.equal(timeout.code, "timeout");
pass("absence and explicit timeout");
// Observe disappearance/reappearance across real app switches while the wait is pending.
const disappearing = request("wait", {
  selector: nav,
  condition: "absent",
  timeoutMs: 12000,
  intervalMs: 200,
});
await new Promise((resolve) => setTimeout(resolve, 300));
await post("home");
assert.equal((await disappearing).ok, true);
const appearing = request("wait", { selector: nav, timeoutMs: 15000, intervalMs: 200 });
await new Promise((resolve) => setTimeout(resolve, 300));
await post("launch", { bundleId: "com.apple.Preferences" });
assert.equal((await appearing).ok, true);
pass("real disappearance/reappearance while actions run during waits");
const report = {
  testedAt: new Date().toISOString(),
  base,
  checks,
  hierarchyNodes: nodes,
  orientation: device.orientation,
  screen: device.screen,
};
if (output)
  await fs.writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report, null, 2));
