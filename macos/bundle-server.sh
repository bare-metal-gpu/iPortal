#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUN="${IPORTAL_BUN_PATH:-$(command -v bun)}"
OUTPUT="$TARGET_BUILD_DIR/$EXECUTABLE_FOLDER_PATH/iportal-server"
"$BUN" "$ROOT/scripts/build-server.ts" "$OUTPUT"
codesign --force --sign "${EXPANDED_CODE_SIGN_IDENTITY:--}" "$OUTPUT"
NATIVE="$TARGET_BUILD_DIR/$EXECUTABLE_FOLDER_PATH/iPortalTransport"
rm -f "$NATIVE"
if [ -x "$ROOT/vendor/native/iPortalTransport" ] && [ -f "$ROOT/vendor/native/host-stamp" ] &&
   [ "$("$ROOT/native/host-stamp.sh")" = "$(cat "$ROOT/vendor/native/host-stamp")" ]; then
  cp "$ROOT/vendor/native/iPortalTransport" "$NATIVE"
  codesign --force --sign "${EXPANDED_CODE_SIGN_IDENTITY:--}" "$NATIVE"
fi
# Keep signed device products beside the server. __TESTROOT__ in xctestrun
# remains relative to Build/Products, so moving the Mac app is safe.
DEVICE="$TARGET_BUILD_DIR/$UNLOCALIZED_RESOURCES_FOLDER_PATH/Device"
rm -rf "$DEVICE"
PRODUCTS="$ROOT/vendor/iportal-device-build/Build/Products"
if [ -d "$PRODUCTS" ]; then
  mkdir -p "$DEVICE/Build"
  ditto "$PRODUCTS" "$DEVICE/Build/Products"
  cp "$ROOT/vendor/iportal-device-build/helper-manifest.json" "$DEVICE/helper-manifest.json"
fi
# The Android helper is one small unsigned file that the server pushes to a phone.
ANDROID="$TARGET_BUILD_DIR/$UNLOCALIZED_RESOURCES_FOLDER_PATH/Android"
rm -rf "$ANDROID"
if [ -f "$ROOT/vendor/android/iportal-agent.jar" ]; then
  mkdir -p "$ANDROID"
  cp "$ROOT/vendor/android/iportal-agent.jar" "$ANDROID/iportal-agent.jar"
fi
