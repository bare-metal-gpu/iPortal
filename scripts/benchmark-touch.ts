#!/usr/bin/env bun
// Opt-in real-phone benchmark; opens/navigates Settings but changes no settings.
// Usage: bun scripts/benchmark-touch.ts /absolute/path/report.json
import assert from "node:assert/strict";
import path from "node:path";
import { mkdir } from "node:fs/promises";

const output = process.argv[2];
if (!output) throw new Error("Provide an output report path");
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
  const response = await fetch(`http://127.0.0.1:7100/api/${name}`, {
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
  const response = await fetch("http://127.0.0.1:9100", { signal: lifetime.signal });
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
  assert(!(await post("state")).value.locked, "Unlock the phone first");
  await post("launch", { bundleId: "com.apple.Preferences" });
  const state = (await post("state")).value;
  assert.equal(state.orientation, "PORTRAIT");
  const selector = (value: string) => ({ using: "accessibility id", value });
  for (let i = 0; i < 6; i++) {
    const matches = (await post("elements", { selector: selector("BackButton") })).value;
    if (!matches.length) break;
    await post("tap", { id: matches[0].id, expectedApp: "com.apple.Preferences" });
  }
  videoTask = video().catch((error) => {
    videoFailure = error;
  });
  const ready = performance.now() + 10000;
  while (!frames.length && !videoFailure && performance.now() < ready) await wait(20);
  if (videoFailure || !frames.length) throw videoFailure ?? new Error("No video frames");
  for (const [value, start, end] of [
    ["com.apple.settings.primaryAppleAccount", 0.38, 0.72],
    ["com.apple.settings.displayAndBrightness", 0.72, 0.38],
  ] as const) {
    for (let i = 0; i < 6; i++) {
      const matches = (await post("elements", { selector: selector(value) })).value;
      if (
        matches.length &&
        (await post("element", { id: matches[0].id, attributes: ["hittable"] })).value.hittable
      )
        break;
      await post("gesture", {
        points: [
          [0.5, start, 0],
          [0.5, end, 180],
        ],
        end: 180,
        expectedApp: "com.apple.Preferences",
      });
      await wait(800);
    }
  }
  const samples: Awaited<ReturnType<typeof measure>>[] = [];
  for (let i = 0; i < 6; i++) {
    const target = selector(i % 2 === 0 ? "com.apple.settings.displayAndBrightness" : "BackButton");
    await post("wait", {
      selector: target,
      condition: "attribute",
      attribute: "hittable",
      equals: true,
      stableForMs: 100,
      timeoutMs: 5000,
    });
    const { rect, hittable } = (await post("element", { selector: target })).value;
    assert(hittable);
    samples.push(
      await measure("tap", {
        points: [
          [
            (rect.x + rect.width / 2) / state.screen.width,
            (rect.y + rect.height / 2) / state.screen.height,
            0,
          ],
        ],
        end: 60,
        expectedApp: "com.apple.Preferences",
        expectedOrientation: "PORTRAIT",
      }),
    );
    await post("wait", {
      selector: { using: "class name", value: "XCUIElementTypeNavigationBar" },
      timeoutMs: 5000,
    });
  }
  for (let i = 0; i < 4; i++)
    samples.push(
      await measure("swipe", {
        points: [
          [0.5, i % 2 ? 0.4 : 0.65, 0],
          [0.5, i % 2 ? 0.65 : 0.4, 150],
        ],
        end: 250,
        expectedApp: "com.apple.Preferences",
        expectedOrientation: "PORTRAIT",
      }),
    );
  const median = (values: number[]) => {
    values.sort((a, b) => a - b);
    const n = values.length;
    return n ? (values[Math.floor((n - 1) / 2)] + values[Math.floor(n / 2)]) / 2 : null;
  };
  const summary = Object.fromEntries(
    ["tap", "swipe"].map((kind) => {
      const group = samples.filter((s) => s.kind === kind);
      return [
        kind,
        {
          samples: group.length,
          medianHttpMs: median(group.map((s) => s.httpMs)),
          medianFirstChangedVideoFrameMs: median(
            group.flatMap((s) =>
              s.firstChangedVideoFrameMs === null ? [] : [s.firstChangedVideoFrameMs],
            ),
          ),
          allVisibleChangesDetected: group.every((s) => s.firstChangedVideoFrameMs !== null),
        },
      ];
    }),
  );
  await Bun.write(
    output,
    JSON.stringify(
      {
        recordedAt: new Date().toISOString(),
        samples,
        summary,
        method:
          "Host monotonic clock; API POST to changed central-region MJPEG frame (mean RGB difference >3). Native CoreGraphics sampling; includes video transport, excludes mouse recording. No display-panel timestamps. Sampling differs from historical Pillow reports.",
        settingsChanged: false,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(JSON.stringify(summary, null, 2));
} finally {
  lifetime.abort();
  await worker.stdin.end();
  worker.kill();
  await videoTask;
  await pixels.cancel().catch(() => {});
}
