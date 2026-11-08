#!/usr/bin/env bun
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
  const presentation = capture.match(
    /\/\/ BEGIN TESTABLE PRESENTATION POLICY\n([\s\S]*?)\/\/ END TESTABLE PRESENTATION POLICY/,
  );
  assert(presentation, "presentation policy markers must exist");
  await writeFile(
    geometryHelper,
    `@preconcurrency import AVFoundation\nimport Cocoa\nimport CoreImage\n${executor}\n${presentation[1]}\n${store[1]}`,
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
  const main = await readFile(join(root, "macos/main.swift"), "utf8");
  const handles = main.match(
    /\/\/ BEGIN TESTABLE CORNER RESIZE\n([\s\S]*?)\/\/ END TESTABLE CORNER RESIZE/,
  );
  assert(handles, "corner resize test markers must exist");
  const handleHelper = join(temporary, "CornerResize.swift");
  const handleBinary = join(temporary, "corner-resize-tests");
  await writeFile(handleHelper, `import Cocoa\n${handles[1]}`);
  execFileSync(
    "xcrun",
    [
      "swiftc",
      "-swift-version",
      "5",
      "-warnings-as-errors",
      handleHelper,
      join(root, "shared/DeviceCapabilities.swift"),
      join(root, "macos/Lifecycle.swift"),
      join(root, "test/corner-resize.swift"),
      "-o",
      handleBinary,
    ],
    { stdio: "pipe" },
  );
  execFileSync(handleBinary, [], { stdio: "inherit" });
} finally {
  await rm(temporary, { recursive: true, force: true });
}
