#!/usr/bin/env bash
# Launches the already-built WebDriverAgent on the iPhone and keeps it running. mirror.mjs calls this automatically.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
UDID="${UDID:-$(node "$ROOT/mirror.mjs" devices --first)}"
# xcodebuild forwards TEST_RUNNER_* into the runner environment (xcodebuild(1)).
# Both WDA HTTP and MJPEG honor USE_IP. USB forwarding still reaches loopback.
export TEST_RUNNER_USE_IP=127.0.0.1
export TEST_RUNNER_PORTAL_AUTOMATION=1
# Use immutable build products; separate result bundles prevent concurrent
# devices from contending over the shared DerivedData test log directory.
shopt -s nullglob
RUNFILES=("$ROOT"/vendor/build/Build/Products/*iphoneos*.xctestrun)
[ "${#RUNFILES[@]}" -eq 1 ] || { echo "Run setup again to build iPhone Portal."; exit 1; }
RESULTS="$(mktemp -d "${TMPDIR:-/tmp/}portal-tests.XXXXXX")"
exec xcodebuild test-without-building -xctestrun "${RUNFILES[0]}" \
  -destination "id=$UDID" -resultBundlePath "$RESULTS/Run.xcresult"
