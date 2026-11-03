// Explicit developer experiment. No production route or gesture path changes.
#import <UIKit/UIKit.h>
#import <objc/runtime.h>

static BOOL FMIEnabled(void) {
  return [NSProcessInfo.processInfo.environment[@"MIRROR_INDIRECT_EXPERIMENT"] isEqual:@"1"];
}
static BOOL FMIInFlight, FMIOutcomeUnknown;
static UIWindow *FMIWindow;
static BOOL FMIOwnsIdle, FMIPriorIdle;

@protocol FMIRecap <NSObject>
+ (id)eventStreamWithEventActions:(void (^)(id<FMIRecap>))block;
+ (id)trackpadSender;
+ (id)mouseSender;
+ (id)touchScreenDigitizerSender;
- (void)composeWithSender:(id)sender actionBlock:(void (^)(id<FMIRecap>))block;
- (void)setGsScreenPointSize:(CGSize)size;
- (void)setGsScreenScaleFactor:(double)scale;
- (void)pointerSetAbsolutePosition:(CGPoint)point;
- (void)pointerPhasedScroll:(CGPoint)delta duration:(double)duration frequency:(long long)frequency;
- (void)pointerDiscreteScroll:(CGPoint)delta duration:(double)duration frequency:(long long)frequency;
- (void)pointerScale:(double)scale duration:(double)duration frequency:(long long)frequency;
- (void)advanceTime:(double)duration;
- (void)touchDown:(CGPoint)point;
- (void)moveToPoint:(CGPoint)point duration:(double)duration;
- (void)liftUp:(CGPoint)point;
- (NSData *)dataRepresentation;
- (NSArray *)events;
@end

@interface FMIView : UIView <UIScrollViewDelegate>
@property(nonatomic,strong) UIScrollView *scroll;
@property(nonatomic,strong) UIView *canvas;
@property(nonatomic,strong) UILabel *label;
@property(nonatomic,strong) NSMutableArray<NSDictionary *> *events;
@property(nonatomic,strong) NSMutableArray<NSDictionary *> *frames;
@property(nonatomic,strong) CADisplayLink *displayLink;
@property(nonatomic) BOOL recording;
+ (instancetype)shared;
- (void)reset;
- (NSDictionary *)snapshot;
- (void)releaseIdle;
@end

