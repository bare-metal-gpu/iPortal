#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CARGO="${CARGO:-$HOME/.cargo/bin/cargo}"
OUT="$ROOT/vendor/native"
mkdir -p "$OUT"
export MACOSX_DEPLOYMENT_TARGET=14.0
"$CARGO" build --manifest-path "$ROOT/native/Cargo.toml" --release --locked
xcrun swiftc -target arm64-apple-macos14.0 -parse-as-library -O -I "$ROOT/native/shims" \
  -import-objc-header "$ROOT/native/include/iportal_native_media.h" \
  -F /Library/Developer/PrivateFrameworks -framework CoreDevice \
  -Xlinker -rpath -Xlinker /Library/Developer/PrivateFrameworks \
  "$ROOT/shared/DeviceCapabilities.swift" "$ROOT/native/DiscoveryRecovery.swift" "$ROOT/native/Transport.swift" "$ROOT/native/target/release/libiportal_native_media.a" \
  -o "$OUT/iPortalTransport"
codesign --force --sign - "$OUT/iPortalTransport"

"$ROOT/native/host-stamp.sh" > "$OUT/host-stamp"
