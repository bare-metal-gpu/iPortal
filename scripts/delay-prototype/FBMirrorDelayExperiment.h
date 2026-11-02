// Development-only completion-delay experiment. Include once in FBTouchActionCommands.m.
// No daemon patching, entitlements, early acknowledgement or overlap is introduced.
@protocol FBDelayComposer <NSObject>
- (void)composeWithSender:(id)sender actionBlock:(void (^)(id<FBDelayComposer>))block;
- (void)setGsScreenPointSize:(CGSize)size;
- (void)touchDown:(CGPoint)point;
- (void)advanceTime:(double)duration;
- (void)moveToPoint:(CGPoint)point duration:(double)duration;
- (void)liftUp:(CGPoint)point;
@end
@protocol FBDelayStream <NSObject>
+ (id<FBDelayStream>)eventStreamWithEventActions:(void (^)(id<FBDelayComposer>))block;
+ (id)touchScreenDigitizerSender;
- (NSArray *)events;
@end
@protocol FBDelayInlinePlayer <NSObject>
- (void)setNeedsInitialDelay:(BOOL)value;
- (void)setIgnoresCompletionDelay:(BOOL)value;
- (void)playEventStream:(id)stream options:(id)options completion:(void (^)(void))completion;
- (id)underlyingPlayer;
- (void)tearDown;
@end
@protocol FBDelayPlayer <NSObject>
- (BOOL)prewarmForEventStream:(id)stream withError:(NSError **)error;
@end

