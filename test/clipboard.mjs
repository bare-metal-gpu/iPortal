import assert from "node:assert/strict";
import test from "node:test";
import { Effect } from "effect";
import { createClipboard, validateClipboard } from "../clipboard.mjs";
import { decodeRequest } from "../schemas.mjs";
import { checkRequest } from "../server.mjs";
const encode = (text) => Buffer.from(text).toString("base64");

void test("clipboard validates Unicode, URLs, base64 and bounded payloads", async () => {
  const payload = { format: "text", content: encode("iPortal 👋 café\n日本語") };
  assert.deepEqual(validateClipboard(payload), payload);
  assert.deepEqual(await Effect.runPromise(decodeRequest("clipboard-write", payload)), payload);
  for (const body of [
    { format: "file", content: encode("x") },
    { format: "text", content: "%%%" },
    { format: "text", content: "" },
    { format: "text", content: encode("x"), arbitrary: true },
  ])
    await assert.rejects(Effect.runPromise(decodeRequest("clipboard-write", body)));
  for (const body of [
    { format: "url", content: encode("not a URL") },
    { format: "text", content: Buffer.from([0xff]).toString("base64") },
    { format: "text", content: encode("x".repeat(1024 * 1024 + 1)) },
    { format: "image", content: encode("x".repeat(4 * 1024 * 1024 + 1)) },
  ])
    assert.throws(() => validateClipboard(body));
  assert.equal(
    validateClipboard({ format: "url", content: encode("https://example.com/🍎") }).format,
    "url",
  );
});

void test("clipboard does not replay failed operations or return invalid/empty data as content", async () => {
  let calls = 0;
  /** @type {Record<string, any>} */
  let value = { empty: true };
  let fail = false;
  const bridge = createClipboard({
    withSession: (fn) => fn(),
    wda: async (_method, route) => {
      calls++;
      if (fail) throw new Error("Disconnected");
      return route.endsWith("/prepare") ? { value: { lease: "test" } } : { value };
    },
  });
  assert.deepEqual(await bridge.transfer({ operation: "read" }), { empty: true });
  value = { format: "text", content: "!" };
  await assert.rejects(bridge.transfer({ operation: "read" }));
  fail = true;
  calls = 0;
  await assert.rejects(
    bridge.transfer({ operation: "write", format: "text", content: encode("marker") }),
  );
  assert.equal(calls, 1);
  calls = 0;
  await assert.rejects(
    bridge.transfer({ operation: "write", format: "url", content: encode("invalid") }),
  );
  assert.equal(calls, 0, "invalid payload never reaches phone");
});

void test("native clipboard callers cannot use a stale server instance", () => {
  const headers = {
    host: "127.0.0.1:7100",
    "content-type": "application/json",
    "x-iportal-instance": "old",
  };
  assert.throws(() => checkRequest({ method: "POST", headers }, 7100, "new"));
  headers["x-iportal-instance"] = "new";
  checkRequest({ method: "POST", headers }, 7100, "new");
});

void test("keyboard schema validates keys and modifier combinations", async () => {
  assert.equal(
    (
      await Effect.runPromise(
        decodeRequest("key", { key: "ArrowLeft", modifiers: ["option", "shift"] }),
      )
    ).key,
    "ArrowLeft",
  );
  for (const body of [
    { key: "Dead" },
    { key: "hello" },
    { key: "\n" },
    { key: "a", modifiers: ["command", "command"] },
    { key: "a", modifiers: ["hyper"] },
  ])
    await assert.rejects(Effect.runPromise(decodeRequest("key", body)));
});
