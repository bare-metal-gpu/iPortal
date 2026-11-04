#!/usr/bin/env bash
# Developer-only manual launch. Set the same IPORTAL_HELPER_TOKEN in the server's
# environment. Normal app/server startup provisions authentication automatically.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export UDID="${UDID:-$(bun "$ROOT/iportal.mjs" devices --first)}"
# xcodebuild forwards TEST_RUNNER_* into the runner environment (xcodebuild(1)).
# Both WDA HTTP and MJPEG honor USE_IP. USB forwarding still reaches loopback.
export TEST_RUNNER_USE_IP=127.0.0.1
export TEST_RUNNER_IPORTAL_AUTOMATION=1
# Use immutable build products; separate result bundles prevent concurrent
# devices from contending over the shared DerivedData test log directory.
exec bun "$ROOT/runtime-entry.ts" --run-device-helper
