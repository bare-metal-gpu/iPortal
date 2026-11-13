// One status probe for every viewer, with immediate invalidation on device /
// helper events. Timers cover silent failures and helpers with no ready event.
import { observability } from "./observability.ts";
/** Passed to every read so it can say that its helper probe went unanswered. */
export type StatusProbe = { missed: () => void };
export function createStatusEvents<T extends { lifecycle: string }>({
  read,
  readyMs = 2000,
  retryMs = 500,
  idleMs = 10000,
  graceMs = 1000,
  now = () => performance.now(),
}: {
  read: (signal: AbortSignal, probe: StatusProbe) => Promise<T>;
  readyMs?: number;
  retryMs?: number;
  idleMs?: number;
  /** Unanswered probes closer together than this count as one miss. */
  graceMs?: number;
  now?: () => number;
}) {
  type Snapshot = T & { eventSequence: number };
  const listeners = new Set<(value: Snapshot) => void>();
  const persistentPatch: Partial<T> = {};
  let current: Snapshot | undefined;
  let running: Promise<Snapshot | undefined> | undefined;
  let controller: AbortController | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let version = 0,
    sequence = 0,
    stopped = false;
  // Consecutive reads whose helper probe got no answer. A busy helper or a
  // Wi-Fi hiccup drops a probe now and then; one of them is not a lost session.
  let misses = 0,
    firstMissAt = 0,
    held = false;
  // A read that only missed its probe keeps a verified snapshot standing until
  // a second probe also goes unanswered. Probes refused within the same moment
  // (a reset tunnel fails at once, and helper events can re-probe immediately)
  // are one miss, not two. The read reports "connecting", or the same state
  // without a reachable helper; anything else it found is published.
  const tolerated = (value: T) =>
    (misses === 1 || now() - firstMissAt < graceMs) &&
    (current?.lifecycle === "ready" || current?.lifecycle === "locked") &&
    (value.lifecycle === "connecting" || value.lifecycle === current.lifecycle);
  function publish(value: T) {
    current = { ...value, ...persistentPatch, eventSequence: ++sequence };
    for (const listener of listeners) listener(current);
  }
  function refresh(): Promise<Snapshot | undefined> {
    if (stopped) return Promise.resolve(current);
    if (running) return running;
    clearTimeout(timer);
    running = (async () => {
      while (!stopped) {
        const generation = version;
        controller = new AbortController();
        try {
          const signal = controller.signal;
          let missed = false;
          const probe = {
            missed() {
              missed = true;
            },
          };
          const value = await observability.detached(() =>
            observability.promise("status.refresh", () => read(signal, probe)),
          );
          if (!stopped && generation === version) {
            misses = missed ? misses + 1 : 0;
            if (misses === 1) firstMissAt = now();
            const verified = current?.lifecycle === "ready" || current?.lifecycle === "locked";
            held = missed && tolerated(value);
            // Recorded only when it decides something, not for every retry
            // against a helper already known to be away.
            if (missed && verified)
              observability.event(
                "status-probe-missed",
                { confirmed: !held },
                held ? "Info" : "Warning",
              );
            if (!held) publish(value);
            return current;
          }
        } catch {
          if (generation === version) return current;
        }
      }
      return current;
    })().finally(() => {
      running = undefined;
      if (stopped) return;
      // A tolerated miss is settled by the next probe, so ask again soon: a
      // helper that is really gone is then reported about as fast as before.
      const delay =
        current?.lifecycle === "disconnected"
          ? idleMs
          : current?.lifecycle === "connecting" || held
            ? retryMs
            : readyMs;
      timer = setTimeout(() => {
        void refresh();
      }, delay);
      timer.unref?.();
    });
    return running;
  }
  return {
    refresh,
    // Content events must not start a status probe or wait behind one. Reapply
    // the patch to in-flight probe results so an older read cannot roll it back.
    patch(patch: Partial<T>) {
      Object.assign(persistentPatch, patch);
      if (current && !stopped) publish(current);
    },
    invalidate(patch?: Partial<T>) {
      version++;
      controller?.abort();
      if (patch && current) publish({ ...current, ...patch });
      void refresh();
    },
    stream() {
      let unsubscribe: (() => void) | undefined;
      let pending: Snapshot | undefined;
      const encode = (value: Snapshot) =>
        new TextEncoder().encode(`data: ${JSON.stringify(value)}\n\n`);
      return new ReadableStream<Uint8Array>({
        start(output) {
          const send = (value: Snapshot) => {
            if ((output.desiredSize ?? 0) > 0) output.enqueue(encode(value));
            else pending = value; // Bound slow clients to the latest observation.
          };
          listeners.add(send);
          unsubscribe = () => listeners.delete(send);
          if (current) send(current);
          void refresh();
        },
        pull(output) {
          if (pending) {
            output.enqueue(encode(pending));
            pending = undefined;
          }
        },
        cancel() {
          unsubscribe?.();
        },
      });
    },
    stop() {
      stopped = true;
      clearTimeout(timer);
      controller?.abort();
      listeners.clear();
    },
  };
}
