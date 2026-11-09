import fs from "node:fs";
import path from "node:path";
import { stateDirectory } from "./runtime-paths.mjs";

// Opt-in milestones share the native window's trace. Never include command
// arguments, input, credentials, or device content in these records.
export function startupTrace(
  event: string,
  fields: Record<string, string | number | boolean> = {},
) {
  if (!fs.existsSync(path.join(stateDirectory, "trace-reconnect"))) return;
  try {
    fs.appendFileSync(
      path.join(stateDirectory, "reconnect-trace.jsonl"),
      JSON.stringify({ event, ...fields, wallMs: Date.now(), pid: process.pid }) + "\n",
      { mode: 0o600 },
    );
  } catch {
    /* Diagnostics never affect startup. */
  }
}
