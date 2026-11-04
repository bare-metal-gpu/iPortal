#pragma once
#import <Foundation/Foundation.h>

// Shared by HTTP commands and the bounded MJPEG handshake. Missing or malformed
// provisioning fails closed, including a runner launched directly from Xcode.
static inline BOOL FBIPortalValidToken(NSString *token)
{
  if (token.length != 64) return NO;
  return [token rangeOfCharacterFromSet:[[NSCharacterSet characterSetWithCharactersInString:@"0123456789abcdef"] invertedSet]].location == NSNotFound;
}

static inline NSString *FBIPortalHelperToken(void)
{
  static NSString *token;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    NSString *candidate = NSProcessInfo.processInfo.environment[@"IPORTAL_HELPER_TOKEN"];
    if (FBIPortalValidToken(candidate)) token = [candidate copy];
  });
  return token;
}

static inline BOOL FBIPortalHeadersAuthorized(NSDictionary<NSString *, NSString *> *headers, NSString *token)
{
  if (!FBIPortalValidToken(token) || headers[@"origin"] != nil || headers[@"sec-fetch-site"] != nil) return NO;
  NSString *expected = [@"Bearer " stringByAppendingString:token];
  NSData *actual = [headers[@"authorization"] dataUsingEncoding:NSUTF8StringEncoding];
  NSData *wanted = [expected dataUsingEncoding:NSUTF8StringEncoding];
  if (actual.length != wanted.length) return NO;
  const uint8_t *a = actual.bytes, *b = wanted.bytes;
  volatile uint8_t difference = 0;
  for (NSUInteger i = 0; i < wanted.length; i++) difference |= a[i] ^ b[i];
  return difference == 0;
}

static const NSUInteger FBIPortalMaxVideoHeaderBytes = 16 * 1024;
static const NSTimeInterval FBIPortalVideoHandshakeTimeout = 5;

// 0 means incomplete; only 200 permits capture. No request body, pipelining,
// duplicate headers or ambiguous HTTP syntax is accepted by this stream endpoint.
static inline NSInteger FBIPortalVideoRequestStatus(NSData *data, NSString *token)
{
  if (data.length > FBIPortalMaxVideoHeaderBytes) return 431;
  NSData *terminator = [@"\r\n\r\n" dataUsingEncoding:NSUTF8StringEncoding];
  NSRange end = [data rangeOfData:terminator options:0 range:NSMakeRange(0, data.length)];
  if (end.location == NSNotFound) return 0;
  if (end.location + end.length != data.length) return 400;
  NSString *text = [[NSString alloc] initWithData:[data subdataWithRange:NSMakeRange(0, end.location)] encoding:NSUTF8StringEncoding];
  if (!text) return 400;
  NSArray<NSString *> *lines = [text componentsSeparatedByString:@"\r\n"];
  if (![@[@"GET / HTTP/1.1", @"GET / HTTP/1.0"] containsObject:lines.firstObject]) return 400;
  NSMutableDictionary *headers = [NSMutableDictionary dictionary];
  NSCharacterSet *badName = [[NSCharacterSet characterSetWithCharactersInString:@"!#$%&'*+-.^_`|~0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"] invertedSet];
  for (NSUInteger i = 1; i < lines.count; i++) {
    NSString *line = lines[i];
    NSRange colon = [line rangeOfString:@":"];
    if (colon.location == NSNotFound || colon.location == 0) return 400;
    NSString *name = [[line substringToIndex:colon.location] lowercaseString];
    NSString *value = [[line substringFromIndex:colon.location + 1] stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceCharacterSet];
    if ([name rangeOfCharacterFromSet:badName].location != NSNotFound || headers[name] != nil ||
        [value rangeOfCharacterFromSet:NSCharacterSet.controlCharacterSet].location != NSNotFound) return 400;
    headers[name] = value;
  }
  if (!FBIPortalHeadersAuthorized(headers, token)) return 401;
  if (![headers[@"host"] length] || headers[@"transfer-encoding"] != nil ||
      (headers[@"content-length"] != nil && ![headers[@"content-length"] isEqualToString:@"0"])) return 400;
  return 200;
}
