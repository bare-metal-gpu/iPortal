import fs from "node:fs";
import path from "node:path";
import { helperProtocolVersion } from "./helper-protocol.ts";

/** @param {string} directory */
export function readHelperBuild(directory, required = false) {
  const file = path.join(directory, "helper-manifest.json");
  if (!fs.existsSync(file) && !required) return null;
  /** @type {unknown} */
  const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
  if (
    !manifest ||
    typeof manifest !== "object" ||
    !("protocol" in manifest) ||
    manifest.protocol !== helperProtocolVersion ||
    !("build" in manifest) ||
    typeof manifest.build !== "string" ||
    !/^[a-f0-9]{64}$/.test(manifest.build)
  )
    throw new Error("Run setup again to build the compatible iPortal helper.");
  return manifest.build;
}
