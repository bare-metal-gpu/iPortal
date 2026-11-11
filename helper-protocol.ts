import { Schema } from "effect";
import { validWebURL } from "./web-url.ts";

export const helperProtocolVersion = 1;
export const helperBuild = "native-1";
const optional = Schema.optionalKey;
const text = (max = 10000) => Schema.String.check(Schema.isMaxLength(max));
const number = Schema.Finite;
const integer = (min: number, max: number) =>
  number.check(Schema.isInt(), Schema.isBetween({ minimum: min, maximum: max }));
export const nil = Schema.Null;
const nullable = <S extends Schema.Constraint>(schema: S) => Schema.Union([schema, nil]);
const empty = Schema.Struct({}).check(Schema.isMaxProperties(0));
export const id = text(256).check(Schema.isMinLength(1));
const duration = number.check(Schema.isBetween({ minimum: 0, maximum: 10000 }));
const unit = number.check(Schema.isBetween({ minimum: 0, maximum: 1 }));
const point = Schema.Tuple([unit, unit, duration]);
const touchPath = Schema.Array(point).check(Schema.isMinLength(1), Schema.isMaxLength(256));
const keys = new Set([
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
  "Backspace",
  "Delete",
  "Enter",
  "Tab",
  "Escape",
  "Home",
  "End",
  "PageUp",
  "PageDown",
]);
const nonnegative = number.check(Schema.isGreaterThanOrEqualTo(0));
export const RectSchema = Schema.Struct({
  x: number,
  y: number,
  width: nonnegative,
  height: nonnegative,
});
const rect = RectSchema;
const orientation = Schema.Literals([
  "PORTRAIT",
  "LANDSCAPE",
  "UIA_DEVICE_ORIENTATION_LANDSCAPERIGHT",
  "UIA_DEVICE_ORIENTATION_PORTRAIT_UPSIDEDOWN",
]);
export const inputGuards = {
  expectedBundleId: optional(id),
  expectedOrientation: optional(orientation),
};
const guardedEmpty = Schema.Struct(inputGuards);
const app = Schema.Struct({ pid: integer(1, 2147483647), bundleId: id, name: text() });
const geometry = Schema.Struct({
  width: number.check(Schema.isGreaterThan(0)),
  height: number.check(Schema.isGreaterThan(0)),
});
export interface SourceNode {
  type: string;
  label: string | null;
  value: Schema.Schema.Type<typeof Schema.Json>;
  name: string | null;
  rawIdentifier: string | null;
  frame: string;
  nativeFrame: string;
  rect: Schema.Schema.Type<typeof rect>;
  isEnabled: "0" | "1";
  isVisible: "0" | "1";
  isAccessible: "0" | "1";
  isNativeAccessibilityElement: "0" | "1";
  isFocused: "0" | "1";
  traits: string;
  customActions: Schema.Schema.Type<typeof Schema.Json>;
  children: readonly SourceNode[];
}
const flag = Schema.Literals(["0", "1"]);
/**
 * The part of the contract that names a platform's UI concepts: how elements
 * are selected and what their types are called. Everything else in the helper
 * contract is shared. Each platform keeps its own vocabulary; neither is
 * translated into the other's.
 */
