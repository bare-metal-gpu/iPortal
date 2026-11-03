#!/bin/bash
# Build the same SwiftUI packages used by the Mac app, including Metal resources.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WDA="${1:-$ROOT/vendor/WebDriverAgent}"
BUILD="$ROOT/vendor/portal-ui-build"
LOG="$ROOT/vendor/portal-ui-build.log"
if ! xcodebuild -project "$ROOT/ios/PortalUI.xcodeproj" -scheme PortalUI \
  -configuration Release -destination 'generic/platform=iOS' -derivedDataPath "$BUILD" build >"$LOG" 2>&1; then
  tail -60 "$LOG"
  exit 1
fi
PRODUCTS="$BUILD/Build/Products/Release-iphoneos"
mkdir -p "$WDA/PortalUI"
ditto "$PRODUCTS/PortalUI.framework" "$WDA/PortalUI/PortalUI.framework"
ditto "$PRODUCTS/Libraries.dev_BorderBeamKit.bundle" "$WDA/PortalUI/Libraries.dev_BorderBeamKit.bundle"
