#!/bin/sh
# Builds Probe.java into a dex jar, pushes it to /data/local/tmp and runs it as
# the adb shell user. Nothing is installed; the pushed files are removed afterwards.
set -eu
SDK="${ANDROID_HOME:-/opt/homebrew/share/android-commandlinetools}"
ADB="${ADB:-$SDK/platform-tools/adb}"
PLATFORM="$(ls -d "$SDK"/platforms/android-* | sort -V | tail -1)/android.jar"
D8="$(ls -d "$SDK"/build-tools/* | sort -V | tail -1)/d8"
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="$(mktemp -d)"
trap 'rm -rf "$OUT"' EXIT

javac -nowarn -source 17 -target 17 -cp "$PLATFORM" -d "$OUT/classes" "$HERE/Probe.java" 2>&1 | grep -v '^warning\|^Note' || true
"$D8" --lib "$PLATFORM" --min-api 31 --output "$OUT/probe.jar" "$OUT"/classes/*.class
"$ADB" push "$OUT/probe.jar" /data/local/tmp/iportal-probe.jar >/dev/null

# The probe drags on a scrollable list and uses the Settings search field.
"$ADB" shell am force-stop com.google.android.settings.intelligence
"$ADB" shell am start -S -W -a android.settings.SETTINGS >/dev/null
sleep 1
"$ADB" shell CLASSPATH=/data/local/tmp/iportal-probe.jar app_process / Probe "$@" || true
if [ -n "${KEEP_STREAM:-}" ]; then
  "$ADB" pull /data/local/tmp/iportal-probe.h264 "$KEEP_STREAM" >/dev/null 2>&1 || true
fi
if [ -n "${KEEP_PCM:-}" ]; then
  "$ADB" pull /data/local/tmp/iportal-probe.pcm "$KEEP_PCM" >/dev/null 2>&1 || true
fi
"$ADB" shell input keyevent KEYCODE_HOME
"$ADB" shell rm -f /data/local/tmp/iportal-probe.jar /data/local/tmp/iportal-probe.h264 /data/local/tmp/iportal-probe.h265 /data/local/tmp/iportal-probe.pcm
