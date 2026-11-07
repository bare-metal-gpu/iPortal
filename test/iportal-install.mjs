import { test } from "bun:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
const root = path.resolve(import.meta.dirname, "..");

test.skipIf(process.platform !== "darwin")(
  "failed native build restores the complete original host bundle",
  () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "iportal-rollback-"));
    try {
      const runner = path.join(temp, "Runner.app"),
        bin = path.join(temp, "bin"),
        source = path.join(temp, "source");
      fs.mkdirSync(runner);
      fs.mkdirSync(bin);
      fs.mkdirSync(source);
      fs.writeFileSync(path.join(runner, "Info.plist"), "original plist");
      fs.writeFileSync(path.join(runner, "host"), "original executable", { mode: 0o755 });
      fs.writeFileSync(path.join(bin, "xcrun"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
      fs.copyFileSync(path.join(root, "ios/embed.sh"), path.join(source, "embed.sh"));
      // Exercise rollback after newly copied framework/resources, not a preflight.
      fs.mkdirSync(path.join(source, "iPortalUI.framework"));
      fs.writeFileSync(path.join(source, "iPortalUI.framework/iPortalUI"), "new framework");
      fs.mkdirSync(path.join(source, "Libraries.dev_BorderBeamKit.bundle"));
      fs.writeFileSync(
        path.join(source, "Libraries.dev_BorderBeamKit.bundle/default.metallib"),
        "new shaders",
      );
      assert.throws(() =>
        execFileSync("bash", [path.join(source, "embed.sh"), runner], {
          env: { ...process.env, IPORTAL_UI_PRODUCTS: source, PATH: `${bin}:${process.env.PATH}` },
          stdio: "pipe",
        }),
      );
      assert.deepEqual(fs.readdirSync(runner).sort(), ["Info.plist", "host"]);
      assert.equal(fs.readFileSync(path.join(runner, "host"), "utf8"), "original executable");
      assert.equal(fs.readFileSync(path.join(runner, "Info.plist"), "utf8"), "original plist");
      assert.ok(fs.statSync(path.join(runner, "host")).mode & 0o100);
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  },
);
