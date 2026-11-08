# Independent helper verification

The owned runner targets iOS/iPadOS 17. It uses XCTest, SwiftNIO 2.99.0 and
NIOTransportServices 1.28.0. Apple runtime interfaces and Objective-C exception
handling are confined to `ios/Helper/AppleCompatibility`.

## Behavioral inventory

| Responsibility                          | Implementation and checks                                                                                                                                                                         |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Authentication, build and boot identity | One authenticated HTTP listener on 8100; `/v1/status`, `/v1/commands`, `/v1/events`, `/v1/video`; shared native/Effect contract fixtures; credentials rejected before execution or capture        |
| Ownership and recovery                  | Explicit lifecycle reducer, serialized bounded executor, queued cancellation, retained ownership after timeout, unknown outcomes, duplicate-command receipts, bounded recovery, generation checks |
| Input                                   | Touch paths, two-finger paths, Unicode, HID navigation/modifiers, orientation guards, Home, volume, lock/unlock, launch, Siri and keep-awake                                                      |
| Inspection                              | Normalized snapshots, seven selectors, XPath with external access disabled, class chains, guarded predicates, temporary identity-bound handles, attributes and targeted actions                   |
| Observation                             | Public source formats, screen/element screenshots, waits, stability checks, observation guards and receipts remain Mac-side                                                                       |
| Clipboard                               | Explicit transfers, permission-aware asynchronous reads, bounded content, transfer leases, foreground restoration and stale-transfer rejection                                                    |
| Media                                   | Subscriber-driven asynchronous screenshot capture, quality presets, shared latest frame, bounded capture ownership and backpressure; existing native video/audio transport retained               |
| Status and packaging                    | Existing branded status screen and standalone launch; direct owned-project build, signed relocatable runner, bundled dependency notices and compiled Bun server                                   |

## Measured latency

Physical iPhone on iOS 27.3; 30 taps per row. Host monotonic timestamps measure API
dispatch to acknowledgement and the first changed MJPEG frame of a controlled
fixture color toggle. These are **not** mouse-to-Mac-panel measurements. USB rows
mean the cable was attached; this device's control tunnel uses Apple's paired
transport. Every dispatched tap produced an observed visual change.

| Helper / route   | Ack median / p95 (ms) | Changed frame median / p95 (ms) |
| ---------------- | --------------------- | ------------------------------- |
| Previous / USB   | 294.0 / 299.9         | 170.2 / 191.1                   |
| Owned / USB      | 278.5 / 285.3         | 134.0 / 168.2                   |
| Previous / Wi-Fi | 306.2 / 388.3         | 185.2 / 275.2                   |
| Owned / Wi-Fi    | 319.9 / 373.1         | 139.6 / 178.4                   |

These first owned measurements used an incorrectly undersized fallback image
(201 × 437 instead of 603 × 1311 at the balanced preset on the test phone).
They are retained as diagnostic results, **not a quality-matched performance
acceptance**. Re-measure after the Retina scaling correction before final cutover.

The first owned implementation regressed fallback video. Removing accessibility
label queries from input guards, moving encoding off the input thread, and
awaiting Apple's screenshot callback directly resolved that regression. The
50 ms input confirmation setting is unchanged.

## Verification status

- Simulator CI pins Xcode 27.2 and iOS 26.5 and connects its disposable phone
  to DeviceHub for hardware-key input. The full API fixture checks the actual
  iPortal input path, including exact text results and keyboard stability.
  `IPORTAL_SIMULATOR_RUNTIME=26.5 bun run test:simulator` selects that installed
  runtime explicitly; other runs select a compatible phone within the active
  SDK release. A missing requested runtime fails rather than silently changing
  the test target.
- Native host tests cover strict contracts, authentication, parser limits,
  callback races, cancellation, duplicate commands, queue deadlines and retained
  ownership after stalls.
- Public API, simulated multi-device, transport/capture lifecycle and relocated
  packaged-server tests pass without a development runtime on the executable's
  `PATH`.
