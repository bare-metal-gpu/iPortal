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

// Bounded fallback only while the helper is unavailable. A one-shot query can
// leave an unlocked phone labelled Locked for the entire failed launch.
// Never delay publication or accept a result from an obsolete connection.
export function createStartupLock({
  read = readStartupLock,
  changed = () => {},
  now = Date.now,
  refreshMs = 3000,
} = {}) {
  /** @type {string | null} */
  let key = null;
  /** @type {boolean | null} */
  let value = null;
  let generation = 0,
    pending = false,
    queriedAt = -Infinity;
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
        queriedAt = -Infinity;
        pending = false;
      }
      if (!device || pending || now() - queriedAt < refreshMs) return;
      pending = true;
      queriedAt = now();
      const request = generation;
      Promise.resolve()
        .then(() => read(device.udid, device.connection ?? "Unknown"))
        .then((result) => {
          if (generation !== request) return;
          const previous = value;
          value = typeof result === "boolean" ? result : null;
          if (value !== previous) changed();
        })
        .catch(() => {
          if (generation !== request) return;
          const previous = value;
          value = null;
          if (previous !== null) changed();
        })
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
      queriedAt = -Infinity;
      pending = false;
    },
  };
}
