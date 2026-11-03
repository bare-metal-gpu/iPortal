# Indirect scroll and zoom capability probe

Opt-in developer experiment on branch `experiment/indirect-input`, based on
`539cf06`. It does not change the production app, API, or gestures.

## Result on 3 November 2026

**No working indirect-input path was found.** All 50 indirect-input attempts
completed without an error but produced no recorded hover, pan, pinch, scroll or
zoom events and no offset/zoom changes. All 8 direct-touch controls delivered.
An acknowledged XCTest request is therefore insufficient evidence of delivery.

The test covered XCTest mouse paths and serialized Recap streams; mouse and
trackpad senders; phased and discrete scrolling; indirect scaling; and point,
pixel, normalized and view coordinates where applicable. The complete matrix was
run first in the runner's legacy 320×480 view and again at native 402×874 after
adding a launch-screen dictionary. Both hosts explicitly enabled
`UIApplicationSupportsIndirectInputEvents`. Neither configuration delivered an
indirect event. The native-size direct pinch changed zoom from 1 to 1.985.

At native size, 200 ms phased scrolls took about 469–471 ms to acknowledge through
the XCTest mouse path and 560–573 ms through raw Recap streams. These are callback
times for requests with **no observed effect**, not interaction latency. A 200 ms
touch control took 437–440 ms and visibly changed the recorder's content offset.
The raw-touch control also worked, demonstrating that serialized event playback
itself was functional.

This rules out the tested wrappers/configurations as a ready-to-use realtime
backend. It does **not** prove that indirect input is impossible on iPhone or that
an entitlement is the cause. There was no real mouse/trackpad positive control.
Live update cadence, reversal, phase continuity, cancellation and finger-following
pinch remain unverified because the initial indirect-delivery gate failed.

The next useful experiment is a known-working indirect input source against this
same recorder, followed by tracing where synthetic delivery diverges. Until then,
keep this out of production. The ordinary helper was restored, the probe route
returned 404, and its foreground idle assertion was released.

Grouped measurements and raw-file SHA-256 hashes: [phone-results.json](phone-results.json).
Full local JSON recordings retain requests, acknowledgements, recognizer events,
scroll/zoom delegate changes and display-link samples.

## Design

`FBMirrorIndirectExperiment.h` installs a harmless foreground `UIScrollView` with
a zoomable canvas. Its standard pan recognizer allows all scroll types. It logs
hover, pan, pinch, content-offset/zoom changes, and bounded display-link samples.
Each gesture is a complete event record; no unfinished contacts are sent.
The helper rejects input outside its visible foreground recorder, while locked,
in landscape, while busy, or after an unknown playback outcome. Its foreground
idle assertion is released on hide/background and never changes Auto-Lock settings.

`measure.mjs` first requires a successful direct-touch scroll. Raw mode additionally
requires successful raw-touch playback and checks direct pinch. It tries indirect
variants and, only after phased scroll delivery, proceeds to long scrolling and
sequential updates with a direction reversal. Delivery is a prerequisite, not a
realtime success claim. HTTP/command failures abort rather than counting as
negative delivery evidence. Exit code 0 means the capability probe completed;
read `continuousScrollDeliveryObserved` and the actual events for its result.

## Build and run

Use the existing configured/signed WDA checkout. Set `PHONE_UDID` and `APPLE_TEAM`
to the device and signing team already used by the normal helper. Coordinate
exclusive phone ownership before stopping/replacing its runner.

```sh
node scripts/indirect-prototype/test-install.mjs
node scripts/indirect-prototype/install.mjs
MIRROR_INDIRECT_BUILD=1 xcodebuild build-for-testing \
  -project vendor/WebDriverAgent/WebDriverAgent.xcodeproj \
  -scheme WebDriverAgentRunner -destination "id=$PHONE_UDID" \
  -derivedDataPath vendor/indirect-build \
  DEVELOPMENT_TEAM="$APPLE_TEAM" CODE_SIGN_STYLE=Automatic
node scripts/indirect-prototype/install.mjs --remove
```

Remove the source instrumentation even if the build fails. Do not overwrite
`vendor/build` or rebuild the production app for this experiment. The installer
temporarily adds the test route and modifies the generated runner's Info.plist
before the existing re-sign step. Both source files are restored by `--remove`.

Quit the normal mirror and stop its helper. Start these in separate terminals:

```sh
TEST_RUNNER_USE_IP=127.0.0.1 TEST_RUNNER_MIRROR_INDIRECT_EXPERIMENT=1 \
  xcodebuild test-without-building \
  -project vendor/WebDriverAgent/WebDriverAgent.xcodeproj \
  -scheme WebDriverAgentRunner -destination "id=$PHONE_UDID" \
  -derivedDataPath vendor/indirect-build

node mirror.mjs --no-open --no-autostart --udid "$PHONE_UDID"
```

After the USB bridge is ready, POST `{"mode":"show"}` to
`http://127.0.0.1:8100/wda/mirror/indirect`. Use its `bundleId` to foreground the
runner with `xcrun devicectl device process launch --device "$PHONE_UDID"
"$RUNNER_BUNDLE_ID"`. Do not ask XCTest to activate its own runner. Keep the phone
unlocked, portrait and idle. Then run:

```sh
node scripts/indirect-prototype/measure.mjs \
  http://127.0.0.1:8100 vendor/indirect-pointer-results.json
node scripts/indirect-prototype/measure.mjs \
  http://127.0.0.1:8100 vendor/indirect-raw-results.json --raw
```

The harness leaves the recorder available for inspection; it does not restore the
normal helper automatically. Inspect `{"mode":"state"}` and `{"mode":"runtime"}`
on the same route if needed. `raw-scale` uses Recap's scale argument; the direct
`pinch-baseline` is explicitly a touch control, not indirect-transform evidence.

## Restore

POST `{"mode":"hide"}`. Check `visible:false`, `idleTimerHeld:false`,
`inFlight:false` and `outcomeUnknown:false`, and idle pan/pinch recognizers.
Stop only the manual server and experimental test runner. Open the normal installed
app so it starts the normal helper from `vendor/build`. Check ready/unlocked status
and that `/wda/mirror/indirect` returns 404. Restore the usual bounded keep-awake
lease promptly to avoid Auto-Lock during handoff. The installer test covers repeat
installation/removal and rejects an incompatible source anchor before mutation.

## Sources and limits

- [Apple TN3210](https://developer.apple.com/documentation/technotes/tn3210-optimizing-your-app-for-iphone-mirroring)
  documents receiving scroll and transform events from Apple's mirroring. It does
  not establish an injection API available to this helper.
- [UIPanGestureRecognizer.allowedScrollTypesMask](https://developer.apple.com/documentation/uikit/uipangesturerecognizer/allowedscrolltypesmask)
  describes the receiving recognizer's scroll-type opt-in.
- [Specifying a launch screen](https://developer.apple.com/documentation/Xcode/specifying-your-apps-launch-screen)
  covers the launch-screen dictionary used for the native-size control.

Private XCTest/Recap selectors were inspected in the current device runtime and
are exploratory. This is a one-phone capability probe, not a supported API or a
latency percentile benchmark. No normal user-facing setting was added.
