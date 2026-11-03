// One status probe for every viewer, with immediate invalidation on device /
// helper events. Timers cover silent failures and helpers with no ready event.
export function createStatusEvents({ read, readyMs = 2000, retryMs = 500, idleMs = 10000 }) {
  const listeners = new Set();
  let current,
    running,
    controller,
    timer,
    version = 0,
    sequence = 0,
    stopped = false;
  function publish(value) {
    current = { ...value, eventSequence: ++sequence };
    for (const listener of listeners) listener(current);
  }
  function refresh() {
    if (stopped) return Promise.resolve(current);
    if (running) return running;
    clearTimeout(timer);
    running = (async () => {
      while (!stopped) {
        const generation = version;
        controller = new AbortController();
        try {
          const value = await read(controller.signal);
          if (!stopped && generation === version) {
            publish(value);
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
      const delay =
        current?.lifecycle === "disconnected"
          ? idleMs
          : current?.lifecycle === "connecting"
            ? retryMs
            : readyMs;
      timer = setTimeout(refresh, delay);
      timer.unref?.();
    });
    return running;
  }
  return {
    refresh,
    invalidate(patch) {
      version++;
      controller?.abort();
      if (patch && current) publish({ ...current, ...patch });
      void refresh();
    },
    stream() {
      let unsubscribe, pending;
      const encode = (value) => new TextEncoder().encode(`data: ${JSON.stringify(value)}\n\n`);
      return new ReadableStream({
        start(output) {
          const send = (value) => {
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
