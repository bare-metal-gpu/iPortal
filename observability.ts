import { AsyncLocalStorage } from "node:async_hooks";
import {
  Cause,
  Context,
  Effect,
  Exit,
  FiberSet,
  Logger,
  Metric,
  Option,
  References,
  Schema,
  Scope,
  Tracer,
  type Fiber,
  type LogLevel,
} from "effect";
import { RequestSchemas } from "./schemas.ts";
import { helperOperations } from "./helper-protocol.ts";

const operations = new Set([
  ...Object.keys(RequestSchemas),
  ...Object.keys(helperOperations),
  "status",
  "command-status",
]);
const errorCodes = new Set([
  "invalid argument",
  "invalid selector",
  "invalid response",
  "no such element",
  "stale element reference",
  "invalid element state",
  "element not actionable",
  "guard failed",
  "device locked",
  "app changed",
  "orientation changed",
  "queue full",
  "timeout",
  "unsupported operation",
  "automation denied",
  "stale generation",
  "helper unavailable",
  "helper response",
  "incompatible helper",
  "forbidden",
  "unknown error",
]);
const names = new Set([
  "server.request",
  "server.lifetime",
  "helper.startup",
  "helper.prepare",
  "helper.status",
  "helper.events",
  "status.events",
  "status.refresh",
  "queue.wait",
  "queue.execute",
  "video.connect",
  "video.stream",
  ...[...operations].flatMap((name) => [`api.${name}`, `helper.${name}`]),
]);
const events = new Set([
  "server-entered",
  "server-listening",
  "server-device-selected",
  "server-stopping",
  "server-failed",
  "helper-ready",
  "helper-prepare-start",
  "helper-installation-hint",
  "helper-inventory-start",
  "helper-inventory-finished",
  "helper-launch",
  "helper-ended",
  "helper-restarting",
  "helper-unreachable",
  "status-probe-missed",
  "android-devices",
  "android-adb-lost",
  "operation-completed",
]);
const values: Record<string, ReadonlySet<string>> = {
  mode: new Set(["installed", "install"]),
  connection: new Set(["USB", "Paired", "Network", "Unknown", "unavailable"]),
  pairedHealth: new Set(["starting", "ready", "recovering", "unavailable"]),
  method: new Set(["GET", "POST", "HEAD", "OPTIONS", "PUT", "DELETE", "PATCH"]),
  outcome: new Set(["verified", "executed", "not executed", "unknown", "completed", "failed"]),
  reason: new Set([
    "locked",
    "developer",
    "setup",
    "verification",
    "artifacts",
    "transient",
    "timeout",
  ]),
};
type Attributes = Record<string, string | number | boolean>;
// Export only enumerated metadata. Never serialize errors, paths, selectors,
// request/response bodies, clipboard data, auth headers or device identities.
function attributes(input: Record<string, unknown>): Attributes {
  const result: Attributes = {};
  for (const [key, value] of Object.entries(input)) {
    if (
      typeof value === "string" &&
      ((Object.hasOwn(values, key) && values[key]!.has(value)) ||
        (key === "operation" && operations.has(value)) ||
        (key === "span" && names.has(value)) ||
        (key === "errorCode" && errorCodes.has(value)))
    )
      result[key] = value;
    else if (key === "confirmed" && typeof value === "boolean") result[key] = value;
    else if (
      ["httpStatus", "budgetMs", "queueMs", "durationMs"].includes(key) &&
      typeof value === "number" &&
      Number.isFinite(value)
    )
      result[key] = value;
  }
  return result;
}
const Fields = Schema.Record(
  Schema.String,
  Schema.Union([Schema.String, Schema.Finite, Schema.Boolean]),
);
const finite = Schema.Finite;
const optional = Schema.optional;
const Correlation = { traceId: optional(Schema.String), spanId: optional(Schema.String) };
const LogRecord = Schema.Struct({
  timestamp: Schema.String,
  level: Schema.String,
  event: Schema.String,
  processId: finite,
  fiberId: finite,
  ...Correlation,
  attributes: Fields,
});
const SpanRecord = Schema.Struct({
  name: Schema.String,
  traceId: Schema.String,
  spanId: Schema.String,
  parentSpanId: optional(Schema.String),
  startedAt: finite,
  durationMs: finite,
  outcome: Schema.Literals(["running", "success", "failure", "interrupted", "unknown"]),
  attributes: Fields,
});
const MetricRecord = Schema.Union([
  Schema.Struct({
    name: Schema.String,
    type: Schema.Literal("Counter"),
    attributes: Fields,
    count: finite,
  }),
  Schema.Struct({
    name: Schema.String,
    type: Schema.Literal("Gauge"),
    attributes: Fields,
    value: finite,
  }),
  Schema.Struct({
    name: Schema.String,
    type: Schema.Literal("Histogram"),
    attributes: Fields,
    count: finite,
    sum: finite,
    min: Schema.NullOr(finite),
    max: Schema.NullOr(finite),
    buckets: Schema.Array(Schema.Tuple([Schema.NullOr(finite), finite])),
  }),
]);
export const DiagnosticsSchema = Schema.Struct({
  version: Schema.Literal(1),
  startedAt: finite,
  uptimeMs: finite,
  droppedRecords: finite,
  logs: Schema.Array(LogRecord),
  spans: Schema.Array(SpanRecord),
  activeSpans: Schema.Array(SpanRecord),
  metrics: Schema.Array(MetricRecord),
  fiberCount: finite,
  fibers: Schema.Array(
    Schema.Struct({ id: finite, name: Schema.String, ageMs: finite, ...Correlation }),
  ),
});
type Diagnostics = typeof DiagnosticsSchema.Type;
type SpanView = typeof SpanRecord.Type;
type LogView = typeof LogRecord.Type;
const count = Metric.counter("iportal.operations", { incremental: true });
const duration = Metric.histogram("iportal.operation.duration_ms", {
  boundaries: [1, 5, 10, 25, 50, 100, 250, 500, 1000, 2000, 5000, 10000, 30000, 60000],
});
const queueDepth = Metric.gauge("iportal.queue.depth");
const queueActive = Metric.gauge("iportal.queue.active");
const knownLevels = new Set<LogLevel.LogLevel>([
  "All",
  "Trace",
  "Debug",
  "Info",
  "Warn",
  "Error",
  "Fatal",
  "None",
]);
function configuredLevel(value: string | undefined): LogLevel.LogLevel {
  return knownLevels.has(value as LogLevel.LogLevel) ? (value as LogLevel.LogLevel) : "Info";
}

