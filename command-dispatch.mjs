import { randomUUID } from "node:crypto";
import { apiError, errorInfo } from "./errors.mjs";
import { commandContext } from "./scheduler.ts";
import { errorResponse } from "./server.mjs";

/**
 * The public API's request pipeline: receipts, the serial command queue,
 * preflight guards, postconditions and outcome reporting. It is the same for
 * every device platform; a platform supplies its helper, request parser and
 * action handlers.
 *
 * @param {{
 *   instanceId: string,
 *   transportSignal: () => AbortSignal,
 *   statusEvents: { refresh: () => Promise<unknown> },
 *   commandLedger: () => ReturnType<typeof import("./commands.ts").createCommands>,
 *   parse: typeof import("./schemas.ts").parseNamedRequest,
 *   execute: (name: import("./schemas.ts").ActionName, body: unknown) => Promise<import("./schemas.ts").ActionResult>,
 *   portalStatus: { receive: (body: {clientId: string, ready: boolean}) => void },
 *   keepAwake: ReturnType<typeof import("./keep-awake.mjs").createKeepAwake>,
 *   enqueue: ReturnType<typeof import("./scheduler.ts").createScheduler>["enqueue"],
 *   inspection: ReturnType<typeof import("./inspection.ts").createInspection>,
 *   clipboard: ReturnType<typeof import("./clipboard.ts").createClipboard>,
 *   helper: Pick<ReturnType<typeof import("./helper-client.ts").createHelperClient>, "command" | "status" | "ready">,
 *   lockedMessage: string,
 *   onFailure: (failure: ReturnType<typeof errorInfo>) => void,
 *   contentChanged: () => void,
 * }} options
 */
