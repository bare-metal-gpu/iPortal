import { stubCommand } from "./helper-stub.ts";
import { test } from "bun:test";
import assert from "node:assert/strict";
import corpus from "./fixtures/helper-contract.json" with { type: "json" };
import { decodeHelper, helperOperations, HelperReplySchema } from "../helper-protocol.ts";
import { createHelperClient } from "../helper-client.ts";
import { createHelperAuthentication } from "../helper-auth.mjs";
import { createHelperLifecycle } from "../helper-lifecycle.ts";

const generation = "00000000-0000-4000-8000-000000000001";
const state = {
  protocol: 1,
  build: "native-1",
  generation,
  phase: "ready",
  automationReady: true,
  locked: false,
  activeOperation: null,
  capabilities: {
    touch: true,
    multiTouch: true,
    keyboard: true,
    inspection: true,
    clipboard: true,
    video: true,
  },
} as const;
const reply = (body: unknown) => Response.json(body, { headers: { "x-iportal-helper-auth": "1" } });
function setup(fetch: (request: Request) => Response | Promise<Response>) {
  const server = Bun.serve({ port: 0, fetch });
  const client = createHelperClient({
    url: `http://127.0.0.1:${server.port}`,
    socket: () => null,
    authentication: createHelperAuthentication(),
  });
  return { client, stop: () => server.stop(true) };
}

test("helper rejects incompatible builds and malformed status responses", async () => {
  for (const [body, code] of [
    [{ ...state, build: "obsolete" }, "incompatible helper"],
    [{ ...state, locked: "false" }, "invalid response"],
    [{ ...state, capabilities: { ...state.capabilities, clipboard: 1 } }, "invalid response"],
    [{ ...state, displayPixels: { width: 0, height: 2622 } }, "invalid response"],
    [{ ...state, displayPixels: { width: 1206, height: Infinity } }, "invalid response"],
  ] as const) {
    const s = setup(() => reply(body));
    try {
      await assert.rejects(s.client.status(), { code });
    } finally {
      await s.stop();
    }
  }
});
test("mutations are never replayed after an uncertain or mismatched reply", async () => {
  for (const bad of ["generation", "result", "envelope"]) {
    let commands = 0;
    const s = setup(async (request) => {
      if (request.method === "GET") return reply(state);
      commands++;
      const body = (await request.json()) as { id: string };
      return reply({
        id: body.id,
        generation: bad === "generation" ? "other" : generation,
        ...(bad === "envelope"
          ? { result: null, error: { code: "bad", message: "bad", outcome: "unknown" } }
          : { result: bad === "result" ? "wrong" : null }),
      });
    });
    try {
      await assert.rejects(s.client.command("home"), {
        code: "invalid response",
        outcome: "unknown",
      });
      assert.equal(commands, 1);
    } finally {
      await s.stop();
    }
  }
});
test("late status from a retired transport cannot overwrite new readiness", async () => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  let count = 0;
  const s = setup(async () => {
    if (++count === 1) await pending;
    return reply(state);
  });
  try {
    const old = s.client.status().catch((error) => error);
    await Bun.sleep(20);
    s.client.reset();
    await s.client.ready();
    release();
    assert.equal((await old).code, "stale generation");
    assert.equal(s.client.cached?.generation, generation);
  } finally {
    release();
    await s.stop();
  }
});
test("cancelled status observations do not invalidate a healthy helper", async () => {
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  let count = 0;
  const s = setup(async () => {
    if (++count === 2) {
      entered();
      await pending;
    }
    return reply(state);
  });
  try {
    const healthy = await s.client.status();
    const controller = new AbortController();
    const probe = s.client.status(controller.signal).catch((error) => error);
    await started;
    controller.abort();
    await probe;
    assert.equal(s.client.cached, healthy, "Cancelling an obsolete read is not a disconnect");
  } finally {
    release();
    await s.stop();
  }
});
test("failed older probes cannot erase newer authenticated status", async () => {
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  let count = 0;
  const s = setup(async () => {
    if (++count === 2) {
      entered();
      await pending;
      return new Response(null, { status: 503 });
    }
    return reply(state);
  });
  try {
    await s.client.status();
    const probe = s.client.status().catch((error) => error);
    await started;
    const healthy = await s.client.status();
    release();
    await probe;
    assert.equal(s.client.cached, healthy);
  } finally {
    release();
    await s.stop();
  }
});
test("opening a URL is not replayed when the helper response has an unknown outcome", async () => {
  let commands = 0;
  const s = setup(async (request) => {
    if (request.method === "GET") return reply(state);
    commands++;
    const body = (await request.json()) as { id: string; operation: string };
    assert.equal(body.operation, "openURL");
    return reply({
      id: body.id,
      generation,
      error: {
        code: "timeout",
        message: "Native completion missing",
        outcome: "unknown",
      },
    });
  });
  try {
    await assert.rejects(s.client.command("openURL", { url: "https://example.com/" }), {
      outcome: "unknown",
    });
    assert.equal(commands, 1);
  } finally {
    await s.stop();
  }
});
test("lifecycle isolates launcher generations, route changes and bounded recovery", () => {
  let now = 0;
  const lifecycle = createHelperLifecycle("owner-a", () => now);
  const first = lifecycle.begin();
  lifecycle.routeChanged();
  assert.equal(lifecycle.state.phase, "starting");
  lifecycle.observe({ ...state, locked: null });
  assert.equal(lifecycle.state.phase, "authenticating");
  lifecycle.observe(state);
  assert.equal(lifecycle.state.phase, "ready");
  const replacement = lifecycle.begin();
  assert.equal(lifecycle.exit(first), false);
  assert(lifecycle.owns(replacement));
  for (let n = 0; n < 3; n++) assert(lifecycle.recover());
  assert.equal(lifecycle.recover(), false);
  assert.equal(lifecycle.state.phase, "blocked");
  now = 61000;
  assert(lifecycle.recover());
  lifecycle.stop();
  assert.equal(lifecycle.recover(), false);
  lifecycle.observe(state);
  assert.equal(lifecycle.state.phase, "stopping");
  assert.equal(lifecycle.exit(replacement), false);
  assert.equal(lifecycle.begin(), null);
});

