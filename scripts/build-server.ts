import path from "node:path";
import { mkdir } from "node:fs/promises";

const root = path.resolve(import.meta.dirname, "..");
if (!Bun.semver.satisfies(Bun.version, ">=1.4.4")) throw new Error("Bun 1.4.4+ is required");
const output = path.resolve(process.argv[2] ?? path.join(root, "dist/iportal-server"));
await mkdir(path.dirname(output), { recursive: true });
const result = await Bun.build({
  entrypoints: [path.join(root, "runtime-entry.ts")],
  root,
  compile: {
    outfile: output,
    autoloadDotenv: false,
    autoloadBunfig: false,
    autoloadTsconfig: false,
    autoloadPackageJson: false,
  },
  define: {
    IPORTAL_PACKAGED: "true",
    IPORTAL_HTML: JSON.stringify(await Bun.file(path.join(root, "public/index.html")).text()),
    IPORTAL_SCRIPT: JSON.stringify(await Bun.file(path.join(root, "public/iportal.js")).text()),
  },
  minify: true,
});
if (!result.success) throw new AggregateError(result.logs, "Could not build iPortal server");
console.log(`Built ${output}`);
