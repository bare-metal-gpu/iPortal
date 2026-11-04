import { Cause, Effect, Layer, Stream } from "effect";
import { HttpRouter, HttpServer, HttpServerResponse } from "effect/http";
import { BunHttpServer } from "@effect/platform-bun";
import { apiError } from "./errors.mjs";
import { decodeRequest, RequestSchemas } from "./schemas.mjs";
import { interFont } from "./web-assets.mjs";

/** @returns {{status: number, body: Record<string, any>}} */
export function errorResponse(e) {
  const status =
    e.status ??
    {
      "no such element": 404,
      "stale element reference": 409,
      "invalid element state": 409,
      "invalid argument": 400,
      "invalid selector": 400,
    }[e.code] ??
    (e._tag === "SchemaError"
      ? 400
      : e.name === "TimeoutError"
        ? 408
        : e.name === "AbortError"
          ? 499
          : 502);
  return {
    status,
    body: {
      ok: false,
      error: e.message ?? String(e),
      code:
        e.code ??
        (status === 400 ? "invalid argument" : status === 408 ? "timeout" : "upstream error"),
      ...(e.details ? { details: e.details } : {}),
    },
  };
}

// Trust local OS clients, and bind browser clients automatically to this server instance.
// No account, pairing dialog or user-managed secret. Host checks also reject DNS rebinding.
export function checkRequest(request, port, instanceId) {
  const headers = request.headers;
  const allowed = new Set([`localhost:${port}`, `127.0.0.1:${port}`]);
  if (!allowed.has(headers.host)) throw apiError("Unexpected Host", 403, "forbidden");
  if (headers.origin && ![...allowed].some((host) => headers.origin === `http://${host}`))
    throw apiError("Unexpected Origin", 403, "forbidden");
  if (
    headers["sec-fetch-site"] === "cross-site" ||
    (headers["sec-fetch-site"] === "same-site" && !headers.origin)
  )
    throw apiError("Cross-site request rejected", 403, "forbidden");
  if (request.method === "POST") {
    if (!/^application\/json(?:\s*;|$)/i.test(headers["content-type"] ?? ""))
      throw apiError("Content-Type must be application/json", 415, "unsupported media type");
    if (
      (headers.origin || headers["sec-fetch-site"] || headers["x-iportal-instance"]) &&
      headers["x-iportal-instance"] !== instanceId
    )
      throw apiError("Reload the mirror to reconnect", 409, "instance changed");
  }
}

