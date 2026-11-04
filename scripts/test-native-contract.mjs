#!/usr/bin/env node
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
${portalPhase}
int main(void) { @autoreleasepool {
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
    await writeFile(source, upstream);
    execFileSync(installer, [checkout]);
    const installed = await readFile(source, "utf8");
    execFileSync(installer, [checkout]);
    assert.equal(await readFile(source, "utf8"), installed);
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
    await writeFile(source, "incompatible upstream");
    assert.throws(() => execFileSync(installer, [checkout], { stdio: "pipe" }));
    assert.equal(await readFile(source, "utf8"), "incompatible upstream");
    console.log("Fresh/upgrade/repeated/incompatible WDA patch installation passed.");
  }
} finally {
  await rm(temporary, { recursive: true, force: true });
}
