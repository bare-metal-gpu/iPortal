import { test, expect } from "bun:test";
import { installedTestRun, matchesInstalledHelper, startupFailure } from "../helper-startup.ts";
import { createHelperLifecycle } from "../helper-lifecycle.ts";

const config = {
  __xctestrun_metadata__: { FormatVersion: 1 },
  iPortalRunner: {
    IsUITestBundle: true,
    TestBundlePath: "__TESTHOST__/PlugIns/iPortalRunner.xctest",
    TestHostPath: "__TESTROOT__/Debug-iphoneos/iPortalRunner-Runner.app",
    TestHostBundleIdentifier: "test.iportal.runner",
    UseUITargetAppProvidedByTests: true,
    TestingEnvironmentVariables: { XCODE_SCHEME_NAME: "iPortalHelper" },
  },
};
test("matching installed helper uses Apple's no-install configuration without changing packaged artifacts", () => {
  const rewritten = installedTestRun(config) as typeof config & {
    iPortalRunner: Record<string, unknown>;
  };
  const target = rewritten.iPortalRunner;
  expect(target.UseDestinationArtifacts).toBe(true);
  expect(target.TestBundleDestinationRelativePath).toBe(config.iPortalRunner.TestBundlePath);
  expect(target.UITargetAppBundleIdentifier).toBe("test.iportal.runner");
  expect(target.UseUITargetAppProvidedByTests).toBe(true);
  expect(target.TestingEnvironmentVariables).toEqual(
    config.iPortalRunner.TestingEnvironmentVariables,
  );
  expect(target.TestHostPath).toBeUndefined();
  expect(target.TestBundlePath).toBeUndefined();
  expect(config.iPortalRunner.TestHostPath).toContain("__TESTROOT__");
  expect(() => installedTestRun({ ...config, duplicate: config.iPortalRunner })).toThrow();
  expect(() =>
    installedTestRun({ iPortalRunner: { ...config.iPortalRunner, TestBundlePath: "/unrelated" } }),
  ).toThrow();
});
test("missing or upgraded helpers install; unreachable/malformed inventory cannot trigger reinstall", () => {
  const app = { bundleIdentifier: "test.iportal.runner", bundleVersion: "1.2.3" };
  expect(
    matchesInstalledHelper({ result: { apps: [app] } }, app.bundleIdentifier, app.bundleVersion),
  ).toBe(true);
  expect(
    matchesInstalledHelper({ result: { apps: [app] } }, "another-device-app", app.bundleVersion),
  ).toBe(false);
  expect(matchesInstalledHelper({ result: { apps: [app] } }, app.bundleIdentifier, "2.0.0")).toBe(
    false,
  );
  expect(
    matchesInstalledHelper({ result: { apps: [] } }, app.bundleIdentifier, app.bundleVersion),
  ).toBe(false);
  expect(() => matchesInstalledHelper({}, app.bundleIdentifier, app.bundleVersion)).toThrow();
  expect(() =>
    matchesInstalledHelper({ result: { apps: [null] } }, app.bundleIdentifier, app.bundleVersion),
  ).toThrow();
});
test("generic Apple security wrappers never claim that user trust is missing", () => {
  const appleError =
    "The application could not be launched because the Developer App Certificate is not trusted. Underlying Error: invalid code signature, inadequate entitlements or its profile has not been explicitly trusted by the user";
  expect(startupFailure(appleError).kind).toBe("verification");
  expect(startupFailure(appleError).message).not.toMatch(/VPN|Trust|Settings/);
  expect(startupFailure(appleError + " device is locked").kind).toBe("locked");
  expect(startupFailure("Developer Mode is disabled").kind).toBe("developer");
  expect(startupFailure("provisioning profile has expired").kind).toBe("setup");
  expect(startupFailure("", true).kind).toBe("timeout");
});
test("startup has bounded preparation and launch deadlines; authenticated ready cancels deadline", () => {
  let now = 0;
  const lifecycle = createHelperLifecycle("one", () => now);
  const ticket = lifecycle.begin();
  now = 10001;
  expect(lifecycle.timedOut(ticket)).toBe(true);
  lifecycle.launched(ticket, false);
  now += 19999;
  expect(lifecycle.timedOut(ticket)).toBe(false);
  now += 2;
  expect(lifecycle.timedOut(ticket)).toBe(true);
  lifecycle.observe({ generation: "boot", phase: "ready", automationReady: true, locked: false });
  now += 60000;
  expect(lifecycle.timedOut(ticket)).toBe(false);
  const replacement = lifecycle.begin();
  lifecycle.launched(replacement, true);
  now += 20001;
  expect(lifecycle.timedOut(replacement)).toBe(false);
  now += 40000;
  expect(lifecycle.timedOut(replacement)).toBe(true);
});
test("retry preserves its cause, backs off repeated failures and ignores obsolete exits", () => {
  let now = 0;
  const lifecycle = createHelperLifecycle("one", () => now);
  const error = startupFailure("invalid code signature or profile not trusted");
  const first = lifecycle.begin();
  expect(lifecycle.failed(first, error)).toBe(true);
  expect(lifecycle.canLaunch).toBe(false);
  expect(lifecycle.begin()).toBeNull();
  now += 1000;
  const second = lifecycle.begin();
  expect(lifecycle.problem).toEqual(error);
  expect(lifecycle.failed(first, startupFailure("device is locked"))).toBe(false);
  expect(lifecycle.problem).toEqual(error);
  lifecycle.failed(second, error);
  now += 1000;
  lifecycle.failed(lifecycle.begin(), error);
  now += 1000;
  expect(lifecycle.canLaunch).toBe(false);
  now += 30000;
  expect(lifecycle.canLaunch).toBe(true);
  lifecycle.observe({ generation: "boot", phase: "ready", automationReady: true, locked: false });
  expect(lifecycle.problem).toBeNull();
});
test("an observed unlock releases a lock failure without granting input readiness", () => {
  const lifecycle = createHelperLifecycle("one");
  lifecycle.failed(lifecycle.begin(), startupFailure("device is locked"));
  expect(lifecycle.canLaunch).toBe(false);
  lifecycle.lockObserved(false);
  expect(lifecycle.canLaunch).toBe(true);
  expect(lifecycle.problem).toBeNull();
  expect(lifecycle.state.phase).toBe("stopped");
});

test("a live launcher cannot hold Connecting forever after losing readiness; handover cancels recovery", () => {
  let now = 0;
  const lifecycle = createHelperLifecycle("one", () => now);
  const ticket = lifecycle.begin();
  const ready = {
    generation: "boot",
    phase: "ready" as const,
    automationReady: true,
    locked: false,
  };
  lifecycle.observe(ready);
  lifecycle.unavailable();
  now = 7000;
  expect(lifecycle.timedOut(ticket)).toBe(false);
  lifecycle.observe(ready);
  now = 25000;
  expect(lifecycle.timedOut(ticket)).toBe(false);
  lifecycle.unavailable();
  now += 10000;
  lifecycle.unavailable();
  now += 10001;
  expect(lifecycle.timedOut(ticket)).toBe(true);
});

test("losing lock evidence removes the unlock instruction without cancelling backoff", () => {
  const lifecycle = createHelperLifecycle("one");
  lifecycle.failed(lifecycle.begin(), startupFailure("device is locked"));
  lifecycle.lockObserved(null);
  expect(lifecycle.problem).toBeNull();
  expect(lifecycle.canLaunch).toBe(false);
});
