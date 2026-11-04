import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

// Serve the exact native font locally. A fingerprinted URL lets WebKit cache it
// across reconnects without inflating every HTML response or needing a CDN.
const font = readFileSync(new URL("./macos/Fonts/InterVariable.ttf", import.meta.url));
export const interFont = {
  path: `/assets/inter-${createHash("sha256").update(font).digest("hex").slice(0, 16)}.ttf`,
  body: font,
};

// Keep one HTML response and the classic-script globals used by the Mac bridge.
// Separate source files let the browser code participate in lint/type checks.
export function loadIPortalHTML() {
  const html = readFileSync(new URL("./public/index.html", import.meta.url), "utf8");
  const script = readFileSync(new URL("./public/iportal.js", import.meta.url), "utf8");
  if (!html.includes("<!-- iportal-script -->"))
    throw new Error("Missing mirror script placeholder");
  return html
    .replaceAll("__IPORTAL_INTER_FONT__", interFont.path)
    .replace("<!-- iportal-script -->", () => `<script>${script}</script>`);
}
