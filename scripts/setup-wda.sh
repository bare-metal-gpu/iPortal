#!/usr/bin/env bash
# One-time setup: downloads WebDriverAgent, signs it with your (free) Apple developer team and builds it for your iPhone.
# Usage: scripts/setup-wda.sh [TEAM_ID]
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WDA="$ROOT/vendor/WebDriverAgent"
BUILD="$ROOT/vendor/build"

command -v xcodebuild >/dev/null || { echo "Xcode is required (install it from the App Store, open it once)."; exit 1; }

UDID="${UDID:-$(node "$ROOT/mirror.mjs" devices --first || true)}"
[ -n "$UDID" ] || { echo "No iPhone found. Plug it in via USB, unlock it and tap Trust."; exit 1; }

TEAM="${1:-}"
if [ -z "$TEAM" ]; then
  # The Team ID is the OU of your "Apple Development" signing certificate.
  TEAM="$(security find-certificate -c "Apple Development" -p 2>/dev/null | openssl x509 -noout -subject 2>/dev/null | sed -n 's/.*OU *= *\([A-Z0-9]\{10\}\).*/\1/p' | head -1)"
fi
[ -n "$TEAM" ] || { echo "Couldn't find your Team ID. Add your Apple ID in Xcode → Settings → Accounts, then run: scripts/setup-wda.sh <TEAM_ID>"; exit 1; }

if [ ! -d "$WDA" ]; then
  echo "→ Downloading WebDriverAgent"
  git clone --depth 1 https://github.com/appium/WebDriverAgent "$WDA"
fi

# Fast touch endpoint (/wda/mirror/touch): injects touches without WDA's per-action app lookup and waits.
if git -C "$WDA" apply --check "$ROOT/scripts/wda-fast-touch.patch" 2>/dev/null; then
  git -C "$WDA" apply "$ROOT/scripts/wda-fast-touch.patch"
elif ! git -C "$WDA" apply --reverse --check "$ROOT/scripts/wda-fast-touch.patch" 2>/dev/null; then
  echo "! Couldn't apply the fast-touch patch to WebDriverAgent; taps will use the slower standard path."
fi

# Free accounts need a bundle ID nobody else has registered.
BUNDLE="com.$(echo "$TEAM" | tr A-Z a-z).iphonemirror.WebDriverAgentRunner"
sed -i '' "s/com\.facebook\.WebDriverAgentRunner/$BUNDLE/g" "$WDA/WebDriverAgent.xcodeproj/project.pbxproj"

echo "→ Building for $UDID with team $TEAM (first build takes a few minutes)"
LOG="$ROOT/vendor/build.log"
if ! xcodebuild build-for-testing \
  -project "$WDA/WebDriverAgent.xcodeproj" \
  -scheme WebDriverAgentRunner \
  -destination "id=$UDID" \
  -derivedDataPath "$BUILD" \
  -allowProvisioningUpdates -allowProvisioningDeviceRegistration \
  DEVELOPMENT_TEAM="$TEAM" CODE_SIGN_STYLE=Automatic CODE_SIGN_IDENTITY="Apple Development" >"$LOG" 2>&1; then
  grep -E "error:" "$LOG" | sed 's/^.*error: /  ! /' | sort -u
  if grep -q "No Accounts" "$LOG"; then
    echo "Sign in to Xcode: Xcode → Settings → Accounts → + → Apple ID, then run npm run setup again."
  else
    echo "Build failed (full log: vendor/build.log)."
  fi
  exit 1
fi

cat <<MSG

✓ WebDriverAgent is built.

On your iPhone, once:
  1. Settings → Privacy & Security → Developer Mode → On (it restarts)
  2. After the first launch: Settings → General → VPN & Device Management → trust your Apple ID

Then run: npm start
MSG
