# API reference

Use `http://127.0.0.1:7100/api/<name>`. POST requests require
`Content-Type: application/json`; unknown fields and malformed arguments are
rejected. Inspection returns `{ "ok": true, "value": ... }`. Inputs return
`{ "ok": true, "requestId": "...", "outcome": "executed", "verified": false }`
unless a requested postcondition has been verified.

The API is local to the Mac. Native CLI clients need no credentials; browser requests require the server's host/origin and instance checks. Local native processes are trusted. Do not publish this API through a tunnel or proxy. See [security and privacy](security.md).

Phone-helper authentication is automatic and separate from the Mac API. Rebuild with `bun run setup` and `bun run app` if an older helper is rejected.

One device UDID is pinned for the server lifetime. Disconnecting it never selects another phone or iPad.

The Mac app runs one isolated server per mirrored device. The first available
session uses port 7100; additional sessions receive an available port automatically.
Managed `/api/health` responses include the selected `pinnedUdid` and launch `owner`.
For CLI automation with explicit ports, run a separate process per UDID:

```bash
bun iportal.mjs --udid "<first-udid>" --port 7100 --no-open
bun iportal.mjs --udid "<second-udid>" --port 7101 --no-open --device-kind iPad
```

Each device can have only one owning server. Queues, inspection observations,
command receipts and keep-awake leases belong to that server's device. Detach
cancels queued commands instead of replaying them after reconnection.

`GET /api/diagnostics` returns bounded local logs, traces, metrics and active
Effect fibers without querying the phone. See [local diagnostics](observability.md)
for its schema, timing scope and log levels.

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

Selectors support `accessibility id`, `id`, `name`, `class name`, `predicate string`, `class chain`, and `xpath`. For example:

```json
{
  "selector": {
    "using": "predicate string",
    "value": "type == 'XCUIElementTypeButton' AND label == 'Continue'"
  }
}
```

Element attributes: `type`, `name`, `label`, `value`, `enabled`, `visible`, `selected`, `hittable`, `accessible`, `rect`. Defaults are all except `selected` and `accessible`. Attribute values retain the helper's JSON types, including null. Bounds use logical screen points, not screenshot pixels. IDs are temporary and can become stale after UI changes; re-run the selector to recover. An element existing does not imply it is visible or hittable.

Inspection depends on the app exposing meaningful accessibility elements. Element IDs can become stale; resolve selectors again after UI changes. Combined state is not an atomic snapshot, and deep hierarchy inspection can be slow.

## Mac accessibility bridge

Each live device window exposes a native **Device content** accessibility group
to Computer and screen readers. It contains the phone's reported roles, labels,
non-password values, hierarchy and oriented screen bounds. No setup switch or
extra permission is needed beyond the existing mirroring and Mac accessibility access.

An initial read asynchronously obtains a cached `/api/observe` snapshot without
capturing an image. Subsequent command completions and changes in presented video
invalidate the cache and push a refresh, coalesced over 120 ms. One snapshot runs
at a time, with one trailing refresh if content changes during it. Unchanged trees
preserve accessibility object identity. Layout changes post native notifications.

Inspection is active only while a reader has used the tree within 12 seconds.
Frame detection samples a tiny luminance grid and retains no image data. There is
no two-second refresh gate; a read of a cache older than ten seconds is the safety
net for missed events and off-screen changes that produce no visible difference.
An initial read can need a second read after the snapshot arrives.

The bridge exposes native Press, slider Increment/Decrement, editable text values,
and custom Focus, Increase/Decrease, Double tap, Long press and four-direction
scroll actions where applicable. Slider steps request five percent of the range;
supported numeric `AXValue` values are normalized from zero to one. Apple's slider
gesture is approximate, so read the resulting value rather than assuming an exact
position. Text `AXValue` replaces the
field's contents, including clearing it, through the existing stable keyboard
path. Password fields remain on the keyboard path and never export values.

These targeted operations are also available through `POST /api/element-action`
with an `id` or `selector`, and `action`: `focus`, `replaceText` (with `text`),
`adjust` (with normalized `value`), `increment`, `decrement`, `doubleTap` or
`longPress`. The same observation and receipt guards apply. Actions are
asynchronous: acceptance means admission, so read the resulting tree to verify
the outcome. An unconfirmed command is never replayed automatically.

Actions require a recent stable observation, the same server/device generation,
foreground app and orientation, and current actionability checks. Closing the
window, losing readiness, opening Settings, or changing connection identity
retires the tree. Password values are excluded. The bridge stores no snapshots
on disk and does not log their text.
Video-only refreshes preserve readable content; input still requires the
window's existing video/readiness checks.

Off-screen nodes remain readable when the iPhone app includes them in its
accessibility tree. They are not advertised as visible or pressable. Content
that an app lazily creates after scrolling, and unlabeled photo details, still
require scrolling or screenshots; a complete Hinge profile is not guaranteed.

Physical-phone check (2026-11-08, Wi-Fi, one Hinge profile): Computer read all
10 profile sections from the top, including eight off screen, three text
answers and six photo entries. Named scroll actions and More options → Cancel
worked through the bridge. Photo entries exposed labels, not image descriptions.

