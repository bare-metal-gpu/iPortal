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
AUTH="$ROOT/scripts/wda-helper-auth.patch"

apply_touch_patches() {

# Upgrade our old diagnostic namespace before checking patch revisions. These
# exact strings belong to our additions, not to upstream WebDriverAgent.
bun - "$WDA/WebDriverAgentLib/Commands/FBTouchActionCommands.m" <<'JS'
import fs from 'node:fs';
const file = process.argv[2];
const source = fs.readFileSync(file, 'utf8');
const renamed = source.replaceAll('// iphone-mirror: injects', '// iportal: injects').replaceAll('errorWithDomain:@"iphone-mirror"', 'errorWithDomain:@"iportal"');
if (source !== renamed) fs.writeFileSync(file, renamed);
JS

# Later patches modify earlier lines, so recognize the final state first.
if git -C "$WDA" apply --reverse --check "$COORDINATES" 2>/dev/null; then
  return 0
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
}
apply_touch_patches

if ! git -C "$WDA" apply --reverse --check "$AUTH" 2>/dev/null; then
  if ! git -C "$WDA" apply --check "$AUTH" 2>/dev/null; then
    echo "Cannot apply helper authentication: refusing to build an unauthenticated helper." >&2
    exit 1
  fi
  git -C "$WDA" apply "$AUTH"
fi
install -m 644 "$ROOT/ios/FBIPortalAuthentication.h" "$WDA/WebDriverAgentLib/Routing/FBIPortalAuthentication.h"
