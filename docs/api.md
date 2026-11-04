# Mirror API

The server uses Effect 4 `HttpRouter` / `NodeHttpServer` and strict Effect schemas in `schemas.mjs`. All POST requests require `Content-Type: application/json`; unknown fields and malformed arguments are rejected before dispatch. Routes are `http://127.0.0.1:7100/api/<name>`. Inspection returns `{ "ok": true, "value": ... }` plus observation metadata. Inputs return `{ "ok": true, "requestId": "...", "outcome": "executed", "verified": false }`.

The Mac server listens only on loopback. Exact Host/Origin checks, Fetch Metadata, JSON-only mutations and an automatically embedded server-instance fingerprint protect browser access without an authentication UI. Trusted local CLI clients need no credentials. This is not a security boundary against malicious software running as the same OS user. The bundled iPhone runner now binds both HTTP and MJPEG to device loopback via `TEST_RUNNER_USE_IP`; USB forwarding remains available, direct Wi-Fi access does not. Screenshots and UI trees are not saved by the server.

One device UDID is pinned for the server lifetime. Disconnecting it does not select another phone or iPad. Native video uses an exact ID match when available, or the unambiguous correspondence between one connected USB device and one iOS capture source. With multiple unmatched candidates, the app automatically uses the pinned device's screenshot stream. `/api/status` includes `service`, `apiVersion`, `instanceId`, device identity, queue and keep-awake status.

The Mac app runs one isolated server per mirrored device. The first available
session uses port 7100; additional sessions receive an available port automatically.
Managed `/api/health` responses include the selected `pinnedUdid` and launch `owner`.
For CLI automation with explicit ports, run a separate process per UDID:

```bash
bun iportal.mjs --udid <first-udid> --port 7100 --wda-port 8100 --mjpeg-port 9100 --no-open
bun iportal.mjs --udid <second-udid> --port 7101 --wda-port 8101 --mjpeg-port 9101 --no-open --device-kind iPad
```

Each device can have only one owning server. Queues, inspection observations,
command receipts and keep-awake leases belong to that server's device. Detach
cancels queued commands instead of replaying them after reconnection.

## Endpoints

| Endpoint     | Body                                                                  | Result in `value`                                                         |
| ------------ | --------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `state`      | `{}`                                                                  | Lock state, active app, orientation and logical screen dimensions         |
| `elements`   | `{ "selector": { "using": "accessibility id", "value": "General" } }` | Array of `{ "id": "..." }`; empty if none match                           |
| `element`    | `{ "id": "...", "attributes": ["label", "enabled", "rect"] }`         | ID and requested attributes                                               |
| `source`     | `{ "format": "json" }`                                                | UI hierarchy; formats: `json` (default), `xml`, `description`             |
| `screenshot` | `{}`                                                                  | `{ "mimeType": "image/png", "encoding": "base64", "data": "..." }`        |
| `wait`       | See below                                                             | Matching observation and `elapsedMs`                                      |
| `observe`    | `{ "screenshot": true, "settleMs": 100 }`                             | Timestamped app/orientation/tree/screenshot observation and `stable` flag |
| `keep-awake` | `{ "enabled": true, "durationMs": 1800000 }`                          | Timed keep-awake lease; `{}` reads status, `{"enabled":false}` stops      |

`element` and `screenshot` also accept a `selector` instead of an `id`. A selector must resolve to exactly one element for these calls; multiple matches produce HTTP 409. Omit both for a whole-screen screenshot. Screenshot MIME types are detected from the returned bytes (PNG, JPEG or HEIC), not assumed.

Selectors support `accessibility id`, `id`, `name`, `class name`, `predicate string`, `class chain`, and `xpath`. These are WDA strategy names. For example:

```json
{
  "selector": {
    "using": "predicate string",
    "value": "type == 'XCUIElementTypeButton' AND label == 'Continue'"
  }
}
```

Element attributes: `type`, `name`, `label`, `value`, `enabled`, `visible`, `selected`, `hittable`, `accessible`, `rect`. Defaults are all except `selected` and `accessible`. Attribute values retain WDA's JSON types, including null. Bounds use logical screen points, not screenshot pixels. IDs are temporary and can become stale after UI changes; re-run the selector to recover. An element existing does not imply it is visible or hittable.

