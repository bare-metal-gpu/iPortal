// Status only: no input synthesis, window activation, or idle-timer changes.
#import <UIKit/UIKit.h>
#import <math.h>
#import <notify.h>

// A missing heartbeat is a lost connection, not an active reconnect attempt.
static NSString *IPPortalPhase(NSTimeInterval receivedAt, NSTimeInterval now, BOOL ready,
                               BOOL wasConnected) {
    if (receivedAt <= 0)
        return @"waiting";
    if (now - receivedAt >= 3)
        return @"disconnected";
    return ready ? @"connected" : wasConnected ? @"reconnecting" : @"connecting";
}

@interface IPPortalStatus : NSObject
@property(nonatomic) NSTimeInterval receivedAt;
@property(nonatomic) NSTimeInterval awakeUntil;
@property(nonatomic) BOOL ready;
@property(nonatomic) BOOL wasConnected;
@property(nonatomic) BOOL hostDetached;
@property(nonatomic) NSTimeInterval recoveringUntil;
@property(nonatomic) NSTimeInterval detachGraceUntil;
@property(nonatomic, strong) NSMutableArray *usbEvents;
@property(nonatomic, strong) NSMutableArray *phaseEvents;
@property(nonatomic, copy) NSString *lastRenderedPhase;
@property(nonatomic, strong) NSTimer *timer;
+ (instancetype)shared;
- (NSDictionary *)snapshot;
- (void)render;
- (NSDictionary *)updateReady:(BOOL)ready keepAwakeMs:(double)remaining;
@end

@implementation IPPortalStatus
+ (instancetype)shared {
    static IPPortalStatus *status;
    static dispatch_once_t once;
    dispatch_once(&once, ^{
      status = [IPPortalStatus new];
    });
    return status;
}
+ (void)load {
    dispatch_async(dispatch_get_main_queue(), ^{
      IPPortalStatus *status = self.shared;
      status.usbEvents = [NSMutableArray new];
      status.phaseEvents = [NSMutableArray new];
      // lockdownd's host notifications also work when no heartbeat can cross the
      // removed cable. Keep the deadline as a fallback on systems that omit them.
      for (NSString *name in @[
               @"com.apple.mobile.lockdown.host_detached",
               @"com.apple.mobile.lockdown.host_attached"
           ]) {
          int token;
          notify_register_dispatch(
              name.UTF8String, &token, dispatch_get_main_queue(), ^(int notification) {
                // A paired tunnel survives removing USB. Presence still expires if the
                // authenticated Mac heartbeat stops, including Wi-Fi loss.
                if ([NSProcessInfo.processInfo.environment[@"IPORTAL_PAIRED"] isEqual:@"1"])
                    return;
                BOOL detached = [name hasSuffix:@"host_detached"];
                NSTimeInterval now = NSProcessInfo.processInfo.systemUptime;
                BOOL recovering = !status.ready && now < status.recoveringUntil;
                status.detachGraceUntil = detached && recovering ? now + 1.2 : 0;
                if (!detached && !recovering)
                    status.recoveringUntil = now + 8;
                status.hostDetached = detached;
                status.ready = NO;
                status.awakeUntil = 0;
                if (!detached)
                    status.receivedAt = NSProcessInfo.processInfo.systemUptime;
                [status.usbEvents addObject:@{
                    @"attached" : @((BOOL)!detached),
                    @"uptime" : @(NSProcessInfo.processInfo.systemUptime)
                }];
                if (status.usbEvents.count > 8)
                    [status.usbEvents removeObjectAtIndex:0];
                [status render];
              });
      }
      [NSNotificationCenter.defaultCenter addObserver:status
                                             selector:@selector(render)
                                                 name:UIApplicationDidBecomeActiveNotification
                                               object:nil];
      status.timer = [NSTimer scheduledTimerWithTimeInterval:1
                                                      target:status
                                                    selector:@selector(render)
                                                    userInfo:nil
                                                     repeats:YES];
      status.timer.tolerance = .2;
      [status render];
    });
}
- (NSDictionary *)updateReady:(BOOL)ready keepAwakeMs:(double)remaining {
    self.receivedAt = NSProcessInfo.processInfo.systemUptime;
    self.hostDetached = NO;
    self.ready = ready;
    if (ready) {
        self.recoveringUntil = 0;
        self.detachGraceUntil = 0;
    }
    self.wasConnected |= ready;
    self.awakeUntil = self.receivedAt + remaining / 1000;
    [self render];
    return self.snapshot;
}
- (NSString *)phase {
    if (self.hostDetached)
        return NSProcessInfo.processInfo.systemUptime < self.detachGraceUntil ? @"reconnecting"
                                                                              : @"disconnected";
    return IPPortalPhase(self.receivedAt, NSProcessInfo.processInfo.systemUptime, self.ready,
                         self.wasConnected);
}
- (UIView *)root {
    for (UIScene *scene in UIApplication.sharedApplication.connectedScenes) {
        if (![scene isKindOfClass:UIWindowScene.class])
            continue;
        for (UIWindow *window in ((UIWindowScene *)scene).windows)
            if ([window.rootViewController.view viewWithTag:4102])
                return window.rootViewController.view;
    }
    return nil;
}
- (NSDictionary *)snapshot {
    NSString *phase = self.phase;
    BOOL connected = [phase isEqual:@"connected"];
    NSString *message = connected                         ? @"Connected"
                        : [phase isEqual:@"connecting"]   ? @"Connecting…"
                        : [phase isEqual:@"reconnecting"] ? @"Reconnecting…"
                        : [phase isEqual:@"disconnected"] ? @"Disconnected"
                                                          : @"Waiting for your Mac";
    NSString *detail = [phase isEqual:@"waiting"]        ? @"Open iPortal on your Mac."
                       : [phase isEqual:@"disconnected"] ? @"Connect to your Mac"
                                                         : @"";
    BOOL fresh = !self.hostDetached && self.receivedAt > 0 &&
                 NSProcessInfo.processInfo.systemUptime - self.receivedAt < 3;
    NSTimeInterval remaining =
        fresh ? MAX(0, self.awakeUntil - NSProcessInfo.processInfo.systemUptime) : 0;
    UIView *root = self.root;
    return @{
        @"phase" : phase,
        @"message" : message,
        @"detail" : detail,
        @"keepAwakeRemainingMs" : @((long long)ceil(remaining * 1000)),
        @"screenInstalled" : @((BOOL)(root != nil)),
        @"width" : @(root.bounds.size.width),
        @"height" : @(root.bounds.size.height),
        @"foreground" : @((BOOL)(UIApplication.sharedApplication.applicationState ==
                                 UIApplicationStateActive)),
        @"usbEvents" : self.usbEvents ?: @[],
        @"phaseEvents" : self.phaseEvents ?: @[]
    };
}
- (void)render {
    if (UIApplication.sharedApplication.applicationState != UIApplicationStateActive)
        return;
    UIView *root = self.root;
    if (!root)
        return;
    NSDictionary *state = self.snapshot;
    if (![self.lastRenderedPhase isEqual:state[@"phase"]]) {
        self.lastRenderedPhase = state[@"phase"];
        [self.phaseEvents addObject:@{
            @"phase" : self.lastRenderedPhase,
            @"uptime" : @(NSProcessInfo.processInfo.systemUptime)
        }];
        if (self.phaseEvents.count > 24)
            [self.phaseEvents removeObjectAtIndex:0];
    }
    [NSNotificationCenter.defaultCenter postNotificationName:@"IPortalStatusChanged"
                                                      object:nil
                                                    userInfo:state];
}
@end
