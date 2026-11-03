// Status only: no input synthesis, window activation, or idle-timer changes.
#import <UIKit/UIKit.h>
#import <math.h>
#import <notify.h>
#import "FBCommandHandler.h"
#import "FBRoute.h"
#import "FBRouteRequest.h"
#import "FBResponsePayload.h"
#import "FBCommandStatus.h"

// A missing heartbeat is a lost connection, not an active reconnect attempt.
static NSString *FBPortalPhase(NSTimeInterval receivedAt, NSTimeInterval now, BOOL ready, BOOL wasConnected) {
  if (receivedAt <= 0) return @"waiting";
  if (now - receivedAt >= 3) return @"disconnected";
  return ready ? @"connected" : wasConnected ? @"reconnecting" : @"connecting";
}

@interface FBPortalStatus : NSObject
@property(nonatomic) NSTimeInterval receivedAt;
@property(nonatomic) NSTimeInterval awakeUntil;
@property(nonatomic) BOOL ready;
@property(nonatomic) BOOL wasConnected;
@property(nonatomic) BOOL hostDetached;
@property(nonatomic,strong) NSMutableArray *usbEvents;
@property(nonatomic,strong) NSTimer *timer;
+ (instancetype)shared;
- (NSDictionary *)snapshot;
- (void)render;
@end

@implementation FBPortalStatus
+ (instancetype)shared {
  static FBPortalStatus *status; static dispatch_once_t once;
  dispatch_once(&once, ^{ status = [FBPortalStatus new]; });
  return status;
}
+ (void)load {
  dispatch_async(dispatch_get_main_queue(), ^{
    FBPortalStatus *status = self.shared;
    status.usbEvents = [NSMutableArray new];
    // lockdownd's host notifications also work when no heartbeat can cross the
    // removed cable. Keep the deadline as a fallback on systems that omit them.
    for (NSString *name in @[@"com.apple.mobile.lockdown.host_detached", @"com.apple.mobile.lockdown.host_attached"]) {
      int token;
      notify_register_dispatch(name.UTF8String, &token, dispatch_get_main_queue(), ^(int notification) {
        BOOL detached = [name hasSuffix:@"host_detached"];
        status.hostDetached = detached;
        status.ready = NO;
        status.awakeUntil = 0;
        if (!detached) status.receivedAt = NSProcessInfo.processInfo.systemUptime;
        [status.usbEvents addObject:@{@"attached":@(!detached), @"uptime":@(NSProcessInfo.processInfo.systemUptime)}];
        if (status.usbEvents.count > 8) [status.usbEvents removeObjectAtIndex:0];
        [status render];
      });
    }
    [NSNotificationCenter.defaultCenter addObserver:status selector:@selector(render)
      name:UIApplicationDidBecomeActiveNotification object:nil];
    status.timer = [NSTimer scheduledTimerWithTimeInterval:1 target:status selector:@selector(render) userInfo:nil repeats:YES];
    status.timer.tolerance = .2;
    [status render];
  });
}
- (NSString *)phase {
  if (self.hostDetached) return @"disconnected";
  return FBPortalPhase(self.receivedAt, NSProcessInfo.processInfo.systemUptime, self.ready, self.wasConnected);
}
- (UIView *)root {
  for (UIScene *scene in UIApplication.sharedApplication.connectedScenes) {
    if (![scene isKindOfClass:UIWindowScene.class]) continue;
    for (UIWindow *window in ((UIWindowScene *)scene).windows)
      if ([window.rootViewController.view viewWithTag:4102]) return window.rootViewController.view;
  }
  return nil;
}
- (NSDictionary *)snapshot {
  NSString *phase = self.phase;
  BOOL connected = [phase isEqual:@"connected"];
  NSString *message = connected ? @"Connected" : [phase isEqual:@"connecting"] ? @"Connecting…"
    : [phase isEqual:@"reconnecting"] ? @"Reconnecting…" : [phase isEqual:@"disconnected"] ? @"Disconnected" : @"Waiting for your Mac";
  NSString *detail = [phase isEqual:@"waiting"] ? @"Connect by USB and open iPhone Portal on your Mac."
    : [phase isEqual:@"disconnected"] ? @"Connect to your Mac" : @"";
  BOOL fresh = !self.hostDetached && self.receivedAt > 0 && NSProcessInfo.processInfo.systemUptime - self.receivedAt < 3;
  NSTimeInterval remaining = fresh ? MAX(0, self.awakeUntil - NSProcessInfo.processInfo.systemUptime) : 0;
  UIView *root = self.root;
  return @{@"phase":phase, @"message":message, @"detail":detail, @"keepAwakeRemainingMs":@((long long)ceil(remaining * 1000)),
    @"screenInstalled":@(root != nil), @"width":@(root.bounds.size.width), @"height":@(root.bounds.size.height),
    @"foreground":@(UIApplication.sharedApplication.applicationState == UIApplicationStateActive),
    @"usbEvents":self.usbEvents ?: @[]};
}
- (void)render {
  if (UIApplication.sharedApplication.applicationState != UIApplicationStateActive) return;
  UIView *root = self.root; if (!root) return;
  NSDictionary *state = self.snapshot;
  [NSNotificationCenter.defaultCenter postNotificationName:@"PortalStatusChanged" object:nil userInfo:state];
}
@end

@interface FBPortalStatusCommands : NSObject <FBCommandHandler>
@end
@implementation FBPortalStatusCommands
+ (NSArray *)routes {
  return @[[[FBRoute GET:@"/wda/mirror/portal"].withoutSession respondWithTarget:self action:@selector(read:)],
    [[FBRoute POST:@"/wda/mirror/portal"].withoutSession respondWithTarget:self action:@selector(update:)]];
}
+ (id<FBResponsePayload>)read:(FBRouteRequest *)request {
  return FBResponseWithObject(FBPortalStatus.shared.snapshot);
}
+ (id<FBResponsePayload>)update:(FBRouteRequest *)request {
  NSDictionary *args = request.arguments;
  if (![args isKindOfClass:NSDictionary.class])
    return FBResponseWithStatus([FBCommandStatus invalidArgumentErrorWithMessage:@"Invalid portal presence" traceback:nil]);
  id ready = args[@"ready"], remaining = args[@"keepAwakeMs"];
  if (args.count != 2 || ![ready isKindOfClass:NSNumber.class] || CFGetTypeID((__bridge CFTypeRef)ready) != CFBooleanGetTypeID()
      || ![remaining isKindOfClass:NSNumber.class] || CFGetTypeID((__bridge CFTypeRef)remaining) == CFBooleanGetTypeID()
      || !isfinite([remaining doubleValue]) || [remaining doubleValue] < 0 || [remaining doubleValue] > 7200000)
    return FBResponseWithStatus([FBCommandStatus invalidArgumentErrorWithMessage:@"Invalid portal presence" traceback:nil]);
  FBPortalStatus *status = FBPortalStatus.shared;
  status.receivedAt = NSProcessInfo.processInfo.systemUptime;
  status.hostDetached = NO;
  status.ready = [ready boolValue];
  status.wasConnected |= status.ready;
  status.awakeUntil = status.receivedAt + [remaining doubleValue]/1000;
  [status render];
  return FBResponseWithObject(status.snapshot);
}
@end
