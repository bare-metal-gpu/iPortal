// Development-only UIKit recorder. Installed explicitly, never by normal setup.
#import <UIKit/UIKit.h>

static BOOL FBMirrorBenchmarkEnabled(void) {
  return [NSProcessInfo.processInfo.environment[@"MIRROR_BENCHMARK"] isEqual:@"1"];
}

@interface FBMirrorBenchmarkView : UIView
@property(nonatomic,strong) NSMutableArray<NSDictionary *> *events;
@property(nonatomic,strong) NSMutableSet<NSValue *> *active;
@property(nonatomic,assign) NSUInteger sequence;
+ (instancetype)shared;
- (NSDictionary *)snapshot;
@end
static UIWindow *FBMirrorBenchmarkWindow;
static BOOL FBMirrorBenchmarkOwnsIdleTimer;
static BOOL FBMirrorBenchmarkPreviousIdleTimer;

@implementation FBMirrorBenchmarkView
+ (instancetype)shared {
  static FBMirrorBenchmarkView *view;
  static dispatch_once_t once;
  dispatch_once(&once, ^{ view = [[self alloc] initWithFrame:CGRectZero]; });
  return view;
}
- (instancetype)initWithFrame:(CGRect)frame {
  if ((self = [super initWithFrame:frame])) {
    self.backgroundColor = UIColor.blackColor;
    self.multipleTouchEnabled = YES;
    self.accessibilityIdentifier = @"MirrorBenchmark";
    self.events = [NSMutableArray new]; self.active = [NSMutableSet new];
    [NSNotificationCenter.defaultCenter addObserver:self selector:@selector(releaseIdleTimer) name:UIApplicationDidEnterBackgroundNotification object:nil];
    [NSNotificationCenter.defaultCenter addObserver:self selector:@selector(holdIdleTimer) name:UIApplicationDidBecomeActiveNotification object:nil];
  }
  return self;
}
- (void)holdIdleTimer {
  if (!FBMirrorBenchmarkWindow || FBMirrorBenchmarkWindow.hidden || UIApplication.sharedApplication.applicationState != UIApplicationStateActive) return;
  if (!FBMirrorBenchmarkOwnsIdleTimer) {
    FBMirrorBenchmarkPreviousIdleTimer = UIApplication.sharedApplication.idleTimerDisabled;
    FBMirrorBenchmarkOwnsIdleTimer = YES;
  }
  UIApplication.sharedApplication.idleTimerDisabled = YES;
}
- (void)releaseIdleTimer {
  if (!FBMirrorBenchmarkOwnsIdleTimer) return;
  UIApplication.sharedApplication.idleTimerDisabled = FBMirrorBenchmarkPreviousIdleTimer;
  FBMirrorBenchmarkOwnsIdleTimer = NO;
}
- (void)record:(NSSet<UITouch *> *)touches phase:(NSString *)phase {
  // One sequence per gesture, including a two-finger pinch.
  if ([phase isEqual:@"began"] && !self.active.count) self.sequence++;
  for (UITouch *touch in touches) {
    NSValue *identity = [NSValue valueWithNonretainedObject:touch];
    if ([phase isEqual:@"began"]) [self.active addObject:identity];
    if ([phase isEqual:@"ended"] || [phase isEqual:@"cancelled"]) [self.active removeObject:identity];
    [self.events addObject:@{@"phase":phase, @"sequence":@(self.sequence),
      @"eventUptime":@(touch.timestamp), @"receivedUptime":@(NSProcessInfo.processInfo.systemUptime),
      @"activeCount":@(self.active.count)}];
  }
  if (self.events.count > 2048) [self.events removeObjectsInRange:NSMakeRange(0, self.events.count-2048)];
  [self setNeedsDisplay];
}
- (void)touchesBegan:(NSSet<UITouch *> *)touches withEvent:(UIEvent *)event { [self record:touches phase:@"began"]; }
- (void)touchesMoved:(NSSet<UITouch *> *)touches withEvent:(UIEvent *)event { [self record:touches phase:@"moved"]; }
- (void)touchesEnded:(NSSet<UITouch *> *)touches withEvent:(UIEvent *)event { [self record:touches phase:@"ended"]; }
- (void)touchesCancelled:(NSSet<UITouch *> *)touches withEvent:(UIEvent *)event { [self record:touches phase:@"cancelled"]; }
- (void)drawRect:(CGRect)rect {
  CGFloat w = self.bounds.size.width, h = self.bounds.size.height;
  for (NSUInteger i=0; i<10; i++) {
    UIColor *color = i == 0 ? UIColor.whiteColor : i == 1 ? UIColor.greenColor
      : (self.sequence & (1 << (i-2))) ? UIColor.cyanColor : UIColor.redColor;
    [color setFill];
    UIRectFill(CGRectMake(w*(0.1+i*0.08), h*0.32, w*0.08, h*0.10));
  }
  NSString *text = [NSString stringWithFormat:@"Latency benchmark\nGesture %lu · active %lu\nTap anywhere", (unsigned long)self.sequence, (unsigned long)self.active.count];
  [text drawInRect:CGRectMake(24,h*0.55,w-48,150) withAttributes:@{
    NSForegroundColorAttributeName:UIColor.whiteColor,
    NSFontAttributeName:[UIFont monospacedSystemFontOfSize:18 weight:UIFontWeightRegular]}];
}
- (NSDictionary *)snapshot {
  return @{@"bundleId":NSBundle.mainBundle.bundleIdentifier ?: @"", @"sequence":@(self.sequence),
    @"visible":@(self.window && !self.window.hidden), @"activeCount":@(self.active.count),
    @"idleTimerHeld":@(FBMirrorBenchmarkOwnsIdleTimer), @"events":[self.events copy]};
}
@end

