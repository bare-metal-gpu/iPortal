import { test, expect } from "bun:test";
import { readHelperBuild } from "../helper-build.mjs";
import { linkHost } from "../ios/link-host.ts";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { helperCommand } from "../helper-launch.mjs";
import { tmpdir } from "node:os";
import path from "node:path";
import fs from "node:fs";
import assert from "node:assert/strict";
import { ensurePrivateDirectory, claimDevice } from "../device-runtime.mjs";
import { diagnosticTail, selectSimulator } from "../scripts/simulator-support.ts";

test("simulator selection uses runtime compatibility rather than a hard-coded phone", () => {
  const phone = (name: string) => ({
    name,
    productFamily: "iPhone",
    identifier: `com.apple.CoreSimulator.SimDeviceType.${name}`,
  });
  const runtime = (version: string, devices = [phone("iPhone-15-Pro")]) => ({
    identifier: `com.apple.CoreSimulator.SimRuntime.iOS-${version.replaceAll(".", "-")}`,
    version,
    isAvailable: true,
    supportedDeviceTypes: devices,
  });
  const older = runtime("26.5");
  const latest = runtime("27.2", [phone("iPhone-Duo"), phone("iPhone-18-Pro")]);
  const inventory = { runtimes: [older, latest, { ...runtime("28.0"), isAvailable: false }] };
  expect(selectSimulator(inventory, "27.2").device.identifier).toBe(
    phone("iPhone-18-Pro").identifier,
  );
  expect(selectSimulator(inventory, "27.2").runtime.version).toBe("27.2");
  expect(selectSimulator(inventory, "27.1").runtime.version).toBe("26.5");
  expect(selectSimulator(inventory, "27.2", "26.5").runtime.version).toBe("26.5");
  expect(() => selectSimulator(inventory, "27.2", "26.4")).toThrow("26.4");
  expect(() => selectSimulator(inventory, "27.2", "invalid")).toThrow("runtime version");
  expect(() => selectSimulator({ runtimes: [latest] }, "27.1")).toThrow("SDK 27.1");
  expect(() => selectSimulator(inventory, "invalid")).toThrow("SDK version");
  expect(selectSimulator({ runtimes: [runtime("27.1.1")] }, "27.1").runtime.version).toBe("27.1.1");
  expect(inventory.runtimes[0]).toBe(older);
  expect(
    selectSimulator(
      {
        runtimes: [
          runtime("27.2", [phone("iPhone-18-Pro"), phone("iPhone-17"), phone("iPhone-17e")]),
        ],
      },
      "27.2",
    ).device.identifier,
  ).toBe(phone("iPhone-17e").identifier);
  expect(
    selectSimulator({ runtimes: [runtime("27.9"), runtime("27.10")] }, "27.10").runtime.version,
  ).toBe("27.10");
  expect(
    selectSimulator({ runtimes: [{ ...latest, supportedDeviceTypes: undefined }, older] }, "27.2")
      .runtime.version,
  ).toBe("26.5");
  for (const runtimes of [
    [],
    [runtime("16.4")],
    [{ ...latest, supportedDeviceTypes: [] }],
    [runtime("27.2", [phone("iPhone-Duo")])],
    [{ ...latest, identifier: "com.apple.CoreSimulator.SimRuntime.tvOS-27-2" }],
    [
      runtime("27.2", [
        {
          name: "iPad",
          productFamily: "iPad",
          identifier: "com.apple.CoreSimulator.SimDeviceType.iPad",
        },
      ]),
    ],
  ]) {
    expect(() => selectSimulator({ runtimes }, "27.2")).toThrow("supported iPhone");
  }
  expect(() => selectSimulator({ runtimes: "invalid" }, "27.2")).toThrow();
  expect(
    selectSimulator({ runtimes: [runtime("18.0", [phone("iPhone-SE-3rd-generation")])] }, "18.0")
      .device.identifier,
  ).toBe(phone("iPhone-SE-3rd-generation").identifier);
});

