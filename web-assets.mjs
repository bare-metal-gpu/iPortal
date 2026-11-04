import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import fontPath from "./macos/Fonts/InterVariable.ttf" with { type: "file" };

// Serve the exact native font locally. A fingerprinted URL lets WebKit cache it
// across reconnects without inflating every HTML response or needing a CDN.
const font = readFileSync(fontPath);
export const interFont = {
  path: `/assets/inter-${createHash("sha256").update(font).digest("hex").slice(0, 16)}.ttf`,
  body: font,
};

// Keep one HTML response and the classic-script globals used by the Mac bridge.
// Separate source files let the browser code participate in lint/type checks.
export function loadIPortalHTML() {
  // Build-time strings preserve the classic script exactly, without importing
  // browser globals into the server or relying on the working directory.
  const html =
    typeof IPORTAL_HTML !== "undefined"
      ? IPORTAL_HTML
      : readFileSync(new URL("./public/index.html", import.meta.url), "utf8");
  const script =
    typeof IPORTAL_SCRIPT !== "undefined"
      ? IPORTAL_SCRIPT
      : readFileSync(new URL("./public/iportal.js", import.meta.url), "utf8");
  if (!html.includes("<!-- iportal-script -->"))
    throw new Error("Missing mirror script placeholder");
  return html
    .replaceAll("__IPORTAL_INTER_FONT__", interFont.path)
    .replace("<!-- iportal-script -->", () => `<script>${script}</script>`);
}
