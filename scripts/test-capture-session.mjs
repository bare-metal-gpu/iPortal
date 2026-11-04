#!/usr/bin/env node
// Compile the exact executor used by the app against deterministic virtual
// sessions. No camera permissions, connected phone, or installed app required.
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

if (process.platform !== "darwin") {
  console.log("Capture executor compile requires the macOS Swift toolchain; skipped.");
  process.exit(0);
}
const root = fileURLToPath(new URL("../", import.meta.url));
const capture = await readFile(join(root, "macos/Capture.swift"), "utf8");
const match = capture.match(
  /\/\/ BEGIN TESTABLE CAPTURE EXECUTOR\n([\s\S]*?)\/\/ END TESTABLE CAPTURE EXECUTOR/,
);
assert(match, "capture executor markers must exist");
const executor = match[1];
assert(executor.includes("CaptureSessionExecutor"));
const temporary = await mkdtemp(join(tmpdir(), "iportal-capture-"));
try {
  const helper = join(temporary, "CaptureSessionExecutor.swift");
  const binary = join(temporary, "capture-session-tests");
  await writeFile(helper, `import Foundation\n${executor}`);
  execFileSync(
    "xcrun",
    [
      "swiftc",
      "-swift-version",
      "5",
      "-warnings-as-errors",
      helper,
      join(root, "test/capture-session.swift"),
      "-o",
      binary,
    ],
    { stdio: "pipe" },
  );
  execFileSync(binary, [], { stdio: "inherit" });
  const store = capture.match(
    /\/\/ BEGIN TESTABLE FRAME STORE\n([\s\S]*?)\/\/ END TESTABLE FRAME STORE/,
  );
  assert(store, "frame-store markers must exist");
  const geometryHelper = join(temporary, "CaptureGeometry.swift");
  const geometryBinary = join(temporary, "capture-geometry-tests");
  await writeFile(
    geometryHelper,
    `@preconcurrency import AVFoundation\nimport Cocoa\nimport CoreImage\n${executor}\n${store[1]}`,
  );
  execFileSync(
    "xcrun",
    [
      "swiftc",
      "-swift-version",
      "5",
      "-warnings-as-errors",
      geometryHelper,
      join(root, "test/capture-geometry.swift"),
      "-o",
      geometryBinary,
    ],
    { stdio: "pipe" },
  );
  execFileSync(geometryBinary, [], { stdio: "inherit" });
} finally {
  await rm(temporary, { recursive: true, force: true });
}
