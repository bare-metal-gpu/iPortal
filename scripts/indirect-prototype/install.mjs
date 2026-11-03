#!/usr/bin/env node
import { readFile, writeFile, copyFile, unlink } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const here=dirname(fileURLToPath(import.meta.url));
const remove=process.argv.includes("--remove");
const wda=resolve(process.argv.slice(2).find(x=>x!=="--remove") ?? resolve(here,"../../vendor/WebDriverAgent"));
const file=resolve(wda,"WebDriverAgentLib/Commands/FBTouchActionCommands.m");
const embed=resolve(wda,"Scripts/embed-runner-icon.sh");
const changes=[
  ["@implementation FBTouchActionCommands",'#import "FBMirrorIndirectExperiment.h"\n\n@implementation FBTouchActionCommands'],
  ['+ (NSArray *)routes\n{\n  return','+ (NSArray *)routes\n{\n  NSArray *routes ='],
  ['  ];\n}\n\n#pragma mark - Commands','  ];\n  return FMIEnabled() ? [routes arrayByAddingObject:[[FBRoute POST:@"/wda/mirror/indirect"].withoutSession respondWithTarget:self action:@selector(handleMirrorIndirect:)]] : routes;\n}\n\n+ (id<FBResponsePayload>)handleMirrorIndirect:(FBRouteRequest *)request\n{\n  return FMIRun(request.arguments);\n}\n\n#pragma mark - Commands'],
];
let source=await readFile(file,"utf8"), script=await readFile(embed,"utf8");
const anchor="# Re-codesign since we modified the bundle after Xcode signed it.";
const addition='# Indirect input prototype: only this separate developer build opts in.\nif [ "${MIRROR_INDIRECT_BUILD:-}" = "1" ]; then\n  /usr/libexec/PlistBuddy -c "Delete :UIApplicationSupportsIndirectInputEvents" "$PLIST" 2>/dev/null || true\n  /usr/libexec/PlistBuddy -c "Add :UIApplicationSupportsIndirectInputEvents bool true" "$PLIST"\n  /usr/libexec/PlistBuddy -c "Delete :UILaunchScreen" "$PLIST" 2>/dev/null || true\n  /usr/libexec/PlistBuddy -c "Add :UILaunchScreen dict" "$PLIST"\nfi\n\n';
const installed=source.includes('#import "FBMirrorIndirectExperiment.h"');
if(installed) for(const [,value] of changes) if(source.split(value).length!==2) throw Error("Incompatible partial installation");
if(remove && installed) for(const [old,value] of changes.toReversed()) source=source.replace(value,old);
if(!remove && !installed) for(const [old,value] of changes) {
  if(source.split(old).length!==2) throw Error(`Unexpected helper source: ${old.slice(0,60)}`);
  source=source.replace(old,value);
}
if(remove) script=script.replace(addition,"");
else if(!script.includes(addition)) {
  if(script.split(anchor).length!==2) throw Error("Cannot opt in generated runner to indirect input");
  script=script.replace(anchor,addition+anchor);
}
if(!remove) await copyFile(resolve(here,"FBMirrorIndirectExperiment.h"),resolve(dirname(file),"FBMirrorIndirectExperiment.h"));
await writeFile(file,source); await writeFile(embed,script);
if(remove) await unlink(resolve(dirname(file),"FBMirrorIndirectExperiment.h")).catch(e=>{if(e.code!=="ENOENT") throw e;});
console.log(remove?"Removed indirect experiment source instrumentation.":"Installed indirect experiment; build with MIRROR_INDIRECT_BUILD=1, run with TEST_RUNNER_MIRROR_INDIRECT_EXPERIMENT=1.");
