#!/usr/bin/env bash
# Xcode compiles BorderBeamKit's Metal shaders and embeds its resource bundle.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="$ROOT/dist/iPhone Portal.app"
BUILD="$ROOT/vendor/mac-build"
NODE="$(command -v node)" || { echo "Node 22.19+ is required."; exit 1; }
mkdir -p "$ROOT/vendor" "$ROOT/dist"
echo "→ Building iPhone Portal with Xcode"
if ! xcodebuild -project "$ROOT/macos/iPhonePortal.xcodeproj" -scheme iPhonePortal \
  -configuration Release -destination 'platform=macOS' -derivedDataPath "$BUILD" \
  IM_REPO_PATH="$ROOT" IM_NODE_PATH="$NODE" build >"$ROOT/vendor/mac-build.log" 2>&1; then
  tail -80 "$ROOT/vendor/mac-build.log"
  exit 1
fi
rm -rf "$APP"
ditto "$BUILD/Build/Products/Release/iPhone Portal.app" "$APP"
codesign --verify --strict "$APP"
echo "✓ Built $APP"
if [ "${1:-}" = "--install" ]; then
  mkdir -p "$HOME/Applications"
  rm -rf "$HOME/Applications/iPhone Portal.app"
  ditto "$APP" "$HOME/Applications/iPhone Portal.app"
  echo "✓ Installed to ~/Applications/iPhone Portal.app"
fi