Inspection uses WDA's accessibility hierarchy, so an app must expose meaningful accessible elements. Selector-based element attributes reuse WDA’s expanded lookup response, avoiding separate USB requests for each attribute. Hittability is checked freshly; ID-based or missing attributes are read sequentially. Combined state is not an atomic snapshot. Hierarchy snapshots use a depth of 50 rather than the original mirror's depth of 1; deep inspections can be slower than raw touch input.

## Waits

```bash
# Wait for a button to exist
curl -s http://127.0.0.1:7100/api/wait \
  -H 'Content-Type: application/json' \
  -d '{"selector":{"using":"accessibility id","value":"Continue"},"condition":"exists","timeoutMs":10000}'

# Wait until an unambiguous button is hittable
curl -s http://127.0.0.1:7100/api/wait \
  -H 'Content-Type: application/json' \
  -d '{"selector":{"using":"accessibility id","value":"Continue"},"condition":"attribute","attribute":"hittable","equals":true,"timeoutMs":10000}'
```

Conditions:

- `exists` (default): at least one match; returns matching IDs and count.
- `absent`: zero matches.
- `attribute`: exactly one match whose requested attribute deeply equals `equals`. Multiple matches are an error; no match continues waiting.

`timeoutMs`: 1–60000, default 10000. `intervalMs`: 50–5000, default 250. Timeouts include time spent in the command queue and making upstream requests. Each poll is serialized with input and other inspection operations, but the wait releases the queue between polls. Another request can therefore trigger the transition being awaited. Queued work is removed on cancellation or deadline expiry. Device calls already dispatched may finish after a timeout. Individual queued operations have an eight-second budget (gestures may use their duration plus two seconds). The queue admits at most 64 pending operations and prioritizes keep-awake pulses while preserving FIFO order among ordinary inputs. `stableForMs` (0–10000, default 0) requires the same matching observation across the specified interval; it does not assert that the entire screen is stable.

Selectors are evaluated afresh on each poll, including after stale-element errors during transitions. Transport, authorization, and invalid-selector errors are never treated as successful absence. Polling can miss short-lived states. Disconnecting the HTTP client cancels polling; an upstream operation already dispatched may still finish on the phone. Successful waits describe an observation, not a permanent guarantee about subsequent UI state.

A timeout returns HTTP 408:

```json
{
  "ok": false,
  "error": "Wait timed out",
  "code": "timeout",
  "details": { "elapsedMs": 10000, "last": { "matched": false, "count": 0 } }
}
```

Invalid requests return 400; rejected origins/hosts 403; missing elements 404; stale, ambiguous or conflicting requests 409; bodies over 1 MiB 413; non-JSON mutations 415; full queues 429; upstream failures generally 502. Errors have `ok`, `error`, and `code`. Inspect HTTP status and `ok`; do not assume a completed fetch means success.

## Element actions and verified transitions

`tap` accepts exactly one `id` or `selector`. `type` accepts `text` plus an optional `id`/`selector`; without a target it inserts into the focused field using Unicode event playback without attaching a temporary hardware keyboard. Targeted operations re-resolve selectors and check enabled/hittable state before invoking XCTest's element action.

```json
{
  "selector": {
    "using": "predicate string",
    "value": "type == 'XCUIElementTypeButton' AND label == 'Settings'"
  },
  "expectedApp": "com.apple.Preferences",
  "requestId": "navigation-001",
  "waitFor": {
    "selector": { "using": "accessibility id", "value": "General" },
    "condition": "exists",
    "stableForMs": 100
  }
}
```

Send this to `/api/tap`. A visible label is not necessarily an accessibility identifier: use a label predicate when that is what you observed. Input routes accept optional `expectedApp`, `expectedOrientation`, `observationId`, `requestId`, `timeoutMs` and `waitFor`. A postcondition is observed after dispatch without monopolizing the queue; only success of that check produces `outcome: "verified"`. Without it, success is `executed`, not a claim about the resulting UI. Failed postconditions preserve `outcome: "executed"`; failures after dispatch with uncertain completion produce `unknown`. Never blindly retry an unknown outcome.

