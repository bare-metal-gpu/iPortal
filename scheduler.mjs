import { AsyncLocalStorage } from "node:async_hooks";
import { apiError } from "./errors.mjs";

export const commandContext = new AsyncLocalStorage();
export function createScheduler({ maxQueued = 64, defaultTimeoutMs = 8000 } = {}) {
  let active = false;
  const pending = [];
  let completed = 0;
  let sequence = 0;
  function drain() {
    if (active) return;
    pending.sort((a, b) => b.priority - a.priority || a.order - b.order);
    const item = pending.shift();
    if (!item) return;
    if (item.cancelled) return drain();
    active = true;
    item.started = true;
    void Promise.resolve()
      .then(() => {
        item.signal.throwIfAborted();
        if (performance.now() >= item.deadline)
          throw apiError("Command deadline expired", 408, "timeout");
        return commandContext.run(
          { ...item.context, signal: item.signal, deadline: item.deadline, insideQueue: true },
          item.fn,
        );
      })
      .then(item.resolve, item.reject)
      .finally(() => {
        clearTimeout(item.timer);
        item.cleanup();
        completed++;
        active = false;
        drain();
      });
  }
  function enqueue(fn, options = {}) {
    const parent = commandContext.getStore();
    const context = {
      ...parent,
      ...Object.fromEntries(Object.entries(options).filter(([, v]) => v !== undefined)),
    };
    if (parent?.insideQueue) {
      parent.signal?.throwIfAborted();
      return Promise.resolve().then(fn);
    }
    if (pending.length >= maxQueued)
      return Promise.reject(apiError("Command queue is full", 429, "queue full"));
    const deadline = Math.min(
      context.deadline ?? Infinity,
      performance.now() + (context.operationTimeoutMs ?? defaultTimeoutMs),
    );
    const controller = new AbortController();
    const signal = context.signal
      ? AbortSignal.any([context.signal, controller.signal])
      : controller.signal;
    return new Promise((resolve, reject) => {
      const item = {
        fn,
        context,
        signal,
        deadline,
        priority: context.priority ?? 0,
        order: sequence++,
        resolve,
        reject,
        cancelled: false,
        started: false,
      };
      const abort = () => {
        if (!item.started) {
          item.cancelled = true;
          clearTimeout(item.timer);
          item.cleanup();
          const index = pending.indexOf(item);
          if (index >= 0) pending.splice(index, 1);
          reject(signal.reason);
          drain();
        }
        // In-flight work keeps ownership until its upstream call actually settles.
      };
      item.cleanup = () => signal.removeEventListener("abort", abort);
      item.timer = setTimeout(
        () => controller.abort(apiError("Command deadline expired", 408, "timeout")),
        Math.max(0, deadline - performance.now()),
      );
      item.timer.unref();
      signal.addEventListener("abort", abort, { once: true });
      pending.push(item);
      if (signal.aborted) abort();
      else drain();
    });
  }
  // Timers created during an input inherit its AsyncLocalStorage context. A lease
  // outlives that request: maintenance must get a new deadline and cancellation scope.
  const maintenance = (fn) => commandContext.run({}, () => enqueue(fn, { priority: 10 }));
  return { enqueue, maintenance, stats: () => ({ active, queued: pending.length, completed }) };
}
