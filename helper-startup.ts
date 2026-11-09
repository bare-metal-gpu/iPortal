// Apple test-launch failures contain nested errors. Classify the most specific
// cause before the generic trust wrapper; that wrapper also means bad signing.
export type StartupFailure = {
  kind: "locked" | "developer" | "setup" | "verification" | "transient" | "timeout";
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
  return {
    kind: timeout ? "timeout" : "transient",
    message: "Couldn’t start iPortal on your iPhone. Retrying…",
  };
}

export function matchesInstalledHelper(value: unknown, bundle: string, version: string): boolean {
  if (!value || typeof value !== "object" || !("result" in value))
    throw new Error("Invalid app inventory");
  const result = value.result;
  if (!result || typeof result !== "object" || !("apps" in result) || !Array.isArray(result.apps))
    throw new Error("Invalid app inventory");
  return result.apps.some(
    (app: unknown) =>
      !!app &&
      typeof app === "object" &&
      "bundleIdentifier" in app &&
      app.bundleIdentifier === bundle &&
      "bundleVersion" in app &&
      app.bundleVersion === version,
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
