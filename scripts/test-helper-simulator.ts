// Reproducible native parity checks, isolated from physical devices and user apps.
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { openSync, closeSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";

const root = path.resolve(import.meta.dirname, "..");
const logs = await mkdtemp(path.join(tmpdir(), "iportal-simulator-"));
const build = path.join(root, "vendor/simulator-check-build");
const fixtureBuild = path.join(root, "vendor/simulator-fixture-check-build");
const bundle = "com.baremetalgpu.iportal.mobile";
const accessibilityAudit = process.argv.includes("--accessibility-audit");
const webNavigationOnly = process.argv.includes("--web-navigation-only");
assert(
  process.argv
    .slice(2)
    .every((arg) => ["--accessibility-audit", "--web-navigation-only"].includes(arg)),
  "Unknown simulator check option",
);
const token = randomBytes(32).toString("hex");
let simulator: string | undefined;
let runner: ReturnType<typeof Bun.spawn> | undefined;
let server: ReturnType<typeof Bun.spawn> | undefined;
const run = async (args: string[], label: string) => {
  const child = spawn(args, label);
  const code = await child.exited;
  if (code !== 0) {
    // Hosted runners discard this private temporary directory after the job.
    // Surface bounded diagnostics while keeping the ephemeral helper token out.
    const tail = await Bun.file(path.join(logs, `${label}.log`)).slice(-64 * 1024).text();
    console.error(tail.replaceAll(token, "[redacted]").split("\n").slice(-100).join("\n"));
  }
  assert.equal(code, 0, `${label} failed; see ${logs}`);
};
function spawn(
  args: string[],
  label: string,
  env: Record<string, string | undefined> = process.env,
) {
  const fd = openSync(path.join(logs, `${label}.log`), "w", 0o600);
  try {
    return Bun.spawn(args, { cwd: root, env, stdin: "ignore", stdout: fd, stderr: fd });
  } finally {
    closeSync(fd);
  }
}
async function output(args: string[]) {
  const child = Bun.spawn(args, { cwd: root, stdout: "pipe", stderr: "pipe" });
  const [text, error] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  assert.equal(await child.exited, 0, error);
  return text.trim();
}
async function stop(child: ReturnType<typeof Bun.spawn> | undefined) {
  if (!child) return;
  child.kill();
  const force = setTimeout(() => child.kill("SIGKILL"), 3000);
  try {
    await child.exited;
  } finally {
    clearTimeout(force);
  }
}
async function shutdownHelper() {
  try {
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    const state = (await (
      await fetch("http://127.0.0.1:8100/v1/status", { headers, signal: AbortSignal.timeout(1000) })
    ).json()) as { generation: string };
    await fetch("http://127.0.0.1:8100/v1/commands", {
      method: "POST",
      headers,
      signal: AbortSignal.timeout(1000),
      body: JSON.stringify({
        id: crypto.randomUUID(),
        generation: state.generation,
        budgetMs: 500,
        operation: "shutdown",
        arguments: {},
      }),
    });
  } catch {
    /* The owned helper may not have started or may already have exited. */
  }
}
try {
  // Do not take another simulator helper's port or interfere with its owner.
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 8100, fetch: () => new Response() });
  await probe.stop(true);
  const inventory = JSON.parse(await output(["xcrun", "simctl", "list", "runtimes", "--json"]));
  const runtimes = inventory.runtimes.filter(
    (r: { identifier: string; isAvailable: boolean }) =>
      r.isAvailable && r.identifier.includes(".iOS-"),
  );
  runtimes.sort((a: { version: string }, b: { version: string }) =>
    b.version.localeCompare(a.version, undefined, { numeric: true }),
  );
  assert(runtimes[0], "Install an iOS simulator runtime in Xcode first");
  simulator = await output([
    "xcrun",
    "simctl",
    "create",
    "iPortal parity checks",
    "com.apple.CoreSimulator.SimDeviceType.iPhone-15-Pro",
    runtimes[0].identifier,
  ]);
  await run(["xcrun", "simctl", "boot", simulator], "boot");
  await run(["xcrun", "simctl", "bootstatus", simulator, "-b"], "boot-ready");
  const identity = await output(["bun", "scripts/helper-build-id.ts"]);
  const version = `${(parseInt(identity.slice(0, 7), 16) % 9999) + 1}.${parseInt(identity.slice(7, 9), 16) % 100}.${parseInt(identity.slice(9, 11), 16) % 100}`;
  const project = [
    "xcodebuild",
    "-project",
    "ios/iPortalHelper.xcodeproj",
    "-destination",
    `id=${simulator}`,
    "CODE_SIGNING_ALLOWED=NO",
  ];
  console.log("Building owned helper and fixture…");
  await run(
    [
      ...project,
      "build-for-testing",
      "-scheme",
      "iPortalHelper",
      "-derivedDataPath",
      build,
      `IPORTAL_HELPER_BUILD_ID=${identity}`,
      `CURRENT_PROJECT_VERSION=${version}`,
    ],
    "build-helper",
  );
  await writeFile(
    path.join(build, "helper-manifest.json"),
    JSON.stringify({ protocol: 1, build: identity }),
  );
  await run(
    [...project, "build", "-scheme", "iPortalFixture", "-derivedDataPath", fixtureBuild],
    "build-fixture",
  );
  const products = path.join(build, "Build/Products");
  await run(
    [
      "plutil",
      "-replace",
      "CFBundleVersion",
      "-string",
      version,
      path.join(products, "Debug-iphonesimulator/iPortalRunner-Runner.app/Info.plist"),
    ],
    "version-host",
  );
  const fixtureApp = path.join(
    fixtureBuild,
    "Build/Products/Debug-iphonesimulator/iPortalFixture.app",
  );
  await run(
    [
      "xcrun",
      "simctl",
      "install",
      simulator,
      path.join(products, "Debug-iphonesimulator/iPortalRunner-Runner.app"),
    ],
    "install-helper",
  );
  await run(["xcrun", "simctl", "install", simulator, fixtureApp], "install-fixture");
  await run(["xcrun", "simctl", "launch", simulator, `${bundle}.fixture`], "launch-fixture");
  const runs = await Array.fromAsync(new Bun.Glob("*.xctestrun").scan(products));
  assert.equal(runs.length, 1);
  runner = spawn(
    [
      "xcodebuild",
      "test-without-building",
      "-xctestrun",
      path.join(products, runs[0]!),
      "-destination",
      `id=${simulator}`,
    ],
    "runner",
    {
      ...process.env,
      TEST_RUNNER_USE_IP: "127.0.0.1",
      TEST_RUNNER_IPORTAL_AUTOMATION: "1",
      TEST_RUNNER_IPORTAL_HELPER_TOKEN: token,
    },
  );
  const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = reservation.port;
  await reservation.stop(true);
  server = spawn(
    [
      "bun",
      "runtime-entry.ts",
      "--port",
      String(port),
      "--helper-url",
      "http://127.0.0.1:8100",
      "--no-autostart",
      "--no-open",
    ],
    "server",
    {
      ...process.env,
      IPORTAL_HELPER_TOKEN: token,
      IPORTAL_DEVICE_BUILD: build,
      IPORTAL_STATE_DIR: logs,
    },
  );
  if (!webNavigationOnly) {
    const tests = spawn(
      ["bun", "scripts/test-helper-fixture.ts", `${bundle}.fixture`],
      "fixture-checks",
      { ...process.env, IPORTAL_API_URL: `http://127.0.0.1:${port}`, IPORTAL_SIMULATOR: "1" },
    );
    const fixtureExit = await tests.exited;
    if (fixtureExit !== 0) {
      // Retain evidence before deleting this owned simulator. Never replay a
      // failed mutation merely to make a flaky interaction look successful.
      await run(
        ["xcrun", "simctl", "io", simulator, "screenshot", path.join(logs, "failure.png")],
        "failure-screenshot",
      );
      for (const name of ["state", "source"]) {
        try {
          const response = await fetch(`http://127.0.0.1:${port}/api/${name}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(name === "source" ? { format: "json" } : {}),
            signal: AbortSignal.timeout(16000),
          });
          await writeFile(path.join(logs, `failure-${name}.json`), await response.text());
        } catch {
          /* The first failure is still authoritative if diagnostics fail. */
        }
      }
    }
    assert.equal(fixtureExit, 0, `Fixture checks failed; see ${logs}`);
    console.log(await Bun.file(path.join(logs, "fixture-checks.log")).text());
  }
  // This newly created simulator has no user clipboard to preserve. Exercise
  // the animated helper's foreground handoff without reading another app's
  // pasteboard item or dismissing an Apple permission decision.
  const api = async (name: string, body: object = {}) => {
    const response = await fetch(`http://127.0.0.1:${port}/api/${name}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(25000),
    });
    const result = (await response.json()) as Record<string, any>;
    assert.equal(response.status, 200, `${name}: ${JSON.stringify(result)}`);
    assert.equal(result.ok, true);
    return result.value;
  };
  if (webNavigationOnly) {
    const readyDeadline = performance.now() + 45000;
    for (;;) {
      let ready = false;
      try {
        const status = (await fetch(`http://127.0.0.1:${port}/api/status`, {
          signal: AbortSignal.timeout(1500),
        }).then((response) => response.json())) as { ok: boolean; locked: boolean | null };
        ready = status.ok && status.locked === false;
      } catch {
        /* Allow the owned server/helper to start. */
      }
      if (ready) break;
      assert(performance.now() < readyDeadline, "Helper did not become ready");
      await Bun.sleep(100);
    }
    await api("launch", { bundleId: `${bundle}.fixture` });
    const foregroundDeadline = performance.now() + 10000;
    while ((await api("state")).app.bundleId !== `${bundle}.fixture`) {
      assert(performance.now() < foregroundDeadline, "Fixture did not become foreground");
      await Bun.sleep(100);
    }
  } else {
    const clipboard = {
      format: "text",
      content: Buffer.from("iPortal café 👋 世界").toString("base64"),
    };
    await api("clipboard-write", clipboard);
    assert.deepEqual(await api("clipboard-read"), clipboard);
    assert.equal((await api("state")).app.bundleId, `${bundle}.fixture`);
    console.log("PASS clipboard roundtrip and animated-helper foreground restoration");
  }
  // Reserved .invalid domain makes this a navigation/dispatch check without
  // contacting a real website. A fresh simulator has no user browser state.
  await api("open-url", {
    url: "https://example.invalid/iportal-fixture",
    expectedApp: `${bundle}.fixture`,
  });
  const navigationDeadline = performance.now() + 10000;
  while ((await api("state")).app.bundleId !== "com.apple.mobilesafari") {
    assert(performance.now() < navigationDeadline, "System web navigation did not activate Safari");
    await Bun.sleep(100);
  }
  await api("launch", { bundleId: `${bundle}.fixture` });
  const returnDeadline = performance.now() + 10000;
  while ((await api("state")).app.bundleId !== `${bundle}.fixture`) {
    assert(performance.now() < returnDeadline, "Fixture did not resume after web navigation");
    await Bun.sleep(100);
  }
  console.log("PASS system web navigation and explicit fixture restoration");
  if (accessibilityAudit) {
    // Give the audit exclusive XCTest ownership. Both runners target only this
    // newly created simulator, and the audit cannot enable its HTTP server.
    await shutdownHelper();
    await stop(server);
    server = undefined;
    await stop(runner);
    runner = undefined;
    const audit = spawn(
      [
        "xcodebuild",
        "test-without-building",
        "-xctestrun",
        path.join(products, runs[0]!),
        "-destination",
        `id=${simulator}`,
        "-only-testing:iPortalRunner/iPortalRunner/testFixtureAccessibility",
      ],
      "accessibility-audit",
      { ...process.env, TEST_RUNNER_IPORTAL_FIXTURE_AUDIT: "1" },
    );
    try {
      assert.equal(await audit.exited, 0, `Fixture audit failed; see ${logs}`);
    } finally {
      await stop(audit);
    }
    const report = await Bun.file(path.join(logs, "accessibility-audit.log")).text();
    const issues = report
      .split("\n")
      .find((line) => line.startsWith("IPORTAL_FIXTURE_ACCESSIBILITY "));
    assert(issues, "Audit did not produce an issues report");
    console.log(issues);
  }
  console.log(`Native simulator checks passed. Logs: ${logs}`);
} finally {
  await shutdownHelper();
  await stop(server);
  await stop(runner);
  if (simulator) {
    await run(["xcrun", "simctl", "shutdown", simulator], "shutdown-simulator");
    await run(["xcrun", "simctl", "delete", simulator], "delete-simulator");
  }
}
