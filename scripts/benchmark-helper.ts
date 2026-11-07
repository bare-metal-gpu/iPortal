#!/usr/bin/env bun
// Controlled fixture benchmark: acknowledgement and first changed fallback-video frame.
// Usage: bun scripts/benchmark-helper.ts report.json fixture.bundle.id [usb|wifi]
import assert from "node:assert/strict";
import path from "node:path";
import { mkdir } from "node:fs/promises";

const output = process.argv[2];
if (!output) throw new Error("Provide an output report path");
const base = process.env.IPORTAL_API_URL ?? "http://127.0.0.1:7100";
const fixture = process.argv[3];
if (!fixture) throw new Error("Provide the installed fixture bundle identity");
const root = path.resolve(import.meta.dirname, "..");
const workerPath = path.join(root, "vendor/frame-sample");
await mkdir(path.dirname(workerPath), { recursive: true });
const build = Bun.spawn(
  ["xcrun", "swiftc", "-O", path.join(root, "scripts/frame-sample.swift"), "-o", workerPath],
  { stderr: "inherit" },
);
if (await build.exited) throw new Error("Could not build frame sampler");
const worker = Bun.spawn([workerPath], { stdin: "pipe", stdout: "pipe", stderr: "inherit" });
const pixels = worker.stdout.getReader();
const lifetime = new AbortController();
const wait = (ms: number) => Bun.sleep(ms);
async function post(name: string, body: Record<string, unknown> = {}) {
  const response = await fetch(`${base}/api/${name}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(65000)]),
  });
  const result = (await response.json()) as Record<string, any>;
  if (!result.ok) throw new Error(JSON.stringify(result));
  return result;
}
const frames: { time: number; pixels: Uint8Array }[] = [];
let videoFailure: unknown;
let frameBytes = Buffer.alloc(0);
async function sample(frame: Uint8Array) {
  const header = Buffer.alloc(4);
  header.writeUInt32LE(frame.length);
  await worker.stdin.write(header);
  await worker.stdin.write(frame);
  await worker.stdin.flush();
  const size = 64 * 96 * 3;
  while (frameBytes.length < size) {
    const result = await pixels.read();
    if (result.done) throw new Error("Frame sampler stopped");
    frameBytes = Buffer.concat([frameBytes, result.value]);
  }
  const result = frameBytes.subarray(0, size);
  frameBytes = frameBytes.subarray(size);
  return result;
}
async function video() {
  const response = await fetch(`${base}/stream`, { signal: lifetime.signal });
  if (!response.ok || !response.body) throw new Error("Video unavailable");
  const reader = response.body.getReader();
  let buffer = Buffer.alloc(0),
    length = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) throw new Error("Video stopped");
      buffer = Buffer.concat([buffer, result.value]);
      while (true) {
        if (!length) {
          while (buffer.subarray(0, 2).toString() === "\r\n") buffer = buffer.subarray(2);
          const end = buffer.indexOf("\r\n\r\n");
          if (end < 0) break;
          length = Number(
            buffer
              .subarray(0, end)
              .toString()
              .match(/content-length:\s*(\d+)/i)?.[1],
          );
          if (!Number.isInteger(length) || length <= 0 || length > 32 * 1024 * 1024)
            throw new Error("Invalid MJPEG frame");
          buffer = buffer.subarray(end + 4);
        }
        if (buffer.length < length) break;
        const time = performance.now(),
          frame = buffer.subarray(0, length);
        buffer = buffer.subarray(length);
        length = 0;
        frames.push({ time, pixels: await sample(frame) });
        if (frames.length > 300) frames.shift();
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}
const difference = (a: Uint8Array, b: Uint8Array) =>
  a.reduce((sum, byte, i) => sum + Math.abs(byte - b[i]), 0) / a.length;
async function measure(kind: string, body: Record<string, unknown>) {
  const deadline = performance.now() + 6000;
  let quietSince = 0,
    previous = frames.at(-1);
  while (true) {
    if (videoFailure) throw videoFailure;
    if (performance.now() > deadline) throw new Error("Video never settled before sample");
    await wait(50);
    const latest = frames.at(-1);
    if (previous && latest && latest.time > previous.time) {
      quietSince =
        difference(previous.pixels, latest.pixels) < 0.7 ? quietSince || performance.now() : 0;
      if (quietSince && performance.now() - quietSince > 400) break;
    }
    previous = latest;
  }
  const before = frames.at(-1)!;
  const start = performance.now();
  assert(start - before.time < 500, "No fresh video frame");
  const result = await post("gesture", body),
    completed = performance.now();
  let visible: number | undefined;
  while (performance.now() - start < 4000) {
    if (videoFailure) throw videoFailure;
    visible = frames.find(
      (frame) => frame.time >= start && difference(before.pixels, frame.pixels) > 3,
    )?.time;
    if (visible !== undefined) break;
    await wait(10);
  }
  const round = (n: number) => Math.round(n * 10) / 10;
  const resultSample = {
    kind,
    httpMs: round(completed - start),
    firstChangedVideoFrameMs: visible === undefined ? null : round(visible - start),
    videoBaselineAgeMs: round(start - before.time),
    gestureDurationMs: body.end,
    timing: result.timing,
  };
  console.log(JSON.stringify(resultSample));
  return resultSample;
}
let videoTask: Promise<void> | undefined;
try {
  await post("keep-awake", { enabled: true, durationMs: 1800000 });
  await post("launch", { bundleId: fixture });
  await post("wait", {
    selector: { using: "accessibility id", value: "fixture.tap" },
    timeoutMs: 10000,
  });
  const state = (await post("state")).value;
  const { rect, hittable } = (
    await post("element", { selector: { using: "accessibility id", value: "fixture.tap" } })
  ).value;
  assert(hittable);
  const gesture = {
    points: [
      [
        (rect.x + rect.width / 2) / state.screen.width,
        (rect.y + rect.height / 2) / state.screen.height,
        0,
      ],
    ],
    end: 40,
    expectedApp: fixture,
    expectedOrientation: state.orientation,
  };
  videoTask = video().catch((error) => {
    videoFailure = error;
  });
  const deadline = performance.now() + 10000;
  while (!frames.length && !videoFailure && performance.now() < deadline) await wait(20);
  if (videoFailure || !frames.length) throw videoFailure ?? new Error("No frames");
  const samples: Awaited<ReturnType<typeof measure>>[] = [];
  for (let i = 0; i < 30; i++) samples.push(await measure("tap", gesture));
  const distribution = (values: number[]) => {
    values.sort((a, b) => a - b);
    return {
      median: values[Math.floor(values.length / 2)],
      p95: values[Math.ceil(values.length * 0.95) - 1],
    };
  };
  const visible = samples.flatMap((s) =>
    s.firstChangedVideoFrameMs === null ? [] : [s.firstChangedVideoFrameMs],
  );
  const report = {
    recordedAt: new Date().toISOString(),
    transport: process.argv[4] ?? "unknown",
    samples,
    summary: {
      count: samples.length,
      acknowledgementMs: distribution(samples.map((s) => s.httpMs)),
      visibleResponseMs: distribution(visible),
      allChangesObserved: visible.length === 30,
    },
    method:
      "Host monotonic API dispatch to acknowledgement and first changed MJPEG frame; controlled fixture color toggle, no mouse or panel timestamps. Same sampler and quality for both helpers.",
  };
  await Bun.write(output, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report.summary));
  assert(report.summary.allChangesObserved, "Every dispatched fixture tap must change a frame");
} finally {
  lifetime.abort();
  await videoTask;
  await worker.stdin.end();
  worker.kill();
  await worker.exited;
}
