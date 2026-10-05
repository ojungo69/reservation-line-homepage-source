import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createMigratedSqliteD1, type SqliteD1Database } from "./helpers/sqlite-d1";

// "Now" reference for the trigger: every reservation INSERT below binds this as
// updated_at, and the trigger compares start_at / pending_expires_at against it
// (datetime(NEW.updated_at)). So the cap logic is deterministic regardless of the
// real wall clock. Future = after NOW; past = before NOW.
const NOW = "2026-05-31T00:00:00.000Z";
const FUTURE_1 = "2026-08-01T03:00:00.000Z";
const FUTURE_2 = "2026-08-02T03:00:00.000Z";
const FUTURE_3 = "2026-08-03T03:00:00.000Z";
const FUTURE_4 = "2026-08-04T03:00:00.000Z";
const PAST = "2026-01-01T03:00:00.000Z";

let seq = 0;
const uid = (prefix: string) => `${prefix}_${(seq += 1)}`;

const seedStore = (d1: SqliteD1Database, storeId: string, cap = 1) => {
  d1.sqlite.prepare(`INSERT INTO stores (id, name, timezone) VALUES (?, ?, 'Asia/Tokyo')`).run(storeId, storeId);
  d1.sqlite
    .prepare(
      `INSERT INTO store_settings (store_id, reservation_approval_mode, max_active_reservations_per_customer)
       VALUES (?, 'existing_customer_auto', ?)`
    )
    .run(storeId, cap);
  d1.sqlite
    .prepare(`INSERT INTO store_resources (id, store_id, name) VALUES (?, ?, 'R')`)
    .run(`res_${storeId}`, storeId);
  d1.sqlite
    .prepare(`INSERT INTO services (id, store_id, name, duration_minutes) VALUES (?, ?, 'カット', 60)`)
    .run(`svc_${storeId}`, storeId);
};

const seedCustomer = (d1: SqliteD1Database, customerId: string, phoneHash: string) => {
  d1.sqlite
    .prepare(
      `INSERT INTO customers (id, display_name, phone_normalized, phone_hash, block_status)
       VALUES (?, '太郎', ?, ?, 'active')`
    )
    .run(customerId, `070${customerId}`, phoneHash);
};

type ResOpts = {
  storeId: string;
  customerId: string;
  status?: string;
  startAt?: string;
  source?: string;
  pendingExpiresAt?: string | null;
  updatedAt?: string;
};

const insertReservation = (d1: SqliteD1Database, opts: ResOpts) => {
  const id = uid("resv");
  d1.sqlite
    .prepare(
      `INSERT INTO reservations (
         id, store_id, service_id, customer_id, resource_id, source, status,
         start_at, end_at, duration_minutes, pending_expires_at, idempotency_key, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 60, ?, ?, ?)`
    )
    .run(
      id,
      opts.storeId,
      `svc_${opts.storeId}`,
      opts.customerId,
      `res_${opts.storeId}`,
      opts.source ?? "web_line",
      opts.status ?? "confirmed",
      opts.startAt ?? FUTURE_1,
      // end_at = start + 1h, kept after start_at for the CHECK(start_at < end_at)
      (opts.startAt ?? FUTURE_1).replace("T03:", "T04:"),
      opts.pendingExpiresAt ?? null,
      uid("idem"),
      opts.updatedAt ?? NOW
    );
  return id;
};

