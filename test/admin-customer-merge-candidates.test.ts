import { describe, expect, it } from "vitest";

import { listCustomerMergeCandidates } from "../src/admin/customers";
import { createMigratedSqliteD1, type SqliteD1Database } from "./helpers/sqlite-d1";

const STORE_ID = "store_merge_dom";
const SERVICE_ID = "service_merge_dom";
const RESOURCE_ID = "resource_merge_dom";

const seedStoreScaffold = (db: SqliteD1Database) => {
  db.sqlite
    .prepare(`INSERT INTO stores (id, name, timezone) VALUES (?, ?, ?)`)
    .run(STORE_ID, "Store Merge Domain", "Asia/Tokyo");
  db.sqlite
    .prepare(`INSERT INTO store_resources (id, store_id, name) VALUES (?, ?, ?)`)
    .run(RESOURCE_ID, STORE_ID, "Resource Merge Domain");
  db.sqlite
    .prepare(`INSERT INTO services (id, store_id, name, duration_minutes) VALUES (?, ?, ?, ?)`)
    .run(SERVICE_ID, STORE_ID, "Service Merge Domain", 60);
};

const insertCustomer = (
  db: SqliteD1Database,
  args: { id: string; phoneHash: string | null; mergedIntoId?: string | null }
) => {
  db.sqlite
    .prepare(
      `INSERT INTO customers (id, display_name, phone_normalized, phone_hash, merged_into_id)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(
      args.id,
      `Customer ${args.id}`,
      "0700000000",
      args.phoneHash,
      args.mergedIntoId ?? null
    );
};

const insertReservation = (
  db: SqliteD1Database,
  args: { id: string; customerId: string; startAt: string; endAt: string }
) => {
  db.sqlite
    .prepare(
      `INSERT INTO reservations (
         id, store_id, service_id, customer_id, resource_id, source, status,
         start_at, end_at, duration_minutes, idempotency_key
       ) VALUES (?, ?, ?, ?, ?, 'admin', 'confirmed', ?, ?, 60, ?)`
    )
    .run(
      args.id,
      STORE_ID,
      SERVICE_ID,
      args.customerId,
      RESOURCE_ID,
      args.startAt,
      args.endAt,
      `idem_${args.id}`
    );
};

describe("listCustomerMergeCandidates domain", () => {
  it("only surfaces phone_hash clusters with more than one non-tombstoned customer", async () => {
    const db = createMigratedSqliteD1();
    try {
      // Cluster A: two live customers sharing a hash → should surface.
      insertCustomer(db, { id: "dup_a1", phoneHash: "hash_dup" });
      insertCustomer(db, { id: "dup_a2", phoneHash: "hash_dup" });
      // Singleton: one live customer on a unique hash → must NOT surface.
      insertCustomer(db, { id: "single", phoneHash: "hash_single" });
      // No-hash customers never group regardless of count.
      insertCustomer(db, { id: "nohash_1", phoneHash: null });
      insertCustomer(db, { id: "nohash_2", phoneHash: null });

      const result = await listCustomerMergeCandidates({ db: db as unknown as D1Database });

      expect(result.ok).toBe(true);
      expect(result.truncated).toBe(false);
      expect(result.groups).toHaveLength(1);
      expect(result.groups[0].phoneHash).toBe("hash_dup");
      expect(result.groups[0].customers.map((c) => c.id).sort()).toEqual(["dup_a1", "dup_a2"]);
    } finally {
      db.sqlite.close();
    }
  });

  it("excludes tombstoned (merged_into_id IS NOT NULL) rows from grouping", async () => {
    const db = createMigratedSqliteD1();
    try {
      // Three rows share the hash, but one is a merged tombstone. Only the two
      // live rows count, so the cluster still surfaces — without the tombstone.
      insertCustomer(db, { id: "keep_a", phoneHash: "hash_tomb" });
      insertCustomer(db, { id: "keep_b", phoneHash: "hash_tomb" });
      insertCustomer(db, {
        id: "tomb_c",
        phoneHash: "hash_tomb",
        mergedIntoId: "keep_a"
      });
      // A hash with one live + one tombstone → only 1 live row → must NOT surface.
      insertCustomer(db, { id: "lone_live", phoneHash: "hash_lone" });
      insertCustomer(db, {
        id: "lone_tomb",
        phoneHash: "hash_lone",
        mergedIntoId: "lone_live"
      });

      const result = await listCustomerMergeCandidates({ db: db as unknown as D1Database });

      expect(result.groups).toHaveLength(1);
      const group = result.groups[0];
      expect(group.phoneHash).toBe("hash_tomb");
      const ids = group.customers.map((c) => c.id).sort();
      expect(ids).toEqual(["keep_a", "keep_b"]);
      expect(ids).not.toContain("tomb_c");
    } finally {
      db.sqlite.close();
    }
  });

  it("reports lastReservationAt as MAX(reservations.start_at) per customer", async () => {
    const db = createMigratedSqliteD1();
    try {
      seedStoreScaffold(db);
      insertCustomer(db, { id: "res_a", phoneHash: "hash_res" });
      insertCustomer(db, { id: "res_b", phoneHash: "hash_res" });

      // res_a has two reservations; the later start_at must win.
      insertReservation(db, {
        id: "r_early",
        customerId: "res_a",
        startAt: "2026-08-01T01:00:00.000Z",
        endAt: "2026-08-01T02:00:00.000Z"
      });
      insertReservation(db, {
        id: "r_late",
        customerId: "res_a",
        startAt: "2026-09-15T03:00:00.000Z",
        endAt: "2026-09-15T04:00:00.000Z"
      });
      // res_b has no reservations → lastReservationAt should be null.

      const result = await listCustomerMergeCandidates({ db: db as unknown as D1Database });

      expect(result.groups).toHaveLength(1);
      const byId = new Map(result.groups[0].customers.map((c) => [c.id, c]));
      expect(byId.get("res_a")?.lastReservationAt).toBe("2026-09-15T03:00:00.000Z");
      expect(byId.get("res_b")?.lastReservationAt).toBeNull();
    } finally {
      db.sqlite.close();
    }
  });

  it("flips truncated to true when duplicate-group count exceeds the limit", async () => {
    const db = createMigratedSqliteD1();
    try {
      // Three distinct duplicate clusters (each two live rows).
      for (const hash of ["hash_t1", "hash_t2", "hash_t3"]) {
        insertCustomer(db, { id: `${hash}_x`, phoneHash: hash });
        insertCustomer(db, { id: `${hash}_y`, phoneHash: hash });
      }

      const result = await listCustomerMergeCandidates({
        db: db as unknown as D1Database,
        limit: 2
      });

      expect(result.ok).toBe(true);
      expect(result.truncated).toBe(true);
      expect(result.groups).toHaveLength(2);
    } finally {
      db.sqlite.close();
    }
  });
});
