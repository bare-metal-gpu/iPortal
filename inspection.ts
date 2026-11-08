import type { HelperCommandCall } from "./helper-client.ts";
import type { HelperArguments, HelperResult } from "./helper-protocol.ts";
import type { RequestBody } from "./schemas.ts";
import type { createScheduler } from "./scheduler.ts";
import { apiError, errorInfo } from "./errors.mjs";
// Read-only UI inspection over the native helper. Polls share the input queue, not the whole wait.
import { isDeepStrictEqual } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { fingerprint } from "./commands.ts";

const STRATEGIES = new Set([
  "accessibility id",
  "id",
  "name",
  "class name",
  "predicate string",
  "class chain",
  "xpath",
]);
const ATTRIBUTES = new Set([
  "type",
  "name",
  "label",
  "value",
  "enabled",
  "visible",
  "selected",
  "hittable",
  "accessible",
  "rect",
]);
type Attribute = HelperArguments<"attribute">["name"];
type Attributes = HelperResult<"elements">[number]["attributes"];
type Target = { id?: string; selector?: HelperArguments<"elements"> };
const DEFAULT_ATTRIBUTES: Attribute[] = [
  "type",
  "name",
  "label",
  "value",
  "enabled",
  "visible",
  "hittable",
  "rect",
];
const missing = (e: unknown) =>
  ["no such element", "stale element reference"].includes(errorInfo(e).code ?? "");

function selector(value: HelperArguments<"elements"> | undefined): HelperArguments<"elements"> {
  if (
    !value ||
    typeof value !== "object" ||
    !STRATEGIES.has(value.using) ||
    typeof value.value !== "string" ||
    !value.value.length
  ) {
    throw apiError("selector requires a supported 'using' strategy and a non-empty string 'value'");
  }
  return { using: value.using, value: value.value };
}

function attribute(value: Attribute | undefined) {
  if (!value || !ATTRIBUTES.has(value)) throw apiError(`Unsupported attribute: ${value}`);
  return value;
}

function integer(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
  name: string,
) {
  const n = value ?? fallback;
  if (!Number.isInteger(n) || n < min || n > max)
    throw apiError(`${name} must be an integer from ${min} to ${max}`);
  return n;
}

function target(body: Target): Target {
  if (body.id !== undefined) {
    if (typeof body.id !== "string" || !body.id || body.selector !== undefined)
      throw apiError("Provide either id or selector");
    return { id: body.id };
  }
  return { selector: selector(body.selector) };
}

