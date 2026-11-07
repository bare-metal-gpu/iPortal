import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Database } from "bun:sqlite";
import { Schema } from "effect";
import { OutcomeSchema } from "./public-contracts.ts";
import { apiError } from "./errors.mjs";

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => [key, canonical(item)]),
    );
  return value;
}
export const fingerprint = (value: unknown): string =>
  crypto
    .createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");

const optional = Schema.optionalKey;
const ReceiptResponse = Schema.Struct({
  status: Schema.Finite.check(Schema.isInt(), Schema.isBetween({ minimum: 100, maximum: 599 })),
  body: Schema.Struct({
    ok: Schema.Boolean,
    requestId: optional(Schema.String),
    outcome: optional(OutcomeSchema),
    verified: optional(Schema.Boolean),
    code: optional(Schema.String),
    error: optional(Schema.String),
    clipboardChanged: optional(Schema.Boolean),
  }),
});
export type CommandResponse = Schema.Schema.Type<typeof ReceiptResponse>;
type Receipt = { id: string; state: string; updatedAt: number; response: CommandResponse | null };
type Row = { id: string; hash: string; state: string; updatedAt: number; response: string | null };
const decodeResponse = Schema.decodeUnknownSync(ReceiptResponse);
function compact(response: CommandResponse): CommandResponse {
  const { ok, requestId, outcome, verified, code, clipboardChanged } = response.body;
  return decodeResponse({
    status: response.status,
    body: Object.fromEntries(
      Object.entries({
        ok,
        requestId,
        outcome,
        verified,
        code,
        clipboardChanged,
        ...(!ok ? { error: code ?? "Command failed" } : {}),
      }).filter(([, value]) => value !== undefined),
    ),
  });
}
const unknownResponse = (id: string): CommandResponse => ({
  status: 409,
  body: {
    ok: false,
    requestId: id,
    outcome: "unknown",
    code: "outcome unknown",
    error: "Server restarted during this command; inspect the phone before sending another action",
  },
});

// A small hot cache is independent of the durable 24-hour replay window. Each
// transition writes one row; input never rewrites an ever-growing JSON ledger.
export function createCommands({
  file,
  capacity = 4096,
  ttlMs = 86400000,
  now = Date.now,
}: { file?: string; capacity?: number; ttlMs?: number; now?: () => number } = {}) {
  const databasePath = file ? (file.endsWith(".json") ? file + ".sqlite" : file) : ":memory:";
  if (file) fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const db = new Database(databasePath, { create: true });
  if (file) fs.chmodSync(databasePath, 0o600);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=1000;");
  db.exec(
    "CREATE TABLE IF NOT EXISTS receipts (id TEXT PRIMARY KEY, hash TEXT NOT NULL, state TEXT NOT NULL, updatedAt REAL NOT NULL, response TEXT); CREATE INDEX IF NOT EXISTS receipts_expiry ON receipts(updatedAt)",
  );
  const lookup = db.query<Row, [string]>("SELECT * FROM receipts WHERE id=?");
  const write = db.query("INSERT OR REPLACE INTO receipts VALUES (?, ?, ?, ?, ?)");
  const clean = db.query(
    "DELETE FROM receipts WHERE updatedAt < ? AND state NOT IN ('queued','running')",
  );
  const hot = new Map<string, Row>();
  const active = new Map<string, Promise<CommandResponse>>();
  const put = (r: Row) => {
    write.run(r.id, r.hash, r.state, r.updatedAt, r.response);
    hot.delete(r.id);
    hot.set(r.id, r);
    while (hot.size > capacity) hot.delete(hot.keys().next().value!);
  };
  // Migrate the previous receipt-only JSON format in one durable transaction.
  // The legacy file is removed only after the commit; repeats are idempotent.
  if (file && databasePath !== file && fs.existsSync(file)) {
    const legacy: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    const rowSchema = Schema.Struct({
      id: Schema.String,
      hash: Schema.String,
      state: Schema.String,
      updatedAt: Schema.Finite,
      response: optional(ReceiptResponse),
    });
    const records = Schema.decodeUnknownSync(Schema.Array(rowSchema))(legacy);
    db.transaction(() => {
      for (const r of records) {
        if (!lookup.get(r.id) && now() - r.updatedAt <= ttlMs)
          put({ ...r, response: r.response ? JSON.stringify(compact(r.response)) : null });
      }
    })();
    fs.unlinkSync(file);
  }
  for (const r of db
    .query<Row, []>("SELECT * FROM receipts WHERE state IN ('queued','running')")
    .all())
    put({ ...r, state: "unknown", response: JSON.stringify(unknownResponse(r.id)) });
  let lastCleanup = now();
  clean.run(lastCleanup - ttlMs);
  const load = (id: string): Row | null => {
    const cached = hot.get(id) ?? lookup.get(id);
    if (!cached) return null;
    if (!active.has(id) && now() - cached.updatedAt > ttlMs) return null;
    return cached;
  };
  const get = (id: string): Receipt | null => {
    const r = load(id);
    return r
      ? {
          id: r.id,
          state: r.state,
          updatedAt: r.updatedAt,
          response: r.response ? decodeResponse(JSON.parse(r.response)) : null,
        }
      : null;
  };
  async function execute(
    id: string,
    input: unknown,
    run: (mark: (state: string) => void) => Promise<CommandResponse>,
  ): Promise<CommandResponse> {
    const hash = fingerprint(input),
      prior = load(id);
    if (prior) {
      if (prior.hash !== hash)
        throw apiError("Request ID was already used with different input", 409, "request conflict");
      return (
        active.get(id) ??
        (prior.response ? decodeResponse(JSON.parse(prior.response)) : unknownResponse(id))
      );
    }
    if (now() - lastCleanup >= 60000) {
      clean.run(now() - ttlMs);
      lastCleanup = now();
      for (const [key, r] of hot)
        if (!active.has(key) && now() - r.updatedAt > ttlMs) hot.delete(key);
    }
    const record: Row = { id, hash, state: "queued", updatedAt: now(), response: null };
    put(record);
    const mark = (state: string) => {
      record.state = state;
      record.updatedAt = now();
      put(record);
    };
    const promise = Promise.resolve()
      .then(() => run(mark))
      .then(
        (response) => {
          record.response = JSON.stringify(compact(response));
          record.state = response.body.outcome ?? (response.body.ok ? "completed" : "failed");
          return response;
        },
        (error: unknown) => {
          record.state = "unknown";
          record.response = JSON.stringify(unknownResponse(id));
          throw error;
        },
      )
      .finally(() => {
        record.updatedAt = now();
        put(record);
        active.delete(id);
      });
    active.set(id, promise);
    return promise;
  }
  return { execute, get, close: () => db.close(), databasePath };
}
