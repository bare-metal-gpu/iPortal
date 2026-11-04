#!/usr/bin/env bash
# Idempotently upgrade either upstream WDA or the previous fast-touch helper.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WDA="${1:-$ROOT/vendor/WebDriverAgent}"
BASE="$ROOT/scripts/wda-fast-touch.patch"
SAFETY="$ROOT/scripts/wda-mirror-safety.patch"
LATENCY="$ROOT/scripts/wda-mirror-latency.patch"
MULTITOUCH="$ROOT/scripts/wda-multitouch.patch"
COORDINATES="$ROOT/scripts/wda-mirror-coordinates.patch"

# Upgrade our old diagnostic namespace before checking patch revisions. These
# exact strings belong to our additions, not to upstream WebDriverAgent.
python3 - "$WDA/WebDriverAgentLib/Commands/FBTouchActionCommands.m" <<'PY'
from pathlib import Path
import sys
p = Path(sys.argv[1])
source = p.read_text()
renamed = source.replace('// iphone-mirror: injects', '// iportal: injects').replace('errorWithDomain:@"iphone-mirror"', 'errorWithDomain:@"iportal"')
if renamed != source:
    p.write_text(renamed)
PY

# Later patches modify earlier lines, so recognize the final state first.
if git -C "$WDA" apply --reverse --check "$COORDINATES" 2>/dev/null; then
  exit 0
fi
if ! git -C "$WDA" apply --reverse --check "$MULTITOUCH" 2>/dev/null; then
if ! git -C "$WDA" apply --reverse --check "$LATENCY" 2>/dev/null; then
if ! git -C "$WDA" apply --reverse --check "$SAFETY" 2>/dev/null; then
  if git -C "$WDA" apply --check "$BASE" 2>/dev/null; then
    git -C "$WDA" apply "$BASE"
  elif ! git -C "$WDA" apply --reverse --check "$BASE" 2>/dev/null; then
    echo "Cannot apply mirror endpoints: WebDriverAgent has incompatible local changes." >&2
    exit 1
  fi
  if ! git -C "$WDA" apply --check "$SAFETY" 2>/dev/null; then
    echo "Cannot apply mirror validation patch: refusing to build an unsafe fallback." >&2
    exit 1
  fi
  git -C "$WDA" apply "$SAFETY"

fi
if ! git -C "$WDA" apply --check "$LATENCY" 2>/dev/null; then
  echo "Cannot apply mirror latency patch: incompatible helper source." >&2
  exit 1
fi
git -C "$WDA" apply "$LATENCY"
fi
if ! git -C "$WDA" apply --check "$MULTITOUCH" 2>/dev/null; then
  echo "Cannot apply mirror multi-touch patch: incompatible helper source." >&2
  exit 1
fi
git -C "$WDA" apply "$MULTITOUCH"
fi
if ! git -C "$WDA" apply --check "$COORDINATES" 2>/dev/null; then
  echo "Cannot apply mirror coordinate patch: incompatible helper source." >&2
  exit 1
fi
git -C "$WDA" apply "$COORDINATES"
