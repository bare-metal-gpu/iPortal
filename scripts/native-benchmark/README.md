# Native interaction benchmark

Opt-in developer instrumentation for the existing native mirror. Normal setup does
not install the recorder, and normal app launches do not record anything. No extra
UI, pairing, permissions, persistent phone settings, or input backend is introduced.

The recorder increments a coded color strip on UIKit touch-down. The Mac decodes
that strip directly from the existing BGRA USB capture callback. Input still goes
through the normal WKWebView, HTTP API, scheduler, guards, and XCTest daemon.

## Run

Use an unlocked USB phone and an exclusive test slot. The helper and Mac app must
come from the same checkout. Keep the normal `vendor/build` and installed app for
restoration; build the instrumented helper separately:

```sh
node scripts/native-benchmark/install.mjs
xcodebuild build-for-testing -project vendor/WebDriverAgent/WebDriverAgent.xcodeproj \
  -scheme WebDriverAgentRunner -destination "id=$PHONE_UDID" \
  -derivedDataPath vendor/benchmark-build DEVELOPMENT_TEAM="$APPLE_TEAM" CODE_SIGN_STYLE=Automatic
node scripts/native-benchmark/install.mjs --remove
macos/build.sh
```

Stop the normal mirror and its helper. Start these processes in separate terminals:

```sh
TEST_RUNNER_USE_IP=127.0.0.1 TEST_RUNNER_MIRROR_BENCHMARK=1 \
  xcodebuild test-without-building -project vendor/WebDriverAgent/WebDriverAgent.xcodeproj \
  -scheme WebDriverAgentRunner -destination "id=$PHONE_UDID" -derivedDataPath vendor/benchmark-build

node mirror.mjs --no-open --no-autostart --udid "$PHONE_UDID"

IPHONE_MIRROR_BENCHMARK_TRACE="$PWD/vendor/native-trace.jsonl" \
  "$PWD/dist/iPhone Portal.app/Contents/MacOS/iPhoneMirror"
```

Once the USB bridge is ready, POST `{"mode":"show"}` to
`http://127.0.0.1:8100/wda/mirror/benchmark`. The response contains the runner bundle
ID. Bring that runner to the foreground with `xcrun devicectl device process launch
--device "$PHONE_UDID" "$RUNNER_BUNDLE_ID"`; do not use XCTest to activate its own
runner. Keep the phone portrait. Wait for a `usb-marker` row before collecting samples.
The helper refuses benchmark touches outside its foreground recorder and stops
after 250 gestures to prevent marker wraparound.

Collect isolated clicks, rapid bursts, and clicks during bounded inspection load.
The same recorder supports scrolling and two-finger gestures, but the analyzer
currently reports mouse-up and wheel-event samples only. Native input automation
must produce actual NSEvents; an accessibility action that bypasses mouse events
is not a mouse-latency sample. Verify trace rows and recorder counts after calibration.
Use `{"mode":"state"}` to obtain gesture sequence boundaries for each condition.

Optional condition file:

```json
[{"name":"isolated","afterSequence":0,"throughSequence":10}]
```

```sh
node scripts/native-benchmark/analyze.mjs vendor/native-trace.jsonl vendor/native-report.json conditions.json
node scripts/native-benchmark/test.mjs
swiftc macos/Capture.swift scripts/native-benchmark/marker-test.swift -o vendor/marker-test
IPHONE_MIRROR_BENCHMARK_TRACE="$PWD/vendor/marker-test.jsonl" vendor/marker-test
```

## Interpretation

- End-to-end: native `NSEvent.timestamp` on mouse-up, or the last wheel event,
  to the first matching USB frame callback, using the Mac's monotonic clock.
- Browser queue: enqueue to fetch dispatch, using the browser's own clock.
- Server queue/preflight and native guards: existing command response timings.
- UIKit onset, touch lifetime, and callback tail: measured entirely on the phone.
- Native receipt of a browser trace message is asynchronous. Release-to-enqueue
  is therefore an upper bound, not an exact JavaScript start timestamp.
- USB frame arrival is **not** display-panel presentation. The unallocated residual
  includes browser collection/bridge work, transport, scheduling and video return;
  it must not be labelled pure video latency. No cross-device clock subtraction.
- p95 uses nearest rank. Small samples are exploratory, not a stable tail estimate.

Trace files are private (0600), bounded to 16 MiB, and contain no screenshots, key
contents, typed text, selectors or app data. The capture callback samples at most
230 pixels per frame, without conversion or additional capture sessions. The
analyzer rejects missing input, missing markers, or unverified touch delivery.

## Restore

POST `{"mode":"hide"}` and verify `activeCount:0` and `idleTimerHeld:false`.
The recorder restores its foreground idle assertion on hide/background; it never
changes Auto-Lock settings. Stop the instrumented app, manual server and test runner.
Open the normal installed app, which starts the normal helper from `vendor/build`.
Verify ready/unlocked status and that `/wda/mirror/benchmark` returns 404. Re-enable
the usual bounded keep-awake lease if needed. Do not copy the benchmark helper over
the normal helper build.