- A fresh iOS 26.5 simulator and the physical phone passed the controlled fixture
  checks: all selector strategies, ambiguity and error behavior, attributes,
  source formats, screenshots, receipts, stale handles, waits, alerts, scrolling,
  Unicode, selection, character navigation, deletion and foreground transitions.
- Physical recordings traced keyboard collapse to Recap Unicode injection:
  UIKit reports a transient hardware keyboard while the editor retains focus.
  Ordinary text now uses Apple's accessibility insertion action on the existing
  focused editor. A fresh-field recording verified character insertion, Command-A,
  Left Arrow and Backspace with zero keyboard dismissals or focus losses; Unicode,
  punctuation, multiline and WebKit insertion also changed the expected text.
  A subsequent 30-command character burst produced the exact expected text with
  zero dismissals and zero focus losses. HID navigation and shortcuts retain the
  existing native event path. The user then confirmed that typing and deleting
  through the Mac keyboard keeps the keyboard open in the original affected app.
  The updated iOS 26.5 simulator passed all 18 fixture checks and clipboard
  roundtrip/foreground restoration; physical editor checks passed separately.
- Native secure fields ignore ordinary accessibility insertion. They now use the native
  software-keyboard character action, without activating the app or using the
  clipboard. A committed string is serialized character by character under one
  command owner and retains its original keyboard target. No uncertain mutation
  is retried.
  For native password fields, the tested alphabet is printable ASCII, precomposed Latin-1 letters, and
  `¡¢£¥§«°»¿`. Other characters are rejected before dispatch: the native keyboard
  action can acknowledge them while silently dropping them. **Full Unicode
  input in native password fields remains unresolved**, including CJK, emoji and decomposed
  combining sequences. WebKit password fields are identified by their focused
  accessibility element before dispatch and retain WebKit's Unicode insertion
  path, as do ordinary fields.
  The final physical editor run passed exact insertion, selection, cursor movement,
  deletion and rejection-before-mutation checks without keyboard dismissals or
  unexpected focus losses. The updated iOS 26.5 simulator passed all 18 fixture
  checks plus clipboard roundtrip and foreground restoration.
- WebKit password insertion preserves CJK, Arabic, Devanagari, combining marks
  and emoji. The physical phone's on-screen Delete key and mirrored Backspace
  both split a complex emoji's surrogate pair in a secure field; the fixture
  compares these independent paths rather than claiming grapheme-safe password
  editing. Ordinary multiline/WebKit fields do pass grapheme deletion checks.
- The secure alternatives/dictation action was rejected despite inserting exact
  Unicode: subsequent editing could clear the entire value or split a surrogate
  pair. Its property-list encoder also exposed a 32-bit/64-bit output-size ABI
  mismatch in a simulator test, causing a buffer-unmap crash. That experimental
  encoder and action are removed from the maintained helper. Empty insertion,
  selection refresh and keyboard-delegate notifications did not repair the
  secure editor's behavior; no such workaround ships.
  Apple's synthesized text-input path was also rejected after hiding the keyboard
  and timing out on Unicode. Simulator HID shortcuts attach the host keyboard,
  so their notification counts are separated from physical-device stability
  checks; text insertion itself must remain stable on both.
- Duplicate Apple accessibility identifiers no longer form dictionary keys.
  XPath uses unique snapshot paths; native element binding remains separate. A
  regression test covers the simulator crash caused by duplicate identifiers.
- Clean source-export builds fetch only declared dependencies and build the
  owned project. Bundle signatures, protocol/build identity, removed dependency
  names and automation class symbols have been checked.

- Physical clipboard text roundtrip and foreground restoration passed. A short
  keep-awake lease expired as expected. Intentional helper termination recovered
  in about 11 seconds without terminating the fixture app.
- The user confirmed picture, scrolling, rotation and audio, smooth USB/Wi-Fi
  handover, and recovery after phone lock/unlock and Wi-Fi loss/restoration.
- Native HEVC frames included codec padding with no declared clean aperture.
  The viewer now carries authenticated native display dimensions and excludes
  that padding before rotation. The test phone presents 1206 × 2622 pixels
  instead of the padded 1216 × 2656 buffer. Crop/rotation tests cover all four
  orientations; fallback JPEG tests check encoded Retina pixel dimensions.
