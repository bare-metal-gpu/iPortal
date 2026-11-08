import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCommands, fingerprint } from "../commands.ts";

test("receipt capacity bounds the hot cache without preventing input or duplicate recovery", async () => {
  const root = mkdtempSync(join(tmpdir(), "iportal-receipts-"));
  try {
    const ledger = createCommands({ file: join(root, "receipts.sqlite"), capacity: 8 });
    let calls = 0;
    const input = { name: "type", body: { text: "synthetic secret" } };
    const run = async (): Promise<import("../commands.ts").CommandResponse> => {
      calls++;
      return { status: 200, body: { ok: true, outcome: "executed" } };
    };
    for (let n = 0; n < 5000; n++) await ledger.execute(String(n), input, run);
    assert.equal(calls, 5000);
    await ledger.execute("0", input, run);
    assert.equal(calls, 5000);
    ledger.close();
    const restored = createCommands({ file: join(root, "receipts.sqlite"), capacity: 8 });
    await restored.execute("0", input, run);
    assert.equal(calls, 5000);
    restored.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("legacy uncertain receipts migrate without replay or sensitive error persistence", async () => {
  const root = mkdtempSync(join(tmpdir(), "iportal-receipt-migrate-"));
  try {
    const file = join(root, "commands.json"),
      input = { name: "home" };
    writeFileSync(
      file,
      JSON.stringify([
        { id: "old", hash: fingerprint(input), state: "running", updatedAt: Date.now() },
      ]),
    );
    const ledger = createCommands({ file });
    assert.equal(existsSync(file), false);
    const result = await ledger.execute("old", input, async () => {
      throw Error("must not replay");
    });
    assert.equal(result.body.outcome, "unknown");
    ledger.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("receipt files never contain input, response payloads, or sensitive error details", async () => {
  const root = mkdtempSync(join(tmpdir(), "iportal-private-receipts-"));
  try {
    const ledger = createCommands({ file: join(root, "commands.sqlite") });
    const secret = "synthetic-private-content-4288";
    await ledger.execute("private", { text: secret }, async () => ({
      status: 502,
      body: {
        ok: false,
        outcome: "not executed",
        code: "invalid argument",
        error: secret,
        value: { text: secret },
      },
    }));
    assert.equal(ledger.get("private")?.response?.body.error, "invalid argument");
    for (const file of (await import("node:fs")).readdirSync(root)) {
      const bytes = (await import("node:fs")).readFileSync(join(root, file));
      assert.equal(bytes.includes(Buffer.from(secret)), false, file);
    }
    ledger.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
