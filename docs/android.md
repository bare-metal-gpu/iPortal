# Android

Status: first working slice. An Android phone can be mirrored and controlled from
the browser client, the local API and the Mac app. The Mac app has a native
video and audio path for Android that is built but not yet checked on a phone;
it falls back to basic video, without sound. The iPhone and iPad path is
unchanged.

Background and measurements are in the [assessment](android-assessment.md).

## Setup

On the phone:

1. Settings → About phone → tap **Build number** seven times.
2. Settings → System → Developer options → enable **USB debugging**.
3. Connect by USB, unlock the phone and tap **Allow**.

On the Mac you need Bun, `adb` (Android platform-tools), a JDK, and an Android SDK
with one platform and one build-tools version to build the helper.

```bash
bun install --frozen-lockfile
bun run setup:android
bun run start:android
```

`setup:android` compiles the helper into `vendor/android/iportal-agent.jar`. There
is no signing step and nothing expires. `start:android` opens the mirror at
http://localhost:7100. Use `--udid <serial>` to choose a phone and
`bun iportal.mjs devices --platform android` to list them.

For Wi-Fi, also enable **Wireless debugging** in Developer options and allow the
network. Once the phone is known over USB, iPortal connects the Wi-Fi route itself
and keeps it as a standby, so pulling the cable changes the route without ending
the session.

## How it fits together

One server process serves one device, as before. `--platform android` selects a
different device layer and helper; everything above them is the same code.

| Layer                                            | iPhone and iPad                     | Android                                 |
| ------------------------------------------------ | ----------------------------------- | --------------------------------------- |
| Public API, queue, receipts, waits, observations | shared                              | shared                                  |
| Request pipeline (`command-dispatch.mjs`)        | shared                              | shared                                  |
| Helper client, authentication, status events     | shared                              | shared                                  |
| Helper contract envelope and most operations     | shared                              | shared                                  |
| Vocabulary: selectors, element types, buttons    | `helper-protocol.ts`, `schemas.ts`  | `android/protocol.ts`                   |
| Discovery and tunnels                            | usbmuxd, CoreDevice (`iportal.mjs`) | adb server socket (`android/adb.mjs`)   |
| Device identity across routes                    | UDID                                | hardware serial (`android/devices.mjs`) |
| Helper                                           | signed XCTest runner (`ios/Helper`) | shell-user program (`android/agent`)    |
| Helper start                                     | `xcodebuild test-without-building`  | push a jar, run `app_process`           |
| Server composition                               | `iportal.mjs`                       | `android/server.mjs`                    |

The two platforms are not folded into one model. Each keeps its own vocabulary
and its own device layer. What they share is what was already the same: the
authenticated helper envelope (`/v1/status`, `/v1/commands`, `/v1/events`,
`/v1/video`), the operation shapes, and the server pipeline.

### The Android helper

`android/agent` is a small Java program. iPortal pushes it to
`/data/local/tmp` and starts it with `app_process` as the adb shell user. Nothing
is installed on the phone and the phone shows no prompt beyond USB debugging.

- It listens on a device-local socket. The Mac reaches it through the adb server,
  one stream per connection, without opening a port on the Mac.
- It requires the same per-session bearer credential as the iPhone helper. The
  credential is passed on standard input, not on a command line.
- It is detached from the adb connection that started it, so it survives a route
  change. It exits by itself 45 seconds after the Mac stops talking to it.
- It uses hidden framework APIs through reflection. These can change between
  Android releases.

### The Mac app

`bun run app` builds the Android helper when a JDK and an Android SDK are present
and bundles it in the app; without them the app is built without Android support,
as it is without the paired transport.

- **Discovery.** The app's device monitor runs the bundled server as
  `devices --platform android --watch` and reads one JSON inventory line per
  change, the way it reads paired iPhones from the native transport. This starts
  the adb server if `adb` is installed.
- **Device list.** An Android phone is one row, whether it is reachable over USB,
  Wi-Fi or both. Plugging in the cable can invite mirroring, as for an iPhone.
- **Window.** The session starts its server with `--platform android` and takes
  its picture from the helper. Window sizing, the toolbar, keyboard and clipboard
  menus are the existing ones.

### Native media

The helper also serves `/v1/media`: the display mirrored into a hardware HEVC
encoder (H.264 where there is none) and the phone's playback sound, as the
16-byte-framed records the Mac already reads from the iPhone transport. The
session server relays it at `GET /media`, because only that process holds the
helper's socket and credential and follows its route changes. The Mac window
reads it with the same decoder, display layer and audio queue as a paired
iPhone, and falls back to basic video when it fails, retrying later.

