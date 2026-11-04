// plutil handles both binary and XML plists; Bun owns the structural changes.
const file = process.argv[2];
if (!file) throw new Error("Usage: configure-host.ts <Info.plist>");
const read = Bun.spawnSync(["/usr/bin/plutil", "-convert", "json", "-o", "-", file]);
if (read.exitCode !== 0) throw new Error(read.stderr.toString());
const info = JSON.parse(read.stdout.toString());
info.UILaunchStoryboardName = "iPortalLaunch";
const manifest = (info.UIApplicationSceneManifest ??= {});
const configurations = (manifest.UISceneConfigurations ??= {});
configurations.UIWindowSceneSessionRoleApplication = [
  {
    UISceneConfigurationName: "Default Configuration",
    UISceneDelegateClassName: "_XCTRunnerAppDelegate",
  },
];
const write = Bun.spawnSync(["/usr/bin/plutil", "-convert", "xml1", "-o", file, "-"], {
  stdin: Buffer.from(JSON.stringify(info)),
});
if (write.exitCode !== 0) throw new Error(write.stderr.toString());
