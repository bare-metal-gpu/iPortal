#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WDA="${1:-$ROOT/vendor/WebDriverAgent}"
PATCH="$ROOT/scripts/streaming-prototype/wda-streaming.patch"
if ! git -C "$WDA" apply --reverse --check "$PATCH" 2>/dev/null; then
  "$ROOT/scripts/apply-wda-patches.sh" "$WDA"
  git -C "$WDA" apply --check "$PATCH"
  git -C "$WDA" apply "$PATCH"
fi
cp "$ROOT/scripts/streaming-prototype/FBMirrorTouchProbe.h" "$ROOT/scripts/streaming-prototype/FBMirrorStreamingExperiment.h" "$WDA/WebDriverAgentLib/Commands/"
