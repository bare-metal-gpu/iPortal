# Inspection API

The local mirror server exposes read-only UI inspection and waits alongside its existing input commands. All endpoints below are `POST http://127.0.0.1:7100/api/<name>` with a JSON object body. They return `{ "ok": true, "value": ... }`. Existing input routes still return `{ "ok": true }`.

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

## Verification

`npm test` exercises the HTTP server, fake usbmuxd forwarding, existing input routes, inspection, timeout/error handling, session recovery, cancellation and concurrent waits.

For an explicitly opted-in real phone test, unlock and connect the phone, then run:

```bash
node scripts/test-phone.mjs http://127.0.0.1:7100 /absolute/path/to/local-test-output
```

This opens Settings, briefly goes Home, returns to Settings, and changes no settings. It checks lookup, attributes, hierarchy, full/element screenshots, and waits for appearance, disappearance, attribute equality and timeout. The optional output directory receives screenshots and a report. Keep that output out of Git.