Gesture points use normalized coordinates in the **current interface orientation**. They must be 1–256 triples `[x,y,ms]`, x/y within 0–1, initial time zero, nondecreasing timestamps, and `end` at least the last timestamp and no more than 10000 ms. Both Effect and the patched native route validate these constraints. Native touch independently checks lock state and optional app/orientation guards. Screen dimensions are read for each native gesture instead of caching portrait dimensions.

The helper converts oriented viewport points to XCTest's portrait screen coordinates before building each pointer path. The event record still carries the current interface orientation. This conversion is shared by taps, long presses, drags, scroll swipes, shortcuts and both pinch fingers; clients must not rotate their coordinates again. Ordinary W3C actions already obtain this conversion through `XCUICoordinate.screenPoint`. Helper capability version 5 includes the corrected direct-path conversion.

Helpers advertising `guardedTouch` perform gesture lock/app/orientation checks together on the phone, avoiding duplicate host round trips. Older helpers retain host checks. Touch playback uses the daemon's completion callback with a 50 ms maximum implicit confirmation wait and 10 ms polling. This does not prove the app has finished reacting; use `waitFor` when the next action depends on a transition.

Successful input replies also include diagnostic `timing`: `queueMs` (admission and queue), `preflightMs`, `actionMs`, and `totalMs`, plus `native.guardMs`, `native.playbackMs` and `native.confirmationMs` when supplied by the helper. These use monotonic elapsed time. They are not input-to-display measurements and are not retained in receipts across a server restart.

Ordinary mouse clicks shorter than 250 ms play a 40 ms tap; longer holds and drag paths retain their recorded durations. Each scroll gesture plays one 120 ms swipe, as described below. Drags and pinches submit complete gestures after finger-up; true streaming touches are not enabled.

## Observations

`observe` captures app/orientation, source, an optional screenshot, then source/app/orientation again. It returns component capture timestamps and an opaque `id`. `stable: true` means the two sampled trees and app/orientation agreed; this is a bounded consistency check, **not an atomic snapshot or a guarantee of pixel stability**. If `settleMs` is supplied, that agreement must persist across samples; `timeoutMs` defaults to 8000, maximum 10000. Omit screenshot with `{"screenshot":false}` when a tree is enough.

Input takes priority over pending inspection. Observations release the queue between their before/screenshot/after samples, allowing input to run; the before/after consistency check detects resulting changes. An in-flight WDA request still runs to completion or timeout.

An input's optional `observationId` must refer to a stable observation no older than 15 seconds, and the current app, orientation and tree must still match. Mutations invalidate saved observations. Guards reduce stale-input errors but cannot eliminate a UI change between checking and executing. Only the last 32 observations are retained in memory.

## Retry-safe command receipts

Supply the same `requestId` when recovering a lost input reply. Concurrent and subsequent requests with the same ID and validated payload share the original result; different input with that ID is rejected. The browser generates IDs and checks receipts automatically, without resending an uncertain action.

`GET /api/commands/<requestId>` returns queued/running/executed/verified/failed-or-unknown state and the result. Receipts persist in ignored `vendor/commands.json` (mode 0600); Other server ports use `vendor/commands-PORT.json`; `IPORTAL_COMMANDS_FILE` overrides the location. Persistence contains hashes and sanitized receipts, not input text, screenshots or UI trees. A restart during an unfinished command marks its outcome unknown and prevents replay. The retention window is 24 hours, capped at 4096 receipts; a full store rejects new inputs rather than evicting live deduplication records. This is not an exactly-once guarantee across device failure or beyond retention. Local testing must use a separate receipt file.

## Save a screenshot

```bash
curl -s http://127.0.0.1:7100/api/screenshot \
  -H 'Content-Type: application/json' -d '{}' > screenshot.json
# Inspect mimeType before choosing the extension.
bun -e 'import fs from "node:fs"; const r=JSON.parse(fs.readFileSync("screenshot.json")); if(!r.ok) throw Error(r.error); fs.writeFile("screen."+r.value.mimeType.split("/")[1],Buffer.from(r.value.data,"base64"));'
```

## Keep-awake

```bash
# Hold an already-unlocked phone awake for 30 minutes
curl -s http://127.0.0.1:7100/api/keep-awake \
  -H 'Content-Type: application/json' -d '{"enabled":true,"durationMs":1800000}'

# Read status without touching the phone
curl -s http://127.0.0.1:7100/api/keep-awake

# Release the lease
curl -s http://127.0.0.1:7100/api/keep-awake \
  -H 'Content-Type: application/json' -d '{"enabled":false}'
```

