import { apiError } from "./errors.mjs";
// Read-only UI inspection over WDA. Polls share the input queue, not the whole wait.
import { isDeepStrictEqual } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { fingerprint } from "./commands.mjs";

const ELEMENT_KEY = "element-6066-11e4-a52e-4f735466cecf";
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
const DEFAULT_ATTRIBUTES = [
  "type",
  "name",
  "label",
  "value",
  "enabled",
  "visible",
  "hittable",
  "rect",
];
const missing = (e) => e.code === "no such element" || e.code === "stale element reference";

function selector(value) {
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

function attribute(value) {
  if (!ATTRIBUTES.has(value)) throw apiError(`Unsupported attribute: ${value}`);
  return value;
}

function integer(value, fallback, min, max, name) {
  const n = value ?? fallback;
  if (!Number.isInteger(n) || n < min || n > max)
    throw apiError(`${name} must be an integer from ${min} to ${max}`);
  return n;
}

function target(body) {
  if (body.id !== undefined) {
    if (typeof body.id !== "string" || !body.id || body.selector !== undefined)
      throw apiError("Provide either id or selector");
    return { id: body.id };
  }
  return { selector: selector(body.selector) };
}

export function createInspection({ wda, withSession, enqueue }) {
  const observations = new Map();
  // Deadlines include queue time. Check again when a queued operation actually starts.
  const run = (fn, signal, deadline) =>
    enqueue(
      () => {
        signal?.throwIfAborted();
        if (deadline !== undefined && performance.now() >= deadline)
          throw apiError("Wait timed out", 408, "timeout");
        return withSession(
          (sid) => {
            const call = (method, path, body) => {
              signal?.throwIfAborted();
              const remaining =
                deadline === undefined ? 30000 : Math.ceil(deadline - performance.now());
              if (remaining <= 0) throw apiError("Wait timed out", 408, "timeout");
              return wda(method, `/session/${sid}${path}`, body, remaining, signal).then(
                (r) => r.value,
              );
            };
            return fn(call);
          },
          { deadline, signal },
        );
      },
      { signal, deadline },
    );

  const find = async (call, query, rich = false) => {
    const result = await call("POST", "/elements", query);
    if (!Array.isArray(result))
      throw apiError("Invalid element list from WDA", 502, "invalid response");
    return result.map((item) => {
      const id = item[ELEMENT_KEY] ?? item.ELEMENT;
      if (typeof id !== "string")
        throw apiError("Missing element ID from WDA", 502, "invalid response");
      if (!rich) return { id };
      const attributes = {};
      for (const [name, key] of Object.entries({
        type: "type",
        label: "label",
        rect: "rect",
        enabled: "enabled",
        visible: "displayed",
        selected: "selected",
        name: "attribute/name",
        value: "attribute/value",
        accessible: "attribute/accessible",
      })) {
        if (Object.hasOwn(item, key)) attributes[name] = item[key];
      }
      return { id, attributes };
    });
  };
  const resolveDetailed = async (call, t) => {
    if (t.id) return { id: t.id, attributes: {} };
    const elements = await find(call, t.selector, true);
    if (!elements.length) throw apiError("No matching element", 404, "no such element");
    if (elements.length !== 1)
      throw apiError(
        "Selector is ambiguous; use a more specific selector or an element id",
        409,
        "ambiguous element",
      );
    return elements[0];
  };
  const resolve = async (call, t) => (await resolveDetailed(call, t)).id;
  const read = (call, id, name) =>
    call(
      "GET",
      `/element/${encodeURIComponent(id)}/${name === "rect" ? "rect" : `attribute/${name}`}`,
    );

  const api = {
    tap: (body, signal) =>
      run(async (call) => {
        const id = await resolve(call, target(body));
        if (!(await read(call, id, "enabled")) || !(await read(call, id, "hittable")))
          throw apiError("Element is not currently actionable", 409, "element not actionable");
        await call("POST", `/element/${encodeURIComponent(id)}/click`, {});
        return { id };
      }, signal),
    type: (body, signal) =>
      run(async (call) => {
        const id = await resolve(call, target(body));
        if (!(await read(call, id, "enabled")) || !(await read(call, id, "hittable")))
          throw apiError("Element is not currently actionable", 409, "element not actionable");
        await call("POST", `/element/${encodeURIComponent(id)}/value`, { value: [...body.text] });
        return { id };
      }, signal),
    state: (_body, signal) =>
      run(
        async (call) => ({
          locked: await call("GET", "/wda/locked"),
          app: await call("GET", "/wda/activeAppInfo"),
          orientation: await call("GET", "/orientation"),
          screen: await call("GET", "/window/size"),
        }),
        signal,
      ),
    elements: (body, signal) => {
      const query = selector(body.selector);
      return run((call) => find(call, query), signal);
    },
    element: (body, signal) => {
      const t = target(body);
      const names = body.attributes ?? DEFAULT_ATTRIBUTES;
      if (!Array.isArray(names) || !names.length || names.length > ATTRIBUTES.size)
        throw apiError("attributes must be a non-empty supported attribute array");
      names.forEach(attribute);
      return run(async (call) => {
        const { id, attributes = {} } = await resolveDetailed(call, t);
        const result = { id };
        // Lookup fields come from one WDA snapshot. Hittable remains a fresh native check.
        for (const name of new Set(names))
          result[name] = Object.hasOwn(attributes, name)
            ? attributes[name]
            : await read(call, id, name);
        return result;
      }, signal);
    },
    source: (body, signal) => {
      const format = body.format ?? "json";
      if (!["json", "xml", "description"].includes(format))
        throw apiError("format must be json, xml, or description");
      return run((call) => call("GET", `/source?format=${format}`), signal);
    },
    screenshot: (body, signal) => {
      const t = body.id !== undefined || body.selector !== undefined ? target(body) : null;
      return run(async (call) => {
        const path = t
          ? `/element/${encodeURIComponent(await resolve(call, t))}/screenshot`
          : "/screenshot";
        const data = await call("GET", path);
        if (typeof data !== "string")
          throw apiError("Invalid screenshot from WDA", 502, "invalid response");
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
          throw apiError("Unsupported screenshot encoding from WDA", 502, "invalid response");
        return { mimeType, encoding: "base64", data };
      }, signal);
    },
    observe: async (body, signal) => {
      const deadline = performance.now() + (body.timeoutMs ?? 8000);
      const settleMs = body.settleMs ?? 0;
      let lastHash,
        stableSince = performance.now(),
        result;
      do {
        const before = await run(
          async (call) => {
            const startedAt = new Date().toISOString();
            const app = await call("GET", "/wda/activeAppInfo");
            const orientation = await call("GET", "/orientation");
            const source = await call("GET", "/source?format=json");
            return { app, orientation, source, startedAt, sourceAt: new Date().toISOString() };
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
            const source = await call("GET", "/source?format=json");
            const sourceAt = new Date().toISOString();
            const app = await call("GET", "/wda/activeAppInfo");
            const orientation = await call("GET", "/orientation");
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
        if (!result.stable || lastHash !== result.hash) stableSince = performance.now();
        lastHash = result.hash;
        if (result.stable && performance.now() - stableSince >= settleMs) break;
        if (!settleMs) break;
        await sleep(Math.min(100, Math.max(0, deadline - performance.now())), undefined, {
          signal,
        });
      } while (performance.now() < deadline);
      result.stable = result.stable && performance.now() - stableSince >= settleMs;
      if (observations.size >= 32) observations.delete(observations.keys().next().value);
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
    verifyObservation: (id, signal) =>
      run(async (call) => {
        const observation = observations.get(id);
        if (!observation?.stable || performance.now() - observation.at > 15000)
          throw apiError(
            "Observation is missing, unstable or expired; observe again",
            409,
            "stale observation",
          );
        const app = await call("GET", "/wda/activeAppInfo");
        const orientation = await call("GET", "/orientation");
        const source = await call("GET", "/source?format=json");
        if (
          app.bundleId !== observation.app ||
          orientation !== observation.orientation ||
          fingerprint(source) !== observation.hash
        )
          throw apiError("UI changed since the observation", 409, "stale observation");
      }, signal),
    invalidateObservations: () => observations.clear(),
    wait: async (body, signal) => {
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
      let last = null;
      /** @type {number | null} */
      let matchedSince = null;
      /** @type {string | null} */
      let matchHash = null;
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
                if (e.code === "stale element reference") return { matched: false, retry: e.code };
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
                const value = Object.hasOwn(elements[0].attributes, body.attribute)
                  ? elements[0].attributes[body.attribute]
                  : await read(call, id, body.attribute);
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
          const hash = fingerprint(last);
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
        if (!signal?.aborted && (e.code === "timeout" || e.name === "TimeoutError")) {
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
