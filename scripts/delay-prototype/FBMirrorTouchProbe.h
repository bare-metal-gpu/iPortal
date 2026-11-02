// Development-only touch recorder. Include once in a WDA command implementation.
#import <UIKit/UIKit.h>

@interface FBMirrorTouchProbe : UIView
@property(nonatomic,strong) NSMutableArray<NSDictionary *> *events;
@property(nonatomic,strong) NSMutableSet<NSString *> *active;
@property(nonatomic,strong) UILabel *label;
@property(nonatomic,strong) NSMutableArray<NSValue *> *trail;
+ (instancetype)shared;
+ (NSDictionary *)show;
+ (NSDictionary *)hide;
- (void)holdIdleTimer;
- (void)releaseIdleTimer;
- (void)becameActive;
- (NSDictionary *)snapshot;
- (void)reset;
@end
static UIWindow *FBMirrorProbeWindow;
static BOOL FBMirrorProbeOwnsIdleTimer;
static BOOL FBMirrorProbePriorIdleTimer;
@implementation FBMirrorTouchProbe
+ (instancetype)shared {
  static FBMirrorTouchProbe *probe;
  static dispatch_once_t once;
  dispatch_once(&once, ^{ probe = [[self alloc] initWithFrame:CGRectZero]; });
  return probe;
}
- (instancetype)initWithFrame:(CGRect)frame {
  if ((self = [super initWithFrame:frame])) {
    self.backgroundColor = [UIColor colorWithRed:0.04 green:0.10 blue:0.16 alpha:1];
    self.multipleTouchEnabled = YES;
    self.accessibilityIdentifier = @"MirrorTouchProbe";
    self.events = [NSMutableArray new]; self.active = [NSMutableSet new]; self.trail = [NSMutableArray new];
    self.label = [[UILabel alloc] initWithFrame:CGRectZero];
    self.label.textColor = UIColor.whiteColor; self.label.numberOfLines = 0;
    self.label.textAlignment = NSTextAlignmentCenter; self.label.font = [UIFont monospacedSystemFontOfSize:18 weight:UIFontWeightMedium];
    self.label.userInteractionEnabled = NO;
    [self addSubview:self.label]; [self reset];
    [NSNotificationCenter.defaultCenter addObserver:self selector:@selector(releaseIdleTimer) name:UIApplicationDidEnterBackgroundNotification object:nil];
    [NSNotificationCenter.defaultCenter addObserver:self selector:@selector(becameActive) name:UIApplicationDidBecomeActiveNotification object:nil];
  } return self;
}
+ (NSDictionary *)show {
  FBMirrorTouchProbe *probe = self.shared;
  if (!FBMirrorProbeWindow) {
    UIWindowScene *scene = nil;
    for (UIScene *candidate in UIApplication.sharedApplication.connectedScenes) {
      if ([candidate isKindOfClass:UIWindowScene.class]) { scene = (UIWindowScene *)candidate; break; }
    }
    FBMirrorProbeWindow = scene ? [[UIWindow alloc] initWithWindowScene:scene] : [[UIWindow alloc] initWithFrame:UIScreen.mainScreen.bounds];
    UIViewController *controller = [UIViewController new];
    controller.view = probe;
    FBMirrorProbeWindow.rootViewController = controller;
    FBMirrorProbeWindow.windowLevel = UIWindowLevelNormal + 1;
  }
  [FBMirrorProbeWindow makeKeyAndVisible];
  [probe becameActive];
  [probe setNeedsLayout]; [probe layoutIfNeeded];
  return probe.snapshot;
}
// This is a foreground application assertion, not a persistent Auto-Lock setting.
- (void)holdIdleTimer {
  if(!FBMirrorProbeOwnsIdleTimer) {
    FBMirrorProbePriorIdleTimer=UIApplication.sharedApplication.idleTimerDisabled;
    FBMirrorProbeOwnsIdleTimer=YES;
  }
  UIApplication.sharedApplication.idleTimerDisabled=YES;
}
- (void)releaseIdleTimer {
  if(!FBMirrorProbeOwnsIdleTimer)return;
  UIApplication.sharedApplication.idleTimerDisabled=FBMirrorProbePriorIdleTimer;
  FBMirrorProbeOwnsIdleTimer=NO;
}
- (void)becameActive {
  if(FBMirrorProbeWindow && !FBMirrorProbeWindow.hidden && UIApplication.sharedApplication.applicationState==UIApplicationStateActive) [self holdIdleTimer];
}
+ (NSDictionary *)hide {
  [self.shared releaseIdleTimer];
  FBMirrorProbeWindow.hidden=YES;
  return [self.shared snapshot];
}
- (void)dealloc {
  [NSNotificationCenter.defaultCenter removeObserver:self];
  [self releaseIdleTimer];
}
- (void)layoutSubviews {
  [super layoutSubviews];
  self.label.frame = CGRectMake(12, 25, MAX(0,self.bounds.size.width-24), 120);
}
- (void)reset {
  [self.events removeAllObjects]; [self.active removeAllObjects]; [self.trail removeAllObjects];
  self.label.text = @"TOUCH PROBE\nNo active contact"; [self setNeedsDisplay];
}
- (void)record:(NSSet<UITouch *> *)touches phase:(NSString *)phase {
  for (UITouch *touch in touches) {
    NSString *identity = [NSString stringWithFormat:@"%p", touch];
    CGPoint point = [touch locationInView:self];
    if ([phase isEqual:@"began"]) [self.active addObject:identity];
    if ([phase isEqual:@"ended"] || [phase isEqual:@"cancelled"]) [self.active removeObject:identity];
    [self.events addObject:@{@"phase":phase,@"id":identity,@"x":@(point.x),@"y":@(point.y),@"timestamp":@(touch.timestamp),@"receivedUptime":@(NSProcessInfo.processInfo.systemUptime),@"activeCount":@(self.active.count)}];
    [self.trail addObject:[NSValue valueWithCGPoint:point]];
  }
  if (self.events.count > 2048) [self.events removeObjectsInRange:NSMakeRange(0,self.events.count-2048)];
  self.label.text = [NSString stringWithFormat:@"TOUCH PROBE\n%@ · active %lu\n%lu events",phase,(unsigned long)self.active.count,(unsigned long)self.events.count];
  [self setNeedsDisplay];
}
- (void)touchesBegan:(NSSet<UITouch *> *)touches withEvent:(UIEvent *)event { [self record:touches phase:@"began"]; }
- (void)touchesMoved:(NSSet<UITouch *> *)touches withEvent:(UIEvent *)event { [self record:touches phase:@"moved"]; }
- (void)touchesEnded:(NSSet<UITouch *> *)touches withEvent:(UIEvent *)event { [self record:touches phase:@"ended"]; }
- (void)touchesCancelled:(NSSet<UITouch *> *)touches withEvent:(UIEvent *)event { [self record:touches phase:@"cancelled"]; }
- (void)drawRect:(CGRect)rect {
  UIBezierPath *path = [UIBezierPath bezierPath]; path.lineWidth = 5;
  for (NSUInteger i=0;i<self.trail.count;i++) { CGPoint p=self.trail[i].CGPointValue; if(i) [path addLineToPoint:p]; else [path moveToPoint:p]; }
  [[UIColor colorWithRed:0.1 green:0.85 blue:0.75 alpha:1] setStroke]; [path stroke];
}
- (NSDictionary *)snapshot {
  return @{@"bundleId":NSBundle.mainBundle.bundleIdentifier ?: @"",@"applicationState":@(UIApplication.sharedApplication.applicationState),
    @"idleTimerHeld":@(FBMirrorProbeOwnsIdleTimer),@"idleTimerDisabled":@(UIApplication.sharedApplication.idleTimerDisabled),@"visible":@(self.window && !self.window.hidden),@"width":@(self.bounds.size.width),@"height":@(self.bounds.size.height),@"activeCount":@(self.active.count),@"events":[self.events copy]};
}
@end