static id<FBResponsePayload> FBMirrorBenchmarkRun(NSDictionary *arguments) {
  if (!FBMirrorBenchmarkEnabled()) return FBResponseWithStatus([FBCommandStatus unsupportedOperationErrorWithMessage:@"Benchmark disabled" traceback:nil]);
  NSString *mode = arguments[@"mode"];
  if (arguments.count != 1 || ![@[@"show",@"hide",@"state"] containsObject:mode])
    return FBResponseWithStatus([FBCommandStatus invalidArgumentErrorWithMessage:@"Expected only mode: show, hide, or state" traceback:nil]);
  FBMirrorBenchmarkView *view = FBMirrorBenchmarkView.shared;
  if ([mode isEqual:@"show"]) {
    if (XCUIDevice.sharedDevice.fb_isScreenLocked) return FBResponseWithStatus([FBCommandStatus invalidElementStateErrorWithMessage:@"Unlock the phone first" traceback:nil]);
    if (!FBMirrorBenchmarkWindow) {
      UIWindowScene *scene = nil;
      for (UIScene *candidate in UIApplication.sharedApplication.connectedScenes)
        if ([candidate isKindOfClass:UIWindowScene.class]) { scene = (UIWindowScene *)candidate; break; }
      FBMirrorBenchmarkWindow = scene ? [[UIWindow alloc] initWithWindowScene:scene] : [[UIWindow alloc] initWithFrame:UIScreen.mainScreen.bounds];
      UIViewController *controller = [UIViewController new]; controller.view = view;
      FBMirrorBenchmarkWindow.rootViewController = controller;
      FBMirrorBenchmarkWindow.windowLevel = UIWindowLevelNormal + 1;
    }
    [FBMirrorBenchmarkWindow makeKeyAndVisible]; [view holdIdleTimer];
  } else if ([mode isEqual:@"hide"]) {
    if (view.active.count) return FBResponseWithStatus([FBCommandStatus invalidElementStateErrorWithMessage:@"Cannot hide active contacts" traceback:nil]);
    [view releaseIdleTimer]; FBMirrorBenchmarkWindow.hidden = YES;
  }
  return FBResponseWithObject(view.snapshot);
}

static NSDictionary *FBMirrorBenchmarkTiming(NSTimeInterval dispatched, NSTimeInterval callback) {
  if (!FBMirrorBenchmarkEnabled()) return @{};
  NSDictionary *began = nil, *ended = nil;
  for (NSDictionary *event in FBMirrorBenchmarkView.shared.events) {
    if ([event[@"receivedUptime"] doubleValue] < dispatched) continue;
    if (!began && [event[@"phase"] isEqual:@"began"]) began = event;
    if ([event[@"phase"] isEqual:@"ended"]) ended = event;
  }
  if (!began || !ended || FBMirrorBenchmarkView.shared.active.count) return @{@"deliveryVerified":@NO};
  return @{@"deliveryVerified":@YES, @"sequence":began[@"sequence"],
    @"invokeToTouchMs":@(([began[@"receivedUptime"] doubleValue]-dispatched)*1000),
    @"touchMs":@(([ended[@"eventUptime"] doubleValue]-[began[@"eventUptime"] doubleValue])*1000),
    @"endToCallbackMs":@((callback-[ended[@"receivedUptime"] doubleValue])*1000)};
}
