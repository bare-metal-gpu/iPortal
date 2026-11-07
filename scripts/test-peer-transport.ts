import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Schema } from "effect";

if (process.platform !== "darwin") process.exit(0);
const root = fileURLToPath(new URL("../", import.meta.url));
const directory = await mkdtemp(path.join(tmpdir(), "iportal-peer-test-"));
const nonnegative = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));
const count = nonnegative.check(Schema.isInt());
const optional = Schema.optionalKey;
const ResultSchema = Schema.Struct({
  mode: Schema.Literals([
    "roundtrip",
    "wrongKey",
    "wrongIdentity",
    "oversized",
    "deadline",
    "cancellation",
  ]),
  exchanges: count,
  pathEvents: count,
  viabilityEvents: count,
  betterPathEvents: count,
  elapsedMs: nonnegative,
  activeRequestMs: optional(nonnegative),
  establishmentMs: optional(nonnegative),
  transportRTTMs: optional(nonnegative),
  sentBytes: optional(count),
  receivedBytes: optional(count),
  tlsVersion: optional(count),
  cipherSuite: optional(count),
  authenticationRejected: Schema.Boolean,
  tlsRejectionCode: optional(Schema.Finite.check(Schema.isInt(), Schema.isLessThan(0))),
  oversizedRejected: Schema.Boolean,
  deadlineExpired: Schema.Boolean,
  cancelled: Schema.Boolean,
  requestObserved: Schema.Boolean,
  loopbackOnly: Schema.Literals([true]),
  includePeerToPeerConfigured: Schema.Literals([true]),
});

async function run(command: string[], timeoutMs: number): Promise<string> {
  const child = Bun.spawn(command, { cwd: root, stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
  try {
    const [status, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    if (status !== 0) throw new Error(`${path.basename(command[0])} failed (${status}): ${stderr}`);
    return stdout;
  } finally {
    clearTimeout(timer);
  }
}

try {
  const source = "experiments/apple-bridge/NetworkProbe.swift";
  const executable = path.join(directory, "NetworkProbe");
  const architecture = process.arch === "arm64" ? "arm64" : "x86_64";
  await run(
    [
      "xcrun",
      "swiftc",
      "-parse-as-library",
      "-target",
      `${architecture}-apple-macos14.0`,
      source,
      "-o",
      executable,
    ],
    60_000,
  );
  await run(
    [
      "xcrun",
      "--sdk",
      "iphoneos",
      "swiftc",
      "-typecheck",
      "-parse-as-library",
      "-target",
      "arm64-apple-ios17.0",
      source,
    ],
    60_000,
  );
  const output = await run([executable], 15_000);
  assert(Buffer.byteLength(output) <= 64 * 1024, "Unexpected result size");
  const results = Schema.decodeUnknownSync(Schema.Array(ResultSchema))(JSON.parse(output));
  assert.deepEqual(
    results.map((r) => r.mode),
    ["roundtrip", "wrongKey", "wrongIdentity", "oversized", "deadline", "cancellation"],
  );
  const roundtrip = results[0];
  assert.equal(roundtrip.exchanges, 30);
  assert.equal(roundtrip.sentBytes, 30 * (4 + 21 + 128));
  assert.equal(roundtrip.receivedBytes, roundtrip.sentBytes);
  assert(roundtrip.pathEvents > 0 && roundtrip.viabilityEvents > 0);
  assert(roundtrip.establishmentMs !== undefined && roundtrip.transportRTTMs !== undefined);
  for (const result of results) {
    if (result.mode === "wrongKey" || result.mode === "wrongIdentity") {
      assert(result.authenticationRejected && !result.requestObserved);
      assert.equal(result.exchanges, 0);
      // Exact observed Security errors distinguish a bad MAC/unknown PSK from
      // an unrelated connection failure, deadline or absent server.
      assert.equal(result.tlsRejectionCode, result.mode === "wrongKey" ? -9846 : -9864);
    } else {
      assert.equal(result.tlsVersion, 0x0303, "Expected TLS 1.2 for Apple's PSK API");
      assert.equal(result.cipherSuite, 0x00a8, "Expected TLS_PSK_WITH_AES_128_GCM_SHA256");
      assert(!result.authenticationRejected);
    }
  }
  assert(results[3].oversizedRejected && !results[3].requestObserved);
  assert(results[4].deadlineExpired && results[4].requestObserved);
  assert(results[4].activeRequestMs !== undefined && results[4].activeRequestMs >= 50);
  assert(results[5].cancelled && results[5].requestObserved);
  assert(results[5].activeRequestMs !== undefined);
  assert.equal(results[4].exchanges + results[5].exchanges, 0);
  console.log(JSON.stringify(results, null, 2));
  console.log(
    "Peer transport: 30 authenticated TLS 1.2 loopback exchanges; wrong key/identity, frame bounds, admitted-request deadline/cancellation passed. iOS 17 API typecheck passed. No LAN/AWDL/device/handover evidence.",
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
