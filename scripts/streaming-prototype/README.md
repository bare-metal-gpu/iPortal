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
UDID=YOUR_PHONE_UDID node scripts/streaming-prototype/test-phone.mjs \
  http://127.0.0.1:18100 /absolute/path/to/local-report.json
```

The test creates a harmless window inside the runner and activates it externally with `devicectl`. Activating the runner through its own XCTest request can block its UI thread while waiting for itself to become idle. While the probe is visible in the foreground, it holds `UIApplication.idleTimerDisabled` to prevent automatic locking without HID keep-alive traffic. Hiding the probe, backgrounding, or teardown restores the previously observed value; no persistent phone setting changes. It first calibrates the recorder using one complete ordinary gesture, then a full raw Recap tap. Raw calibration checks real UIKit delivery, touch identity, and center coordinates, because a successful daemon callback alone can accompany zero UIKit events. It then requires one UIKit `began`, the same `UITouch` identity across movement chunks, one `ended`, and zero active contacts after release. A separate test stops sending input and checks that the watchdog actually produces an end event. The harness attempts cleanup even when an assertion fails and records the final active-contact count.

POST `/wda/mirror/probe` accepts `action: show|state|reset|hide`. POST `/wda/mirror/stream` accepts `phase: begin|move|end|cancel|status|tap`; begin/move take normalized `x,y`, and subsequent commands require the returned token. Coordinates are limited to the central recorder region; begin/move require the unlocked portrait runner in foreground. `tap` submits a complete 60 ms raw tap for calibration. On begin/tap, optional development-only calibration arguments are `frameMode: logical|physical|unit`, `pointMode: logical|physical`, `screenScale: 1|3`, and `senderMode: generic|display`. Defaults match the verified raw delivery configuration: logical frame and points, scale 1, generic sender, and the screen's explicit display ID. The bounded harness tries these combinations until a full raw tap reaches the recorder. Display-specific sender setup is skipped if unavailable. These are internal experiment routes, not additions to the normal browser flow.

The stream `active` field describes protocol ownership. The nested recorder `activeCount` describes actual UIKit contacts; these can differ when iOS cancels a contact. The harness treats a down-only `began→cancelled` sequence as a negative capability finding, exits 2, and records `assessment: serialized-delta-contact-not-supported`. It never counts this as successful streaming. Other failures exit 1; complete continuous-contact and watchdog proof exits 0.

A 3-second inactivity watchdog attempts a real up-only Recap chunk. Total contact lifetime is limited to 10 seconds. Timeout or failed release remains an uncertain outcome; at most three watchdog release attempts occur before reporting that a runner restart is required. A callback alone is not evidence of actual release: the recorder's active contact count is included. If active contacts remain or delivery becomes uncertain, stop testing and restart the runner. Restore the normal signed helper after the experiment.

## Evidence status

- Full iOS helper build: passed.
- Offline Recap delta composition: passed.
- Ordinary complete gesture: one UIKit began, movement, and ended; passed.
- Raw full tap: passed with explicit display ID 1, logical 402×874 frame/points, composer scale 1, and generic sender. UIKit saw a 60 ms began→ended pair at the intended center.
- Down-only raw chunk: UIKit saw began→cancelled after 105.5 ms. Cancellation was already present in the response to the 339.2 ms native playback request, so there was no active contact when a serialized next chunk could be sent.
- Continuous contact: **not supported by this tested serialized daemon path**. This does not rule out other injection mechanisms or a persistent in-process player.
- Watchdog physical release: **not assessed** because the contact was cancelled before the next chunk. The watchdog is an experimental attempted release, not a verified guarantee.
- Cleanup: explicit cancel acknowledged; recorder active count 0; probe hidden; prior idle-timer value restored.

Measured on iPhone 16 Pro, iOS 26.7.1. Full raw taps with scale 3 or a physical target frame initially acknowledged without delivering UIKit events; the calibration prevents those acknowledgments from being mistaken for success. `CADisplay`-based display-specific sender setup was unavailable in this runner context. The working generic configuration was found in the sixth dispatched full-tap candidate. The test stopped at the cancellation result; later movement and watchdog phases did not run. These are one-device capability observations, not a general latency benchmark.
