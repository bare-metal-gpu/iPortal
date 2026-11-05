#!/usr/bin/env bun
// Compile the exact pure Objective-C validators shipped in the WDA patch.
import assert from "node:assert/strict";
import { readFile, writeFile, mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const root = fileURLToPath(new URL("../", import.meta.url));
const patch = await readFile(join(root, "scripts/wda-mirror-safety.patch"), "utf8");
const added = patch
  .split("\n")
  .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
  .map((line) => line.slice(1))
  .join("\n");
const helpers = added.slice(
  added.indexOf("static BOOL FBMirrorFiniteNumber"),
  added.indexOf("static BOOL FBMirrorReadOrientation"),
);
const multiPatch = await readFile(join(root, "scripts/wda-multitouch.patch"), "utf8");
const multiAdded = multiPatch
  .split("\n")
  .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
  .map((line) => line.slice(1))
  .join("\n");
const multiHelper = multiAdded.slice(
  multiAdded.indexOf("static BOOL FBMirrorValidFingers"),
  multiAdded.indexOf("\n}\n") + 3,
);
const coordinatePatch = await readFile(join(root, "scripts/wda-mirror-coordinates.patch"), "utf8");
const coordinateAdded = coordinatePatch
  .split("\n")
  .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
  .map((line) => line.slice(1))
  .join("\n");
const coordinateHelper = coordinateAdded.slice(
  coordinateAdded.indexOf("static CGPoint FBMirrorPortraitPoint"),
  coordinateAdded.indexOf("\n}\n") + 3,
);
assert(coordinateHelper.includes("switch (orientation)"));
const keyboardSource = await readFile(join(root, "ios/FBIPortalText.h"), "utf8");
const keyboardValidation = keyboardSource.slice(
  keyboardSource.indexOf("static NSDictionary *FBIPortalKeyboardUsages"),
  keyboardSource.indexOf("@interface FBIPortalTextCommands"),
);
const portal = await readFile(join(root, "ios/FBIPortalStatus.h"), "utf8");
const portalPhase = portal.slice(
  portal.indexOf("static NSString *FBIPortalPhase"),
  portal.indexOf("\n}\n") + 3,
);
assert(helpers.includes("FBMirrorValidPoints") && helpers.includes("FBMirrorOrientedSize"));
const temporary = await mkdtemp(join(tmpdir(), "iportal-native-"));
try {
  if (process.platform === "darwin") {
    const source = `#import <Foundation/Foundation.h>
#import <CoreGraphics/CoreGraphics.h>
#import <math.h>
${helpers}
${multiHelper}
${coordinateHelper}
${portalPhase}
${keyboardValidation}
int main(void) { @autoreleasepool {
  NSCAssert(FBIPortalValidKeyboard(@{@"text":@"café 👋"}, NO), @"Unicode text");
  NSCAssert(FBIPortalValidKeyboard(@{@"text":@""}, NO), @"empty text no-op");
  NSCAssert(FBIPortalValidKeyboard(@{@"key":@"ArrowLeft",@"modifiers":@[@"shift",@"option"]}, YES), @"navigation chord");
  NSCAssert(FBIPortalValidKeyboard(@{@"key":@"🙂",@"modifiers":@[]}, YES), @"Unicode code point");
  for (NSDictionary *bad in @[@{@"key":@"unknown",@"modifiers":@[]}, @{@"key":@"a",@"modifiers":@[@"shift",@"shift"]}, @{@"key":@"a",@"modifiers":@[@"invalid"]}, @{@"key":@"ä",@"modifiers":@[@"command"]}, @{@"key":@"a",@"modifiers":@[],@"extra":@1}, @{@"key":NSNull.null,@"modifiers":@[]}])
    NSCAssert(!FBIPortalValidKeyboard(bad, YES), @"malformed keyboard input rejected");
  NSCAssert([FBIPortalPhase(0, 10, NO, NO) isEqual:@"waiting"], @"manual launch waits for Mac");
  NSCAssert([FBIPortalPhase(10, 11, NO, NO) isEqual:@"connecting"], @"first connection");
  NSCAssert([FBIPortalPhase(10, 12.9, YES, YES) isEqual:@"connected"], @"fresh ready heartbeat");
  NSCAssert([FBIPortalPhase(10, 13, YES, YES) isEqual:@"disconnected"], @"lost cable expires locally");
  NSCAssert([FBIPortalPhase(10, 60, YES, YES) isEqual:@"disconnected"], @"lost connection cannot claim reconnecting");
  NSCAssert([FBIPortalPhase(60, 61, NO, YES) isEqual:@"reconnecting"], @"fresh heartbeat confirms reconnect attempt");
  NSCAssert([FBIPortalPhase(61, 61, YES, YES) isEqual:@"connected"], @"recovered video");
  NSArray *finger = @[@[@0.25,@0.5,@0], @[@0.1,@0.5,@240]];
  NSCAssert(FBMirrorValidFingers(@[finger, finger], @240), @"two synchronized fingers");
  for (id fingers in @[NSNull.null, @[], @[finger], @[finger, finger, finger], @[finger, @[]], @[finger, @[@[@2,@0,@0]]]])
    NSCAssert(!FBMirrorValidFingers(fingers, @240), @"invalid fingers");
  NSCAssert(!FBMirrorValidFingers(@[finger, finger], @239), @"both paths must end before finger-up");
  NSCAssert(FBMirrorValidPoints(@[@[@0,@1,@0]], @0), @"edge tap");
  NSCAssert(FBMirrorValidPoints(@[@[@0,@1,@0],@[@1,@0,@10000]], @10000), @"max duration");
  NSCAssert(FBMirrorValidPoints(@[@[@0.5,@0.5,@0],@[@0.5,@0.5,@0]], @40), @"equal offsets");
  NSArray *bad = @[@[], @[@1], @[@[@0,@0]], @[@[@0,@0,@0,@0]],
    @[@[@(-0.01),@0,@0]], @[@[@1.01,@0,@0]], @[@[@0,@(-0.01),@0]], @[@[@0,@1.01,@0]],
    @[@[@YES,@0,@0]], @[@[@0,@NO,@0]], @[@[@0,@0,@NO]],
    @[@[@"0",@0,@0]], @[@[NSNull.null,@0,@0]], @[@[@(NAN),@0,@0]], @[@[@0,@(INFINITY),@0]],
    @[@[@0,@0,@(-1)]], @[@[@0,@0,@1]], @[@[@0,@0,@0],@[@0,@0,@2],@[@0,@0,@1]],
    @[@[@0,@0,@0],@[@0,@0,@10001]]];
  for (id points in bad) NSCAssert(!FBMirrorValidPoints(points, @10000), @"invalid points: %@", points);
  for (id end in @[@YES, @NO, @"100", NSNull.null, @(-1), @10001, @(NAN), @(INFINITY)])
    NSCAssert(!FBMirrorValidPoints(@[@[@0,@0,@0]], end), @"invalid end: %@", end);
  NSCAssert(!FBMirrorValidPoints(@[@[@0,@0,@0],@[@0,@0,@50]], @40), @"end before final point");
  NSCAssert(!FBMirrorValidPoints(nil, @0), @"missing points");
  NSCAssert(!FBMirrorValidPoints(@[@[@0,@0,@0]], nil), @"missing end");
  NSMutableArray *maximum = [NSMutableArray new];
  for (int i=0;i<256;i++) [maximum addObject:@[@0,@0,@(i)]];
  NSCAssert(FBMirrorValidPoints(maximum, @256), @"256 allowed");
  [maximum addObject:@[@0,@0,@256]];
  NSCAssert(!FBMirrorValidPoints(maximum, @256), @"257 rejected");
  for (int orientation=1;orientation<=4;orientation++) {
    CGSize a = FBMirrorOrientedSize(CGSizeMake(402,874), orientation);
    CGSize b = FBMirrorOrientedSize(CGSizeMake(874,402), orientation);
    NSCAssert(CGSizeEqualToSize(a,b), @"input physical orientation independent");
    NSCAssert(a.width == (orientation<3?402:874) && a.height == (orientation<3?874:402), @"oriented bounds");
    NSCAssert(FBMirrorOrientationName(orientation) != nil, @"orientation name");
  }
  NSCAssert(FBMirrorOrientationName(0) == nil, @"unknown orientation");
  // Fixtures from the oriented viewport -> portrait screen contract used by
  // XCUICoordinate.screenPoint. Asymmetric points catch 90/180-degree mistakes.
  CGPoint expected[] = {CGPointMake(100,50), CGPointMake(302,824), CGPointMake(352,100), CGPointMake(50,774)};
  CGPoint horizontal[] = {CGPointMake(40,0), CGPointMake(-40,0), CGPointMake(0,40), CGPointMake(0,-40)};
  CGPoint vertical[] = {CGPointMake(0,30), CGPointMake(0,-30), CGPointMake(-30,0), CGPointMake(30,0)};
  for (NSInteger orientation=1; orientation<=4; orientation++) {
    CGSize size=FBMirrorOrientedSize(CGSizeMake(402,874),orientation);
    CGPoint a=FBMirrorPortraitPoint(CGPointMake(100,50),size,orientation);
    CGPoint h=FBMirrorPortraitPoint(CGPointMake(140,50),size,orientation);
    CGPoint v=FBMirrorPortraitPoint(CGPointMake(100,80),size,orientation);
    NSCAssert(CGPointEqualToPoint(a,expected[orientation-1]), @"off-center tap");
    NSCAssert(CGPointEqualToPoint(CGPointMake(h.x-a.x,h.y-a.y),horizontal[orientation-1]), @"horizontal drag/scroll axis");
    NSCAssert(CGPointEqualToPoint(CGPointMake(v.x-a.x,v.y-a.y),vertical[orientation-1]), @"vertical drag/scroll axis");
    CGPoint f1=FBMirrorPortraitPoint(CGPointMake(80,50),size,orientation);
    CGPoint f2=FBMirrorPortraitPoint(CGPointMake(120,50),size,orientation);
    NSCAssert(CGPointEqualToPoint(CGPointMake((f1.x+f2.x)/2,(f1.y+f2.y)/2),a), @"pinch keeps its off-center anchor");
    NSCAssert(fabs(hypot(f2.x-f1.x,f2.y-f1.y)-40)<0.001, @"pinch preserves finger separation");
  }
} return 0; }`;
    const path = join(temporary, "contract.m");
    await writeFile(path, source);
    execFileSync(
      "xcrun",
      [
        "clang",
        "-fobjc-arc",
        "-Werror",
        "-framework",
        "Foundation",
        "-framework",
        "CoreGraphics",
        path,
        "-o",
        join(temporary, "contract"),
      ],
      { stdio: "pipe" },
    );
    execFileSync(join(temporary, "contract"), [], { stdio: "inherit" });
    console.log("Native validation and rotation contract passed.");
  } else console.log("Native Objective-C compile requires macOS; skipped.");

  // Exercise fresh install, previous-helper upgrade and repeat installs against actual upstream source.
  const vendor = join(root, "vendor/WebDriverAgent");
  let upstream;
  try {
    upstream = execFileSync(
      "git",
      ["-C", vendor, "show", "HEAD:WebDriverAgentLib/Commands/FBTouchActionCommands.m"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
  } catch {
    console.log("WDA checkout absent; patch installation check skipped.");
  }
  if (upstream) {
    const checkout = join(temporary, "wda");
    await mkdir(join(checkout, "WebDriverAgentLib/Commands"), { recursive: true });
    execFileSync("git", ["init", "-q", checkout]);
    const source = join(checkout, "WebDriverAgentLib/Commands/FBTouchActionCommands.m");
    const installer = join(root, "scripts/apply-wda-patches.sh");
    const lockSource = join(checkout, "WebDriverAgentLib/Categories/XCUIDevice+FBHelpers.m");
    const upstreamLock = execFileSync(
      "git",
      ["-C", vendor, "show", "HEAD:WebDriverAgentLib/Categories/XCUIDevice+FBHelpers.m"],
      { encoding: "utf8" },
    );
    await mkdir(join(lockSource, ".."), { recursive: true });
    await writeFile(lockSource, upstreamLock);
    const lockRoutes = join(checkout, "WebDriverAgentLib/Commands/FBCustomCommands.m");
    const upstreamLockRoutes = execFileSync(
      "git",
      ["-C", vendor, "show", "HEAD:WebDriverAgentLib/Commands/FBCustomCommands.m"],
      { encoding: "utf8" },
    );
    await writeFile(lockRoutes, upstreamLockRoutes);
    const authSources = [
      "Routing/FBHTTPServer.m",
      "Routing/FBWebServer.m",
      "Utilities/FBMjpegServer.m",
    ];
    for (const file of authSources) {
      await mkdir(join(checkout, "WebDriverAgentLib", file, ".."), { recursive: true });
      await writeFile(
        join(checkout, "WebDriverAgentLib", file),
        execFileSync("git", ["-C", vendor, "show", `HEAD:WebDriverAgentLib/${file}`]),
      );
    }
    await writeFile(source, upstream);
    execFileSync(installer, [checkout]);
    const installed = await readFile(source, "utf8");
    const installedLock = await readFile(lockSource, "utf8");
    const installedLockRoutes = await readFile(lockRoutes, "utf8");
    assert.notEqual(installedLock, upstreamLock);
    execFileSync(installer, [checkout]);
    assert.equal(await readFile(source, "utf8"), installed);
    assert.equal(await readFile(lockSource, "utf8"), installedLock);
    // A previously fully patched helper must receive this independent fix too.
    await writeFile(lockSource, upstreamLock);
    await writeFile(lockRoutes, upstreamLockRoutes);
    execFileSync(installer, [checkout]);
    assert.equal(await readFile(lockSource, "utf8"), installedLock);
    assert.equal(await readFile(lockRoutes, "utf8"), installedLockRoutes);
    await writeFile(lockSource, "incompatible lock source");
    assert.throws(() => execFileSync(installer, [checkout], { stdio: "pipe" }));
    assert.equal(await readFile(lockSource, "utf8"), "incompatible lock source");
    await writeFile(lockSource, installedLock);
    for (const file of authSources) {
      const installedAuth = await readFile(join(checkout, "WebDriverAgentLib", file), "utf8");
      assert.match(installedAuth, /FBIPortal|X-iPortal-Helper-Auth/);
    }
    await writeFile(source, upstream);
    for (const patch of [
      "wda-fast-touch.patch",
      "wda-mirror-safety.patch",
      "wda-mirror-latency.patch",
    ])
      execFileSync("git", ["-C", checkout, "apply", join(root, "scripts", patch)]);
    execFileSync(installer, [checkout]);
    assert.equal(await readFile(source, "utf8"), installed);
    await writeFile(source, upstream);
    execFileSync("git", ["-C", checkout, "apply", join(root, "scripts/wda-fast-touch.patch")]);
    execFileSync("git", ["-C", checkout, "apply", join(root, "scripts/wda-mirror-safety.patch")]);
    execFileSync(installer, [checkout]);
    assert.equal(await readFile(source, "utf8"), installed);
    await writeFile(source, upstream);
    execFileSync("git", ["-C", checkout, "apply", join(root, "scripts/wda-fast-touch.patch")]);
    execFileSync(installer, [checkout]);
    assert.equal(await readFile(source, "utf8"), installed);
    await writeFile(source, upstream);
    for (const patch of [
      "wda-fast-touch.patch",
      "wda-mirror-safety.patch",
      "wda-mirror-latency.patch",
      "wda-multitouch.patch",
    ])
      execFileSync("git", ["-C", checkout, "apply", join(root, "scripts", patch)]);
    execFileSync(installer, [checkout]);
    assert.equal(
      await readFile(source, "utf8"),
      installed,
      "upgrade the previously installed multi-touch helper",
    );
    await writeFile(source, "incompatible upstream");
    assert.throws(() => execFileSync(installer, [checkout], { stdio: "pipe" }));
    assert.equal(await readFile(source, "utf8"), "incompatible upstream");
    await writeFile(source, installed);
    const authSource = join(checkout, "WebDriverAgentLib/Routing/FBHTTPServer.m");
    await writeFile(authSource, "incompatible authentication source");
    assert.throws(() => execFileSync(installer, [checkout], { stdio: "pipe" }));
    assert.equal(await readFile(authSource, "utf8"), "incompatible authentication source");
    console.log("Fresh/upgrade/repeated/incompatible WDA patch installation passed.");
  }
} finally {
  await rm(temporary, { recursive: true, force: true });
}
