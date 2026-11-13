# Local diagnostics

The Bun server uses Effect v4 logging, tracing, metrics and fiber tracking. No
collector, account, background exporter or extra permission is required. Records
stay on the Mac. Each mirrored device has its own server and metric registry.

```bash
curl -s http://127.0.0.1:7100/api/diagnostics
```

Use the device window's port for additional sessions. This read-only endpoint
uses the same Host/Origin protections as the rest of the API and never queries
the phone. Its response is validated by `DiagnosticsSchema`:

- `logs`: the latest 256 structured log records, including timestamp, level,
  process/fiber IDs, safe attributes and available trace/span IDs.
- `spans`: the latest 256 completed operations, with parent IDs, duration,
  outcome and safe attributes. `activeSpans` contains up to 512 current spans.
- `metrics`: Effect counters, gauges and fixed-bucket duration histograms.
  Histogram `null` upper bounds mean positive infinity; empty minima/maxima are
  also `null`.
- `fiberCount` and `fibers`: active tracked Effect fibers, with up to 512 entries
  showing their current instrumented phase, age and trace IDs.
- `startedAt`, `uptimeMs`, `droppedRecords`: owner lifetime and diagnostic sink
  pressure. Historical records and metrics reset when the server restarts.

Logs default to `Info` and write JSON lines to stderr. In the Mac app they enter
its existing per-device session log under `~/Library/Logs`. For a CLI session:

```bash
IPORTAL_LOG_LEVEL=Debug bun iportal.mjs --udid '<device-id>' --no-open 2>iportal.jsonl
```

Supported levels are `All`, `Trace`, `Debug`, `Info`, `Warn`, `Error`, `Fatal`, and
`None`. Invalid values fall back to `Info`. `Debug` adds operation-completion
logs; normal polling does not write one log line per request at `Info`. Sink
failures and backpressure do not fail commands. Keep verbose capture bounded in
time; stderr retention belongs to its receiving file or process.

## What is measured

`server.request` covers HTTP handling; `api.*` covers validated public dispatch;
`queue.wait` and `queue.execute` separate admission from execution; `helper.*`
covers the authenticated command/status boundary, including validation and
unknown outcomes. `helper.startup` and `helper.prepare` measure process launch
and installation preparation. `status.refresh` measures the shared observation,
while `helper.events`, `status.events` and `video.stream` track stream lifetimes.
`video.connect` measures fallback-video connection setup.

A `status-probe-missed` log record marks a helper status probe that got no answer
while the session was `ready` or `locked`. `confirmed: false` (Info) means the
published state was kept and the probe repeated; `confirmed: true` (Warn) means a
following probe also went unanswered and `connecting` was published. Pair them with
the `helper.status` spans to see how long the helper was silent.

These are server timings, not input-to-visible-frame latency or internal Swift
execution traces. Existing native Mac capture/reconnect traces and Xcode helper
logs remain separate. Correlate them by timestamp and process identity. Server
startup milestones now use the Effect log instead of the optional native trace
file.

Request data, typed text, clipboard contents, selectors, screenshots, app names,
device identities, credentials and raw error messages are excluded. Span names
and metric labels come from a finite vocabulary, not request URLs or IDs.
Unknown input outcomes remain unknown: observing or closing a trace never
replays a command or releases the command executor early.

## Implementation

`observability.ts` uses `Logger.make`, `Effect.log*`, `Effect.annotateLogs`,
`Effect.withSpan`, `Tracer.NativeSpan`, `Metric` counters/gauges/histograms and
runtime fiber metrics. `FiberSet` belongs to an explicit `Scope`; completed fibers
remove themselves, and shutdown interrupts remaining tracked work after device
teardown. A small AsyncLocalStorage adapter carries Effect span identity through
the existing Promise queue without replacing its ownership or deadline logic.

The regression suite covers parentage across queued work, per-owner isolation,
payload exclusion, bounded history/cardinality, broken sinks, log levels, native
fiber cleanup, cancellation ownership and protected HTTP diagnostics.

Effect references: [logging](https://effect.website/docs/v4/observability/logging),
[metrics](https://effect.website/docs/v4/observability/metrics),
[tracing](https://effect.website/docs/v4/observability/tracing), and
[tracking fibers](https://effect.website/docs/v4/observability/tracking-fibers).
