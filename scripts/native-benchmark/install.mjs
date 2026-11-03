#!/usr/bin/env node
// Explicit opt-in installation, separate from normal WDA setup. Refuse source drift.
import { readFile, writeFile, copyFile, unlink } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const remove = process.argv.includes("--remove");
const wda = resolve(process.argv.slice(2).find(arg => arg !== "--remove") ?? resolve(here, "../../vendor/WebDriverAgent"));
const commands = resolve(wda, "WebDriverAgentLib/Commands");
const source = resolve(commands, "FBTouchActionCommands.m");
let text = await readFile(source, "utf8");
const changes = [
  ["@implementation FBTouchActionCommands", '#import "FBMirrorBenchmark.h"\n\n@implementation FBTouchActionCommands'],
  ['+ (NSArray *)routes\n{\n  return', '+ (NSArray *)routes\n{\n  NSArray *routes ='],
  ['  ];\n}\n\n#pragma mark - Commands', '  ];\n  return FBMirrorBenchmarkEnabled() ? [routes arrayByAddingObject:[[FBRoute POST:@"/wda/mirror/benchmark"].withoutSession respondWithTarget:self action:@selector(handleMirrorBenchmark:)]] : routes;\n}\n\n+ (id<FBResponsePayload>)handleMirrorBenchmark:(FBRouteRequest *)request\n{\n  return FBMirrorBenchmarkRun(request.arguments);\n}\n\n#pragma mark - Commands'],
  ['  NSTimeInterval dispatched = NSProcessInfo.processInfo.systemUptime;', '  NSTimeInterval dispatched = NSProcessInfo.processInfo.systemUptime;\n  __block NSTimeInterval benchmarkCallback = 0;'],
  ['+ (id<FBResponsePayload>)handleMirrorTouch:(FBRouteRequest *)request\n{', '+ (id<FBResponsePayload>)handleMirrorTouch:(FBRouteRequest *)request\n{\n  if (FBMirrorBenchmarkEnabled() && (UIApplication.sharedApplication.applicationState != UIApplicationStateActive || ![FBMirrorBenchmarkView.shared.snapshot[@"visible"] boolValue] || FBMirrorBenchmarkView.shared.sequence >= 250))\n    return FBResponseWithStatus([FBCommandStatus invalidElementStateErrorWithMessage:@"Benchmark requires the foreground recorder and fewer than 250 gestures" traceback:nil]);'],
  ['_XCT_synthesizeEvent:event\n                                         implicitConfirmationInterval:0.05\n                                                           completion:^(NSError *innerError) {\n    playbackError = innerError;', '_XCT_synthesizeEvent:event\n                                         implicitConfirmationInterval:0.05\n                                                           completion:^(NSError *innerError) {\n    playbackError = innerError;\n    benchmarkCallback = NSProcessInfo.processInfo.systemUptime;'],
  ['@"confirmationMs":@50}});', '@"confirmationMs":@50, @"benchmark":FBMirrorBenchmarkTiming(dispatched, benchmarkCallback)}});']
];
const installed = text.includes('#import "FBMirrorBenchmark.h"');
if (installed) {
  for (const [, replacement] of changes) {
    if (text.split(replacement).length !== 2) throw Error("Partial or incompatible benchmark installation");
  }
}
if (remove && installed) {
  for (const [old, replacement] of changes.toReversed()) text = text.replace(replacement, old);
} else if (!remove && !installed) {
  for (const [old, replacement] of changes) {
    if (text.split(old).length !== 2) throw Error(`Unexpected helper source near ${old.slice(0,70)}`);
    text = text.replace(old, replacement);
  }
}
if (remove) {
  await writeFile(source, text);
  await unlink(resolve(commands, "FBMirrorBenchmark.h")).catch(error => { if (error.code !== "ENOENT") throw error; });
  console.log("Benchmark helper instrumentation removed; existing built runners are unchanged.");
} else {
  await copyFile(resolve(here, "FBMirrorBenchmark.h"), resolve(commands, "FBMirrorBenchmark.h"));
  await writeFile(source, text);
  console.log("Benchmark helper installed; route requires TEST_RUNNER_MIRROR_BENCHMARK=1 at launch.");
}