test("Effect accepts the shared native command/error corpus and rejects unknown fields", () => {
  assert.equal(corpus.commands.length, Object.keys(helperOperations).length);
  for (const command of corpus.commands) {
    const schema = helperOperations[command.operation].request;
    decodeHelper(schema, command.arguments);
    assert.throws(() => decodeHelper(schema, { ...command.arguments, unknown: true }));
    for (const key of Object.keys(command.arguments))
      assert.throws(() => decodeHelper(schema, { ...command.arguments, [key]: null }));
  }
  for (const error of corpus.errors)
    decodeHelper(HelperReplySchema, { id: "request-1", generation: corpus.generation, error });
});

test("observation counts the stability already observed between two slow snapshots", async () => {
  const { createInspection } = await import("../inspection.ts");
  let sources = 0;
  const inspection = createInspection({
    enqueue: async (fn) => fn(),
    helper: {
      command: stubCommand(async (operation) => {
        if (operation === "app") return { bundleId: "com.example.fixture" };
        if (operation === "orientation") return "PORTRAIT";
        if (operation === "source") {
          sources++;
          await Bun.sleep(70);
          return { type: "Application" };
        }
        throw new Error(operation);
      }),
    },
  });
  const observation = await inspection.observe({ screenshot: false, settleMs: 50, timeoutMs: 220 });
  assert(observation.stable);
  assert.equal(sources, 2);
});

test("stable attribute waits ignore fresh native handles for the same observed value", async () => {
  const { createInspection } = await import("../inspection.ts");
  const { createScheduler } = await import("../scheduler.ts");
  let reads = 0;
  const fixture = corpus.results.find((r) => r.operation === "elements")!.result as {
    id: string;
    attributes: Record<string, unknown>;
  }[];
  const s = setup(async (request) => {
    if (request.method === "GET") return reply(state);
    const body = (await request.json()) as { id: string };
    reads++;
    return reply({
      id: body.id,
      generation,
      result: fixture.map((e) => ({ ...e, id: `fresh-${reads}` })),
    });
  });
  try {
    const inspection = createInspection({ helper: s.client, enqueue: createScheduler().enqueue });
    const result = await inspection.wait({
      selector: { using: "id", value: "fixture" },
      condition: "attribute",
      attribute: "enabled",
      equals: true,
      stableForMs: 60,
      intervalMs: 50,
      timeoutMs: 600,
    });
    assert.equal(result.matched, true);
    assert(reads >= 2);
  } finally {
    await s.stop();
  }
});
