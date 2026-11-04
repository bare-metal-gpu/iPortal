import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";

const root = path.resolve(import.meta.dirname, "..");
const scratch = await mkdtemp(path.join(tmpdir(), "iportal-package-"));
try {
  const binary = path.join(scratch, "Moved App", "iportal-server");
  let child = Bun.spawn([process.execPath, "scripts/build-server.ts", binary], {
    cwd: root,
    stdout: "inherit",
    stderr: "inherit",
  });
  assert.equal(await child.exited, 0);
  const info = Bun.spawn([binary, "--runtime-info"], { stdout: "pipe" });
  assert.deepEqual(await new Response(info.stdout).json(), {
    runtime: "bun",
    version: Bun.version,
  });
  assert.equal(await info.exited, 0);
  for (const suite of ["e2e", "multi-device", "guarded-touch"]) {
    child = Bun.spawn([process.execPath, `test/${suite}.mjs`], {
      cwd: root,
      env: { ...process.env, IPORTAL_TEST_BINARY: binary },
      stdout: "inherit",
      stderr: "inherit",
    });
    assert.equal(await child.exited, 0, `packaged ${suite}`);
  }
  // Same supervisor entry point as the live phone launcher, without a runtime
  // or JavaScript file on disk. Parent EOF must terminate the child.
  const guard = Bun.spawn([binary, "--owned-command", "/bin/sleep", "60"], {
    cwd: scratch,
    env: { PATH: "/usr/bin:/bin" },
    stdin: "pipe",
    stderr: "pipe",
  });
  await guard.stdin.end();
  const timeout = setTimeout(() => guard.kill("SIGKILL"), 4000);
  try {
    assert.equal(await guard.exited, 0, "packaged supervisor follows its owner");
  } finally {
    clearTimeout(timeout);
  }
  console.log(
    "Packaged server: relocated assets, USB, streams, device isolation and supervisor passed without Node/Bun on PATH.",
  );
} finally {
  await rm(scratch, { recursive: true, force: true });
}
