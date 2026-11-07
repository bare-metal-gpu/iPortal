#import "ProbeTouchBridge.h"
#import <XCTest/XCTest.h>
#import <UIKit/UIKit.h>
#import <dlfcn.h>
#import <math.h>

// Independent ABI declarations for the same Apple entry points investigated
// previously. Runtime rejection is an experimental result, never a fallback.
@protocol ProbeRuntime <NSObject>
+ (id)eventStreamWithEventActions:(void (^)(id))actions;
+ (id)touchScreenDigitizerSender;
+ (id)sharedSession;
- (id)daemonProxy;
- (void)composeWithSender:(id)sender actionBlock:(void (^)(id))actions;
- (void)setGsScreenPointSize:(CGSize)size;
- (void)setGsScreenScaleFactor:(double)scale;
- (void)touchDown:(CGPoint)point;
- (void)moveToPoint:(CGPoint)point duration:(double)duration;
- (void)advanceTime:(double)duration;
- (void)liftUp:(CGPoint)point;
- (NSArray *)events;
- (void)setEvents:(NSArray *)events;
- (NSData *)dataRepresentation;
- (id)initForEventStream:(NSData *)data frame:(CGRect)frame speed:(double)speed;
- (id)initWithName:(NSString *)name displayID:(NSUInteger)display interfaceOrientation:(NSInteger)orientation;
- (void)addPointerEventPath:(id)path;
- (void)_XCT_synthesizeEvent:(id)event implicitConfirmationInterval:(double)interval completion:(void (^)(NSError *))completion;
@end
static void Require(id object, SEL selector) {
    if (![object respondsToSelector:selector])
        @throw [NSException exceptionWithName:@"UnsupportedProbeAPI" reason:NSStringFromSelector(selector) userInfo:nil];
}
@implementation ProbeTouchBridge {
    NSMutableArray<NSValue *> *_points;
    NSUInteger _prefix;
    BOOL _busy;
    BOOL _retired;
}
- (void)sendPhase:(NSString *)phase point:(CGPoint)point size:(CGSize)size
    confirmation:(double)confirmation completion:(void (^)(NSError *))completion {
    NSAssert(NSThread.isMainThread, @"Probe dispatch is main-thread serialized");
    if (_busy || _retired) {
        completion([NSError errorWithDomain:@"iPortal.InputProbe" code:1 userInfo:@{NSLocalizedDescriptionKey:@"Previous native ownership unresolved or retired"}]);
        return;
    }
    NSLock *completionLock = [NSLock new];
    __block BOOL delivered = NO;
    void (^finish)(NSError *, NSUInteger, BOOL) = ^(NSError *error, NSUInteger prefix, BOOL retire) {
        [completionLock lock];
        BOOL duplicate = delivered;
        delivered = YES;
        [completionLock unlock];
        if (duplicate) return;
        dispatch_async(dispatch_get_main_queue(), ^{
            self->_busy = NO;
            // An exception after dispatch can retire ownership before a late
            // Apple callback arrives. A late callback must never unretire it.
            self->_retired = self->_retired || error != nil || retire;
            self->_prefix = prefix;
            completion(error);
        });
    };
    @try {
        BOOL begin = [phase isEqual:@"begin"], tap = [phase isEqual:@"tap"];
        BOOL end = [phase isEqual:@"end"] || tap;
        if ((!begin && !tap && !end && ![phase isEqual:@"move"]) ||
            !isfinite(point.x) || !isfinite(point.y) || !isfinite(size.width) || !isfinite(size.height) ||
            size.width <= 0 || size.height <= 0 || point.x < 0 || point.y < 0 ||
            point.x > size.width || point.y > size.height || (confirmation != 0 && confirmation != 0.05))
            @throw [NSException exceptionWithName:@"InvalidProbe" reason:@"Invalid bounded probe arguments" userInfo:nil];
        if (begin || tap) {
            if (_points) @throw [NSException exceptionWithName:@"InvalidProbe" reason:@"Start a new probe object for a new contact" userInfo:nil];
            _points = [NSMutableArray arrayWithObject:[NSValue valueWithCGPoint:point]];
        } else {
            if (!_points || _points.count >= 8) @throw [NSException exceptionWithName:@"InvalidProbe" reason:@"No active bounded contact" userInfo:nil];
            if (!end) [_points addObject:[NSValue valueWithCGPoint:point]];
        }
        dlopen("/System/Library/PrivateFrameworks/Recap.framework/Recap", RTLD_LAZY);
        id streamType = NSClassFromString(@"RCPSyntheticEventStream");
        id senderType = NSClassFromString(@"RCPEventSenderProperties");
        Require(streamType, @selector(eventStreamWithEventActions:));
        Require(senderType, @selector(touchScreenDigitizerSender));
        id sender = [senderType touchScreenDigitizerSender];
        id<ProbeRuntime> stream = [streamType eventStreamWithEventActions:^(id<ProbeRuntime> composer) {
            Require(composer, @selector(composeWithSender:actionBlock:));
            [composer composeWithSender:sender actionBlock:^(id<ProbeRuntime> scoped) {
                for (NSString *name in @[@"setGsScreenPointSize:", @"setGsScreenScaleFactor:", @"touchDown:", @"moveToPoint:duration:", @"advanceTime:", @"liftUp:"])
                    Require(scoped, NSSelectorFromString(name));
                [scoped setGsScreenPointSize:size];
                [scoped setGsScreenScaleFactor:1];
                [scoped touchDown:self->_points.firstObject.CGPointValue];
                for (NSUInteger i = 1; i < self->_points.count; i++)
                    [scoped moveToPoint:self->_points[i].CGPointValue duration:0.02];
                if (end) {
                    if (tap) [scoped advanceTime:0.06];
                    [scoped liftUp:self->_points.lastObject.CGPointValue];
                }
            }];
        }];
        Require(stream, @selector(events)); Require(stream, @selector(setEvents:));
        Require(stream, @selector(dataRepresentation));
        NSArray *events = stream.events;
        if (events.count <= _prefix) @throw [NSException exceptionWithName:@"InvalidProbe" reason:@"No new serialized events" userInfo:nil];
        NSUInteger nextPrefix = events.count;
        [stream setEvents:[events subarrayWithRange:NSMakeRange(_prefix, events.count - _prefix)]];
        NSData *data = stream.dataRepresentation;
        id pathType = NSClassFromString(@"XCPointerEventPath");
        id recordType = NSClassFromString(@"XCSynthesizedEventRecord");
        Require([pathType alloc], @selector(initForEventStream:frame:speed:));
        Require([recordType alloc], @selector(initWithName:displayID:interfaceOrientation:));
        id path = [[pathType alloc] initForEventStream:data frame:(CGRect){CGPointZero, size} speed:1];
        id<ProbeRuntime> record = [[recordType alloc] initWithName:@"iPortal Input Probe" displayID:1 interfaceOrientation:UIInterfaceOrientationPortrait];
        Require(record, @selector(addPointerEventPath:));
        [record addPointerEventPath:path];
        id sessionType = NSClassFromString(@"XCTRunnerDaemonSession");
        Require(sessionType, @selector(sharedSession));
        id<ProbeRuntime> session = [sessionType sharedSession];
        Require(session, @selector(daemonProxy));
        id<ProbeRuntime> daemon = session.daemonProxy;
        Require(daemon, @selector(_XCT_synthesizeEvent:implicitConfirmationInterval:completion:));
        _busy = YES;
        [daemon _XCT_synthesizeEvent:record implicitConfirmationInterval:confirmation completion:^(NSError *error) {
            finish(error, nextPrefix, end);
        }];
    } @catch (NSException *exception) {
        // A synchronous exception at dispatch may have an unknown outcome.
        // Retire this probe; do not retry through another Apple API.
        _retired = YES;
        finish([NSError errorWithDomain:@"iPortal.InputProbe" code:2 userInfo:@{NSLocalizedDescriptionKey:exception.reason ?: @"Apple probe unavailable"}], _prefix, YES);
    }
}
@end
