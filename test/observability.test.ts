import { test, expect } from "bun:test";
import { Effect, Fiber, References, Schema } from "effect";
import { createObservability, DiagnosticsSchema, observability } from "../observability.ts";
import { createScheduler } from "../scheduler.ts";
import { startServer } from "../server.mjs";

test("Effect spans correlate through Promise boundaries, and metrics remain per-owner", async () => {
  const lines: string[] = [];
  const telemetry = createObservability({ level: "Debug", write: (line) => lines.push(line) });
  const other = createObservability({ write: () => {} });
  try {
    const result = await telemetry.promise("api.type", async () => {
      telemetry.event("helper-launch", {
        mode: "installed",
        text: "PRIVATE_INPUT",
        authorization: "PRIVATE_TOKEN",
      });
      return telemetry.promise("helper.type", async () => "PRIVATE_RESULT");
    });
    expect(result).toBe("PRIVATE_RESULT");
    const data = telemetry.snapshot();
    Schema.decodeUnknownSync(DiagnosticsSchema)(data);
    const parent = data.spans.find((span) => span.name === "api.type")!;
    const child = data.spans.find((span) => span.name === "helper.type")!;
    expect(child.traceId).toBe(parent.traceId);
    expect(child.parentSpanId).toBe(parent.spanId);
    expect(data.logs.some((log) => log.traceId === parent.traceId)).toBe(true);
    expect(
      data.metrics.some(
        (metric) =>
          metric.name === "iportal.operation.duration_ms" &&
          metric.type === "Histogram" &&
          metric.count === 1,
      ),
    ).toBe(true);
    expect(data.metrics.filter((metric) => metric.name === "iportal.operations")).toHaveLength(2);
    expect(data.fibers).toHaveLength(0);
    expect(other.snapshot().metrics).toHaveLength(0);
    expect(JSON.stringify([data, lines])).not.toContain("PRIVATE_");
  } finally {
    await telemetry.close();
    await other.close();
  }
});