test("simulator failure logs are bounded and redact complete and partial credentials", () => {
  const token = "0123456789abcdef".repeat(4);
  const lines = Array.from({ length: 130 }, (_, i) => `line ${i}`).join("\n");
  const output = diagnosticTail(
    `${lines}\nBearer ${token}\nFixture assertion failed`,
    token,
    false,
  );
  expect(output.split("\n")).toHaveLength(100);
  expect(output).toContain("Bearer [redacted]");
  expect(output).toEndWith("Fixture assertion failed");
  expect(output).not.toContain(token);
  expect(diagnosticTail(`${token.slice(10)}\nActual error`, token, true)).toBe("Actual error");
  expect(diagnosticTail(token.slice(10), token, true)).toBe("");
});

test("runtime directories repair permissions and reject pre-created symlinks", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "iportal-permissions-"));
  try {
    fs.chmodSync(directory, 0o755);
    ensurePrivateDirectory(directory);
    expect(fs.statSync(directory).mode & 0o777).toBe(0o700);
    const target = path.join(directory, "target");
    const link = path.join(directory, "link");
    await mkdir(target, { mode: 0o755 });
    fs.symlinkSync(target, link);
    expect(() => ensurePrivateDirectory(link)).toThrow();
    await assert.rejects(claimDevice("TESTDEVICE01", link));
    expect(fs.statSync(target).mode & 0o777).toBe(0o755);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("phone launcher requires one test bundle and keeps device/path arguments distinct", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "iportal-launch-"));
  try {
    const products = path.join(directory, "Build/Products");
    await mkdir(products, { recursive: true });
    expect(() => helperCommand("invalid id", directory, directory)).toThrow();
    expect(() => helperCommand("TESTDEVICE01", directory, directory)).toThrow();
    await Bun.write(
      path.join(directory, "helper-manifest.json"),
      JSON.stringify({ protocol: 1, build: "a".repeat(64) }),
    );
    const run = path.join(products, "iPortal iphoneos.xctestrun");
    await Bun.write(run, "fixture");
    const command = helperCommand("TESTDEVICE01", directory, directory);
    expect(command[0]).toBe("/usr/bin/xcodebuild");
    expect(command[command.indexOf("-xctestrun") + 1]).toBe(run);
    expect(command).toContain("-only-testing:iPortalRunner/iPortalRunner/testServe");
    expect(command[command.indexOf("-destination") + 1]).toBe("id=TESTDEVICE01");
    await Bun.write(path.join(products, "second-iphoneos.xctestrun"), "fixture");
    expect(() => helperCommand("TESTDEVICE01", directory, directory)).toThrow();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("helper build identity rejects missing, malformed and incompatible manifests", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "iportal-manifest-"));
  try {
    expect(readHelperBuild(directory)).toBeNull();
    expect(() => readHelperBuild(directory, true)).toThrow();
    for (const manifest of [
      { protocol: 2, build: "a".repeat(64) },
      { protocol: 1, build: "bad" },
    ]) {
      await Bun.write(path.join(directory, "helper-manifest.json"), JSON.stringify(manifest));
      expect(() => readHelperBuild(directory)).toThrow();
    }
    await Bun.write(
      path.join(directory, "helper-manifest.json"),
      JSON.stringify({ protocol: 1, build: "b".repeat(64) }),
    );
    expect(readHelperBuild(directory)).toBe("b".repeat(64));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
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
        const run = Bun.spawnSync([process.execPath, "ios/configure-host.ts", file, "", "123.4.5"]);
        expect(run.exitCode).toBe(0);
      }
      const result = JSON.parse(
        Bun.spawnSync(["plutil", "-convert", "json", "-o", "-", file]).stdout.toString(),
      );
      expect(result.CFBundleIdentifier).toBe(info.CFBundleIdentifier);
      expect(result.CFBundleVersion).toBe("123.4.5");
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
