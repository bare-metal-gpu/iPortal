import { test, expect } from "bun:test";
import { Schema } from "effect";
import corpus from "./fixtures/helper-contract.json" with { type: "json" };
import bridge from "./fixtures/native-bridge.json" with { type: "json" };
import { decodeHelperResult, helperOperations, type HelperOperation } from "../helper-protocol.ts";
import { NativeMessageSchema } from "../public-contracts.ts";
import { validatePublicResponse } from "../responses.ts";
import urls from "./fixtures/web-urls.json" with { type: "json" };
import { ActionSchemas } from "../schemas.ts";

test("element actions validate discriminated payloads before native dispatch", () => {
  for (const schema of [ActionSchemas["element-action"], helperOperations.elementAction.request]) {
    const decode = Schema.decodeUnknownSync(schema, { onExcessProperty: "error" });
    expect(() => decode({ id: "a", action: "replaceText", text: "" })).not.toThrow();
    expect(() => decode({ id: "a", action: "adjust", value: 0.7 })).not.toThrow();
    for (const args of [
      { action: "replaceText" },
      { action: "focus", text: "unexpected" },
      { action: "adjust", value: 1.1 },
      { action: "adjust", value: "0.5" },
      { action: "adjust", value: NaN },
      { action: "increment", value: 0.5 },
      { action: "executeArbitraryAction" },
    ])
      expect(() => decode({ id: "a", ...args })).toThrow();
  }
});

test("web navigation rejects repaired URLs and non-web schemes on both boundaries", () => {
  for (const schema of [ActionSchemas["open-url"], helperOperations.openURL.request]) {
    const decode = Schema.decodeUnknownSync(schema, { onExcessProperty: "error" });
    for (const url of urls.valid) expect(() => decode({ url })).not.toThrow();
    for (const url of urls.invalid) expect(() => decode({ url })).toThrow();
    expect(() => decode({ url: "https://example.com/", target: "another-device" })).toThrow();
  }
  expect(helperOperations.openURL.mutates).toBe(true);
});

test("every native operation has a typed successful reply in the shared wire corpus", () => {
  expect(new Set(corpus.results.map((r) => r.operation)).size).toBe(
    Object.keys(helperOperations).length,
  );
  for (const value of corpus.results) {
    const operation = value.operation as HelperOperation;
    const args = Schema.decodeUnknownSync(helperOperations[operation].request)(value.arguments);
    expect(() => decodeHelperResult(operation, args, value.result)).not.toThrow();
  }
});
test("dependent replies reject truthy strings, wrong geometry, wrong sources and invalid images", () => {
  for (const [op, args, result] of [
    ["attribute", { id: "a", name: "enabled" }, "false"],
    ["attribute", { id: "a", name: "rect" }, { x: 0, y: 0, width: "1", height: 1 }],
    ["source", { format: "json" }, "<Application/>"],
    ["source", { format: "xml" }, {}],
    ["screenshot", {}, "not an image"],
  ] as const)
    expect(() => decodeHelperResult(op, args, result)).toThrow();
});
for (const fixture of bridge)
  test(`shared native bridge: ${fixture.name}`, () => {
    const decode = () => Schema.decodeUnknownSync(NativeMessageSchema)(fixture.value);
    if (fixture.valid) expect(decode).not.toThrow();
    else expect(decode).toThrow();
  });
test("public responses reject malformed inspection fields and receipt outcomes", () => {
  expect(() =>
    validatePublicResponse("element", { ok: true, value: { id: "a", enabled: "false" } }),
  ).toThrow();
  expect(() =>
    validatePublicResponse("type", { ok: true, requestId: "a", verified: false, outcome: "maybe" }),
  ).toThrow();
  expect(() =>
    validatePublicResponse("type", { ok: false, error: "Changed", outcome: "not executed" }),
  ).not.toThrow();
});
