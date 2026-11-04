// Explicit, bounded clipboard transfers. Never polls or accepts privacy alerts.
#import <UIKit/UIKit.h>
#import <ImageIO/ImageIO.h>
#import "XCUIApplication+FBHelpers.h"
#import "XCUIDevice+FBHelpers.h"
#import "FBCommandHandler.h"
#import "FBRoute.h"
#import "FBRouteRequest.h"
#import "FBResponsePayload.h"
#import "FBCommandStatus.h"

static const NSUInteger FBIPortalClipboardLimit = 4 * 1024 * 1024;
static dispatch_group_t FBIPortalPendingPaste;
static XCUIApplication *FBIPortalClipboardPrevious;
static NSString *FBIPortalClipboardLease;
static NSTimer *FBIPortalClipboardTimer;
@interface FBIPortalClipboardRead : NSObject
@property(nonatomic,strong) NSData *data;
@property(nonatomic,strong) NSString *format;
@property(nonatomic) NSInteger revision;
@property(nonatomic,strong) dispatch_group_t group;
@end
@implementation FBIPortalClipboardRead
@end
static FBIPortalClipboardRead *FBIPortalRead;
@interface FBIPortalClipboardCommands : NSObject <FBCommandHandler>
@end
@implementation FBIPortalClipboardCommands
+ (NSArray *)routes {
  return @[[[FBRoute POST:@"/wda/mirror/clipboard/prepare"].withoutSession respondWithTarget:self action:@selector(prepare:)],
    [[FBRoute POST:@"/wda/mirror/clipboard"].withoutSession respondWithTarget:self action:@selector(transfer:)]];
}
+ (id<FBResponsePayload>)failure:(NSString *)message {
  return FBResponseWithStatus([FBCommandStatus invalidElementStateErrorWithMessage:message traceback:nil]);
}
+ (void)restore {
  XCUIApplication *previous = FBIPortalClipboardPrevious;
  FBIPortalClipboardPrevious = nil; FBIPortalClipboardLease = nil; FBIPortalRead = nil;
  [FBIPortalClipboardTimer invalidate]; FBIPortalClipboardTimer = nil;
  if (previous && UIApplication.sharedApplication.applicationState == UIApplicationStateActive
      && !XCUIDevice.sharedDevice.fb_isScreenLocked && previous.state >= XCUIApplicationStateRunningBackgroundSuspended) {
    @try { [previous activate]; } @catch (NSException *exception) { }
  }
}
+ (id<FBResponsePayload>)prepare:(FBRouteRequest *)request {
  if (FBIPortalClipboardLease || (FBIPortalPendingPaste && dispatch_group_wait(FBIPortalPendingPaste, DISPATCH_TIME_NOW) != 0))
    return [self failure:@"Finish the current clipboard transfer on your device first"];
  if (XCUIDevice.sharedDevice.fb_isScreenLocked) return [self failure:@"Unlock your device to transfer the clipboard"];
  XCUIApplication *previous = XCUIApplication.fb_activeApplication;
  NSString *ownID = NSBundle.mainBundle.bundleIdentifier;
  FBIPortalClipboardPrevious = [previous.bundleID isEqual:ownID] ? nil : previous;
  FBIPortalClipboardLease = NSUUID.UUID.UUIDString;
  FBIPortalClipboardTimer = [NSTimer scheduledTimerWithTimeInterval:25 repeats:NO block:^(NSTimer *timer) { [self restore]; }];
  @try { if (FBIPortalClipboardPrevious) [[[XCUIApplication alloc] initWithBundleIdentifier:ownID] activate]; }
  @catch (NSException *exception) { [self restore]; @throw exception; }
  // Return to UIKit's main queue before requesting pasteboard access. Reading
  // in the same activation handler can deadlock iOS's foreground handoff.
  return FBResponseWithObject(@{@"lease":FBIPortalClipboardLease, @"helperBundleId":ownID, @"restoreBundleId":FBIPortalClipboardPrevious.bundleID ?: NSNull.null});
}
+ (id<FBResponsePayload>)transfer:(FBRouteRequest *)request {
  NSDictionary *args = request.arguments;
  if (![args isKindOfClass:NSDictionary.class]) return [self failure:@"Invalid clipboard request"];
  if ([args[@"operation"] isEqual:@"status"] && args.count == 1)
    return FBResponseWithObject(@{@"changeCount":@(UIPasteboard.generalPasteboard.changeCount)});
  if (![args[@"lease"] isKindOfClass:NSString.class] || ![args[@"lease"] isEqual:FBIPortalClipboardLease])
    return [self failure:@"Clipboard transfer expired; try again"];
  __block BOOL finished = YES;
  @try {
  if ([args[@"operation"] isEqual:@"cancel"]) return FBResponseWithObject(@{@"cancelled":@YES});
  BOOL writing = [args[@"operation"] isEqual:@"write"];
  NSString *format = args[@"format"];
  NSData *data = nil;
  id value = nil;
  NSString *type = nil;
  if ((!writing && ![args[@"operation"] isEqual:@"read"]) || args.count != (writing ? 4 : 2))
    return [self failure:@"Invalid clipboard request"];
  if (writing) {
    if (![args[@"content"] isKindOfClass:NSString.class] || [args[@"content"] length] > 5592408)
      return [self failure:@"Clipboard is too large (4 MB maximum)"];
    data = [[NSData alloc] initWithBase64EncodedString:args[@"content"] options:0];
    if (!data.length || data.length > FBIPortalClipboardLimit) return [self failure:@"Invalid clipboard data"];
    if ([format isEqual:@"text"] || [format isEqual:@"url"]) {
      if (data.length > 1024 * 1024) return [self failure:@"Text is too large (1 MB maximum)"];
      value = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
      type = [format isEqual:@"url"] ? @"public.url" : @"public.utf8-plain-text";
      if ([format isEqual:@"url"]) { NSURL *url = value ? [NSURL URLWithString:value] : nil; value = url.scheme.length ? url : nil; }
    } else if ([format isEqual:@"image"]) {
      CGImageSourceRef source = CGImageSourceCreateWithData((__bridge CFDataRef)data, NULL);
      NSDictionary *properties = source ? CFBridgingRelease(CGImageSourceCopyPropertiesAtIndex(source, 0, NULL)) : nil;
      double width = [properties[(id)kCGImagePropertyPixelWidth] doubleValue];
      double height = [properties[(id)kCGImagePropertyPixelHeight] doubleValue];
      if (source) CFRelease(source);
      if (width > 0 && height > 0 && width * height <= 20000000) {
        value = UIImagePNGRepresentation([UIImage imageWithData:data]);
        type = @"public.png";
      }
    }
    if (!value) return [self failure:@"Unsupported clipboard content"];
  }
  if (XCUIDevice.sharedDevice.fb_isScreenLocked) return [self failure:@"Unlock your device to transfer the clipboard"];
    if (UIApplication.sharedApplication.applicationState != UIApplicationStateActive) {
      finished = NO;
      return FBResponseWithObject(@{@"pending":@YES});
    }
    UIPasteboard *pb = UIPasteboard.generalPasteboard;
    if (writing) {
      // Keep USB transfers local to this phone instead of broadcasting via Handoff.
      [pb setItems:@[@{type:value}] options:@{UIPasteboardOptionLocalOnly:@YES}];
      return FBResponseWithObject(@{@"format":format, @"bytes":@(data.length)});
    }
    if (!FBIPortalRead) {
      NSString *format = pb.hasImages ? @"image" : pb.hasURLs ? @"url" : pb.hasStrings ? @"text" : nil;
      if (!format) return FBResponseWithObject(@{@"empty":@YES});
      FBIPortalClipboardRead *read = [FBIPortalClipboardRead new];
      read.format = format; read.revision = pb.changeCount; read.group = dispatch_group_create();
      FBIPortalRead = read; FBIPortalPendingPaste = read.group;
      dispatch_group_async(read.group, dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
        if ([format isEqual:@"image"]) { UIImage *image = pb.image; read.data = image ? UIImagePNGRepresentation(image) : nil; }
        else { NSString *text = [format isEqual:@"url"] ? pb.URL.absoluteString : pb.string; read.data = [text dataUsingEncoding:NSUTF8StringEncoding]; }
      });
    }
    FBIPortalClipboardRead *read = FBIPortalRead;
    // Do not spin inside an HTTP handler: UIKit's paste authorization needs the
    // main dispatch queue to be free. The host checks this short-lived operation.
    if (dispatch_group_wait(read.group, DISPATCH_TIME_NOW) != 0) {
      finished = NO;
      return FBResponseWithObject(@{@"pending":@YES});
    }
    NSData *result = read.data;
    NSString *readFormat = read.format;
    NSInteger revision = read.revision;
    if (XCUIDevice.sharedDevice.fb_isScreenLocked || UIApplication.sharedApplication.applicationState != UIApplicationStateActive)
      return [self failure:@"Device state changed; try again"];
    if (pb.changeCount != revision) return [self failure:@"Device clipboard changed; try again"];
    if (!result.length) return [self failure:@"Clipboard access was not allowed or the clipboard is empty"];
    if (result.length > FBIPortalClipboardLimit) return [self failure:@"Clipboard is too large (4 MB maximum)"];
    return FBResponseWithObject(@{@"format":readFormat, @"content":[result base64EncodedStringWithOptions:0]});
  } @finally {
    // Leave the HTTP handler before restoring so UIKit can complete the handoff.
    if (finished) dispatch_async(dispatch_get_main_queue(), ^{ [self restore]; });
  }
}
@end
