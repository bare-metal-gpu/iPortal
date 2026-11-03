// Presence reports describe a usable viewer; they never acquire a test session,
// synthesize input, or keep the phone awake. The phone expires them independently.
export function createPortalStatus({ wda, keepAwake, now = () => performance.now(),
  later = setTimeout, cancel = clearTimeout, intervalMs = 1000, ttlMs = 6000 }) {
  const clients = new Map();
  let timer, stopped = false, pending = false, dirty = false, retryAt = 0, unsupported = false;
  const aggregateReady = () => [...clients.values()].some(client => client.ready);
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
        await wda('POST', '/wda/mirror/portal', {
          ready: aggregateReady(),
          keepAwakeMs: awake.enabled ? Math.min(7200000, Math.max(0, awake.remainingMs ?? 0)) : 0,
        }, 1000);
        unsupported = false;
      } catch (error) {
        // Old helpers continue working. Retry later after a helper upgrade.
        unsupported = ['unknown command', 'unsupported operation'].includes(error.code);
        retryAt = now() + (unsupported ? 30000 : intervalMs);
      } finally { pending = false; }
    }
    if (dirty && now() >= retryAt && !stopped) { dirty = false; return tick(); }
    if (!stopped) { timer = later(tick, intervalMs); timer?.unref?.(); }
  }
  function receive({ clientId, ready }) {
    if (stopped) return;
    const before = aggregateReady();
    prune();
    // Keep memory bounded even if a local client creates a new ID per request.
    if (!clients.has(clientId) && clients.size >= 16) clients.delete(clients.keys().next().value);
    clients.set(clientId, { ready, seen: now() });
    const changed = before !== [...clients.values()].some(client => client.ready);
    if (changed) {
      // A newly usable viewer is evidence that a transient USB failure ended.
      if (ready && !unsupported) retryAt = 0;
      if (pending) { dirty = true; return; }
      cancel(timer); timer = undefined;
    }
    if (!timer && !pending) void tick();
  }
  function stop() { stopped = true; cancel(timer); clients.clear(); }
  return { receive, stop };
}
