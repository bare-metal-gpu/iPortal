import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { deviceBuild } from "./runtime-paths.mjs";

export function helperCommand(udid, buildDirectory = deviceBuild, resultParent = os.tmpdir()) {
  if (!udid || !/^[a-zA-Z0-9-]{8,64}$/.test(udid))
    throw new Error("A valid device identity is required");
  const products = path.join(buildDirectory, "Build/Products");
  const runs = fs
    .readdirSync(products)
    .filter((name) => name.includes("iphoneos") && name.endsWith(".xctestrun"));
  if (runs.length !== 1) throw new Error("Run setup again to build iPortal.");
  const results = fs.mkdtempSync(path.join(resultParent, "iportal-tests-"));
  return [
    "/usr/bin/xcodebuild",
    "test-without-building",
    "-xctestrun",
    path.join(products, runs[0]),
    "-destination",
    `id=${udid}`,
    "-resultBundlePath",
    path.join(results, "Run.xcresult"),
  ];
}