/** @param {Request} req @param {AbortSignal} signal */
export async function readBody(req, signal, limit = 1024 * 1024) {
  const lifetime = AbortSignal.any([signal, req.signal, AbortSignal.timeout(10000)]);
  lifetime.throwIfAborted();
  if (Number(req.headers.get("content-length")) > limit)
    throw apiError("Request body exceeds size limit", 413);
  const reader = req.body?.getReader();
  if (!reader) return {};
  const chunks = [];
  let length = 0;
  const abort = () => {
    void reader.cancel(lifetime.reason).catch(() => {});
  };
  lifetime.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      lifetime.throwIfAborted();
      const { done, value } = await reader.read();
      lifetime.throwIfAborted();
      if (done) break;
      length += value.byteLength;
      if (length > limit) throw apiError("Request body exceeds size limit", 413);
      chunks.push(value);
    }
    try {
      return length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
    } catch {
      throw apiError("Invalid JSON body");
    }
  } finally {
    lifetime.removeEventListener("abort", abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

// The handshake and each idle read are bounded independently. A permanent
// timeout on fetch's signal would also kill healthy long-running video.
/** @param {string} url @param {{connectTimeoutMs?: number, idleTimeoutMs?: number, unix?: string, authentication?: ReturnType<typeof import('./helper-auth.mjs').createHelperAuthentication>}} [options] */
export function openVideoStream(
  url,
  { connectTimeoutMs = 3000, idleTimeoutMs = 5000, unix, authentication } = {},
) {
  return Effect.gen(function* () {
    const controller = new AbortController();
    const upstream = yield* Effect.tryPromise(async (signal) => {
      const timeout = setTimeout(
        () => controller.abort(apiError("Video connection timed out", 504, "timeout")),
        connectTimeoutMs,
      );
      timeout.unref?.();
      try {
        const response = await fetch(url, {
          ...(unix ? { unix } : {}),
          redirect: "error",
          signal: AbortSignal.any([signal, controller.signal]),
          headers: { connection: "close", ...authentication?.headers },
        });
        authentication?.verify(response);
        if (!response.ok || !response.body)
          throw apiError("Video stream unavailable", 502, "video unavailable");
        return { body: response.body, headers: response.headers };
      } catch (error) {
        controller.abort();
        throw error;
      } finally {
        clearTimeout(timeout);
      }
    });
    return {
      contentType: upstream.headers.get("content-type") ?? "multipart/x-mixed-replace",
      stream: Stream.fromReadableStream({ evaluate: () => upstream.body, onError: (e) => e }).pipe(
        Stream.timeout(idleTimeoutMs),
        Stream.ensuring(Effect.sync(() => controller.abort())),
      ),
    };
  });
}

export function startServer({
  port,
  instanceId,
  html,
  mjpeg,
  mjpegSocket,
  helperAuth,
  dispatch,
  statusEvents,
  onListening,
  identity = {},
  fallbackPort = false,
}) {
  let boundPort = port;
  const headers = {
    "cache-control": "no-store",
    "x-iportal-instance": instanceId,
    "x-content-type-options": "nosniff",
    "cross-origin-resource-policy": "same-origin",
    "referrer-policy": "no-referrer",
    "x-frame-options": "DENY",
    "content-security-policy": "frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  };
  const json = (response) =>
    HttpServerResponse.jsonUnsafe(response.body, { status: response.status, headers });
  const handler = (request) =>
    Effect.gen(function* () {
      yield* Effect.try(() => checkRequest(request, boundPort, instanceId));
      const url = new URL(request.url, `http://localhost:${boundPort}`);
      if (request.method === "GET" && url.pathname === interFont.path) {
        return HttpServerResponse.uint8Array(interFont.body, {
          contentType: "font/ttf",
          headers: { ...headers, "cache-control": "public, max-age=31536000, immutable" },
        });
      }
      if (request.method === "GET" && url.pathname === "/") {
        return HttpServerResponse.text(
          html.replace("<head>", `<head><meta name="iportal-instance" content="${instanceId}">`),
          { contentType: "text/html", headers },
        );
      }
      if (request.method === "GET" && url.pathname === "/api/health") {
        // Process liveness must not depend on USB, XCTest, lock state or a session.
        return json({
          status: 200,
          body: { service: "iportal", apiVersion: 2, instanceId, ok: true, ...identity },
        });
      }
      if (request.method === "GET" && url.pathname === "/api/events" && statusEvents) {
        return HttpServerResponse.stream(
          Stream.fromReadableStream({ evaluate: () => statusEvents.stream(), onError: (e) => e }),
          {
            headers: { ...headers, "content-type": "text/event-stream", "x-accel-buffering": "no" },
          },
        );
      }
      if (request.method === "GET" && url.pathname === "/stream") {
        const video = yield* openVideoStream(mjpeg, {
          unix: mjpegSocket,
          authentication: helperAuth,
        });
        return HttpServerResponse.stream(video.stream, {
          // WebKit's multipart response loader rejects fetch().body reads.
          // Our canvas decoder needs the original framed bytes, without the
          // browser interpreting them. Preserve multipart for direct clients.
          headers: {
            ...headers,
            "content-type":
              url.searchParams.get("raw") === "1" ? "application/octet-stream" : video.contentType,
          },
        });
      }
      const name = url.pathname.match(/^\/api\/([\w-]+)$/)?.[1];
      const command = url.pathname.match(/^\/api\/commands\/([a-zA-Z0-9._:-]+)$/)?.[1];
      if (request.method === "GET" && (name === "status" || name === "keep-awake" || command)) {
        return json(
          yield* Effect.tryPromise((signal) =>
            dispatch(
              command ? "command-status" : name,
              command ? { requestId: command } : {},
              signal,
            ),
          ),
        );
      }
      if (request.method !== "POST" || !name || !Object.hasOwn(RequestSchemas, name))
        return json({ status: 404, body: { ok: false, error: "Not found" } });
      const raw = yield* Effect.tryPromise((signal) =>
        readBody(request.source, signal, name === "clipboard-write" ? 6 * 1024 * 1024 : undefined),
      );
      const body = yield* decodeRequest(/** @type {keyof typeof RequestSchemas} */ (name), raw);
      return json(yield* Effect.tryPromise((signal) => dispatch(name, body, signal)));
    }).pipe(
      Effect.catch((e) =>
        Effect.succeed(
          json(errorResponse(e.cause instanceof Error && e._tag === "UnknownError" ? e.cause : e)),
        ),
      ),
    );

  const routes = HttpRouter.add("*", "/*", handler);
  const launch = (listenPort) => {
    const listener = Layer.effect(
      HttpServer.HttpServer,
      Effect.gen(function* () {
        const server = yield* BunHttpServer.make({
          port: listenPort,
          hostname: "127.0.0.1",
          // SSE supplies heartbeats; video has its own shorter stall deadline.
          idleTimeout: 30,
          maxRequestBodySize: 6 * 1024 * 1024,
        });
        if (!("port" in server.address)) throw new Error("Missing HTTP listener address");
        boundPort = server.address.port;
        onListening?.(boundPort);
        return server;
      }),
    ).pipe(Layer.provideMerge(BunHttpServer.layerHttpServices));
    const live = HttpRouter.serve(routes, { disableLogger: true, disableListenLog: true }).pipe(
      Layer.provide(listener),
    );
    return Layer.launch(live).pipe(
      Effect.catchCause((cause) =>
        fallbackPort &&
        listenPort !== 0 &&
        /EADDRINUSE|(?:address|port \d+).*in use/i.test(Cause.pretty(cause))
          ? launch(0)
          : Effect.sync(() => {
              console.error("Could not start mirror server:", Cause.pretty(cause));
              process.exit(1);
            }),
      ),
    );
  };
  return Effect.runFork(launch(port));
}