export function createObservability({
  write = (line: string) => {
    if (process.stderr.writableLength > 65536) return false;
    return process.stderr.write(line);
  },
  level = configuredLevel(process.env.IPORTAL_LOG_LEVEL),
  capacity = 256,
}: { write?: (line: string) => unknown; level?: LogLevel.LogLevel; capacity?: number } = {}) {
  const limit = Math.max(1, Math.min(1024, Math.floor(capacity) || 256));
  const startedAt = Date.now();
  const origin = performance.now();
  const logs: LogView[] = [],
    spans: SpanView[] = [];
  const active = new Set<Tracer.Span>();
  const labels = new WeakMap<
    Fiber.Fiber<unknown, unknown>,
    { name: string; started: number; span?: Tracer.AnySpan }
  >();
  const scope = Scope.makeUnsafe();
  const fibers = Effect.runSync(FiberSet.make().pipe(Scope.provide(scope)));
  const current = new AsyncLocalStorage<Tracer.AnySpan | undefined>();
  let closed = false,
    droppedRecords = 0;
  const retain = <T>(array: T[], value: T) => {
    if (array.length === limit) array.shift();
    array.push(value);
  };
  const logger = Logger.make<unknown, void>((options) => {
    try {
      const message = Array.isArray(options.message) ? options.message[0] : options.message;
      if (typeof message !== "string" || !events.has(message)) return;
      const span = Context.getOption(options.fiber.context, Tracer.ParentSpan);
      const record: LogView = {
        timestamp: options.date.toISOString(),
        level: options.logLevel,
        event: message,
        processId: process.pid,
        fiberId: options.fiber.id,
        ...(Option.isSome(span) ? { traceId: span.value.traceId, spanId: span.value.spanId } : {}),
        attributes: attributes(options.fiber.getRef(References.CurrentLogAnnotations)),
      };
      retain(logs, record);
      if (write(JSON.stringify(record) + "\n") === false) droppedRecords++;
    } catch {
      droppedRecords++;
    } // Diagnostics must never fail an input.
  });
  const spanView = (span: Tracer.Span): SpanView => {
    const state = span.status;
    const fields = attributes(Object.fromEntries(span.attributes));
    const outcome =
      state._tag === "Started"
        ? "running"
        : Exit.isFailure(state.exit)
          ? Cause.hasInterruptsOnly(state.exit.cause)
            ? "interrupted"
            : fields.outcome === "unknown"
              ? "unknown"
              : "failure"
          : fields.outcome === "unknown"
            ? "unknown"
            : typeof fields.httpStatus === "number" && fields.httpStatus >= 400
              ? "failure"
              : "success";
    return {
      name: span.name,
      traceId: span.traceId,
      spanId: span.spanId,
      ...(Option.isSome(span.parent) ? { parentSpanId: span.parent.value.spanId } : {}),
      startedAt: Number(state.startTime / 1_000_000n),
      durationMs: Math.max(
        0,
        state._tag === "Ended"
          ? Number(state.endTime - state.startTime) / 1e6
          : Date.now() - Number(state.startTime / 1_000_000n),
      ),
      outcome,
      attributes: fields,
    };
  };
  const tracer = Tracer.make({
    span(options) {
      const span = new Tracer.NativeSpan(options);
      if (!names.has(options.name) || closed) return span;
      if (active.size < 512) active.add(span);
      else droppedRecords++;
      const end = span.end.bind(span);
      span.end = (time, exit) => {
        if (span.status._tag === "Ended") return;
        end(time, exit);
        active.delete(span);
        if (closed) return;
        try {
          const record = spanView(span);
          retain(spans, record);
          const tags = { operation: span.name, outcome: record.outcome };
          Effect.runSync(
            Effect.all([
              Metric.update(count.pipe(Metric.withAttributes(tags)), 1),
              Metric.update(duration.pipe(Metric.withAttributes(tags)), record.durationMs),
            ]).pipe(Effect.provideContext(context)),
          );
        } catch {
          droppedRecords++;
        }
      };
      return span;
    },
  });
  const context = Context.empty().pipe(
    Context.add(Logger.CurrentLoggers, new Set([logger])),
    Context.add(References.MinimumLogLevel, level),
    Context.add(Tracer.Tracer, tracer),
    Context.add(Metric.MetricRegistry, new Map()),
    Context.add(Metric.FiberRuntimeMetrics, Metric.FiberRuntimeMetricsImpl),
  );
  function provide<A, E, R>(effect: Effect.Effect<A, E, R>) {
    return effect.pipe(Effect.provideContext(context));
  }
  function instrument<A, E, R>(
    effect: Effect.Effect<A, E, R>,
    name: string,
    fields: Attributes = {},
    root = false,
  ) {
    const safeName = names.has(name) ? name : "server.request";
    return Effect.withFiber<A, E, R>((fiber) => {
      if (!closed) {
        FiberSet.addUnsafe(fibers, fiber);
        const span = Option.getOrUndefined(Context.getOption(fiber.context, Tracer.ParentSpan));
        labels.set(fiber, { name: safeName, started: performance.now(), span });
      }
      return effect;
    }).pipe(
      Effect.onExit((exit) =>
        Effect.gen(function* () {
          const fields: Attributes = { span: safeName };
          if (Exit.isFailure(exit)) {
            const error = Option.getOrUndefined(Cause.findErrorOption(exit.cause));
            if (error && typeof error === "object") {
              if ("code" in error && typeof error.code === "string" && errorCodes.has(error.code))
                fields.errorCode = error.code;
              if ("outcome" in error && error.outcome === "unknown") fields.outcome = "unknown";
            }
            yield* Effect.annotateCurrentSpan(fields);
          }
          yield* Effect.logDebug("operation-completed").pipe(Effect.annotateLogs(fields));
        }),
      ),
      Effect.withSpan(safeName, { attributes: attributes(fields), root }),
    );
  }
  // Bridge Promise entry points without changing their cancellation, rejection
  // identity, or ownership. The native operation keeps its original signal.
  function fromPromise<A>(
    name: string,
    run: (signal: AbortSignal) => Promise<A>,
    fields: Attributes = {},
  ) {
    return instrument(
      Effect.withFiber((fiber) => {
        const span = Option.getOrUndefined(Context.getOption(fiber.context, Tracer.ParentSpan));
        return Effect.tryPromise({
          try: (signal) => current.run(span, () => run(signal)),
          catch: (error) => error,
        });
      }),
      name,
      fields,
    );
  }
  async function promise<A>(
    name: string,
    run: () => Promise<A>,
    fields: Attributes = {},
  ): Promise<A> {
    if (closed) return run();
    let effect = fromPromise(name, run, fields);
    const parent = current.getStore();
    if (parent) effect = effect.pipe(Effect.withParentSpan(parent));
    const exit = await Effect.runPromiseExitWith(context)(effect);
    if (Exit.isSuccess(exit)) return exit.value;
    const error = Cause.findErrorOption(exit.cause);
    if (Option.isSome(error)) throw error.value;
    throw new Error("Observation interrupted", { cause: exit.cause });
  }
  function event(
    name: string,
    fields: Attributes = {},
    severity: "Info" | "Warning" | "Debug" = "Info",
  ) {
    if (closed || !events.has(name)) return;
    const log =
      severity === "Warning"
        ? Effect.logWarning
        : severity === "Debug"
          ? Effect.logDebug
          : Effect.logInfo;
    let effect = log(name).pipe(Effect.annotateLogs(attributes(fields)));
    const span = current.getStore();
    if (span) effect = effect.pipe(Effect.withParentSpan(span));
    Effect.runSync(provide(effect));
  }
  function startSpan(name: string, fields: Attributes = {}) {
    let effect = Effect.makeSpan(names.has(name) ? name : "helper.startup", {
      attributes: attributes(fields),
    });
    const parent = current.getStore();
    if (parent) effect = effect.pipe(Effect.withParentSpan(parent));
    const span = Effect.runSync(provide(effect));
    return {
      run<A>(run: () => A) {
        return current.run(span, run);
      },
      end(outcome: "success" | "failure" | "interrupted" = "success") {
        const exit =
          outcome === "success"
            ? Exit.void
            : outcome === "interrupted"
              ? Exit.interrupt()
              : Exit.fail("operation failed");
        span.end(BigInt(Date.now()) * 1_000_000n, exit);
      },
    };
  }
  function snapshot(): Diagnostics {
    const liveFibers = fibers.state._tag === "Closed" ? [] : [...fibers];
    const metrics = Metric.snapshotUnsafe(context).flatMap(
      (metric): Diagnostics["metrics"][number][] => {
        const base = { name: metric.id, attributes: metric.attributes ?? {} };
        switch (metric.type) {
          case "Counter":
            return [{ ...base, type: metric.type, count: Number(metric.state.count) }];
          case "Gauge":
            return [{ ...base, type: metric.type, value: Number(metric.state.value) }];
          case "Histogram":
            return [
              {
                ...base,
                type: metric.type,
                count: metric.state.count,
                sum: metric.state.sum,
                min: Number.isFinite(metric.state.min) ? metric.state.min : null,
                max: Number.isFinite(metric.state.max) ? metric.state.max : null,
                buckets: metric.state.buckets.map(
                  ([upper, value]) => [Number.isFinite(upper) ? upper : null, value] as const,
                ),
              },
            ];
          default:
            return [];
        }
      },
    );
    return Schema.decodeUnknownSync(DiagnosticsSchema)({
      version: 1,
      startedAt,
      uptimeMs: performance.now() - origin,
      droppedRecords,
      logs: [...logs],
      spans: [...spans],
      activeSpans: [...active].map(spanView),
      metrics,
      fiberCount: liveFibers.length,
      fibers: liveFibers.slice(0, 512).map((fiber) => {
        const label = labels.get(fiber);
        const liveSpan = Option.getOrUndefined(Context.getOption(fiber.context, Tracer.ParentSpan));
        const span = liveSpan?._tag === "Span" && names.has(liveSpan.name) ? liveSpan : label?.span;
        return {
          id: fiber.id,
          name: span?._tag === "Span" ? span.name : (label?.name ?? "server.lifetime"),
          ageMs:
            span?._tag === "Span"
              ? Math.max(0, Date.now() - Number(span.status.startTime / 1_000_000n))
              : label
                ? performance.now() - label.started
                : 0,
          ...(span ? { traceId: span.traceId, spanId: span.spanId } : {}),
        };
      }),
    });
  }
  return {
    provide,
    instrument,
    fromPromise,
    promise,
    event,
    startSpan,
    snapshot,
    fork<A, E>(effect: Effect.Effect<A, E>) {
      return Effect.runForkWith(context)(effect);
    },
    annotate(fields: Attributes) {
      const span = current.getStore();
      if (span?._tag === "Span")
        for (const [key, value] of Object.entries(attributes(fields))) span.attribute(key, value);
    },
    bind<A>(run: () => A) {
      const span = current.getStore();
      return () => current.run(span, run);
    },
    detached<A>(run: () => A) {
      return current.run(undefined, run);
    },
    queue(queued: number, active: boolean) {
      if (!closed)
        Effect.runSync(
          provide(
            Effect.all([
              Metric.update(queueDepth, queued),
              Metric.update(queueActive, active ? 1 : 0),
            ]),
          ),
        );
    },
    // Closing the scope interrupts the HTTP server, which then waits for its
    // open connections. A process on its way out passes a deadline: it must
    // not keep its device lease for a response nobody is going to finish.
    async close(deadlineMs?: number) {
      if (closed) return;
      const closing = Effect.runPromise(Scope.close(scope, Exit.void));
      let timer: ReturnType<typeof setTimeout> | undefined;
      await (deadlineMs === undefined
        ? closing
        : Promise.race([
            closing,
            new Promise<void>((resolve) => {
              timer = setTimeout(resolve, deadlineMs);
            }),
          ]));
      clearTimeout(timer);
      for (const span of active) span.end(BigInt(Date.now()) * 1_000_000n, Exit.interrupt());
      closed = true;
    },
  };
}
export const observability = createObservability();
