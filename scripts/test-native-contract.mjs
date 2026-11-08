// Compile and exercise the exact protocol, reducer, executor, and HTTP transport
// used by the phone runner. These tests do not claim XCTest hardware coverage.
import path from "node:path";
const child = Bun.spawn(
  ["swift", "test", "--package-path", path.resolve(import.meta.dirname, "../ios/Helper")],
  { stdout: "inherit", stderr: "inherit" },
);
process.exitCode = await child.exited;