export function createInspection({
  helper,
  enqueue,
}: {
  helper: { command: HelperCommandCall };
  enqueue: ReturnType<typeof createScheduler>["enqueue"];
}) {
  const observations = new Map<
    string,
    {
      hash: string;
      app: string;
      orientation: HelperResult<"orientation">;
      stable: boolean;
      at: number;
    }
  >();
  const run = <T>(
    fn: (call: HelperCommandCall) => T | Promise<T>,
    signal?: AbortSignal,
    deadline?: number,
  ): Promise<T> =>
    enqueue(
      () => {
        signal?.throwIfAborted();
        if (deadline !== undefined && performance.now() >= deadline)
          throw apiError("Wait timed out", 408, "timeout");
        const call = ((
          operation: Parameters<HelperCommandCall>[0],
          args?: Record<string, unknown>,
        ) =>
          helper.command(operation, args ?? {}, {
            signal,
            deadline,
            timeout: 30000,
          })) as HelperCommandCall;
        return fn(call);
      },
      { signal, deadline },
    );
  const find = async (
    call: HelperCommandCall,
    query: HelperArguments<"elements">,
    rich = false,
  ): Promise<{ id: string; attributes?: Attributes }[]> => {
    const result = await call("elements", query);
    return result.map(({ id, attributes }) => (rich ? { id, attributes } : { id }));
  };
  const resolveDetailed = async (
    call: HelperCommandCall,
    t: Target,
  ): Promise<{ id: string; attributes: Partial<Attributes> }> => {
    if (t.id) return { id: t.id, attributes: {} };
    const elements = await find(call, selector(t.selector), true);
    if (!elements.length) throw apiError("No matching element", 404, "no such element");
    if (elements.length !== 1)
      throw apiError(
        "Selector is ambiguous; use a more specific selector or an element id",
        409,
        "ambiguous element",
      );
    return { id: elements[0].id, attributes: elements[0].attributes ?? {} };
  };
  const resolve = async (call: HelperCommandCall, t: Target) => (await resolveDetailed(call, t)).id;
  const read = (call: HelperCommandCall, id: string, name: Attribute) =>
    call("attribute", { id, name });

  const api = {
    tap: (body: RequestBody<"tap">, signal?: AbortSignal) =>
      run(async (call) => {
        const id = await resolve(call, target(body));
        if (!(await read(call, id, "enabled")) || !(await read(call, id, "hittable")))
          throw apiError("Element is not currently actionable", 409, "element not actionable");
        await call("tapElement", {
          id,
          expectedBundleId: body.expectedApp,
          expectedOrientation: body.expectedOrientation,
        });
        return { id };
      }, signal),
    type: (body: RequestBody<"type">, signal?: AbortSignal) =>
      run(async (call) => {
        const id = await resolve(call, target(body));
        if (!(await read(call, id, "enabled")) || !(await read(call, id, "hittable")))
          throw apiError("Element is not currently actionable", 409, "element not actionable");
        await call("typeElement", {
          id,
          text: body.text,
          expectedBundleId: body.expectedApp,
          expectedOrientation: body.expectedOrientation,
        });
        return { id };
      }, signal),
    state: (_body: RequestBody<"state">, signal?: AbortSignal) =>
      run((call) => call("state"), signal),
    elements: (body: RequestBody<"elements">, signal?: AbortSignal) => {
      const query = selector(body.selector);
      return run((call) => find(call, query), signal);
    },
    element: (body: RequestBody<"element">, signal?: AbortSignal) => {
      const t = target(body);
      const names = body.attributes ?? DEFAULT_ATTRIBUTES;
      if (!names.length || names.length > ATTRIBUTES.size)
        throw apiError("attributes must be a non-empty supported attribute array");
      names.forEach(attribute);
      return run(async (call) => {
        const { id, attributes } = await resolveDetailed(call, t);
        const result: { id: string } & Partial<Record<Attribute, unknown>> = { id };
        // Lookup fields come from one native snapshot. Hittable remains a fresh native check.
        for (const name of new Set(names))
          result[name] = Object.hasOwn(attributes, name)
            ? attributes[name]
            : await read(call, id, name);
        return result;
      }, signal);
    },
    source: (body: RequestBody<"source">, signal?: AbortSignal) => {
      const format = body.format ?? "json";
      if (!["json", "xml", "description"].includes(format))
        throw apiError("format must be json, xml, or description");
      return run((call) => call("source", { format }), signal);
    },
    screenshot: (body: RequestBody<"screenshot">, signal?: AbortSignal) => {
      const t = body.id !== undefined || body.selector !== undefined ? target(body) : null;
      return run(async (call) => {
        const data = await call("screenshot", t ? { id: await resolve(call, t) } : {});
        if (typeof data !== "string")
          throw apiError("Invalid screenshot from helper", 502, "invalid response");
        const bytes = Buffer.from(data, "base64");
        const mimeType = bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))
          ? "image/png"
          : bytes[0] === 0xff && bytes[1] === 0xd8
            ? "image/jpeg"
            : bytes.subarray(4, 8).toString() === "ftyp" &&
                ["heic", "heix", "mif1"].includes(bytes.subarray(8, 12).toString())
              ? "image/heic"
              : null;
        if (!mimeType)
          throw apiError("Unsupported screenshot encoding from helper", 502, "invalid response");
        return { mimeType, encoding: "base64", data };
      }, signal);
    },
    observe: async (body: RequestBody<"observe">, signal?: AbortSignal) => {
      const deadline = performance.now() + (body.timeoutMs ?? 8000);
      const settleMs = body.settleMs ?? 0;
      let lastHash,
        stableSince = performance.now(),
        result;
      do {
        const before = await run(
          async (call) => {
            const startedAt = new Date().toISOString();
            const app = await call("app");
            const orientation = await call("orientation");
            const source = await call("source", { format: "json" });
            return {
              app,
              orientation,
              source,
              startedAt,
              sourceAt: new Date().toISOString(),
              sampledAt: performance.now(),
            };
          },
          signal,
          deadline,
        );
        // Yield queue ownership between samples so pending input can run. Any
        // intervening UI change is handled by the same before/after consistency check.
        const screenshot = body.screenshot === false ? undefined : await api.screenshot({}, signal);
        const screenshotAt = screenshot ? new Date().toISOString() : undefined;
        result = await run(
          async (call) => {
            const source = await call("source", { format: "json" });
            const sourceAt = new Date().toISOString();
            const app = await call("app");
            const orientation = await call("orientation");
            const hash = fingerprint(source);
            return {
              id: randomUUID(),
              startedAt: before.startedAt,
              beforeSourceAt: before.sourceAt,
              sourceAt,
              screenshotAt,
              finishedAt: new Date().toISOString(),
              app,
              orientation,
              source,
              ...(screenshot ? { screenshot } : {}),
              stable:
                before.app.bundleId === app.bundleId &&
                before.orientation === orientation &&
                fingerprint(before.source) === hash,
              hash,
            };
          },
          signal,
          deadline,
        );
        if (!result.stable) stableSince = performance.now();
        else if (lastHash !== result.hash) stableSince = before.sampledAt;
        lastHash = result.hash;
        if (result.stable && performance.now() - stableSince >= settleMs) break;
        if (!settleMs) break;
        await sleep(Math.min(100, Math.max(0, deadline - performance.now())), undefined, {
          signal,
        });
      } while (performance.now() < deadline);
      result.stable = result.stable && performance.now() - stableSince >= settleMs;
      if (observations.size >= 32) {
        const oldest = observations.keys().next().value;
        if (oldest) observations.delete(oldest);
      }
      observations.set(result.id, {
        hash: result.hash,
        app: result.app.bundleId,
        orientation: result.orientation,
        stable: result.stable,
        at: performance.now(),
      });
      const { hash, ...publicResult } = result;
      return publicResult;
    },
    verifyObservation: (id: string, signal?: AbortSignal) =>
      run(async (call) => {
        const observation = observations.get(id);
        if (!observation?.stable || performance.now() - observation.at > 15000)
          throw apiError(
            "Observation is missing, unstable or expired; observe again",
            409,
            "stale observation",
          );
        const app = await call("app");
        const orientation = await call("orientation");
        const source = await call("source", { format: "json" });
        if (
          app.bundleId !== observation.app ||
          orientation !== observation.orientation ||
          fingerprint(source) !== observation.hash
        )
          throw apiError("UI changed since the observation", 409, "stale observation");
      }, signal),
    invalidateObservations: () => observations.clear(),
    wait: async (body: RequestBody<"wait">, signal?: AbortSignal) => {
      const query = selector(body.selector);
      const condition = body.condition ?? "exists";
      if (!["exists", "absent", "attribute"].includes(condition))
        throw apiError("condition must be exists, absent, or attribute");
      if (condition === "attribute") {
        attribute(body.attribute);
        if (!Object.hasOwn(body, "equals")) throw apiError("attribute waits require equals");
      }
      const timeoutMs = integer(body.timeoutMs, 10000, 1, 60000, "timeoutMs");
      const intervalMs = integer(body.intervalMs, 250, 50, 5000, "intervalMs");
      const started = performance.now();
      const deadline = started + timeoutMs;
      /** @type {{matched: boolean, [key: string]: unknown} | null} */
      let last: { matched: boolean; [key: string]: unknown } | null = null;
      /** @type {number | null} */
      let matchedSince: number | null = null;
      /** @type {string | null} */
      let matchHash: string | null = null;
      try {
        while (true) {
          /** @type {{matched: boolean, [key: string]: unknown}} */
          const observation = await run(
            async (call) => {
              let elements;
              try {
                elements = await find(call, query, condition === "attribute");
              } catch (e) {
                // A changing hierarchy can stale during lookup itself. It is not proof of absence.
                if (errorInfo(e).code === "stale element reference")
                  return { matched: false, retry: "stale element reference" };
                throw e;
              }
              if (condition === "exists")
                return { matched: elements.length > 0, count: elements.length, elements };
              if (condition === "absent")
                return { matched: elements.length === 0, count: elements.length };
              if (elements.length > 1)
                throw apiError("Attribute wait selector is ambiguous", 409, "ambiguous element");
              if (!elements.length) return { matched: false, count: 0 };
              const id = elements[0].id;
              try {
                const name = attribute(body.attribute);
                const attrs = elements[0].attributes;
                const value =
                  attrs && Object.hasOwn(attrs, name) ? attrs[name] : await read(call, id, name);
                return {
                  matched: isDeepStrictEqual(value, body.equals),
                  count: 1,
                  id,
                  attribute: body.attribute,
                  value,
                };
              } catch (e) {
                if (missing(e)) return { matched: false, count: 0 }; // Re-resolve after a UI transition.
                throw e;
              }
            },
            signal,
            deadline,
          );
          last = observation;
          if (performance.now() >= deadline) throw apiError("Wait timed out", 408, "timeout");
          // Native handles can rotate while the same selector/condition stays
          // true (especially WebKit accessibility nodes). Compare observations,
          // not the temporary handles returned to the caller.
          const hash = fingerprint({
            matched: last.matched,
            count: last.count,
            attribute: last.attribute,
            value: last.value,
          });
          if (!last.matched || matchHash !== hash)
            matchedSince = last.matched ? performance.now() : null;
          matchHash = hash;
          if (
            last.matched &&
            matchedSince !== null &&
            performance.now() - matchedSince >= (body.stableForMs ?? 0)
          )
            return { ...last, elapsedMs: Math.round(performance.now() - started) };
          await sleep(Math.min(intervalMs, Math.max(0, deadline - performance.now())), undefined, {
            signal,
          });
        }
      } catch (e) {
        // Transport, invalid selector, and authorization errors are never treated as absence.
        if (
          !signal?.aborted &&
          (errorInfo(e).code === "timeout" || errorInfo(e).name === "TimeoutError")
        ) {
          throw Object.assign(apiError("Wait timed out", 408, "timeout"), {
            details: { elapsedMs: Math.round(performance.now() - started), last },
          });
        }
        throw e;
      }
    },
  };
  return api;
}
