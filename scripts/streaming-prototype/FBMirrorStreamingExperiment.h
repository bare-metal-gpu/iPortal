// Experimental raw Recap delta playback. Gated by MIRROR_STREAMING_PROTOTYPE=1.
#import "FBMirrorTouchProbe.h"
@protocol FBMirrorDeltaStream <NSObject>
+ (id)eventStreamWithEventActions:(void(^)(id))block;
+ (id)touchScreenDigitizerSender;
- (void)composeWithSender:(id)sender actionBlock:(void(^)(id))block;
- (void)setGsScreenPointSize:(CGSize)size;
- (void)setGsScreenScaleFactor:(double)scale;
- (void)touchDown:(CGPoint)point;
- (void)moveToPoint:(CGPoint)point duration:(double)duration;
- (void)liftUp:(CGPoint)point;
- (NSArray *)events;
- (void)setEvents:(NSArray *)events;
- (NSData *)dataRepresentation;
@end

@interface FBMirrorStreamingExperiment : NSObject
@property(nonatomic,strong) NSMutableArray<NSValue *> *points;
@property(nonatomic,strong) NSString *token;
@property(nonatomic,strong) id sender;
@property(nonatomic) NSUInteger priorCount;
@property(nonatomic) BOOL busy;
@property(nonatomic) BOOL active;
@property(nonatomic) BOOL uncertain;
@property(nonatomic) NSUInteger releaseAttempts;
@property(nonatomic) NSTimeInterval beganAt;
@property(nonatomic) NSTimeInterval leaseUntil;
@property(nonatomic) CGSize size;
@property(nonatomic) CGFloat scale;
@property(nonatomic,strong) NSString *lastRelease;
+ (instancetype)shared;
- (NSDictionary *)command:(NSDictionary *)body error:(NSError **)error;
- (NSDictionary *)playEnd:(BOOL)end releaseOnly:(BOOL)releaseOnly error:(NSError **)error;
- (void)watchdog:(NSString *)expectedToken;
@end

