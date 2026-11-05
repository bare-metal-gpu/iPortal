import { Schema } from "effect";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { isIP } from "node:net";
import { canonicalUDID } from "./device-runtime.mjs";
import { nativeTransport } from "./runtime-paths.mjs";

const text = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256));
const capability = Schema.Literals(["eligible", "supported", "unavailable"]);
const Inventory = Schema.Struct({
  version: Schema.Literals([1]),
  devices: Schema.Array(
    Schema.Struct({
      udid: text.check(Schema.isPattern(/^[a-zA-Z0-9-]+$(?![\s\S])/)),
      identifier: text,
      name: text,
      kind: Schema.Literals(["iPhone", "iPad"]),
      transport: Schema.Literals(["usb", "wifi"]),
      osVersion: text.check(Schema.isPattern(/^[0-9]+(\.[0-9]+){0,2}$(?![\s\S])/)),
      capabilities: Schema.Struct({ control: capability, video: capability, audio: capability }),
      address: text.check(
        Schema.makeFilter(
          (s) => (isIP(s) === 6 && /^f[cd]/i.test(s)) || "Expected a paired tunnel address",
        ),
      ),
    }),
  ).check(Schema.isMaxLength(64)),
});
export type PairedDevice = Schema.Schema.Type<typeof Inventory>["devices"][number];
export function decodePairedInventory(line: string): readonly PairedDevice[] {
  if (Buffer.byteLength(line) > 65536) throw new Error("Oversized device inventory");
  const inventory = Schema.decodeUnknownSync(Inventory)(JSON.parse(line));
  const devices = inventory.devices.map((d) => ({ ...d, udid: canonicalUDID(d.udid) }));
  if (devices.some((d) => !d.udid) || new Set(devices.map((d) => d.udid)).size !== devices.length)
    throw new Error("Duplicate paired identity");
  if (
    devices.some(
      (d) =>
        Number(d.osVersion.split(".")[0]) < 27 &&
        Object.values(d.capabilities).some((c) => c !== "unavailable"),
    )
  )
    throw new Error("Unsupported OS capability");
  return devices;
}

// Only the bundled CoreDevice child supplies these addresses. Never accept a
// caller-supplied LAN host as an automatic authenticated-device connection.
export type DiscoveryHealth = "starting" | "ready" | "recovering" | "unavailable";
export function awaitInitialPairedDiscovery(
  health: DiscoveryHealth | undefined,
  elapsedMs: number,
) {
  return health === "starting" && elapsedMs < 1500;
}
export function createPairedMonitor(
  changed: () => void,
  options: {
    launch?: () => ReturnType<typeof spawn>;
    restartMs?: number;
    watchdogMs?: number;
    staleMs?: number;
  } = {},
) {
  let devices: readonly PairedDevice[] = [];
  let child: ReturnType<typeof spawn> | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  let expiry: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let failures = 0;
  let health: DiscoveryHealth = "starting";
  const setHealth = (next: DiscoveryHealth) => {
    if (health !== next) {
      health = next;
      changed();
    }
  };
  function update(next: readonly PairedDevice[]) {
    if (JSON.stringify(next) === JSON.stringify(devices)) return;
    devices = next;
    changed();
  }
  function start() {
    if (stopped) return;
    if (
      !options.launch &&
      (process.platform !== "darwin" ||
        process.env.USBMUXD_SOCKET_ADDRESS ||
        !existsSync(nativeTransport))
    ) {
      setHealth("unavailable");
      return;
    }
    const current =
      options.launch?.() ??
      spawn(nativeTransport, ["--watch"], { stdio: ["pipe", "pipe", "ignore"] });
    child = current;
    let buffered = "";
    const active = () => !stopped && child === current;
    const failed = () => {
      if (!active()) return;
      child = undefined;
      clearTimeout(watchdog);
      current.stdin?.end();
      current.kill();
      failures += 1;
      setHealth(failures >= 3 && !devices.length ? "unavailable" : "recovering");
      // A failed observer is not evidence that its devices disconnected. Keep a
      // bounded cache while restarting; verified live sessions can outlive it.
      expiry ??= setTimeout(() => {
        expiry = undefined;
        if (!stopped) update([]);
      }, options.staleMs ?? 30000);
      expiry.unref();
      retry = setTimeout(
        start,
        options.restartMs ?? Math.min(30000, 1000 * 2 ** Math.min(failures - 1, 5)),
      );
      retry.unref();
    };
    const arm = (ms: number) => {
      clearTimeout(watchdog);
      watchdog = setTimeout(failed, ms);
      watchdog.unref();
    };
    arm(options.watchdogMs ?? 10000);
    current.stdin?.on("error", failed);
    current.stdout?.setEncoding("utf8");
    current.stdout?.on("data", (chunk: string) => {
      if (!active()) return;
      buffered += chunk;
      let newline: number;
      while ((newline = buffered.indexOf("\n")) >= 0) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        try {
          const next = decodePairedInventory(line);
          clearTimeout(expiry);
          expiry = undefined;
          // Publish a healthy snapshot atomically before notifying consumers.
          const notify = health !== "ready" || JSON.stringify(next) !== JSON.stringify(devices);
          health = "ready";
          devices = next;
          failures = 0;
          arm(options.watchdogMs ?? 30000);
          if (notify) changed();
        } catch {
          failed();
          return;
        }
      }
      if (Buffer.byteLength(buffered) > 65536) failed();
    });
    current.once("error", failed);
    current.once("close", failed);
  }
  // Avoid invoking a consumer before it has retained this monitor.
  queueMicrotask(start);
  return {
    devices: () => devices,
    health: () => health,
    stop() {
      stopped = true;
      clearTimeout(retry);
      clearTimeout(watchdog);
      clearTimeout(expiry);
      const previous = child;
      child = undefined;
      previous?.stdin?.end();
      previous?.kill();
      devices = [];
      health = "unavailable";
    },
  };
}

type SelectedDevice = {
  id: number | string;
  udid: string;
  connection?: string;
  address?: string;
  transport: "usb" | "wifi";
};

export function selectDevice(
  usb: { id: number; udid: string; connection?: string }[],
  paired: readonly PairedDevice[],
  wanted: string | null,
  continuity?: { previous: SelectedDevice | null; retainPaired: boolean },
): SelectedDevice | null {
  const udid =
    wanted ??
    paired.find((d) => d.capabilities.control !== "unavailable")?.udid ??
    usb.find((d) => d.connection === "USB")?.udid;
  const previous = continuity?.previous;
  if (previous && previous.udid === udid) {
    // An observer outage alone cannot evict an authenticated, responsive helper.
    if (previous.connection === "Paired" && continuity?.retainPaired) return previous;
  }
  const wireless = paired.find((d) => d.udid === udid && d.capabilities.control !== "unavailable");
  // CoreDevice migrates its paired tunnel between USB and Wi-Fi. A route label
  // is metadata, never a session identity: changing it must not restart the
  // helper, invalidate commands, or discard a healthy video stream.
  if (wireless)
    return {
      id: `paired:${wireless.udid}:${wireless.address}`,
      udid: wireless.udid,
      connection: "Paired",
      address: wireless.address,
      transport: wireless.transport,
    };
  const wired = usb.find((d) => d.connection === "USB" && d.udid === udid);
  return wired ? { ...wired, address: undefined, transport: "usb" as const } : null;
}
