#!/usr/bin/env bash
# Idempotently upgrade either upstream WDA or the previous fast-touch helper.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WDA="${1:-$ROOT/vendor/WebDriverAgent}"
BASE="$ROOT/scripts/wda-fast-touch.patch"
SAFETY="$ROOT/scripts/wda-mirror-safety.patch"

# The second patch modifies the first patch's lines, so check the final state first.
if git -C "$WDA" apply --reverse --check "$SAFETY" 2>/dev/null; then
  exit 0
fi
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
