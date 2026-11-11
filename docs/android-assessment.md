# Android support assessment

Status: research only, 2026-11-10. No production code was changed. Measurements
come from one phone: a Pixel 6a on Android 17 (API 37, user build), connected by
USB to this Mac, using adb 37.0.1. The probe is in
[`experiments/android-probe`](../experiments/android-probe/README.md).

## Recommendation

**Proceed. Android can reach feature parity with much less setup than the iPhone
path, and several things work better.** Build an owned on-device agent that runs
as the adb `shell` user through `app_process` (architecture B below), and put it
behind the existing helper contract.

Why this is the right route:

- **Setup is two toggles and one tap on the phone.** There is no Xcode on the
  device side, no Apple Account, no signing, no helper install and no seven-day
  expiry. The Mac needs `adb` (a 15 MB download).
- **Every core mechanism worked on the connected phone** without installing
  anything on it: hardware H.264 and HEVC video, system audio capture, live touch
  and two-finger input, clipboard, UI tree, element actions, Unicode text,
  screenshots, lock and wake.
- **Input is live.** Android accepts each touch event as it happens, so drags and
  pinches can track the pointer instead of taking effect when the gesture ends.
- **The seam already exists.** The server reaches the iPhone helper through one
  authenticated HTTP contract (`helper-protocol.ts`), and has a `--helper-url`
  mode that skips Apple discovery and launch.

What stands in the way is contract and Mac-app work, not Android capability:

- The helper contract names iOS concepts (`XCUIElementType…` types, predicate and
  class-chain selectors, `UIA_DEVICE_ORIENTATION_*`, `siri`). It needs a
  platform-neutral revision.
- The Mac app finds devices by Apple's USB vendor ID and gets USB video from
  CoreMediaIO, which Android does not provide.
- USB to Wi-Fi handover is unbuilt, though a test stream switched transports in
  under 300 ms on a real cable pull.

Three things are worse on Android and will stay worse:

- Apps that mark windows secure (banking, password managers, incognito tabs)
  mirror as black.
- Behaviour varies by manufacturer.
- The agent depends on hidden framework APIs that can change with each release.

## What was verified

"Verified" below means observed on the Pixel 6a in this session. Everything else
is from current documentation or inferred, and is marked so.

Not verified, and why:

- **Handover of real video and input.** The cable-pull test carried a text
  ticker only. See [Wi-Fi results](#wi-fi-results).
- **End-to-end latency.** The probe measures on the phone only. Nothing was
  decoded or displayed on the Mac.
- **iPhone timings for comparison.** The iPortal server was not run in this
  session.
- **Other manufacturers, older Android versions, tablets and foldables.**

## Capability parity

| Capability                                        | iPhone today                                                               | Android mechanism                                                                                       | Verified on device                                                                                                              | Gap or difference                                                                     |
| ------------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Native video                                      | USB: CoreMediaIO capture. Wi-Fi: HEVC from CoreDevice display service      | Mirror virtual display into a hardware `MediaCodec` encoder, from a shell-user process                  | **Yes.** H.264 and HEVC at 1080×2400; first frame 90–165 ms after setup; stream validated with `ffprobe`                        | Secure windows are black. The stream must be restarted on rotation                    |
| Basic video (browser)                             | MJPEG from helper screenshots                                              | Same encoder stream decoded in the browser, or JPEG screenshots                                         | Partly. Screenshot plus JPEG took 105–145 ms, about 8 fps                                                                       | MJPEG at that rate is poor; the browser client should decode H.264 instead            |
| Audio                                             | USB: AVFoundation. Wi-Fi: AAC-ELD                                          | `AudioRecord` on `REMOTE_SUBMIX` (Android 11+), or playback capture (13+) to keep the phone audible     | **Partly.** Capture started in 70–250 ms and a test tone came through cleanly, but 36 dB quieter than its source                | Level problem unexplained. Not possible on Android 10 or older                        |
| Tap, long press, swipe                            | XCTest event path, played after the gesture ends                           | `InputManager.injectInputEvent`, one event at a time                                                    | **Yes.** All accepted; 1 ms per event, 3–4 ms when waiting for delivery                                                         | Better: live drags                                                                    |
| Pinch                                             | Two-finger path, played whole                                              | Same injection with two pointers                                                                        | **Yes**, accepted. Effect on screen not checked                                                                                 | Better: live                                                                          |
| Text entry                                        | XCTest HID keyboard, Unicode                                               | Key events (ASCII), `ACTION_SET_TEXT` (whole field), or a virtual hardware keyboard through `/dev/uhid` | **Partly.** Unicode `ACTION_SET_TEXT` set and read back. Shell is in the `uhid` group; uhid not exercised                       | Inserting arbitrary Unicode at the cursor needs a paste or an installed input method  |
| Editing keys and shortcuts                        | HID keys with modifiers                                                    | Key events with Ctrl in place of Command                                                                | No                                                                                                                              | Standard Android behaviour; per-app support varies, as on iOS                         |
| Clipboard, text and links                         | `UIPasteboard`; helper comes to the foreground; iOS may ask to Allow Paste | `IClipboard` called as `com.android.shell`                                                              | **Yes.** Read, write and clear in 1–4 ms; no prompt, no app switch                                                              | Better                                                                                |
| Clipboard, images                                 | PNG through the pasteboard                                                 | Needs a `content://` URI from a provider                                                                | No                                                                                                                              | Likely needs an installed companion app. Open question                                |
| App launch, open URL                              | `XCUIApplication.activate`, system open                                    | `am start` by package or URL                                                                            | **Launch yes** (316 ms). URL not tried                                                                                          | Package name fills the `bundleId` field                                               |
| Home, App Switcher, notifications, quick settings | Home press and edge swipes                                                 | Key codes and `cmd statusbar expand-*`                                                                  | Home yes. The `statusbar` commands exist; not run                                                                               | Android also needs **Back**, which the contract lacks                                 |
| Siri                                              | `siriService.activate` with text                                           | Assistant key only                                                                                      | No                                                                                                                              | No equivalent for a text request                                                      |
| Orientation follows device                        | Helper reports orientation                                                 | Display rotation from the window manager                                                                | Read yes. A rotation during a stream was not exercised                                                                          | Android can also set rotation                                                         |
| Lock, wake, volume                                | HID consumer keys                                                          | `KEYCODE_SLEEP`, `WAKEUP`, `VOLUME_*`                                                                   | **Yes** for sleep and wake. Volume down changed the level; one volume up press did not                                          | Minor: volume key behaviour to pin down                                               |
| Lock state                                        | Notify state, `devicectl` when the helper is down                          | Trust manager and keyguard state                                                                        | **Yes**                                                                                                                         | None                                                                                  |
| Use while locked                                  | Not possible; mirror waits for unlock                                      | Lock screen is mirrored, takes input and exposes its PIN pad in the UI tree                             | **Yes.** Frames, drags and the tree all worked on the lock screen                                                               | Different: the user can unlock from the Mac. iPortal must never store or replay a PIN |
| Keep awake                                        | Idle HID pulse; no setting changed                                         | User-activity pulse, wake lock, or the stay-on setting                                                  | No. The phone already had "Stay awake" on                                                                                       | Which option avoids changing a setting is open                                        |
| Screenshot                                        | `XCUIScreen` PNG                                                           | `UiAutomation.takeScreenshot`                                                                           | **Yes.** 80–125 ms capture. `screencap -p` took 1.6–1.9 s; avoid it                                                             | None                                                                                  |
| UI tree                                           | XCUIElement snapshot                                                       | `UiAutomation.getRootInActiveWindow`                                                                    | **Yes.** 155 nodes in 83 ms first time, 3–8 ms after. `uiautomator dump` took 2.2–2.5 s; avoid it                               | Selectors and type names differ; see Fit                                              |
| Element actions                                   | XCTest element actions; slider is approximate                              | `AccessibilityNodeInfo` actions                                                                         | **Click and set text yes.** Focus, long press, scroll and set progress not tried                                                | Slider can be set exactly                                                             |
| Mac accessibility bridge                          | Reads `/api/observe`                                                       | Same, once the tree is mapped                                                                           | No                                                                                                                              | Needs an Android role table                                                           |
| USB discovery                                     | usbmuxd socket                                                             | adb server socket, `host:track-devices`                                                                 | **Yes** for `host:devices-l` over raw TCP and for a forward to a device socket                                                  | Many vendor IDs; ask adb, do not match USB IDs                                        |
| Wi-Fi                                             | CoreDevice tunnel, iOS 27+                                                 | Wireless debugging, Android 11+                                                                         | **Yes.** Connected with no pairing step after USB authorisation; probe ran over Wi-Fi                                           | One toggle and one prompt on the phone; see Setup                                     |
| USB to Wi-Fi handover                             | Same window and session                                                    | Reconnect to the same agent over the other transport                                                    | **Yes, one sample.** A test stream switched from USB to Wi-Fi 283 ms after a real cable pull; the detached process kept running | Unbuilt. Video and control across the switch not yet shown                            |
| Recovery after lock or reconnect                  | Helper relaunch through `xcodebuild`                                       | Restart the agent                                                                                       | Partly. A probe run reached its first frame within 165 ms of starting                                                           | Likely much faster than iPhone; not compared                                          |
| Several devices                                   | One server per UDID                                                        | One server per adb serial                                                                               | No, one device attached                                                                                                         | None expected                                                                         |
| Status shown on the phone                         | Helper app screen                                                          | None; the agent has no UI                                                                               | No                                                                                                                              | Could post a notification. Minor                                                      |

### Timing detail

All measured on the phone, over USB:

| Measurement                                               | Result                                       |
| --------------------------------------------------------- | -------------------------------------------- |
| Injected drag to next encoded frame, H.264, Settings list | 55–66 ms, eight samples                      |
| Same, HEVC                                                | 58–65 ms, plus one first sample of 97 ms     |
| Same, H.264, lock screen                                  | 40–56 ms                                     |
| `adb shell` round trip from the Mac                       | 23–31 ms                                     |
| `adb shell input` tap or swipe from the Mac               | 45–95 ms; too slow and coarse for live input |

scrcpy's README states 35–70 ms end to end. That is their claim, not measured here.

## Setup the user would need

### Android, USB

1. Settings → About phone → tap **Build number** seven times.
2. Settings → System → Developer options → enable **USB debugging**.
3. Connect by USB and tap **Allow** on the phone. Ticking "Always allow from this
   computer" makes it permanent.

On the Mac, `adb` must be present. It is not installed by default; on this Mac it
existed only inside an Android SDK folder that was not on `PATH`.

Known extras, from scrcpy's documentation: some Xiaomi phones need a second
option, **USB debugging (Security settings)**, before input works, plus a reboot.

### Android, Wi-Fi

Android 11 or later, both devices on the same network.

1. Complete USB setup first.
2. In Developer options, enable **Wireless debugging** and tap **Allow** for the
   current network. The phone must be unlocked for this prompt.

No pairing code was needed on the test phone: the computer's USB authorisation
was accepted over Wi-Fi. The documentation does not promise this, so treat the
documented route, pairing once with a QR code or six-digit code, as the fallback.
A computer that has never been connected by USB must pair.

### Wi-Fi results

Verified on the Pixel 6a (Android 17) with adb 37.0.1, Mac and phone on the same
/24 network:

- **Enabling.** Setting `adb_wifi_enabled` from the shell was not enough while the
  phone was locked. The service started only after the owner unlocked the phone
  and allowed the network.
- **Discovery.** The phone then advertised `_adb-tls-connect._tcp` over mDNS with
  its USB serial in the record and `mdns_service_version: "2.1"`, which is adb
  Wi-Fi 2.0. The shared serial lets iPortal match the Wi-Fi and USB identities.
- **Connecting.** `adb connect <address>:<port>` succeeded with no `adb pair`,
  in 338 ms once the cable was out. adb never connected over Wi-Fi by itself:
  not while USB was attached, not for 15 seconds after the cable was pulled, and
  not for 20 seconds after restarting the adb server, although the phone was
  visible over mDNS throughout. Without pairing, iPortal must issue the connect.
  Whether a paired computer is connected automatically was not tested.
- **Two transports at once.** USB and Wi-Fi appeared as two adb devices with
  different serials (`25271JEGR16740` and `192.168.2.72:41811`).
- **Cost.** An `adb shell` round trip took 39–45 ms over Wi-Fi against 27–38 ms
  over USB. A four-second 8 Mbit/s H.264 recording arrived complete over both.
  The probe's on-device timings were unchanged (59–64 ms drag to encoded frame).
- **Handover building blocks.** A process started with `nohup` over Wi-Fi kept
  running after that connection was closed; one started in the foreground died
  with it. A single listener on the phone answered through a forward on each
  transport.
- **Handover on a real cable pull, one sample.** A detached process on the phone
  sent a line about every 80 ms. The Mac read it through a USB forward, with the
  Wi-Fi transport connected in standby. When the cable was pulled, the USB
  socket closed within 69 ms of the last line and adb had already dropped the USB
  device. The first line over Wi-Fi arrived 283 ms after the last one over USB.
  About 110 ms of that was the test's own device query, so the switch itself
  cost roughly one missed line. Replugging made the USB device appear again
  while Wi-Fi stayed connected. This was a text ticker, not video: a video stream
  would also wait for the next keyframe.

### Compared with iPhone

|                                  | iPhone                                                                          | Android                                           |
| -------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------- |
| Mac software for the device side | Full Xcode 27+, Bun, Rust for Wi-Fi                                             | `adb`                                             |
| Account                          | Apple Account and development certificate                                       | None                                              |
| Phone settings                   | Trust, Developer Mode with restart, developer-app trust, UI Automation passcode | Developer options, USB debugging, Allow           |
| Installed on the phone           | Signed helper app                                                               | Nothing; a small file pushed to temporary storage |
| Expiry                           | Seven days on a free account                                                    | None                                              |
| Wi-Fi                            | iOS 27+, Apple silicon, prior USB setup                                         | Android 11+, one toggle                           |
| OS floor                         | iOS 17                                                                          | Android 5 for video and input; 11 for audio       |

Friction that is specific to Android:

- Developer options are hidden behind the build-number taps.
- Some banking and work apps refuse to run while USB debugging is on. (General
  knowledge, not tested.)
- Managed devices can forbid USB debugging.
- Android 17's Advanced Protection mode restricts USB data and accessibility
  services. Whether it blocks USB debugging itself was not confirmed.

## Fit with the existing code

### Reusable as is

- Command queue, receipts, waits, observations, status events, diagnostics:
  `scheduler.ts`, `commands.ts`, `inspection.ts` (logic), `status-events.ts`,
  `observability.ts`.
- `helper-client.ts`. It already speaks to the helper over a Unix socket; an adb
  forward is a third way to fill that socket, next to usbmuxd and the paired tunnel.
- The public HTTP API and the browser client's input handling.
- The Mac window: display layer, web overlay, menus, settings, per-device server
  spawning.

### Needs an Android backend behind the helper contract

- **Discovery.** A watcher on the adb server socket, shaped like `usb-events.ts`.
  adb's `track-devices` is a push subscription, as usbmuxd's `Listen` is.
- **Launch.** Push the agent and start it with `app_process`, in place of
  `helper-launch.mjs`, `helper-startup.ts` and `startup-lock.mjs`. No build step.
- **Media.** `NativeMedia.swift` reads a 16-byte-framed stream of HEVC frames and
  AAC-ELD audio from `native-transport`. The agent can emit the same framing with
  HEVC, which the phone encoded in hardware. Audio needs either an AAC-ELD encoder
  on the phone (Android documents one; not tested) or a new PCM or Opus path on
  the Mac.
- **Mac device detection.** `USBMonitor.swift` matches Apple's vendor ID and
  `iPhone`/`iPad` product names; `DeviceNames.swift` calls `devicectl`.

### Contract changes

These are the places where `helper-protocol.ts` assumes iOS:

- Element `type` must match `^XCUIElementType…`. Android reports class names such
  as `android.widget.Button`.
- Selector strategies `predicate string` and `class chain` have no Android
  meaning. `id` (resource ID), `accessibility id` (content description), `class
  name` and `xpath` map cleanly.
- Orientation literals are UIAutomation names.
- `button` lacks Back and App Switcher. `siri` cannot be served.
- Serial formats: `canonicalUDID` expects Apple shapes, and wireless adb serials
  contain dots and colons.

`HelperStatusSchema.capabilities` already exists and is the natural place to
advertise what a backend supports.

### No equivalent, or materially worse

- Siri with a text request.
- Secure windows: black on Android. iOS has no general equivalent, so more apps
  are affected on Android.
- Image clipboard without an installed app (open).
- A status screen on the phone.

### Better on Android

Live touch, clipboard without prompts or app switching, exact slider values,
unlocking through the mirror, sub-second agent start, no signing or expiry.

## Candidate architectures

### A. Bundle scrcpy's server and speak its protocol

Ship `scrcpy-server` (Apache-2.0) and write an iPortal client for its video,
audio and control sockets.

- For: years of manufacturer workarounds; video, audio, input, clipboard and uhid
  keyboard already done; current release 5.0.1 (October 2026).
- Against: no UI tree, element actions, screenshots or app state, so a second
  on-device process is still needed for half the helper contract. Its protocol is
  documented as internal, changes between versions, and gives no receipts or
  guards. Two agents on one phone compete for the same input and display APIs.

### B. Owned shell-user agent behind the helper contract (recommended)

One Java or Kotlin program, pushed to `/data/local/tmp` and run with
`app_process`. It serves the helper contract on a device-local socket reached
through an adb forward, and streams video and audio in the framing the Mac
already reads.

- For: one contract, so receipts, guards, waits and the accessibility bridge work
  unchanged. Every mechanism it needs was verified in the probe, in about 400
  lines. Nothing to install or sign. Matches how the iPhone side moved from
  WebDriverAgent to an owned helper.
- Against: iPortal owns the manufacturer and version quirks that scrcpy has
  already solved. Those fixes can be ported under Apache-2.0 with attribution in
  `NOTICE`. Hidden APIs need re-checking on each Android release.

### C. Installed app with an accessibility service and MediaProjection, no adb

- For: no Developer options.
- Against: a screen-capture consent prompt every session since Android 14;
  restricted-settings and Advanced Protection blocks on sideloaded accessibility
  services; Google's developer verification for apps installed outside Play
  (enforcement reported as phased from late 2026; current status not confirmed);
  audio only from apps that allow capture; iPortal would have to build its own
  pairing and transport security. More friction and less capability than B.

### The adb dependency, for A or B

- **Use the adb server** over its local socket (verified). Simplest. The user
  installs platform-tools, or iPortal locates an existing copy. Google's SDK
  licence restricts redistributing the binary, so bundling it needs a licence
  check.
- **Implement the adb protocol in the Rust component.** No install, but it must
  handle USB, TLS and pairing, and it conflicts with a running adb server, since
  only one process can claim the phone's USB interface. Defer.

## Suggested order of work

1. **Spike:** agent streams HEVC into the existing Mac window and accepts live
   touch through an adb forward, started by hand with `--helper-url`. This settles
   end-to-end latency and the audio level problem.
2. **Contract revision:** platform-neutral types, selectors, orientation and
   buttons, with capability flags. Keep the iPhone helper passing.
3. **Backend:** discovery, launch, inspection, clipboard, keep-awake, recovery.
4. **Wi-Fi and handover:** start the agent detached, match transports by serial,
   and re-forward on the surviving transport. Test with real cable pulls.

## Risks and unknowns

- **Audio level.** The captured tone was 36 dB low regardless of media volume.
  It may be specific to audio played by a shell process; test with real app
  playback before relying on it.
- **Handover.** A test stream moved from USB to Wi-Fi in under 300 ms, once.
  Not yet shown: video and control surviving the switch, the Wi-Fi to USB
  direction, and behaviour on a weak network. adb did not fall back to Wi-Fi
  unaided, so iPortal must keep that transport connected in standby.
- **Wireless debugging in practice.** mDNS is blocked on some networks; the port
  changes each time the option is toggled (documented, not tested). Skipping the
  pairing step was seen on one Android 17 phone only.
- **Manufacturer variance.** One Pixel was tested. Samsung, Xiaomi and others
  differ in encoders, input restrictions and background limits.
- **Hidden APIs.** The probe needed version-specific lookups already (for example
  `InputManagerGlobal`, clipboard method signatures). Expect breakage per release.
- **Platform direction.** Android 17 is tightening accessibility and sideloading.
  Architecture B does not use either, but shell privileges could be narrowed later.
- **Security model.** The agent's socket should stay device-local with the
  existing bearer credential. Whether other apps on the phone can reach an
  abstract socket owned by the shell user was not checked.
- **Unlocking from the Mac** is new behaviour for iPortal and needs a deliberate
  decision about what the API may do on a lock screen.

## Sources

- [Android Debug Bridge](https://developer.android.com/tools/adb), including wireless debugging and adb Wi-Fi 2.0
- [scrcpy README](https://github.com/Genymobile/scrcpy/blob/master/README.md), [audio](https://github.com/Genymobile/scrcpy/blob/master/doc/audio.md), [developer notes](https://github.com/Genymobile/scrcpy/blob/master/doc/develop.md), [releases](https://github.com/Genymobile/scrcpy/releases)
- [Android 17 Advanced Protection and accessibility services](https://thehackernews.com/2026/03/android-17-blocks-non-accessibility.html)
- [Android developer verification timeline](https://www.androidauthority.com/android-sideloading-changes-timeline-3679204/)