The event/action update was checked on a physical iPhone over Wi-Fi in the owned
fixture: Computer read rows 0–59 including off-screen rows, focused and replaced
a field with Unicode text, cleared it, adjusted a slider, invoked Increase and
Decrease, and verified double-tap and long-press counters. A delayed UI change
also reached the tree. Slider adjustment to 0.75 reported 0.79 on this device.
Remote host regression checks pass; the simulator run timed out on the initial
Controls navigation, before reaching the new action checks. It does not establish
simulator or older-device parity.

Run `bun run test:accessibility` for the native bridge regression checks.

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

`timeoutMs`: 1–60000, default 10000. `intervalMs`: 50–5000, default 250. Timeouts include time spent in the command queue and making upstream requests. Each poll is serialized with input and other inspection operations, but the wait releases the queue between polls. Another request can therefore trigger the transition being awaited. Queued work is removed on cancellation or deadline expiry. Device calls already dispatched may finish after a timeout. Input defaults to an eight-second budget (gestures may use their duration plus two seconds); ordinary inspection defaults to fifteen seconds. Explicit request budgets reach both the queue and native helper, with no sub-operation extending the overall deadline. The queue admits at most 64 pending operations and prioritizes keep-awake pulses while preserving FIFO order among ordinary inputs. `stableForMs` (0–10000, default 0) requires the matching condition, match count, and requested attribute value to remain stable across the specified interval; temporary element handles may change; it does not assert that the entire screen is stable.

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

Invalid requests return 400; rejected origins/hosts 403; missing elements 404; stale, ambiguous or conflicting requests 409; oversized bodies 413 (1 MiB normally, 6 MiB for clipboard writes); non-JSON mutations 415; full queues 429; upstream failures generally 502. Errors have `ok`, `error`, and `code`. Inspect HTTP status and `ok`; do not assume a completed fetch means success.

## Element actions and verified transitions

`open-url` accepts `{ "url": "https://example.com/" }` and opens the link in the phone's default application. Only absolute HTTP/HTTPS links without embedded credentials are accepted. Encode non-ASCII paths and internationalized hostnames before sending. It uses the same queue, app/orientation guards and durable command receipts as other inputs; successful dispatch does not guarantee that the destination loaded. An uncertain result is never automatically replayed.

`tap` accepts exactly one `id` or `selector`. `type` accepts `text` plus an optional `id`/`selector`; without a target it inserts into the focused field without attaching a temporary hardware keyboard. Targeted operations re-resolve selectors and check enabled/hittable state before invoking XCTest's element action.

Ordinary text and WebKit password fields support Unicode insertion. Native password fields currently support printable ASCII, precomposed Latin-1 letters, and `¡¢£¥§«°»¿`; a command containing any other character returns `unsupported operation` before inserting anything. Full Unicode support in native password fields remains unresolved. Editing follows iOS behavior: on the tested iOS 27.3 phone, even the on-screen Delete key can split complex emoji in a password field. No normalization, clipboard transfer, or uncertain retry is used.

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

Gesture points use normalized coordinates in the **current interface orientation**. They must be 1–256 triples `[x,y,ms]`, x/y within 0–1, initial time zero, nondecreasing timestamps, and `end` at least the last timestamp and no more than 10000 ms. Both Effect and the native helper validate these constraints. Native touch independently checks lock state and optional app/orientation guards. Screen dimensions are read for each native gesture instead of caching portrait dimensions.

Successful input replies also include diagnostic `timing`: `queueMs` (admission and queue), `preflightMs`, `actionMs`, and `totalMs`, plus `native.guardMs`, `native.playbackMs` and `native.confirmationMs` when supplied by the helper. These use monotonic elapsed time. They are not input-to-display measurements and are not retained in receipts across a server restart.

## Pinch zoom

`POST /api/pinch` accepts `{ "x": 0.5, "y": 0.5, "scale": 2, "durationMs": 240 }` plus the normal action metadata. Coordinates are normalized in the current interface orientation; scale is 0.25–4 (below 1 zooms out, above 1 zooms in, 1 does nothing), and duration is 80–1000 ms, default 240. Both fingers start together, settle for 40 ms, then move for the requested duration and lift together. The center is clamped near screen edges so neither finger leaves the display. Dimensions are read for every pinch; lock/app/orientation checks, serialization and receipt recovery use the existing action pipeline. Supported behavior depends on the foreground app; Photos supports zooming an open photo.

## Observations

`observe` captures app/orientation, source, an optional screenshot, then source/app/orientation again. It returns component capture timestamps and an opaque `id`. `stable: true` means the two sampled trees and app/orientation agreed; this is a bounded consistency check, **not an atomic snapshot or a guarantee of pixel stability**. If `settleMs` is supplied, that agreement must persist across samples; `timeoutMs` defaults to 8000, maximum 60000. Omit screenshot with `{"screenshot":false}` when a tree is enough.

