import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readHelperBuild } from "./helper-build.mjs";
import { deviceBuild } from "./runtime-paths.mjs";
import { installedTestRun, matchesInstalledHelper } from "./helper-startup.ts";

const execute = promisify(execFile);
/** @param {string | undefined} udid */
export function helperCommand(udid, buildDirectory = deviceBuild, resultParent = os.tmpdir()) {
  if (!udid || !/^[a-zA-Z0-9-]{8,64}$/.test(udid))
    throw new Error("A valid device identity is required");
  readHelperBuild(buildDirectory, true);
  const products = path.join(buildDirectory, "Build/Products");
  const runs = fs
    .readdirSync(products)
    .filter((name) => name.includes("iphoneos") && name.endsWith(".xctestrun"));
  if (runs.length !== 1) throw new Error("Run setup again to build iPortal.");
  const results = fs.mkdtempSync(path.join(resultParent, "iportal-tests-"));
  return [
    "/usr/bin/xcodebuild",
    "test-without-building",
    "-xctestrun",
    path.join(products, runs[0]),
    "-destination",
    `id=${udid}`,
    "-destination-timeout",
    "15",
    "-collect-test-diagnostics",
    "never",
    "-resultBundlePath",
    path.join(results, "Run.xcresult"),
  ];
}

/** @param {string} file @param {AbortSignal} signal @returns {Promise<unknown>} */
async function readPlist(file, signal) {
  const result = await execute("/usr/bin/plutil", ["-convert", "json", "-o", "-", file], {
    signal,
    timeout: 2000,
    maxBuffer: 1024 * 1024,
  });
  return JSON.parse(result.stdout);
}

// Xcode otherwise reinstalls even an identical runner on every Play/recovery.
// Use its documented destination-artifact mode only for a matching installed
// bundle. Full authenticated build/protocol validation still happens on connect.
/** @param {string} udid @param {{signal:AbortSignal, forceInstall?:boolean, buildDirectory?:string}} options */
export async function prepareHelperCommand(
  udid,
  { signal, forceInstall = false, buildDirectory = deviceBuild },
) {
  const command = helperCommand(udid, buildDirectory);
  const results = path.dirname(command[command.indexOf("-resultBundlePath") + 1]);
  try {
    const runner = path.join(
      buildDirectory,
      "Build/Products/Debug-iphoneos/iPortalRunner-Runner.app/Info.plist",
    );
    const bundle = await readPlist(runner, signal);
    if (
      !bundle ||
      typeof bundle !== "object" ||
      !("CFBundleIdentifier" in bundle) ||
      typeof bundle.CFBundleIdentifier !== "string" ||
      !("CFBundleVersion" in bundle) ||
      typeof bundle.CFBundleVersion !== "string"
    )
      throw new Error("Invalid helper bundle");
    if (forceInstall) return { command, mode: /** @type {const} */ ("install") };
    const output = path.join(results, "installed.json");
    // --filter works on the older Xcode releases supported by our USB path.
    // A failed inventory is unknown, not evidence that reinstalling is needed.
    await execute(
      "/usr/bin/xcrun",
      [
        "devicectl",
        "device",
        "info",
        "apps",
        "--device",
        udid,
        "--filter",
        `bundleIdentifier == '${bundle.CFBundleIdentifier}'`,
        "--timeout",
        "5",
        "--json-output",
        output,
      ],
      { signal, timeout: 6500, maxBuffer: 64 * 1024 },
    );
    const installed = JSON.parse(fs.readFileSync(output, "utf8"));
    fs.rmSync(output);
    if (!matchesInstalledHelper(installed, bundle.CFBundleIdentifier, bundle.CFBundleVersion))
      return { command, mode: /** @type {const} */ ("install") };
    const index = command.indexOf("-xctestrun") + 1;
    const configuration = installedTestRun(await readPlist(command[index], signal));
    const run = path.join(results, "Installed.xctestrun");
    fs.writeFileSync(run, JSON.stringify(configuration), { mode: 0o600 });
    await execute("/usr/bin/plutil", ["-convert", "xml1", run], { signal, timeout: 2000 });
    command[index] = run;
    return { command, mode: /** @type {const} */ ("installed") };
  } catch (error) {
    fs.rmSync(results, { recursive: true, force: true });
    throw error;
  }
}
