import { readFileSync } from "node:fs";

// Keep one HTML response and the classic-script globals used by the Mac bridge.
// Separate source files let the browser code participate in lint/type checks.
export function loadMirrorHTML() {
  const html = readFileSync(new URL("./public/index.html", import.meta.url), "utf8");
  const script = readFileSync(new URL("./public/mirror.js", import.meta.url), "utf8");
  if (!html.includes("<!-- mirror-script -->"))
    throw new Error("Missing mirror script placeholder");
  return html.replace("<!-- mirror-script -->", () => `<script>${script}</script>`);
}
