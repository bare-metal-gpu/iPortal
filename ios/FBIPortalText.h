// Use the touch sender for Unicode and HID key chords. XCTest's default
// keyboard sender registers a temporary hardware keyboard, making iOS hide and
// reopen the software keyboard on each text request. No focus/app switching,
// persistent key-down state, clipboard, or keyboard preference changes needed.
#import <stdatomic.h>
#import <dlfcn.h>
#import "XCSynthesizedEventRecord.h"
#import "XCPointerEventPath.h"
#import "XCTRunnerDaemonSession.h"
#import "FBRunLoopSpinner.h"
#import "XCUIDevice+FBHelpers.h"
#import "FBCommandHandler.h"
#import "FBRoute.h"
#import "FBRouteRequest.h"
#import "FBResponsePayload.h"
#import "FBCommandStatus.h"

@protocol FBIPortalTextComposer <NSObject>
- (void)composeWithSender:(id)sender actionBlock:(void (^)(id))block;
- (void)beginButtonPressWithPage:(NSUInteger)page usage:(NSUInteger)usage;
- (void)endButtonPressWithPage:(NSUInteger)page usage:(NSUInteger)usage;
- (void)pressButtonsWithPages:(NSArray *)pages usages:(NSArray *)usages duration:(double)duration;
- (void)sendUnicodeStringByCharacters:(NSArray *)characters durationBetweenEvents:(double)duration;
@end
@protocol FBIPortalTextStream <NSObject>
+ (id)eventStreamWithEventActions:(void (^)(id<FBIPortalTextComposer>))block;
- (NSData *)dataRepresentation;
@end
@protocol FBIPortalTextSender <NSObject>
+ (id)touchScreenDigitizerSender;
@end

static NSDictionary *FBIPortalKeyboardUsages(void) {
  return @{@"ArrowLeft":@80, @"ArrowRight":@79, @"ArrowUp":@82, @"ArrowDown":@81,
    @"Backspace":@42, @"Delete":@76, @"Enter":@40, @"Tab":@43, @"Escape":@41,
    @"Home":@74, @"End":@77, @"PageUp":@75, @"PageDown":@78};
}
static NSDictionary *FBIPortalModifierUsages(void) {
  return @{@"control":@224, @"shift":@225, @"option":@226, @"command":@227};
}
static BOOL FBIPortalValidKeyboard(NSDictionary *args, BOOL isKey) {
  if (![args isKindOfClass:NSDictionary.class]) return NO;
  NSString *text = args[isKey ? @"key" : @"text"];
  if (![text isKindOfClass:NSString.class] || text.length > (isKey ? 64 : 10000)) return NO;
  if (!isKey) return args.count == 1;
  NSArray *modifiers = args[@"modifiers"];
  if (args.count != 2 || ![modifiers isKindOfClass:NSArray.class] || modifiers.count > 4) return NO;
  NSMutableSet *seen = [NSMutableSet new];
  for (id modifier in modifiers) {
    if (![modifier isKindOfClass:NSString.class] || !FBIPortalModifierUsages()[modifier] || [seen containsObject:modifier]) return NO;
    [seen addObject:modifier];
  }
  if (FBIPortalKeyboardUsages()[text]) return YES;
  // Modified printable input is a key chord, not text. Limit to the letters
  // forwarded by the Mac editing shortcuts; never silently drop modifiers.
  if (modifiers.count) return text.length == 1 && [text characterAtIndex:0] >= 'a' && [text characterAtIndex:0] <= 'z';
  if (!text.length || [text characterAtIndex:0] < 32 || [text characterAtIndex:0] == 127) return NO;
  NSUInteger codepoints = [text lengthOfBytesUsingEncoding:NSUTF32LittleEndianStringEncoding] / 4;
  return codepoints == 1;
}

