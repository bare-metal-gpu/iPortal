// Opt-in integration checks against our installed fixture, on a simulator or a
// physical device. Never run against the user's foreground application.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { ActionSchemas } from "../schemas.ts";

const url = process.env.IPORTAL_API_URL ?? "http://127.0.0.1:7100";
const bundleId = process.argv[2];
assert(bundleId?.endsWith(".iportal.mobile.fixture"), "Pass the installed fixture bundle ID");
// Hosted Simulator snapshots can take several seconds, even after a mutation
// has finished. Functional assertions need time for two stable observations;
// the explicit short-deadline check below still exercises a 200 ms timeout.
const observationTimeoutMs = process.env.IPORTAL_SIMULATOR === "1" ? 30000 : 5000;
async function api(name: string, body: object = {}, expected: number | readonly number[] = 200) {
  const args = {
    ...(name === "wait" ? { timeoutMs: observationTimeoutMs } : {}),
    ...(process.env.IPORTAL_SIMULATOR === "1" && Object.hasOwn(ActionSchemas, name)
      ? { timeoutMs: 30000 }
      : {}),
    ...(["tap", "type", "key", "gesture", "element-action"].includes(name)
      ? { expectedApp: bundleId }
      : {}),
    ...body,
  };
  const response = await fetch(`${url}/api/${name}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(args),
    signal: AbortSignal.timeout(45000),
  });
  // These integration assertions deliberately inspect the raw public response.
  const result = (await response.json()) as Record<string, any>;
  assert(
    (typeof expected === "number" ? [expected] : expected).includes(response.status),
    `${name}: ${JSON.stringify(result)}`,
  );
  return result;
}
// Launch acknowledges activation before the first stable accessibility tree.
// Retry only observations, never the launch or an uncertain input mutation.
async function waitForApp() {
  const deadline = performance.now() + 8000;
  for (;;) {
    const result = await api("state", {}, [200, 502]);
    if (result.ok && result.value.app.bundleId === bundleId) return result.value;
    assert(result.ok || result.code === "unknown error", JSON.stringify(result));
    assert(performance.now() < deadline, "Fixture foreground did not settle");
    await Bun.sleep(100);
  }
}
const selector = (value: string, using = "id") => ({ using, value });
const target = (value: string) => ({ selector: selector(value) });
// These fixture reads consume labels, values and geometry. Hittability has its
// own explicit assertion above the input tests; do not re-query it for text.
const element = async (value: string) =>
  (await api("element", { ...target(value), attributes: ["label", "value", "rect"] })).value;
const inputValue = async (expected: string) => {
  // Native completion acknowledges dispatch, not the editor's rendered state.
  // Observe the exact result with a deadline; never replay a key to repair it.
  const result = await api("wait", {
    ...target("fixture.input"),
    condition: "attribute",
    attribute: "value",
    equals: expected,
    stableForMs: 100,
    timeoutMs: observationTimeoutMs,
  });
  return result.value.value;
};
let checks = 0;
const passed = (name: string) => {
  checks++;
  console.log(`PASS ${name}`);
};
// XCTest's first launch on a fresh hosted Simulator can itself exceed 45 s.
// Startup is a separate bounded phase, not part of an input latency assertion.
const readyDeadline = performance.now() + (process.env.IPORTAL_SIMULATOR === "1" ? 120000 : 45000);
let readiness = "No status response";
for (;;) {
  try {
    const status = (await (
      await fetch(`${url}/api/status`, { signal: AbortSignal.timeout(1500) })
    ).json()) as { ok: boolean; locked: boolean | null; lifecycle: string; error: string | null };
    readiness = JSON.stringify({
      lifecycle: status.lifecycle,
      locked: status.locked,
      error: status.error,
    });
    if (status.ok && status.locked === false) break;
  } catch {
    /* Allow the isolated test server to finish starting. */
  }
  assert(performance.now() < readyDeadline, `Helper is not ready and unlocked: ${readiness}`);
  await Bun.sleep(100);
}
await api("keep-awake", { enabled: true, durationMs: 1800000 });
await api("launch", { bundleId });
let state = await waitForApp();
assert.equal(state.app.bundleId, bundleId);
assert.equal(state.locked, false);
assert(state.screen.width > 320 && state.screen.height > 480);
passed("foreground identity and logical geometry");
for (const using of [
  "id",
  "name",
  "accessibility id",
  "class name",
  "predicate string",
  "class chain",
  "xpath",
]) {
  const value =
    {
      "class name": "XCUIElementTypeButton",
      "predicate string": "type == 'XCUIElementTypeButton' AND name == 'fixture.tap'",
      "class chain": "**/XCUIElementTypeButton[`name == 'fixture.tap'`][1]",
      xpath: "//XCUIElementTypeButton[@name='fixture.tap']",
    }[using] ?? "fixture.tap";
  const result = await api("elements", { selector: selector(value, using) });
  assert(using === "class name" ? result.value.length > 2 : result.value.length === 1, using);
  passed(`selector ${using}`);
}
assert.equal((await api("elements", target("fixture.duplicate"))).value.length, 2);
await api("element", target("fixture.duplicate"), 409);
await api("screenshot", target("fixture.duplicate"), 409);
await api("tap", target("fixture.disabled"), 409);
await api("elements", { selector: selector("//*invalid[", "xpath") }, 400);
await api("elements", { selector: selector("**/*[0]", "class chain") }, 400);
await api("elements", { selector: selector("name ===", "predicate string") }, 400);
passed("ambiguity, disabled controls and malformed selectors");
// Selector representations must retain identical attributes, duplicate order
// and root matching, even if their implementation is optimized later.
const comparisonAttributes = [
  "type",
  "name",
  "label",
  "value",
  "enabled",
  "visible",
  "selected",
  "accessible",
  "rect",
];
const xpathTap = (
  await api("element", {
    selector: selector("//XCUIElementTypeButton[@name='fixture.tap']", "xpath"),
    attributes: comparisonAttributes,
  })
).value;
for (const [using, value] of [
  ["id", "fixture.tap"],
  ["name", "fixture.tap"],
  ["accessibility id", "fixture.tap"],
  ["predicate string", "name == 'fixture.tap'"],
  ["class chain", "**/XCUIElementTypeButton[`name == 'fixture.tap'`][1]"],
]) {
  assert.deepEqual(
    (await api("element", { selector: selector(value!, using), attributes: comparisonAttributes }))
      .value,
    xpathTap,
    `Attribute parity for ${using}`,
  );
}
assert.deepEqual(
  (await api("elements", target("fixture.duplicate"))).value,
  (await api("elements", { selector: selector("//*[@name='fixture.duplicate']", "xpath") })).value,
);
assert.equal(
  (await api("elements", { selector: selector("XCUIElementTypeApplication", "class name") })).value
    .length,
  1,
);
passed("lookup/source attribute parity, duplicate order and application root inclusion");
const attributes = (
  await api("element", {
    ...target("fixture.tap"),
    attributes: [
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
    ],
  })
).value;
assert.equal(attributes.type, "XCUIElementTypeButton");
assert.equal(attributes.name, "fixture.tap");
assert.equal(attributes.label, "Tap");
assert.equal(attributes.value, null);
for (const field of ["enabled", "visible", "hittable", "accessible"])
  assert.equal(attributes[field], true, field);
assert.equal(attributes.selected, false);
passed("attribute types and accessibility flags");
for (const format of ["json", "xml", "description"]) {
  const source = (await api("source", { format })).value;
  if (format === "json") {
    assert.equal(source.type, "Application");
    assert.equal(typeof source.isEnabled, "string");
  } else {
    assert.equal(typeof source, "string");
    assert(source.length > 100);
    assert(!source.includes("iportalId="));
  }
}
let screenshotPixels: number[] = [];
for (const body of [{}, target("fixture.tap")]) {
  const image = (await api("screenshot", body)).value;
  assert.match(image.mimeType, /^image\//);
  assert.equal(image.encoding, "base64");
  const png = Buffer.from(image.data, "base64");
  assert(png.length > 100);
  if (!Object.keys(body).length) {
    assert.equal(png.subarray(1, 4).toString(), "PNG");
    screenshotPixels = [png.readUInt32BE(16), png.readUInt32BE(20)].sort((a, b) => a - b);
  }
}
passed("source formats and screen/element screenshots");
// Verify the actual encoded fallback frame, not UIImage's point dimensions.
// This catches Retina images accidentally scaled down a second time.
await api("quality", { level: "balanced" });
const displayStatus = (await fetch(`${url}/api/status`).then((response) => response.json())) as {
  displayPixels?: { width: number; height: number };
};
const stream = await fetch(`${url}/stream`, { signal: AbortSignal.timeout(5000) });
assert(stream.ok && stream.body);
const reader = stream.body.getReader();
let encoded = Buffer.alloc(0);
try {
  for (;;) {
    const part = await reader.read();
    assert(!part.done, "Fallback stream ended before its first image");
    encoded = Buffer.concat([encoded, part.value]);
    assert(encoded.length < 8 * 1024 * 1024);
    const start = encoded.indexOf(Buffer.from([0xff, 0xd8]));
    if (start < 0) continue;
    const end = encoded.indexOf(Buffer.from([0xff, 0xd9]), start + 2);
    if (end < 0) continue;
    encoded = encoded.subarray(start, end + 2);
    break;
  }
} finally {
  await reader.cancel();
}
let dimensions: number[] | undefined;
for (let offset = 2; offset + 9 < encoded.length;) {
  assert.equal(encoded[offset], 0xff);
  const marker = encoded[offset + 1];
  if (
    [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)
  ) {
    dimensions = [encoded.readUInt16BE(offset + 5), encoded.readUInt16BE(offset + 7)].sort(
      (a, b) => a - b,
    );
    break;
  }
  const length = encoded.readUInt16BE(offset + 2);
  assert(length >= 2);
  offset += 2 + length;
}
assert(dimensions, "JPEG frame has no image dimensions");
const expectedPixels = displayStatus.displayPixels;
assert(expectedPixels, "Helper must report native display dimensions");
assert(expectedPixels.width > 0 && expectedPixels.height >= expectedPixels.width);
assert(
  dimensions.every((value, index) => Math.abs(value - screenshotPixels[index] * 0.5) <= 1),
  `Balanced video ${JSON.stringify(dimensions)} must be half the captured pixels ${JSON.stringify(screenshotPixels)}; native display ${JSON.stringify(expectedPixels)}`,
);
passed("fallback video preserves the configured Retina pixel resolution");
const oldCounter = await element("fixture.counter");
const requestId = randomUUID();
const tap = { ...target("fixture.tap"), requestId };
assert.equal((await api("tap", tap)).outcome, "executed");
await api("tap", tap);
await api("wait", {
  ...target("fixture.counter"),
  condition: "attribute",
  attribute: "label",
  equals: `Taps: ${Number(oldCounter.label.split(": ")[1]) + 1}`,
  timeoutMs: observationTimeoutMs,
});
assert.equal(
  (await element("fixture.counter")).label,
  `Taps: ${Number(oldCounter.label.split(": ")[1]) + 1}`,
);
await api("element", { id: oldCounter.id }, 409);
await api("tap", { ...target("fixture.tap"), expectedApp: "com.example.not-the-fixture" }, 409);
passed("receipts, stale handles and app guards");
await api("wait", { ...target("fixture.tap"), condition: "exists", stableForMs: 100 });
await api("wait", { ...target("fixture.missing"), condition: "absent" });
await api("wait", {
  ...target("fixture.disabled"),
  condition: "attribute",
  attribute: "enabled",
  equals: false,
});
await api("wait", { ...target("fixture.missing"), timeoutMs: 200 }, 408);
passed("wait conditions, stability and deadline");
await api("tap", target("fixture.alert"));
await api("wait", { selector: selector("XCUIElementTypeAlert", "class name") });
await api("tap", {
  selector: selector("**/XCUIElementTypeAlert/**/XCUIElementTypeButton[-1]", "class chain"),
});
await api("wait", {
  selector: selector("XCUIElementTypeAlert", "class name"),
  condition: "absent",
});
const rowBefore = (await element("fixture.row.0")).rect;
await api("gesture", {
  points: [
    [0.5, 0.75, 0],
    [0.5, 0.35, 240],
  ],
  end: 300,
  expectedApp: bundleId,
});
const rowAfter = (await element("fixture.row.0")).rect;
assert(Math.abs(rowAfter.y - rowBefore.y) > 50, "Scroll did not move fixture content");
await api("gesture", {
  points: [
    [0.5, 0.3, 0],
    [0.5, 0.8, 240],
  ],
  end: 300,
  expectedApp: bundleId,
});
passed("alerts, descendant class chains and continuous scroll paths");
await api("tap", target("fixture.input"));
let keyboardLifecycle = (await element("fixture.title")).value;
const keyboardTrace = async (step: string, hardwareKey = false) => {
  // One coherent snapshot covers all three assertions. Separate queries both
  // waste native snapshots and can observe different stages of a transition.
  const nodes: Record<string, any>[] = [];
  const visit = (node: Record<string, any>) => {
    nodes.push(node);
    for (const child of node.children ?? []) visit(child);
  };
  visit((await api("source", { format: "json" })).value);
  const lifecycle = nodes.find((node) => node.name === "fixture.title")?.value;
  assert.equal(typeof lifecycle, "string", `${step}: fixture status missing`);
  const keyboards = nodes.filter((node) => node.type === "Keyboard").length;
  console.log(`Keyboard ${step}:`, {
    lifecycle,
    keyboards,
    value: nodes.find((node) => node.name === "fixture.input")?.value,
  });
  assert.equal(
    lifecycle.split(":")[1],
    keyboardLifecycle.split(":")[1],
    `${step}: input focus lost`,
  );
  // Simulator attaches the host keyboard for HID shortcuts. Text insertion must
  // remain stable there too; physical devices also require stable HID keys.
  if (!(hardwareKey && process.env.IPORTAL_SIMULATOR === "1")) {
    assert.equal(lifecycle, keyboardLifecycle, `${step}: keyboard dismissed`);
  }
  keyboardLifecycle = lifecycle;
  assert.equal(keyboards, 1, `${step}: software keyboard missing`);
};
await keyboardTrace("focused");
await api("key", { key: "a", modifiers: ["command"] });
await keyboardTrace("select all", true);
for (const text of ["a", "b", "c"]) {
  await api("type", { text });
  await keyboardTrace(`type ${text}`);
}
assert.equal(await inputValue("abc"), "abc");
await api("key", { key: "ArrowLeft" });
await keyboardTrace("arrow left", true);
await api("key", { key: "Backspace" });
await keyboardTrace("backspace", true);
assert.equal(await inputValue("ac"), "ac");
await api("key", { key: "a", modifiers: ["command"] });
await keyboardTrace("select unicode replacement", true);
await api("type", { text: "café 👋 世界" });
await keyboardTrace("type unicode");
assert.equal(await inputValue("café 👋 世界"), "café 👋 世界");
console.log("Keyboard notifications:", (await element("fixture.keyboardTrace")).label);
assert.equal(
  (await element("fixture.title")).value.split(":")[1],
  keyboardLifecycle.split(":")[1],
  "Input focus changed during typing",
);
passed("Unicode, Command-A, character navigation, deletion and focus retention");
await api("tap", {
  selector: selector(
    "type == 'XCUIElementTypeButton' AND name == 'fixture.editors'",
    "predicate string",
  ),
});
const unicode = 'é世界👋 عربي हिन्दी e\u0301👨‍👩‍👧‍👦"\\!';
const latinPassword =
  String.fromCharCode(
    ...Array.from({ length: 95 }, (_, i) => 32 + i),
    ...Array.from({ length: 23 }, (_, i) => 0xc0 + i),
    ...Array.from({ length: 31 }, (_, i) => 0xd8 + i),
    ...Array.from({ length: 8 }, (_, i) => 0xf8 + i),
  ) + "¡¢£¥§«°»¿";
const editorLabel = async (id: string, expected: string) => {
  // A native input acknowledgement precedes SwiftUI/WebKit's rendered update.
  // Observe the exact value; never replay an input while waiting for layout.
  const result = await api("wait", {
    ...target(id),
    condition: "attribute",
    attribute: "label",
    equals: expected,
    stableForMs: 100,
    timeoutMs: observationTimeoutMs,
  });
  return result.value.value;
};
for (const [input, output, secure, chunks] of [
  ["fixture.secure", "fixture.secureValue", true, ["a", "b", "c", latinPassword]],
  ["fixture.multiline", "fixture.multilineValue", false, ["first line\n", unicode]],
  ["Web input", "fixture.webValue", false, ["web line\n", unicode]],
  ["Web password", "fixture.webSecureValue", true, ["a", "b", "c", unicode]],
] as const) {
  const editor = {
    selector: selector(
      `type == '${secure ? "XCUIElementTypeSecureTextField" : "XCUIElementTypeTextView"}' AND name == '${input}'`,
      "predicate string",
    ),
  };
  console.log(`Checking ${input}`);
  await api("wait", editor);
  await api("tap", editor);
  await api("wait", {
    selector: selector("XCUIElementTypeKeyboard", "class name"),
    stableForMs: 100,
  });
  await api("key", { key: "a", modifiers: ["command"] });
  const dismissals = (await element("fixture.editorStatus")).value;
  let expected = "";
  for (const text of chunks) {
    await api("type", { text });
    expected += text;
    assert.equal(await editorLabel(output, expected), expected, `${input}: exact insertion`);
    assert.equal(
      (await element("fixture.editorStatus")).value,
      dismissals,
      `${input}: insertion dismissed keyboard or lost focus`,
    );
  }
  if (input === "fixture.secure") {
    for (const text of [unicode, "©", "e\u0301"]) {
      const rejected = await api("type", { text }, 502);
      assert.equal(rejected.code, "unsupported operation");
    }
    assert.equal(
      (await element(output)).label,
      expected,
      `${input}: rejected input mutated password`,
    );
  }
  await api("type", { text: "X" });
  await api("key", { key: "Backspace" });
  assert.equal(await editorLabel(output, expected), expected, `${input}: deletion`);
  await api("key", { key: "a", modifiers: ["command"] });
  await api("type", {
    text: input === "fixture.secure" ? "aéb" : secure ? "a界b" : "a👨‍👩‍👧‍👦b",
  });
  await api("key", { key: "ArrowLeft" });
  await api("key", { key: "Backspace" });
  assert.equal(await editorLabel(output, "ab"), "ab", `${input}: grapheme deletion at cursor`);
  if (input === "Web password" && process.env.IPORTAL_SIMULATOR !== "1") {
    // iOS can split secure-field emoji even with its own on-screen Delete key.
    // Compare independent native and mirrored actions rather than claiming a
    // Unicode editing guarantee that the system's password editor does not meet.
    const original = "a👨‍👩‍👧‍👦";
    const deleteResult = async (onScreen: boolean) => {
      await api("key", { key: "a", modifiers: ["command"] });
      await api("type", { text: original });
      await editorLabel(output, original);
      if (onScreen)
        await api("tap", {
          selector: selector(
            "type == 'XCUIElementTypeKey' AND name == 'delete'",
            "predicate string",
          ),
        });
      else await api("key", { key: "Backspace" });
      await api("wait", { ...target(output), stableForMs: 100 });
      return (await element(output)).label;
    };
    assert.equal(
      await deleteResult(false),
      await deleteResult(true),
      "Password deletion differs from the on-screen keyboard",
    );
  }
  if (process.env.IPORTAL_SIMULATOR !== "1")
    assert.equal(
      (await element("fixture.editorStatus")).value,
      dismissals,
      `${input}: editing dismissed keyboard or lost focus`,
    );
}
passed(
  "Native password and Unicode multiline/WebKit input without keyboard dismissal; unsupported native password text rejected before mutation",
);
await api("home");
await api("launch", { bundleId });
state = await waitForApp();
assert.equal(state.app.bundleId, bundleId);
const observation = (
  await api("observe", {
    screenshot: false,
    settleMs: 100,
    ...(process.env.IPORTAL_SIMULATOR === "1" ? { timeoutMs: observationTimeoutMs } : {}),
  })
).value;
assert.equal(observation.stable, true);
passed("app transitions and stable observation");
// Rejected commands must not mutate the focused field or consume its selection.
for (const [name, args] of [
  ["type", { text: "must-not-type" }],
  ["key", { key: "Backspace" }],
] as const) {
  const rejected = await api(name, { ...args, expectedApp: "synthetic.not.foreground" }, 409);
  assert.equal(rejected.code, "app changed");
  assert.equal(rejected.outcome, "not executed");
}
const opposite =
  state.orientation === "PORTRAIT"
    ? "UIA_DEVICE_ORIENTATION_PORTRAIT_UPSIDEDOWN"
    : state.orientation === "UIA_DEVICE_ORIENTATION_PORTRAIT_UPSIDEDOWN"
      ? "PORTRAIT"
      : state.orientation === "LANDSCAPE"
        ? "UIA_DEVICE_ORIENTATION_LANDSCAPERIGHT"
        : "LANDSCAPE";
const rejectedRotation = await api(
  "type",
  { text: "must-not-type", expectedOrientation: opposite },
  409,
);
assert.equal(rejectedRotation.code, "orientation changed");
assert.equal(rejectedRotation.outcome, "not executed");
passed("native app guards and exact opposite-orientation rejection preserve not-executed receipts");
const once = crypto.randomUUID();
const first = await api("home", { requestId: once });
await api("launch", { bundleId });
const replay = await api("home", { requestId: once });
assert.equal(replay.outcome, first.outcome);
assert.equal((await waitForApp()).app.bundleId, bundleId, "duplicate public request replayed Home");
passed("durable receipt replay returns the original outcome without repeating input");
// The editor page is still on the navigation stack after Home/launch.
await api("tap", {
  selector: selector(
    "type == 'XCUIElementTypeButton' AND (name == 'Back' OR label == 'Back')",
    "predicate string",
  ),
});
await api("tap", target("fixture.controls"));
await api("wait", target("fixture.replace"));
await api("element-action", { ...target("fixture.replace"), action: "focus" });
for (const text of ["Replacement café 世界 👋", "", "Final replacement"]) {
  await api("element-action", { ...target("fixture.replace"), action: "replaceText", text });
  // A separate label distinguishes an empty editor's placeholder from its value.
  await api("wait", {
    ...target("fixture.replacedValue"),
    condition: "attribute",
    attribute: "label",
    equals: `Value:${text}`,
    stableForMs: 100,
  });
}
await api("key", { key: "Enter" });
await api("element-action", { ...target("fixture.slider"), action: "adjust", value: 0.75 });
const percent = async () => parseFloat((await element("fixture.slider")).value);
const adjusted = await percent();
assert(Math.abs(adjusted - 75) < 10, `Slider adjustment: ${adjusted}`);
await api("element-action", { ...target("fixture.slider"), action: "decrement" });
assert((await percent()) < adjusted, "Native decrement did not lower slider");
await api("element-action", { ...target("fixture.slider"), action: "increment" });
const wrongType = await api(
  "element-action",
  { ...target("fixture.delayed"), action: "replaceText", text: "must-not-type" },
  [400, 422, 502],
);
assert.equal(wrongType.outcome, "not executed");
passed("Targeted focus, replacement, empty/Unicode text and normalized slider actions");
console.log(`${checks} native fixture checks passed`);
