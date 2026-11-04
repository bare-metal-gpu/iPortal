import path from "node:path";
export const packagedBinary = process.env.IPORTAL_TEST_BINARY;
export const serverCommand = packagedBinary
  ? [packagedBinary]
  : [process.execPath, path.resolve(import.meta.dirname, "../iportal.mjs")];

// The packaged test deliberately excludes user-installed runtimes and runs
// outside the checkout. Sources and dependencies must come from the binary.
export function runtimeEnvironment(scratch) {
  return {
    ...process.env,
    IPORTAL_STATE_DIR: scratch,
    ...(packagedBinary ? { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" } : {}),
  };
}
