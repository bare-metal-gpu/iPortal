#!/usr/bin/env bash
# One-time setup: downloads WebDriverAgent, signs it with your (free) Apple developer team and builds it for your iPhone.
# Usage: scripts/setup-wda.sh [TEAM_ID]
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WDA="$ROOT/vendor/WebDriverAgent"
BUILD="$ROOT/vendor/iportal-device-build"
REVISION="$(cat "$ROOT/scripts/wda-revision")"
[[ "$REVISION" =~ ^[a-f0-9]{40}$ ]] || { echo "Invalid helper source revision." >&2; exit 1; }

command -v xcodebuild >/dev/null || { echo "Xcode is required (install it from the App Store, open it once)."; exit 1; }

UDID="${UDID:-$(bun "$ROOT/iportal.mjs" devices --first || true)}"
[ -n "$UDID" ] || { echo "No iPhone found. Plug it in via USB, unlock it and tap Trust."; exit 1; }

TEAM="${1:-}"
if [ -z "$TEAM" ]; then
  for SAVED in "$ROOT/vendor/ios-signing-team" "$ROOT/vendor/mac-signing-team"; do
    if [ -s "$SAVED" ]; then TEAM="$(cat "$SAVED")"; break; fi
  done
fi
if [ -z "$TEAM" ]; then
  # The Team ID is the OU of your "Apple Development" signing certificate.
  TEAM="$(security find-certificate -c "Apple Development" -p 2>/dev/null | openssl x509 -noout -subject 2>/dev/null | sed -n 's/.*OU *= *\([A-Z0-9]\{10\}\).*/\1/p' | head -1)"
fi
[ -n "$TEAM" ] || { echo "Couldn't find your Team ID. Add your Apple ID in Xcode → Settings → Accounts, then run: scripts/setup-wda.sh <TEAM_ID>"; exit 1; }

if [ ! -d "$WDA" ]; then
  echo "→ Downloading WebDriverAgent"
  git init -q "$WDA"
  git -C "$WDA" remote add origin https://github.com/appium/WebDriverAgent
  git -C "$WDA" fetch --depth 1 origin "$REVISION"
  git -C "$WDA" checkout --detach FETCH_HEAD
fi
[ "$(git -C "$WDA" rev-parse HEAD)" = "$REVISION" ] || {
  echo "Helper source differs from the tested revision. Move vendor/WebDriverAgent aside and run setup again; local changes were preserved." >&2
  exit 1
}

# Apply the validated, rotation-aware touch and acknowledged keepalive endpoints.
"$ROOT/scripts/apply-wda-patches.sh" "$WDA"
bash "$ROOT/scripts/build-iportal-ui.sh" "$WDA"
"$ROOT/scripts/apply-wda-branding.sh" "$WDA"

# Free accounts need a team-specific identifier. Handle both fresh upstream
# checkouts and previously branded runners, including repeat setup runs.
bun "$ROOT/scripts/configure-ios.ts" "$WDA/WebDriverAgent.xcodeproj/project.pbxproj" "$TEAM"

echo "→ Building for $UDID with team $TEAM (first build takes a few minutes)"
LOG="$ROOT/vendor/iportal-device-build.log"
if ! xcodebuild build-for-testing \
  -project "$WDA/WebDriverAgent.xcodeproj" \
  -scheme WebDriverAgentRunner \
  -destination "id=$UDID" \
  -derivedDataPath "$BUILD" \
  -allowProvisioningUpdates -allowProvisioningDeviceRegistration \
  IPORTAL_BUN_PATH="$(command -v bun)" DEVELOPMENT_TEAM="$TEAM" CODE_SIGN_STYLE=Automatic CODE_SIGN_IDENTITY="Apple Development" >"$LOG" 2>&1; then
  grep -E "error:" "$LOG" | sed 's/^.*error: /  ! /' | sort -u
  if grep -q "No Accounts" "$LOG"; then
    echo "Sign in to Xcode: Xcode → Settings → Accounts → + → Apple ID, then run bun run setup again."
  else
    echo "Build failed (full log: vendor/iportal-device-build.log)."
  fi
  exit 1
fi

RUNNER="$BUILD/Build/Products/Debug-iphoneos/iPortalRunner-Runner.app"
[ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleDisplayName' "$RUNNER/Info.plist")" = "iPortal" ] || { echo "Runner branding was not embedded."; exit 1; }
codesign --verify --strict "$RUNNER"
[ -d "$RUNNER/iPortalLaunch.storyboardc" ] || { echo "Runner launch screen was not embedded."; exit 1; }
codesign --verify --strict "$RUNNER/Frameworks/iPortalUI.framework"
xcrun otool -L "$RUNNER/iPortalRunner-Runner" | grep -q '@executable_path/Frameworks/iPortalUI.framework/iPortalUI' || { echo "Runner status screen was not linked."; exit 1; }
printf '%s\n' "$TEAM" > "$ROOT/vendor/ios-signing-team"

cat <<MSG

✓ WebDriverAgent is built.

On your iPhone, once:
  1. Settings → Privacy & Security → Developer Mode → On (it restarts)
  2. After the first launch: Settings → General → VPN & Device Management → trust your Apple ID

Then run: bun start
MSG
