#import <Foundation/Foundation.h>
#import <XCTest/XCTest.h>
NS_ASSUME_NONNULL_BEGIN
// All runtime-only Apple interfaces and Objective-C exception handling live here.
@interface IPApple : NSObject
+ (nullable id)protect:(id _Nullable (^)(void))block error:(NSError **)error;
+ (nullable XCUIApplication *)foreground:(NSError **)error;
+ (NSDictionary *)applicationInfo:(XCUIApplication *)app;
+ (NSDictionary *)applicationIdentity:(XCUIApplication *)app;
+ (NSString *)bundleIdentifier:(XCUIApplication *)app;
+ (BOOL)activate:(XCUIApplication *)app error:(NSError **)error;
+ (CGSize)screenSize:(NSError **)error;
+ (NSInteger)orientation:(XCUIApplication *)app;
+ (nullable NSNumber *)locked;
+ (void)startLockObserver:(void (^)(NSNumber *_Nullable))changed;
+ (void)stopLockObserver;
+ (NSDictionary *)capabilities;
+ (void)captureJPEGWithQuality:(double)quality scale:(double)scale
                   completion:(void (^)(NSData *_Nullable))completion;
+ (void)touch:(NSArray<NSArray<NSArray<NSNumber *> *> *> *)fingers
            end:(double)end
           size:(CGSize)size
    orientation:(NSInteger)orientation
     completion:(void (^)(NSError *_Nullable))completion;
+ (void)keyboard:(NSString *)text
             key:(BOOL)isKey
       modifiers:(NSArray<NSString *> *)modifiers
      completion:(void (^)(NSError *_Nullable))completion;
+ (nullable NSNumber *)keyboardFocused:(XCUIElement *)element error:(NSError **)error;
+ (void)keyboard:(NSString *)text key:(BOOL)isKey modifiers:(NSArray<NSString *> *)modifiers
         element:(XCUIElement *_Nullable)element completion:(void (^)(NSError *_Nullable))completion;
+ (void)consumer:(NSUInteger)usage
        duration:(double)duration
      completion:(void (^)(NSError *_Nullable))completion;
+ (nullable id<XCUIElementSnapshot>)snapshotAttributes:(id<XCUIElementSnapshot>)snapshot
                                                 error:(NSError **)error;
+ (nullable id<XCUIElementSnapshot>)snapshotElement:(XCUIElement *)element
                                           flags:(BOOL)flags error:(NSError **)error;
+ (nullable NSString *)snapshotIdentity:(id<XCUIElementSnapshot>)snapshot error:(NSError **)error;
+ (nullable XCUIElement *)elementForSnapshot:(id<XCUIElementSnapshot>)snapshot
    application:(XCUIApplication *)app error:(NSError **)error;
+ (NSDictionary *)snapshotExtras:(id)snapshot;
+ (nullable NSNumber *)snapshotFlag:(id)snapshot name:(NSString *)name;
+ (nullable NSNumber *)predicate:(NSString *)predicate
                         matches:(NSDictionary *)attributes
                           error:(NSError **)error;
+ (nullable NSArray<NSString *> *)xpath:(NSString *)expression
                                    xml:(NSString *)xml
                                  error:(NSError **)error;
@end
NS_ASSUME_NONNULL_END
