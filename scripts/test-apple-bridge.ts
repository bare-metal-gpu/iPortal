// Isolated experimental app: never rebuild, install, or replace iPortal here.
// Defaults to an unsigned device+simulator build. --simulator uses only a fresh
// disposable simulator and public input probes. Physical/raw probes stay manual.
import assert from "node:assert/strict";
import { mkdtemp, open, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const mode = process.argv.slice(2);
assert(
  mode.length === 0 || (mode.length === 1 && mode[0] === "--simulator"),
  "Use no arguments or --simulator",
);
const logs = await mkdtemp(path.join(tmpdir(), "iportal-bridge-probe-"));
const project = path.join(root, "experiments/apple-bridge/BridgeProbe.xcodeproj");
const build = path.join(root, "vendor/apple-bridge-probe");
let simulator: string | undefined;
let creatingSimulatorName: string | undefined;
const children = new Set<ReturnType<typeof Bun.spawn>>();
let stopping = false;

async function run(args: string[], label: string, capture = false) {
  assert(!stopping, "Probe interrupted");
  const log = await open(path.join(logs, `${label}.log`), "w", 0o600);
  if (stopping) {
    await log.close();
    throw new Error("Probe interrupted");
  }
  const child = Bun.spawn(args, {
    cwd: root,
    // Raw private-API probes are deliberately absent from automated runs.
    env: { ...process.env, IPORTAL_RAW_INPUT_PROBE: "0", TEST_RUNNER_IPORTAL_RAW_INPUT_PROBE: "0" },
    stdin: "ignore",
    stdout: log.fd,
    stderr: log.fd,
  });
  children.add(child);
  await log.close();
  const timeout = setTimeout(() => child.kill("SIGTERM"), 300000);
  const force = setTimeout(() => child.kill("SIGKILL"), 305000);
  try {
    const code = await child.exited;
    assert.equal(code, 0, `${label} failed (${code}); see ${logs}`);
    return capture ? (await readFile(path.join(logs, `${label}.log`), "utf8")).trim() : "";
  } finally {
    clearTimeout(timeout);
    clearTimeout(force);
    children.delete(child);
  }
}
async function cleanup() {
  await Promise.all(
    [...children].map(async (child) => {
      child.kill("SIGTERM");
      const deadline = setTimeout(() => child.kill("SIGKILL"), 3000);
      try {
        await child.exited;
      } finally {
        clearTimeout(deadline);
      }
    }),
  );
  // A create process can be interrupted after CoreSimulator commits the
  // device but before its UUID is returned. Resolve only our unique run name.
  if (!simulator && creatingSimulatorName) {
    const inventory = Bun.spawn(["xcrun", "simctl", "list", "devices", "--json"], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    });
    const text = await new Response(inventory.stdout).text();
    if ((await inventory.exited) === 0) {
      const devices: { devices: Record<string, { name: string; udid: string }[]> } =
        JSON.parse(text);
      const owned = Object.values(devices.devices)
        .flat()
        .find((device) => device.name === creatingSimulatorName);
      if (owned && /^[0-9A-F-]{36}$/i.test(owned.udid)) simulator = owned.udid;
    }
  }
  creatingSimulatorName = undefined;
  if (simulator) {
    const id = simulator;
    simulator = undefined;
    const removal = Bun.spawn(["xcrun", "simctl", "delete", id], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    await removal.exited;
  }
}
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    process.exitCode = 130;
    // Let the main flow collect a just-created simulator's identity and enter
    // its single finally block before deletion. Concurrent cleanup could miss it.
    for (const child of children) {
      child.kill("SIGTERM");
      const force = setTimeout(() => child.kill("SIGKILL"), 3000);
      void child.exited.finally(() => clearTimeout(force));
    }
  });
}
try {
  for (const platform of ["iOS", "iOS Simulator"]) {
    await run(
      [
        "xcodebuild",
        "build-for-testing",
        "-project",
        project,
        "-scheme",
        "BridgeProbe",
        "-destination",
        `generic/platform=${platform}`,
        "-derivedDataPath",
        `${build}-${platform === "iOS" ? "device" : "simulator"}`,
        "CODE_SIGNING_ALLOWED=NO",
      ],
      platform === "iOS" ? "build-device" : "build-simulator",
    );
  }
  console.log(`Bridge probe: iOS17-targeted device and simulator builds pass. Logs: ${logs}`);
  if (mode[0] === "--simulator") {
    const inventory: { runtimes: { identifier: string; version: string; isAvailable: boolean }[] } =
      JSON.parse(await run(["xcrun", "simctl", "list", "runtimes", "--json"], "runtimes", true));
    const runtimes = inventory.runtimes
      .filter((r) => r.isAvailable && r.identifier.includes(".iOS-"))
      .sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }));
    assert(runtimes[0], "Install an iOS simulator runtime first");
    for (const [family, deviceType] of [
      ["iphone", "com.apple.CoreSimulator.SimDeviceType.iPhone-15-Pro"],
      ["ipad", "com.apple.CoreSimulator.SimDeviceType.iPad-Pro-13-inch-M4-8GB"],
    ] as const) {
      creatingSimulatorName = `${path.basename(logs)}-${family}`;
      simulator = await run(
        ["xcrun", "simctl", "create", creatingSimulatorName, deviceType, runtimes[0].identifier],
        `${family}-create`,
        true,
      );
      assert(/^[0-9A-F-]{36}$/i.test(simulator), "Unexpected simulator identity");
      creatingSimulatorName = undefined;
      await run(["xcrun", "simctl", "boot", simulator], `${family}-boot`);
      await run(["xcrun", "simctl", "bootstatus", simulator, "-b"], `${family}-boot-ready`);
      await run(
        [
          "xcodebuild",
          "test-without-building",
          "-parallel-testing-enabled",
          "NO",
          "-project",
          project,
          "-scheme",
          "BridgeProbe",
          "-destination",
          `id=${simulator}`,
          "-derivedDataPath",
          `${build}-simulator`,
          "-resultBundlePath",
          path.join(logs, `${family}-input.xcresult`),
          "CODE_SIGNING_ALLOWED=NO",
        ],
        `${family}-input-probes`,
      );
      await cleanup();
    }
    console.log(
      "Public input probes completed; inspect observed-event attachments. Acknowledgement alone does not prove delivery.",
    );
  }
} finally {
  await cleanup();
}
