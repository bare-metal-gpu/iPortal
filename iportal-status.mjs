// Presence reports describe a usable viewer; they never acquire a test session,
// synthesize input, or keep the phone awake. The phone expires them independently.
import { errorInfo } from "./errors.mjs";
/** @param {{helper: Pick<ReturnType<typeof import('./helper-client.ts').createHelperClient>, 'command'>, keepAwake: () => import('./keep-awake.mjs').AwakeStatus, now?: () => number,
 * later?: (fn: () => void | Promise<void>, ms: number) => NodeJS.Timeout | number,
 * cancel?: (timer: NodeJS.Timeout | number | undefined) => void, intervalMs?: number, ttlMs?: number}} options */
export function createIPortalStatus({
  helper,
  keepAwake,
  now = () => performance.now(),
  later = setTimeout,
  cancel = clearTimeout,
  intervalMs = 1000,
  ttlMs = 6000,
}) {
  /** @type {Map<string, {ready:boolean,seen:number}>} */
  const clients = new Map();
  /** @type {NodeJS.Timeout | number | undefined} */
  let timer;
  let stopped = false,
    pending = false,
    dirty = false,
    retryAt = 0,
    unsupported = false;
  const aggregateReady = () => [...clients.values()].some((client) => client.ready);
  function prune() {
    for (const [id, client] of clients) if (now() - client.seen >= ttlMs) clients.delete(id);
  }
  async function tick() {
    if (stopped || pending) return;
    timer = undefined;
    prune();
    if (clients.size && now() >= retryAt) {
      pending = true;
      dirty = false;
      try {
        const awake = keepAwake();
        await helper.command(
          "presence",
          {
            ready: aggregateReady(),
            keepAwakeMs: awake.enabled ? Math.min(7200000, Math.max(0, awake.remainingMs ?? 0)) : 0,
          },
          { timeout: 1000 },
        );
        unsupported = false;
      } catch (error) {
        // Back off unavailable operations without claiming a usable viewer.
        unsupported = ["unknown command", "unsupported operation"].includes(
          errorInfo(error).code ?? "",
        );
        retryAt = now() + (unsupported ? 30000 : intervalMs);
      } finally {
        pending = false;
      }
    }
    if (dirty && now() >= retryAt && !stopped) {
      dirty = false;
      return tick();
    }
    if (!stopped) {
      timer = later(tick, intervalMs);
      if (typeof timer === "object") timer.unref();
    }
  }
  /** @param {{clientId:string,ready:boolean}} body */
  function receive({ clientId, ready }) {
    if (stopped) return;
    const before = aggregateReady();
    prune();
    // Keep memory bounded even if a local client creates a new ID per request.
    if (!clients.has(clientId) && clients.size >= 16) clients.delete([...clients.keys()][0]);
    clients.set(clientId, { ready, seen: now() });
    const changed = before !== [...clients.values()].some((client) => client.ready);
    if (changed) {
      // A newly usable viewer is evidence that a transient USB failure ended.
      if (ready && !unsupported) retryAt = 0;
      if (pending) {
        dirty = true;
        return;
      }
      cancel(timer);
      timer = undefined;
    }
    if (!timer && !pending) void tick();
  }
  function stop() {
    stopped = true;
    cancel(timer);
    clients.clear();
  }
  return { receive, stop };
}
