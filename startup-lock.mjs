import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
export async function readStartupLock(udid) {
  const directory = await mkdtemp(join(tmpdir(), "iphone-portal-lock-"));
  try {
    const output = join(directory, "state.json");
    await execute("/usr/bin/xcrun", ["devicectl", "device", "info", "lockState", "--device", udid,
      "--timeout", "5", "--json-output", output], { timeout: 6500, maxBuffer: 64 * 1024 });
    const value = JSON.parse(await readFile(output, "utf8"))?.result?.passcodeRequired;
    return typeof value === "boolean" ? value : null;
  } finally { await rm(directory, { recursive: true, force: true }); }
}

// One bounded query per USB attachment, only while the helper is unavailable.
// Never delay status publication or reuse a result from an old connection.
export function createStartupLock({ read = readStartupLock, changed = () => {} } = {}) {
  let generation = 0, key = null, value = null, pending = false, queried = false;
  const identity = device => device ? `${device.udid}:${device.id}` : null;
  return {
    observe(device) {
      const next = identity(device);
      if (next !== key) { generation++; key = next; value = null; queried = false; pending = false; }
      if (!device || pending || queried) return;
      queried = pending = true;
      const request = generation;
      Promise.resolve().then(() => read(device.udid)).then(result => {
        if (generation !== request) return;
        value = typeof result === "boolean" ? result : null;
        if (value !== null) changed();
      }).catch(() => {}).finally(() => { if (generation === request) pending = false; });
    },
    value(device) { return identity(device) === key ? value : null; },
    reset() { generation++; key = null; value = null; queried = pending = false; },
  };
}
