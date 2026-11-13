// The Android helper's contract. It shares the envelope and nearly every
// operation with the iPhone helper; what differs is Android's own vocabulary:
// selector strategies, element type names and hardware buttons. Operations that
// have no Android meaning (Siri) are absent rather than emulated.
import { Schema } from "effect";
import {
  HelperStatusSchema,
  contract,
  decodeHelper,
  helperOperations,
  id,
  inputGuards,
  inspectionVocabulary,
  nil,
  type HelperProtocol,
} from "../helper-protocol.ts";
import { createRequestSchemas } from "../schemas.ts";
import { createResponseValidator } from "../responses.ts";
import { apiError } from "../errors.mjs";

export const androidHelperBuild = "android-1";
/**
 * `id` is a resource ID (full, or the part after `:id/`); `accessibility id` is
 * the content description. `xpath` is the subset the helper implements; what it
 * does not support fails with `invalid selector`.
 */
export const androidStrategies = [
  "accessibility id",
  "id",
  "name",
  "text",
  "class name",
  "xpath",
] as const;
export const androidButtons = [
  "home",
  "volumeUp",
  "volumeDown",
  "back",
  "appSwitch",
  "notifications",
  "quickSettings",
  "search",
] as const;

// Android element types are Java class names, for example android.widget.Button.
const className = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/;
export const androidVocabulary = inspectionVocabulary({
  strategies: androidStrategies,
  elementType: className,
  sourceType: className,
});

const unit = Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 }));
/** One or two fingers, each `[x, y]`, normalized in the current orientation. */
const fingers = Schema.Array(Schema.Tuple([unit, unit])).check(
  Schema.isMinLength(1),
  Schema.isMaxLength(2),
);
const strokeId = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(128),
  Schema.isPattern(/^[a-zA-Z0-9._:-]+$/),
);
const phase = Schema.Literals(["down", "move", "up", "cancel"]);
const orientation = Schema.Literals([
  "PORTRAIT",
  "LANDSCAPE",
  "UIA_DEVICE_ORIENTATION_LANDSCAPERIGHT",
  "UIA_DEVICE_ORIENTATION_PORTRAIT_UPSIDEDOWN",
]);
/** `down` and `move` say where the fingers are; only `down` is guarded. */
const wellFormedPointer = (input: { phase: string; points?: unknown }, guarded: boolean) =>
  (input.phase === "cancel" ? input.points === undefined : true) &&
  (input.phase === "down" || input.phase === "move" ? input.points !== undefined : true) &&
  (input.phase === "down" || !guarded);

const { siri: _siri, ...shared } = helperOperations;
export const androidOperations = {
  ...shared,
  elements: contract(
    androidVocabulary.selector,
    Schema.Array(Schema.Struct({ id, attributes: androidVocabulary.attributes })),
  ),
  attribute: contract(
    helperOperations.attribute.request,
    Schema.Union(Object.values(androidVocabulary.AttributeSchemas)),
  ),
  source: contract(
    helperOperations.source.request,
    Schema.Union([Schema.String, androidVocabulary.SourceSchema]),
  ),
  button: contract(
    Schema.Struct({ name: Schema.Literals(androidButtons), ...inputGuards }),
    nil,
    true,
  ),
  // One event of a live touch stroke. The iPhone helper can only play back a
  // whole gesture, so this operation is Android's alone.
  pointer: contract(
    Schema.Struct({
      stroke: strokeId,
      phase,
      points: Schema.optionalKey(fingers),
      ...inputGuards,
    }).check(
      Schema.makeFilter((input) =>
        wellFormedPointer(
          input,
          input.expectedBundleId !== undefined || input.expectedOrientation !== undefined,
        ),
      ),
    ),
    nil,
    true,
  ),
  // Whether the screen is on. A locked phone with its screen on shows the
  // keyguard and takes input; with the screen off it needs waking first.
  power: contract(
    Schema.Struct({}).check(Schema.isMaxProperties(0)),
    Schema.Struct({ interactive: Schema.Boolean }),
  ),
};

