import { Schema } from "effect";

const optional = Schema.optionalKey;
const text = (max = 1024) => Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(max));
const integer = (min, max) => Schema.Finite.check(Schema.isInt(), Schema.isBetween({ minimum: min, maximum: max }));
const enumOf = (...values) => Schema.Literals(values);
const filter = (test, message) => Schema.makeFilter(value => test(value) || message);
export const Selector = Schema.Struct({
  using: enumOf("accessibility id", "id", "name", "class name", "predicate string", "class chain", "xpath"),
  value: text(8192),
});
export const Attribute = enumOf("type", "name", "label", "value", "enabled", "visible", "selected", "hittable", "accessible", "rect");
const target = { id: optional(text(256)), selector: optional(Selector) };
const hasTarget = filter(b => (b.id !== undefined) !== (b.selector !== undefined), "Provide exactly one of id or selector");
export const Wait = Schema.Struct({
  selector: Selector, condition: optional(enumOf("exists", "absent", "attribute")),
  attribute: optional(Attribute), equals: optional(Schema.Unknown),
  timeoutMs: optional(integer(1, 60000)), intervalMs: optional(integer(50, 5000)),
  stableForMs: optional(integer(0, 10000)),
}).check(filter(b => b.condition !== "attribute" || (b.attribute !== undefined && Object.hasOwn(b, "equals")), "Attribute waits require attribute and equals"));
const metadata = {
  requestId: optional(text(128).check(Schema.isPattern(/^[a-zA-Z0-9._:-]+$/))),
  expectedApp: optional(text(255)), observationId: optional(text(128)),
  expectedOrientation: optional(enumOf("PORTRAIT", "UIA_DEVICE_ORIENTATION_PORTRAIT_UPSIDEDOWN", "LANDSCAPE", "UIA_DEVICE_ORIENTATION_LANDSCAPERIGHT")),
  timeoutMs: optional(integer(1, 60000)), waitFor: optional(Wait),
};
const duration = Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 10000 }));
const coordinate = Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 }));
const point = Schema.Tuple([Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
  Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 })), duration]);
const action = fields => Schema.Struct({ ...fields, ...metadata });
export const ActionSchemas = {
  pinch: action({ x: coordinate, y: coordinate,
    scale: Schema.Finite.check(Schema.isBetween({ minimum: 0.25, maximum: 4 })),
    durationMs: optional(integer(80, 1000)) }),
  gesture: action({ points: Schema.Array(point).check(Schema.isMinLength(1), Schema.isMaxLength(256)), end: duration })
    .check(filter(b => b.points[0][2] === 0 && b.end >= b.points.at(-1)[2] && b.points.every((p, i) => !i || p[2] >= b.points[i - 1][2]), "Gesture times must start at zero, increase monotonically, and end after the final point")),
  shortcut: action({ name: enumOf("switcher", "control", "notifications", "spotlight") }),
  type: action({ text: Schema.String.check(Schema.isMaxLength(10000)), ...target })
    .check(filter(b => !(b.id !== undefined && b.selector !== undefined), "Provide id or selector, not both")),
  tap: action(target).check(hasTarget),
  home: action({}), lock: action({}), unlock: action({}), ensure: action({}),
  button: action({ name: enumOf("home", "volumeUp", "volumeDown") }),
  launch: action({ bundleId: text(255) }), siri: action({ text: text(4096) }),
  quality: action({ level: enumOf("low", "balanced", "high") }),
};
export const RequestSchemas = {
  ...ActionSchemas,
  state: Schema.Struct({}),
  elements: Schema.Struct({ selector: Selector }),
  element: Schema.Struct({ ...target, attributes: optional(Schema.Array(Attribute).check(Schema.isMinLength(1), Schema.isMaxLength(11))) }).check(hasTarget),
  source: Schema.Struct({ format: optional(enumOf("json", "xml", "description")) }),
  screenshot: Schema.Struct(target).check(filter(b => !(b.id !== undefined && b.selector !== undefined), "Provide id or selector, not both")),
  observe: Schema.Struct({ screenshot: optional(Schema.Boolean), settleMs: optional(integer(0, 2000)), timeoutMs: optional(integer(1, 10000)) }),
  wait: Wait,
  "keep-awake": Schema.Struct({ enabled: optional(Schema.Boolean), durationMs: optional(integer(1000, 7200000)), method: optional(enumOf("hid", "volume")) })
    .check(filter(b => !Object.keys(b).length || b.enabled !== undefined, "Provide enabled, or {} for status")),
};
export const decodeRequest = (name, body) => Schema.decodeUnknownEffect(RequestSchemas[name], { onExcessProperty: "error" })(body);