export function inspectionVocabulary<const S extends readonly [string, ...string[]]>({
  strategies,
  elementType,
  sourceType,
}: {
  strategies: S;
  elementType: RegExp;
  sourceType: RegExp;
}) {
  const selector = Schema.Struct({
    using: Schema.Literals(strategies),
    value: text(8192).check(Schema.isMinLength(1)),
  });
  const AttributeSchemas = {
    type: Schema.String.check(Schema.isPattern(elementType)),
    name: nullable(Schema.String),
    label: Schema.String,
    value: Schema.Json,
    enabled: Schema.Boolean,
    visible: Schema.Boolean,
    selected: Schema.Boolean,
    hittable: Schema.Boolean,
    accessible: Schema.Boolean,
    rect,
  };
  const attributes = Schema.Struct({
    ...AttributeSchemas,
    hittable: optional(Schema.Boolean),
    identifier: Schema.String,
    x: number,
    y: number,
    width: nonnegative,
    height: nonnegative,
    index: integer(0, 10000),
  });
  const SourceSchema: Schema.Codec<SourceNode> = Schema.Struct({
    type: Schema.String.check(Schema.isPattern(sourceType)),
    label: nullable(Schema.String),
    value: Schema.Json,
    name: nullable(Schema.String),
    rawIdentifier: nullable(Schema.String),
    frame: Schema.String,
    nativeFrame: Schema.String,
    rect,
    isEnabled: flag,
    isVisible: flag,
    isAccessible: flag,
    isNativeAccessibilityElement: flag,
    isFocused: flag,
    traits: Schema.String,
    customActions: Schema.Json,
    children: Schema.Array(Schema.suspend((): Schema.Codec<SourceNode> => SourceSchema)),
  });
  return { selector, AttributeSchemas, attributes, SourceSchema };
}
const ios = inspectionVocabulary({
  strategies: [
    "accessibility id",
    "id",
    "name",
    "class name",
    "predicate string",
    "class chain",
    "xpath",
  ],
  elementType: /^XCUIElementType[A-Za-z0-9]+$/,
  sourceType: /^[A-Za-z][A-Za-z0-9]*$/,
});
const { selector, attributes } = ios;
export const AttributeSchemas = ios.AttributeSchemas;
export const SourceSchema = ios.SourceSchema;
export const ScreenshotSchema = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(64 * 1024 * 1024),
  Schema.makeFilter((value) => {
    if (value.length % 4 !== 0) return false;
    const bytes = Buffer.from(value, "base64");
    return (
      bytes.toString("base64") === value &&
      (bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")) ||
        (bytes[0] === 0xff && bytes[1] === 0xd8) ||
        (bytes.subarray(4, 8).toString() === "ftyp" &&
          ["heic", "heix", "mif1"].includes(bytes.subarray(8, 12).toString())))
    );
  }),
);
const lease = { lease: id };
const clipboardData = { format: Schema.Literals(["text", "url", "image"]), content: text(5592408) };
export const ClipboardPayloadSchema = Schema.Struct(clipboardData);
const portal = Schema.Struct({
  phase: Schema.Literals(["waiting", "connecting", "reconnecting", "connected", "disconnected"]),
  message: text(128),
  detail: text(256),
  keepAwakeRemainingMs: integer(0, 7200000),
  screenInstalled: Schema.Boolean,
  width: number,
  height: number,
  foreground: Schema.Boolean,
  usbEvents: Schema.Array(Schema.Struct({ attached: Schema.Boolean, uptime: nonnegative })).check(
    Schema.isMaxLength(8),
  ),
  phaseEvents: Schema.Array(
    Schema.Struct({
      phase: Schema.Literals([
        "waiting",
        "connecting",
        "reconnecting",
        "connected",
        "disconnected",
      ]),
      uptime: nonnegative,
    }),
  ).check(Schema.isMaxLength(24)),
});
export const contract = <
  R extends Schema.ConstraintDecoder<unknown>,
  S extends Schema.ConstraintDecoder<unknown>,