| Kind | Payload                                                               |
| ---- | --------------------------------------------------------------------- |
| 1    | One frame, length-prefixed NAL units. Flag 1 is a keyframe. 90 kHz.   |
| 2    | HEVC VPS, SPS, PPS, each length-prefixed. Replaces the decoder.       |
| 7    | JSON capabilities; `audio` is `unavailable` when capture was refused. |
| 8    | The frame with this time is still what the screen shows.              |
| 9    | Android only: 480 frames of 48 kHz stereo 16-bit little-endian PCM.   |
| 10   | Android only: H.264 SPS, PPS, each length-prefixed.                   |

- **Rotation.** The helper encodes the screen as it is rotated. A rotation is a
  new encoder at the new size, which sends new parameter sets and a keyframe.
- **Still screen.** Kind 8 twice a second keeps the stream alive, and the helper
  has the system redraw the display every two seconds so there is a real frame.
- **Sound.** PCM, not AAC-ELD: the phone's encoder makes 512-sample low-delay
  frames, the Mac's packet clock counts 480, and a local link has the room.
  Silence is not sent. Capturing sound silences the phone, so **View → Play
  Android Audio** switched off asks for a stream without it (`/media?audio=0`).
- **Sound level.** The capture is the remote submix with the framework's
  `fixedVolume` tag, which a plain `REMOTE_SUBMIX` record lacks; that is the
  likely cause of the quiet capture in the assessment. If the phone refuses it,
  the helper tries a loop-back audio policy mix (Android 13 and later).
  `adb shell setprop debug.iportal.audio submix|playback|off` picks one path;
  the helper logs the path and peak levels in `/data/local/tmp/iportal-agent.log`.

## What differs for API clients

`GET /api/status` and `/api/health` report `"platform": "android"`. Requests and
responses have the same shapes as on iPhone, with these differences:

