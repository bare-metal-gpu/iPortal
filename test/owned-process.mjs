import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const wait = ms => new Promise(r => setTimeout(r, ms));
test('owned test launcher stops on lifetime-pipe closure, including an unresponsive child', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'portal-owned-'));
  let guard, childPID;
  try {
    const marker = join(scratch, 'pid');
    guard = spawn(process.execPath, ['scripts/owned-process.mjs', process.execPath, '-e',
      `require('fs').writeFileSync(process.argv[1],String(process.pid)); process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)`, marker],
      { stdio: ['pipe', 'ignore', 'pipe'] });
    for (let i = 0; i < 50; i++) { try { childPID = Number(await readFile(marker, 'utf8')); break; } catch { await wait(20); } }
    assert.ok(childPID, 'child must start');
    process.kill(childPID, 0);
    const exit = once(guard, 'exit');
    guard.stdin.end(); // Also happens automatically when the parent process crashes.
    const timeout = setTimeout(() => guard.kill('SIGKILL'), 4000);
    const [code] = await exit; clearTimeout(timeout);
    assert.equal(code, 0, 'supervisor must finish its own bounded teardown');
    assert.throws(() => process.kill(childPID, 0), { code: 'ESRCH' });
  } finally {
    if (guard?.exitCode === null) guard.kill('SIGKILL');
    if (childPID) { try { process.kill(childPID, 'SIGKILL'); } catch {} }
    await rm(scratch, { recursive: true, force: true });
  }
});
