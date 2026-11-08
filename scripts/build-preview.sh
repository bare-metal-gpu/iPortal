#!/usr/bin/env bash
# Hosted compilation only. Signing identities and provisioning stay on the Mac.
set -euo pipefail
[[ "${CI:-}" = true ]] || { echo 'Run Checks on GitHub with native_preview enabled.'; exit 1; }
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUTPUT="$RUNNER_TEMP/iPortal-preview"
mkdir -p "$OUTPUT" "$ROOT/vendor"
BUILD_ID="$(bun "$ROOT/scripts/helper-build-id.ts")"
VERSION="$((16#${BUILD_ID:0:7} % 9999 + 1)).$((16#${BUILD_ID:7:2} % 100)).$((16#${BUILD_ID:9:2} % 100))"
xcodebuild build-for-testing -project ios/iPortalHelper.xcodeproj -scheme iPortalHelper \
  -destination 'generic/platform=iOS' -derivedDataPath "$RUNNER_TEMP/helper-preview" \
  IPORTAL_HELPER_BUILD_ID="$BUILD_ID" CURRENT_PROJECT_VERSION="$VERSION" CODE_SIGNING_ALLOWED=NO
xcodebuild -project ios/iPortalUI.xcodeproj -scheme iPortalUI -configuration Release \
  -destination 'generic/platform=iOS' -derivedDataPath "$RUNNER_TEMP/ui-preview" CODE_SIGNING_ALLOWED=NO build
PRODUCTS="$RUNNER_TEMP/helper-preview/Build/Products"
RUNNER="$PRODUCTS/Debug-iphoneos/iPortalRunner-Runner.app"
for DEPENDENCY in swift-nio swift-nio-transport-services swift-atomics swift-collections swift-system; do
  NOTICES="$RUNNER/ThirdPartyNotices/$DEPENDENCY"
  mkdir -p "$NOTICES"
  cp "$RUNNER_TEMP/helper-preview/SourcePackages/checkouts/$DEPENDENCY/LICENSE.txt" "$NOTICES/"
  if [ -f "$RUNNER_TEMP/helper-preview/SourcePackages/checkouts/$DEPENDENCY/NOTICE.txt" ]; then
    cp "$RUNNER_TEMP/helper-preview/SourcePackages/checkouts/$DEPENDENCY/NOTICE.txt" "$NOTICES/"
  fi
done
# Ad-hoc signing allows the existing embedder to preserve the Apple test host.
# These products are not installable on a phone until locally provisioned.
codesign --force --sign - "$RUNNER"
IPORTAL_UI_PRODUCTS="$RUNNER_TEMP/ui-preview/Build/Products/Release-iphoneos" bash ios/embed.sh "$RUNNER"
mkdir -p "$OUTPUT/Device/Build/Products/Debug-iphoneos"
ditto "$RUNNER" "$OUTPUT/Device/Build/Products/Debug-iphoneos/iPortalRunner-Runner.app"
cp "$PRODUCTS"/iPortalHelper_iphoneos*.xctestrun "$OUTPUT/Device/Build/Products/"
printf '{"protocol":1,"build":"%s"}\n' "$BUILD_ID" > "$OUTPUT/Device/helper-manifest.json"
xcodebuild -project ios/iPortalHelper.xcodeproj -scheme iPortalFixture \
  -destination 'generic/platform=iOS' -derivedDataPath "$RUNNER_TEMP/fixture-preview" CODE_SIGNING_ALLOWED=NO build
ditto "$RUNNER_TEMP/fixture-preview/Build/Products/Debug-iphoneos/iPortalFixture.app" "$OUTPUT/iPortalFixture.app"
xcodebuild -project macos/iPortal.xcodeproj -scheme iPortal -configuration Release \
  -destination 'platform=macOS' -derivedDataPath "$RUNNER_TEMP/mac-preview" \
  ARCHS=arm64 CODE_SIGNING_ALLOWED=NO build
ditto "$RUNNER_TEMP/mac-preview/Build/Products/Release/iPortal.app" "$OUTPUT/iPortal.app"
git rev-parse HEAD > "$OUTPUT/commit.txt"
ditto -c -k --keepParent "$OUTPUT" "$RUNNER_TEMP/iPortal-preview.zip"
