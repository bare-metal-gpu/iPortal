// Explicit live check against a running mirror's private USB socket directory.
// Usage: bun scripts/test-helper-auth-phone.mjs /tmp/iportal-usb-XXXXXX [base-url]
// No real credential is read or printed. All raw probes are unauthorized; the
// normal Mac API supplies its own credential for the positive checks.
import assert from "node:assert/strict";
import net from "node:net";
import path from "node:path";

const directory = process.argv[2];
if (!directory) throw new Error("Pass the running mirror's USB socket directory.");
const base = process.argv[3] ?? "http://127.0.0.1:7100";
const wrong = "b".repeat(64);

/** @param {string} service @param {string} request @returns {Promise<Buffer>} */
async function probe(service, request, { fragmented = false, idle = false } = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(path.join(directory, `${service}.sock`));
    /** @type {Buffer[]} */
    const chunks = [];
    let bytes = 0;
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`${service}: authentication deadline exceeded`));
    }, 8000);
    socket.on("error", reject);
    socket.on("data", (chunk) => {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
      bytes += chunk.length;
      if (bytes > 65536) {
        socket.destroy();
        reject(new Error(`${service}: unauthenticated stream leaked bytes`));
      }
    });
    socket.on("close", () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks));
    });
    socket.on("connect", () => {
      if (idle) return;
      if (!fragmented) return socket.write(request);
      socket.write(request.slice(0, -2));
      setTimeout(() => {
        if (bytes !== 0 || socket.destroyed) {
          socket.destroy();
          reject(new Error(`${service}: responded before complete authentication headers`));
        } else socket.write(request.slice(-2));
      }, 150);
    });
  });
}

for (const [method, route] of [
  ["GET", "/v1/status"],

  ["POST", "/v1/commands"],
]) {
  for (const auth of ["", `Authorization: Bearer ${wrong}\r\n`]) {
    // An unauthorized command must fail before waiting for/decoding its body.
    const bodyLength = method === "POST" ? "Content-Length: 100000\r\n" : "";
    const reply = await probe(
      "helper",
      `${method} ${route} HTTP/1.1\r\nHost: localhost\r\n${auth}${bodyLength}\r\n`,
    );
    assert.match(reply.toString(), /^HTTP\/1\.[01] 401 /);
    assert.doesNotMatch(reply.toString(), /access-control-allow-origin/i);
  }
}
console.log("✓ Real helper rejects missing/wrong command credentials before body or action");

for (const auth of ["", `Authorization: Bearer ${wrong}\r\n`]) {
  const reply = await probe("helper", `GET /v1/video HTTP/1.1\r\nHost: localhost\r\n${auth}\r\n`, {
    fragmented: true,
  });
  assert.match(reply.toString(), /^HTTP\/1\.[01] 401 /);
  assert.equal(reply.indexOf("\r\n\r\n") + 4, reply.length, "no image/body on rejected stream");
}
assert.match(
  (
    await probe(
      "helper",
      `GET /v1/video HTTP/1.1\r\nHost: localhost\r\nX: ${"x".repeat(16384)}\r\n\r\n`,
    )
  ).toString(),
  /^HTTP\/1\.[01] 431 /,
);
assert.equal((await probe("helper", "", { idle: true })).length, 0);
console.log(
  "✓ Real video waits for complete authentication, rejects wrong keys/oversized headers, expires idle handshakes, leaks no frames",
);

const status = /** @type {{lifecycle: string}} */ (
  await (await fetch(`${base}/api/status`)).json()
);
assert.equal(status.lifecycle, "ready");
const state = /** @type {{ok: boolean, value: {locked: boolean}}} */ (
  await fetch(`${base}/api/state`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  }).then((r) => r.json())
);
assert.equal(state.ok, true);
assert.equal(state.value.locked, false);
const video = await fetch(`${base}/stream`, { signal: AbortSignal.timeout(10000) });
assert.equal(video.status, 200);
assert.match(video.headers.get("content-type") ?? "", /multipart/);
assert(video.body);
const reader = video.body.getReader();
let imageBytes = Buffer.alloc(0);
try {
  while (imageBytes.indexOf(Buffer.from([0xff, 0xd8])) < 0) {
    const next = await reader.read();
    assert.equal(next.done, false);
    imageBytes = Buffer.concat([imageBytes, next.value]);
    assert.ok(imageBytes.length < 1024 * 1024, "bounded frame preamble");
  }
} finally {
  await reader.cancel();
}
console.log(
  "✓ Automatic Mac authentication supports device state and actual JPEG video after all rejection probes",
);
