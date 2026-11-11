// Android Debug Bridge access. Device tunnels and the device list go straight to
// the adb server's local socket, the way usbmuxd is used for iPhones: no port is
// opened on the Mac and no forward is left behind. The adb executable is used
// only to start that server, push the helper and run shell commands.
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const SERVER_PORT = Number(process.env.ANDROID_ADB_SERVER_PORT) || 5037;

/** @param {NodeJS.ProcessEnv} [env] @param {(file: string) => boolean} [exists] @returns {string | null} */
export function locateAdb(env = process.env, exists = fs.existsSync) {
  const name = process.platform === "win32" ? "adb.exe" : "adb";
  const candidates = [
    env.ADB,
    ...(env.PATH ?? "").split(path.delimiter).map((directory) => path.join(directory, name)),
    ...[env.ANDROID_HOME, env.ANDROID_SDK_ROOT]
      .filter((root) => root !== undefined)
      .map((root) => path.join(root, "platform-tools", name)),
    path.join(os.homedir(), "Library/Android/sdk/platform-tools", name),
    "/opt/homebrew/share/android-commandlinetools/platform-tools/adb",
    "/opt/homebrew/bin/adb",
    "/usr/local/bin/adb",
  ];
  return candidates.find((file) => file && path.isAbsolute(file) && exists(file)) ?? null;
}

/** Hardware serial carried by a transport's own name, when it has one. */
/** @param {string} transport @param {boolean} usb */
export function serialFromTransport(transport, usb) {
  const advertised = transport.match(
    /^adb-([A-Za-z0-9]+)-[A-Za-z0-9]+\._adb-tls-connect\._tcp\.?$/,
  );
  if (advertised) return advertised[1];
  // A USB transport is named by the device's serial. An address is not one.
  return usb && !/^[^:]+:\d+$/.test(transport) ? transport : null;
}

/**
 * @typedef {{id: string, state: string, usb: boolean, model: string | null}} AdbTransport
 * @param {string} listing `host:devices-l` payload
 * @returns {AdbTransport[]}
 */
export function parseDevices(listing) {
  return listing
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .filter((fields) => fields.length >= 2 && fields[0])
    .map(([id, state, ...properties]) => ({
      id,
      state,
      usb: properties.some((property) => property.startsWith("usb:")),
      model:
        properties
          .find((property) => property.startsWith("model:"))
          ?.slice(6)
          .replaceAll("_", " ") ?? null,
    }));
}

/** @param {string} listing `adb mdns services` output */
export function parseMdns(listing) {
  return listing
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .filter((fields) => fields.length === 3 && fields[1] === "_adb-tls-connect._tcp")
    .map(([name, , address]) => ({
      serial: name.match(/^adb-([A-Za-z0-9]+)-/)?.[1] ?? null,
      address,
    }))
    .filter((service) => service.serial && /^[0-9a-fA-F.:[\]]+:\d+$/.test(service.address));
}

/** @param {string} payload */
const frame = (payload) => payload.length.toString(16).padStart(4, "0") + payload;

// Reads exactly `length` bytes without leaving the socket flowing, so the bytes
// after a completed handshake stay buffered for pipe().
/** @param {net.Socket} socket @param {number} length @returns {Promise<Buffer>} */
function take(socket, length) {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const cleanup = () => {
      socket.off("readable", onReadable);
      socket.off("error", onError);
      socket.off("end", onEnd);
    };
    const onReadable = () => {
      let chunk;
      while (buffer.length < length && (chunk = socket.read()) !== null)
        buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length < length) return;
      cleanup();
      if (buffer.length > length) socket.unshift(buffer.subarray(length));
      resolve(buffer.subarray(0, length));
    };
    /** @param {Error} error */
    const onError = (error) => (cleanup(), reject(error));
    const onEnd = () => (cleanup(), reject(new Error("adb closed the connection")));
    socket.on("readable", onReadable);
    socket.on("error", onError);
    socket.on("end", onEnd);
    onReadable();
  });
}

/** @param {net.Socket} socket @param {string} service */
async function request(socket, service) {
  socket.write(frame(service));
  const status = (await take(socket, 4)).toString("latin1");
  if (status === "OKAY") return;
  let message = "adb refused the request";
  if (status === "FAIL") {
    const length = parseInt((await take(socket, 4)).toString("latin1"), 16);
    message = (await take(socket, Math.min(length || 0, 4096))).toString("utf8");
  }
  throw new Error(message);
}

/** @param {net.Socket} socket */
async function payload(socket) {
  const length = parseInt((await take(socket, 4)).toString("latin1"), 16);
  if (!Number.isInteger(length) || length < 0) throw new Error("Invalid adb reply");
  return length ? (await take(socket, length)).toString("utf8") : "";
}

/** @param {{executable?: string | null, port?: number}} [options] */
export function createAdb({ executable = locateAdb(), port = SERVER_PORT } = {}) {
  /** @returns {Promise<net.Socket>} */
  const open = () =>
    new Promise((resolve, reject) => {
      const socket = net.connect({ host: "127.0.0.1", port });
      socket.once("connect", () => {
        socket.off("error", reject);
        resolve(socket);
      });
      socket.once("error", reject);
    });

  /**
   * @param {string[]} args
   * @param {{input?: string, timeoutMs?: number, signal?: AbortSignal}} [options]
   * @returns {Promise<string>}
   */
  const run = (args, { input, timeoutMs = 15000, signal } = {}) =>
    new Promise((resolve, reject) => {
      if (!executable) return reject(new Error("adb is not installed"));
      const child = spawn(executable, args, { stdio: ["pipe", "pipe", "pipe"], signal });
      let output = "";
      const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
      /** @param {Buffer} chunk */
      const collect = (chunk) => {
        if (output.length < 1 << 20) output += chunk.toString("utf8");
      };
      child.stdout.on("data", collect);
      child.stderr.on("data", collect);
      child.stdin.on("error", () => {});
      child.stdin.end(input ?? "");
      child.on("error", (error) => (clearTimeout(timer), reject(error)));
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve(output);
        else reject(new Error(output.trim().slice(-400) || `adb exited with ${code}`));
      });
    });

  return {
    available: Boolean(executable),
    run,
    startServer: () => run(["start-server"], { timeoutMs: 10000 }),
    /** @returns {Promise<AdbTransport[]>} */
    async devices() {
      const socket = await open();
      try {
        await request(socket, "host:devices-l");
        return parseDevices(await payload(socket));
      } finally {
        socket.destroy();
      }
    },
    /**
     * A raw stream to a socket on the device, through one named transport.
     * @param {string} transport @param {string} service for example `localabstract:name`
     */
    async connect(transport, service) {
      const socket = await open();
      try {
        await request(socket, `host:transport:${transport}`);
        await request(socket, service);
        return socket;
      } catch (error) {
        socket.destroy();
        throw error;
      }
    },
    /**
     * Pushes every device-list change until stopped.
     * @param {(devices: AdbTransport[]) => void} onChange @param {() => void} onLost
     */
    track(onChange, onLost) {
      let stopped = false;
      /** @type {net.Socket | undefined} */
      let socket;
      const loop = async () => {
        while (!stopped) {
          try {
            socket = await open();
            await request(socket, "host:track-devices-l");
            while (!stopped) onChange(parseDevices(await payload(socket)));
          } catch {
            socket?.destroy();
            if (stopped) return;
            onLost();
            await run(["start-server"], { timeoutMs: 10000 }).catch(() => {});
            await new Promise((resolve) => setTimeout(resolve, 1000));
          }
        }
      };
      void loop();
      return () => {
        stopped = true;
        socket?.destroy();
      };
    },
  };
}