export const androidHelperProtocol: HelperProtocol = {
  build: androidHelperBuild,
  status: HelperStatusSchema,
  operations: androidOperations,
  decodeResult(operation, args, value) {
    // Request-dependent results must not accept another operation's shape.
    if (operation === "attribute") {
      const request = decodeHelper(androidOperations.attribute.request, args);
      return decodeHelper(androidVocabulary.AttributeSchemas[request.name], value);
    }
    if (operation === "source") {
      const request = decodeHelper(androidOperations.source.request, args);
      return decodeHelper(
        request.format === "json" ? androidVocabulary.SourceSchema : Schema.String,
        value,
      );
    }
    return decodeHelper(
      androidOperations[operation as keyof typeof androidOperations].result,
      value,
    );
  },
};

// ---- public API ----

const all = createRequestSchemas({ strategies: androidStrategies, buttons: androidButtons });
const { siri: _siriAction, ...actionSchemas } = all.ActionSchemas;
const { siri: _siriRequest, ...requestSchemas } = all.RequestSchemas;
/**
 * `POST /api/pointer`: one event of a live touch stroke. It is not an action:
 * it has no request ID, no receipt and no postcondition, because a stroke is
 * many small events and none of them may ever be sent twice.
 */
export const PointerRequestSchema = Schema.Struct({
  stroke: strokeId,
  phase,
  points: Schema.optionalKey(fingers),
  expectedApp: Schema.optionalKey(
    Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(255)),
  ),
  expectedOrientation: Schema.optionalKey(orientation),
}).check(
  Schema.makeFilter(
    (input) =>
      wellFormedPointer(
        input,
        input.expectedApp !== undefined || input.expectedOrientation !== undefined,
      ) || "down and move need points, cancel takes none, and only down accepts guards",
  ),
);
export type PointerRequest = (typeof PointerRequestSchema)["Type"];
export const AndroidActionSchemas = actionSchemas;
export const AndroidRequestSchemas = { ...requestSchemas, pointer: PointerRequestSchema };
export type AndroidActionName = keyof typeof AndroidActionSchemas;
export type AndroidRequestName = keyof typeof AndroidRequestSchemas;
export type AndroidRequestBody<K extends AndroidRequestName> =
  (typeof AndroidRequestSchemas)[K]["Type"];
export type AndroidActionHandlers = {
  [K in AndroidActionName]: (body: AndroidRequestBody<K>) => Promise<unknown>;
};

export function parseAndroidRequest(name: string, raw: unknown) {
  if (!Object.hasOwn(AndroidRequestSchemas, name)) throw new Error("Unknown API operation");
  const key = name as AndroidRequestName;
  const body = Schema.decodeUnknownSync(
    AndroidRequestSchemas[key] as Schema.ConstraintDecoder<unknown>,
    {
      onExcessProperty: "error",
    },
  )(raw);
  return { name: key, body };
}

export function executeAndroidAction(handlers: AndroidActionHandlers, name: string, raw: unknown) {
  const key = name as AndroidActionName;
  const body = Schema.decodeUnknownSync(
    AndroidActionSchemas[key] as Schema.ConstraintDecoder<unknown>,
    {
      onExcessProperty: "error",
    },
  )(raw);
  return (handlers[key] as (body: unknown) => Promise<unknown>)(body);
}

const validateShared = createResponseValidator({
  vocabulary: androidVocabulary,
  actions: AndroidActionSchemas,
  requests: AndroidRequestSchemas,
});
const PointerResponse = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true) }),
  Schema.Struct({
    ok: Schema.Literal(false),
    error: Schema.String,
    code: Schema.optional(Schema.String),
  }),
]);
export function validateAndroidResponse(name: string, raw: unknown, request: unknown = {}): void {
  if (name !== "pointer") return validateShared(name, raw, request);
  try {
    Schema.decodeUnknownSync(PointerResponse)(raw);
  } catch {
    throw apiError("Invalid API response", 502, "invalid response");
  }
}