Opt-in only: the server starts with keep-awake disabled. `durationMs` defaults to 30 minutes and accepts 1000–7200000 ms (up to two hours). Enabling again replaces the previous lease and immediately sends a pulse. The lease belongs to the server and survives completion/disconnection of the HTTP request; it ends on expiration, explicit disable, server exit, an API lock request, or detection of a locked phone or upstream failure. It never unlocks a phone or restarts itself after a failure. GET and POST `{}` return status without querying the device.

Pulses run immediately and then 15 seconds after completion, with priority over queued input/inspection. Successful touch, typing, Home and button input postpones the next pulse by 15 seconds because it already provides activity; obsolete queued maintenance pulses are skipped. Activity never extends the lease’s absolute expiry. Maintenance has its own deadline and cancellation scope, independent of the HTTP input that scheduled it. Long in-flight device operations can still delay a pulse; timeout does not undo already-dispatched device work. Each pulse first checks the lock state. Status includes `enabled`, `method`, `remainingMs`, `pulses`, `lastPulseAt`, `backend` and `lastPulseMs` while active; after stopping it includes `reason` and any upstream `error`. A successful pulse means WDA accepted the event, not proof that every iOS version honors it. Normal Auto-Lock resumes when pulses stop; no phone settings are changed. An already-dispatched event can finish after disabling; a volume pair attempts to finish both presses.

Methods:

- `hid` (default): sends Consumer-page AC Idle Keep Alive (`page:12, usage:688`) through the patched acknowledged event-stream route `/wda/mirror/keepalive`. Older helpers without that route, or reporting it unsupported, fall back to WDA's slower `performIoHidEvent`; other errors stop the lease. Avoids volume/button presses. Verified on an iPhone 16 Pro running iOS 26.7.1 with 30-second Auto-Lock; verify effectiveness on other iOS/device combinations. There is no automatic fallback to volume presses.
- `volume`: explicit fallback sending volume-up then volume-down. May display the volume HUD, affect camera behavior, and change the final volume at its limits. If the second press fails, the first press is not undone. The fallback has automated stub coverage but was not used for the real-phone keep-awake verification.

The old WDA route takes about 5.24 seconds because Apple's daemon waits five seconds for a button confirmation before implicitly reporting success. The patched route uses synthesized event-stream playback with a shorter confirmation interval and waits for its daemon callback. Five final server pulse measurements on the same phone had a median of 0.67 seconds, roughly 87% lower latency than the legacy route. End-to-end HTTP renewal requests had a median of 0.70 seconds. This requires rebuilding the helper with `bun run setup`. A completed callback is not proof that application animations or accessibility state have settled.

## Verification

`bun run test` covers Effect schema validation, browser binding, queue priority/deadlines/cancellation, persisted receipt recovery, real HTTP regression checks, fake USB forwarding, element actions, observations, waits, and device pinning. Unimplemented fake-WDA routes fail explicitly. On macOS it also compiles the exact native input-validation and rotation helpers and verifies fresh/repeated/upgrade/incompatible patch installation. Native tests do not simulate physical touchscreen behavior. On the connected iPhone, lookup, state, screenshots, waits, an observation-guarded tap, targeted typing, a portrait gesture, and duplicate-request recovery passed. Rotation geometry has native contract coverage for all four orientations. A physical iPhone touch recorder verified 16 cases across portrait, both landscape directions and a return to portrait: off-center taps, horizontal/vertical drags and off-center two-finger pinches. The largest observed endpoint error was 0.21 points; converted points also matched XCTest’s own coordinate conversion. Upside-down portrait remains covered by native contract tests rather than a physical iPhone check. Seven-attribute lookup measured a 199 ms median using a selector’s expanded response versus 603 ms with separate ID-based attribute reads (three pairs on the same Settings navigation element).

For an explicitly opted-in real phone test, unlock and connect the phone, then run:

```bash
bun scripts/test-phone.mjs http://127.0.0.1:7100 /absolute/path/to/local-test-output
```

