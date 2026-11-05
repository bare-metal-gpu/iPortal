#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
{
  uname -m
  xcodebuild -version
  # Record source and ABI shims too, so direct Xcode builds cannot reuse an old protocol.
  shasum -a 256 "$ROOT/native/"*.swift "$ROOT/shared/DeviceCapabilities.swift" \
    "$ROOT/native/shims/CoreDevice.swiftmodule/arm64-apple-macos.swiftinterface" \
    "$ROOT/native/shims/CoreDeviceProtocols.swiftmodule/arm64-apple-macos.swiftinterface" \
    "$ROOT/native/Cargo.lock" "$ROOT/native/src/"*.rs
} | shasum -a 256 | awk '{print $1}'
