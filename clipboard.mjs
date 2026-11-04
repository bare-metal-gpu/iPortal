import { setTimeout as sleep } from "node:timers/promises";
import { apiError } from "./errors.mjs";

export const clipboardLimit = 4 * 1024 * 1024;

export function validateClipboard(value) {
  if (!["text", "url", "image"].includes(value?.format) || typeof value.content !== "string")
    throw apiError("Unsupported clipboard content");
  const bytes = Buffer.from(value.content, "base64");
  if (!bytes.length || bytes.toString("base64") !== value.content)
    throw apiError("Invalid clipboard data");
  if (bytes.length > clipboardLimit || (value.format !== "image" && bytes.length > 1024 * 1024))
    throw apiError("Clipboard is too large", 413);
  if (value.format !== "image") {
    let text;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw apiError("Clipboard text must be UTF-8");
    }
    if (value.format === "url" && !URL.canParse(text)) throw apiError("Invalid clipboard URL");
  }
  return value;
}

export function createClipboard({ wda, withSession }) {
  return {
    async transfer(body) {
      if (body.operation === "write") validateClipboard(body);
      // The helper owns foreground handoff and restoration, including when the
      // host disconnects mid-transfer. Never replay a clipboard operation.
      await withSession(async () => undefined);
      const prepared = await wda("POST", "/wda/mirror/clipboard/prepare", {}, 5000);
      if (typeof prepared.value?.lease !== "string")
        throw apiError("Clipboard transfer unavailable", 502);
      let value;
      try {
        const deadline = performance.now() + 17000;
        do {
          ({ value } = await wda(
            "POST",
            "/wda/mirror/clipboard",
            { ...body, lease: prepared.value.lease },
            5000,
          ));
          if (!value?.pending) break;
          if (performance.now() > deadline)
            throw apiError("Allow Paste on your device, then try again", 408);
          await sleep(50);
        } while (value?.pending);
      } catch (error) {
        await wda(
          "POST",
          "/wda/mirror/clipboard",
          { operation: "cancel", lease: prepared.value.lease },
          2000,
        ).catch(() => {});
        throw error;
      }
      if (prepared.value.restoreBundleId) {
        const deadline = performance.now() + 3000;
        for (;;) {
          const active = (await wda("GET", "/wda/activeAppInfo")).value?.bundleId;
          if (active !== prepared.value.helperBundleId) break; // restored, or the user switched apps
          if (performance.now() >= deadline)
            throw apiError("Return to your app on the device, then try again", 409);
          await sleep(25);
        }
      }
      if (body.operation === "read") {
        if (value?.empty === true) return { empty: true };
        return validateClipboard(value);
      }
      if (value?.format !== body.format || !Number.isSafeInteger(value?.bytes) || value.bytes <= 0)
        throw apiError("Clipboard transfer could not be confirmed", 502);
      return value;
    },
  };
}