This opens Settings, briefly goes Home, returns to Settings, and changes no settings. It checks lookup, attributes, hierarchy, full/element screenshots, and waits for appearance, disappearance, attribute equality and timeout. The optional output directory receives screenshots and a report. Keep that output out of Git.

## Reproducing touch latency measurements

`scripts/benchmark-touch.ts` is an explicitly opted-in real-phone test using Bun and a native Swift image sampler (built automatically with Xcode). With the phone unlocked and connected, run `bun scripts/benchmark-touch.ts /absolute/path/report.json`. The sampler uses CoreGraphics rather than the historical Pillow implementation; compare new reports within the same sampler version. It opens Settings, navigates to Display & Brightness and back, and performs small alternating scrolls. It changes no settings and enables keep-awake for 30 minutes.

The report separates HTTP completion from the first changed central-region MJPEG frame, using the host monotonic clock. It waits for quiet video before each sample to avoid counting residual scroll inertia. Video timing includes capture and transport delay; it is not a direct panel measurement or a measurement of the native USB preview. Mouse recording time is excluded. Raw drag duration remains part of playback. Frame samples and screenshots are not saved by this benchmark.

### Device lifecycle

`GET /api/status` includes `locked` (`true`, `false`, or `null` when unknown) and `lifecycle` (`ready`, `locked`, `connecting`, or `disconnected`). `ok` still describes WDA reachability; it does not imply that the phone is unlocked. Lock state is read without creating an XCTest session. Unknown or failed observations never count as unlocked.

The app polls once a second, blurs its last captured frame while unavailable, and blocks input until both the phone is ready and a fresh frame arrives. Queued UI input is discarded across lifecycle changes. Native capture and the MJPEG fallback both monitor frame freshness. Capture teardown and replacement are serialized; a rolling retry budget limits native attempts to two per minute until ten seconds of continuous healthy video reset the budget. Exhausted attempts use MJPEG and retry native capture after a cooldown. Both backends preserve a fixed blurred frame while unavailable. Manual locking ends the keep-awake lease; unlocking does not silently start a new lease.

`GET /api/health` returns `{ service, apiVersion, instanceId, ok: true }` without contacting the phone. The Mac app uses this endpoint to distinguish a failed local server from slow or unavailable WDA. It restarts only its own server process, retaining the pinned UDID, and reloads failed WebKit content with backoff.

Native readiness is scoped to the document, video epoch, and device identity. A poll-only status revision prevents cached UI messages from undoing a suspension. Old readiness callbacks cannot reactivate a replaced page or phone. Mouse, drag, scroll, and typing share the same readiness gate. Client action requests expire after 18 seconds and receipt lookups after 3 seconds; timed-out input is never blindly replayed. MJPEG has a 3-second connection/first-frame deadline, a 3-second presented-frame watchdog, and a server-side 5-second idle-read deadline.

Regression checks now include real CSS class tracking and pointer handlers, stale document/device callbacks, transient outages, frozen fallback frames, multipart parsing, stalled streams, hung command queues, cheap health probes under slow WDA, capture serialization/cancellation, and native readiness/retry-budget tests.

### Scroll gestures

The Mac app forwards explicit trackpad begin/change/end phases and consumes those events before WebKit can dispatch them a second time. A trackpad gesture sends one phone swipe when the fingers lift; inertial momentum is ignored. Mouse-wheel events without phases are grouped into a single burst ending after 80 ms of inactivity. Lock/reconnect cancels unfinished gestures. A cancelled or abandoned gesture cannot be replayed by a later input.

### Pinch zoom

