import { test } from "bun:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { randomBytes } from "node:crypto";
import { Effect, Stream } from "effect";
import { openVideoStream, readBody } from "../server.mjs";
import { startFakeIphone } from "./fake-iphone.mjs";
import { serverCommand, runtimeEnvironment } from "./server-command.mjs";
import { readJSON } from "./json.mjs";

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

// A managed server as the Mac app starts one, on a port the system picks.
function startMirror(scratch, args, env) {
  const child = spawn(
    serverCommand[0],
    [
      ...serverCommand.slice(1),
      "--no-open",
      "--managed",
      "--owner",
      "test",
      "--port",
      "0",
      ...args,
    ],
    {
      cwd: scratch,
      env: { ...runtimeEnvironment(scratch), IPORTAL_LOG_LEVEL: "None", ...env },
      stdio: ["ignore", "pipe", "inherit"],
    },
  );
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  return {
    child,
    async base() {
      for (let i = 0; i < 200; i++) {
        const port = output.match(/"event":"iportal-listening".*"port":(\d+)/)?.[1];
        if (port) return `http://127.0.0.1:${port}`;
        assert.equal(child.exitCode, null, "server must stay up");
        await wait(25);
      }
      throw new Error("server did not start");
    },
    // The interval a closed mirror keeps its device lease.
    async terminate() {
      const exited = once(child, "exit");
      const started = performance.now();
      child.kill("SIGTERM");
      const guard = setTimeout(() => child.kill("SIGKILL"), 8000);
      await exited;
      clearTimeout(guard);
      return performance.now() - started;
    },
  };
}
/** @param {string} url */
async function openStream(url) {
  const response = await fetch(url);
  assert.equal(response.status, 200);
  assert(response.body);
  return response.body.getReader();
}
// Resolves when the server ends the response, however it ends it.
/** @param {{read: () => Promise<{done: boolean}>}} reader */
function ended(reader) {
  return (async () => {
    try {
      while (!(await reader.read()).done);
    } catch {
      /* A reset connection is also an ended response. */
    }
  })();
}

test("SIGTERM exits promptly under open event and video streams, and keeps the receipt", async () => {
  const scratch = fs.mkdtempSync("/tmp/iportal-term-");
  const udid = `${randomBytes(4).toString("hex")}-${randomBytes(8).toString("hex")}`.toUpperCase();
  const fake = startFakeIphone({
    helperPort: 18340,
    socketPath: path.join(scratch, "mux.sock"),
  });
  fake.ui.devices = [{ id: 7, udid, connection: "USB" }];
  const env = {
    IPORTAL_HELPER_TOKEN: fake.helperToken,
    USBMUXD_SOCKET_ADDRESS: path.join(scratch, "mux.sock"),
    IPORTAL_COMMANDS_FILE: path.join(scratch, "commands.json"),
  };
  const mirrors = [];
  try {
    const first = startMirror(scratch, ["--udid", udid], env);
    mirrors.push(first);
    const base = await first.base();
    for (let i = 0; i < 100; i++) {
      if ((await readJSON(await fetch(`${base}/api/status`))).lifecycle === "ready") break;
      await wait(50);
    }
    // What an open mirror page holds: the status stream and the video stream.
    const events = await openStream(`${base}/api/events`);
    const video = await openStream(`${base}/stream`);
    assert.ok((await events.read()).value?.length);
    assert.ok((await video.read()).value?.length);
    // And a command the phone has started but not acknowledged.
    fake.ui.delayMs = 15000;
    const command = fetch(`${base}/api/home`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ requestId: "interrupted-by-close" }),
    }).then(
      (response) => readJSON(response),
      () => null,
    );
    for (let i = 0; i < 100 && !fake.log.some((entry) => entry.operation === "home"); i++)
      await wait(20);
    assert.ok(
      fake.log.some((entry) => entry.operation === "home"),
      "command reached the phone",
    );

    const streamsEnded = Promise.all([ended(events), ended(video)]);
    const elapsed = await first.terminate();
    assert.ok(elapsed < 1500, `exit took ${Math.round(elapsed)} ms with a page open`);
    await streamsEnded;
    const reply = await command;
    if (reply) assert.equal(reply.outcome, "unknown", "an interrupted input is never a success");

    // The lease is free at once, and the next server knows the outcome is unknown.
    fake.ui.delayMs = 0;
    const second = startMirror(scratch, ["--udid", udid], env);
    mirrors.push(second);
    const receipt = await readJSON(
      await fetch(`${await second.base()}/api/commands/interrupted-by-close`),
    );
    assert.equal(receipt.value.state, "unknown");
    assert.equal(receipt.value.response.body.outcome, "unknown");
    assert.ok((await second.terminate()) < 1500);
  } finally {
    for (const mirror of mirrors) if (mirror.child.exitCode === null) mirror.child.kill("SIGKILL");
    fake.close();
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test("the Android composition also exits promptly under an open event stream", async () => {
  const scratch = fs.mkdtempSync("/tmp/iportal-term-");
  // Neither a real adb nor a real device: an executable that does nothing and
  // an adb server with an empty device list.
  const adb = path.join(scratch, "adb");
  fs.writeFileSync(adb, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const sockets = new Set();
  const adbServer = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    socket.once("data", () => socket.write("OKAY0000"));
  });
  await new Promise((resolve) => adbServer.listen(0, "127.0.0.1", () => resolve(undefined)));
  let mirror;
  try {
    mirror = startMirror(
      scratch,
      ["--platform", "android", "--udid", `TEST${randomBytes(6).toString("hex")}`],
      {
        ADB: adb,
        ANDROID_ADB_SERVER_PORT: String(
          /** @type {import("node:net").AddressInfo} */ (adbServer.address()).port,
        ),
        IPORTAL_COMMANDS_FILE: path.join(scratch, "commands.json"),
      },
    );
    const events = await openStream(`${await mirror.base()}/api/events`);
    assert.match(new TextDecoder().decode((await events.read()).value), /"platform":"android"/);
    const streamEnded = ended(events);
    const elapsed = await mirror.terminate();
    assert.ok(elapsed < 1500, `exit took ${Math.round(elapsed)} ms with a page open`);
    await streamEnded;
  } finally {
    if (mirror?.child.exitCode === null) mirror.child.kill("SIGKILL");
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => adbServer.close(resolve));
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
