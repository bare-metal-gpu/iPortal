import path from "node:path";
import os from "node:os";
import fs from "node:fs";

export const packaged = typeof IPORTAL_PACKAGED !== "undefined" && IPORTAL_PACKAGED;
export const sourceRoot = import.meta.dirname;
export const deviceBuild =
  process.env.IPORTAL_DEVICE_BUILD ??
  (packaged
    ? path.resolve(path.dirname(process.execPath), "../Resources/Device")
    : path.join(sourceRoot, "vendor/iportal-device-build"));
export const stateDirectory =
  process.env.IPORTAL_STATE_DIR ??
  (packaged
    ? path.join(os.homedir(), "Library/Application Support/iPortal")
    : path.join(sourceRoot, "vendor"));

export function statePath(name) {
  fs.mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
  return path.join(stateDirectory, name);
}

export function runtimeCommand(...args) {
  return [
    process.execPath,
    ...(packaged ? [] : [path.join(sourceRoot, "runtime-entry.ts")]),
    ...args,
  ];
}
