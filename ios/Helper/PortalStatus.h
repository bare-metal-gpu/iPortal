#import <Foundation/Foundation.h>
@interface IPPortalStatus : NSObject
+ (instancetype)shared;
- (NSDictionary *)snapshot;
- (NSDictionary *)updateReady:(BOOL)ready keepAwakeMs:(double)remaining;
@end
