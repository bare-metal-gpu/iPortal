#!/usr/bin/env python3
"""Installs the development-only experiment into an already patched local WDA copy."""
from pathlib import Path
import shutil

root = Path(__file__).resolve().parents[2]
commands = root / "vendor/WebDriverAgent/WebDriverAgentLib/Commands"
source = commands / "FBTouchActionCommands.m"
text = source.read_text()
header = "FBMirrorDelayExperiment.h"
shutil.copyfile(Path(__file__).with_name(header), commands / header)
shutil.copyfile(Path(__file__).with_name("FBMirrorTouchProbe.h"), commands / "FBMirrorTouchProbe.h")
if '#import "FBMirrorTouchProbe.h"' not in text:
    text = text.replace("@implementation FBTouchActionCommands", '#import "FBMirrorTouchProbe.h"\n\n@implementation FBTouchActionCommands')
if '#import "FBMirrorDelayExperiment.h"' not in text:
    text = text.replace("@implementation FBTouchActionCommands", '#import "FBMirrorDelayExperiment.h"\n\n@implementation FBTouchActionCommands')
    text = text.replace('    [[FBRoute GET:@"/wda/mirror/capabilities"]', '    [[FBRoute POST:@"/wda/mirror/experiment/delay"].withoutSession respondWithTarget:self action:@selector(handleMirrorDelayExperiment:)],\n    [[FBRoute GET:@"/wda/mirror/capabilities"]')
    head, tail = text.rsplit("\n@end\n", 1)
    text = head + "\n+ (id<FBResponsePayload>)handleMirrorDelayExperiment:(FBRouteRequest *)request\n{\n  return FBMirrorDelayRun(request.arguments);\n}\n\n@end\n" + tail
text = text.replace('#import "FBMirrorTouchProbe.h"\n', "")
text = text.replace('#import "FBMirrorDelayExperiment.h"', '#import "FBMirrorTouchProbe.h"\n#import "FBMirrorDelayExperiment.h"')
source.write_text(text)