describe("per-customer reservation cap trigger (trg_reservations_web_cap)", () => {
  let d1: SqliteD1Database;
  beforeEach(() => {
    d1 = createMigratedSqliteD1();
    seq = 0;
  });
  afterEach(() => d1.sqlite.close());

  it("falls back to cap 1 when the store has no store_settings row", () => {
    seedStore(d1, "s1");
    d1.sqlite.prepare("DELETE FROM store_settings WHERE store_id = 's1'").run();
    seedCustomer(d1, "c1", "ph1");
    expect(() => insertReservation(d1, { storeId: "s1", customerId: "c1", startAt: FUTURE_1 })).not.toThrow();
    expect(() => insertReservation(d1, { storeId: "s1", customerId: "c1", startAt: FUTURE_2 })).toThrow(
      /reservation_limit_reached/
    );
  });

  it("rejects out-of-range cap values via CHECK", () => {
    d1.sqlite.prepare(`INSERT INTO stores (id, name, timezone) VALUES ('s_chk', 's', 'Asia/Tokyo')`).run();
    for (const bad of [0, 51, -1]) {
      expect(() =>
        d1.sqlite
          .prepare(
            `INSERT INTO store_settings (store_id, reservation_approval_mode, max_active_reservations_per_customer)
             VALUES ('s_chk', 'manual', ?)`
          )
          .run(bad)
      ).toThrow();
    }
  });

  it("allows the 1st web booking and blocks the 2nd at the default cap", () => {
    seedStore(d1, "s1");
    seedCustomer(d1, "c1", "ph1");
    insertReservation(d1, { storeId: "s1", customerId: "c1", startAt: FUTURE_1 });
    expect(() => insertReservation(d1, { storeId: "s1", customerId: "c1", startAt: FUTURE_2 })).toThrow(
      /reservation_limit_reached/
    );
  });

  it("does not count past, cancelled, rejected, expired, completed or no_show reservations", () => {
    seedStore(d1, "s1", 1); // cap 1: any single active future booking would block the next
    seedCustomer(d1, "c1", "ph1");
    insertReservation(d1, { storeId: "s1", customerId: "c1", startAt: PAST, status: "confirmed" });
    insertReservation(d1, { storeId: "s1", customerId: "c1", startAt: FUTURE_1, status: "cancelled_by_customer" });
    insertReservation(d1, { storeId: "s1", customerId: "c1", startAt: FUTURE_1, status: "rejected" });
    insertReservation(d1, { storeId: "s1", customerId: "c1", startAt: FUTURE_1, status: "expired" });
    insertReservation(d1, { storeId: "s1", customerId: "c1", startAt: FUTURE_1, status: "completed" });
    insertReservation(d1, { storeId: "s1", customerId: "c1", startAt: FUTURE_1, status: "no_show" });
    // None of the above are "future active", so a fresh future booking is allowed even at cap 1.
    expect(() => insertReservation(d1, { storeId: "s1", customerId: "c1", startAt: FUTURE_2 })).not.toThrow();
  });

  it("excludes pending_approval rows whose pending window has expired", () => {
    seedStore(d1, "s1", 1);
    seedCustomer(d1, "c1", "ph1");
    // Pending but already expired at NOW → not counted, so a fresh booking is allowed at cap 1.
    insertReservation(d1, {
      storeId: "s1",
      customerId: "c1",
      startAt: FUTURE_1,
      status: "pending_approval",
      pendingExpiresAt: PAST
    });
    expect(() => insertReservation(d1, { storeId: "s1", customerId: "c1", startAt: FUTURE_2 })).not.toThrow();
  });

  it("counts a live (un-expired) pending_approval row", () => {
    seedStore(d1, "s1", 1);
    seedCustomer(d1, "c1", "ph1");
    // A live pending (no expiry) counts as 1 active → the next booking is blocked at cap 1.
    insertReservation(d1, {
      storeId: "s1",
      customerId: "c1",
      startAt: FUTURE_1,
      status: "pending_approval",
      pendingExpiresAt: null
    });
    expect(() => insertReservation(d1, { storeId: "s1", customerId: "c1", startAt: FUTURE_2 })).toThrow(
      /reservation_limit_reached/
    );
  });

  it("counts reservations across all stores (booked store's cap, global count)", () => {
    seedStore(d1, "sA", 3);
    seedStore(d1, "sB", 3);
    seedCustomer(d1, "c1", "ph1");
    insertReservation(d1, { storeId: "sA", customerId: "c1", startAt: FUTURE_1 });
    insertReservation(d1, { storeId: "sB", customerId: "c1", startAt: FUTURE_2 });
    insertReservation(d1, { storeId: "sB", customerId: "c1", startAt: FUTURE_3 });
    // 3 across both stores → a 4th anywhere is blocked.
    expect(() => insertReservation(d1, { storeId: "sA", customerId: "c1", startAt: FUTURE_4 })).toThrow(
      /reservation_limit_reached/
    );
  });

  it("does NOT combine reservations across different customer_ids sharing a phone_hash (DoS-safe)", () => {
    // Phone numbers are unverified at submit, so counting across a shared phone_hash
    // would let an attacker book under a victim's phone and exhaust the victim's cap.
    // The cap therefore keys off customer_id only: a different customer record sharing
    // the same phone_hash cannot consume this customer's allowance.
    seedStore(d1, "s1", 2);
    seedCustomer(d1, "c_victim", "shared_phone");
    seedCustomer(d1, "c_attacker", "shared_phone"); // same phone, different LINE identity
    insertReservation(d1, { storeId: "s1", customerId: "c_attacker", startAt: FUTURE_1 });
    insertReservation(d1, { storeId: "s1", customerId: "c_attacker", startAt: FUTURE_2 });
    // The attacker's 2 reservations under the victim's phone do not count toward the victim.
    expect(() => insertReservation(d1, { storeId: "s1", customerId: "c_victim", startAt: FUTURE_3 })).not.toThrow();
    expect(() => insertReservation(d1, { storeId: "s1", customerId: "c_victim", startAt: FUTURE_4 })).not.toThrow();
    // The victim is still capped by their OWN count (2 → 3rd blocked).
    expect(() =>
      insertReservation(d1, { storeId: "s1", customerId: "c_victim", startAt: "2026-08-09T03:00:00.000Z" })
    ).toThrow(/reservation_limit_reached/);
  });

  it("counts an existing customer's reservations even when a new phone_hash is presented", () => {
    seedStore(d1, "s1", 2);
    seedCustomer(d1, "c1", "ph_stored"); // stored phone
    insertReservation(d1, { storeId: "s1", customerId: "c1", startAt: FUTURE_1 });
    insertReservation(d1, { storeId: "s1", customerId: "c1", startAt: FUTURE_2 });
    // The trigger counts by customer_id, so an existing customer's reservations are
    // counted (2 → blocked) regardless of any different phone submitted in the request
    // (the request phone never overrides the stored customer row).
    expect(() => insertReservation(d1, { storeId: "s1", customerId: "c1", startAt: FUTURE_3 })).toThrow(
      /reservation_limit_reached/
    );
  });

  it("does not block admin/phone reservations, but still counts them toward the web cap", () => {
    seedStore(d1, "s1", 2);
    seedCustomer(d1, "c1", "ph1");
    insertReservation(d1, { storeId: "s1", customerId: "c1", startAt: FUTURE_1, source: "admin" });
    insertReservation(d1, { storeId: "s1", customerId: "c1", startAt: FUTURE_2, source: "phone_admin" });
    // Staff may create a 3rd admin reservation beyond the cap (trigger only guards source='web_line').
    expect(() =>
      insertReservation(d1, { storeId: "s1", customerId: "c1", startAt: FUTURE_3, source: "admin" })
    ).not.toThrow();
    // But the customer's own WEB booking is blocked because 3 active count toward the cap of 2.
    expect(() => insertReservation(d1, { storeId: "s1", customerId: "c1", startAt: FUTURE_4, source: "web_line" })).toThrow(
      /reservation_limit_reached/
    );
  });

  it("honours a per-store configured cap above the default", () => {
    seedStore(d1, "s1", 5);
    seedCustomer(d1, "c1", "ph1");
    for (const start of [FUTURE_1, FUTURE_2, FUTURE_3, FUTURE_4, "2026-08-05T03:00:00.000Z"]) {
      expect(() => insertReservation(d1, { storeId: "s1", customerId: "c1", startAt: start })).not.toThrow();
    }
    // 6th exceeds cap 5.
    expect(() =>
      insertReservation(d1, { storeId: "s1", customerId: "c1", startAt: "2026-08-06T03:00:00.000Z" })
    ).toThrow(/reservation_limit_reached/);
  });
});
