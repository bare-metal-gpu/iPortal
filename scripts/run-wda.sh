#!/usr/bin/env bash
# Launches the already-built WebDriverAgent on the iPhone and keeps it running. mirror.mjs calls this automatically.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
UDID="${UDID:-$(node "$ROOT/mirror.mjs" devices --first)}"
exec xcodebuild test-without-building \
  -project "$ROOT/vendor/WebDriverAgent/WebDriverAgent.xcodeproj" \
  -scheme WebDriverAgentRunner \
  -destination "id=$UDID" \
  -derivedDataPath "$ROOT/vendor/build"
