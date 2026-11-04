import { test, expect } from "bun:test";
import { createHelperAuthentication, createSecretRedactor } from "../helper-auth.mjs";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

test("helper credentials are private, unique, validated and never silently downgraded", () => {
  const first = createHelperAuthentication(),
    second = createHelperAuthentication();
  expect(first.headers.authorization).not.toBe(second.headers.authorization);
  expect(first.headers.authorization).toMatch(/^Bearer [a-f0-9]{64}$/);
  expect(first.verified).toBe(false);
  expect(() => createHelperAuthentication("")).toThrow();
  expect(() => createHelperAuthentication("bad\ncredential")).toThrow();
  expect(() => first.verify(new Response("{}"))).toThrow();
  expect(() =>
    first.verify(new Response("", { status: 401, headers: { "x-iportal-helper-auth": "1" } })),
  ).toThrow();
  first.verify(new Response("{}", { headers: { "x-iportal-helper-auth": "1" } }));
  expect(first.verified).toBe(true);
  first.reset();
  expect(first.verified).toBe(false);
});

test("helper launch logging redacts credentials across every chunk boundary", () => {
  const token = Array.from({ length: 64 }, (_, i) => (i % 16).toString(16)).join("");
  const source = Buffer.from(`launch café 🙂\nTOKEN=${token}\nTOKEN=${token}`);
  for (let split = 0; split <= source.length; split++) {
    const redactor = createSecretRedactor(token);
    const output =
      redactor.write(source.subarray(0, split)) +
      redactor.write(source.subarray(split)) +
      redactor.end();
    expect(output).toBe("launch café 🙂\nTOKEN=[redacted]\nTOKEN=[redacted]");
  }
});

test("shipped native authentication rejects missing, wrong, browser and malformed stream requests", async () => {
  if (process.platform !== "darwin") return;
  const scratch = await mkdtemp(path.join(os.tmpdir(), "iportal-auth-"));
  try {
    const header = path.resolve(import.meta.dirname, "../ios/FBIPortalAuthentication.h");
    const source = `#import "${header}"
int main(void) { @autoreleasepool {
  NSString *token = [@"a" stringByPaddingToLength:64 withString:@"a" startingAtIndex:0];
  NSString *other = [@"b" stringByPaddingToLength:64 withString:@"b" startingAtIndex:0];
  NSDictionary *good = @{@"authorization":[@"Bearer " stringByAppendingString:token]};
  NSCAssert(FBIPortalHeadersAuthorized(good, token), @"authorized");
  NSCAssert(!FBIPortalHeadersAuthorized(good, nil), @"unconfigured fails closed");
  NSCAssert(!FBIPortalHeadersAuthorized(good, @""), @"empty fails closed");
  NSCAssert(!FBIPortalHeadersAuthorized(good, other), @"previous or other device credential rejected");
  NSCAssert(!FBIPortalHeadersAuthorized(@{}, token), @"missing rejected");
  for (NSString *key in @[@"origin", @"sec-fetch-site"]) {
    NSMutableDictionary *browser = good.mutableCopy; browser[key] = @"";
    NSCAssert(!FBIPortalHeadersAuthorized(browser, token), @"browser even with a credential rejected");
  }
  NSString *request = [NSString stringWithFormat:@"GET / HTTP/1.1\\r\\nHost: 127.0.0.1:9100\\r\\nAuthorization: Bearer %@\\r\\n\\r\\n", token];
  NSData *data = [request dataUsingEncoding:NSUTF8StringEncoding];
  for (NSUInteger i=0; i<data.length; i++)
    NSCAssert(FBIPortalVideoRequestStatus([data subdataWithRange:NSMakeRange(0,i)],token)==0, @"fragmented headers reveal no frames");
  NSCAssert(FBIPortalVideoRequestStatus(data, token)==200, @"complete authenticated request");
  NSCAssert(FBIPortalVideoRequestStatus(data, nil)==401, @"unconfigured stream");
  NSCAssert(FBIPortalVideoRequestStatus(data, other)==401, @"wrong stream credential");
  for (NSString *bad in @[
    [request stringByAppendingString:@"GET / HTTP/1.1\\r\\n\\r\\n"],
    [request stringByReplacingOccurrencesOfString:@"GET /" withString:@"POST /"],
    [request stringByReplacingOccurrencesOfString:@"Authorization:" withString:@"Authorization :"],
    [request stringByReplacingOccurrencesOfString:@"Host:" withString:@"Host: repeated\\r\\nHost:"],
    [request stringByReplacingOccurrencesOfString:@"Host:" withString:@"Content-Length: 1\\r\\nHost:"],
    [request stringByReplacingOccurrencesOfString:@"Host:" withString:@"Transfer-Encoding: chunked\\r\\nHost:"],
    [request stringByReplacingOccurrencesOfString:@"Host:" withString:@"Origin: https://evil.example\\r\\nHost:"],
    [request stringByReplacingOccurrencesOfString:@"Host:" withString:@"Authorization: Bearer wrong\\r\\nHost:"]])
    NSCAssert(FBIPortalVideoRequestStatus([bad dataUsingEncoding:NSUTF8StringEncoding],token)>=400, @"malformed rejected");
  NSCAssert(FBIPortalVideoRequestStatus([NSMutableData dataWithLength:16385],token)==431, @"bounded headers");
} return 0; }`;
    const file = path.join(scratch, "auth.m"),
      binary = path.join(scratch, "auth");
    await writeFile(file, source);
    execFileSync(
      "xcrun",
      ["clang", "-fobjc-arc", "-Werror", "-framework", "Foundation", file, "-o", binary],
      { stdio: "pipe" },
    );
    execFileSync(binary, [], { stdio: "pipe" });
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
