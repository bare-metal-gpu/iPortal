import { setTimeout as sleep } from "node:timers/promises";
import { apiError } from "./errors.mjs";

import { decodeHelper, ClipboardPayloadSchema, type HelperResult } from "./helper-protocol.ts";
export type ClipboardPayload = import("effect").Schema.Schema.Type<typeof ClipboardPayloadSchema>;
type Transfer = { operation: "read" } | ({ operation: "write" } & ClipboardPayload);
const clipboardLimit = 4 * 1024 * 1024;

export function validateClipboard(input: unknown): ClipboardPayload {
  let value: ClipboardPayload;
  try {
    value = decodeHelper(ClipboardPayloadSchema, input);
  } catch {
    throw apiError("Unsupported clipboard content");
  }
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

export function createClipboard({
  helper,
}: {
  helper: Pick<ReturnType<typeof import("./helper-client.ts").createHelperClient>, "command">;
}) {
  return {
    async transfer(body: Transfer) {
      if (body.operation === "write")
        validateClipboard({ format: body.format, content: body.content });
      // The helper owns foreground handoff and restoration, including when the
      // host disconnects mid-transfer. Never replay a clipboard operation.
      const prepared = await helper.command("clipboardPrepare", {}, { timeout: 5000 });
      if (typeof prepared?.lease !== "string")
        throw apiError("Clipboard transfer unavailable", 502);
      let value: HelperResult<"clipboardRead"> | HelperResult<"clipboardWrite">;
      try {
        const deadline = performance.now() + 17000;
        do {
          value =
            body.operation === "read"
              ? await helper.command("clipboardRead", { lease: prepared.lease }, { timeout: 5000 })
              : await helper.command(
                  "clipboardWrite",
                  { lease: prepared.lease, format: body.format, content: body.content },
                  { timeout: 5000 },
                );
          if (!("pending" in value)) break;
          if (performance.now() > deadline)
            throw apiError("Allow Paste on your device, then try again", 408);
          await sleep(50);
        } while ("pending" in value);
      } catch (error) {
        await helper
          .command("clipboardCancel", { lease: prepared.lease }, { timeout: 2000 })
          .catch(() => {});
        throw error;
      }
      if (prepared.restoreBundleId) {
        const deadline = performance.now() + 3000;
        for (;;) {
          const active = (await helper.command("app")).bundleId;
          if (active !== prepared.helperBundleId) break; // restored, or the user switched apps
          if (performance.now() >= deadline)
            throw apiError("Return to your app on the device, then try again", 409);
          await sleep(25);
        }
      }
      if (body.operation === "read") {
        if ("empty" in value && value.empty === true) return { empty: true };
        return validateClipboard(value);
      }
      if (
        !("format" in value) ||
        value.format !== body.format ||
        !("bytes" in value) ||
        !Number.isSafeInteger(value.bytes) ||
        value.bytes <= 0
      )
        throw apiError("Clipboard transfer could not be confirmed", 502);
      return value;
    },
  };
}
