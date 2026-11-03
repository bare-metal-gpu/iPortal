import http from "node:http";
import { Cause, Effect, Layer, Stream } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/http";
import { NodeHttpServer } from "@effect/platform-node";
import { apiError } from "./inspection.mjs";
import { decodeRequest, RequestSchemas } from "./schemas.mjs";

export function errorResponse(e) {
  const status = e.status ?? ({ "no such element": 404, "stale element reference": 409, "invalid element state": 409, "invalid argument": 400, "invalid selector": 400 }[e.code])
    ?? (e._tag === "SchemaError" ? 400 : e.name === "TimeoutError" ? 408 : e.name === "AbortError" ? 499 : 502);
  return { status, body: { ok: false, error: e.message ?? String(e), code: e.code ?? (status === 400 ? "invalid argument" : status === 408 ? "timeout" : "upstream error"), ...(e.details ? { details: e.details } : {}) } };
}

// Trust local OS clients, and bind browser clients automatically to this server instance.
// No account, pairing dialog or user-managed secret. Host checks also reject DNS rebinding.
export function checkRequest(request, port, instanceId) {
  const headers = request.headers;
  const allowed = new Set([`localhost:${port}`, `127.0.0.1:${port}`]);
  if (!allowed.has(headers.host)) throw apiError("Unexpected Host", 403, "forbidden");
  if (headers.origin && ![...allowed].some(host => headers.origin === `http://${host}`)) throw apiError("Unexpected Origin", 403, "forbidden");
  if (headers["sec-fetch-site"] === "cross-site" || (headers["sec-fetch-site"] === "same-site" && !headers.origin)) throw apiError("Cross-site request rejected", 403, "forbidden");
  if (request.method === "POST") {
    if (!/^application\/json(?:\s*;|$)/i.test(headers["content-type"] ?? "")) throw apiError("Content-Type must be application/json", 415, "unsupported media type");
    if ((headers.origin || headers["sec-fetch-site"]) && headers["x-mirror-instance"] !== instanceId) throw apiError("Reload the mirror to reconnect", 409, "instance changed");
  }
}

function readBody(req, signal) {
  return new Promise((resolve, reject) => {
    let length = 0;
    const chunks = [];
    const cleanup = () => signal.removeEventListener("abort", abort);
    const abort = () => { cleanup(); reject(signal.reason); };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) return abort();
    req.on("data", chunk => {
      length += chunk.length;
      if (length > 1024 * 1024) { chunks.length = 0; cleanup(); reject(apiError("Request body exceeds 1 MiB", 413)); }
      else chunks.push(chunk);
    });
    req.on("error", error => { cleanup(); reject(error); });
    req.on("aborted", abort);
    req.on("end", () => {
      cleanup(); if (length > 1024 * 1024) return;
      try { resolve(length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}); }
      catch { reject(apiError("Invalid JSON body")); }
    });
  });
}

// The handshake and each idle read are bounded independently. A permanent
// timeout on fetch's signal would also kill healthy long-running video.
export function openVideoStream(url, { connectTimeoutMs = 3000, idleTimeoutMs = 5000 } = {}) {
  return Effect.gen(function*() {
    const controller = new AbortController();
    const upstream = yield* Effect.tryPromise(async signal => {
      const timeout = setTimeout(() => controller.abort(apiError("Video connection timed out", 504, "timeout")), connectTimeoutMs);
      timeout.unref?.();
      try {
        const response = await fetch(url, { signal: AbortSignal.any([signal, controller.signal]), headers: { connection: "close" } });
        if (!response.ok || !response.body) throw apiError("Video stream unavailable", 502, "video unavailable");
        return response;
      } catch (error) {
        controller.abort();
        throw error;
      } finally { clearTimeout(timeout); }
    });
    return {
      contentType: upstream.headers.get("content-type") ?? "multipart/x-mixed-replace",
      stream: Stream.fromReadableStream({ evaluate: () => upstream.body, onError: e => e }).pipe(
        Stream.timeout(idleTimeoutMs),
        Stream.ensuring(Effect.sync(() => controller.abort())),
      ),
    };
  });
}

export function startServer({ port, instanceId, html, mjpeg, dispatch, statusEvents, onListening }) {
  const headers = { "cache-control": "no-store", "x-mirror-instance": instanceId, "x-content-type-options": "nosniff", "cross-origin-resource-policy": "same-origin", "referrer-policy": "no-referrer" };
  const json = response => HttpServerResponse.jsonUnsafe(response.body, { status: response.status, headers });
  const handler = request => Effect.gen(function*() {
    yield* Effect.try(() => checkRequest(request, port, instanceId));
    const url = new URL(request.url, `http://localhost:${port}`);
    if (request.method === "GET" && url.pathname === "/") {
      return HttpServerResponse.text(html.replace("<head>", `<head><meta name="mirror-instance" content="${instanceId}">`), { contentType: "text/html", headers });
    }
    if (request.method === "GET" && url.pathname === "/api/health") {
      // Process liveness must not depend on USB, XCTest, lock state or a session.
      return json({ status: 200, body: { service: "iphone-mirror", apiVersion: 2, instanceId, ok: true } });
    }
    if (request.method === "GET" && url.pathname === "/api/events" && statusEvents) {
      return HttpServerResponse.stream(Stream.fromReadableStream({ evaluate: () => statusEvents.stream(), onError: e => e }), {
        headers: { ...headers, "content-type": "text/event-stream", "x-accel-buffering": "no" },
      });
    }
    if (request.method === "GET" && url.pathname === "/stream") {
      const video = yield* openVideoStream(mjpeg);
      return HttpServerResponse.stream(video.stream, {
        headers: { ...headers, "content-type": video.contentType },
      });
    }
    const name = url.pathname.match(/^\/api\/([\w-]+)$/)?.[1];
    const command = url.pathname.match(/^\/api\/commands\/([a-zA-Z0-9._:-]+)$/)?.[1];
    if (request.method === "GET" && (name === "status" || name === "keep-awake" || command)) {
      return json(yield* Effect.tryPromise(signal => dispatch(command ? "command-status" : name, command ? { requestId: command } : {}, signal)));
    }
    if (request.method !== "POST" || !name || !Object.hasOwn(RequestSchemas, name)) return json({ status: 404, body: { ok: false, error: "Not found" } });
    const raw = yield* Effect.tryPromise(signal => readBody(request.source, signal));
    const body = yield* decodeRequest(name, raw);
    return json(yield* Effect.tryPromise(signal => dispatch(name, body, signal)));
  }).pipe(Effect.catch(e => Effect.succeed(json(errorResponse(e.cause instanceof Error && e._tag === "UnknownError" ? e.cause : e)))));

  const routes = HttpRouter.add("*", "/*", handler);
  const live = HttpRouter.serve(routes, { disableLogger: true, disableListenLog: true }).pipe(
    Layer.provide(NodeHttpServer.layer(() => {
      const server = http.createServer({ requestTimeout: 10000, headersTimeout: 10000, connectionsCheckingInterval: 1000 });
      server.once("listening", onListening);
      return server;
    }, { port, host: "127.0.0.1" })),
  );
  return Effect.runFork(Layer.launch(live).pipe(Effect.catchCause(cause => Effect.sync(() => {
    console.error("Could not start mirror server:", Cause.pretty(cause));
    process.exit(1);
  }))));
}
