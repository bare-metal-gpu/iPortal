#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SCRATCH="$(mktemp -d)"
trap 'rm -rf "$SCRATCH"' EXIT
ICONSET="$SCRATCH/AppIcon.iconset"
mkdir -p "$ICONSET" "$(dirname "$1")"
swift "$ROOT/tools/make-icon.swift" "$ROOT/icon.png" "$ICONSET/icon_512x512@2x.png"
for s in 16 32 128 256 512; do
  sips -z "$s" "$s" "$ICONSET/icon_512x512@2x.png" --out "$ICONSET/icon_${s}x${s}.png" >/dev/null
  sips -z "$((s * 2))" "$((s * 2))" "$ICONSET/icon_512x512@2x.png" --out "$ICONSET/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$1"
