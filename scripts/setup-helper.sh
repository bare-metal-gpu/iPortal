#!/usr/bin/env bash
# Build the owned runner. Credentials remain in local signing configuration.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUILD="${IPORTAL_BUILD_DIR:-$ROOT/vendor/iportal-device-build}"
mkdir -p "$ROOT/vendor"
TEAM="${1:-}"
if [ -z "$TEAM" ]; then
  for SAVED in "$ROOT/vendor/ios-signing-team" "$ROOT/vendor/mac-signing-team"; do
    if [ -s "$SAVED" ]; then TEAM="$(cat "$SAVED")"; break; fi
  done
fi
if [ -z "$TEAM" ]; then
  TEAM="$(security find-certificate -c 'Apple Development' -p 2>/dev/null | openssl x509 -noout -subject 2>/dev/null | sed -n 's/.*OU *= *\([A-Z0-9]\{10\}\).*/\1/p' | head -1)"
fi
[[ "$TEAM" =~ ^[A-Z0-9]{10}$ ]] || { echo 'Add your Apple ID in Xcode → Settings → Accounts, then run bun run setup again.'; exit 1; }
BUNDLE="com.$(printf '%s' "$TEAM" | tr '[:upper:]' '[:lower:]').iportal.mobile"
bash "$ROOT/scripts/build-iportal-ui.sh"
LOG="$ROOT/vendor/iportal-device-build.log"
BUILD_ID="$(bun "$ROOT/scripts/helper-build-id.ts")"
# Give Apple's installer a changed bundle version as well as the full protocol
# identity. It may otherwise reuse an already-loaded test bundle after an update.
BUILD_VERSION="$((16#${BUILD_ID:0:7} % 9999 + 1)).$((16#${BUILD_ID:7:2} % 100)).$((16#${BUILD_ID:9:2} % 100))"
# Build away from published products. A failed build must leave the last working
# installation intact, and a running launcher must never see half-written files.
DERIVED="$BUILD-cache"
mkdir -p "$(dirname "$BUILD")"
STAGE="$(mktemp -d "$BUILD.stage.XXXXXX")"
PREVIOUS=""
cleanup() {
  rm -rf "$STAGE"
  if [ -n "$PREVIOUS" ] && [ -d "$PREVIOUS" ] && [ ! -e "$BUILD" ]; then mv "$PREVIOUS" "$BUILD"; fi
}
trap cleanup EXIT
DESTINATION="generic/platform=iOS"
if [ -n "${UDID:-}" ]; then DESTINATION="id=$UDID"; fi
if ! xcodebuild build-for-testing -project "$ROOT/ios/iPortalHelper.xcodeproj" -scheme iPortalHelper \
  -destination "$DESTINATION" -derivedDataPath "$DERIVED" -allowProvisioningUpdates -allowProvisioningDeviceRegistration \
  DEVELOPMENT_TEAM="$TEAM" IPORTAL_BUNDLE_BASE="$BUNDLE" IPORTAL_HELPER_BUILD_ID="$BUILD_ID" CURRENT_PROJECT_VERSION="$BUILD_VERSION" CODE_SIGN_STYLE=Automatic CODE_SIGN_IDENTITY='Apple Development' >"$LOG" 2>&1; then
  echo 'Helper build failed. See vendor/iportal-device-build.log.'; exit 1
fi
mkdir -p "$STAGE/Build/Products/Debug-iphoneos"
ditto "$DERIVED/Build/Products/Debug-iphoneos/iPortalRunner-Runner.app" "$STAGE/Build/Products/Debug-iphoneos/iPortalRunner-Runner.app"
cp "$DERIVED"/Build/Products/iPortalHelper_iphoneos*.xctestrun "$STAGE/Build/Products/"
RUNNER="$STAGE/Build/Products/Debug-iphoneos/iPortalRunner-Runner.app"
# Static SwiftPM libraries need their redistribution notices in the product too.
for DEPENDENCY in swift-nio swift-nio-transport-services swift-atomics swift-collections swift-system; do
  NOTICES="$RUNNER/ThirdPartyNotices/$DEPENDENCY"
  mkdir -p "$NOTICES"
  cp "$DERIVED/SourcePackages/checkouts/$DEPENDENCY/LICENSE.txt" "$NOTICES/"
  if [ -f "$DERIVED/SourcePackages/checkouts/$DEPENDENCY/NOTICE.txt" ]; then
    cp "$DERIVED/SourcePackages/checkouts/$DEPENDENCY/NOTICE.txt" "$NOTICES/"
  fi
done
bash "$ROOT/ios/embed.sh" "$RUNNER"
codesign --verify --strict "$RUNNER"
ACTUAL_BUILD_ID="$(/usr/libexec/PlistBuddy -c 'Print :IPortalHelperBuildID' "$RUNNER/PlugIns/iPortalRunner.xctest/Info.plist")"
[ "$ACTUAL_BUILD_ID" = "$BUILD_ID" ] || { echo 'Helper build identity mismatch.'; exit 1; }
printf '{"protocol":1,"build":"%s"}\n' "$BUILD_ID" > "$STAGE/helper-manifest.json"
if [ -e "$BUILD" ]; then PREVIOUS="$BUILD.previous.$$"; mv "$BUILD" "$PREVIOUS"; fi
mv "$STAGE" "$BUILD"
if [ -n "$PREVIOUS" ]; then rm -rf "$PREVIOUS"; PREVIOUS=""; fi
printf '%s\n' "$TEAM" > "$ROOT/vendor/ios-signing-team"
echo 'iPortal helper built. Connect and unlock your device, enable Developer Mode, and run bun start.'
