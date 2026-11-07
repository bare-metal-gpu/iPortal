import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
/** @param {string} udid @param {string} connection */
async function readStartupLock(udid, connection) {
  const seconds = connection === "Paired" ? 12 : 5;
  const directory = await mkdtemp(join(tmpdir(), "iportal-lock-"));
  try {
    const output = join(directory, "state.json");
    await execute(
      "/usr/bin/xcrun",
      [
        "devicectl",
        "device",
        "info",
        "lockState",
        "--device",
        udid,
        "--timeout",
        String(seconds),
        "--json-output",
        output,
      ],
      { timeout: seconds * 1000 + 1500, maxBuffer: 64 * 1024 },
    );
    const value = JSON.parse(await readFile(output, "utf8"))?.result?.passcodeRequired;
    return typeof value === "boolean" ? value : null;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

// One bounded query per USB attachment, only while the helper is unavailable.
// Never delay status publication or reuse a result from an old connection.
export function createStartupLock({ read = readStartupLock, changed = () => {} } = {}) {
  /** @type {string | null} */
  let key = null;
  /** @type {boolean | null} */
  let value = null;
  let generation = 0,
    pending = false,
    queried = false;
  /** @typedef {{udid:string, id:number|string, connection?:string} | null} Device */
  /** @param {Device} device */
  const identity = (device) => (device ? `${device.udid}:${device.id}` : null);
  return {
    /** @param {Device} device */
    observe(device) {
      const next = identity(device);
      if (next !== key) {
        generation++;
        key = next;
        value = null;
        queried = false;
        pending = false;
      }
      if (!device || pending || queried) return;
      queried = pending = true;
      const request = generation;
      Promise.resolve()
        .then(() => read(device.udid, device.connection ?? "Unknown"))
        .then((result) => {
          if (generation !== request) return;
          value = typeof result === "boolean" ? result : null;
          if (value !== null) changed();
        })
        .catch(() => {})
        .finally(() => {
          if (generation === request) pending = false;
        });
    },
    /** @param {Device} device */
    value(device) {
      return identity(device) === key ? value : null;
    },
    reset() {
      generation++;
      key = null;
      value = null;
      queried = pending = false;
    },
  };
}
