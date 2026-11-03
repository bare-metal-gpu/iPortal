import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const wda = process.argv[2] ?? path.join(root, 'vendor/WebDriverAgent');
const destination = path.join(wda, 'PortalUI');
const commands = path.join(wda, 'WebDriverAgentLib/Commands/FBTouchActionCommands.m');
const embed = path.join(wda, 'Scripts/embed-runner-icon.sh');
let source = fs.readFileSync(commands, 'utf8');
let script = fs.readFileSync(embed, 'utf8');
const marker = '# iPhone Portal status screen';
if (!source.includes('@implementation FBTouchActionCommands') || !script.includes('echo "embedded icon into $RUNNER_APP"'))
  throw new Error('Unsupported WDA source; cannot install Portal status screen');
fs.mkdirSync(destination, { recursive: true });
for (const file of ['PortalLaunch.storyboard', 'PortalUI.m', 'link-host.py', 'embed.sh']) fs.copyFileSync(path.join(root, 'ios', file), path.join(destination, file));
fs.copyFileSync(path.join(root, 'ios/FBPortalStatus.h'), path.join(path.dirname(commands), 'FBPortalStatus.h'));
if (!source.includes('#import "FBPortalStatus.h"')) {
  source = source.replace('@implementation FBTouchActionCommands', '#import "FBPortalStatus.h"\n\n@implementation FBTouchActionCommands');
  fs.writeFileSync(commands, source);
}
if (!script.includes(marker)) {
  script += `\n${marker}\nbash "$(dirname "$0")/../PortalUI/embed.sh" "$RUNNER_APP"\n`;
  fs.writeFileSync(embed, script);
}
