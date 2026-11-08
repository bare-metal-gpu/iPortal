import { Schema } from "effect";

const Inventory = Schema.Struct({
  runtimes: Schema.Array(
    Schema.Struct({
      identifier: Schema.String,
      version: Schema.String,
      isAvailable: Schema.Boolean,
      supportedDeviceTypes: Schema.optional(
        Schema.Array(
          Schema.Struct({
            identifier: Schema.String,
            name: Schema.String,
            productFamily: Schema.String,
          }),
        ),
      ),
    }),
  ),
});

// Device types must come from the selected runtime's compatibility list, not
// the global catalog: Xcode can retain models a newer runtime cannot boot.
export function selectSimulator(inventory: unknown, sdkVersion: string, runtimeVersion?: string) {
  if (!/^\d+(?:\.\d+){0,2}$/.test(sdkVersion)) throw new Error("Invalid simulator SDK version");
  if (runtimeVersion !== undefined && !/^\d+(?:\.\d+){0,2}$/.test(runtimeVersion))
    throw new Error("Invalid simulator runtime version");
  const compare = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });
  const release = (version: string) => {
    const [major, minor = "0"] = version.split(".");
    return `${major}.${minor}`;
  };
  const { runtimes } = Schema.decodeUnknownSync(Inventory)(inventory);
  const available = runtimes
    .filter(
      (runtime) =>
        runtime.isAvailable &&
        runtime.identifier.startsWith("com.apple.CoreSimulator.SimRuntime.iOS-") &&
        /^\d+(?:\.\d+){0,2}$/.test(runtime.version) &&
        (runtimeVersion === undefined || runtime.version === runtimeVersion) &&
        // A newer Xcode installation shares its runtimes with the selected
        // toolchain. Its presence does not make that runtime's XCTest protocol
        // compatible with an older SDK (for example 27.2 RC with Xcode 27.1).
        compare(release(runtime.version), release(sdkVersion)) <= 0 &&
        Number.parseInt(runtime.version, 10) >= 17,
    )
    .sort((a, b) => compare(b.version, a.version));
  for (const runtime of available) {
    const candidates = runtime.supportedDeviceTypes?.filter(
      (device) =>
        device.productFamily === "iPhone" &&
        // This fixture exercises one phone display. A newly added multi-display
        // model (for example iPhone Duo) must not silently change its target just
        // because Apple puts that model first in the compatibility list.
        /^com\.apple\.CoreSimulator\.SimDeviceType\.iPhone-(?:\d+e?|SE)(?:-|$)/.test(
          device.identifier,
        ),
    );
    // A hosted 7 GB Mac also runs the simulated OS. Prefer a compact/economy
    // display over Pro/Max rendering surfaces, within the same runtime.
    const cost = (identifier: string) =>
      /(?:-SE-|\de$|-mini$)/.test(identifier) ? 0 : /-Pro(?:-|$)|-Plus$/.test(identifier) ? 2 : 1;
    const device = candidates?.sort((a, b) => cost(a.identifier) - cost(b.identifier))[0];
    if (device) return { runtime, device };
  }
  throw new Error(
    `Install an available iOS ${runtimeVersion ?? "17+"} simulator runtime no newer than SDK ${sdkVersion} with a supported iPhone device type`,
  );
}

export function diagnosticTail(text: string, token: string, truncated: boolean) {
  // A byte-limited read can begin inside a credential. Drop that incomplete
  // line before redacting; never print even a fragment of the helper token.
  const complete = truncated ? text.slice(text.indexOf("\n") + 1) : text;
  if (truncated && !text.includes("\n")) return "";
  return complete.replaceAll(token, "[redacted]").split("\n").slice(-100).join("\n");
}