@implementation FMIView
+ (instancetype)shared {
  static FMIView *view; static dispatch_once_t once;
  dispatch_once(&once, ^{ view = [[self alloc] initWithFrame:CGRectZero]; });
  return view;
}
- (instancetype)initWithFrame:(CGRect)frame {
  if ((self = [super initWithFrame:frame])) {
    self.backgroundColor = UIColor.blackColor;
    self.events = [NSMutableArray new]; self.frames = [NSMutableArray new];
    self.accessibilityIdentifier = @"MirrorIndirectProbe";
    self.scroll = [UIScrollView new]; self.scroll.delegate = self;
    self.scroll.minimumZoomScale = 0.5; self.scroll.maximumZoomScale = 3;
    self.scroll.contentInsetAdjustmentBehavior = UIScrollViewContentInsetAdjustmentNever;
    self.scroll.panGestureRecognizer.allowedScrollTypesMask = UIScrollTypeMaskAll;
    self.scroll.decelerationRate = UIScrollViewDecelerationRateFast;
    self.scroll.bounces = NO;
    [self.scroll.panGestureRecognizer addTarget:self action:@selector(pan:)];
    [self.scroll.pinchGestureRecognizer addTarget:self action:@selector(pinch:)];
    [self.scroll addGestureRecognizer:[[UIHoverGestureRecognizer alloc] initWithTarget:self action:@selector(hover:)]];
    self.canvas = [[UIView alloc] initWithFrame:CGRectMake(0,0,800,2400)];
    for (NSUInteger i=0; i<24; i++) {
      UILabel *row = [[UILabel alloc] initWithFrame:CGRectMake(0,i*100,800,100)];
      row.text = [NSString stringWithFormat:@"  Row %02lu — scroll / pinch probe",(unsigned long)i];
      row.font = [UIFont monospacedSystemFontOfSize:24 weight:UIFontWeightSemibold];
      row.textColor = UIColor.whiteColor;
      row.backgroundColor = [UIColor colorWithHue:(CGFloat)i/24 saturation:0.7 brightness:0.55 alpha:1];
      [self.canvas addSubview:row];
    }
    [self.scroll addSubview:self.canvas]; self.scroll.contentSize = self.canvas.bounds.size;
    [self addSubview:self.scroll];
    self.label = [UILabel new]; self.label.textColor = UIColor.whiteColor;
    self.label.font = [UIFont monospacedSystemFontOfSize:14 weight:UIFontWeightRegular];
    self.label.numberOfLines = 0; [self addSubview:self.label];
    [NSNotificationCenter.defaultCenter addObserver:self selector:@selector(releaseIdle) name:UIApplicationDidEnterBackgroundNotification object:nil];
    [NSNotificationCenter.defaultCenter addObserver:self selector:@selector(holdIdle) name:UIApplicationDidBecomeActiveNotification object:nil];
  }
  return self;
}
- (void)layoutSubviews {
  [super layoutSubviews];
  self.label.frame = CGRectMake(12,20,self.bounds.size.width-24,70);
  self.scroll.frame = CGRectMake(0,100,self.bounds.size.width,MAX(0,self.bounds.size.height-100));
}
- (void)holdIdle {
  if (!FMIWindow || FMIWindow.hidden || UIApplication.sharedApplication.applicationState != UIApplicationStateActive) return;
  if (!FMIOwnsIdle) { FMIPriorIdle = UIApplication.sharedApplication.idleTimerDisabled; FMIOwnsIdle = YES; }
  UIApplication.sharedApplication.idleTimerDisabled = YES;
}
- (void)releaseIdle {
  if (FMIOwnsIdle) UIApplication.sharedApplication.idleTimerDisabled = FMIPriorIdle;
  FMIOwnsIdle = NO;
}
- (void)event:(NSString *)kind values:(NSDictionary *)values {
  if (!self.recording) return;
  NSMutableDictionary *event = [values mutableCopy];
  event[@"kind"] = kind; event[@"uptime"] = @(NSProcessInfo.processInfo.systemUptime);
  event[@"offsetX"] = @(self.scroll.contentOffset.x); event[@"offsetY"] = @(self.scroll.contentOffset.y);
  event[@"zoom"] = @(self.scroll.zoomScale);
  [self.events addObject:event];
  if (self.events.count > 2048) [self.events removeObjectAtIndex:0];
  self.label.text = [NSString stringWithFormat:@"Indirect input probe\n%@ · y %.1f · zoom %.2f\n%lu events",kind,self.scroll.contentOffset.y,self.scroll.zoomScale,(unsigned long)self.events.count];
}
- (void)tick:(CADisplayLink *)link {
  if (!self.recording || self.frames.count >= 600) return;
  [self.frames addObject:@{@"uptime":@(NSProcessInfo.processInfo.systemUptime),@"displayTimestamp":@(link.timestamp),
    @"offsetX":@(self.scroll.contentOffset.x),@"offsetY":@(self.scroll.contentOffset.y),@"zoom":@(self.scroll.zoomScale)}];
}
- (void)pan:(UIPanGestureRecognizer *)gesture {
  CGPoint translation = [gesture translationInView:self.scroll];
  [self event:@"pan" values:@{@"state":@(gesture.state),@"touches":@(gesture.numberOfTouches),@"dx":@(translation.x),@"dy":@(translation.y)}];
}
- (void)pinch:(UIPinchGestureRecognizer *)gesture {
  [self event:@"pinch" values:@{@"state":@(gesture.state),@"touches":@(gesture.numberOfTouches),@"scale":@(gesture.scale)}];
}
- (void)hover:(UIHoverGestureRecognizer *)gesture {
  CGPoint point = [gesture locationInView:self];
  [self event:@"hover" values:@{@"state":@(gesture.state),@"x":@(point.x),@"y":@(point.y)}];
}
- (void)scrollViewDidScroll:(UIScrollView *)scroll { [self event:@"scroll" values:@{}]; }
- (void)scrollViewDidZoom:(UIScrollView *)scroll { [self event:@"zoom" values:@{}]; }
- (UIView *)viewForZoomingInScrollView:(UIScrollView *)scroll { return self.canvas; }
- (void)reset {
  self.recording = NO;
  self.scroll.scrollEnabled = NO;
  [self.scroll setZoomScale:1 animated:NO];
  [self.scroll setContentOffset:CGPointMake(100,800) animated:NO];
  self.scroll.scrollEnabled = YES;
  [self.events removeAllObjects]; [self.frames removeAllObjects];
  self.label.text = @"Indirect input probe\nReady at y 800 · zoom 1";
  self.recording = YES;
}
- (NSDictionary *)snapshot {
  return @{@"bundleId":NSBundle.mainBundle.bundleIdentifier ?: @"",@"visible":@(FMIWindow && !FMIWindow.hidden),
    @"foreground":@(UIApplication.sharedApplication.applicationState == UIApplicationStateActive),@"idleTimerHeld":@(FMIOwnsIdle),
    @"indirectInputEnabled":NSBundle.mainBundle.infoDictionary[@"UIApplicationSupportsIndirectInputEvents"] ?: NSNull.null,
    @"screenWidth":@(UIScreen.mainScreen.bounds.size.width),@"screenHeight":@(UIScreen.mainScreen.bounds.size.height),
    @"viewWidth":@(self.bounds.size.width),@"viewHeight":@(self.bounds.size.height),
    @"offsetX":@(self.scroll.contentOffset.x),@"offsetY":@(self.scroll.contentOffset.y),@"zoom":@(self.scroll.zoomScale),
    @"panState":@(self.scroll.panGestureRecognizer.state),@"pinchState":@(self.scroll.pinchGestureRecognizer.state),
    @"inFlight":@(FMIInFlight),@"outcomeUnknown":@(FMIOutcomeUnknown),@"events":[self.events copy],@"frames":[self.frames copy]};
}
@end

