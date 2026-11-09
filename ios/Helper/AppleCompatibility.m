#import "AppleCompatibility.h"
#import <UIKit/UIKit.h>
#import <dlfcn.h>
#import <libxml/parser.h>
#import <libxml/xpath.h>
#import <notify.h>
#import <stdatomic.h>

// Minimal ABI declarations for selectors checked immediately before use.
@protocol IPAppleRuntime <NSObject>
+ (id)sharedClient;
+ (id)sharedSession;
- (id)accessibilityInterface;
- (id)applicationProcessTracker;
+ (NSArray *)standardAttributeNames;
+ (NSArray *)axAttributesForElementSnapshotKeyPaths:(NSArray *)keys isMacOS:(BOOL)isMacOS;
- (id)requestSnapshotForElement:(id)element
                     attributes:(NSArray *)attributes
                     parameters:(NSDictionary *)parameters
                          error:(NSError **)error;
- (NSArray *)activeApplications;
- (int)processIdentifier;
- (unsigned long long)elementID;
- (XCUIElement *)_elementMatchingAccessibilityElementOfSnapshot:(id)snapshot;
- (id)initWithUniformTypeIdentifier:(NSString *)uti compressionQuality:(double)quality;
- (NSInteger)displayID;
- (id)screenDataSource;
- (id)initWithScreenID:(NSInteger)screenID rect:(CGRect)rect encoding:(id)encoding;
- (void)requestScreenshotWithRequest:(id)request withReply:(void (^)(id, NSError *))reply;
- (XCUIApplication *)monitoredApplicationWithProcessIdentifier:(int)pid;
- (NSInteger)interfaceOrientation;
- (unsigned int)currentInteractionOptions;
- (void)setCurrentInteractionOptions:(unsigned int)options;
- (id)daemonProxy;
- (id)accessibilityElement;
- (void)_XCT_performAccessibilityAction:(unsigned int)action
                            onElement:(id)element
                            withValue:(id)value
                                reply:(void (^)(NSError *))reply;
- (void)_XCT_synthesizeEvent:(id)event
    implicitConfirmationInterval:(double)interval
                      completion:(void (^)(NSError *))completion;
- (id)initWithName:(NSString *)name interfaceOrientation:(NSInteger)orientation;
- (id)initForTouchAtPoint:(CGPoint)point offset:(double)offset;
- (id)initForEventStream:(NSData *)stream frame:(CGRect)frame speed:(double)speed;
- (void)moveToPoint:(CGPoint)point atOffset:(double)offset;
- (void)liftUpAtOffset:(double)offset;
- (void)addPointerEventPath:(id)path;
+ (id)eventStreamWithEventActions:(void (^)(id))block;
+ (id)touchScreenDigitizerSender;
- (void)composeWithSender:(id)sender actionBlock:(void (^)(id))block;
- (void)beginButtonPressWithPage:(NSUInteger)page usage:(NSUInteger)usage;
- (void)endButtonPressWithPage:(NSUInteger)page usage:(NSUInteger)usage;
- (void)pressButtonsWithPages:(NSArray *)pages usages:(NSArray *)usages duration:(double)duration;
- (NSData *)dataRepresentation;
@end