@interface FBIPortalTextCommands : NSObject <FBCommandHandler>
@end
@implementation FBIPortalTextCommands
+ (NSArray *)routes {
  return @[[[FBRoute POST:@"/wda/mirror/text"].withoutSession respondWithTarget:self action:@selector(type:)],
    [[FBRoute POST:@"/wda/mirror/key"].withoutSession respondWithTarget:self action:@selector(key:)]];
}
+ (id<FBResponsePayload>)type:(FBRouteRequest *)request { return [self input:request isKey:NO]; }
+ (id<FBResponsePayload>)key:(FBRouteRequest *)request { return [self input:request isKey:YES]; }
+ (id<FBResponsePayload>)input:(FBRouteRequest *)request isKey:(BOOL)isKey {
  if (!FBIPortalValidKeyboard(request.arguments, isKey))
    return FBResponseWithStatus([FBCommandStatus invalidArgumentErrorWithMessage:@"Invalid keyboard input" traceback:nil]);
  NSString *text = request.arguments[isKey ? @"key" : @"text"];
  NSArray *modifiers = isKey ? request.arguments[@"modifiers"] : @[];
  if (XCUIDevice.sharedDevice.fb_isScreenLocked)
    return FBResponseWithStatus([FBCommandStatus invalidElementStateErrorWithMessage:@"Device is locked" traceback:nil]);
  if (!text.length) return FBResponseWithOK();
  static void *recap;
  static dispatch_once_t once;
  dispatch_once(&once, ^{ recap = dlopen("/System/Library/PrivateFrameworks/Recap.framework/Recap", RTLD_LAZY); });
  Class<FBIPortalTextStream> streamClass = NSClassFromString(@"RCPSyntheticEventStream");
  Class<FBIPortalTextSender> senderClass = NSClassFromString(@"RCPEventSenderProperties");
  if (!recap || ![streamClass respondsToSelector:@selector(eventStreamWithEventActions:)]
      || ![senderClass respondsToSelector:@selector(touchScreenDigitizerSender)])
    return FBResponseWithStatus([FBCommandStatus unsupportedOperationErrorWithMessage:@"Keyboard playback unavailable on this runtime" traceback:nil]);
  NSMutableArray *characters = [NSMutableArray new];
  [text enumerateSubstringsInRange:NSMakeRange(0, text.length) options:NSStringEnumerationByComposedCharacterSequences
    usingBlock:^(NSString *substring, NSRange r, NSRange e, BOOL *stop) { [characters addObject:substring]; }];
  NSNumber *usage = isKey ? FBIPortalKeyboardUsages()[text] : nil;
  if (isKey && modifiers.count && !usage) usage = @(4 + [text characterAtIndex:0] - 'a');
  __block BOOL composed = NO;
  id<FBIPortalTextStream> stream = [streamClass eventStreamWithEventActions:^(id<FBIPortalTextComposer> composer) {
    if (![composer respondsToSelector:@selector(composeWithSender:actionBlock:)]) return;
    [composer composeWithSender:[senderClass touchScreenDigitizerSender] actionBlock:^(id<FBIPortalTextComposer> scoped) {
      if (![scoped respondsToSelector:@selector(sendUnicodeStringByCharacters:durationBetweenEvents:)]
          || ![scoped respondsToSelector:@selector(beginButtonPressWithPage:usage:)]
          || ![scoped respondsToSelector:@selector(endButtonPressWithPage:usage:)]
          || ![scoped respondsToSelector:@selector(pressButtonsWithPages:usages:duration:)]) return;
      for (NSString *modifier in modifiers) [scoped beginButtonPressWithPage:7 usage:[FBIPortalModifierUsages()[modifier] unsignedIntegerValue]];
      if (usage) [scoped pressButtonsWithPages:@[@7] usages:@[usage] duration:0.01];
      else [scoped sendUnicodeStringByCharacters:characters durationBetweenEvents:0];
      for (NSString *modifier in modifiers.reverseObjectEnumerator) [scoped endButtonPressWithPage:7 usage:[FBIPortalModifierUsages()[modifier] unsignedIntegerValue]];
      composed = YES;
    }];
  }];
  NSData *data = [stream respondsToSelector:@selector(dataRepresentation)] ? stream.dataRepresentation : nil;
  if (!composed || !data.length)
    return FBResponseWithStatus([FBCommandStatus unsupportedOperationErrorWithMessage:@"Keyboard playback unavailable on this runtime" traceback:nil]);
  XCSynthesizedEventRecord *record = [[XCSynthesizedEventRecord alloc] initWithName:@"mirror-keyboard" interfaceOrientation:UIInterfaceOrientationPortrait];
  [record addPointerEventPath:[[XCPointerEventPath alloc] initForEventStream:data frame:CGRectMake(0,0,1,1) speed:1]];
  if (XCUIDevice.sharedDevice.fb_isScreenLocked)
    return FBResponseWithStatus([FBCommandStatus invalidElementStateErrorWithMessage:@"Device is locked" traceback:nil]);
  __block volatile atomic_bool done = false;
  __block NSError *failure = nil;
  [XCTRunnerDaemonSession.sharedSession.daemonProxy _XCT_synthesizeEvent:record implicitConfirmationInterval:0.05 completion:^(NSError *error) {
    failure = error;
    atomic_store_explicit(&done, true, memory_order_release);
  }];
  NSError *error = nil;
  BOOL replied = [[[[[FBRunLoopSpinner new] interval:0.01] timeout:6] timeoutErrorMessage:@"Keyboard input outcome unknown"]
    spinUntilTrue:^BOOL{ return atomic_load_explicit(&done, memory_order_acquire); } error:&error];
  if (!replied || failure) return FBResponseWithUnknownError(failure ?: error);
  return FBResponseWithOK();
}
@end
