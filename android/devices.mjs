// Android device inventory. One phone can be reachable through two adb
// transports at once (USB and Wi-Fi). They are grouped by the phone's hardware
// serial, so a cable pull changes the route without changing the device.
import { observability } from "../observability.ts";
import { parseMdns, serialFromTransport } from "./adb.mjs";

/**
 * @typedef {{id: string, udid: string, connection: "USB" | "Network", transport: "usb" | "wifi", model: string | null}} AndroidDevice
 */

/**
 * USB is preferred while present: it is faster and does not depend on the
 * network. The Wi-Fi transport stays connected as the standby route.
 * @param {AndroidDevice[]} devices @param {string | null} pinned
 * @returns {AndroidDevice | null}
 */
export function selectAndroidDevice(devices, pinned) {
  const mine = pinned ? devices.filter((device) => device.udid === pinned) : devices;
  return (
    mine.find((device) => device.transport === "usb") ??
    mine.find((device) => device.transport === "wifi") ??
    null
  );
}

/** A device that is attached but cannot be used yet, and what the owner must do. */
/** @param {import("./adb.mjs").AdbTransport[]} transports */
export function attachmentProblem(transports) {
  if (transports.some((transport) => transport.state === "unauthorized"))
    return "Unlock your Android device and tap Allow to permit USB debugging.";
  if (transports.some((transport) => transport.state === "authorizing"))
    return "Waiting for your Android device…";
  if (transports.some((transport) => transport.state === "offline"))
    return "Reconnect your Android device.";
  return null;
}

/**
 * @param {{
 *   adb: ReturnType<typeof import("./adb.mjs").createAdb>,
 *   onChange: () => void,
 *   pinned: () => string | null,
 *   standbyIntervalMs?: number,
 * }} options
 */
export function createAndroidMonitor({ adb, onChange, pinned, standbyIntervalMs = 5000 }) {
  /** @type {import("./adb.mjs").AdbTransport[]} */
  let transports = [];
  /** @type {AndroidDevice[]} */
  let devices = [];
  /** @type {Map<string, string>} */
  const identities = new Map();
  /** @type {Map<string, number>} */
  const attempts = new Map();
  let revision = 0;
  let healthy = false;

  /** @param {import("./adb.mjs").AdbTransport} transport */
  const identify = async (transport) => {
    const known =
      serialFromTransport(transport.id, transport.usb) ?? identities.get(transport.id) ?? null;
    if (known) return known;
    // A transport named by address says nothing about which phone it is.
    const serial = (
      await adb.run(["-s", transport.id, "shell", "getprop", "ro.serialno"], { timeoutMs: 4000 })
    ).trim();
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(serial)) throw new Error("Unreadable device serial");
    identities.set(transport.id, serial);
    return serial;
  };

  /** @param {import("./adb.mjs").AdbTransport[]} next */
  const update = async (next) => {
    const mine = ++revision;
    healthy = true;
    for (const id of identities.keys())
      if (!next.some((transport) => transport.id === id)) identities.delete(id);
    /** @type {AndroidDevice[]} */
    const resolved = [];
    let unresolved = false;
    for (const transport of next) {
      if (transport.state !== "device") continue;
      try {
        resolved.push({
          id: transport.id,
          udid: await identify(transport),
          connection: transport.usb ? "USB" : "Network",
          transport: transport.usb ? "usb" : "wifi",
          model: transport.model,
        });
      } catch {
        // Not ready to answer yet. adb reports no further change once the
        // transport settles, so ask again shortly.
        unresolved = true;
      }
    }
    if (mine !== revision) return;
    transports = next;
    devices = resolved;
    observability.event("android-devices", {
      usable: resolved.length,
      attached: next.length,
      unresolved,
    });
    if (unresolved) {
      const retry = setTimeout(() => {
        if (mine === revision) void update(next);
      }, 1500);
      retry.unref?.();
    }
    onChange();
  };

  // adb connects to a paired phone over Wi-Fi by itself only in some setups. A
  // phone advertising itself is connected here, so the standby route exists
  // before the cable is pulled.
  const standby = async () => {
    const serial = pinned();
    if (!serial || !healthy || devices.some((d) => d.udid === serial && d.transport === "wifi"))
      return;
    if (!devices.some((d) => d.udid === serial)) return;
    try {
      for (const service of parseMdns(await adb.run(["mdns", "services"], { timeoutMs: 4000 }))) {
        if (service.serial !== serial || Date.now() - (attempts.get(service.address) ?? 0) < 15000)
          continue;
        attempts.set(service.address, Date.now());
        await adb.run(["connect", service.address], { timeoutMs: 6000 }).catch(() => {});
      }
    } catch {
      /* mDNS is optional. USB keeps working without it. */
    }
  };

  const stopTracking = adb.track(
    (next) => void update(next),
    () => {
      observability.event("android-adb-lost", {}, "Warning");
      healthy = false;
      transports = [];
      devices = [];
      revision++;
      onChange();
    },
  );
  const timer = setInterval(() => void standby(), standbyIntervalMs);
  timer.unref?.();
  return {
    devices: () => devices,
    transports: () => transports,
    healthy: () => healthy,
    stop() {
      clearInterval(timer);
      stopTracking();
    },
  };
}