static atomic_int lockValue = -1;
static int lockToken = NOTIFY_TOKEN_INVALID;
static NSError *IPFailure(NSString *message) {
    return [NSError errorWithDomain:@"iPortal.Apple"
                               code:1
                           userInfo:@{NSLocalizedDescriptionKey : message}];
}
static void IPRequire(id object, SEL selector) {
    if (![object respondsToSelector:selector])
        @throw [NSException
            exceptionWithName:@"UnsupportedAppleAPI"
                       reason:[NSString stringWithFormat:@"Apple API unavailable: %@",
                                                         NSStringFromSelector(selector)]
                     userInfo:nil];
}
static id<IPAppleRuntime> IPRuntime(NSString *name) { return (id)NSClassFromString(name); }
static id<IPAppleRuntime> IPClient(void) {
    id device = XCUIDevice.sharedDevice;
    if ([device respondsToSelector:@selector(accessibilityInterface)])
        return [device accessibilityInterface];
    id cls = IPRuntime(@"XCAXClient_iOS");
    IPRequire(cls, @selector(sharedClient));
    return [cls sharedClient];
}
static id<IPAppleRuntime> IPDaemon(void) {
    id cls = IPRuntime(@"XCTRunnerDaemonSession");
    IPRequire(cls, @selector(sharedSession));
    id session = [cls sharedSession];
    IPRequire(session, @selector(daemonProxy));
    id daemon = [session daemonProxy];
    IPRequire(daemon, @selector(_XCT_synthesizeEvent:implicitConfirmationInterval:completion:));
    return daemon;
}
static void IPTypeKeyboardCharacters(id daemon, id keyboard, NSString *text,
                                     NSUInteger index, void (^completion)(NSError *)) {
    if (index == text.length) { completion(nil); return; }
    // This action accepts one Latin-1 character, not a whole committed string.
    // Keep one command owner and the original keyboard target throughout the
    // sequence. Never retry a character after an uncertain callback outcome.
    [daemon _XCT_performAccessibilityAction:0xa2d onElement:keyboard
                                 withValue:[text substringWithRange:NSMakeRange(index, 1)]
                                     reply:^(NSError *error) {
        if (error) { completion(error); return; }
        dispatch_async(dispatch_get_main_queue(), ^{
            IPTypeKeyboardCharacters(daemon, keyboard, text, index + 1, completion);
        });
    }];
}
static BOOL IPSupportsSecureText(NSString *text) {
    // Apple's software-key action silently ignores characters without a native
    // key mapping. Keep the tested alphabet explicit; never partially dispatch
    // a password or normalize it into different characters.
    static NSCharacterSet *supported;
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        NSMutableCharacterSet *characters = [NSMutableCharacterSet characterSetWithRange:NSMakeRange(32, 95)];
        [characters addCharactersInRange:NSMakeRange(0xC0, 0xD7 - 0xC0)];
        [characters addCharactersInRange:NSMakeRange(0xD8, 0xF7 - 0xD8)];
        [characters addCharactersInRange:NSMakeRange(0xF8, 0x100 - 0xF8)];
        [characters addCharactersInString:@"¡¢£¥§«°»¿"];
        supported = [characters copy];
    });
    return [text rangeOfCharacterFromSet:supported.invertedSet].location == NSNotFound;
}
static void IPSend(id record, void (^completion)(NSError *)) {
    // Ownership remains with the caller until Apple's callback, including after a
    // transport timeout. There is no synchronous run-loop spinner or replay.
    [IPDaemon() _XCT_synthesizeEvent:record
        implicitConfirmationInterval:0.05
                          completion:completion];
}
static id IPRecord(NSInteger orientation) {
    id cls = IPRuntime(@"XCSynthesizedEventRecord");
    IPRequire([cls alloc], @selector(initWithName:interfaceOrientation:));
    id record = [[cls alloc] initWithName:@"iPortal" interfaceOrientation:orientation];
    IPRequire(record, @selector(addPointerEventPath:));
    return record;
}
static id IPStream(void (^actions)(id<IPAppleRuntime>)) {
    static dispatch_once_t once;
    dispatch_once(&once, ^{
      dlopen("/System/Library/PrivateFrameworks/Recap.framework/Recap", RTLD_LAZY);
    });
    id cls = IPRuntime(@"RCPSyntheticEventStream"), sender = IPRuntime(@"RCPEventSenderProperties");
    IPRequire(cls, @selector(eventStreamWithEventActions:));
    IPRequire(sender, @selector(touchScreenDigitizerSender));
    id properties = [sender touchScreenDigitizerSender];
    __block BOOL composed = NO;
    id stream = [cls eventStreamWithEventActions:^(id composer) {
      IPRequire(composer, @selector(composeWithSender:actionBlock:));
      [composer composeWithSender:properties
                      actionBlock:^(id scoped) {
                        actions(scoped);
                        composed = YES;
                      }];
    }];
    IPRequire(stream, @selector(dataRepresentation));
    NSData *data = [stream dataRepresentation];
    if (!composed || !data.length)
        @throw [NSException exceptionWithName:@"UnsupportedAppleAPI"
                                       reason:@"Input stream unavailable"
                                     userInfo:nil];
    id clsPath = IPRuntime(@"XCPointerEventPath");
    IPRequire([clsPath alloc], @selector(initForEventStream:frame:speed:));
    id record = IPRecord(UIInterfaceOrientationPortrait);
    [record addPointerEventPath:[[clsPath alloc] initForEventStream:data
                                                              frame:CGRectMake(0, 0, 1, 1)
                                                              speed:1]];
    return record;
}

