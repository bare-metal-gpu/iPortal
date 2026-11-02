# Mirror API

The local mirror server exposes read-only UI inspection, waits, and timed keep-awake alongside its existing input commands. All endpoints below are `POST http://127.0.0.1:7100/api/<name>` with a JSON object body. They return `{ "ok": true, "value": ... }`. Existing input routes still return `{ "ok": true }`.

The API is unauthenticated and listens only on loopback. Keep it local. Screenshots and UI trees may contain personal information; the server does not save them.

## Endpoints

| Endpoint | Body | Result in `value` |
| --- | --- | --- |
| `state` | `{}` | Lock state, active app, orientation and logical screen dimensions |
| `elements` | `{ "selector": { "using": "accessibility id", "value": "General" } }` | Array of `{ "id": "..." }`; empty if none match |
| `element` | `{ "id": "...", "attributes": ["label", "enabled", "rect"] }` | ID and requested attributes |
| `source` | `{ "format": "json" }` | UI hierarchy; formats: `json` (default), `xml`, `description` |
| `screenshot` | `{}` | `{ "mimeType": "image/png", "encoding": "base64", "data": "..." }` |
| `wait` | See below | Matching observation and `elapsedMs` |
| `keep-awake` | `{ "enabled": true, "durationMs": 1800000 }` | Timed keep-awake lease; `{}` reads status, `{"enabled":false}` stops |

`element` and `screenshot` also accept a `selector` instead of an `id`. A selector must resolve to exactly one element for these calls; multiple matches produce HTTP 409. Omit both for a whole-screen screenshot. Screenshot MIME types are detected from the returned bytes (PNG, JPEG or HEIC), not assumed.

Selectors support `accessibility id`, `id`, `name`, `class name`, `predicate string`, `class chain`, and `xpath`. These are WDA strategy names. For example:

```json
{"selector":{"using":"predicate string","value":"type == 'XCUIElementTypeButton' AND label == 'Continue'"}}
```

Element attributes: `type`, `name`, `label`, `value`, `enabled`, `visible`, `selected`, `hittable`, `accessible`, `rect`. Defaults are all except `selected` and `accessible`. Attribute values retain WDA's JSON types, including null. Bounds use logical screen points, not screenshot pixels. IDs are temporary and can become stale after UI changes; re-run the selector to recover. An element existing does not imply it is visible or hittable.

Inspection uses WDA's accessibility hierarchy, so an app must expose meaningful accessible elements. State attributes are read sequentially and are not an atomic snapshot. Hierarchy snapshots use a depth of 50 rather than the original mirror's depth of 1; deep inspections can be slower than raw touch input.

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

`timeoutMs`: 1–60000, default 10000. `intervalMs`: 50–5000, default 250. Timeouts include time spent in the command queue and making upstream requests. Each poll is serialized with input and other inspection operations, but the wait releases the queue between polls. Another request can therefore trigger the transition being awaited. A busy operation already ahead of a poll can delay delivery of the timeout response, but the expired poll will not contact WDA when it reaches the queue.

Selectors are evaluated afresh on each poll, including after stale-element errors during transitions. Transport, authorization, and invalid-selector errors are never treated as successful absence. Polling can miss short-lived states. Disconnecting the HTTP client cancels polling; an upstream operation already dispatched may still finish on the phone. Successful waits describe an observation, not a permanent guarantee about subsequent UI state.

A timeout returns HTTP 408:

```json
{"ok":false,"error":"Wait timed out","code":"timeout","details":{"elapsedMs":10000,"last":{"matched":false,"count":0}}}
```

Invalid requests return 400; missing elements 404; stale or ambiguous targets 409; bodies over 1 MiB 413; other upstream failures 502 (or 503 when automation needs restarting). Errors have `ok`, `error`, and `code`. Inspect HTTP status and `ok`; do not assume a completed fetch means success.

## Save a screenshot

```bash
curl -s http://127.0.0.1:7100/api/screenshot \
  -H 'Content-Type: application/json' -d '{}' > screenshot.json
# Inspect mimeType before choosing the extension.
node --input-type=module -e 'import fs from "node:fs"; const r=JSON.parse(fs.readFileSync("screenshot.json")); if(!r.ok) throw Error(r.error); fs.writeFile("screen."+r.value.mimeType.split("/")[1],Buffer.from(r.value.data,"base64"));'
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

Pulses run immediately and then 15 seconds after the previous pulse completes, sharing the input/inspection queue. A long-running command can delay a pulse enough for Auto-Lock to fire. Each pulse first checks the lock state. Status includes `enabled`, `method`, `remainingMs`, `pulses` and `lastPulseAt` while active; after stopping it includes `reason` and any upstream `error`. A successful pulse means WDA accepted the event, not proof that every iOS version honors it. Normal Auto-Lock resumes when pulses stop; no phone settings are changed. An already-dispatched event can finish after disabling; a volume pair attempts to finish both presses.

Methods:

- `hid` (default): sends Consumer-page AC Idle Keep Alive (`page:12, usage:688`) through WDA's `performIoHidEvent` route. Avoids volume/button presses. Verified on an iPhone 16 Pro running iOS 26.7.1 with 30-second Auto-Lock; verify effectiveness on other iOS/device combinations. There is no automatic fallback to volume presses.
- `volume`: explicit fallback sending volume-up then volume-down. May display the volume HUD, affect camera behavior, and change the final volume at its limits. If the second press fails, the first press is not undone. The fallback has automated stub coverage but was not used for the real-phone keep-awake verification.

On the tested phone, WDA took about 5.2 seconds to acknowledge each HID event. An input/inspection request arriving during that operation can wait behind it. This implementation favors using the existing WDA route; it does not require rebuilding or re-signing the iPhone helper.

## Verification

`npm test` exercises the HTTP server, fake usbmuxd forwarding, existing input routes, inspection, timeout/error handling, session recovery, cancellation and concurrent waits.

For an explicitly opted-in real phone test, unlock and connect the phone, then run:

```bash
node scripts/test-phone.mjs http://127.0.0.1:7100 /absolute/path/to/local-test-output
```

This opens Settings, briefly goes Home, returns to Settings, and changes no settings. It checks lookup, attributes, hierarchy, full/element screenshots, and waits for appearance, disappearance, attribute equality and timeout. The optional output directory receives screenshots and a report. Keep that output out of Git.
