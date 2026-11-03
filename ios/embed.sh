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
FRAMEWORK="$RUNNER/Frameworks/PortalUI.framework"
[ -d "$SOURCE/PortalUI.framework" ] || { echo 'Build PortalUI with scripts/build-portal-ui.sh first'; exit 1; }
rm -rf "$FRAMEWORK"
ditto "$SOURCE/PortalUI.framework" "$FRAMEWORK"
ditto "$SOURCE/Libraries.dev_BorderBeamKit.bundle" "$RUNNER/Libraries.dev_BorderBeamKit.bundle"
for NAME in PortalLaunch; do
  xcrun --sdk "$SDK" ibtool --compile "$TEMP/$NAME.storyboardc" "$SOURCE/$NAME.storyboard" \
    --minimum-deployment-target "${IPHONEOS_DEPLOYMENT_TARGET:-15.0}" --target-device iphone --target-device ipad
  rm -rf "$RUNNER/$NAME.storyboardc"
  ditto "$TEMP/$NAME.storyboardc" "$RUNNER/$NAME.storyboardc"
done
python3 - "$RUNNER/Info.plist" <<'PY'
import plistlib, sys
path = sys.argv[1]
with open(path, 'rb') as f: info = plistlib.load(f)
info['UILaunchStoryboardName'] = 'PortalLaunch'
# Preserve the runner's delegates. PortalUI fills its empty window on launch.
configs = info.setdefault('UIApplicationSceneManifest', {}).setdefault('UISceneConfigurations', {})
configs['UIWindowSceneSessionRoleApplication'] = [{
    'UISceneConfigurationName': 'Default Configuration',
    'UISceneDelegateClassName': '_XCTRunnerAppDelegate',
}]
with open(path, 'wb') as f: plistlib.dump(info, f)
PY
SIGN_INFO="$(codesign -dvv "$RUNNER" 2>&1)"
if [[ "$SIGN_INFO" == *'Signature=adhoc'* ]]; then
  IDENTITY='-'
else
  codesign -d --extract-certificates="$TEMP/cert" "$RUNNER" 2>/dev/null
  IDENTITY="$(shasum -a 1 "$TEMP/cert0" | awk '{print toupper($1)}')"
fi
HOST_NAME="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$RUNNER/Info.plist")"
python3 "$SOURCE/link-host.py" "$RUNNER/$HOST_NAME"
codesign --force --sign "$IDENTITY" "$FRAMEWORK"
codesign --force --sign "$IDENTITY" --preserve-metadata=identifier,entitlements "$RUNNER"
codesign --verify --strict "$RUNNER"
SUCCESS=1
echo 'Embedded iPhone Portal status screen'
