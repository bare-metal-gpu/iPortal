import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

// Product identity is computed from maintained sources, never Git status,
// absolute paths, signing teams, device identifiers, or build timestamps.
const root = path.resolve(import.meta.dirname, "..");
const files = (await readdir(path.join(root, "ios/Helper")))
  .filter((name) => /\.(swift|m|h)$/.test(name) && name !== "Package.swift")
  .map((name) => `ios/Helper/${name}`);
files.push(
  "ios/iPortalHelper.xcodeproj/project.pbxproj",
  "ios/Helper/Info.plist",
  "ios/configure-host.ts",
  "ios/embed.sh",
  "ios/link-host.ts",
  "ios/iPortalHelper.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved",
  "ios/iPortalUI.swift",
  "ios/iPortalUI.m",
  "ios/iPortalUI.xcodeproj/project.pbxproj",
  "shared/Appearance.swift",
  "shared/ConnectionAppearance.swift",
  "ios/Assets.xcassets/AppIcon.appiconset/icon.png",
);
const digest = createHash("sha256");
for (const file of files.sort()) {
  digest.update(file);
  digest.update("\0");
  digest.update(await readFile(path.join(root, file)));
}
console.log(digest.digest("hex"));
