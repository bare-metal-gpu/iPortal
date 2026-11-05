import { test } from "bun:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
test("owned test launcher stops on lifetime-pipe closure, including an unresponsive child", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "iportal-owned-"));
  let guard, childPID;
  try {
    const marker = join(scratch, "pid");
    guard = spawn(
      process.execPath,
      [
        "scripts/owned-process.mjs",
        process.execPath,
        "-e",
        `require('fs').writeFileSync(process.argv[1],String(process.pid)); process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)`,
        marker,
      ],
      { stdio: ["pipe", "ignore", "pipe"] },
    );
    for (let i = 0; i < 50; i++) {
      try {
        childPID = Number(await readFile(marker, "utf8"));
        break;
      } catch {
        await wait(20);
      }
    }
    assert.ok(childPID, "child must start");
    process.kill(childPID, 0);
    const exit = once(guard, "exit");
    guard.stdin.end(); // Also happens automatically when the parent process crashes.
    const timeout = setTimeout(() => guard.kill("SIGKILL"), 4000);
    const [code] = await exit;
    clearTimeout(timeout);
    assert.equal(code, 0, "supervisor must finish its own bounded teardown");
    assert.throws(() => process.kill(childPID, 0), { code: "ESRCH" });
  } finally {
    if (guard?.exitCode === null) guard.kill("SIGKILL");
    if (childPID) {
      try {
        process.kill(childPID, "SIGKILL");
      } catch {}
    }
    await rm(scratch, { recursive: true, force: true });
  }
});

test("an abrupt owner crash retires its supervisor and server", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "iportal-owner-crash-"));
  const marker = join(scratch, "server-pid");
  let owner, childPID, guardPID;
  const alive = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  try {
    const command = [
      process.execPath,
      "scripts/owned-process.mjs",
      process.execPath,
      "-e",
      `require('fs').writeFileSync(process.argv[1],String(process.pid)); setInterval(()=>{},1000)`,
      marker,
    ];
    owner = spawn(
      process.execPath,
      [
        "-e",
        `
      const {spawn}=require('node:child_process');
      const command=JSON.parse(process.argv[1]);
      const guard=spawn(command[0],command.slice(1),{stdio:['pipe','ignore','ignore']});
      console.log(guard.pid);
      setInterval(()=>{},1000);
    `,
        JSON.stringify(command),
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    owner.stdout.on("data", (data) => {
      guardPID = Number(data.toString().trim());
    });
    for (let i = 0; i < 100; i++) {
      try {
        childPID = Number(await readFile(marker, "utf8"));
      } catch {}
      if (childPID && guardPID) break;
      await wait(20);
    }
    assert.ok(childPID && guardPID, "supervised server must start");
    const exited = once(owner, "exit");
    owner.kill("SIGKILL");
    await exited;
    for (let i = 0; i < 100 && (alive(guardPID) || alive(childPID)); i++) await wait(30);
    assert.equal(alive(childPID), false, "server must not retain a device lease after owner crash");
    assert.equal(alive(guardPID), false, "supervisor must retire with its child");
  } finally {
    if (owner?.exitCode === null && owner.signalCode === null) owner.kill("SIGKILL");
    for (const pid of [childPID, guardPID]) if (pid && alive(pid)) process.kill(pid, "SIGKILL");
    await rm(scratch, { recursive: true, force: true });
  }
});
