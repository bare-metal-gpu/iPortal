import { randomUUID } from "node:crypto";
import { apiError } from "./errors.mjs";
import { commandContext } from "./scheduler.ts";
import {
  decodeHelper,
  decodeHelperResult,
  type HelperOperation,
  type AttributeSchemas,
  type SourceNode,
  type HelperArguments,
  type HelperResult,
  HelperReplySchema,
  HelperStatusSchema,
  helperBuild,
  helperOperations,
} from "./helper-protocol.ts";

// Boot generation belongs to the helper, not to a USB/Wi-Fi connection. Route
// changes only replace sockets; they must not recreate automation state.
type HelperStatus = import("effect").Schema.Schema.Type<typeof HelperStatusSchema>;
export type HelperCommandOptions = {
  signal?: AbortSignal;
  deadline?: number;
  timeout?: number;
  retried?: boolean;
};
type EmptyOperation = {
  [K in HelperOperation]: {} extends HelperArguments<K> ? K : never;
}[HelperOperation];
export interface HelperCommandCall {
  <A extends keyof typeof AttributeSchemas>(
    operation: "attribute",
    arguments_: { id: string; name: A },
    options?: HelperCommandOptions,
  ): Promise<(typeof AttributeSchemas)[A]["Type"]>;
  (
    operation: "source",
    arguments_: { format: "json" },
    options?: HelperCommandOptions,
  ): Promise<SourceNode>;
  (
    operation: "source",
    arguments_: { format: "xml" | "description" },
    options?: HelperCommandOptions,
  ): Promise<string>;
  <K extends HelperOperation>(
    operation: K,
    arguments_: HelperArguments<K>,
    options?: HelperCommandOptions,
  ): Promise<HelperResult<K>>;
  <K extends EmptyOperation>(operation: K): Promise<HelperResult<K>>;
}
export function createHelperClient({
  url,
  socket,
  authentication,
  expectedBuild = helperBuild,
  onGeneration = (_generation) => {},
}: {
  url: string;
  socket: () => string | null | undefined;
  authentication: ReturnType<typeof import("./helper-auth.mjs").createHelperAuthentication>;
  expectedBuild?: string;
  onGeneration?: (generation: string) => void;
}) {
  /** @type {import("effect").Schema.Schema.Type<typeof HelperStatusSchema> | null} */
  let current: HelperStatus | null = null;
  /** @type {Promise<import("effect").Schema.Schema.Type<typeof HelperStatusSchema>> | null} */
  let handshake: Promise<HelperStatus> | null = null;
  let epoch = 0;
  let resetEvents = () => {};
  const retired = new Set<string>();
  const accept = (next: HelperStatus) => {
    if (next.build !== expectedBuild)
      throw apiError("Helper update required", 503, "incompatible helper");
    if (retired.has(next.generation))
      throw apiError("Obsolete helper response", 502, "stale generation");
    if (current?.generation !== next.generation) {
      if (current) retired.add(current.generation);
      while (retired.size > 16) retired.delete(retired.values().next().value!);
      onGeneration(next.generation);
    }
    current = next;
    return next;
  };
  const request = async (
    path: string,
    body: unknown,
    timeout: number,
    signal?: AbortSignal,
  ): Promise<unknown> => {
    const response = await fetch(url + path, {
      ...(socket() ? { unix: socket() ?? undefined } : {}),
      method: body === undefined ? "GET" : "POST",
      redirect: "error",
      headers: {
        ...authentication.headers,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.any([AbortSignal.timeout(timeout), ...(signal ? [signal] : [])]),
    });
    try {
      authentication.verify(response);
    } catch (error) {
      await response.body?.cancel();
      throw error;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw apiError(`Helper returned ${response.status}`, 502, "helper response");
    }
    if (!response.body) throw apiError("Empty helper response", 502, "invalid response");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 64 * 1024 * 1024) {
        await reader.cancel();
        throw apiError("Helper response is too large", 502, "invalid response");
      }
      chunks.push(value);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      throw apiError("Invalid helper JSON", 502, "invalid response");
    }
  };
  const status = async (signal?: AbortSignal, timeout = 1500) => {
    signal?.throwIfAborted();
    const requestEpoch = epoch;
    let next;
    try {
      next = decodeHelper(
        HelperStatusSchema,
        await request("/v1/status", undefined, timeout, signal),
      );
    } catch (error) {
      if (requestEpoch === epoch) current = null;
      if (error instanceof Error && error.name === "SchemaError")
        throw apiError("Invalid helper status", 502, "invalid response");
      throw error;
    }
    if (requestEpoch !== epoch) throw apiError("Helper route changed", 502, "stale generation");
    return accept(next);
  };
  const ready = async (signal?: AbortSignal) => {
    if (current) return current;
    if (!handshake) {
      const pending = status(signal).finally(() => {
        if (handshake === pending) handshake = null;
      });
      handshake = pending;
    }
    return handshake;
  };
  return {
    status,
    ready,
    get cached() {
      return current;
    },
    reset() {
      epoch++;
      current = null;
      handshake = null;
      authentication.reset();
      resetEvents();
    },
    watch(changed: () => void) {
      let stopped = false;
      let controller: AbortController | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      resetEvents = () => controller?.abort();
      const run = async () => {
        while (!stopped) {
          controller = new AbortController();
          const watchEpoch = epoch;
          const deadline = () => {
            clearTimeout(timer);
            timer = setTimeout(() => controller?.abort(), 5000);
          };
          try {
            deadline();
            const response = await fetch(url + "/v1/events", {
              ...(socket() ? { unix: socket() } : {}),
              headers: authentication.headers,
              redirect: "error",
              signal: controller.signal,
            });
            authentication.verify(response);
            if (!response.ok || !response.body) throw new Error("Helper events unavailable");
            const reader = response.body.getReader(),
              decoder = new TextDecoder();
            let buffer = "";
            try {
              for (;;) {
                const chunk = await reader.read();
                if (chunk.done) break;
                deadline();
                buffer += decoder.decode(chunk.value, { stream: true });
                if (buffer.length > 65536) throw new Error("Helper event exceeds limit");
                let end;
                while ((end = buffer.indexOf("\n\n")) >= 0) {
                  const event = buffer.slice(0, end);
                  buffer = buffer.slice(end + 2);
                  const data = event
                    .split("\n")
                    .find((line) => line.startsWith("data: "))
                    ?.slice(6);
                  if (!data || watchEpoch !== epoch) continue;
                  const next = decodeHelper(HelperStatusSchema, JSON.parse(data));
                  const key = (s: HelperStatus | null) =>
                    JSON.stringify([s?.generation, s?.phase, s?.locked, s?.automationReady]);
                  const before = key(current);
                  accept(next);
                  if (before !== key(next)) changed();
                }
              }
            } finally {
              await reader.cancel().catch(() => {});
            }
          } catch {
            if (!stopped && watchEpoch === epoch) {
              changed();
            }
          } finally {
            clearTimeout(timer);
            controller?.abort();
          }
          if (!stopped) await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      };
      void run();
      return () => {
        stopped = true;
        clearTimeout(timer);
        controller?.abort();
        resetEvents = () => {};
      };
    },
    command: async function command(
      operation: HelperOperation,
      rawArgs?: Record<string, unknown>,
      options: HelperCommandOptions = {},
    ): Promise<unknown> {
      const args = rawArgs ?? {};
      const contract = helperOperations[operation];
      if (!contract) throw apiError("Unsupported helper operation", 400, "invalid argument");
      let arguments_;
      try {
        arguments_ = decodeHelper(
          contract.request,
          Object.fromEntries(Object.entries(args).filter(([, value]) => value !== undefined)),
        );
      } catch {
        throw apiError("Invalid helper command arguments", 400, "invalid argument");
      }
      const context = commandContext.getStore();
      const signal =
        options.signal && context?.signal
          ? AbortSignal.any([options.signal, context.signal])
          : (options.signal ?? context?.signal);
      signal?.throwIfAborted();
      const deadline = Math.min(
        options.deadline ?? Infinity,
        context?.deadline ?? Infinity,
        performance.now() + (options.timeout ?? 8000),
      );
      const state = await ready(signal);
      const budgetMs = Math.min(60000, Math.ceil(deadline - performance.now()));
      if (budgetMs <= 0) throw apiError("Command deadline expired", 408, "timeout");
      if (operation !== "shutdown" && (state.phase === "blocked" || state.phase === "stopping"))
        throw apiError("Helper requires recovery", 503, "helper unavailable");
      const id = randomUUID();
      const commandEpoch = epoch;
      if (contract.mutates) context?.onDispatch?.();
      let reply;
      try {
        reply = decodeHelper(
          HelperReplySchema,
          await request(
            "/v1/commands",
            { id, generation: state.generation, budgetMs, operation, arguments: arguments_ },
            budgetMs + 250,
            signal,
          ),
        );
      } catch (error) {
        const failure =
          error instanceof Error && error.name === "SchemaError"
            ? apiError("Invalid helper reply", 502, "invalid response")
            : error;
        throw contract.mutates
          ? Object.assign(failure instanceof Error ? failure : new Error("Helper request failed"), {
              outcome: "unknown",
            })
          : failure;
      }
      if (
        commandEpoch !== epoch ||
        (current && current.generation !== state.generation) ||
        reply.id !== id ||
        reply.generation !== state.generation ||
        Object.hasOwn(reply, "result") === Object.hasOwn(reply, "error")
      ) {
        throw Object.assign(apiError("Mismatched helper response", 502, "invalid response"), {
          outcome: contract.mutates ? "unknown" : "notExecuted",
        });
      }
      if (reply.error) {
        if (reply.error.code === "stale generation") {
          current = null;
          if (!contract.mutates && !options.retried && reply.error.outcome === "notExecuted")
            return command(operation, args, { ...options, deadline, retried: true });
        }
        const statusCode =
          {
            "invalid argument": 400,
            "invalid selector": 400,
            "no such element": 404,
            "stale element reference": 409,
            "element not actionable": 409,
            "invalid element state": 409,
            "guard failed": 409,
            "device locked": 409,
            "app changed": 409,
            "orientation changed": 409,
            "queue full": 429,
            timeout: 408,
            "unsupported operation": 502,
          }[reply.error.code] ?? 502;
        throw Object.assign(apiError(reply.error.message, statusCode, reply.error.code), {
          outcome: reply.error.outcome,
        });
      }
      try {
        const result = decodeHelperResult(operation, arguments_, reply.result);
        if (contract.mutates) context?.onComplete?.();
        return result;
      } catch {
        throw Object.assign(apiError("Invalid helper result", 502, "invalid response"), {
          outcome: contract.mutates ? "unknown" : "notExecuted",
        });
      }
    } as HelperCommandCall,
  };
}
