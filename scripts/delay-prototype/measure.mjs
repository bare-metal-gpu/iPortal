#!/usr/bin/env node
// Explicit physical test; requires isolated bridge, experiment runner and foreground recorder.
import fs from "node:fs/promises";
const base = process.argv[2] ?? "http://127.0.0.1:18100";
const output = process.argv[3];
if (!output) throw Error("Usage: node measure.mjs WDA-URL /absolute/report.json");
async function request(body) {
  const r = await fetch(base + "/wda/mirror/experiment/delay", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(10000) });
  const json = await r.json();
  return { status: r.status, value: json.value };
}
const results = [];
const plan = [
  ...[false, true].flatMap(ignoreDelay => Array.from({ length: 5 }, () => ({ mode: "empty", ignoreDelay }))),
  ...[0, 50, 300].flatMap(confirmationMs => [60, 250].flatMap(durationMs => Array.from({ length: 3 }, () => ({ mode: "daemon", confirmationMs, durationMs })))),
  ...[false, true].map(ignoreDelay => ({ mode: "local", ignoreDelay, durationMs: 60 })),
];
await request({ mode: "show" });
for (const body of plan) {
  const before = await request({ mode: "reset" });
  if (before.value?.error || before.value?.activeCount) throw Error("Recorder not idle: " + JSON.stringify(before));
  const response = await request(body);
  await new Promise(resolve => setTimeout(resolve, 100));
  const probe = (await request({ mode: "state" })).value;
  if (probe?.activeCount) throw Error("Contact left active; stop input and release before continuing");
  const began = probe?.events?.find(e => e.phase === "began");
  const ended = probe?.events?.findLast(e => e.phase === "ended");
  const timing = began && ended && response.value?.startedUptime ? {
    inputDeliveryMs: (began.receivedUptime - response.value.startedUptime) * 1000,
    touchDurationMs: (ended.timestamp - began.timestamp) * 1000,
    callbackAfterEndMs: (response.value.callbackUptime - ended.receivedUptime) * 1000,
  } : undefined;
  const delivered = Boolean(began && ended && began.id === ended.id);
  const item = { request: body, ...response, deliveryVerified: delivered, observedProbe: probe, timing };
  results.push(item);
  console.log(JSON.stringify({ request: body, status: response.status, elapsedMs: response.value?.elapsedMs, error: response.value?.error, deliveryVerified: delivered, timing }));
  await fs.writeFile(output, JSON.stringify({ recordedAt: new Date().toISOString(), results }, null, 2) + "\n");
  if (body.mode === "daemon" && !delivered) throw Error("Daemon baseline did not deliver to recorder; remaining comparisons invalid");
}
