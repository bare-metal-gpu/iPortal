#!/bin/sh
# Builds the Android helper into vendor/android/iportal-agent.jar.
# Needs a JDK and an Android SDK with one platform and one build-tools version.
# No Gradle, no signing: the jar is pushed to the phone and run with app_process.
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SDK="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-/opt/homebrew/share/android-commandlinetools}}"
PLATFORM="$(ls -d "$SDK"/platforms/android-* 2>/dev/null | sort -V | tail -1)/android.jar"
D8="$(ls -d "$SDK"/build-tools/* 2>/dev/null | sort -V | tail -1)/d8"
if [ ! -f "$PLATFORM" ] || [ ! -x "$D8" ]; then
  echo "Android SDK platform or build-tools not found under $SDK (set ANDROID_HOME)." >&2
  exit 1
fi
OUT="$ROOT/vendor/android"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$OUT"
javac -nowarn -Xlint:-options -source 17 -target 17 -cp "$PLATFORM" -d "$WORK/classes" \
  "$ROOT"/android/agent/src/iportal/*.java
"$D8" --lib "$PLATFORM" --min-api 31 --output "$WORK/iportal-agent.jar" \
  $(find "$WORK/classes" -name '*.class')
mv "$WORK/iportal-agent.jar" "$OUT/iportal-agent.jar"
shasum -a 256 "$OUT/iportal-agent.jar" | cut -d' ' -f1 > "$OUT/iportal-agent.sha256"
echo "Built $OUT/iportal-agent.jar ($(cat "$OUT/iportal-agent.sha256" | cut -c1-12))"
