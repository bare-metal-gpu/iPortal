import { Schema } from "effect";
const optional = Schema.optional;
const integer = Schema.Finite.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0));
const text = Schema.String;
export const OrientationSchema = Schema.Literals([
  "PORTRAIT",
  "LANDSCAPE",
  "UIA_DEVICE_ORIENTATION_LANDSCAPERIGHT",
  "UIA_DEVICE_ORIENTATION_PORTRAIT_UPSIDEDOWN",
]);
export const PixelsSchema = Schema.Struct({
  width: Schema.Finite.check(Schema.isGreaterThan(0)),
  height: Schema.Finite.check(Schema.isGreaterThan(0)),
});
export const LifecycleSchema = Schema.Literals(["ready", "locked", "connecting", "disconnected"]);
export const AwakeSchema = Schema.Struct({
  enabled: Schema.Boolean,
  method: optional(text),
  pulses: optional(integer),
  remainingMs: optional(integer),
  lastPulseAt: optional(Schema.NullOr(text)),
  backend: optional(text),
  lastPulseMs: optional(Schema.Finite),
  reason: optional(text),
  error: optional(text),
});
export const StatusSchema = Schema.Struct({
  service: Schema.Literal("iportal"),
  apiVersion: Schema.Literal(2),
  // Absent means an iPhone or iPad.
  platform: optional(Schema.Literals(["ios", "android"])),
  instanceId: text,
  observedAt: integer,
  eventSequence: optional(integer),
  contentRevision: optional(integer),
  ok: Schema.Boolean,
  device: Schema.NullOr(
    Schema.Struct({
      id: Schema.Union([text, integer]),
      udid: text,
      connection: optional(text),
      address: optional(text),
      transport: Schema.Literals(["usb", "wifi"]),
    }),
  ),
  pinnedUdid: Schema.NullOr(text),
  locked: Schema.NullOr(Schema.Boolean),
  lifecycle: LifecycleSchema,
  orientation: Schema.NullOr(OrientationSchema),
  displayPixels: Schema.NullOr(PixelsSchema),
  captureIdentity: Schema.Struct({ singleUsbDevice: Schema.Boolean }),
  error: Schema.NullOr(text),
  quality: Schema.Literals(["low", "balanced", "high"]),
  queue: Schema.Struct({ active: Schema.Boolean, queued: integer, completed: integer }),
  keepAwake: AwakeSchema,
});
export type PublicStatus = typeof StatusSchema.Type;
export const NativeStatusMessageSchema = Schema.Struct({
  loading: Schema.Boolean,
  waitingForVideo: Schema.Boolean,
  loadingDetail: text,
  lifecycle: LifecycleSchema,
  deviceUdid: text,
  usbConnectionID: text,
  singleUsbDevice: Schema.Boolean,
  usbDevicePresent: Schema.Boolean,
  deviceOrientation: Schema.NullOr(OrientationSchema),
  displayPixels: Schema.NullOr(PixelsSchema),
  serverInstance: text,
  videoEpoch: integer,
  statusRevision: integer,
  bridgeId: text,
  videoMode: Schema.Literals(["native", "stream"]),
});
export const NativeFrameMessageSchema = Schema.Struct({
  accessibilityChanged: optional(Schema.Boolean),
  w: Schema.Finite.check(Schema.isGreaterThan(0)),
  h: Schema.Finite.check(Schema.isGreaterThan(0)),
  videoEpoch: integer,
  bridgeId: text,
});
export const NativeMessageSchema = Schema.Union([
  NativeStatusMessageSchema,
  NativeFrameMessageSchema,
]);
export type NativeMessage = typeof NativeMessageSchema.Type;
export interface NativeScroll {
  phase: "none" | "began" | "changed" | "ended" | "cancelled" | "momentum";
  x: number;
  y: number;
  dx: number;
  dy: number;
  zoom?: boolean;
}
export interface NativePinch {
  phase: string;
  x: number;
  y: number;
  scale?: number;
  delta?: number;
}
export interface ActionResponse {
  ok: boolean;
  code?: string;
  outcome?: string;
  clipboardChanged?: boolean;
  value?: { response?: { body?: { ok?: boolean } } };
}

export const OutcomeSchema = Schema.Literals(["verified", "executed", "not executed", "unknown"]);
export type CommandOutcome = typeof OutcomeSchema.Type;
