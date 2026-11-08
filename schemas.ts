import { validKeyboardKey } from "./keyboard.mjs";
import { Schema } from "effect";
import { validWebURL } from "./web-url.ts";

const optional = Schema.optionalKey;
const text = (max = 1024) => Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(max));
const integer = (min: number, max: number) =>
  Schema.Finite.check(Schema.isInt(), Schema.isBetween({ minimum: min, maximum: max }));
const enumOf = <const T extends readonly string[]>(...values: T) => Schema.Literals(values);
const filter = <T>(test: (value: T) => boolean, message: string) =>
  Schema.makeFilter<T>((value) => test(value) || message);
const Selector = Schema.Struct({
  using: enumOf(
    "accessibility id",
    "id",
    "name",
    "class name",
    "predicate string",
    "class chain",
    "xpath",
  ),
  value: text(8192),
});
const Attribute = enumOf(
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
);
const target = { id: optional(text(256)), selector: optional(Selector) };
const hasTarget = filter(
  (b: { id?: string; selector?: Schema.Schema.Type<typeof Selector> }) =>
    (b.id !== undefined) !== (b.selector !== undefined),
  "Provide exactly one of id or selector",
);
const Wait = Schema.Struct({
  selector: Selector,
  condition: optional(enumOf("exists", "absent", "attribute")),
  attribute: optional(Attribute),
  equals: optional(Schema.Unknown),
  timeoutMs: optional(integer(1, 60000)),
  intervalMs: optional(integer(50, 5000)),
  stableForMs: optional(integer(0, 10000)),
}).check(
  filter(
    (b) => b.condition !== "attribute" || (b.attribute !== undefined && Object.hasOwn(b, "equals")),
    "Attribute waits require attribute and equals",
  ),
);
const metadata = {
  requestId: optional(text(128).check(Schema.isPattern(/^[a-zA-Z0-9._:-]+$/))),
  expectedApp: optional(text(255)),
  observationId: optional(text(128)),
  expectedOrientation: optional(
    enumOf(
      "PORTRAIT",
      "UIA_DEVICE_ORIENTATION_PORTRAIT_UPSIDEDOWN",
      "LANDSCAPE",
      "UIA_DEVICE_ORIENTATION_LANDSCAPERIGHT",
    ),
  ),
  timeoutMs: optional(integer(1, 60000)),
  waitFor: optional(Wait),
};
const duration = Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 10000 }));
const coordinate = Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 }));
const point = Schema.Tuple([
  Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
  Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
  duration,
]);
/** @template {Schema.Struct.Fields} F @param {F} fields */
const action = <F extends Schema.Struct.Fields>(fields: F) =>
  Schema.Struct({ ...fields, ...metadata });
