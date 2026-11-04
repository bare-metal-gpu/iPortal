import { test } from "bun:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
const root = path.resolve(import.meta.dirname, "..");

test("status installer is repeatable and rejects incompatible upstream sources", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "iportal-install-"));
  try {
    const commands = path.join(temp, "WebDriverAgentLib/Commands/FBTouchActionCommands.m");
    const embed = path.join(temp, "Scripts/embed-runner-icon.sh");
    fs.mkdirSync(path.dirname(commands), { recursive: true });
    fs.mkdirSync(path.dirname(embed));
    fs.writeFileSync(commands, "@implementation FBTouchActionCommands\n@end\n");
    fs.writeFileSync(embed, 'echo "embedded icon into $RUNNER_APP"\n');
    const install = () =>
      execFileSync(
        process.execPath,
        [path.join(root, "scripts/install-iportal-status.mjs"), temp],
        {
          stdio: "pipe",
        },
      );
    install();
    const first = [fs.readFileSync(commands, "utf8"), fs.readFileSync(embed, "utf8")];
    install();
    assert.deepEqual([fs.readFileSync(commands, "utf8"), fs.readFileSync(embed, "utf8")], first);
    assert.ok(fs.existsSync(path.join(temp, "iPortalUI/iPortalUI.m")));
    // Upgrade an already-installed status screen without adding duplicate hooks.
    fs.writeFileSync(commands, first[0].replaceAll("FBIPortalStatus", "FBPortalStatus"));
    fs.writeFileSync(
      embed,
      first[1].replaceAll("# iPortal", "# iPhone Portal").replaceAll("/iPortalUI/", "/PortalUI/"),
    );
    install();
    assert.deepEqual([fs.readFileSync(commands, "utf8"), fs.readFileSync(embed, "utf8")], first);
    fs.writeFileSync(embed, "incompatible upstream");
    assert.throws(install);
    assert.equal(fs.readFileSync(embed, "utf8"), "incompatible upstream");
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

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
          env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
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
