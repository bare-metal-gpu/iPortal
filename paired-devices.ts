import { Schema } from "effect";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { isIP } from "node:net";
import { canonicalUDID } from "./device-runtime.mjs";
import { nativeTransport } from "./runtime-paths.mjs";

const text = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256));
const Inventory = Schema.Struct({
  devices: Schema.Array(
    Schema.Struct({
      udid: text.check(Schema.isPattern(/^[a-zA-Z0-9-]+$/)),
      identifier: text,
      name: text,
      kind: Schema.Literals(["iPhone", "iPad"]),
      transport: Schema.Literals(["usb", "wifi"]),
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
  if (line.length > 65536) throw new Error("Oversized device inventory");
  const inventory = Schema.decodeUnknownSync(Inventory)(JSON.parse(line));
  const devices = inventory.devices.map((d) => ({ ...d, udid: canonicalUDID(d.udid) }));
  if (new Set(devices.map((d) => d.udid)).size !== devices.length)
    throw new Error("Duplicate paired identity");
  return devices;
}

// Only the bundled CoreDevice child supplies these addresses. Never accept a
// caller-supplied LAN host as an automatic authenticated-device connection.
export function createPairedMonitor(changed: () => void) {
  let devices: readonly PairedDevice[] = [];
  let child: ReturnType<typeof spawn> | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  function update(next: readonly PairedDevice[]) {
    if (JSON.stringify(next) === JSON.stringify(devices)) return;
    devices = next;
    changed();
  }
  function start() {
    if (
      stopped ||
      process.platform !== "darwin" ||
      process.env.USBMUXD_SOCKET_ADDRESS ||
      !existsSync(nativeTransport)
    )
      return;
    const current = spawn(nativeTransport, ["--watch"], { stdio: ["pipe", "pipe", "ignore"] });
    child = current;
    current.stdin?.on("error", () => {});
    let buffered = "";
    current.stdout?.setEncoding("utf8");
    current.stdout?.on("data", (chunk: string) => {
      buffered += chunk;
      if (buffered.length > 65536) {
        current.kill();
        return;
      }
      let newline: number;
      while ((newline = buffered.indexOf("\n")) >= 0) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        try {
          update(decodePairedInventory(line));
        } catch {
          current.kill();
        }
      }
    });
    current.on("error", () => {});
    current.once("close", () => {
      if (child !== current) return;
      child = undefined;
      update([]);
      if (!stopped) {
        retry = setTimeout(start, 5000);
        retry.unref();
      }
    });
  }
  start();
  return {
    devices: () => devices,
    stop() {
      stopped = true;
      clearTimeout(retry);
      child?.stdin?.end();
      child?.kill();
      child = undefined;
      devices = [];
    },
  };
}

export function selectDevice(
  usb: { id: number; udid: string; connection?: string }[],
  paired: readonly PairedDevice[],
  wanted: string | null,
) {
  const udid = wanted ?? paired[0]?.udid ?? usb.find((d) => d.connection === "USB")?.udid;
  const wireless = paired.find((d) => d.udid === udid);
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