>(
  request: R,
  result: S,
  mutates = false,
) => ({ request, result, mutates });
export const helperOperations = {
  touch: contract(
    Schema.Struct({
      points: optional(touchPath),
      fingers: optional(
        Schema.Array(touchPath).check(Schema.isMinLength(2), Schema.isMaxLength(2)),
      ),
      end: duration,
      expectedBundleId: optional(id),
      expectedOrientation: optional(orientation),
    }).check(
      Schema.makeFilter((input) => {
        if (Boolean(input.points) === Boolean(input.fingers)) return false;
        return (input.fingers ?? [input.points]).every(
          (path) =>
            path &&
            path[0][2] === 0 &&
            (path.at(-1)?.[2] ?? Infinity) <= input.end &&
            path.every((p, i) => !i || p[2] >= path[i - 1][2]),
        );
      }),
    ),
    Schema.Struct({
      completed: Schema.Literal(true),
      timing: Schema.Struct({ guardMs: number, confirmationMs: number, playbackMs: number }),
    }),
    true,
  ),
  text: contract(Schema.Struct({ text: text(), ...inputGuards }), nil, true),
  key: contract(
    Schema.Struct({
      ...inputGuards,
      key: text(64).check(Schema.isMinLength(1)),
      modifiers: Schema.Array(Schema.Literals(["control", "shift", "option", "command"])).check(
        Schema.isMaxLength(4),
      ),
    }).check(
      Schema.makeFilter(({ key, modifiers }) => {
        if (new Set(modifiers).size !== modifiers.length) return false;
        if (keys.has(key)) return true;
        return modifiers.length
          ? /^[a-z]$/.test(key)
          : Array.from(key).length === 1 &&
              (key.codePointAt(0) ?? 0) >= 32 &&
              key.codePointAt(0) !== 127;
      }),
    ),
    nil,
    true,
  ),
  home: contract(guardedEmpty, nil, true),
  shutdown: contract(empty, nil, true),
  button: contract(
    Schema.Struct({ name: Schema.Literals(["home", "volumeUp", "volumeDown"]), ...inputGuards }),
    nil,
    true,
  ),
  lock: contract(guardedEmpty, nil, true),
  unlock: contract(guardedEmpty, nil, true),
  launch: contract(Schema.Struct({ bundleId: id, ...inputGuards }), nil, true),
  openURL: contract(
    Schema.Struct({ url: text(8192).check(Schema.makeFilter(validWebURL)), ...inputGuards }),
    nil,
    true,
  ),
  siri: contract(
    Schema.Struct({ text: text().check(Schema.isMinLength(1)), ...inputGuards }),
    nil,
    true,
  ),
  keepAlive: contract(empty, Schema.Struct({ completed: Schema.Literal(true) }), true),
  state: contract(
    empty,
    Schema.Struct({ locked: nullable(Schema.Boolean), app, orientation, screen: geometry }),
  ),
  app: contract(empty, app),
  orientation: contract(empty, orientation),
  geometry: contract(empty, geometry),
  elements: contract(selector, Schema.Array(Schema.Struct({ id, attributes }))),
  attribute: contract(
    Schema.Struct({
      id,
      name: Schema.Literals([
        "type",
        "name",
        "label",
        "value",
        "enabled",
        "visible",
        "selected",
        "hittable",
        "accessible",
        "rect",
      ]),
    }),
    Schema.Union(Object.values(AttributeSchemas)),
  ),
  tapElement: contract(Schema.Struct({ id, ...inputGuards }), nil, true),
  typeElement: contract(Schema.Struct({ id, text: text(), ...inputGuards }), nil, true),
  elementAction: contract(
    Schema.Union([
      Schema.Struct({
        id,
        action: Schema.Literals(["focus", "doubleTap", "longPress", "increment", "decrement"]),
        ...inputGuards,
      }),
      Schema.Struct({ id, action: Schema.Literal("replaceText"), text: text(), ...inputGuards }),
      Schema.Struct({
        id,
        action: Schema.Literal("adjust"),
        value: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
        ...inputGuards,
      }),
    ]),
    nil,
    true,
  ),
  source: contract(
    Schema.Struct({ format: Schema.Literals(["json", "xml", "description"]) }),
    Schema.Union([Schema.String, SourceSchema]),
  ),
  screenshot: contract(Schema.Struct({ id: optional(id) }), ScreenshotSchema),
  clipboardPrepare: contract(
    empty,
    Schema.Struct({ lease: id, helperBundleId: id, restoreBundleId: nullable(id) }),
    true,
  ),
  clipboardStatus: contract(
    empty,
    Schema.Struct({ changeCount: integer(0, Number.MAX_SAFE_INTEGER) }),
  ),
  clipboardRead: contract(
    Schema.Struct(lease),
    Schema.Union([
      Schema.Struct({ pending: Schema.Literal(true) }),
      Schema.Struct({ empty: Schema.Literal(true) }),
      Schema.Struct(clipboardData),
    ]),
    true,
  ),
  clipboardWrite: contract(
    Schema.Struct({ ...lease, ...clipboardData }),
    Schema.Union([
      Schema.Struct({ pending: Schema.Literal(true) }),
      Schema.Struct({ format: clipboardData.format, bytes: integer(1, 4194304) }),
    ]),
    true,
  ),
  clipboardRestore: contract(
    Schema.Struct(lease),
    Schema.Struct({ cancelled: Schema.Literal(true) }),
    true,
  ),
  clipboardCancel: contract(
    Schema.Struct(lease),
    Schema.Struct({ cancelled: Schema.Literal(true) }),
    true,
  ),
  presence: contract(
    Schema.Struct({ ready: Schema.Boolean, keepAwakeMs: integer(0, 7200000) }),
    portal,
  ),
  portal: contract(empty, portal),
  quality: contract(Schema.Struct({ preset: Schema.Literals(["low", "balanced", "high"]) }), nil),
};
export const HelperStatusSchema = Schema.Struct({
  protocol: Schema.Literal(helperProtocolVersion),
  build: id,
  generation: id.check(Schema.isPattern(/^[0-9a-f-]{36}$/i)),
  phase: Schema.Literals([
    "stopped",
    "starting",
    "authenticating",
    "ready",
    "locked",
    "recovering",
    "blocked",
    "stopping",
  ]),
  automationReady: nullable(Schema.Boolean),
  locked: nullable(Schema.Boolean),
  activeOperation: nullable(id),
  displayPixels: optional(
    nullable(Schema.Struct({ width: integer(1, 16384), height: integer(1, 16384) })),
  ),
  capabilities: Schema.Struct({
    touch: Schema.Boolean,
    multiTouch: Schema.Boolean,
    keyboard: Schema.Boolean,
    inspection: Schema.Boolean,
    clipboard: Schema.Boolean,
    video: Schema.Boolean,
  }),
});
export const HelperReplySchema = Schema.Struct({
  id,
  generation: id,
  result: optional(Schema.Json),
  error: optional(
    Schema.Struct({
      code: id,
      message: text(2048),
      outcome: Schema.Literals(["notExecuted", "unknown"]),
    }),
  ),
});
export function decodeHelper<S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  value: unknown,
): S["Type"] {
  return Schema.decodeUnknownSync(schema, { onExcessProperty: "error" })(value);
}