Pinch the Mac trackpad over the mirror to zoom, or hold Command while scrolling with a mouse. Each completed pinch sends one simultaneous two-finger gesture to the iPhone, centered near the pointer. Ordinary scrolling still swipes. The browser also accepts Ctrl-wheel (Chromium trackpad pinch) and Safari gesture events. Magnification follows [AppKit's incremental magnification](https://developer.apple.com/documentation/appkit/nsevent/magnification). Lock, reconnect, cancellation and stale document callbacks discard unfinished pinches.

Helpers advertising `multiTouch` accept exactly two validated `fingers` paths through `/wda/mirror/touch`. Both paths share one on-device lock/app/orientation check and one acknowledged event record with the existing 50 ms confirmation interval. Older helpers use [W3C touch actions](https://appium.github.io/appium-xcuitest-driver/12.3/guides/gestures/) with host guards; that fallback has a longer completion delay. Uncertain playback is never retried through the fallback.

`POST /api/pinch` accepts `{ "x": 0.5, "y": 0.5, "scale": 2, "durationMs": 240 }` plus the normal action metadata. Coordinates are normalized in the current interface orientation; scale is 0.25–4 (below 1 zooms out, above 1 zooms in, 1 does nothing), and duration is 80–1000 ms, default 240. Both fingers start together, settle for 40 ms, then move for the requested duration and lift together. The center is clamped near screen edges so neither finger leaves the display. Dimensions are read for every pinch; lock/app/orientation checks, serialization and receipt recovery use the existing action pipeline. Supported behavior depends on the foreground app; Photos supports zooming an open photo.

Live Photos checks on the connected iPhone verified zoom-in and zoom-out. The two fast-route requests completed in 587 ms and 580 ms, versus 4126 ms and 3922 ms through W3C actions; these are server command durations, not input-to-display measurements. Physical trackpad pinch and Command-scroll were also confirmed on the installed Mac app.

### Connection events

`GET /api/events` returns `text/event-stream`. Each `data:` record contains the same
connection snapshot as `/api/status`, plus an increasing `eventSequence` and
`observedAt` (Unix milliseconds). Subscribe once per viewer; do not poll status while
the stream is healthy. The server shares helper probes across subscribers and pushes
USB/helper transitions immediately. Intermediate snapshots may be coalesced for slow
readers. On a broken/silent stream, reconnect or use `/api/status` as a fallback.
Reject events from obsolete server instances and observations preceding a local USB
transition. Readiness still requires both a verified unlocked helper and fresh video;
receiving an event alone does not enable input. Existing local host/origin checks apply.

## Clipboard

`POST /api/clipboard-read {}` reads the selected device’s clipboard. Returns
`{ok:true,value:{format:"text"|"url"|"image",content:"<base64>"}}` or
`{ok:true,value:{empty:true}}` for an empty/unsupported clipboard.

`POST /api/clipboard-write {"format":"text","content":"aVBvcnRhbA=="}` writes
UTF-8 text; `url` writes a UTF-8 absolute URL, and `image` writes an image (the Mac
client supplies PNG). Returns `{ok:true,value:{format:"text",bytes:7}}`.
Text/URLs are limited to 1 MiB; images to 4 MiB and 20 megapixels. The bridge
transfers one primary representation, preferring image, URL, then text; rich text,
files, multiple items and continuous synchronization are not supported.

Both operations are serialized with input, require an unlocked device, and use
an instance-bound request from the Mac app. The helper briefly activates itself
and restores the previous running app if the user has not switched elsewhere.
Clipboard reads never auto-accept iOS Paste prompts. Denial, a pending prompt,
timeout, stale connection or changed clipboard is surfaced without replacing the
Mac clipboard. Writes use a local-only pasteboard item to avoid Handoff loops.
No transfer payload or response is retained in the command receipt ledger, and
neither direction retries automatically. Clipboard writes copy the item only;
they do not invoke Paste in the foreground app.

## Keyboard editing

`POST /api/key {"key":"ArrowLeft","modifiers":["shift"]}` moves or extends the current selection. Keys: `ArrowLeft`, `ArrowRight`, `ArrowUp`, `ArrowDown`, `Backspace`, `Delete` (forward delete), `Enter`, `Tab`, `Escape`, `Home`, `End`, `PageUp`, `PageDown`, or one printable Unicode code point. Modifiers are a unique subset of `command`, `control`, `option`, `shift`; modified printable keys use lowercase Latin letters. Use `type` for composed text or strings.

Untargeted text and key commands use the same touch-sender event stream: Unicode insertion for text, bounded HID chords for navigation and shortcuts. Every chord releases its modifiers in the same stream. This avoids XCTest's temporary keyboard attachment and the resulting hide/reopen cycle. Completion acknowledges playback, not application-specific editing success. Existing lock, app, device, queue, and no-replay guards apply. Command-C/X also report `clipboardChanged`; the native app uses that to transfer an actual new selection without overwriting the Mac clipboard when nothing was copied.
