#!/usr/bin/env bash
# Launches the already-built WebDriverAgent on the iPhone and keeps it running. mirror.mjs calls this automatically.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
UDID="${UDID:-$(node "$ROOT/mirror.mjs" devices --first)}"
# xcodebuild forwards TEST_RUNNER_* into the runner environment (xcodebuild(1)).
# Both WDA HTTP and MJPEG honor USE_IP. USB forwarding still reaches loopback.
export TEST_RUNNER_USE_IP=127.0.0.1
export TEST_RUNNER_PORTAL_AUTOMATION=1
exec xcodebuild test-without-building \
  -project "$ROOT/vendor/WebDriverAgent/WebDriverAgent.xcodeproj" \
  -scheme WebDriverAgentRunner \
  -destination "id=$UDID" \
  -derivedDataPath "$ROOT/vendor/build"
