import { test, expect } from "bun:test";
import { configure } from "../scripts/configure-ios.ts";
import { linkHost } from "../ios/link-host.ts";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { helperCommand } from "../helper-launch.mjs";
import { tmpdir } from "node:os";
import path from "node:path";

test("phone launcher requires one test bundle and keeps device/path arguments distinct", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "iportal-launch-"));
  try {
    const products = path.join(directory, "Build/Products");
    await mkdir(products, { recursive: true });
    expect(() => helperCommand("invalid id", directory, directory)).toThrow();
    expect(() => helperCommand("TESTDEVICE01", directory, directory)).toThrow();
    const run = path.join(products, "iPortal iphoneos.xctestrun");
    await Bun.write(run, "fixture");
    const command = helperCommand("TESTDEVICE01", directory, directory);
    expect(command[0]).toBe("/usr/bin/xcodebuild");
    expect(command[command.indexOf("-xctestrun") + 1]).toBe(run);
    expect(command[command.indexOf("-destination") + 1]).toBe("id=TESTDEVICE01");
    await Bun.write(path.join(products, "second-iphoneos.xctestrun"), "fixture");
    expect(() => helperCommand("TESTDEVICE01", directory, directory)).toThrow();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("signing configuration preserves upstream targets across fresh, repeated and changed teams", () => {
  for (const old of [
    "com.facebook.WebDriverAgentRunner",
    "com.testteam01.iphonemirror.WebDriverAgentRunner",
  ]) {
    const source =
      `PRODUCT_BUNDLE_IDENTIFIER = ${old};\nPRODUCT_NAME = "$(TARGET_NAME)";\n`.repeat(3) +
      'PRODUCT_BUNDLE_IDENTIFIER = com.facebook.WebDriverAgentLib;\nPRODUCT_NAME = "$(TARGET_NAME)";';
    const changed = configure(source, "TESTTEAM01");
    expect(changed.match(/com.testteam01.iportal.mobile/g)).toHaveLength(3);
    expect(changed).toContain('com.facebook.WebDriverAgentLib;\nPRODUCT_NAME = "$(TARGET_NAME)";');
    expect(configure(changed, "TESTTEAM01")).toBe(changed);
    expect(configure(changed, "ABCDEFGHIJ").match(/com.abcdefghij.iportal.mobile/g)).toHaveLength(
      3,
    );
  }
  expect(() => configure("", "../invalid")).toThrow();
  expect(() => configure("", "TESTTEAM01")).toThrow();
});

const library = "@executable_path/Frameworks/iPortalUI.framework/iPortalUI";
function host() {
  const data = Buffer.alloc(512);
  [0xfeedfacf, 0x100000c, 0, 2, 1, 152, 0, 0].forEach((n, i) => data.writeUInt32LE(n, i * 4));
  data.writeUInt32LE(0x19, 32);
  data.writeUInt32LE(152, 36);
  data.writeUInt32LE(1, 32 + 64);
  data.writeUInt32LE(384, 32 + 72 + 48);
  data.fill(0xa5, 384);
  return data;
}
test("Mach-O linkage changes only unused padding and is repeatable for thin and universal hosts", () => {
  const original = host(),
    linked = linkHost(original, library);
  expect(original).toEqual(host());
  expect(linked.subarray(384)).toEqual(original.subarray(384));
  expect(linked.readUInt32LE(16)).toBe(2);
  expect(linked.subarray(184 + 24).toString()).toStartWith(library + "\0");
  expect(linkHost(linked, library)).toEqual(linked);
  const fat = Buffer.alloc(4096 + original.length);
  [0xcafebabe, 1, 0x100000c, 0, 4096, original.length, 12].forEach((n, i) =>
    fat.writeUInt32BE(n, i * 4),
  );
  original.copy(fat, 4096);
  const result = linkHost(fat, library);
  expect(result.subarray(0, 4096)).toEqual(fat.subarray(0, 4096));
  expect(result.subarray(4096)).toEqual(linked);
});
test("Mach-O patch refuses malformed, foreign and insufficient-padding hosts", () => {
  for (const mutate of [
    (data: Buffer) => data.writeUInt32LE(7, 4),
    (data: Buffer) => data.writeUInt32LE(9, 16),
    (data: Buffer) => data.writeUInt32LE(9999, 20),
    (data: Buffer) => data.writeUInt32LE(7, 36),
    (data: Buffer) => data.writeUInt32LE(9, 32 + 64),
    (data: Buffer) => data.writeUInt32LE(190, 32 + 72 + 48),
    (data: Buffer) => data.writeUInt8(1, 184),
  ]) {
    const data = host();
    mutate(data);
    expect(() => linkHost(data, library)).toThrow();
  }
  expect(() => linkHost(Buffer.alloc(0), library)).toThrow();
});
test.skipIf(process.platform !== "darwin")(
  "host plist migration preserves unrelated settings and supports binary plists",
  async () => {
    const temp = await mkdtemp(path.join(tmpdir(), "iportal-plist-"));
    try {
      const file = path.join(temp, "Info.plist");
      const info = {
        CFBundleIdentifier: "com.example.fixture",
        UIApplicationSceneManifest: { unrelated: true },
      };
      await Bun.write(file, JSON.stringify(info));
      expect(Bun.spawnSync(["plutil", "-convert", "binary1", file]).exitCode).toBe(0);
      for (let i = 0; i < 2; i++) {
        const run = Bun.spawnSync([process.execPath, "ios/configure-host.ts", file]);
        expect(run.exitCode).toBe(0);
      }
      const result = JSON.parse(
        Bun.spawnSync(["plutil", "-convert", "json", "-o", "-", file]).stdout.toString(),
      );
      expect(result.CFBundleIdentifier).toBe(info.CFBundleIdentifier);
      expect(result.UIApplicationSceneManifest.unrelated).toBe(true);
      expect(
        result.UIApplicationSceneManifest.UISceneConfigurations
          .UIWindowSceneSessionRoleApplication[0].UISceneDelegateClassName,
      ).toBe("_XCTRunnerAppDelegate");
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  },
);
