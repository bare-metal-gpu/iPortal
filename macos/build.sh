#!/usr/bin/env bash
# Xcode compiles BorderBeamKit's Metal shaders and embeds its resource bundle.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="$ROOT/dist/iPhone Portal.app"
BUILD="$ROOT/vendor/mac-build"
NODE="$(command -v node)" || { echo "Node 22.19+ is required."; exit 1; }
mkdir -p "$ROOT/vendor" "$ROOT/dist"
# Reuse a selected development identity across local rebuilds so macOS can
# recognize the background helper after an update. Never store private keys.
SIGN_IDENTITY="${IM_CODE_SIGN_IDENTITY:-}"
if [ -z "$SIGN_IDENTITY" ] && [ -f "$ROOT/vendor/mac-signing-identity" ]; then
  SIGN_IDENTITY="$(cat "$ROOT/vendor/mac-signing-identity")"
fi
SIGN_IDENTITY="${SIGN_IDENTITY:--}"
SIGN_TEAM="${IM_DEVELOPMENT_TEAM:-}"
if [ -z "$SIGN_TEAM" ] && [ -f "$ROOT/vendor/mac-signing-team" ]; then
  SIGN_TEAM="$(cat "$ROOT/vendor/mac-signing-team")"
fi
echo "→ Building iPhone Portal with Xcode"
if ! xcodebuild -project "$ROOT/macos/iPhonePortal.xcodeproj" -scheme iPhonePortal \
  -configuration Release -destination 'platform=macOS' -derivedDataPath "$BUILD" \
  IM_REPO_PATH="$ROOT" IM_NODE_PATH="$NODE" CODE_SIGN_STYLE=Manual CODE_SIGN_IDENTITY="$SIGN_IDENTITY" DEVELOPMENT_TEAM="$SIGN_TEAM" build >"$ROOT/vendor/mac-build.log" 2>&1; then
  tail -80 "$ROOT/vendor/mac-build.log"
  exit 1
fi
rm -rf "$APP"
ditto "$BUILD/Build/Products/Release/iPhone Portal.app" "$APP"
codesign --verify --deep --strict "$APP"
if [ "$SIGN_IDENTITY" != "-" ]; then
  printf '%s\n' "$SIGN_IDENTITY" > "$ROOT/vendor/mac-signing-identity"
  printf '%s\n' "$SIGN_TEAM" > "$ROOT/vendor/mac-signing-team"
fi
echo "✓ Built $APP"
if [ "${1:-}" = "--install" ]; then
  mkdir -p "$HOME/Applications"
  rm -rf "$HOME/Applications/iPhone Portal.app"
  ditto "$APP" "$HOME/Applications/iPhone Portal.app"
  # ditto preserves the old bundle-directory timestamp, which can leave Finder
  # and the Dock displaying a cached icon even though AppIcon.icns changed.
  touch "$HOME/Applications/iPhone Portal.app"
  /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister \
    -f "$HOME/Applications/iPhone Portal.app"
  echo "✓ Installed to ~/Applications/iPhone Portal.app"
fi