- **Selectors.** `accessibility id` (content description), `id` (resource ID, full
  or the part after `:id/`), `name` (text or content description), `text`,
  `class name`, and a subset of `xpath` (see [XPath selectors](#xpath-selectors)).
  `predicate string` and `class chain` are iPhone-only.
- **Element types** are Android class names, for example `android.widget.Button`.
- **Bounds** are in pixels.
- **Buttons.** `home`, `volumeUp`, `volumeDown`, plus `back`, `appSwitch`,
  `notifications`, `quickSettings` and `search`.
- **Applications** are identified by package name in the existing `bundleId` and
  `expectedApp` fields.
- **Keyboard.** `command` is sent as Control, which is what Android apps use for
  copy, cut, paste, undo and select all.
- **Siri** is not available; `/api/siri` returns 404.
- **Clipboard** transfers need no prompt and do not switch apps. Images go both
  ways (see [Image clipboard](#image-clipboard)).
- **Live touch.** `POST /api/pointer` sends a stroke one event at a time. It
  exists on Android only (see [Live touch](#live-touch)).
- **Lock screen.** A locked phone with its screen on is `lifecycle: "ready"`
  with `locked: true`, and takes input (see [The lock screen](#the-lock-screen)).

## Live touch

The browser page and the Mac window send touch as it happens: the phone follows
the pointer during a drag, a trackpad scroll or a pinch, instead of replaying
the gesture after it ends. `/api/gesture` and `/api/pinch` still work and are
what the iPhone path uses.

```bash
# One finger down, moved, and lifted. Use one stroke ID for the whole stroke.
curl -s localhost:7100/api/pointer -H 'Content-Type: application/json' \
  -d '{"stroke":"s1","phase":"down","points":[[0.5,0.7]]}'
curl -s localhost:7100/api/pointer -H 'Content-Type: application/json' \
  -d '{"stroke":"s1","phase":"move","points":[[0.5,0.5]]}'
curl -s localhost:7100/api/pointer -H 'Content-Type: application/json' \
  -d '{"stroke":"s1","phase":"up","points":[[0.5,0.3]]}'
```

- `phase` is `down`, `move`, `up` or `cancel`. `points` holds one or two
  fingers as `[x, y]`, normalized in the current orientation. `down` and `move`
  need it, `up` may give a final position, `cancel` takes none. A stroke may
  gain or lose its second finger between events.
- `down` accepts `expectedApp` and `expectedOrientation` and checks the screen
  state, as a gesture does. Later events only check that the screen is still on
  and has not rotated. A drag may change the foreground app.
- The reply is `{"ok":true}` once the phone has taken the event. Send the next
  event after the reply.

A stroke is many small events, so it is handled differently from an action:

- **No receipts, no replay.** An event has no `requestId` and nothing about it
  is recorded. If an event fails or its reply is lost, do not send it again. The
  stroke is over and the finger has been lifted. Later events for that stroke
  return HTTP 409 with code `stroke ended`.
- **It always ends with the finger up.** A stroke ends on `up` or `cancel`, when
  an event fails, after 2 seconds without an event, after 60 seconds in total,
  when another stroke or any other input begins, when the route to the phone
  changes, and when the session closes. Every ending except `up` cancels the
  touch, so it cannot land as a tap. The helper applies the same 2-second rule
  by itself, so a finger is lifted even if the Mac disappears. To hold a finger
  still for longer, repeat its position; the page does this every 500 ms.
- **It owns the queue.** `down` waits its turn like any input, for at most 5
  seconds. From then until the stroke ends, nothing else runs: no inspection and
  no other input can come between two events of one stroke. Requests that
  arrive meanwhile wait, and their own timeouts keep running.

The page sends at most one `move` per 16 ms and only while the previous event
has been answered; positions in between are dropped in favour of the newest.
A mouse wheel puts a finger down at the first notch and lifts it 80 ms after the
last. A scroll that runs out of screen is cancelled and gripped again at its
starting point, which leaves the content where it is instead of flinging it.

## XPath selectors

`xpath` selects against the same tree `/api/source` returns, with these names:

- **Steps.** Absolute paths of `/` (child) and `//` (descendant) steps. A step
  is a class name (`android.widget.Button`), `*`, or `node`.
- **Attributes.** `text`, `content-desc`, `resource-id`, `class`, `package`,
  `index`, `checkable`, `checked`, `clickable`, `enabled`, `focusable`,
  `focused`, `scrollable`, `long-clickable`, `password`, `selected`,
  `displayed`, and iPortal's `label`, `value` and `visible`. Flags compare with
  `'true'` and `'false'`. A password field's `text` is always empty.
- **Predicates.** A position (`[2]`, `[last()]`), comparisons with `=`, `!=`,
  `<`, `<=`, `>`, `>=`, `contains()`, `starts-with()`, `text()`, `position()`,
  `not()`, `and`, `or`, and several predicates in a row.
- **One parenthesized path** with predicates: `(//android.widget.Button)[2]`.

```json
{ "selector": { "using": "xpath", "value": "//android.widget.Button[@text='OK']" } }
```

The Mac accessibility bridge's paths (`/*[1]/*[3]/*[2]`) are in this subset.
Everything else fails with `invalid selector` (HTTP 400) rather than matching
something: other axes (`..`, `parent::`), unions, arithmetic, other functions,
a bare `[@text]`, and relative paths.

## Image clipboard

`clipboard-write` and `clipboard-read` carry `image` on Android within the
existing contract and limits (base64, 4 MiB, 20 megapixels).

The helper is not an installed app, so it has no content provider of its own to
serve a picture from. It works as the shell user instead:

- **To the phone.** The picture (PNG or JPEG) is stored in the phone's media
  store under `Pictures/iPortal`, and the clipboard is given that item's
  `content://` address. The picture is therefore visible in the phone's
  gallery. iPortal keeps only the latest one and removes the previous.
- **From the phone.** Reading the clipboard grants the shell user access to the
  copied item's address. The helper opens it through the activity manager, the
  way the `content read` shell command does, and returns PNG. A picture too
  large for the limits is scaled down by halves until it fits.

If the phone refuses either step, the transfer fails with `unsupported
operation` and a message saying which step. Neither direction has been run on a
phone yet; see [Not verified](#verified).

## The lock screen

Android mirrors its lock screen and accepts input on it, so a locked phone can
be unlocked from the Mac. The iPhone path is unchanged.

| Phone state        | `locked` | `lifecycle` | What works                               |
| ------------------ | -------- | ----------- | ---------------------------------------- |
| Unlocked           | `false`  | `ready`     | Everything                               |
| Locked, screen on  | `true`   | `ready`     | Picture, touch, live touch, typing, keys |
| Locked, screen off | `true`   | `locked`    | **Wake** (`/api/unlock`), Lock, buttons  |

`locked` is always the truth. `lifecycle` says whether the mirror is usable, and
no new value was added: the page and the Mac app show their Locked overlay only
for `lifecycle: "locked"`, which now means the screen is off. **Wake** turns the
screen on and dismisses a lock screen that has no PIN; a secure one stays for
its owner to unlock in the mirror.

While `locked` is `true`, these return HTTP 409 with code `device locked`:
`launch`, `open-url`, `tap`, `element-action`, `type` with a target, any action
with `waitFor` or `observationId`, `elements`, `element`, `source`,
`screenshot`, `observe`, `wait`, `clipboard-read` and `clipboard-write`. The
lock screen is shown in the mirror, but its PIN pad is not readable through the
API. `expectedApp` and `expectedOrientation` work as usual. Keep-awake stops
when the phone locks, as before.

What is typed or drawn on a lock screen is a PIN, a password or a pattern:

- Command receipts normally store a hash of the request. A hash does not hide a
  short PIN, which is found by trying every candidate. For `type`, `key`,
  `gesture` and `pinch` sent while the phone is locked, or while its lock state
  is not known, the payload is left out of the hash. The receipt keeps the
  request ID and outcome, and still never runs one ID twice. The lock state is
  asked of the phone for each such input, not taken from a cached value.
- Live touch events are never recorded, locked or not.
- Logs and `/api/diagnostics` name operations and outcomes, never arguments.
- Text the virtual keyboard cannot produce is refused on a lock screen. Placing
  it would mean reading the password field.

## Verified

Checked on one Pixel 6a (Android 17, adb 37.0.1) on 2026-11-10, through the public
API and the browser page, over both USB and Wi-Fi:

- Discovery, helper push and start, and recovery to ready with no manual steps. A
  fresh start reached ready in under a second with the helper file already on the
  phone.
- Live picture in the browser page; click to tap, and the Back button.
- Swipe, pinch, app launch, open URL, Home, Recents and Back.
- Typing ASCII and Unicode (`héllo 👋 wifi`), Backspace, select all, copy, cut,
  paste and undo.
- Clipboard in both directions, and copy detection without reading the clipboard.
- Element search, attributes, tap by selector, replace text, waits and
  postconditions, UI tree, screenshot.
- Lock guard, app guard, and the locked lifecycle.
- A keep-awake pulse.

In the Mac app, built from this tree and launched against the same phone:

- The app found the phone, opened a window from `iportal://mirror?serial=…`,
  started the Android server and showed the live picture at the right shape.
- A click opened an app, Escape went back, and **View → Home Screen** went home.
- The View menu showed Android's names (Recents, Search, Notifications, Quick
  Settings) and the audio item was disabled.
- Quitting the app ended its server, the inventory watcher and the helper on the
  phone.
- Replugging the phone with the app closed dropped the device list from the menu
  bar, and both the phone and an iPhone could be mirrored from it. Restarting the
  watcher with the phone already attached did not open the list.
- An iPhone over Wi-Fi and the Android phone over USB mirrored side by side, both
  live, each with its own server and window. The Android session stayed ready
  while the iPhone session was locked, failing to launch and reinstalling.

Not verified:

- A cable pull during a session through the server. The route did move from Wi-Fi
  to USB when the cable was plugged in, and the underlying switch was measured in
  the assessment, but a held session across it was not exercised.
- Rotation while streaming, long-press, double-tap, sliders, volume keys, lock and
  wake through the API.
- Any other phone or Android version.
- **Live touch, `xpath`, the image clipboard and the usable lock screen.** They
  were built without a phone attached. The helper compiles, the XPath evaluator
  is tested on the Mac with the helper's own code, and the server and page
  logic are unit-tested, but nothing here has run on a device. In particular:
  whether the media store lets the shell user store a picture and the clipboard
  accept its address, whether other apps can paste it, whether a copied
  picture's address opens for the shell user, how a cancelled touch behaves in
  scrolling lists, and how live strokes feel over Wi-Fi.

Observed behaviour worth knowing:

- Android shows a brief notice on the phone when iPortal reads the clipboard
  (**Edit → copy from device**). Copy detection after ⌘C does not read it.
- Keyboard shortcuts sent immediately after a field opens can arrive before the
  field has focus.
- With a browser page still open, the server takes about 20 seconds to exit. This
  is the shared HTTP server waiting for open connections, not Android-specific.

## Not built yet

- **Native audio is unverified with real playback.** Native video runs on the
  test phone; the helper captures audio, but its level has not been checked.
- **Mac accessibility bridge on Android is unverified on a phone.** The bridge has
  an Android role table and the helper accepts the bridge's `xpath` paths.
- **Clipboard images without the gallery.** A picture sent to the phone's
  clipboard is stored in the media store, because the helper has no content
  provider. Avoiding that needs an installed app.
- **Automated tests against a fake device.** Unit tests cover the adb protocol,
  device selection and the contract; the rest was checked on a real phone.
