import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const wda = process.argv[2] ?? path.join(root, "vendor/WebDriverAgent");
const destination = path.join(wda, "iPortalUI");
const commands = path.join(wda, "WebDriverAgentLib/Commands/FBTouchActionCommands.m");
const embed = path.join(wda, "Scripts/embed-runner-icon.sh");
let source = fs.readFileSync(commands, "utf8");
let script = fs.readFileSync(embed, "utf8");
const marker = "# iPortal status screen";
// Upgrade the previous branded checkout without loading both status frameworks.
source = source.replaceAll('#import "FBPortalStatus.h"', '#import "FBIPortalStatus.h"');
script = script
  .replaceAll("# iPhone Portal status screen", marker)
  .replaceAll("/../PortalUI/embed.sh", "/../iPortalUI/embed.sh");
if (
  !source.includes("@implementation FBTouchActionCommands") ||
  !script.includes('echo "embedded icon into $RUNNER_APP"')
)
  throw new Error("Unsupported WDA source; cannot install iPortal status screen");
fs.mkdirSync(destination, { recursive: true });
for (const file of ["iPortalLaunch.storyboard", "iPortalUI.m", "link-host.py", "embed.sh"])
  fs.copyFileSync(path.join(root, "ios", file), path.join(destination, file));
fs.copyFileSync(
  path.join(root, "ios/FBIPortalStatus.h"),
  path.join(path.dirname(commands), "FBIPortalStatus.h"),
);
if (!source.includes('#import "FBIPortalStatus.h"')) {
  source = source.replace(
    "@implementation FBTouchActionCommands",
    '#import "FBIPortalStatus.h"\n\n@implementation FBTouchActionCommands',
  );
}
fs.copyFileSync(
  path.join(root, "ios/FBIPortalClipboard.h"),
  path.join(path.dirname(commands), "FBIPortalClipboard.h"),
);
if (!source.includes('#import "FBIPortalClipboard.h"')) {
  source = source.replace(
    "@implementation FBTouchActionCommands",
    '#import "FBIPortalClipboard.h"\n\n@implementation FBTouchActionCommands',
  );
}
fs.copyFileSync(
  path.join(root, "ios/FBIPortalText.h"),
  path.join(path.dirname(commands), "FBIPortalText.h"),
);
if (!source.includes('#import "FBIPortalText.h"'))
  source = source.replace(
    "@implementation FBTouchActionCommands",
    '#import "FBIPortalText.h"\n\n@implementation FBTouchActionCommands',
  );
fs.writeFileSync(commands, source);
if (!script.includes(marker)) {
  script += `\n${marker}\nbash "$(dirname "$0")/../iPortalUI/embed.sh" "$RUNNER_APP"\n`;
}
fs.writeFileSync(embed, script);
