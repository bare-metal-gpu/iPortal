#!/usr/bin/env bash
# Brand the test bundle and its generated host; setup configures the signing ID.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WDA="${1:-$ROOT/vendor/WebDriverAgent}"
cp "$ROOT/macos/icon.png" "$WDA/WebDriverAgentRunner/Assets.xcassets/AppIcon.appiconset/icon-1024.png"
PLIST="$WDA/WebDriverAgentRunner/Info.plist"
/usr/libexec/PlistBuddy -c 'Set :CFBundleName iPortal' "$PLIST"
/usr/libexec/PlistBuddy -c 'Delete :CFBundleDisplayName' "$PLIST" 2>/dev/null || true
/usr/libexec/PlistBuddy -c 'Add :CFBundleDisplayName string iPortal' "$PLIST"

# XCTRunner generates its own Info.plist. Set the visible name in the existing
# icon post-action, after its rollback backup and before its re-signing step.
node --input-type=module - "$WDA/Scripts/embed-runner-icon.sh" <<'JS'
import fs from 'node:fs';
const file = process.argv[2];
const source = fs.readFileSync(file, 'utf8').replaceAll('iPhone Portal', 'iPortal');
const marker = '# iPortal runner branding';
const anchor = '# Re-codesign since we modified the bundle after Xcode signed it.';
if (!source.includes(marker)) {
  if (!source.includes(anchor)) throw new Error('Unsupported WDA icon embed script; cannot apply runner branding');
  const branding = `${marker}
/usr/libexec/PlistBuddy -c "Delete :CFBundleDisplayName" "$PLIST" 2>/dev/null || true
/usr/libexec/PlistBuddy -c "Add :CFBundleDisplayName string iPortal" "$PLIST"
/usr/libexec/PlistBuddy -c "Set :CFBundleName iPortal" "$PLIST"

`;
  fs.writeFileSync(file, source.replace(anchor, branding + anchor));
} else { fs.writeFileSync(file, source); }
JS
node "$ROOT/scripts/install-iportal-status.mjs" "$WDA"
