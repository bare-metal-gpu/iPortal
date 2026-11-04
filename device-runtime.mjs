import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

// Do not follow a pre-created symlink in the shared temporary directory, or
// reuse another user's directory. Tighten permissions on older installations.
export function ensurePrivateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const fd = fs.openSync(
    directory,
    fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW,
  );
  try {
    if (process.getuid && fs.fstatSync(fd).uid !== process.getuid())
      throw new Error("Runtime directory belongs to another user");
    fs.fchmodSync(fd, 0o700);
  } finally {
    fs.closeSync(fd);
  }
}

export function canonicalUDID(value) {
  if (!/^[a-zA-Z0-9-]{8,64}$/.test(value)) throw new Error("Invalid device identity");
  const compact = value.replaceAll("-", "");
  if (/^[a-fA-F0-9]{40}$/.test(compact)) return compact.toLowerCase();
  return /^[a-fA-F0-9]{24}$/.test(compact)
    ? `${compact.slice(0, 8)}-${compact.slice(8)}`.toUpperCase()
    : value;
}

// The OS owns this lease while the server lives. A crashed process leaves a
// socket pathname, but no listener; only that confirmed stale inode is removed.
export async function claimDevice(
  udid,
  directory = path.join(
    process.platform === "darwin" ? "/tmp" : os.tmpdir(),
    `iportal-${process.getuid?.() ?? "user"}`,
  ),
) {
  ensurePrivateDirectory(directory);
  const key = canonicalUDID(udid).replaceAll("-", "").toLowerCase();
  const file = path.join(
    directory,
    `${createHash("sha256").update(key).digest("hex").slice(0, 24)}.sock`,
  );
  const server = net.createServer((socket) => socket.end());
  /** @returns {Promise<void>} */
  const listen = () =>
    new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(file, () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
  try {
    await listen();
  } catch (error) {
    if (error.code !== "EADDRINUSE") throw error;
    const before = fs.lstatSync(file);
    if (!before.isSocket()) throw new Error("Device lease is not a socket");
    const stale = await new Promise((resolve) => {
      const probe = net.connect(file);
      probe.setTimeout(500, () => {
        probe.destroy();
        resolve(false);
      });
      probe.once("connect", () => {
        probe.destroy();
        resolve(false);
      });
      probe.once("error", (e) => resolve("code" in e && e.code === "ECONNREFUSED"));
    });
    if (!stale || fs.lstatSync(file).ino !== before.ino)
      throw new Error("This device already has a mirror session");
    fs.unlinkSync(file);
    await listen();
  }
  const inode = fs.statSync(file).ino;
  return () => {
    // close() also unlinks the Unix socket; the inode guard protects successors.
    try {
      if (fs.statSync(file).ino === inode) {
        server.close();
        fs.rmSync(file, { force: true });
      }
    } catch {
      server.close();
    }
  };
}
