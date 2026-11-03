#import <UIKit/UIKit.h>
#import <objc/runtime.h>

// Loaded by the host executable, before the test bundle. Keep Apple's app and
// scene delegates intact: they own XCTest startup and background execution.
@interface PortalStatusScreen : NSObject
@end
@implementation PortalStatusScreen
+ (void)installInExistingWindows {
  for (UIScene *scene in UIApplication.sharedApplication.connectedScenes) {
    if (![scene isKindOfClass:UIWindowScene.class]) continue;
    for (UIWindow *window in ((UIWindowScene *)scene).windows) {
      if (window.windowLevel != UIWindowLevelNormal || [window.rootViewController.view viewWithTag:4102]) continue;
      // Never create or activate a window, and never replace a real app screen.
      if (window.rootViewController != nil) continue;
      window.rootViewController = [NSClassFromString(@"PortalViewController") new];
    }
  }
}
+ (void)load {
  // A manual icon launch has no test configuration. Apple's default delegate
  // otherwise starts XCTest anyway, which immediately returns to Home.
  Class runner = NSClassFromString(@"_XCTRunnerAppDelegate");
  SEL start = NSSelectorFromString(@"runTestsInBackground:");
  Method method = class_getInstanceMethod(runner, start);
  if (method) {
    void (*original)(id, SEL, BOOL) = (void *)method_getImplementation(method);
    method_setImplementation(method, imp_implementationWithBlock(^(id delegate, BOOL background) {
      NSDictionary *env = NSProcessInfo.processInfo.environment;
      if ([env[@"PORTAL_AUTOMATION"] isEqual:@"1"] || [env[@"XCTestConfigurationFilePath"] length] || [env[@"XCTestSessionIdentifier"] length]
          || [env[@"XCTestBundlePath"] length]) original(delegate, start, background);
    }));
  }
  for (NSNotificationName name in @[UISceneWillConnectNotification, UISceneDidActivateNotification]) {
    [NSNotificationCenter.defaultCenter addObserverForName:name object:nil queue:NSOperationQueue.mainQueue usingBlock:^(NSNotification *note) {
      // Scene connection completes after the notification; use the window the
      // runner just created. This also handles a previously saved scene.
      dispatch_async(dispatch_get_main_queue(), ^{ [self installInExistingWindows]; });
    }];
  }
}
@end