@implementation IPApple
+ (BOOL)activate:(XCUIApplication *)app error:(NSError **)error {
    return [self protect:^id {
        // Foreground confirmation is required; waiting for all animations to
        // stop is not. The status orb deliberately animates continuously.
        IPRequire(app, @selector(currentInteractionOptions));
        IPRequire(app, @selector(setCurrentInteractionOptions:));
        id runtime = app;
        unsigned int previous = [runtime currentInteractionOptions];
        @try {
            [runtime setCurrentInteractionOptions:previous | 3u]; // skip pre/post idle waits
            [app activate];
        } @finally {
            [runtime setCurrentInteractionOptions:previous];
        }
        return @YES;
    } error:error] != nil;
}
+ (id)protect:(id (^)(void))block error:(NSError **)error {
    @try {
        return block();
    } @catch (NSException *exception) {
        if (error)
            *error =
                [NSError errorWithDomain:@"iPortal.Apple"
                                    code:[exception.name isEqual:@"UnsupportedAppleAPI"] ? 2 : 3
                                userInfo:@{
                                    NSLocalizedDescriptionKey :
                                            [exception.name isEqual:@"UnsupportedAppleAPI"]
                                        ? exception.reason
                                        : @"Apple automation operation failed"
                                }];
        return nil;
    }
}
+ (XCUIApplication *)foreground:(NSError **)error {
    return [self
        protect:^id {
          id client = IPClient();
          IPRequire(client, @selector(activeApplications));
          IPRequire(client, @selector(applicationProcessTracker));
          id tracker = [client applicationProcessTracker];
          IPRequire(tracker, @selector(monitoredApplicationWithProcessIdentifier:));
          NSArray *applications = [client activeApplications];
          XCUIApplication *springboard = nil;
          for (id element in applications) {
              IPRequire(element, @selector(processIdentifier));
              int pid = [element processIdentifier];
              if (pid <= 0)
                  continue;
              XCUIApplication *app = [tracker monitoredApplicationWithProcessIdentifier:pid];
              if (!app)
                  continue;
              NSString *bundle = [app valueForKey:@"bundleID"];
              if ([bundle isEqual:@"com.apple.springboard"])
                  springboard = app;
              else if (app.state == XCUIApplicationStateRunningForeground)
                  return app;
          }
          if (!springboard)
              @throw [NSException exceptionWithName:@"AutomationUnavailable"
                                             reason:@"No foreground application"
                                           userInfo:nil];
          return springboard;
        }
          error:error];
}
+ (NSDictionary *)applicationInfo:(XCUIApplication *)app {
    NSMutableDictionary *info = [[self applicationIdentity:app] mutableCopy];
    @try { info[@"name"] = app.label ?: @""; } @catch (NSException *e) { info[@"name"] = @""; }
    return info;
}
+ (NSDictionary *)applicationIdentity:(XCUIApplication *)app {
    @try {
        return @{
            @"bundleId" : [app valueForKey:@"bundleID"] ?: @"",
            @"pid" : [app valueForKey:@"processID"] ?: @0
        };
    } @catch (NSException *e) {
        return @{};
    }
}
+ (NSString *)bundleIdentifier:(XCUIApplication *)app {
    @try {
        return [app valueForKey:@"bundleID"] ?: @"";
    } @catch (NSException *exception) {
        return @"";
    }
}
+ (CGSize)screenSize:(NSError **)error {
    NSValue *value = [self
        protect:^id {
          id screen = XCUIScreen.mainScreen;
          IPRequire(screen, NSSelectorFromString(@"bounds"));
          IPRequire(screen, NSSelectorFromString(@"scale"));
          CGRect bounds = [[screen valueForKey:@"bounds"] CGRectValue];
          double scale = [[screen valueForKey:@"scale"] doubleValue];
          if (scale <= 0 || CGRectIsEmpty(bounds))
              @throw [NSException exceptionWithName:@"UnsupportedAppleAPI"
                                             reason:@"Screen geometry unavailable"
                                           userInfo:nil];
          return [NSValue
              valueWithCGSize:CGSizeMake(bounds.size.width / scale, bounds.size.height / scale)];
        }
          error:error];
    return value ? value.CGSizeValue : CGSizeZero;
}
+ (NSInteger)orientation:(XCUIApplication *)app {
    @try {
        IPRequire(app, @selector(interfaceOrientation));
        return [(id)app interfaceOrientation];
    } @catch (NSException *e) {
        return 0;
    }
}
+ (NSNumber *)locked {
    int value = atomic_load(&lockValue);
    return value < 0 ? nil : @(value != 0);
}
+ (void)startLockObserver:(void (^)(NSNumber *))changed {
    [self stopLockObserver];
    void (^read)(void) = ^{
      uint64_t value;
      if (notify_get_state(lockToken, &value) == NOTIFY_STATUS_OK)
          atomic_store(&lockValue, value != 0);
      else
          atomic_store(&lockValue, -1);
      changed(self.locked);
    };
    if (notify_register_dispatch("com.apple.springboard.lockstate", &lockToken,
                                 dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0),
                                 ^(int token) {
                                   read();
                                 }) == NOTIFY_STATUS_OK)
        read();
}
+ (void)stopLockObserver {
    if (lockToken != NOTIFY_TOKEN_INVALID)
        notify_cancel(lockToken);
    lockToken = NOTIFY_TOKEN_INVALID;
    atomic_store(&lockValue, -1);
}
+ (NSDictionary *)capabilities {
    // Probe construction and selectors without dispatching any event. Availability
    // is separate from authorization, lock state, and transport readiness.
    BOOL touch = [self
                     protect:^id {
                       IPDaemon();
                       IPRecord(UIInterfaceOrientationPortrait);
                       id cls = IPRuntime(@"XCPointerEventPath");
                       IPRequire([cls alloc], @selector(initForTouchAtPoint:offset:));
                       id path = [[cls alloc] initForTouchAtPoint:CGPointZero offset:0];
                       IPRequire(path, @selector(moveToPoint:atOffset:));
                       IPRequire(path, @selector(liftUpAtOffset:));
                       IPRequire(XCUIScreen.mainScreen, NSSelectorFromString(@"bounds"));
                       IPRequire(XCUIScreen.mainScreen, NSSelectorFromString(@"scale"));
                       return @YES;
                     }
                       error:nil] != nil;
    BOOL keyboard =
        touch &&
        [self
            protect:^id {
              IPRequire(IPDaemon(), @selector(_XCT_performAccessibilityAction:onElement:withValue:reply:));
              id snapshot = NSClassFromString(@"XCElementSnapshot");
              if (![snapshot instancesRespondToSelector:NSSelectorFromString(@"hasKeyboardFocus")] ||
                  ![snapshot instancesRespondToSelector:@selector(accessibilityElement)]) return nil;
              return IPStream(^(id<IPAppleRuntime> scoped) {
                IPRequire(scoped, @selector(beginButtonPressWithPage:usage:));
                IPRequire(scoped, @selector(endButtonPressWithPage:usage:));
                IPRequire(scoped, @selector(pressButtonsWithPages:usages:duration:));
                [scoped pressButtonsWithPages:@[ @7 ] usages:@[ @4 ] duration:.01];
              });
            }
              error:nil] != nil;
    BOOL inspection =
        [self
            protect:^id {
              IPRequire(IPClient(),
                        @selector(requestSnapshotForElement:attributes:parameters:error:));
              IPRequire(XCUIElement.class, @selector(standardAttributeNames));
              IPRequire(NSClassFromString(@"XCElementSnapshot"),
                        @selector(axAttributesForElementSnapshotKeyPaths:isMacOS:));
              if (![XCUIElementQuery instancesRespondToSelector:@selector(_elementMatchingAccessibilityElementOfSnapshot:)] ||
                  ![NSClassFromString(@"XCElementSnapshot") instancesRespondToSelector:NSSelectorFromString(@"accessibilityElement")]) return nil;
              return dlsym(RTLD_DEFAULT, "XC_kAXXCAttributeIsVisible") &&
                             dlsym(RTLD_DEFAULT, "XC_kAXXCAttributeIsElement") &&
                             dlsym(RTLD_DEFAULT, "XCAXAccessibilityAttributesForStringAttributes")
                         ? @YES
                         : nil;
            }
              error:nil] != nil;
    BOOL clipboard = [XCUIApplication instancesRespondToSelector:@selector(currentInteractionOptions)] &&
                     [XCUIApplication instancesRespondToSelector:@selector(setCurrentInteractionOptions:)];
    return @{
        @"touch" : @(touch),
        @"multiTouch" : @(touch),
        @"keyboard" : @(keyboard),
        @"inspection" : @(inspection),
        @"clipboard" : @(clipboard),
        @"video" : @YES
    };
}
+ (void)captureJPEGWithQuality:(double)quality scale:(double)scale
                   completion:(void (^)(NSData *))completion {
    static dispatch_queue_t encoding;
    static dispatch_once_t once;
    dispatch_once(&once, ^{ encoding = dispatch_queue_create("iPortal.video", DISPATCH_QUEUE_SERIAL); });
    void (^encode)(id) = ^(id screenshot) {
        dispatch_async(encoding, ^{
            @autoreleasepool {
                NSData *result = [self protect:^id {
                    UIImage *image = nil;
                    if ([screenshot respondsToSelector:@selector(image)]) image = [screenshot valueForKey:@"image"];
                    else if ([screenshot respondsToSelector:NSSelectorFromString(@"platformImage")]) image = [screenshot valueForKey:@"platformImage"];
                    if (![image isKindOfClass:UIImage.class]) return nil;
                    // UIImage.size is measured in points. Quality presets scale
                    // captured pixels, including Retina images supplied by XCTest.
                    CGSize size = CGSizeMake(MAX(1, image.size.width * image.scale * scale),
                                             MAX(1, image.size.height * image.scale * scale));
                    UIGraphicsImageRendererFormat *format = [UIGraphicsImageRendererFormat defaultFormat];
                    format.scale = 1; format.opaque = YES;
                    UIGraphicsImageRenderer *renderer = [[UIGraphicsImageRenderer alloc] initWithSize:size format:format];
                    return [renderer JPEGDataWithCompressionQuality:quality actions:^(UIGraphicsImageRendererContext *context) {
                        [image drawInRect:(CGRect){CGPointZero, size}];
                    }];
                } error:nil];
                completion(result);
            }
        });
    };
    NSError *error = nil;
    [self protect:^id {
        id screen = XCUIScreen.mainScreen;
        id encodingClass = IPRuntime(@"XCTImageEncoding");
        id requestClass = IPRuntime(@"XCTScreenshotRequest");
        id source = [screen respondsToSelector:@selector(screenDataSource)] ? [screen screenDataSource] : nil;
        if ([screen respondsToSelector:@selector(displayID)] &&
            [source respondsToSelector:@selector(requestScreenshotWithRequest:withReply:)] &&
            [[encodingClass alloc] respondsToSelector:@selector(initWithUniformTypeIdentifier:compressionQuality:)] &&
            [[requestClass alloc] respondsToSelector:@selector(initWithScreenID:rect:encoding:)]) {
            id preferred = [[encodingClass alloc] initWithUniformTypeIdentifier:@"public.jpeg" compressionQuality:quality];
            id request = [[requestClass alloc] initWithScreenID:[screen displayID] rect:CGRectNull encoding:preferred];
            // Await Apple's image callback directly. The synchronous screenshot
            // wrapper spins a future, adding delay to every fallback frame.
            [source requestScreenshotWithRequest:request withReply:^(id image, NSError *failure) {
                encode(failure ? nil : image);
            }];
        } else {
            // Select the older-OS path before dispatch; never replay a failed or
            // timed-out capture through a second Apple API.
            dispatch_async(encoding, ^{
                id screenshot = [self protect:^id { return XCUIScreen.mainScreen.screenshot; } error:nil];
                encode(screenshot);
            });
        }
        return @YES;
    } error:&error];
    if (error) completion(nil);
}
+ (void)touch:(NSArray *)fingers
            end:(double)end
           size:(CGSize)size
    orientation:(NSInteger)orientation
     completion:(void (^)(NSError *))completion {
    NSError *error;
    [self
        protect:^id {
          id record = IPRecord(orientation), cls = IPRuntime(@"XCPointerEventPath");
          CGPoint (^point)(NSArray *) = ^CGPoint(NSArray *p) {
            double x = [p[0] doubleValue] * (size.width - 1),
                   y = [p[1] doubleValue] * (size.height - 1);
            switch (orientation) {
            case 2:
                return CGPointMake(size.width - x, size.height - y);
            case 3:
                return CGPointMake(size.height - y, x);
            case 4:
                return CGPointMake(y, size.width - x);
            default:
                return CGPointMake(x, y);
            }
          };
          IPRequire([cls alloc], @selector(initForTouchAtPoint:offset:));
          for (NSArray *finger in fingers) {
              id path = [[cls alloc] initForTouchAtPoint:point(finger[0]) offset:0];
              IPRequire(path, @selector(moveToPoint:atOffset:));
              IPRequire(path, @selector(liftUpAtOffset:));
              for (NSUInteger i = 1; i < finger.count; i++)
                  [path moveToPoint:point(finger[i]) atOffset:[finger[i][2] doubleValue] / 1000];
              [path liftUpAtOffset:MAX(.04, end / 1000)];
              [record addPointerEventPath:path];
          }
          IPSend(record, completion);
          return @YES;
        }
          error:&error];
    if (error)
        completion(error);
}
+ (void)keyboard:(NSString *)text
             key:(BOOL)isKey
       modifiers:(NSArray<NSString *> *)modifiers
      completion:(void (^)(NSError *))completion {
    [self keyboard:text key:isKey modifiers:modifiers element:nil completion:completion];
}
+ (NSNumber *)keyboardFocused:(XCUIElement *)element error:(NSError **)error {
    return [self protect:^id {
        IPRequire(element, NSSelectorFromString(@"hasKeyboardFocus"));
        return [element valueForKey:@"hasKeyboardFocus"];
    } error:error];
}
+ (void)keyboard:(NSString *)text key:(BOOL)isKey modifiers:(NSArray<NSString *> *)modifiers
         element:(XCUIElement *)expectedElement completion:(void (^)(NSError *))completion {
    NSError *error;
    [self
        protect:^id {
          // Targeted editing must never follow focus into another editor. Check
          // inside the compatibility boundary immediately before dispatch, for
          // both the selection chord and insertion/deletion. No fallback/replay.
          if (expectedElement) {
              IPRequire(expectedElement, NSSelectorFromString(@"hasKeyboardFocus"));
              if (![[expectedElement valueForKey:@"hasKeyboardFocus"] boolValue]) {
                  completion(IPFailure(@"Target editor no longer has keyboard focus"));
                  return @YES;
              }
          }
          NSDictionary *keys = @{
              @"ArrowLeft" : @80,
              @"ArrowRight" : @79,
              @"ArrowUp" : @82,
              @"ArrowDown" : @81,
              @"Backspace" : @42,
              @"Delete" : @76,
              @"Enter" : @40,
              @"Tab" : @43,
              @"Escape" : @41,
              @"Home" : @74,
              @"End" : @77,
              @"PageUp" : @75,
              @"PageDown" : @78
          };
          NSDictionary *mods =
              @{@"control" : @224,
                @"shift" : @225,
                @"option" : @226,
                @"command" : @227};
          NSNumber *usage = isKey ? keys[text] : nil;
          if (isKey && modifiers.count && !usage)
              usage = @(4 + [text characterAtIndex:0] - 'a');
          if (!usage && !modifiers.count) {
              // Recap Unicode events register a transient hardware keyboard on
              // iOS 27, hiding the software keyboard on every character. Insert
              // into the existing focused editor through Apple's AX action;
              // never activate, tap, replace its full value, or use clipboard.
              id daemon = IPDaemon();
              IPRequire(daemon, @selector(_XCT_performAccessibilityAction:onElement:withValue:reply:));
              NSError *foregroundError;
              XCUIApplication *app = [self foreground:&foregroundError];
              if (!app) {
                  completion(foregroundError ?: IPFailure(@"Foreground application unavailable"));
                  return @YES;
              }
              XCUIElement *focused = [[app descendantsMatchingType:XCUIElementTypeAny]
                  matchingPredicate:[NSPredicate predicateWithFormat:@"hasKeyboardFocus == YES"]].firstMatch;
              NSError *snapshotError;
              id snapshot = [focused snapshotWithError:&snapshotError];
              if (!snapshot) { completion(snapshotError ?: IPFailure(@"No focused text editor")); return @YES; }
              IPRequire(snapshot, @selector(accessibilityElement));
              id target = [snapshot accessibilityElement];
              BOOL secure = [snapshot elementType] == XCUIElementTypeSecureTextField;
              if (secure) {
                  // WebKit implements its own text-input accessibility action,
                  // including password fields. Classify before dispatch; an
                  // ignored action is not permission to retry another path.
                  XCUIElement *webFocused = [[app.webViews descendantsMatchingType:XCUIElementTypeSecureTextField]
                      matchingPredicate:[NSPredicate predicateWithFormat:@"hasKeyboardFocus == YES"]].firstMatch;
                  if (webFocused.exists) {
                      id webSnapshot = [webFocused snapshotWithError:&snapshotError];
                      if (!webSnapshot) { completion(snapshotError ?: IPFailure(@"Focused web editor unavailable")); return @YES; }
                      IPRequire(webSnapshot, @selector(accessibilityElement));
                      if ([target isEqual:[webSnapshot accessibilityElement]]) secure = NO;
                  }
              }
              // Secure editors ignore plain AX insertion. Address the software
              // keyboard's native text action instead. Reject characters with
              // no verified native key mapping before any dispatch.
              // The alternatives/dictation action accepts Unicode but corrupts
              // subsequent secure-field editing, so it is not a safe fallback.
              if (secure) {
                  if (!IPSupportsSecureText(text))
                      @throw [NSException exceptionWithName:@"UnsupportedAppleAPI"
                                                    reason:@"This password text contains unsupported characters"
                                                  userInfo:nil];
                  id keyboardSnapshot = [app.keyboards.firstMatch snapshotWithError:&snapshotError];
                  if (!keyboardSnapshot) { completion(snapshotError ?: IPFailure(@"Software keyboard unavailable")); return @YES; }
                  IPRequire(keyboardSnapshot, @selector(accessibilityElement));
                  IPTypeKeyboardCharacters(daemon, [keyboardSnapshot accessibilityElement], text, 0, completion);
                  return @YES;
              }
              [daemon _XCT_performAccessibilityAction:0x808
                                           onElement:target
                                           withValue:text
                                               reply:completion];
              return @YES;
          }
          id record = IPStream(^(id<IPAppleRuntime> scoped) {
            IPRequire(scoped, @selector(beginButtonPressWithPage:usage:));
            IPRequire(scoped, @selector(endButtonPressWithPage:usage:));
            IPRequire(scoped, @selector(pressButtonsWithPages:usages:duration:));
            for (NSString *m in modifiers)
                [scoped beginButtonPressWithPage:7 usage:[mods[m] unsignedIntegerValue]];
            [scoped pressButtonsWithPages:@[ @7 ] usages:@[ usage ] duration:.01];
            for (NSString *m in modifiers.reverseObjectEnumerator)
                [scoped endButtonPressWithPage:7 usage:[mods[m] unsignedIntegerValue]];
          });
          IPSend(record, completion);
          return @YES;
        }
          error:&error];
    if (error)
        completion(error);
}
+ (void)consumer:(NSUInteger)usage
        duration:(double)duration
      completion:(void (^)(NSError *))completion {
    NSError *error;
    [self
        protect:^id {
          id record = IPStream(^(id<IPAppleRuntime> scoped) {
            IPRequire(scoped, @selector(pressButtonsWithPages:usages:duration:));
            [scoped pressButtonsWithPages:@[ @12 ] usages:@[ @(usage) ] duration:duration];
          });
          IPSend(record, completion);
          return @YES;
        }
          error:&error];
    if (error)
        completion(error);
}
+ (NSDictionary *)snapshotExtras:(id)snapshot {
    NSMutableDictionary *result = [NSMutableDictionary new];
    @try {
        result[@"focused"] = [snapshot valueForKey:@"hasKeyboardFocus"] ?: @NO;
    } @catch (NSException *e) {
        @try { result[@"focused"] = [snapshot valueForKey:@"hasFocus"] ?: @NO; }
        @catch (NSException *ignored) { }
    } @
    try {
        result[@"customActions"] = [snapshot valueForKey:@"customActions"] ?: NSNull.null;
    } @catch (NSException *e) {
    } @
    try {
        uint64_t traits = [[snapshot valueForKey:@"traits"] unsignedLongLongValue];
        NSArray *values = @[
            @(UIAccessibilityTraitButton), @(UIAccessibilityTraitLink),
            @(UIAccessibilityTraitImage), @(UIAccessibilityTraitSelected),
            @(UIAccessibilityTraitPlaysSound), @(UIAccessibilityTraitKeyboardKey),
            @(UIAccessibilityTraitStaticText), @(UIAccessibilityTraitSummaryElement),
            @(UIAccessibilityTraitNotEnabled), @(UIAccessibilityTraitUpdatesFrequently),
            @(UIAccessibilityTraitSearchField), @(UIAccessibilityTraitStartsMediaSession),
            @(UIAccessibilityTraitAdjustable), @(UIAccessibilityTraitAllowsDirectInteraction),
            @(UIAccessibilityTraitCausesPageTurn), @(UIAccessibilityTraitHeader),
            @(UIAccessibilityTraitTabBar)
        ];
        NSArray *names = @[
            @"Button", @"Link", @"Image", @"Selected", @"PlaysSound", @"KeyboardKey", @"StaticText",
            @"SummaryElement", @"NotEnabled", @"UpdatesFrequently", @"SearchField",
            @"StartsMediaSession", @"Adjustable", @"AllowsDirectInteraction", @"CausesPageTurn",
            @"Header", @"TabBar"
        ];
        NSMutableArray *matched = [NSMutableArray new];
        for (NSUInteger i = 0; i < values.count; i++)
            if (traits & [values[i] unsignedLongLongValue])
                [matched addObject:names[i]];
        result[@"traits"] = [matched componentsJoinedByString:@", "];
    } @catch (NSException *e) {
    }
    return result;
}
static NSNumber *IPSnapshotAttribute(NSString *name) {
    const char *symbol =
        [name isEqual:@"isVisible"] ? "XC_kAXXCAttributeIsVisible" : "XC_kAXXCAttributeIsElement";
    NSString *__unsafe_unretained *value =
        (NSString * __unsafe_unretained *)dlsym(RTLD_DEFAULT, symbol);
    NSArray *(*convert)(NSArray *) =
        dlsym(RTLD_DEFAULT, "XCAXAccessibilityAttributesForStringAttributes");
    if (!value || !*value || !convert)
        return nil;
    return [convert(@[ *value ]) firstObject];
}
+ (id<XCUIElementSnapshot>)snapshotAttributes:(id<XCUIElementSnapshot>)snapshot
                                        error:(NSError **)error {
    return [self
        protect:^id {
          id cls = NSClassFromString(@"XCElementSnapshot");
          IPRequire(XCUIElement.class, @selector(standardAttributeNames));
          IPRequire(cls, @selector(axAttributesForElementSnapshotKeyPaths:isMacOS:));
          NSMutableArray *keys = [[(id)XCUIElement.class standardAttributeNames] mutableCopy];
          // snapshotExtras reads these on every node. XCTest lazily faults
          // missing snapshot properties back into the phone; a large hierarchy
          // can otherwise perform hundreds of synchronous AX round trips.
          // Request the supported properties in the existing bulk snapshot.
          for (NSString *key in @[ @"traits", @"hasKeyboardFocus", @"hasFocus", @"customActions" ]) {
              if ([cls instancesRespondToSelector:NSSelectorFromString(key)] && ![keys containsObject:key])
                  [keys addObject:key];
          }
          id standard = [cls axAttributesForElementSnapshotKeyPaths:keys isMacOS:NO];
          NSMutableArray *attributes = [NSMutableArray new];
          for (id attribute in standard)
              [attributes addObject:attribute];
          NSNumber *visible = IPSnapshotAttribute(@"isVisible"),
                   *element = IPSnapshotAttribute(@"isAccessibilityElement");
          if (!visible || !element)
              @throw [NSException exceptionWithName:@"UnsupportedAppleAPI"
                                             reason:@"Accessibility flags unavailable"
                                           userInfo:nil];
          if ([attributes.firstObject isKindOfClass:NSString.class]) {
              NSString *__unsafe_unretained *v = (NSString * __unsafe_unretained *)dlsym(
                  RTLD_DEFAULT, "XC_kAXXCAttributeIsVisible");
              NSString *__unsafe_unretained *e = (NSString * __unsafe_unretained *)dlsym(
                  RTLD_DEFAULT, "XC_kAXXCAttributeIsElement");
              [attributes addObject:*v];
              [attributes addObject:*e];
          } else {
              [attributes addObject:visible];
              [attributes addObject:element];
          }
          id client = IPClient();
          IPRequire(client, @selector(requestSnapshotForElement:attributes:parameters:error:));
          NSError *failure = nil;
          id result =
              [client requestSnapshotForElement:[(id)snapshot valueForKey:@"accessibilityElement"]
                                     attributes:attributes
                                     parameters:@{
                                         @"maxDepth" : @50
                                     }
                                          error:&failure];

          if (!result)
              @throw [NSException exceptionWithName:@"SnapshotUnavailable"
                                             reason:failure.localizedDescription
                                           userInfo:nil];
          // Newer XCTest runtimes return a request-result wrapper; older releases
          // return the snapshot itself. Inspect the capability, not an OS version.
          if ([result respondsToSelector:NSSelectorFromString(@"rootElementSnapshot")])
              result = [result valueForKey:@"rootElementSnapshot"];
          IPRequire(result, @selector(frame));
          IPRequire(result, @selector(children));
          return result;
        }
          error:error];
}
+ (id<XCUIElementSnapshot>)snapshotElement:(XCUIElement *)element
                                   flags:(BOOL)flags error:(NSError **)error {
    return [self protect:^id {
        // The executor owns the caller's deadline and bounded stall recovery.
        // Do not impose a second, global AX timeout: it overrides longer caller
        // budgets and can reject a healthy snapshot during app transitions.
        NSError *failure = nil;
        id<XCUIElementSnapshot> basic = [element snapshotWithError:&failure];
        if (!basic) {
            if (error) *error = failure ?: IPFailure(@"Snapshot unavailable");
            return nil;
        }
        return flags ? [self snapshotAttributes:basic error:error] : basic;
    } error:error];
}
+ (NSNumber *)snapshotFlag:(id)snapshot name:(NSString *)name {
    if (![@[ @"isVisible", @"isAccessibilityElement" ] containsObject:name])
        return nil;
    @try {
        NSNumber *attribute = IPSnapshotAttribute(name);
        id attrs = [snapshot valueForKey:@"additionalAttributes"];
        id value = attribute ? attrs[attribute] : nil;
        return [value isKindOfClass:NSNumber.class] ? value : nil;
    } @catch (NSException *e) {
        return nil;
    }
}
+ (NSString *)snapshotIdentity:(id<XCUIElementSnapshot>)snapshot error:(NSError **)error {
    return [self protect:^id {
        id element = [(id)snapshot valueForKey:@"accessibilityElement"];
        IPRequire(element, @selector(processIdentifier));
        IPRequire(element, @selector(elementID));
        // Some virtual accessibility nodes report elementID zero. Apple's
        // equality hash also identifies their backing token/remote element.
        return [NSString stringWithFormat:@"%d:%llu:%lu", [element processIdentifier],
                [element elementID], (unsigned long)[element hash]];
    } error:error];
}
+ (XCUIElement *)elementForSnapshot:(id<XCUIElementSnapshot>)snapshot
    application:(XCUIApplication *)app error:(NSError **)error {
    return [self protect:^id {
        if (snapshot.elementType == XCUIElementTypeApplication) return app;
        id query = [app descendantsMatchingType:XCUIElementTypeAny];
        IPRequire(query, @selector(_elementMatchingAccessibilityElementOfSnapshot:));
        return [query _elementMatchingAccessibilityElementOfSnapshot:snapshot];
    } error:error];
}
+ (NSNumber *)predicate:(NSString *)predicate
                matches:(NSDictionary *)attributes
                  error:(NSError **)error {
    NSNumber *result = [self
        protect:^id {
          return @([[NSPredicate predicateWithFormat:predicate] evaluateWithObject:attributes]);
        }
          error:error];
    return result;
}
+ (NSArray<NSString *> *)xpath:(NSString *)expression xml:(NSString *)xml error:(NSError **)error {
    // XML is generated from our normalized snapshot, never supplied by a client.
    // No DTD, entity expansion, extension functions or network document loading.
    if (expression.length > 8192 || xml.length > 32 * 1024 * 1024 ||
        [xml containsString:@"<!DOCTYPE"] || [xml containsString:@"<!ENTITY"]) {
        if (error)
            *error = IPFailure(@"XML input exceeds selector limits");
        return nil;
    }
    NSData *data = [xml dataUsingEncoding:NSUTF8StringEncoding];
    xmlDocPtr doc = xmlReadMemory(data.bytes, (int)data.length, "snapshot.xml", NULL,
                                  XML_PARSE_NONET | XML_PARSE_NOERROR | XML_PARSE_NOWARNING);
    if (!doc) {
        if (error)
            *error = IPFailure(@"Invalid snapshot XML");
        return nil;
    }
    xmlXPathContextPtr context = xmlXPathNewContext(doc);
    xmlXPathObjectPtr result =
        context ? xmlXPathEvalExpression((const xmlChar *)expression.UTF8String, context) : NULL;
    NSMutableArray *ids = [NSMutableArray new];
    if (result && result->type == XPATH_NODESET) {
        xmlNodeSetPtr nodes = result->nodesetval;
        for (int i = 0; nodes && i < nodes->nodeNr; i++) {
            xmlNodePtr node = nodes->nodeTab[i];
            if (node->type != XML_ELEMENT_NODE)
                continue;
            xmlChar *value = xmlGetProp(node, (const xmlChar *)"iportalId");
            if (value) {
                [ids addObject:[NSString stringWithUTF8String:(const char *)value]];
                xmlFree(value);
            }
        }
    } else if (error)
        *error = IPFailure(@"XPath must select elements");
    if (result)
        xmlXPathFreeObject(result);
    if (context)
        xmlXPathFreeContext(context);
    xmlFreeDoc(doc);
    return error && *error ? nil : ids;
}
@end