static NSArray *FMIMethods(NSString *name) {
  Class cls = NSClassFromString(name); if (!cls) return @[];
  unsigned count = 0; Method *methods = class_copyMethodList(cls, &count);
  NSMutableArray *names = [NSMutableArray new];
  for (unsigned i=0;i<count;i++) [names addObject:NSStringFromSelector(method_getName(methods[i]))];
  free(methods); return [names sortedArrayUsingSelector:@selector(compare:)];
}

static id<FBResponsePayload> FMIRun(NSDictionary *args) {
  if (!FMIEnabled()) return FBResponseWithStatus([FBCommandStatus unsupportedOperationErrorWithMessage:@"Indirect experiment disabled" traceback:nil]);
  NSString *mode = args[@"mode"];
  if (![@[@"show",@"hide",@"state",@"reset",@"runtime",@"touch",@"scroll",@"move",@"pinch-baseline",@"raw-touch",@"raw-scroll",@"raw-scale",@"raw-move"] containsObject:mode])
    return FBResponseWithStatus([FBCommandStatus invalidArgumentErrorWithMessage:@"Unknown experiment mode" traceback:nil]);
  FMIView *view = FMIView.shared;
  if ([@[@"show",@"hide",@"state",@"reset",@"runtime"] containsObject:mode]) {
    if (args.count != 1) return FBResponseWithStatus([FBCommandStatus invalidArgumentErrorWithMessage:@"Mode takes no additional arguments" traceback:nil]);
    if ([mode isEqual:@"state"]) return FBResponseWithObject(view.snapshot);
    if (FMIInFlight || FMIOutcomeUnknown) return FBResponseWithStatus([FBCommandStatus invalidElementStateErrorWithMessage:@"Experiment busy or outcome unknown; restart runner" traceback:nil]);
    if ([mode isEqual:@"runtime"]) {
      dlopen("/System/Library/PrivateFrameworks/Recap.framework/Recap",RTLD_LAZY);
      NSMutableDictionary *classes = [NSMutableDictionary new];
      for (NSString *name in @[@"XCPointerEventPath",@"RCPSyntheticEventStream",@"RCPEventComposer",@"RCPEventSenderProperties",@"RCPScrollEventStream",@"RCPTransformEventStream"])
        classes[name] = FMIMethods(name);
      NSMutableDictionary *encodings=[NSMutableDictionary new];
      for (NSString *name in @[@"pointerScale:duration:frequency:",@"pointerPhasedScroll:duration:frequency:",@"pointerSetAbsolutePosition:"]) {
        Method method=class_getInstanceMethod(NSClassFromString(@"RCPSyntheticEventStream"),NSSelectorFromString(name));
        if(method) encodings[name]=@(method_getTypeEncoding(method));
      }
      classes[@"encodings"]=encodings;
      return FBResponseWithObject(classes);
    }
    if ([mode isEqual:@"hide"]) {
      view.recording = NO; [view.displayLink invalidate]; view.displayLink = nil;
      [view releaseIdle]; FMIWindow.hidden = YES;
    } else if ([mode isEqual:@"show"]) {
      if (XCUIDevice.sharedDevice.fb_isScreenLocked) return FBResponseWithStatus([FBCommandStatus invalidElementStateErrorWithMessage:@"Unlock phone first" traceback:nil]);
      if (!FMIWindow) {
        UIWindowScene *scene = nil;
        for (UIScene *candidate in UIApplication.sharedApplication.connectedScenes)
          if ([candidate isKindOfClass:UIWindowScene.class]) { scene = (UIWindowScene *)candidate; break; }
        FMIWindow = scene ? [[UIWindow alloc] initWithWindowScene:scene] : [[UIWindow alloc] initWithFrame:UIScreen.mainScreen.bounds];
        UIViewController *controller = [UIViewController new]; controller.view = view;
        FMIWindow.rootViewController = controller; FMIWindow.windowLevel = UIWindowLevelNormal+1;
      }
      [FMIWindow makeKeyAndVisible]; [view setNeedsLayout]; [view layoutIfNeeded]; [view holdIdle];
      [view.displayLink invalidate]; view.displayLink = [CADisplayLink displayLinkWithTarget:view selector:@selector(tick:)];
      [view.displayLink addToRunLoop:NSRunLoop.mainRunLoop forMode:NSRunLoopCommonModes];
      [view reset];
    } else [view reset];
    return FBResponseWithObject(view.snapshot);
  }
  for (NSString *key in args) if (![@[@"mode",@"dx",@"dy",@"durationMs",@"units",@"confirmationMs",@"style",@"sender",@"scale"] containsObject:key])
    return FBResponseWithStatus([FBCommandStatus invalidArgumentErrorWithMessage:@"Unknown argument" traceback:nil]);
  NSNumber *dx=args[@"dx"] ?: @0, *dy=args[@"dy"] ?: @160, *ms=args[@"durationMs"] ?: @100, *confirmation=args[@"confirmationMs"] ?: @0;
  NSString *units=args[@"units"] ?: @"points", *style=args[@"style"] ?: @"phased";
  NSString *senderName=args[@"sender"] ?: @"trackpad";
  NSNumber *scale=args[@"scale"] ?: @0.25;
  if (!FBMirrorFiniteNumber(dx) || !FBMirrorFiniteNumber(dy) || fabs(dx.doubleValue)>400 || fabs(dy.doubleValue)>400
      || !FBMirrorFiniteNumber(ms) || ms.doubleValue<0 || ms.doubleValue>2000
      || !FBMirrorFiniteNumber(confirmation) || confirmation.doubleValue<0 || confirmation.doubleValue>300
      || !FBMirrorFiniteNumber(scale) || fabs(scale.doubleValue)>2
      || ![@[@"trackpad",@"mouse"] containsObject:senderName]
      || ![@[@"points",@"pixels",@"normalized",@"view"] containsObject:units] || ![@[@"phased",@"discrete"] containsObject:style])
    return FBResponseWithStatus([FBCommandStatus invalidArgumentErrorWithMessage:@"Invalid bounded input parameters" traceback:nil]);
  if (FMIInFlight || FMIOutcomeUnknown || UIApplication.sharedApplication.applicationState != UIApplicationStateActive || !FMIWindow || FMIWindow.hidden)
    return FBResponseWithStatus([FBCommandStatus invalidElementStateErrorWithMessage:@"Require idle foreground experiment recorder" traceback:nil]);
  if (XCUIDevice.sharedDevice.fb_isScreenLocked) return FBResponseWithStatus([FBCommandStatus invalidElementStateErrorWithMessage:@"Device locked" traceback:nil]);
  UIInterfaceOrientation orientation; NSError *error = nil;
  if (!FBMirrorReadOrientation(&orientation,&error)) return FBResponseWithUnknownError(error);
  if (orientation != UIInterfaceOrientationPortrait) return FBResponseWithStatus([FBCommandStatus invalidElementStateErrorWithMessage:@"Keep phone portrait" traceback:nil]);
  XCUIScreen *screen = [FBScreen currentScreenWithError:&error];
  if (!screen || screen.scale<=0) return FBResponseWithUnknownError(error);
  CGSize size = FBMirrorOrientedSize(CGSizeMake(screen.bounds.size.width/screen.scale,screen.bounds.size.height/screen.scale),orientation);
  CGPoint center = CGPointMake(size.width*0.5,size.height*0.6);
  double duration=ms.doubleValue/1000;
  XCSynthesizedEventRecord *event = [[XCSynthesizedEventRecord alloc] initWithName:@"mirror-indirect-experiment" displayID:screen.displayID interfaceOrientation:orientation];
  if ([mode isEqual:@"touch"] || [mode isEqual:@"pinch-baseline"]) {
    BOOL pinch=[mode isEqual:@"pinch-baseline"];
    for (NSUInteger i=0;i<(pinch?2:1);i++) {
      double direction=i?1:-1;
      CGPoint start=pinch?CGPointMake(center.x+direction*30,center.y):CGPointMake(center.x,center.y+60);
      CGPoint end=pinch?CGPointMake(center.x+direction*90,center.y):CGPointMake(center.x,center.y-60);
      XCPointerEventPath *path=[[XCPointerEventPath alloc] initForTouchAtPoint:start offset:0];
      [path moveToPoint:end atOffset:MAX(.04,duration)]; [path liftUpAtOffset:MAX(.06,duration+.02)]; [event addPointerEventPath:path];
    }
  } else if ([mode hasPrefix:@"raw-"]) {
    dlopen("/System/Library/PrivateFrameworks/Recap.framework/Recap",RTLD_LAZY);
    Class<FMIRecap> streamClass=(Class<FMIRecap>)NSClassFromString(@"RCPSyntheticEventStream");
    Class<FMIRecap> senderClass=(Class<FMIRecap>)NSClassFromString(@"RCPEventSenderProperties");
    BOOL touch=[mode isEqual:@"raw-touch"];
    if (![streamClass respondsToSelector:@selector(eventStreamWithEventActions:)] || ![senderClass respondsToSelector:@selector(trackpadSender)])
      return FBResponseWithStatus([FBCommandStatus unsupportedOperationErrorWithMessage:@"Raw indirect composition unavailable" traceback:nil]);
    id sender=touch?[senderClass touchScreenDigitizerSender]:[senderName isEqual:@"mouse"]?[senderClass mouseSender]:[senderClass trackpadSender];
    if ([units isEqual:@"pixels"]) center=CGPointMake(center.x*screen.scale,center.y*screen.scale);
    if ([units isEqual:@"normalized"]) center=CGPointMake(.5,.6);
    if ([units isEqual:@"view"]) center=CGPointMake(view.bounds.size.width*.5,view.bounds.size.height*.6);
    id<FMIRecap> stream=[streamClass eventStreamWithEventActions:^(id<FMIRecap> composer) {
      [composer composeWithSender:sender actionBlock:^(id<FMIRecap> scoped) {
        [scoped setGsScreenPointSize:size]; [scoped setGsScreenScaleFactor:1];
        if(touch) {
          [scoped touchDown:CGPointMake(center.x,center.y+60)];
          [scoped moveToPoint:CGPointMake(center.x,center.y-60) duration:MAX(.04,duration)];
          [scoped liftUp:CGPointMake(center.x,center.y-60)];
        } else {
          [scoped pointerSetAbsolutePosition:center]; [scoped advanceTime:.02];
          if([mode isEqual:@"raw-scroll"]) {
            if([style isEqual:@"discrete"]) [scoped pointerDiscreteScroll:CGPointMake(dx.doubleValue,dy.doubleValue) duration:MAX(.016,duration) frequency:60];
            else [scoped pointerPhasedScroll:CGPointMake(dx.doubleValue,dy.doubleValue) duration:MAX(.016,duration) frequency:60];
          } else if([mode isEqual:@"raw-scale"]) [scoped pointerScale:scale.doubleValue duration:MAX(.016,duration) frequency:60];
        }
      }];
    }];
    NSData *data=stream.dataRepresentation;
    if(!data.length || !stream.events.count) return FBResponseWithStatus([FBCommandStatus unsupportedOperationErrorWithMessage:@"No raw events composed" traceback:nil]);
    XCPointerEventPath *path=[[XCPointerEventPath alloc] initForEventStream:data frame:CGRectMake(0,0,size.width,size.height) speed:1];
    [event addPointerEventPath:path];
  } else {
    if ([units isEqual:@"pixels"]) center=CGPointMake(center.x*screen.scale,center.y*screen.scale);
    if ([units isEqual:@"normalized"]) center=CGPointMake(.5,.6);
    if ([units isEqual:@"view"]) center=CGPointMake(view.bounds.size.width*.5,view.bounds.size.height*.6);
    XCPointerEventPath *path=[[XCPointerEventPath alloc] initForMouseEventsAtLocation:center];
    [path moveMouseToPoint:center atOffset:0 duration:0.01];
    if ([mode isEqual:@"scroll"]) {
      if ([style isEqual:@"discrete"]) [path scrollAtPoint:center byLines:dy.longLongValue atOffset:0.02];
      else [path scrollWithDeltaVector:CGVectorMake(dx.doubleValue,dy.doubleValue) atOffset:0.02 duration:duration];
    }
    [event addPointerEventPath:path];
  }
  NSUInteger before=view.events.count;
  double offsetBefore=view.scroll.contentOffset.y, zoomBefore=view.scroll.zoomScale;
  NSTimeInterval invoked=NSProcessInfo.processInfo.systemUptime;
  __block NSTimeInterval callback=0;
  __block NSError *playbackError=nil;
  __block volatile atomic_bool completed=false;
  FMIInFlight=YES;
  @try {
    [XCTRunnerDaemonSession.sharedSession.daemonProxy _XCT_synthesizeEvent:event implicitConfirmationInterval:confirmation.doubleValue/1000 completion:^(NSError *innerError) {
      playbackError=innerError; callback=NSProcessInfo.processInfo.systemUptime;
      atomic_store_explicit(&completed,true,memory_order_release);
    }];
    BOOL replied=[[[[[FBRunLoopSpinner new] interval:.005] timeout:duration+4] timeoutErrorMessage:@"Indirect input outcome unknown"]
      spinUntilTrue:^BOOL{ return atomic_load_explicit(&completed,memory_order_acquire); } error:&error];
    if (!replied) FMIOutcomeUnknown=YES;
    if (!replied || playbackError) return FBResponseWithUnknownError(playbackError ?: error);
  } @catch (NSException *exception) {
    FMIOutcomeUnknown=YES;
    return FBResponseWithStatus([FBCommandStatus unknownErrorWithMessage:exception.reason traceback:nil]);
  } @finally { FMIInFlight=NO; }
  NSArray *newEvents=[view.events subarrayWithRange:NSMakeRange(MIN(before,view.events.count),view.events.count-MIN(before,view.events.count))];
  return FBResponseWithObject(@{@"completed":@YES,@"mode":mode,@"units":units,@"style":style,
    @"invokedUptime":@(invoked),@"callbackUptime":@(callback),@"nativeMs":@((callback-invoked)*1000),
    @"offsetBefore":@(offsetBefore),@"offsetAfter":@(view.scroll.contentOffset.y),@"zoomBefore":@(zoomBefore),@"zoomAfter":@(view.scroll.zoomScale),
    @"events":newEvents,@"recordDescription":event.description});
}
