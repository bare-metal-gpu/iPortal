import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

if (process.platform !== "darwin") {
  console.log("Native accessibility tests require macOS; skipped.");
  process.exit(0);
}
const root = fileURLToPath(new URL("../", import.meta.url));
const directory = await mkdtemp(join(tmpdir(), "iportal-accessibility-"));
try {
  const binary = join(directory, "accessibility-tests");
  execFileSync(
    "xcrun",
    [
      "swiftc",
      "-swift-version",
      "5",
      "-warnings-as-errors",
      join(root, "macos/AccessibilityBridge.swift"),
      join(root, "test/AccessibilityBridgeTests.swift"),
      "-o",
      binary,
    ],
    { stdio: "inherit", timeout: 60000 },
  );
  execFileSync(binary, [], { stdio: "inherit", timeout: 20000 });
} finally {
  await rm(directory, { recursive: true, force: true });
}
