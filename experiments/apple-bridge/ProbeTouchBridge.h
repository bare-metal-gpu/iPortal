#import <Foundation/Foundation.h>
#import <CoreGraphics/CoreGraphics.h>
NS_ASSUME_NONNULL_BEGIN
// Test-target only. No listener, production route, or automatic retries.
@interface ProbeTouchBridge : NSObject
- (void)sendPhase:(NSString *)phase point:(CGPoint)point size:(CGSize)size
    confirmation:(double)confirmation completion:(void (^)(NSError *_Nullable))completion;
@end
NS_ASSUME_NONNULL_END