static id<FBResponsePayload> FBMirrorDelayRun(NSDictionary *arguments)
{
  if (![NSProcessInfo.processInfo.environment[@"MIRROR_DELAY_EXPERIMENT"] isEqual:@"1"])
    return FBResponseWithStatus([FBCommandStatus unsupportedOperationErrorWithMessage:@"Delay experiment disabled" traceback:nil]);
  NSString *mode = arguments[@"mode"];
  if ([@[@"show", @"state", @"reset", @"hide"] containsObject:mode]) {
    if ([mode isEqual:@"show"]) return FBResponseWithObject([FBMirrorTouchProbe show]);
    if ([mode isEqual:@"hide"]) {
      if (FBMirrorTouchProbe.shared.active.count) return FBResponseWithStatus([FBCommandStatus invalidElementStateErrorWithMessage:@"Cannot hide active contact" traceback:nil]);
      return FBResponseWithObject([FBMirrorTouchProbe hide]);
    }
    if ([mode isEqual:@"reset"]) {
      if (FBMirrorTouchProbe.shared.active.count) return FBResponseWithStatus([FBCommandStatus invalidElementStateErrorWithMessage:@"Cannot reset active contact" traceback:nil]);
      [FBMirrorTouchProbe.shared reset];
    }
    return FBResponseWithObject(FBMirrorTouchProbe.shared.snapshot);
  }
  NSNumber *durationMs = arguments[@"durationMs"] ?: @60;
  NSNumber *confirmationMs = arguments[@"confirmationMs"] ?: @50;
  NSNumber *ignoreDelay = arguments[@"ignoreDelay"] ?: @NO;
  if (![@[@"daemon", @"empty", @"local"] containsObject:mode]
      || !FBMirrorFiniteNumber(durationMs) || durationMs.doubleValue < 40 || durationMs.doubleValue > 500
      || !FBMirrorFiniteNumber(confirmationMs) || ![@[@0,@50,@300] containsObject:confirmationMs]
      || CFGetTypeID((__bridge CFTypeRef)ignoreDelay) != CFBooleanGetTypeID())
    return FBResponseWithStatus([FBCommandStatus invalidArgumentErrorWithMessage:@"mode daemon/empty/local, durationMs 40..500, confirmationMs 0/50/300, ignoreDelay boolean" traceback:nil]);
  for (NSString *key in arguments) if (![@[@"mode",@"durationMs",@"confirmationMs",@"ignoreDelay"] containsObject:key])
    return FBResponseWithStatus([FBCommandStatus invalidArgumentErrorWithMessage:@"Unknown experiment argument" traceback:nil]);
  // Every nonempty experiment is constrained to the runner's harmless recorder.
  if (XCUIDevice.sharedDevice.fb_isScreenLocked)
    return FBResponseWithStatus([FBCommandStatus invalidElementStateErrorWithMessage:@"Device locked" traceback:nil]);
  if (![XCUIApplication.fb_activeApplication.bundleID isEqual:NSBundle.mainBundle.bundleIdentifier])
    return FBResponseWithStatus([FBCommandStatus invalidElementStateErrorWithMessage:@"Activate the runner touch recorder first" traceback:nil]);
  if (!FBMirrorTouchProbe.shared.window || ![FBMirrorTouchProbe.shared.snapshot[@"visible"] boolValue] || FBMirrorTouchProbe.shared.active.count)
    return FBResponseWithStatus([FBCommandStatus invalidElementStateErrorWithMessage:@"Show an idle touch recorder first" traceback:nil]);
  UIInterfaceOrientation orientation;
  NSError *error = nil;
  if (!FBMirrorReadOrientation(&orientation, &error)) return FBResponseWithUnknownError(error);
  if (orientation != UIInterfaceOrientationPortrait)
    return FBResponseWithStatus([FBCommandStatus invalidElementStateErrorWithMessage:@"Experiment requires portrait" traceback:nil]);
  XCUIScreen *screen = [FBScreen currentScreenWithError:&error];
  if (!screen || screen.scale <= 0) return FBResponseWithUnknownError(error);
  CGSize size = FBMirrorOrientedSize(CGSizeMake(screen.bounds.size.width/screen.scale, screen.bounds.size.height/screen.scale), orientation);
  CGPoint point = CGPointMake(size.width*.5, size.height*.5);
  __block volatile atomic_bool complete = false;
  __block NSTimeInterval callbackAt = 0;
  __block NSError *playbackError = nil;
  NSTimeInterval started = NSProcessInfo.processInfo.systemUptime;
  NSUInteger count = 0;
  id<FBDelayInlinePlayer> localPlayer = nil;
  if ([mode isEqual:@"daemon"]) {
    XCPointerEventPath *path = [[XCPointerEventPath alloc] initForTouchAtPoint:point offset:0];
    [path liftUpAtOffset:durationMs.doubleValue/1000];
    XCSynthesizedEventRecord *event = [[XCSynthesizedEventRecord alloc] initWithName:@"delay-experiment" displayID:screen.displayID interfaceOrientation:orientation];
    [event addPointerEventPath:path];
    [XCTRunnerDaemonSession.sharedSession.daemonProxy _XCT_synthesizeEvent:event implicitConfirmationInterval:confirmationMs.doubleValue/1000 completion:^(NSError *innerError) {
      playbackError = innerError;
      callbackAt = NSProcessInfo.processInfo.systemUptime;
      atomic_store_explicit(&complete, true, memory_order_release);
    }];
  } else {
    if (!dlopen("/System/Library/PrivateFrameworks/Recap.framework/Recap", RTLD_LAZY))
      return FBResponseWithStatus([FBCommandStatus unsupportedOperationErrorWithMessage:@"Recap unavailable" traceback:nil]);
    Class<FBDelayStream> streamClass = NSClassFromString(@"RCPSyntheticEventStream");
    Class<FBDelayStream> senderClass = NSClassFromString(@"RCPEventSenderProperties");
    Class playerClass = NSClassFromString(@"RCPInlinePlayer");
    Class optionsClass = NSClassFromString(@"RCPPlayerPlaybackOptions");
    localPlayer = [playerClass new];
    if (![streamClass respondsToSelector:@selector(eventStreamWithEventActions:)]
        || ![localPlayer respondsToSelector:@selector(setIgnoresCompletionDelay:)]
        || ![localPlayer respondsToSelector:@selector(setNeedsInitialDelay:)]
        || ![localPlayer respondsToSelector:@selector(playEventStream:options:completion:)])
      return FBResponseWithStatus([FBCommandStatus unsupportedOperationErrorWithMessage:@"Recap player selectors unavailable" traceback:nil]);
    id<FBDelayStream> stream = [streamClass eventStreamWithEventActions:^(id<FBDelayComposer> composer) {
      if ([mode isEqual:@"empty"]) return;
      [composer composeWithSender:[senderClass touchScreenDigitizerSender] actionBlock:^(id<FBDelayComposer> touch) {
        [touch setGsScreenPointSize:size];
        [touch touchDown:point];
        [touch advanceTime:durationMs.doubleValue/1000];
        [touch liftUp:point];
      }];
    }];
    count = stream.events.count;
    [localPlayer setNeedsInitialDelay:NO];
    [localPlayer setIgnoresCompletionDelay:ignoreDelay.boolValue];
    if (![mode isEqual:@"empty"]) {
      id<FBDelayPlayer> player = [localPlayer underlyingPlayer];
      if (![player respondsToSelector:@selector(prewarmForEventStream:withError:)]
          || ![player prewarmForEventStream:stream withError:&error])
        return FBResponseWithStatus([FBCommandStatus unsupportedOperationErrorWithMessage:error.localizedDescription ?: @"Local event delivery cannot prewarm" traceback:nil]);
    }
    started = NSProcessInfo.processInfo.systemUptime;
    [localPlayer playEventStream:stream options:[optionsClass new] completion:^{
      callbackAt = NSProcessInfo.processInfo.systemUptime;
      atomic_store_explicit(&complete, true, memory_order_release);
    }];
  }
  BOOL replied = [[[[[FBRunLoopSpinner new] interval:0.001] timeout:3] timeoutErrorMessage:@"Experiment completion unknown"]
                 spinUntilTrue:^BOOL { return atomic_load_explicit(&complete, memory_order_acquire); } error:&error];
  NSTimeInterval elapsed = (NSProcessInfo.processInfo.systemUptime-started)*1000;
  if (localPlayer) [localPlayer tearDown];
  if (!replied || playbackError) return FBResponseWithUnknownError(playbackError ?: error);
  return FBResponseWithObject(@{@"callbackCompleted":@YES, @"mode":mode, @"durationMs":durationMs,
    @"confirmationMs":confirmationMs, @"ignoreDelay":ignoreDelay, @"eventCount":@(count), @"elapsedMs":@(elapsed),
    @"startedUptime":@(started), @"callbackUptime":@(callbackAt),
    @"deliveryVerified":@NO, @"probe":FBMirrorTouchProbe.shared.snapshot,
    @"note":@"Callback only; compare UIKit recorder before claiming delivery"});
}