export function createDispatch({
  instanceId,
  transportSignal,
  statusEvents,
  commandLedger,
  parse,
  execute,
  portalStatus,
  keepAwake,
  enqueue,
  inspection,
  clipboard,
  helper,
  lockedMessage,
  onFailure,
  contentChanged,
}) {
  /** @param {string} rawName @param {unknown} rawBody @param {AbortSignal} [signal] */
  return async function dispatch(rawName, rawBody, signal) {
    // A command submitted before detach must never execute after reattachment.
    signal = signal ? AbortSignal.any([signal, transportSignal()]) : transportSignal();
    const started = performance.now();
    if (rawName === "status") return { status: 200, body: await statusEvents.refresh() };
    if (rawName === "command-status") {
      if (
        !rawBody ||
        typeof rawBody !== "object" ||
        !("requestId" in rawBody) ||
        typeof rawBody.requestId !== "string"
      )
        throw apiError("Missing request ID");
      const value = commandLedger().get(rawBody.requestId);
      return {
        status: value ? 200 : 404,
        body: value
          ? { ok: true, value }
          : { ok: false, code: "not found", error: "Unknown request ID" },
      };
    }
    const { name, body } = parse(rawName, rawBody);
    if (name === "presence") {
      portalStatus.receive(body);
      return { status: 200, body: { ok: true } };
    }
    if (name === "keep-awake")
      return { status: 200, body: { ok: true, value: await keepAwake.configure(body) } };
    if (name === "clipboard-read" || name === "clipboard-write") {
      // Clipboard contents never enter the command receipt cache or disk ledger.
      const value = await commandContext.run(
        { signal, deadline: performance.now() + 25000, operationTimeoutMs: 25000, priority: 5 },
        () =>
          enqueue(async () => {
            inspection.invalidateObservations();
            const value = await clipboard.transfer(
              name === "clipboard-write" ? { operation: "write", ...body } : { operation: "read" },
            );
            keepAwake.activity();
            return value;
          }),
      );
      return { status: 200, body: { ok: true, value, meta: { instanceId } } };
    }
    const timeoutMs =
      ("timeoutMs" in body ? body.timeoutMs : undefined) ?? (name === "wait" ? 10000 : 15000);
    const deadline = performance.now() + timeoutMs;
    if (
      name === "state" ||
      name === "elements" ||
      name === "element" ||
      name === "source" ||
      name === "screenshot" ||
      name === "observe" ||
      name === "wait"
    ) {
      const value = await commandContext.run(
        { signal, deadline, operationTimeoutMs: timeoutMs },
        () => {
          switch (name) {
            case "state":
              return inspection.state(body, signal);
            case "elements":
              return inspection.elements(body, signal);
            case "element":
              return inspection.element(body, signal);
            case "source":
              return inspection.source(body, signal);
            case "screenshot":
              return inspection.screenshot(body, signal);
            case "observe":
              return inspection.observe(body, signal);
            case "wait":
              return inspection.wait(body, signal);
          }
        },
      );
      return {
        status: 200,
        body: { ok: true, value, meta: { instanceId, observedAt: new Date().toISOString() } },
      };
    }
    const requestId = body.requestId ?? randomUUID();
    return commandLedger().execute(requestId, { name, body }, async (mark) => {
      if (name === "lock") keepAwake.stop("lock requested");
      let dispatched = false,
        executed = false;
      let nativeStarted = 0,
        nativeCompleted = 0;
      /** @type {{queueMs?:number,preflightMs?:number,actionMs?:number,totalMs?:number,native?:unknown}} */
      const timing = {};
      let clipboardChanged;
      const onDispatch = () => {
        nativeStarted++;
        if (!dispatched) {
          dispatched = true;
          mark("running");
          inspection.invalidateObservations();
        }
      };
      try {
        await commandContext.run(
          {
            signal,
            deadline,
            onDispatch,
            onComplete: () => {
              nativeCompleted++;
            },
            priority: 5,
            operationTimeoutMs:
              ("timeoutMs" in body ? body.timeoutMs : undefined) ??
              Math.max(8000, (("end" in body ? body.end : undefined) ?? 0) + 2000),
          },
          async () => {
            await enqueue(async () => {
              timing.queueMs = Math.round(performance.now() - started);
              const nativeGuards =
                [
                  "type",
                  "key",
                  "tap",
                  "element-action",
                  "home",
                  "button",
                  "launch",
                  "siri",
                ].includes(name) ||
                (name === "pinch"
                  ? (await helper.ready()).capabilities.multiTouch
                  : ["gesture", "shortcut"].includes(name) &&
                    (await helper.ready()).capabilities.touch);
              if (!nativeGuards && !["unlock", "lock", "ensure", "quality"].includes(name)) {
                if ((await helper.status()).locked)
                  throw apiError(lockedMessage, 409, "device locked");
              }
              if (!nativeGuards && body.expectedApp) {
                const active = await helper.command("app");
                if (active.bundleId !== body.expectedApp)
                  throw apiError("Foreground app changed", 409, "app changed");
              }
              if (
                !nativeGuards &&
                body.expectedOrientation &&
                (await helper.command("orientation")) !== body.expectedOrientation
              )
                throw apiError("Screen orientation changed", 409, "orientation changed");
              if (body.observationId)
                await inspection.verifyObservation(body.observationId, signal);
              signal?.throwIfAborted();
              const actionStarted = performance.now();
              timing.preflightMs = Math.round(actionStarted - started - (timing.queueMs ?? 0));
              const result = await execute(name, body);
              timing.actionMs = Math.round(performance.now() - actionStarted);
              if (result && "timing" in result) timing.native = result.timing;
              if (
                result &&
                "clipboardChanged" in result &&
                typeof result.clipboardChanged === "boolean"
              )
                clipboardChanged = result.clipboardChanged;
              executed = true;
              if (
                [
                  "gesture",
                  "pinch",
                  "shortcut",
                  "tap",
                  "element-action",
                  "type",
                  "key",
                  "home",
                  "button",
                ].includes(name)
              )
                keepAwake.activity();
            });
            if (body.waitFor) await inspection.wait(body.waitFor, signal);
          },
        );
        timing.totalMs = Math.round(performance.now() - started);
        return {
          status: 200,
          body: {
            ok: true,
            requestId,
            outcome: body.waitFor ? "verified" : "executed",
            verified: Boolean(body.waitFor),
            timing,
            ...(clipboardChanged !== undefined ? { clipboardChanged } : {}),
          },
        };
      } catch (e) {
        const failure = errorInfo(e);
        const result = errorResponse(e);
        result.body = {
          ...result.body,
          requestId,
          outcome:
            executed ||
            (nativeCompleted > 0 &&
              (nativeStarted === nativeCompleted || failure.outcome === "notExecuted"))
              ? "executed"
              : failure.outcome === "notExecuted" || !dispatched
                ? "not executed"
                : "unknown",
          verified: false,
        };
        onFailure(failure);
        return result;
      } finally {
        // Include uncertain outcomes: pixels may have changed even when the
        // response was lost. The event never replays the input.
        if (dispatched) contentChanged();
      }
    });
  };
}