- Physical Mac sleep/wake was deferred at the user's request. iOS 17 compilation
  and capability fixtures do not establish physical parity on older devices.
  No second physical device or iPad has been tested in this replacement run.

## Reproduction

Run `bun run verify`, `swift test --package-path ios/Helper`, and
`bun run test:simulator`. The simulator harness creates and deletes its own
device and uses the independent fixture app.

For physical tests, build/install `iPortalFixture`, launch it afresh, and run
`scripts/test-helper-fixture.ts` with its bundle identifier. The fixture keeps
itself awake while foreground; it does not change the device's Auto-Lock
preference. `scripts/benchmark-helper.ts` records the same 30-sample methodology
against the active local API. Test only the controlled fixture, sequentially on
each physical device.

## Apple API follow-up

The API follow-up keeps the production UI and transport choice unchanged:

- Renderer backpressure retains the newest frame until capacity returns, including
  the final update of an idle screen. Flush recovery keeps the displayed image,
  bounds retries, and rejects callbacks from a retired renderer generation.
- USB capture and paired decoding opt into native YUV only for confirmed 8-bit
  SDR. Unknown or HDR inputs retain the established BGRA path. Snapshot and
  crop/rotation checks cover full- and video-range YUV.
- Paired HEVC decoding admits two frames asynchronously, preserves reference
  packets, and bounds retiring decoder resources across replacement receivers.
  Audio route changes recover on the audio owner's queue. The established
  120 ms priming floor, 240 ms backlog cap and `dataConsumed` accounting remain.
- Inspection retains enriched snapshots, selector ordering, duplicate handling,
  attribute types and stale-handle checks. Traversal is iterative and predicate
  syntax is checked once per expression in a query. Skipping source-only
  metadata was explored but withheld after intermittent full-sequence simulator
  tap failures; causation was not established and no speedup was measured.
- `open-url` accepts validated HTTP(S) links through the existing guarded command
  queue and receipt contract. Native and Effect validation share malformed-link
  fixtures. `bun run test:simulator --accessibility-audit` explicitly audits only
  the owned fixture; findings are reported, not silently suppressed or treated as
  a zero-issue accessibility pass.

The automated run passed 120 Bun tests, 26 native core tests, end-to-end and
multi-device checks, media/capture/lifecycle harnesses, and relocated packaging.
The hardware HEVC fixture decodes 30 reference-dependent frames and checks final
pixels, native format, crop/rotation colors and drained teardown. Pending-callback
retirement is covered separately by the ownership harness; this is not a
physical iPhone capture or end-to-end interaction benchmark.

Full snapshot normalization passed all 21 controlled fixture checks on a
disposable iOS simulator, including fallback streaming followed by input. Both
normalization variants also passed ten fresh-process tap/alert trials each; that
did not explain the intermittent failures in the omitted-metadata variant's full
sequence. The final implementation retains full normalization. A separate native
URL check opened Safari and restored the fixture. The optional accessibility
audit reported seven fixture findings (Dynamic Type, clipping and contrast),
which remain diagnostic findings rather than a clean accessibility result.

The isolated input recorder passed direct-touch calibration on iPhone and iPad
simulators running iOS 26.5. Apple reported pointer interaction unavailable on
the iPhone; the iPad delivered actual indirect-scroll events. The iPad harness
was then interrupted at the user's request because the Mac was running hot, so
its overall run is incomplete. Raw continuous-contact probes were not enabled.
The owned simulators and test processes were cleaned up; further local builds,
simulator runs and benchmarks are deferred.

Separate [bridge probes](../experiments/apple-bridge/README.md) cover iOS 27
ScreenCaptureKit, observed indirect/raw input and authenticated Network.framework
transport. They are not linked into the app. Phone capture consent, continuous
contact, quality-matched USB/Wi-Fi latency, audio routing, handover and sleep/wake
checks remain deferred. The builds have not been installed for this follow-up.