export type HelperOperation = keyof typeof helperOperations;
export type HelperArguments<K extends HelperOperation> =
  (typeof helperOperations)[K]["request"]["Type"];
export type HelperResult<K extends HelperOperation> =
  (typeof helperOperations)[K]["result"]["Type"];
export function decodeHelperResult<K extends HelperOperation>(
  operation: K,
  args: HelperArguments<K>,
  value: unknown,
): HelperResult<K> {
  // Request-dependent results must not accept another operation's shape.
  if (operation === "attribute") {
    const request = decodeHelper(helperOperations.attribute.request, args);
    return decodeHelper(AttributeSchemas[request.name], value) as HelperResult<K>;
  }
  if (operation === "source") {
    const request = decodeHelper(helperOperations.source.request, args);
    return decodeHelper(
      request.format === "json" ? SourceSchema : Schema.String,
      value,
    ) as HelperResult<K>;
  }
  return decodeHelper(helperOperations[operation].result, value);
}

/** What a helper client needs to know about one platform's helper. */
export interface HelperProtocol {
  build: string;
  status: Schema.ConstraintDecoder<unknown>;
  operations: Record<
    string,
    {
      request: Schema.ConstraintDecoder<unknown>;
      result: Schema.ConstraintDecoder<unknown>;
      mutates: boolean;
    }
  >;
  decodeResult(operation: string, args: unknown, value: unknown): unknown;
}
export const iosHelperProtocol: HelperProtocol = {
  build: helperBuild,
  status: HelperStatusSchema,
  operations: helperOperations,
  decodeResult: (operation, args, value) =>
    decodeHelperResult(operation as HelperOperation, args as never, value),
};
