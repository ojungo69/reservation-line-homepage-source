import { describe, expect, it } from "vitest";

import { fetchAdminActionIdempotency } from "../src/admin/settings-common";
import { createMigratedSqliteD1, type SqliteD1Database } from "./helpers/sqlite-d1";

// Proves the R1 root / B8 fix: fetchAdminActionIdempotency's expires_at TTL
// predicate is judged against the OPTIONAL injected `nowIso` clock (so admin
// create-flows that stamp `expires_at` from the same injected clock read and
// write against one clock), and falls back to wall-clock `datetime('now')`
// when `nowIso` is omitted (legacy callers are byte-for-byte unchanged).

const insertRow = (
  db: SqliteD1Database,
  opts: { key: string; expiresAt: string; status?: "started" | "succeeded" | "failed"; requestHash?: string }
) => {
  db.sqlite
    .prepare(
      `INSERT INTO idempotency_keys (id, scope, idempotency_key, status, request_hash, target_id, expires_at)
       VALUES (?, 'admin_action', ?, ?, ?, 'target-1', ?)`
    )
    .run(`idem_${opts.key}`, opts.key, opts.status ?? "succeeded", opts.requestHash ?? "hash", opts.expiresAt);
};

describe("fetchAdminActionIdempotency nowIso TTL filter", () => {
  it("returns the row when nowIso precedes expires_at (within TTL)", async () => {
    const db = createMigratedSqliteD1();
    try {
      insertRow(db, { key: "live", expiresAt: "2099-12-31T00:00:00.000Z" });
      const row = await fetchAdminActionIdempotency(
        db as unknown as D1Database,
        "live",
        "2099-06-01T00:00:00.000Z"
      );
      expect(row?.status).toBe("succeeded");
    } finally {
      db.sqlite.close();
    }
  });

  it("filters out the row when nowIso is past expires_at (expired)", async () => {
    const db = createMigratedSqliteD1();
    try {
      insertRow(db, { key: "expired", expiresAt: "2099-01-01T00:00:00.000Z" });
      const row = await fetchAdminActionIdempotency(
        db as unknown as D1Database,
        "expired",
        "2099-06-01T00:00:00.000Z"
      );
      expect(row).toBeNull();
    } finally {
      db.sqlite.close();
    }
  });

  it("judges expiry against the INJECTED clock, not wall-clock — discriminates the nowIso param", async () => {
    const db = createMigratedSqliteD1();
    try {
      // expires_at is FAR in the future relative to the real wall clock but in
      // the PAST relative to the injected 2100 clock. The two branches below
      // can only diverge if the SELECT actually binds the injected nowIso.
      insertRow(db, { key: "discriminate", expiresAt: "2099-01-01T00:00:00.000Z" });
      // Injected future clock → row expired → filtered.
      expect(
        await fetchAdminActionIdempotency(
          db as unknown as D1Database,
          "discriminate",
          "2100-01-01T00:00:00.000Z"
        )
      ).toBeNull();
      // Omitted nowIso → wall-clock datetime('now') → 2099 is still future → row live.
      expect(
        (await fetchAdminActionIdempotency(db as unknown as D1Database, "discriminate"))?.status
      ).toBe("succeeded");
    } finally {
      db.sqlite.close();
    }
  });
});
