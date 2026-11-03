import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { apiError } from "./errors.mjs";

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, canonical(value[k])]),
    );
  return value;
}
export const fingerprint = (value) =>
  crypto
    .createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");

// Store hashes and small receipts only, never input text, screenshots or UI trees.
/** @param {{file?: string, capacity?: number, ttlMs?: number}} [options] */
export function createCommands({ file, capacity = 4096, ttlMs = 86400000 } = {}) {
  const records = new Map();
  if (file && fs.existsSync(file)) {
    for (const record of JSON.parse(fs.readFileSync(file, "utf8"))) {
      if (Date.now() - record.updatedAt > ttlMs) continue;
      if (["queued", "running"].includes(record.state)) {
        record.state = "unknown";
        record.response = {
          status: 409,
          body: {
            ok: false,
            code: "outcome unknown",
            error:
              "Server restarted during this command; inspect the phone before sending another action",
            requestId: record.id,
          },
        };
      }
      records.set(record.id, record);
    }
  }
  function persist() {
    for (const [id, r] of records)
      if (!r.promise && Date.now() - r.updatedAt > ttlMs) records.delete(id);
    if (!file) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(
      temp,
      JSON.stringify(
        [...records.values()].map(({ promise, ...r }) => {
          if (!r.response) return r;
          // Upstream error details may echo text or UI content. Persist only the receipt.
          const { ok, requestId, outcome, verified, code } = r.response.body;
          return {
            ...r,
            response: {
              status: r.response.status,
              body: {
                ok,
                requestId,
                outcome,
                verified,
                code,
                ...(!ok ? { error: code ?? "Command failed" } : {}),
              },
            },
          };
        }),
      ),
      { mode: 0o600 },
    );
    fs.renameSync(temp, file);
  }
  persist();
  function get(id) {
    const r = records.get(id);
    return r ? { id: r.id, state: r.state, updatedAt: r.updatedAt, response: r.response } : null;
  }
  async function execute(id, input, run) {
    const hash = fingerprint(input);
    const prior = records.get(id);
    if (prior) {
      if (prior.hash !== hash)
        throw apiError("Request ID was already used with different input", 409, "request conflict");
      return prior.promise ?? prior.response;
    }
    persist();
    if (records.size >= capacity) {
      throw apiError(
        "Command receipt capacity reached; retry after retention expires",
        429,
        "receipt capacity",
      );
    }
    const record = { id, hash, state: "queued", updatedAt: Date.now() };
    records.set(id, record);
    persist();
    const mark = (state) => {
      record.state = state;
      record.updatedAt = Date.now();
      persist();
    };
    record.promise = Promise.resolve()
      .then(() => run(mark))
      .then(
        (response) => {
          record.response = response;
          record.state = response.body.outcome ?? (response.body.ok ? "completed" : "failed");
          return response;
        },
        (error) => {
          record.state = "unknown";
          record.response = {
            status: 500,
            body: {
              ok: false,
              requestId: id,
              outcome: "unknown",
              error: "Command outcome unavailable",
              code: "outcome unknown",
            },
          };
          throw error;
        },
      )
      .finally(() => {
        delete record.promise;
        record.updatedAt = Date.now();
        persist();
      });
    return record.promise;
  }
  return { execute, get };
}