@implementation FBMirrorStreamingExperiment
+ (instancetype)shared {
  static FBMirrorStreamingExperiment *instance; static dispatch_once_t once;
  dispatch_once(&once, ^{ instance=[self new]; instance.points=[NSMutableArray new]; }); return instance;
}
- (NSDictionary *)fail:(NSString *)message error:(NSError **)error {
  if(error) *error=[NSError errorWithDomain:@"mirror-streaming" code:1 userInfo:@{NSLocalizedDescriptionKey:message}]; return nil;
}
- (NSDictionary *)playEnd:(BOOL)end releaseOnly:(BOOL)releaseOnly error:(NSError **)error {
  Class<FBMirrorDeltaStream> cls=(Class<FBMirrorDeltaStream>)NSClassFromString(@"RCPSyntheticEventStream");
  NSArray<NSValue *> *points=[self.points copy]; id sender=self.sender; CGSize size=self.size; CGFloat scale=self.scale;
  id<FBMirrorDeltaStream> stream=[cls eventStreamWithEventActions:^(id<FBMirrorDeltaStream> composer){
    [composer composeWithSender:sender actionBlock:^(id<FBMirrorDeltaStream> scoped){
      [scoped setGsScreenPointSize:size]; [scoped setGsScreenScaleFactor:scale];
      [scoped touchDown:points[0].CGPointValue];
      for(NSUInteger i=1;i<points.count;i++) [scoped moveToPoint:points[i].CGPointValue duration:0.01];
      if(end) [scoped liftUp:points.lastObject.CGPointValue];
    }];
  }];
  NSArray *all=stream.events;
  if(!all.count || (!releaseOnly && all.count<=self.priorCount)) return [self fail:@"No new Recap events composed" error:error];
  NSArray *delta=releaseOnly ? @[all.lastObject] : [all subarrayWithRange:NSMakeRange(self.priorCount,all.count-self.priorCount)];
  NSUInteger fullCount=all.count;
  [stream setEvents:delta]; NSData *data=stream.dataRepresentation;
  if(!data.length) return [self fail:@"Recap delta serialization failed" error:error];
  XCPointerEventPath *path=[[XCPointerEventPath alloc] initForEventStream:data frame:CGRectMake(0,0,size.width,size.height) speed:1];
  XCSynthesizedEventRecord *record=[[XCSynthesizedEventRecord alloc] initWithName:@"mirror-streaming-prototype" interfaceOrientation:UIInterfaceOrientationPortrait];
  [record addPointerEventPath:path];
  __block volatile atomic_bool completed=false; __block NSError *playbackError=nil;
  NSTimeInterval start=NSProcessInfo.processInfo.systemUptime;
  self.busy=YES;
  [XCTRunnerDaemonSession.sharedSession.daemonProxy _XCT_synthesizeEvent:record implicitConfirmationInterval:0.05 completion:^(NSError *e){ playbackError=e; atomic_store_explicit(&completed,true,memory_order_release); }];
  BOOL replied=[[[[[FBRunLoopSpinner new] interval:0.01] timeout:2] timeoutErrorMessage:@"Streaming delta outcome unknown"] spinUntilTrue:^BOOL{ return atomic_load_explicit(&completed,memory_order_acquire); } error:error];
  self.busy=NO;
  if(!replied || playbackError) { self.uncertain=YES; if(playbackError && error)*error=playbackError; return nil; }
  self.priorCount=fullCount;
  return @{@"completed":@YES,@"deltaEvents":@(delta.count),@"prefixEvents":@(fullCount),@"bytes":@(data.length),@"elapsedMs":@((NSProcessInfo.processInfo.systemUptime-start)*1000)};
}
- (void)watchdog:(NSString *)expectedToken {
  if(!self.active || ![self.token isEqual:expectedToken])return;
  NSTimeInterval now=NSProcessInfo.processInfo.systemUptime;
  if((now>=self.leaseUntil || now-self.beganAt>=10) && !self.busy) {
    NSError *error=nil;
    NSDictionary *result=[self playEnd:YES releaseOnly:YES error:&error];
    self.releaseAttempts++;
    if(result && FBMirrorTouchProbe.shared.active.count==0) {
      self.lastRelease=@"watchdog acknowledged; recorder has no active contact"; self.active=NO; self.uncertain=NO; return;
    }
    self.uncertain=YES;
    self.lastRelease=[NSString stringWithFormat:@"watchdog release uncertain (attempt %lu): %@; recorder active=%lu",(unsigned long)self.releaseAttempts,error.localizedDescription ?: @"callback acknowledged",(unsigned long)FBMirrorTouchProbe.shared.active.count];
    if(self.releaseAttempts>=3) { self.lastRelease=[self.lastRelease stringByAppendingString:@"; runner restart required"]; return; }
    self.leaseUntil=now+0.5;
  }
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW,(int64_t)(0.1*NSEC_PER_SEC)),dispatch_get_main_queue(),^{[self watchdog:expectedToken];});
}
- (NSDictionary *)command:(NSDictionary *)body error:(NSError **)error {
  if(self.busy)return [self fail:@"Another delta is still playing" error:error];
  NSString *phase=body[@"phase"];
  if(![@[@"begin",@"move",@"end",@"cancel",@"status"] containsObject:phase])return [self fail:@"Invalid phase" error:error];
  if([phase isEqual:@"status"])return @{@"active":@(self.active),@"uncertain":@(self.uncertain),@"releaseAttempts":@(self.releaseAttempts),@"token":self.token ?: @"",@"lastRelease":self.lastRelease ?: @"",@"probe":FBMirrorTouchProbe.shared.snapshot};
  BOOL begin=[phase isEqual:@"begin"],end=[phase isEqual:@"end"] || [phase isEqual:@"cancel"];
  if(begin && (self.active || self.uncertain || FBMirrorTouchProbe.shared.active.count))return [self fail:@"Previous contact active or uncertain; release/restart before beginning" error:error];
  if(begin && (!FBMirrorTouchProbe.shared.window.isKeyWindow || FBMirrorTouchProbe.shared.window.hidden))return [self fail:@"Show the recorder window first" error:error];
  if(!begin && (!self.active || ![body[@"token"] isEqual:self.token]))return [self fail:@"No matching active contact" error:error];
  for(NSString *key in body)if(![@[@"phase",@"token",@"x",@"y"] containsObject:key])return [self fail:@"Unknown argument" error:error];
  if(!end) {
    if(!FBMirrorFiniteNumber(body[@"x"]) || !FBMirrorFiniteNumber(body[@"y"]))return [self fail:@"Coordinates must be finite" error:error];
    double x=[body[@"x"] doubleValue],y=[body[@"y"] doubleValue];
    if(x<0.15 || x>0.85 || y<0.25 || y>0.85)return [self fail:@"Coordinates outside safe probe area" error:error];
    if(XCUIDevice.sharedDevice.fb_isScreenLocked || ![XCUIApplication.fb_activeApplication.bundleID isEqual:NSBundle.mainBundle.bundleIdentifier])return [self fail:@"Probe runner must be unlocked and foreground" error:error];
    UIInterfaceOrientation orientation;
    if(!FBMirrorReadOrientation(&orientation,error) || orientation!=UIInterfaceOrientationPortrait)return [self fail:@"Prototype requires portrait" error:error];
    if(begin) {
      dlopen("/System/Library/PrivateFrameworks/Recap.framework/Recap",RTLD_LAZY);
      Class<FBMirrorDeltaStream> streamClass=(Class<FBMirrorDeltaStream>)NSClassFromString(@"RCPSyntheticEventStream");
      Class<FBMirrorDeltaStream> senderClass=(Class<FBMirrorDeltaStream>)NSClassFromString(@"RCPEventSenderProperties");
      if(![streamClass respondsToSelector:@selector(eventStreamWithEventActions:)] || ![senderClass respondsToSelector:@selector(touchScreenDigitizerSender)])return [self fail:@"Recap runtime unavailable" error:error];
      XCUIScreen *screen=[FBScreen currentScreenWithError:error]; if(!screen)return nil;
      self.size=CGSizeMake(screen.bounds.size.width/screen.scale,screen.bounds.size.height/screen.scale); self.scale=screen.scale;
      self.sender=[senderClass touchScreenDigitizerSender]; self.token=NSUUID.UUID.UUIDString;
      [self.points removeAllObjects]; self.priorCount=0; self.active=YES; self.beganAt=NSProcessInfo.processInfo.systemUptime;
      self.leaseUntil=self.beganAt+3; self.lastRelease=nil; self.releaseAttempts=0; self.uncertain=NO;
      [self watchdog:self.token];
    }
    if(self.points.count>=64)return [self fail:@"Contact point limit reached; end contact" error:error];
    [self.points addObject:[NSValue valueWithCGPoint:CGPointMake(x*self.size.width,y*self.size.height)]];
  }
  NSDictionary *result=[self playEnd:end releaseOnly:end error:error];
  if(end) {
    if(result && FBMirrorTouchProbe.shared.active.count==0) { self.active=NO; self.uncertain=NO; self.lastRelease=@"explicit end acknowledged; recorder has no active contact"; }
    else { self.uncertain=YES; self.lastRelease=@"explicit end uncertain; watchdog will attempt release"; self.leaseUntil=NSProcessInfo.processInfo.systemUptime+0.5; }
  }
  else self.leaseUntil=NSProcessInfo.processInfo.systemUptime+3;
  if(!result)return nil;
  NSMutableDictionary *response=[result mutableCopy]; response[@"phase"]=phase;response[@"token"]=self.token;response[@"active"]=@(self.active);response[@"probe"]=FBMirrorTouchProbe.shared.snapshot;
  return response;
}
@end
