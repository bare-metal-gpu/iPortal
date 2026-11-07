#!/bin/bash
# Embed the native status UI while preserving Apple's test runner.
set -euo pipefail
SOURCE="$(cd "$(dirname "$0")" && pwd)"
RUNNER="$1"
TEMP="$(mktemp -d)"
SUCCESS=0
ditto "$RUNNER" "$TEMP/backup.app"
cleanup() {
  if [ "$SUCCESS" != 1 ]; then
    rm -rf "$RUNNER"
    ditto "$TEMP/backup.app" "$RUNNER"
  fi
  rm -rf "$TEMP"
}
trap cleanup EXIT
SDK="${PLATFORM_NAME:-iphoneos}"
PRODUCTS="${IPORTAL_UI_PRODUCTS:-$SOURCE/../vendor/iportal-status-ui}"
FRAMEWORK="$RUNNER/Frameworks/iPortalUI.framework"
[ -d "$PRODUCTS/iPortalUI.framework" ] || { echo 'Build iPortalUI with scripts/build-iportal-ui.sh first'; exit 1; }
rm -rf "$FRAMEWORK"
ditto "$PRODUCTS/iPortalUI.framework" "$FRAMEWORK"
ditto "$PRODUCTS/Libraries.dev_BorderBeamKit.bundle" "$RUNNER/Libraries.dev_BorderBeamKit.bundle"
for NAME in iPortalLaunch; do
  xcrun --sdk "$SDK" ibtool --compile "$TEMP/$NAME.storyboardc" "$SOURCE/$NAME.storyboard" \
    --minimum-deployment-target "${IPHONEOS_DEPLOYMENT_TARGET:-17.0}" --target-device iphone --target-device ipad
  rm -rf "$RUNNER/$NAME.storyboardc"
  ditto "$TEMP/$NAME.storyboardc" "$RUNNER/$NAME.storyboardc"
done
# Compile our own icon catalog directly into Apple's generated host.
xcrun actool "$SOURCE/Assets.xcassets" --compile "$TEMP" --platform "$SDK" \
  --minimum-deployment-target 17.0 --target-device iphone --target-device ipad \
  --app-icon AppIcon --output-partial-info-plist "$TEMP/icon.plist" >/dev/null
for ASSET in "$TEMP/Assets.car" "$TEMP"/AppIcon*.png; do
  [ ! -f "$ASSET" ] || cp "$ASSET" "$RUNNER/"
done
BUN="${IPORTAL_BUN_PATH:-$(command -v bun)}"
VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "$RUNNER/PlugIns/iPortalRunner.xctest/Info.plist")"
"$BUN" "$SOURCE/configure-host.ts" "$RUNNER/Info.plist" "$TEMP/icon.plist" "$VERSION"
SIGN_INFO="$(codesign -dvv "$RUNNER" 2>&1)"
if [[ "$SIGN_INFO" == *'Signature=adhoc'* ]]; then
  IDENTITY='-'
else
  codesign -d --extract-certificates="$TEMP/cert" "$RUNNER" 2>/dev/null
  IDENTITY="$(shasum -a 1 "$TEMP/cert0" | awk '{print toupper($1)}')"
fi
HOST_NAME="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$RUNNER/Info.plist")"
"$BUN" "$SOURCE/link-host.ts" "$RUNNER/$HOST_NAME"
codesign --force --sign "$IDENTITY" "$FRAMEWORK"
codesign --force --sign "$IDENTITY" --preserve-metadata=identifier,entitlements "$RUNNER"
codesign --verify --strict "$RUNNER"
SUCCESS=1
echo 'Embedded iPortal status screen'
