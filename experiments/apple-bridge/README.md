# Apple bridge experiments

These are separate test products. They do not change iPortal's UI, helper,
transport selection, signing identity, or permissions. The capture probe requires
an explicit choice in Apple's screen-sharing picker; existing automation trust
does not authorize capture through that API.

## Build and simulator checks

With Xcode 27.2 selected, run:

```sh
bun run test:apple-bridge
bun run test:apple-bridge --simulator
```

The first command builds unsigned device and simulator products targeting iOS 17.
The second also creates and deletes its own iPhone and iPad simulators sequentially,
calibrates the touch recorder, and records public indirect-scroll delivery when
`XCUIDevice.supportsPointerInteraction` allows it. Unsupported devices are reported
as skipped, not working pointer input. It never installs to a
physical phone or starts raw-input experiments. ScreenCaptureKit is absent from
the current simulator SDK; that tab reports its limitation explicitly.

Each run prints the private temporary log directory. The result bundle retains
observed input events. An acknowledged scroll without recorded scroll events is
a negative observation, not working realtime input. A known-working physical
indirect-input source remains necessary to rule out recorder/routing differences.

The initial iOS 26.5 simulator check calibrated direct touches on both device
families. The iPhone reported pointer interaction unavailable; the iPad recorded
actual indirect-scroll events. The overall iPad run was interrupted afterward
to stop local CPU load. This is recorder evidence, not iPhone pointer support or
continuous-contact acceptance. Raw probes stayed disabled.

## Physical capture probe

Open `BridgeProbe.xcodeproj`, select a development team and an unlocked test
device, and run the BridgeProbe scheme. This installs a separate probe app.
Open its Capture tab and choose full-display capture using Apple's picker.
There are no microphone or camera permission requests, and media stays in memory.

Observe native dimensions, orientation, capture sample age, system-audio arrival,
and bounded hardware-encoder timings. Test other foreground apps, rotation,
lock/unlock, background survival, cancellation, and restart consent. Encoded bytes
are discarded: this does not establish network streaming or protected-media
parity. Compare actual visible response separately from sample and encode timing.

The installed iOS 27.2 SDK marks `minimumFrameInterval`, `queueDepth`,
`pixelFormat`, and `updateConfiguration` unavailable on iOS despite broader web
documentation. The probe does not access them through runtime workarounds.

## Physical raw input probe

Use only an idle test phone and run only this probe's UI-test target, serially.
Set `IPORTAL_RAW_INPUT_PROBE=1` in the **test runner's** environment; with
`xcodebuild`, use the `TEST_RUNNER_IPORTAL_RAW_INPUT_PROBE` environment variable.
The normal build/simulator script explicitly disables that flag.

`testRawContinuousContact` first verifies a complete raw tap, then observes a
down-only request. If the system cancels it, the experiment stops. Move and end
chunks are attempted only while the recorder still reports contact. Unknown
outcomes or unresolved contacts block subsequent test setup; restart the isolated
runner before another experiment. Never replay an uncertain input.

`testRawCompletionTiming` records 30 taps each with 0 and 50 ms implicit
confirmation. Attachments distinguish native dispatch-to-touch onset, contact
duration, and completion tail. These values exclude the Mac UI, network path,
capture pipeline, and panel presentation. They are not end-to-end latency.

## Acceptance boundaries

Keep the existing production backend until a replacement passes quality-matched
video/audio/input, permission, lifecycle and transport tests. Run at least 30
samples per USB/Wi-Fi route, preserve the last frame through backpressure and
handover, and verify the final static update. Do not lower the proven 120 ms
audio priming floor until burst and handover measurements justify it. Verify
older-device and simultaneous-device behavior separately from host/simulator
tests.

Relevant Apple references:

- [ScreenCaptureKit on iOS](https://developer.apple.com/documentation/screencapturekit/capturing-screen-content-on-ios)
- [Low-latency VideoToolbox encoding](https://developer.apple.com/documentation/videotoolbox/encoding-video-for-low-latency-conferencing)
- [Indirect input in iPhone Mirroring](https://developer.apple.com/documentation/technotes/tn3210-optimizing-your-app-for-iphone-mirroring)
- [Choosing a networking API](https://developer.apple.com/documentation/technotes/tn3151-choosing-the-right-networking-api)

## Public network transport probe

```sh
bun run test:peer-transport
```

This compiles a separate macOS CLI, checks its shared API surface against the
iOS 17 SDK, and runs an authenticated TLS loopback test. It binds only
`127.0.0.1`, requires the loopback interface, and does not advertise, browse,
contact a phone, or accept a LAN endpoint. Random keys and identities exist only
in memory for that run. Build products are deleted afterward.

The probe validates 30 framed exchanges, generation/receipt ownership, a 64 KiB
frame limit before body allocation, malformed frames, wrong-key and wrong-identity
TLS failures, an admitted-request deadline, and cancellation after the server has
received the request. It records path/viability callbacks, establishment duration,
transport RTT and transferred bytes. Those timings describe loopback, not user
interaction or wireless latency. No better-path event is expected on loopback.

Apple's PSK interface supports TLS 1.2, not TLS 1.3 or QUIC. The probe pins
`TLS_PSK_WITH_AES_128_GCM_SHA256`; a TLS 1.3-only attempt failed before application
data, consistent with [TN3213](https://developer.apple.com/documentation/technotes/tn3213-moving-from-multipeer-connectivity-to-network-framework).
Wrong-key rejection must report a TLS authentication error; a connection close or
timeout alone does not pass. The test uses random printable identities after
arbitrary binary identities produced intermittent unknown-identity failures.

`includePeerToPeer` is configured but cannot prove AWDL discovery, iPhone
background survival, local-network permission behavior, route changes, or USB
handover. There is deliberately no peer mode or production integration. A real
device experiment first needs explicit identity pairing, scoped local-network
permission, and certificate provisioning if TLS 1.3/QUIC is the target; this
PSK-only cipher also does not provide forward secrecy for a reused key.
