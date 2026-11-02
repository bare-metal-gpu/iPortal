// Offline smoke test. Empty streams contain zero HID events; no input is dispatched.
#import <Foundation/Foundation.h>
#import <dlfcn.h>
#import <stdatomic.h>
@protocol EmptyStream <NSObject>
+ (id)eventStreamWithEventActions:(void (^)(id))block;
- (NSArray *)events;
@end
@protocol EmptyPlayer <NSObject>
- (void)setNeedsInitialDelay:(BOOL)value;
- (void)setIgnoresCompletionDelay:(BOOL)value;
- (void)playEventStream:(id)stream options:(id)options completion:(void (^)(void))completion;
- (void)tearDown;
- (id)underlyingPlayer;
@end
int main(void) { @autoreleasepool {
  if (!dlopen("/System/Library/PrivateFrameworks/Recap.framework/Recap", RTLD_LAZY)) return 2;
  NSMutableArray *samples = [NSMutableArray new];
  for (NSNumber *ignore in @[@NO,@YES]) for (int i=0;i<5;i++) {
    Class<EmptyStream> streamClass = NSClassFromString(@"RCPSyntheticEventStream");
    id<EmptyStream> stream = [streamClass eventStreamWithEventActions:^(id unused) {}];
    if (stream.events.count != 0) return 3;
    id<EmptyPlayer> player = [NSClassFromString(@"RCPInlinePlayer") new];
    [player setNeedsInitialDelay:NO]; [player setIgnoresCompletionDelay:ignore.boolValue];
    __block atomic_bool complete = false;
    __block double callbackAt = 0;
    double start = NSProcessInfo.processInfo.systemUptime;
    [player playEventStream:stream options:[NSClassFromString(@"RCPPlayerPlaybackOptions") new] completion:^{
      callbackAt = NSProcessInfo.processInfo.systemUptime;
      atomic_store_explicit(&complete, true, memory_order_release);
    }];
    while (!atomic_load_explicit(&complete, memory_order_acquire) && NSProcessInfo.processInfo.systemUptime-start < 3)
      [NSRunLoop.currentRunLoop runUntilDate:[NSDate dateWithTimeIntervalSinceNow:.001]];
    if (!atomic_load_explicit(&complete, memory_order_acquire)) return 4;
    [samples addObject:@{@"ignoreDelay":ignore,@"eventCount":@(stream.events.count),@"elapsedMs":@((callbackAt-start)*1000),@"underlyingClass":NSStringFromClass([[player underlyingPlayer] class]) ?: @"nil"}];
    [player tearDown];
  }
  NSData *data = [NSJSONSerialization dataWithJSONObject:samples options:NSJSONWritingPrettyPrinted error:nil];
  fwrite(data.bytes,1,data.length,stdout); puts("");
} return 0; }