test("logging respects Effect levels, drops unapproved content and tolerates a broken sink", async () => {
  const lines: string[] = [];
  const telemetry = createObservability({
    write: (line) => {
      lines.push(line);
      throw new Error("disk unavailable");
    },
  });
  try {
    telemetry.event("helper-launch", {
      mode: "installed",
      device: "PRIVATE_DEVICE",
      durationMs: Infinity,
    });
    telemetry.event("helper-launch", {}, "Debug");
    Effect.runSync(telemetry.provide(Effect.logInfo("PRIVATE_ERROR", new Error("PRIVATE_SECRET"))));
    const failure = Object.assign(new Error("PRIVATE_INPUT"), { outcome: "unknown" });
    let caught: unknown;
    try {
      await telemetry.promise("helper.type", async () => {
        throw failure;
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(failure);
    expect(lines).toHaveLength(1);
    const data = telemetry.snapshot();
    expect(data.droppedRecords).toBe(1);
    expect(data.spans[0]?.outcome).toBe("unknown");
    expect(JSON.stringify([lines, data])).not.toContain("PRIVATE_");
  } finally {
    await telemetry.close();
  }
});

test("disabled tracing never prevents the original operation from executing", async () => {
  const telemetry = createObservability({ write: () => {} });
  try {
    const value = await Effect.runPromise(
      telemetry
        .provide(telemetry.fromPromise("api.tap", async () => 42))
        .pipe(Effect.provideService(References.TracerEnabled, false)),
    );
    expect(value).toBe(42);
  } finally {
    await telemetry.close();
  }
});

test("diagnostic history and arbitrary span names cannot grow cardinality", async () => {
  const telemetry = createObservability({ capacity: 3, write: () => {} });
  try {
    for (let i = 0; i < 12; i++) {
      telemetry.event("helper-launch", { mode: "installed" });
      await telemetry.promise(`PRIVATE_PATH_${i}`, async () => {});
    }
    const data = telemetry.snapshot();
    expect(data.spans).toHaveLength(3);
    expect(data.logs).toHaveLength(3);
    expect(data.metrics.filter((metric) => metric.name === "iportal.operations")).toHaveLength(1);
    expect(JSON.stringify(data)).not.toContain("PRIVATE_");
  } finally {
    await telemetry.close();
  }
});

test("FiberSet removes completed fibers and scope closure runs background finalizers", async () => {
  const telemetry = createObservability({ write: () => {} });
  let finalized = false;
  const fiber = telemetry.fork(
    telemetry.instrument(
      Effect.never.pipe(
        Effect.ensuring(
          Effect.sync(() => {
            finalized = true;
          }),
        ),
      ),
      "helper.events",
    ),
  );
  expect(
    telemetry
      .snapshot()
      .fibers.some((entry) => entry.id === fiber.id && entry.name === "helper.events"),
  ).toBe(true);
  await telemetry.close();
  expect(finalized).toBe(true);
  const data = telemetry.snapshot();
  expect(data.fibers).toHaveLength(0);
  expect(data.activeSpans).toHaveLength(0);
  expect(data.spans.some((span) => span.outcome === "interrupted")).toBe(true);
});

test("queued commands retain their own trace and cancellation does not release executing work", async () => {
  const telemetry = createObservability({ write: () => {} });
  const scheduler = createScheduler({ telemetry });
  const gate = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  let secondRan = false,
    firstSettled = false;
  try {
    const first = telemetry
      .promise("api.type", () =>
        scheduler.enqueue(
          async () => {
            entered.resolve();
            await gate.promise;
            return "first";
          },
          { operationTimeoutMs: 15 },
        ),
      )
      .finally(() => {
        firstSettled = true;
      });
    await entered.promise;
    const second = telemetry.promise("api.tap", () =>
      scheduler.enqueue(async () => {
        secondRan = true;
      }),
    );
    await Bun.sleep(25);
    expect(scheduler.stats().active).toBe(true);
    expect(secondRan).toBe(false);
    expect(firstSettled).toBe(false);
    expect(telemetry.snapshot().fibers.length).toBeGreaterThan(1);
    gate.resolve();
    await Promise.all([first, second]);
    const data = telemetry.snapshot();
    const requests = data.spans.filter((span) => span.name.startsWith("api."));
    expect(requests[0]!.traceId).not.toBe(requests[1]!.traceId);
    for (const parent of requests) {
      expect(
        data.spans.some(
          (span) =>
            span.name === "queue.execute" &&
            span.parentSpanId === parent.spanId &&
            span.traceId === parent.traceId,
        ),
      ).toBe(true);
      expect(
        data.spans.some((span) => span.name === "queue.wait" && span.traceId === parent.traceId),
      ).toBe(true);
    }
  } finally {
    gate.resolve();
    await telemetry.close();
  }
});

test("HTTP diagnostics retain host protections, omit request contents, and server interruption is clean", async () => {
  const listening = Promise.withResolvers<number>();
  const server = startServer({
    port: 0,
    instanceId: "diagnostic-test",
    html: "",
    mjpeg: "http://127.0.0.1:1",
    dispatch: async () => ({ status: 200, body: { ok: true } }),
    onListening: listening.resolve,
  });
  try {
    const port = await listening.promise,
      url = `http://127.0.0.1:${port}`;
    const forbidden = await fetch(`${url}/api/diagnostics`, {
      headers: { origin: "https://evil.example" },
    });
    expect(forbidden.status).toBe(403);
    const invalid = await fetch(`${url}/api/type?PRIVATE_QUERY`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"text": "PRIVATE_BODY", INVALID',
    });
    expect(invalid.status).toBe(400);
    const untrustedTrace = "11111111111111111111111111111111";
    const response = await fetch(`${url}/api/diagnostics`, {
      headers: { traceparent: `00-${untrustedTrace}-2222222222222222-01` },
    });
    expect(response.status).toBe(200);
    const data = Schema.decodeUnknownSync(DiagnosticsSchema)(await response.json());
    expect(data.fibers.some((fiber) => fiber.name === "server.lifetime")).toBe(true);
    expect(
      data.spans.some((span) => span.name === "server.request" && span.outcome === "failure"),
    ).toBe(true);
    expect(JSON.stringify(data)).not.toContain("PRIVATE_");
    expect(JSON.stringify(data)).not.toContain(untrustedTrace);
  } finally {
    await Effect.runPromise(Fiber.interrupt(server));
  }
  expect(observability.snapshot().fibers.some((fiber) => fiber.id === server.id)).toBe(false);
});
