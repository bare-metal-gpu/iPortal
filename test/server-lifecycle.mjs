import { test } from "bun:test";
import assert from "node:assert/strict";
import http from "node:http";
import { Effect, Stream } from "effect";
import { openVideoStream, readBody } from "../server.mjs";

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("Bun request bodies enforce actual bytes, malformed JSON and cancellation", async () => {
  const signal = new AbortController();
  const request = (body) => new Request("http://localhost/test", { method: "POST", body });
  assert.deepEqual(await readBody(request('{"value":1}'), signal.signal), { value: 1 });
  await assert.rejects(readBody(request("not json"), signal.signal), /Invalid JSON/);
  await assert.rejects(readBody(request("123456789"), signal.signal, 8), /size limit/);
  let cancelled = false;
  const stream = new ReadableStream({
    cancel() {
      cancelled = true;
    },
  });
  const pending = readBody(request(stream), signal.signal);
  signal.abort(new Error("owner closed"));
  await assert.rejects(pending, /owner closed/);
  assert.ok(cancelled, "cancellation releases the request reader");
});
async function upstream(handler) {
  const sockets = new Set();
  const requestedSockets = new Set();
  const server = http.createServer((req, res) => {
    requestedSockets.add(req.socket);
    handler(req, res);
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => {
      sockets.delete(socket);
      requestedSockets.delete(socket);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(undefined)));
  return {
    url: `http://127.0.0.1:${/** @type {import("node:net").AddressInfo} */ (server.address()).port}`,
    sockets: requestedSockets,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
async function collect(url, options, take) {
  return Effect.runPromise(
    Effect.gen(function* () {
      const source = yield* openVideoStream(url, options);
      assert.match(source.contentType, /multipart/);
      return yield* Stream.runCollect(take ? source.stream.pipe(Stream.take(take)) : source.stream);
    }),
  );
}
async function assertReleased(source) {
  for (let i = 0; i < 20 && source.sockets.size; i++) await wait(10);
  assert.equal(source.sockets.size, 0, "upstream socket released");
}

test("video connection deadline closes an upstream that never sends headers", async () => {
  const source = await upstream(() => {});
  try {
    const started = performance.now();
    await assert.rejects(collect(source.url, { connectTimeoutMs: 50, idleTimeoutMs: 80 }));
    assert.ok(performance.now() - started < 1000);
    await assertReleased(source);
  } finally {
    await source.close();
  }
});

test("silent video read stalls terminate, release the socket and allow reconnect", async () => {
  let requests = 0;
  const source = await upstream((_req, res) => {
    res.writeHead(200, { "content-type": "multipart/x-mixed-replace; boundary=frame" });
    res.write("frame");
    if (++requests > 1) res.end("recovered");
  });
  try {
    const first = await collect(source.url, { connectTimeoutMs: 100, idleTimeoutMs: 50 });
    assert.equal(Buffer.concat(first.map((x) => Buffer.from(x))).toString(), "frame");
    await assertReleased(source);
    const second = await collect(source.url, { connectTimeoutMs: 100, idleTimeoutMs: 50 });
    assert.equal(Buffer.concat(second.map((x) => Buffer.from(x))).toString(), "framerecovered");
  } finally {
    await source.close();
  }
});

test("downstream cancellation releases an active video stream immediately", async () => {
  const source = await upstream((_req, res) => {
    res.writeHead(200, { "content-type": "multipart/x-mixed-replace; boundary=frame" });
    res.write("frame");
  });
  try {
    await collect(source.url, { connectTimeoutMs: 100, idleTimeoutMs: 5000 }, 1);
    await assertReleased(source);
  } finally {
    await source.close();
  }
});

test("connection deadline does not truncate a healthy long-lived stream", async () => {
  const source = await upstream((_req, res) => {
    res.writeHead(200, { "content-type": "multipart/x-mixed-replace; boundary=frame" });
    res.flushHeaders();
    let frames = 0;
    const interval = setInterval(() => {
      res.write("frame");
      if (++frames === 5) res.end();
    }, 30);
    res.on("close", () => clearInterval(interval));
  });
  try {
    const frames = await collect(source.url, { connectTimeoutMs: 50, idleTimeoutMs: 100 });
    assert.equal(Buffer.concat(frames.map((x) => Buffer.from(x))).toString(), "frame".repeat(5));
  } finally {
    await source.close();
  }
});
