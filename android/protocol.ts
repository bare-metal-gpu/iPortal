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

export const androidHelperBuild = "android-1";
/** `id` is a resource ID (full, or the part after `:id/`); `accessibility id` is the content description. */
export const androidStrategies = ["accessibility id", "id", "name", "text", "class name"] as const;
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
export const AndroidActionSchemas = actionSchemas;
export const AndroidRequestSchemas = requestSchemas;
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

export const validateAndroidResponse = createResponseValidator({
  vocabulary: androidVocabulary,
  actions: AndroidActionSchemas,
  requests: AndroidRequestSchemas,
});
