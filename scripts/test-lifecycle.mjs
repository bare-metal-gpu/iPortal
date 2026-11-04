import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

if (process.platform !== "darwin") {
  console.log("Native lifecycle compile requires the macOS Swift toolchain; skipped.");
  process.exit(0);
}
const root = fileURLToPath(new URL("../", import.meta.url));
const directory = await mkdtemp(join(tmpdir(), "iportal-lifecycle-"));
try {
  const binary = join(directory, "lifecycle-tests");
  execFileSync(
    "xcrun",
    [
      "swiftc",
      "-swift-version",
      "5",
      "-warnings-as-errors",
      join(root, "macos/Lifecycle.swift"),
      join(root, "test/LifecycleTests.swift"),
      "-o",
      binary,
    ],
    { stdio: "pipe" },
  );
  execFileSync(binary, [], { stdio: "inherit" });
} finally {
  await rm(directory, { recursive: true, force: true });
}
