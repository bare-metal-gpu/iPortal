# Streaming touch experiment

This branch is a development prototype. It does not alter the normal mirror UI or production routes. The extra routes are registered only when the test runner receives `MIRROR_STREAMING_PROTOTYPE=1`.

The experiment reconstructs the known Recap gesture prefix for each request, strips previously sent events, and sends only the delta through the XCTest daemon. A single sender and deterministic contact index are reused. It does **not** keep mutating a composer after its factory block; that approach did not append events in the earlier probe.

## Build in this isolated worktree

Use an isolated `vendor/WebDriverAgent` checkout with the normal mirror patches applied. Do not point this installer or derived data path at the production checkout.

```sh
scripts/streaming-prototype/install.sh
xcodebuild build-for-testing \
  -project vendor/WebDriverAgent/WebDriverAgent.xcodeproj \
  -scheme WebDriverAgentRunner \
  -destination id=YOUR_PHONE_UDID \
  -derivedDataPath vendor/build \
  -allowProvisioningUpdates DEVELOPMENT_TEAM=YOUR_TEAM \
  CODE_SIGN_STYLE=Automatic CODE_SIGN_IDENTITY='Apple Development'
```

The installer is idempotent and keeps the native experiment in separate headers. The UIKit recorder header can be reused in an independent experimental helper without applying the streaming implementation.

## Offline composition check

```sh
xcrun clang -fobjc-arc -framework Foundation -framework CoreGraphics \
  scripts/streaming-prototype/test-composition.m -o vendor/test-composition
vendor/test-composition
```

This composes and serializes only; it never plays input. On the inspected macOS Recap runtime it produces down:1, first move:4, second move:4, up:1 delta events and checks sender identity. This is not proof that the iPhone retains contact between playback calls.

## Exclusive phone test

Stop other mirror runners before starting this build. Keep the phone unlocked and use only USB forwarding to its loopback WDA port. Do not run both experiments concurrently.

```sh
TEST_RUNNER_USE_IP=127.0.0.1 TEST_RUNNER_MIRROR_STREAMING_PROTOTYPE=1 \
  xcodebuild test-without-building \
  -project vendor/WebDriverAgent/WebDriverAgent.xcodeproj \
  -scheme WebDriverAgentRunner \
  -destination id=YOUR_PHONE_UDID \
  -derivedDataPath vendor/build

# In another terminal with 18100 forwarded over USB to device port 8100:
node scripts/streaming-prototype/test-phone.mjs \
  http://127.0.0.1:18100 /absolute/path/to/local-report.json
```

The test creates a harmless window inside the runner and activates that runner. It first calibrates the recorder using one complete ordinary gesture. It then requires one UIKit `began`, the same `UITouch` identity across movement chunks, one `ended`, and zero active contacts after release. A separate test stops sending input and checks that the watchdog actually produces an end event. The harness attempts cleanup even when an assertion fails and records the final active-contact count.

POST `/wda/mirror/probe` accepts `action: show|state|reset`. POST `/wda/mirror/stream` accepts `phase: begin|move|end|cancel|status`; begin/move take normalized `x,y`, and subsequent commands require the returned token. Coordinates are limited to the central recorder region; begin/move require the unlocked portrait runner in foreground. These are internal experiment routes, not additions to the normal browser flow.

A 3-second inactivity watchdog attempts a real up-only Recap chunk. Total contact lifetime is limited to 10 seconds. Timeout or failed release remains an uncertain outcome; at most three watchdog release attempts occur before reporting that a runner restart is required. A callback alone is not evidence of actual release: the recorder's active contact count is included. If active contacts remain or delivery becomes uncertain, stop testing and restart the runner. Restore the normal signed helper after the experiment.

## Evidence status

- Full iOS helper build: passed.
- Offline Recap delta composition: passed.
- Physical continuous-contact and watchdog proof: pending exclusive phone test.
