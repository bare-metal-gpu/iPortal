#!/usr/bin/env bash
# Builds the native Mac app ("iPhone Mirroring EU.app") into dist/. With --install it's copied to ~/Applications.
# The app runs mirror.mjs from this checkout, so build it again if you move the repo.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="$ROOT/dist/iPhone Mirroring EU.app"
NODE="$(command -v node)" || { echo "Node 20+ is required."; exit 1; }

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

echo "→ Compiling"
swiftc -O -swift-version 5 -parse-as-library -framework Cocoa -framework WebKit -framework AVFoundation -framework CoreMediaIO \
  "$ROOT"/macos/*.swift -o "$APP/Contents/MacOS/iPhoneMirror"

echo "→ Making the icon"
ICONSET="$(mktemp -d)/AppIcon.iconset"
mkdir -p "$ICONSET"
swift "$ROOT/macos/tools/make-icon.swift" "$ROOT/macos/icon.png" "$ICONSET/icon_512x512@2x.png"
for s in 16 32 128 256 512; do
  sips -z $s $s "$ICONSET/icon_512x512@2x.png" --out "$ICONSET/icon_${s}x${s}.png" >/dev/null
  sips -z $((s * 2)) $((s * 2)) "$ICONSET/icon_512x512@2x.png" --out "$ICONSET/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/AppIcon.icns"

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>iPhone Mirroring EU</string>
  <key>CFBundleDisplayName</key><string>iPhone Mirroring EU</string>
  <key>CFBundleIdentifier</key><string>com.yachty66.iphonemirror</string>
  <key>CFBundleExecutable</key><string>iPhoneMirror</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSCameraUsageDescription</key><string>iPhone Mirroring EU shows your iPhone's screen by capturing it over USB, like QuickTime does.</string>
  <key>NSMicrophoneUsageDescription</key><string>iPhone Mirroring EU plays your iPhone's sound on your Mac.</string>
  <key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
  <key>IMRepoPath</key><string>$ROOT</string>
  <key>IMNodePath</key><string>$NODE</string>
</dict>
</plist>
PLIST

codesign --force --sign - "$APP" >/dev/null
echo "✓ Built $APP"

if [ "${1:-}" = "--install" ]; then
  mkdir -p "$HOME/Applications"
  rm -rf "$HOME/Applications/iPhone Mirroring EU.app"
  cp -R "$APP" "$HOME/Applications/"
  echo "✓ Installed to ~/Applications/iPhone Mirroring EU.app"
fi
