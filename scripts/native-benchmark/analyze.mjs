#!/usr/bin/env node
import fs from "node:fs";
import { pathToFileURL } from "node:url";

export function summarize(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  return { n: sorted.length, median: sorted.length % 2 ? sorted[(sorted.length - 1) / 2]
    : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2,
    p95: sorted[Math.ceil(sorted.length * 0.95) - 1], min: sorted[0], max: sorted.at(-1) };
}

export function analyze(rows, conditions = []) {
  const samples = [], rejected = [];
  const markers = new Map();
  for (const row of rows) if (row.event === "usb-marker" && !markers.has(row.sequence)) markers.set(row.sequence, row);
  const usedInputs = new Set();
  for (const reply of rows.filter(r => r.event === "browser" && r.stage === "reply" && r.name === "gesture")) {
    const enqueue = rows.find(r => r.event === "browser" && r.stage === "enqueue" && r.requestId === reply.requestId);
    const native = reply.timing?.native, probe = native?.benchmark;
    if (!reply.ok || !enqueue || !probe?.deliveryVerified) {
      rejected.push({ requestId: reply.requestId, reason: "Unverified command/touch delivery" }); continue;
    }
    const marker = markers.get(probe.sequence);
    // Pair with the last unused mouse-up before enqueue; reject ambiguous/missing pairs.
    // Native trackpad gestures have their own phases and are intentionally not called taps.
    const pointerUp = rows.findLast(r => r.event === "browser" && r.stage === "pointerup"
      && r.hostMs <= enqueue.hostMs && enqueue.hostMs - r.hostMs < 100);
    const input = rows.findLast(r => r.event === "mac-input" && r.type === (pointerUp ? 2 : 22) && r.hostMs <= enqueue.hostMs
      && enqueue.hostMs - r.hostMs < 200 && !usedInputs.has(r));
    if (!marker || !input || input.eventMs <= 0 || marker.hostMs < input.eventMs) {
      rejected.push({ requestId: reply.requestId, sequence: probe.sequence, reason: "Missing or ambiguous native input/video marker" }); continue;
    }
    usedInputs.add(input);
    const condition = conditions.find(c => probe.sequence > c.afterSequence && probe.sequence <= c.throughSequence)?.name ?? "unlabelled";
    samples.push({ condition, sequence: probe.sequence, requestId: reply.requestId, inputKind: pointerUp ? "pointer" : "wheel",
      inputToUSBFrameMs: marker.hostMs - input.eventMs,
      macDeliveryMs: input.hostMs - input.eventMs,
      gestureCollectionMs: pointerUp?.collectionMs ?? null, moved: pointerUp?.moved ?? null,
      releaseToEnqueueMs: enqueue.hostMs - input.eventMs,
      browserQueueMs: reply.browserQueueMs, httpMs: reply.httpMs,
      serverQueueMs: reply.timing.queueMs, serverPreflightMs: reply.timing.preflightMs,
      nativeGuardMs: native.guardMs, invokeToTouchMs: probe.invokeToTouchMs,
      touchMs: probe.touchMs, endToCallbackMs: probe.endToCallbackMs,
      // Residual includes USB video return, HTTP/bridge work, and scheduling. It is not pure video latency.
      unallocatedMs: marker.hostMs - input.eventMs - reply.browserQueueMs - reply.timing.queueMs
        - reply.timing.preflightMs - native.guardMs - probe.invokeToTouchMs });
  }
  const groups = {};
  const metrics = ["inputToUSBFrameMs", "macDeliveryMs", "gestureCollectionMs", "browserQueueMs", "httpMs",
    "releaseToEnqueueMs", "serverQueueMs", "serverPreflightMs", "nativeGuardMs", "invokeToTouchMs", "touchMs", "endToCallbackMs", "unallocatedMs"];
  for (const condition of new Set(samples.map(s => s.condition))) {
    const group = samples.filter(s => s.condition === condition);
    groups[condition] = Object.fromEntries(metrics.map(key => [key, summarize(group.map(s => s[key]))]));
  }
  return { method: "Native NSEvent mouse-up (pointer) or last scroll event (wheel) timestamp to first matching coded patch in the existing USB capture callback. Both use host uptime. Phone substage durations use phone uptime; clocks are never subtracted across devices. Excludes physical panel presentation and human hold time. Release-to-enqueue includes asynchronous browser-message delivery; it is an upper bound. p95 is nearest-rank; small groups are exploratory.",
    samples, rejected, errors: rows.filter(r => r.stage === "error"), groups };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [trace, output, conditions] = process.argv.slice(2);
  if (!trace || !output) throw Error("Usage: node analyze.mjs TRACE.jsonl REPORT.json [CONDITIONS.json]");
  const rows = fs.readFileSync(trace, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
  const result = analyze(rows, conditions ? JSON.parse(fs.readFileSync(conditions, "utf8")) : []);
  fs.writeFileSync(output, JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify({ groups: result.groups, rejected: result.rejected }, null, 2));
  if (!result.samples.length || result.rejected.length || result.errors.length) process.exitCode = 1;
}
