import { apiError } from "./inspection.mjs";

// A bounded lease, not an unlock loop. All device operations share the input queue.
export function createKeepAwake({ wda, withSession, enqueue, intervalMs = 15000,
  now = () => performance.now(), later = setTimeout, cancel = clearTimeout }) {
  let lease = null;
  let fastKeepAlive = true;
  let last = { enabled: false, reason: "not started" };
  const status = () => lease ? {
    enabled: true, method: lease.method, remainingMs: Math.max(0, Math.ceil(lease.deadline - now())),
    pulses: lease.pulses, lastPulseAt: lease.lastPulseAt, backend: lease.backend, lastPulseMs: lease.lastPulseMs,
  } : { ...last };
  function stop(reason = "disabled", error) {
    if (lease) {
      cancel(lease.tick);
      cancel(lease.expiry);
      last = { enabled: false, method: lease.method, pulses: lease.pulses, reason,
        ...(error ? { error } : {}) };
      lease = null;
    }
    return status();
  }
  function current(item) {
    if (lease !== item) return false;
    if (now() >= item.deadline) { stop("expired"); return false; }
    return true;
  }
  async function pulse(item, scheduled = false) {
    return enqueue(async () => {
      if (!current(item)) return;
      // Successful foreground input already provides activity. Drop an obsolete
      // queued maintenance pulse, without extending the lease's absolute expiry.
      if (scheduled && now() - item.lastActivityAt < intervalMs) return;
      const locked = (await wda("GET", "/wda/locked", null, 5000)).value;
      if (typeof locked !== "boolean") throw apiError("Invalid lock state from WDA", 502, "invalid response");
      if (!current(item)) return;
      if (locked) {
        stop("locked");
        throw apiError("Unlock your iPhone before enabling keep-awake", 409, "device locked");
      }
      const pulseStarted = now();
      let fastCompleted = false;
      if (item.method === "hid" && fastKeepAlive) {
        try {
          const response = await wda("POST", "/wda/mirror/keepalive", {}, 5000);
          if (response.value?.completed !== true) throw apiError("Invalid keep-alive acknowledgment", 502, "invalid response");
          item.backend = "hid-event-stream";
          fastCompleted = true;
        } catch (e) {
          if (!["unknown command", "unsupported operation"].includes(e.code)) throw e;
          fastKeepAlive = false;
        }
      }
      if (!fastCompleted) await withSession(async (sid) => {
        if (!current(item)) return;
        const base = `/session/${sid}/wda`;
        if (item.method === "hid") {
          // Consumer page, AC Idle Keep Alive. Acceptance alone does not prove iOS honors it.
          await wda("POST", `${base}/performIoHidEvent`, { page: 0x0c, usage: 0x02b0, duration: 0.01 }, 10000);
          item.backend = "legacy-hid";
        } else {
          await wda("POST", `${base}/pressButton`, { name: "volumeUp" }, 5000);
          // Finish the pair even if the lease expires while the first press is in flight.
          await wda("POST", `${base}/pressButton`, { name: "volumeDown" }, 5000);
          item.backend = "volume";
        }
      }, { deadline: Math.min(item.deadline, now() + 10000) });
      if (current(item)) {
        item.pulses++;
        item.lastPulseAt = new Date().toISOString();
        item.lastPulseMs = Math.round(now() - pulseStarted);
        item.nextPulseAt = now() + intervalMs;
      }
    });
  }
  function schedule(item) {
    if (!current(item)) return;
    cancel(item.tick);
    item.tick = later(async () => {
      try { await pulse(item, true); schedule(item); }
      catch (e) { if (lease === item) stop("upstream error", e.message); }
    }, Math.max(1, item.nextPulseAt - now()));
    item.tick?.unref?.();
  }
  function activity() {
    if (!lease || !current(lease)) return;
    lease.lastActivityAt = now();
    lease.nextPulseAt = now() + intervalMs;
    schedule(lease);
  }
  async function configure(body = {}) {
    const keys = Object.keys(body);
    if (!keys.length) return status();
    if (keys.some(k => !["enabled", "durationMs", "method"].includes(k)) || typeof body.enabled !== "boolean") {
      throw apiError("Provide enabled (boolean), optional durationMs and method, or {} for status");
    }
    if (!body.enabled) return stop();
    const durationMs = body.durationMs ?? 1800000;
    if (!Number.isInteger(durationMs) || durationMs < 1000 || durationMs > 7200000) {
      throw apiError("durationMs must be an integer from 1000 to 7200000");
    }
    const method = body.method ?? "hid";
    if (!["hid", "volume"].includes(method)) throw apiError("method must be hid or volume");
    stop("replaced");
    const item = lease = { method, deadline: now() + durationMs, pulses: 0, lastPulseAt: null };
    item.expiry = later(() => { if (lease === item) stop("expired"); }, durationMs);
    item.expiry?.unref?.();
    try { await pulse(item); schedule(item); }
    catch (e) { if (lease === item) stop("upstream error", e.message); throw e; }
    return status();
  }
  return { configure, status, stop, activity };
}
