// Apple test-launch failures contain nested errors. Classify the most specific
// cause before the generic trust wrapper; that wrapper also means bad signing.
import { Schema } from "effect";

const InstalledApps = Schema.Struct({
  result: Schema.Struct({
    apps: Schema.Array(
      Schema.Struct({ bundleIdentifier: Schema.String, bundleVersion: Schema.String }),
    ),
  }),
});
const InstallationHint = Schema.Struct({
  identity: Schema.String,
  confirmedAt: Schema.Number,
});
// A hint only selects Xcode's no-install path. It never grants authentication
// or readiness; deletion/re-signing still gets one bounded repair on failure.
export function matchesInstallationHint(value: unknown, identity: string, now = Date.now()) {
  try {
    const hint = Schema.decodeUnknownSync(InstallationHint)(value);
    const age = now - hint.confirmedAt;
    return hint.identity === identity && Number.isFinite(age) && age >= 0 && age < 86_400_000;
  } catch {
    return false;
  }
}
export type StartupFailure = {
  kind: "locked" | "developer" | "setup" | "verification" | "artifacts" | "transient" | "timeout";
  message: string;
};
export function startupFailure(output: string, timeout = false): StartupFailure {
  if (/device is locked|DeviceLocked|Unlock .+ to Continue/i.test(output))
    return { kind: "locked", message: "Unlock your iPhone." };
  if (/Developer Mode is (disabled|not enabled)|enable Developer Mode/i.test(output))
    return {
      kind: "developer",
      message: "On your iPhone, turn on Developer Mode in Settings → Privacy & Security.",
    };
  if (
    /cannot be installed on this device|doesn't include the currently selected device|provisioning profile.+expired|code signature.+invalid/i.test(
      output,
    )
  )
    return { kind: "setup", message: "Finish setting up iPortal on your Mac." };
  if (/not trusted|explicitly trusted|invalid code signature|inadequate entitlements/i.test(output))
    return { kind: "verification", message: "Your iPhone couldn’t verify iPortal. Retrying…" };
  if (
    /failed to load.*test bundle|test bundle.*(?:not found|does not exist)|application.*(?:is not installed|was not found)/i.test(
      output,
    )
  )
    return { kind: "artifacts", message: "Couldn’t start iPortal on your iPhone. Retrying…" };
  return {
    kind: timeout ? "timeout" : "transient",
    message: "Couldn’t start iPortal on your iPhone. Retrying…",
  };
}

export function matchesInstalledHelper(value: unknown, bundle: string, version: string): boolean {
  const { result } = Schema.decodeUnknownSync(InstalledApps)(value);
  return result.apps.some(
    (app) => app.bundleIdentifier === bundle && app.bundleVersion === version,
  );
}

export function installedTestRun(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid test configuration");
  const config: Record<string, unknown> = structuredClone(value) as Record<string, unknown>;
  let targets = 0;
  for (const entry of Object.values(config)) {
    if (
      !entry ||
      typeof entry !== "object" ||
      !("IsUITestBundle" in entry) ||
      entry.IsUITestBundle !== true
    )
      continue;
    const target = entry as Record<string, unknown>;
    if (
      typeof target.TestHostBundleIdentifier !== "string" ||
      typeof target.TestBundlePath !== "string" ||
      !/^__TESTHOST__\/PlugIns\/[\w.-]+\.xctest$/.test(target.TestBundlePath)
    )
      throw new Error("Invalid test bundle paths");
    targets++;
    target.UseDestinationArtifacts = true;
    target.TestBundleDestinationRelativePath = target.TestBundlePath;
    // Required by Xcode even with UseUITargetAppProvidedByTests; our test owns
    // foreground selection and never launches a separate target application.
    target.UITargetAppBundleIdentifier = target.TestHostBundleIdentifier;
    delete target.TestBundlePath;
    delete target.TestHostPath;
    delete target.UITargetAppPath;
  }
  if (targets !== 1) throw new Error("Expected one helper test target");
  return config;
}
