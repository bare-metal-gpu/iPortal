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
  const discovery = join(directory, "discovery-recovery-tests");
  execFileSync(
    "xcrun",
    [
      "swiftc",
      "-swift-version",
      "5",
      "-warnings-as-errors",
      join(root, "native/DiscoveryRecovery.swift"),
      join(root, "test/DiscoveryRecoveryTests.swift"),
      "-o",
      discovery,
    ],
    { stdio: "pipe" },
  );
  execFileSync(discovery, [], { stdio: "inherit" });
  const binary = join(directory, "lifecycle-tests");
  execFileSync(
    "xcrun",
    [
      "swiftc",
      "-swift-version",
      "5",
      "-warnings-as-errors",
      join(root, "shared/DeviceCapabilities.swift"),
      join(root, "macos/Lifecycle.swift"),
      join(root, "test/LifecycleTests.swift"),
      "-o",
      binary,
    ],
    { stdio: "pipe" },
  );
  execFileSync(binary, [], { stdio: "inherit" });
  const usbMonitor = join(directory, "usb-monitor-tests");
  execFileSync(
    "xcrun",
    [
      "swiftc",
      "-swift-version",
      "5",
      "-warnings-as-errors",
      join(root, "shared/DeviceCapabilities.swift"),
      join(root, "macos/Lifecycle.swift"),
      join(root, "macos/USBMonitor.swift"),
      join(root, "test/USBMonitorTests.swift"),
      "-o",
      usbMonitor,
    ],
    { stdio: "pipe" },
  );
  execFileSync(usbMonitor, [join(root, "test/fixtures/paired-inventory.json")], {
    stdio: "inherit",
  });
  const permissions = join(directory, "permission-tests");
  execFileSync(
    "xcrun",
    [
      "swiftc",
      "-swift-version",
      "5",
      "-warnings-as-errors",
      join(root, "macos/Permissions.swift"),
      join(root, "test/PermissionTests.swift"),
      "-o",
      permissions,
    ],
    { stdio: "pipe" },
  );
  execFileSync(permissions, [], { stdio: "inherit" });
  const clipboard = join(directory, "clipboard-tests");
  execFileSync(
    "xcrun",
    [
      "swiftc",
      "-swift-version",
      "5",
      "-warnings-as-errors",
      join(root, "macos/Clipboard.swift"),
      join(root, "test/ClipboardTests.swift"),
      "-o",
      clipboard,
    ],
    { stdio: "pipe" },
  );
  execFileSync(clipboard, [], { stdio: "inherit" });
} finally {
  await rm(directory, { recursive: true, force: true });
}
