import { Schema } from "effect";
import { apiError } from "./errors.mjs";
import {
  AttributeSchemas,
  SourceSchema,
  ScreenshotSchema,
  helperOperations,
} from "./helper-protocol.ts";
import { StatusSchema, AwakeSchema, OutcomeSchema } from "./public-contracts.ts";
import { ActionSchemas, RequestSchemas } from "./schemas.ts";
const optional = Schema.optional;
const count = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));
const id = Schema.String.check(Schema.isMinLength(1));
const receiptOutcome = OutcomeSchema;
const ReceiptBody = Schema.Struct({
  ok: Schema.Boolean,
  requestId: optional(id),
  outcome: optional(receiptOutcome),
  verified: optional(Schema.Boolean),
  code: optional(Schema.String),
  error: optional(Schema.String),
  clipboardChanged: optional(Schema.Boolean),
});
const Receipt = Schema.Struct({
  id,
  state: Schema.Literals([
    "queued",
    "running",
    "verified",
    "executed",
    "not executed",
    "unknown",
    "completed",
    "failed",
  ]),
  updatedAt: count,
  response: Schema.NullOr(
    Schema.Struct({
      status: Schema.Finite.check(Schema.isInt(), Schema.isBetween({ minimum: 100, maximum: 599 })),
      body: ReceiptBody,
    }),
  ),
});
const Shot = Schema.Struct({
  mimeType: Schema.Literals(["image/png", "image/jpeg", "image/heic"]),
  encoding: Schema.Literal("base64"),
  data: ScreenshotSchema,
});
/**
 * Validates public responses against one platform's vocabulary. Shapes are
 * shared; element types and the UI tree use the platform's own names.
 */
export function createResponseValidator({
  vocabulary,
  actions,
  requests,
}: {
  vocabulary: {
    AttributeSchemas: Record<string, Schema.ConstraintDecoder<unknown>>;
    SourceSchema: Schema.ConstraintDecoder<unknown>;
  };
  actions: object;
  requests: { source: typeof RequestSchemas.source };
}) {
  const element = Schema.Struct({
    id,
    ...Object.fromEntries(
      Object.entries(vocabulary.AttributeSchemas).map(([key, schema]) => [key, optional(schema)]),
    ),
  });
  const values = {
    state: helperOperations.state.result,
    elements: Schema.Array(Schema.Struct({ id })),
    element,
    screenshot: Shot,
    "keep-awake": AwakeSchema,
    "command-status": Receipt,
    "clipboard-read": Schema.Union([
      Schema.Struct({ empty: Schema.Literal(true) }),
      Schema.Struct({ format: Schema.Literals(["text", "url", "image"]), content: Schema.String }),
    ]),
    "clipboard-write": Schema.Struct({
      format: Schema.Literals(["text", "url", "image"]),
      bytes: count,
    }),
    observe: Schema.Struct({
      id,
      startedAt: id,
      beforeSourceAt: id,
      sourceAt: id,
      screenshotAt: optional(id),
      finishedAt: id,
      app: helperOperations.app.result,
      orientation: helperOperations.orientation.result,
      source: vocabulary.SourceSchema,
      screenshot: optional(Shot),
      stable: Schema.Boolean,
    }),
    wait: Schema.Struct({
      matched: Schema.Literal(true),
      elapsedMs: count,
      count: count,
      id: optional(id),
      attribute: optional(Schema.String),
      value: optional(Schema.Json),
      elements: optional(Schema.Array(Schema.Struct({ id }))),
    }),
  };
  /** Validate at the public boundary without stripping compatible extension fields. */
  return function validatePublicResponse(name: string, raw: unknown, request: unknown = {}): void {
    try {
      if (name === "status") {
        Schema.decodeUnknownSync(StatusSchema)(raw);
        return;
      }
      const envelope = Schema.decodeUnknownSync(
        Schema.Struct({ ok: Schema.Boolean, value: optional(Schema.Unknown) }),
      )(raw);
      if (!envelope.ok) {
        Schema.decodeUnknownSync(
          Schema.Struct({
            ok: Schema.Literal(false),
            error: Schema.String,
            code: optional(Schema.String),
            outcome: optional(receiptOutcome),
          }),
        )(raw);
      } else if (Object.hasOwn(actions, name)) {
        Schema.decodeUnknownSync(
          Schema.Struct({
            ok: Schema.Literal(true),
            requestId: id,
            outcome: receiptOutcome,
            verified: Schema.Boolean,
          }),
        )(raw);
      } else if (name === "source") {
        const input = Schema.decodeUnknownSync(requests.source)(request);
        Schema.decodeUnknownSync(
          (input.format ?? "json") === "json" ? vocabulary.SourceSchema : Schema.String,
          { onExcessProperty: "error" },
        )(envelope.value);
      } else if (Object.hasOwn(values, name)) {
        Schema.decodeUnknownSync(values[name as keyof typeof values])(envelope.value);
      } else if (name !== "presence" && name !== "health")
        throw new Error("Unknown response operation");
    } catch {
      throw apiError("Invalid API response", 502, "invalid response");
    }
  };
}
export const validatePublicResponse = createResponseValidator({
  vocabulary: { AttributeSchemas, SourceSchema },
  actions: ActionSchemas,
  requests: RequestSchemas,
});
