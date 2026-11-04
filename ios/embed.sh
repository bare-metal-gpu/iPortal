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
FRAMEWORK="$RUNNER/Frameworks/iPortalUI.framework"
[ -d "$SOURCE/iPortalUI.framework" ] || { echo 'Build iPortalUI with scripts/build-iportal-ui.sh first'; exit 1; }
rm -rf "$FRAMEWORK"
ditto "$SOURCE/iPortalUI.framework" "$FRAMEWORK"
ditto "$SOURCE/Libraries.dev_BorderBeamKit.bundle" "$RUNNER/Libraries.dev_BorderBeamKit.bundle"
for NAME in iPortalLaunch; do
  xcrun --sdk "$SDK" ibtool --compile "$TEMP/$NAME.storyboardc" "$SOURCE/$NAME.storyboard" \
    --minimum-deployment-target "${IPHONEOS_DEPLOYMENT_TARGET:-15.0}" --target-device iphone --target-device ipad
  rm -rf "$RUNNER/$NAME.storyboardc"
  ditto "$TEMP/$NAME.storyboardc" "$RUNNER/$NAME.storyboardc"
done
BUN="${IPORTAL_BUN_PATH:-$(command -v bun)}"
"$BUN" "$SOURCE/configure-host.ts" "$RUNNER/Info.plist"
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
