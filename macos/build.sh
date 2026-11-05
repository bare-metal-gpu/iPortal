#!/usr/bin/env bash
# Xcode compiles BorderBeamKit's Metal shaders and embeds its resource bundle.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="$ROOT/dist/iPortal.app"
BUILD="$ROOT/vendor/mac-build"
BUN="$(command -v bun)" || { echo "Bun 1.4.4+ is required."; exit 1; }
mkdir -p "$ROOT/vendor" "$ROOT/dist"
# Reuse a selected development identity across local rebuilds so macOS can
# recognize the background helper after an update. Never store private keys.
SIGN_IDENTITY="${IPORTAL_CODE_SIGN_IDENTITY:-}"
if [ -z "$SIGN_IDENTITY" ] && [ -f "$ROOT/vendor/mac-signing-identity" ]; then
  SIGN_IDENTITY="$(cat "$ROOT/vendor/mac-signing-identity")"
fi
SIGN_IDENTITY="${SIGN_IDENTITY:--}"
SIGN_TEAM="${IPORTAL_DEVELOPMENT_TEAM:-}"
if [ -z "$SIGN_TEAM" ] && [ -f "$ROOT/vendor/mac-signing-team" ]; then
  SIGN_TEAM="$(cat "$ROOT/vendor/mac-signing-team")"
fi
echo "→ Building iPortal with Xcode"
rm -f "$ROOT/vendor/native/iPortalTransport" "$ROOT/vendor/native/host-stamp"
XCODE_MAJOR="$(xcodebuild -version | awk '/^Xcode / { split($2, version, "."); print version[1] }')"
if [ "$(uname -m)" = arm64 ] && [ "${XCODE_MAJOR:-0}" -ge 27 ] && [ -d /Library/Developer/PrivateFrameworks/CoreDevice.framework ] && [ -x "${CARGO:-$HOME/.cargo/bin/cargo}" ]; then
  echo "→ Building paired-device transport"
  "$ROOT/native/build.sh"
fi
if ! xcodebuild -project "$ROOT/macos/iPortal.xcodeproj" -scheme iPortal \
  -configuration Release -destination 'platform=macOS' -derivedDataPath "$BUILD" \
  IPORTAL_BUN_PATH="$BUN" CODE_SIGN_STYLE=Manual CODE_SIGN_IDENTITY="$SIGN_IDENTITY" DEVELOPMENT_TEAM="$SIGN_TEAM" build >"$ROOT/vendor/mac-build.log" 2>&1; then
  tail -80 "$ROOT/vendor/mac-build.log"
  exit 1
fi
rm -rf "$APP"
ditto "$BUILD/Build/Products/Release/iPortal.app" "$APP"
# Xcode can reuse the outer seal when a shell phase removes an optional child.
# Reseal the final bundle after packaging; nested products keep their own seals.
codesign --force --sign "$SIGN_IDENTITY" --preserve-metadata=identifier,entitlements,flags,runtime "$APP"
codesign --verify --deep --strict "$APP"
if [ "$SIGN_IDENTITY" != "-" ]; then
  printf '%s\n' "$SIGN_IDENTITY" > "$ROOT/vendor/mac-signing-identity"
  printf '%s\n' "$SIGN_TEAM" > "$ROOT/vendor/mac-signing-team"
fi
echo "✓ Built $APP"
if [ "${1:-}" = "--install" ]; then
  mkdir -p "$HOME/Applications"
  PREVIOUS="$HOME/Applications/iPhone Portal.app"
  if [ -d "$PREVIOUS" ]; then
    swift "$ROOT/scripts/migrate-macos.swift" "$PREVIOUS"
    # Keep a rollback copy outside Applications, with the old login item disabled.
    mv "$PREVIOUS" "$ROOT/vendor/previous-app-$(date +%Y%m%d%H%M%S).app"
  fi
  rm -rf "$HOME/Applications/iPortal.app"
  ditto "$APP" "$HOME/Applications/iPortal.app"
  # ditto preserves the old bundle-directory timestamp, which can leave Finder
  # and the Dock displaying a cached icon even though AppIcon.icns changed.
  touch "$HOME/Applications/iPortal.app"
  /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister \
    -f "$HOME/Applications/iPortal.app"
  echo "✓ Installed to ~/Applications/iPortal.app"
fi