export const ActionSchemas = {
  key: action({
    key: text(64).check(
      filter(validKeyboardKey, "Provide a supported key name or a single character"),
    ),
    modifiers: optional(
      Schema.Array(enumOf("command", "control", "option", "shift")).check(
        Schema.isMaxLength(4),
        filter((items) => new Set(items).size === items.length, "Modifiers must be unique"),
      ),
    ),
  }).check(
    filter(
      (b) => !b.modifiers?.length || Array.from(b.key).length > 1 || /^[a-z]$/.test(b.key),
      "Modified printable keys must be lowercase Latin letters",
    ),
  ),
  pinch: action({
    x: coordinate,
    y: coordinate,
    scale: Schema.Finite.check(Schema.isBetween({ minimum: 0.25, maximum: 4 })),
    durationMs: optional(integer(80, 1000)),
  }),
  gesture: action({
    points: Schema.Array(point).check(Schema.isMinLength(1), Schema.isMaxLength(256)),
    end: duration,
  }).check(
    filter(
      (b) =>
        b.points[0][2] === 0 &&
        b.end >= (b.points.at(-1)?.[2] ?? Infinity) &&
        b.points.every((p, i) => !i || p[2] >= b.points[i - 1][2]),
      "Gesture times must start at zero, increase monotonically, and end after the final point",
    ),
  ),
  shortcut: action({ name: enumOf("switcher", "control", "notifications", "spotlight") }),
  type: action({ text: Schema.String.check(Schema.isMaxLength(10000)), ...target }).check(
    filter(
      (b) => !(b.id !== undefined && b.selector !== undefined),
      "Provide id or selector, not both",
    ),
  ),
  tap: action(target).check(hasTarget),
  home: action({}),
  lock: action({}),
  unlock: action({}),
  ensure: action({}),
  button: action({ name: enumOf("home", "volumeUp", "volumeDown") }),
  launch: action({ bundleId: text(255) }),
  "open-url": action({
    url: text(8192).check(
      filter(validWebURL, "Provide an absolute HTTP or HTTPS URL without credentials"),
    ),
  }),
  siri: action({ text: text(4096) }),
  quality: action({ level: enumOf("low", "balanced", "high") }),
};
export const RequestSchemas = {
  ...ActionSchemas,
  "clipboard-read": Schema.Struct({}),
  "clipboard-write": Schema.Struct({
    format: enumOf("text", "url", "image"),
    content: text(5592408).check(
      Schema.isPattern(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
    ),
  }),
  presence: Schema.Struct({ clientId: text(128), ready: Schema.Boolean }),
  state: Schema.Struct({}),
  elements: Schema.Struct({ selector: Selector }),
  element: Schema.Struct({
    ...target,
    attributes: optional(
      Schema.Array(Attribute).check(Schema.isMinLength(1), Schema.isMaxLength(11)),
    ),
  }).check(hasTarget),
  source: Schema.Struct({ format: optional(enumOf("json", "xml", "description")) }),
  screenshot: Schema.Struct(target).check(
    filter(
      (b) => !(b.id !== undefined && b.selector !== undefined),
      "Provide id or selector, not both",
    ),
  ),
  observe: Schema.Struct({
    screenshot: optional(Schema.Boolean),
    settleMs: optional(integer(0, 2000)),
    timeoutMs: optional(integer(1, 60000)),
  }),
  wait: Wait,
  "keep-awake": Schema.Struct({
    enabled: optional(Schema.Boolean),
    durationMs: optional(integer(1000, 7200000)),
    method: optional(enumOf("hid", "volume")),
  }).check(
    filter(
      (b) => !Object.keys(b).length || b.enabled !== undefined,
      "Provide enabled, or {} for status",
    ),
  ),
};
/** @template {keyof typeof RequestSchemas} K @param {K} name @param {unknown} body */
export const decodeRequest = <K extends keyof typeof RequestSchemas>(name: K, body: unknown) =>
  Schema.decodeUnknownEffect(RequestSchemas[name], { onExcessProperty: "error" })(body);

export type RequestName = keyof typeof RequestSchemas;
export type ActionName = keyof typeof ActionSchemas;
export type RequestBody<K extends RequestName> = (typeof RequestSchemas)[K]["Type"];
export type ActionResult =
  | void
  | null
  | {
      timing?: { guardMs: number; confirmationMs: number; playbackMs: number };
      clipboardChanged?: boolean;
    }
  | { id: string };
export type ActionHandlers = { [K in ActionName]: (body: RequestBody<K>) => Promise<ActionResult> };
export type NamedRequest = { [K in RequestName]: { name: K; body: RequestBody<K> } }[RequestName];
export function parseNamedRequest(name: string, raw: unknown): NamedRequest {
  if (!Object.hasOwn(RequestSchemas, name)) throw new Error("Unknown API operation");
  const key = name as RequestName;
  const body = Schema.decodeUnknownSync(RequestSchemas[key], { onExcessProperty: "error" })(raw);
  return { name: key, body } as NamedRequest; // The chosen schema establishes this correlation.
}
export function executeAction<K extends ActionName>(
  handlers: ActionHandlers,
  name: K,
  raw: unknown,
) {
  const body = Schema.decodeUnknownSync(ActionSchemas[name], { onExcessProperty: "error" })(
    raw,
  ) as RequestBody<K>;
  return handlers[name](body);
}