Input takes priority over pending inspection. Observations release the queue between their before/screenshot/after samples, allowing input to run; the before/after consistency check detects resulting changes. A native operation retains exclusive ownership until Apple completes it. A timed-out mutation has an unknown outcome and is never replayed; stalled operations require bounded helper recovery.

An input's optional `observationId` must refer to a stable observation no older than 15 seconds, and the current app, orientation and tree must still match. Mutations invalidate saved observations. Guards reduce stale-input errors but cannot eliminate a UI change between checking and executing. Only the last 32 observations are retained in memory.

## Retry-safe command receipts

Supply the same `requestId` when recovering a lost input reply. Concurrent and subsequent requests with the same ID and validated payload recover the original outcome; different input with that ID is rejected. The browser generates IDs and checks receipts automatically, without resending an uncertain action.

`GET /api/commands/<requestId>` returns queued/running/executed/verified/failed-or-unknown state and the result. Receipts persist in the server's runtime directory with mode 0600, separated by device or port; `IPORTAL_COMMANDS_FILE` overrides the location. Persistence contains hashes and sanitized receipts, not input text, screenshots or UI trees. A restart during an unfinished command marks its outcome unknown and prevents replay. The retention window is 24 hours. Receipts use a SQLite ledger with a bounded memory cache; reaching 4096 retained receipts does not block input. Existing JSON ledgers migrate automatically to the adjacent `.sqlite` file. This is not an exactly-once guarantee across device failure or beyond retention. Local testing must use a separate receipt file.

## Save a screenshot

```bash
curl -s http://127.0.0.1:7100/api/screenshot \
  -H 'Content-Type: application/json' -d '{}' > screenshot.json
# Inspect mimeType before choosing the extension.
bun -e 'import fs from "node:fs"; const r=JSON.parse(fs.readFileSync("screenshot.json")); if(!r.ok) throw Error(r.error); fs.writeFileSync("screen."+r.value.mimeType.split("/")[1],Buffer.from(r.value.data,"base64"));'
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

Normal Auto-Lock resumes when keep-awake stops; no phone settings are changed. Activity does not extend the lease's absolute expiry. Long device operations can delay a pulse. Status includes `enabled`, `method`, `remainingMs`, and pulse diagnostics; stopped leases include `reason` and any upstream `error`.

Methods:

- `hid` (default): sends an idle keep-alive event without pressing volume buttons. Effectiveness depends on the device/OS. It never automatically falls back to volume presses.
- `volume`: explicitly sends volume-up then volume-down. May show the volume HUD, affect the camera, or change the final volume at its limits. A failed second press does not undo the first.

## Status and connection events

`GET /api/status` reports the selected device, server instance, queue, keep-awake,
`locked` (`true`, `false`, or `null` when unknown), and `lifecycle` (`ready`, `locked`,
`connecting`, or `disconnected`). `ok` describes helper reachability, not whether
the phone is unlocked. `GET /api/health` checks the local server without contacting
the phone. Input requires a ready, unlocked device; queued work is discarded when
its device connection is invalidated.

`GET /api/events` returns `text/event-stream`. Each `data:` record contains the same
connection snapshot as `/api/status`, plus an increasing `eventSequence` and
`observedAt` (Unix milliseconds). Subscribe once per viewer; do not poll status while
the stream is healthy. The server shares helper probes across subscribers and pushes
USB/helper transitions immediately. Intermediate snapshots may be coalesced for slow
readers. On a broken/silent stream, reconnect or use `/api/status` as a fallback.
Reject events from obsolete server instances and observations preceding a local USB
transition. Readiness still requires both a verified unlocked helper and fresh video;
receiving an event alone does not enable input. Existing local host/origin checks apply.

One unanswered helper probe does not change the published state. A busy helper or a
Wi-Fi hiccup drops a probe now and then; while the last snapshot was `ready` or
`locked`, the server keeps it (same `eventSequence` and `observedAt`, nothing is sent)
and probes again after 500 ms. A second unanswered probe at least one second after the
first publishes `connecting` with `ok: false`, about two seconds after the first miss.
Only silence is tolerated. A detached device or changed route, a new helper generation,
a helper that answers `blocked` or `stopping` or with an unknown lock state, a helper
restart, and a failed authentication or build check are published immediately.

Commands are still admitted during that hold, because the published state was never
what admits them: every input checks the helper itself before it is dispatched (a
missed probe clears the cached helper status, so the next command must first get a
fresh answer), and the helper checks lock state and guards again natively. Against a
helper that is really gone the command fails as it would have before, `not executed`
if nothing was dispatched. `observedAt` tells a client how old the verification is.

When the server closes (SIGTERM, SIGINT or the Mac app closing the mirror) it ends
`/api/events` and `/stream` itself instead of waiting for clients to disconnect, and
answers new requests for them with 503 `session closed`. Treat the end of the event
stream as a lost server, as for any broken stream.

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

Completion acknowledges key playback, not application-specific editing success. Command-C/X also report `clipboardChanged`, allowing a client to transfer a newly copied selection without overwriting its clipboard when nothing was copied.
