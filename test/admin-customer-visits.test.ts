import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/sentry-helpers", () => ({
  captureBatchWriteFailure: vi.fn(),
  safeCaptureException: vi.fn()
}));

import type { AdminUser } from "../src/admin/access";
import {
  addAdminCustomerVisit,
  updateAdminCustomerVisit,
  deleteAdminCustomerVisit,
} from "../src/admin/customer-visits";
import { createApp } from "../src/app";
import { captureBatchWriteFailure } from "../src/sentry-helpers";
import { createAccessJwtFixture, createAccessJwksFetchMock, insertAdminUser } from "./helpers/admin-access";
import { createMigratedSqliteD1, type SqliteD1Database } from "./helpers/sqlite-d1";

const owner: AdminUser = {
  id: "admin_visit_owner_1",
  email: "owner@example.com",
  role: "owner",
  staff_member_id: null,
  store_id: null,
};

const staff: AdminUser = {
  id: "admin_visit_staff_1",
  email: "staff@example.com",
  role: "staff",
  staff_member_id: "staff_owner_kyoto",
  store_id: "kyoto",
};

const insertServiceAdmins = (db: SqliteD1Database) => {
  insertAdminUser(db, {
    id: owner.id,
    email: owner.email,
    accessSubject: "admin-visit-owner-subject",
    role: owner.role,
  });
  insertAdminUser(db, {
    id: staff.id,
    email: staff.email,
    accessSubject: "admin-visit-staff-subject",
    role: staff.role,
    staffMemberId: staff.staff_member_id,
  });
};

beforeEach(() => {
  vi.mocked(captureBatchWriteFailure).mockClear();
});

describe("addAdminCustomerVisit — validation", () => {
  let d1: SqliteD1Database;

  beforeEach(() => {
    // Freeze to a fixed JST-safe instant so "future" is deterministic.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-06-02T03:00:00.000Z")); // = 2026-06-02 12:00 JST
    d1 = createMigratedSqliteD1();
    insertServiceAdmins(d1);
    d1.sqlite.exec(`
      INSERT INTO customers (id, display_name, block_status, updated_at)
      VALUES ('cust_visit_1', '来店 顧客', 'active', '2026-05-01T00:00:00.000Z');
    `);
  });

  afterEach(() => {
    d1.sqlite.close();
    vi.useRealTimers();
  });

  const baseRequest = {
    idempotencyKey: "visit-key-1",
    visitedAt: "2026-05-30",
    storeId: "kyoto" as const,
    treatmentNotes: null as string | null,
  };

  it("rejects a staff (non-owner) caller with forbidden", async () => {
    const result = await addAdminCustomerVisit({
      db: d1 as unknown as D1Database,
      admin: staff,
      customerId: "cust_visit_1",
      request: baseRequest,
    });
    expect(result).toEqual({ ok: false, reason: "forbidden" });
  });

  it("rejects a missing idempotency key with invalid_request", async () => {
    const result = await addAdminCustomerVisit({
      db: d1 as unknown as D1Database,
      admin: owner,
      customerId: "cust_visit_1",
      request: { ...baseRequest, idempotencyKey: "" },
    });
    expect(result).toEqual({ ok: false, reason: "invalid_request" });
  });

  it("rejects a malformed visited_at with invalid_visit_date", async () => {
    const result = await addAdminCustomerVisit({
      db: d1 as unknown as D1Database,
      admin: owner,
      customerId: "cust_visit_1",
      request: { ...baseRequest, visitedAt: "2026/05/30" },
    });
    expect(result).toEqual({ ok: false, reason: "invalid_visit_date" });
  });

  it("rejects format-valid but impossible calendar dates with invalid_visit_date", async () => {
    // YYYY-MM-DD shaped but non-existent — must not be stored as a valid visit
    // (would pollute valid_visit_count). Round-trip date validation, not just regex.
    for (const visitedAt of ["2026-02-31", "2025-99-99", "2025-02-29", "2026-13-01", "2026-00-10"]) {
      const result = await addAdminCustomerVisit({
        db: d1 as unknown as D1Database,
        admin: owner,
        customerId: "cust_visit_1",
        request: { ...baseRequest, visitedAt, idempotencyKey: `visit-bad-${visitedAt}` },
      });
      expect(result).toEqual({ ok: false, reason: "invalid_visit_date" });
    }
  });

  it("rejects a future visited_at with future_visit_date", async () => {
    const result = await addAdminCustomerVisit({
      db: d1 as unknown as D1Database,
      admin: owner,
      customerId: "cust_visit_1",
      request: { ...baseRequest, visitedAt: "2026-06-03" }, // tomorrow JST
    });
    expect(result).toEqual({ ok: false, reason: "future_visit_date" });
  });

  it("accepts today (JST) as a non-future visited_at", async () => {
    const result = await addAdminCustomerVisit({
      db: d1 as unknown as D1Database,
      admin: owner,
      customerId: "cust_visit_1",
      request: { ...baseRequest, visitedAt: "2026-06-02", idempotencyKey: "visit-key-today" },
    });
    expect(result.ok).toBe(true);
  });

  it("rejects treatment notes longer than 2000 chars with notes_too_long", async () => {
    const result = await addAdminCustomerVisit({
      db: d1 as unknown as D1Database,
      admin: owner,
      customerId: "cust_visit_1",
      request: { ...baseRequest, treatmentNotes: "x".repeat(2001) },
    });
    expect(result).toEqual({ ok: false, reason: "notes_too_long" });
  });

  it("rejects an unknown store_id with invalid_store", async () => {
    const result = await addAdminCustomerVisit({
      db: d1 as unknown as D1Database,
      admin: owner,
      customerId: "cust_visit_1",
      request: { ...baseRequest, storeId: "no_such_store" as "kyoto", idempotencyKey: "visit-key-store" },
    });
    expect(result).toEqual({ ok: false, reason: "invalid_store" });
  });

  it("rejects an unknown customer with not_found", async () => {
    const result = await addAdminCustomerVisit({
      db: d1 as unknown as D1Database,
      admin: owner,
      customerId: "cust_does_not_exist",
      request: { ...baseRequest, idempotencyKey: "visit-key-nocust" },
    });
    expect(result).toEqual({ ok: false, reason: "not_found" });
  });
});

describe("addAdminCustomerVisit — idempotency", () => {
  let d1: SqliteD1Database;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-06-02T03:00:00.000Z"));
    d1 = createMigratedSqliteD1();
    insertServiceAdmins(d1);
    d1.sqlite.exec(`
      INSERT INTO customers (id, display_name, block_status, updated_at)
      VALUES ('cust_idem_1', 'idem 顧客', 'active', '2026-05-01T00:00:00.000Z');
    `);
  });

  afterEach(() => {
    d1.sqlite.close();
    vi.useRealTimers();
  });

  const req = {
    idempotencyKey: "idem-visit-1",
    visitedAt: "2026-05-20",
    storeId: "kyoto",
    treatmentNotes: "カラー施術",
  };

  it("replays the same visit row for a repeated identical request", async () => {
    const first = await addAdminCustomerVisit({
      db: d1 as unknown as D1Database,
      admin: owner,
      customerId: "cust_idem_1",
      request: req,
    });
    expect(first.ok).toBe(true);
    const firstId = first.ok ? first.visitId : "";

    const second = await addAdminCustomerVisit({
      db: d1 as unknown as D1Database,
      admin: owner,
      customerId: "cust_idem_1",
      request: req,
    });
    expect(second).toEqual({ ok: true, visitId: firstId, replayed: true });

    const count = (
      d1.sqlite
        .prepare("SELECT COUNT(*) AS n FROM customer_visits WHERE customer_id = 'cust_idem_1'")
        .get() as { n: number }
    ).n;
    expect(count).toBe(1); // only one row despite two calls
  });

  it("maps a same-key request with a different body to idempotency_conflict", async () => {
    await addAdminCustomerVisit({
      db: d1 as unknown as D1Database,
      admin: owner,
      customerId: "cust_idem_1",
      request: req,
    });

    const conflicting = await addAdminCustomerVisit({
      db: d1 as unknown as D1Database,
      admin: owner,
      customerId: "cust_idem_1",
      request: { ...req, visitedAt: "2026-05-21" }, // different date, same key
    });
    expect(conflicting).toEqual({ ok: false, reason: "idempotency_conflict" });
  });

  it("rejects an owner revoked immediately before the batch without partial writes", async () => {
    let reachedBatch = false;
    const racingDb = {
      prepare: d1.prepare.bind(d1),
      batch: (statements: D1PreparedStatement[]) => {
        reachedBatch = true;
        d1.sqlite.prepare("UPDATE admin_users SET active = 0 WHERE id = ?").run(owner.id);
        return d1.batch(statements);
      },
    } as unknown as D1Database;

    const result = await addAdminCustomerVisit({
      db: racingDb,
      admin: owner,
      customerId: "cust_idem_1",
      request: { ...req, idempotencyKey: "idem-revoked-1" },
    });

    expect(reachedBatch).toBe(true);
    expect(result).toEqual({ ok: false, reason: "forbidden" });
    expect(d1.sqlite.prepare("SELECT COUNT(*) AS n FROM customer_visits WHERE customer_id = 'cust_idem_1'").get()).toEqual({ n: 0 });
    expect(d1.sqlite.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'customer.visit_manual_add'").get()).toEqual({ n: 0 });
    expect(d1.sqlite.prepare("SELECT COUNT(*) AS n FROM idempotency_keys WHERE idempotency_key = 'idem-revoked-1'").get()).toEqual({ n: 0 });
    expect(captureBatchWriteFailure).not.toHaveBeenCalled();
  });

  it("maps a same-key insert race to idempotency_in_progress", async () => {
    const racingDb = {
      prepare: d1.prepare.bind(d1),
      batch: async (statements: D1PreparedStatement[]) => {
        await d1.batch([statements[1]]); // commit the 'started' idempotency row
        throw new Error(
          "UNIQUE constraint failed: idempotency_keys.scope, idempotency_keys.idempotency_key"
        );
      },
    } as unknown as D1Database;

    const result = await addAdminCustomerVisit({
      db: racingDb,
      admin: owner,
      customerId: "cust_idem_1",
      request: { ...req, idempotencyKey: "idem-race-1" },
    });
    expect(result).toEqual({ ok: false, reason: "idempotency_in_progress" });
    expect(captureBatchWriteFailure).not.toHaveBeenCalled();
  });

  it("returns not_found (no false ok) when the customer is archived between pre-check and INSERT", async () => {
    // The customer passes the active pre-check, then is archived right before the
    // batch commits. The conditional visit INSERT (WHERE EXISTS active customer)
    // matches 0 rows, so the audit INSERT and idempotency success-flip are both
    // skipped: no stray visit row, the idempotency row stays 'started' (a same-key
    // replay returns idempotency_in_progress), and the caller gets not_found.
    const racingDb = {
      prepare: d1.prepare.bind(d1),
      batch: async (statements: D1PreparedStatement[]) => {
        d1.sqlite
          .prepare("UPDATE customers SET archived_at = ? WHERE id = ?")
          .run("2026-06-01T00:00:00.000Z", "cust_idem_1");
        return d1.batch(statements);
      },
    } as unknown as D1Database;

    const result = await addAdminCustomerVisit({
      db: racingDb,
      admin: owner,
      customerId: "cust_idem_1",
      request: { ...req, idempotencyKey: "idem-archive-race-1" },
    });
    expect(result).toEqual({ ok: false, reason: "not_found" });
    const visits = (
      d1.sqlite
        .prepare("SELECT COUNT(*) AS n FROM customer_visits WHERE customer_id = 'cust_idem_1'")
        .get() as { n: number }
    ).n;
    expect(visits).toBe(0);
    const idem = d1.sqlite
      .prepare("SELECT status FROM idempotency_keys WHERE idempotency_key = 'idem-archive-race-1'")
      .get() as { status: string } | undefined;
    expect(idem?.status).toBe("started");
    expect(captureBatchWriteFailure).not.toHaveBeenCalled();
  });

  it("captures an unclassified batch failure with the original error", async () => {
    const batchError = new Error("injected customer visit batch failure");
    const failingDb = {
      prepare: d1.prepare.bind(d1),
      batch: vi.fn().mockRejectedValue(batchError)
    } as unknown as D1Database;

    const result = await addAdminCustomerVisit({
      db: failingDb,
      admin: owner,
      customerId: "cust_idem_1",
      request: { ...req, idempotencyKey: "idem-write-failure-1" }
    });

    expect(result).toEqual({ ok: false, reason: "write_failed" });
    expect(captureBatchWriteFailure).toHaveBeenCalledTimes(1);
    expect(captureBatchWriteFailure).toHaveBeenCalledWith(batchError, {
      component: "customer-visits",
      op: "batch_write_failed",
      helper: "addAdminCustomerVisit"
    });
  });
});

// ---------------------------------------------------------------------------
// POST /api/admin/customers/:id/visits — HTTP-level tests
// ---------------------------------------------------------------------------

const TEAM_DOMAIN = "https://team.example.cloudflareaccess.com";
const ACCESS_AUD = "admin-visit-aud";
const VISIT_ADMIN_EMAIL = "owner-visit@example.com";
const VISIT_ADMIN_SUBJECT = "access-subject-visit-owner";

const makeAccessJwt = () =>
  createAccessJwtFixture({
    issuer: TEAM_DOMAIN,
    audience: ACCESS_AUD,
    keyId: "visit-test-key-1",
    claims: { email: VISIT_ADMIN_EMAIL, sub: VISIT_ADMIN_SUBJECT },
  });

const makeFetchMock = (jwk: Parameters<typeof createAccessJwksFetchMock>[1]) =>
  createAccessJwksFetchMock(TEAM_DOMAIN, jwk);

const insertVisitAdmin = (db: SqliteD1Database, role: "owner" | "staff") => {
  db.sqlite
    .prepare(
      `INSERT INTO admin_users (id, email, access_subject, role, active, updated_at)
       VALUES ('admin_visit_http', ?, ?, ?, 1, '2026-05-22T00:00:00.000Z')`
    )
    .run(VISIT_ADMIN_EMAIL, VISIT_ADMIN_SUBJECT, role);
};

const insertVisitCustomer = (db: SqliteD1Database, id: string) => {
  db.sqlite
    .prepare(
      `INSERT INTO customers (id, display_name, block_status, updated_at)
       VALUES (?, 'HTTP 顧客', 'active', '2026-05-22T00:00:00.000Z')`
    )
    .run(id);
};

const visitEnv = (db: SqliteD1Database): Record<string, unknown> => ({
  ACCESS_TEAM_DOMAIN: TEAM_DOMAIN,
  ACCESS_AUD,
  DB: db,
});

const postVisit = (db: SqliteD1Database, token: string | null, customerId: string, body: unknown) => {
  const app = createApp();
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers["Cf-Access-Jwt-Assertion"] = token;
  return app.request(
    `/api/admin/customers/${encodeURIComponent(customerId)}/visits`,
    { method: "POST", headers, body: JSON.stringify(body) },
    visitEnv(db)
  );
};

describe("POST /api/admin/customers/:id/visits", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-06-02T03:00:00.000Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("adds a manual_import visit row for an owner (201) with audit log", async () => {
    const db = createMigratedSqliteD1();
    try {
      insertVisitAdmin(db, "owner");
      insertVisitCustomer(db, "cust_http_1");
      const access = makeAccessJwt();
      vi.stubGlobal("fetch", makeFetchMock(access.jwk));

      const response = await postVisit(db, access.token, "cust_http_1", {
        idempotencyKey: "http-visit-1",
        visitedAt: "2026-04-15",
        storeId: "kyoto",
        treatmentNotes: "紙カルテより",
      });
      expect(response.status).toBe(201);
      const body = (await response.json()) as { ok: boolean; visitId?: string };
      expect(body.ok).toBe(true);

      const row = db.sqlite
        .prepare(
          "SELECT visit_source, status, reservation_id, store_id, visited_at, recorded_by, treatment_notes FROM customer_visits WHERE customer_id = 'cust_http_1'"
        )
        .get() as {
          visit_source: string;
          status: string;
          reservation_id: string | null;
          store_id: string;
          visited_at: string;
          recorded_by: string;
          treatment_notes: string | null;
        };
      expect(row.visit_source).toBe("manual_import");
      expect(row.status).toBe("valid");
      expect(row.reservation_id).toBeNull();
      expect(row.store_id).toBe("kyoto");
      expect(row.visited_at).toBe("2026-04-15");
      expect(row.recorded_by).toBe("admin_visit_http");
      expect(row.treatment_notes).toBe("紙カルテより");

      const audit = db.sqlite
        .prepare(
          "SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'customer.visit_manual_add'"
        )
        .get() as { n: number };
      expect(audit.n).toBe(1);
    } finally {
      db.sqlite.close();
    }
  });

  it("returns 403 for a staff (non-owner) user and writes nothing", async () => {
    const db = createMigratedSqliteD1();
    try {
      insertVisitAdmin(db, "staff");
      insertVisitCustomer(db, "cust_http_2");
      const access = makeAccessJwt();
      vi.stubGlobal("fetch", makeFetchMock(access.jwk));

      const response = await postVisit(db, access.token, "cust_http_2", {
        idempotencyKey: "http-visit-2",
        visitedAt: "2026-04-15",
        storeId: "kyoto",
      });
      expect(response.status).toBe(403);
      const n = (
        db.sqlite.prepare("SELECT COUNT(*) AS n FROM customer_visits WHERE customer_id = 'cust_http_2'").get() as { n: number }
      ).n;
      expect(n).toBe(0);
    } finally {
      db.sqlite.close();
    }
  });

  it("returns 403 without auth", async () => {
    const db = createMigratedSqliteD1();
    try {
      const response = await postVisit(db, null, "cust_http_x", {
        idempotencyKey: "http-visit-x",
        visitedAt: "2026-04-15",
        storeId: "kyoto",
      });
      expect(response.status).toBe(403);
    } finally {
      db.sqlite.close();
    }
  });

  it("returns 400 for a future visited_at", async () => {
    const db = createMigratedSqliteD1();
    try {
      insertVisitAdmin(db, "owner");
      insertVisitCustomer(db, "cust_http_3");
      const access = makeAccessJwt();
      vi.stubGlobal("fetch", makeFetchMock(access.jwk));

      const response = await postVisit(db, access.token, "cust_http_3", {
        idempotencyKey: "http-visit-3",
        visitedAt: "2026-06-03",
        storeId: "kyoto",
      });
      expect(response.status).toBe(400);
      const body = (await response.json()) as { reason?: string };
      expect(body.reason).toBe("future_visit_date");
    } finally {
      db.sqlite.close();
    }
  });

  it("returns 404 for an unknown customer", async () => {
    const db = createMigratedSqliteD1();
    try {
      insertVisitAdmin(db, "owner");
      const access = makeAccessJwt();
      vi.stubGlobal("fetch", makeFetchMock(access.jwk));

      const response = await postVisit(db, access.token, "cust_missing", {
        idempotencyKey: "http-visit-4",
        visitedAt: "2026-04-15",
        storeId: "kyoto",
      });
      expect(response.status).toBe(404);
    } finally {
      db.sqlite.close();
    }
  });

  it("returns 400 invalid_store for an unknown store_id", async () => {
    const db = createMigratedSqliteD1();
    try {
      insertVisitAdmin(db, "owner");
      insertVisitCustomer(db, "cust_http_5");
      const access = makeAccessJwt();
      vi.stubGlobal("fetch", makeFetchMock(access.jwk));

      const response = await postVisit(db, access.token, "cust_http_5", {
        idempotencyKey: "http-visit-5",
        visitedAt: "2026-04-15",
        storeId: "no_such_store",
      });
      expect(response.status).toBe(400);
      const body = (await response.json()) as { reason?: string };
      expect(body.reason).toBe("invalid_store");
    } finally {
      db.sqlite.close();
    }
  });
});

// ---------------------------------------------------------------------------
// updateAdminCustomerVisit / deleteAdminCustomerVisit — 来店履歴の編集・削除
// ---------------------------------------------------------------------------

// 手動 visit (reservation_id NULL) と予約由来 visit (reservation_id NOT NULL) を
// それぞれ1件ずつ seed する。FK が有効なので予約由来 visit には実 reservations 行が必要。
const seedEditFixtures = (db: SqliteD1Database) => {
  db.sqlite.exec(`
    INSERT INTO customers (id, display_name, block_status, updated_at)
    VALUES ('cust_edit_1', '編集 顧客', 'active', '2026-05-01T00:00:00.000Z');
    INSERT INTO customer_visits (id, customer_id, store_id, visited_at, visit_source, status, recorded_by)
    VALUES ('v_manual', 'cust_edit_1', 'kyoto', '2026-05-01', 'manual_import', 'valid', 'seed_admin');
  `);
  db.sqlite
    .prepare(
      `INSERT INTO reservations (id, store_id, service_id, customer_id, resource_id, source, status, duration_minutes, idempotency_key, start_at, end_at, created_at, updated_at)
       VALUES ('r_edit_1', 'kyoto', 'service_kyoto_default_60', 'cust_edit_1', 'resource_kyoto_calendar', 'admin', 'completed', 60, 'ik_edit_1', '2026-04-01T10:00:00Z', '2026-04-01T11:00:00Z', '2026-04-01T10:00:00Z', '2026-04-01T10:00:00Z')`
    )
    .run();
  db.sqlite
    .prepare(
      `INSERT INTO customer_visits (id, customer_id, reservation_id, store_id, visited_at, visit_source, status, recorded_by)
       VALUES ('v_res', 'cust_edit_1', 'r_edit_1', 'kyoto', '2026-04-01', 'reservation_completed', 'valid', 'seed_admin')`
    )
    .run();
};

describe("updateAdminCustomerVisit — 来店日編集", () => {
  let d1: SqliteD1Database;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-06-02T03:00:00.000Z")); // 2026-06-02 12:00 JST
    d1 = createMigratedSqliteD1();
    insertServiceAdmins(d1);
    seedEditFixtures(d1);
  });
  afterEach(() => {
    d1.sqlite.close();
    vi.useRealTimers();
  });

  const base = { idempotencyKey: "upd-key-1", visitedAt: "2026-05-20" };
  const call = (admin: AdminUser, visitId: string, request = base) =>
    updateAdminCustomerVisit({
      db: d1 as unknown as D1Database,
      admin,
      customerId: "cust_edit_1",
      visitId,
      request,
    });

  it("rejects a staff caller with forbidden", async () => {
    expect(await call(staff, "v_manual")).toEqual({ ok: false, reason: "forbidden" });
  });

  it("rejects an impossible date with invalid_visit_date", async () => {
    expect(await call(owner, "v_manual", { ...base, visitedAt: "2026-02-31" })).toEqual({
      ok: false,
      reason: "invalid_visit_date",
    });
  });

  it("rejects a future date with future_visit_date", async () => {
    expect(await call(owner, "v_manual", { ...base, visitedAt: "2026-06-03" })).toEqual({
      ok: false,
      reason: "future_visit_date",
    });
  });

  it("rejects an unknown visit with not_found", async () => {
    expect(await call(owner, "v_does_not_exist")).toEqual({ ok: false, reason: "not_found" });
  });

  // FR-021 の範囲は施術メモだけ。手動記録の後始末経路（日付訂正・削除）は
  // 無効化された行にも残す — 誤登録を消す手段が無くなるため。
  it("still edits a voided manual visit", async () => {
    d1.sqlite
      .prepare(
        `UPDATE customer_visits
         SET status = 'voided', voided_by = 'seed_admin', voided_at = '2026-05-10T00:00:00.000Z',
             void_reason = 'entered by mistake'
         WHERE id = 'v_manual'`
      )
      .run();
    expect(await call(owner, "v_manual")).toMatchObject({ ok: true });
    const row = d1.sqlite.prepare("SELECT visited_at, status FROM customer_visits WHERE id = 'v_manual'").get() as {
      visited_at: string;
      status: string;
    };
    expect(row.visited_at).toBe("2026-05-20");
    expect(row.status).toBe("voided");
  });

  it("rejects a reservation-linked visit with reservation_linked and leaves it unchanged", async () => {
    expect(await call(owner, "v_res")).toEqual({ ok: false, reason: "reservation_linked" });
    const row = d1.sqlite.prepare("SELECT visited_at FROM customer_visits WHERE id = 'v_res'").get() as {
      visited_at: string;
    };
    expect(row.visited_at).toBe("2026-04-01"); // untouched
  });

  it("updates a manual visit's date for an owner and writes an audit row", async () => {
    const result = await call(owner, "v_manual");
    expect(result).toEqual({ ok: true, visitId: "v_manual", replayed: false });
    const row = d1.sqlite.prepare("SELECT visited_at FROM customer_visits WHERE id = 'v_manual'").get() as {
      visited_at: string;
    };
    expect(row.visited_at).toBe("2026-05-20");
    const audit = d1.sqlite
      .prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'customer.visit_manual_update'")
      .get() as { n: number };
    expect(audit.n).toBe(1);
  });

  it("rejects an owner revoked immediately before the update batch without partial writes", async () => {
    let reachedBatch = false;
    const racingDb = {
      prepare: d1.prepare.bind(d1),
      batch: (statements: D1PreparedStatement[]) => {
        reachedBatch = true;
        d1.sqlite.prepare("UPDATE admin_users SET active = 0 WHERE id = ?").run(owner.id);
        return d1.batch(statements);
      },
    } as unknown as D1Database;

    const result = await updateAdminCustomerVisit({
      db: racingDb,
      admin: owner,
      customerId: "cust_edit_1",
      visitId: "v_manual",
      request: { idempotencyKey: "upd-revoked-1", visitedAt: "2026-05-20" },
    });

    expect(reachedBatch).toBe(true);
    expect(result).toEqual({ ok: false, reason: "forbidden" });
    expect(d1.sqlite.prepare("SELECT visited_at FROM customer_visits WHERE id = 'v_manual'").get()).toEqual({ visited_at: "2026-05-01" });
    expect(d1.sqlite.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'customer.visit_manual_update'").get()).toEqual({ n: 0 });
    expect(d1.sqlite.prepare("SELECT COUNT(*) AS n FROM idempotency_keys WHERE idempotency_key = 'upd-revoked-1'").get()).toEqual({ n: 0 });
    expect(captureBatchWriteFailure).not.toHaveBeenCalled();
  });

  it("replays an identical repeated request (single audit row)", async () => {
    expect((await call(owner, "v_manual")).ok).toBe(true);
    expect(await call(owner, "v_manual")).toEqual({ ok: true, visitId: "v_manual", replayed: true });
    const audit = d1.sqlite
      .prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'customer.visit_manual_update'")
      .get() as { n: number };
    expect(audit.n).toBe(1); // replay does not re-audit
  });

  it("maps a same-key different-date request to idempotency_conflict", async () => {
    expect((await call(owner, "v_manual")).ok).toBe(true);
    expect(await call(owner, "v_manual", { ...base, visitedAt: "2026-05-21" })).toEqual({
      ok: false,
      reason: "idempotency_conflict",
    });
  });

  it("returns not_found (no false ok) when the visit is concurrently deleted before the UPDATE", async () => {
    // Wrap batch so the row is deleted right before the statements run → the
    // UPDATE matches 0 rows. The pre-check (via .prepare) still sees the row.
    const racingDb = {
      prepare: d1.prepare.bind(d1),
      batch: async (statements: D1PreparedStatement[]) => {
        d1.sqlite.prepare("DELETE FROM customer_visits WHERE id = 'v_manual'").run();
        return d1.batch(statements);
      },
    } as unknown as D1Database;

    const result = await updateAdminCustomerVisit({
      db: racingDb,
      admin: owner,
      customerId: "cust_edit_1",
      visitId: "v_manual",
      request: { idempotencyKey: "race-upd-1", visitedAt: "2026-05-15" },
    });
    expect(result).toEqual({ ok: false, reason: "not_found" });
    // The idempotency row must NOT be 'succeeded' (stays 'started'), so a same-key
    // replay returns idempotency_in_progress rather than a false ok.
    const idem = d1.sqlite
      .prepare("SELECT status FROM idempotency_keys WHERE idempotency_key = 'race-upd-1'")
      .get() as { status: string } | undefined;
    expect(idem?.status).toBe("started");
  });

  it("captures an unclassified update batch failure with the original error", async () => {
    const batchError = new Error("injected visit update batch failure");
    const failingDb = {
      prepare: d1.prepare.bind(d1),
      batch: vi.fn().mockRejectedValue(batchError),
    } as unknown as D1Database;

    const result = await updateAdminCustomerVisit({
      db: failingDb,
      admin: owner,
      customerId: "cust_edit_1",
      visitId: "v_manual",
      request: { idempotencyKey: "upd-write-failure-1", visitedAt: "2026-05-15" },
    });

    expect(result).toEqual({ ok: false, reason: "write_failed" });
    expect(captureBatchWriteFailure).toHaveBeenCalledTimes(1);
    expect(captureBatchWriteFailure).toHaveBeenCalledWith(batchError, {
      component: "customer-visits",
      op: "batch_write_failed",
      helper: "updateAdminCustomerVisit",
    });
  });

  it("does not capture when a failed update resolves to an idempotent replay", async () => {
    // The batch commits (succeeded idempotency row included) but its response is
    // lost — the client sees a rejection. The catch's re-resolve then finds the
    // succeeded row and replays. That classified outcome must stay silent.
    // (A pre-seeded success would replay from the PRE-lookup and never reach the
    // batch/catch branch under test.)
    const racingDb = {
      prepare: d1.prepare.bind(d1),
      batch: vi.fn().mockImplementation(async (statements: D1PreparedStatement[]) => {
        await d1.batch(statements);
        throw new Error("injected post-commit failure");
      }),
    } as unknown as D1Database;

    const result = await updateAdminCustomerVisit({
      db: racingDb,
      admin: owner,
      customerId: "cust_edit_1",
      visitId: "v_manual",
      request: base,
    });

    expect(result).toEqual({ ok: true, visitId: "v_manual", replayed: true });
    expect(vi.mocked(racingDb.batch)).toHaveBeenCalledTimes(1);
    expect(captureBatchWriteFailure).not.toHaveBeenCalled();
  });

  it("rejects a visit on an archived customer with not_found and leaves it unchanged", async () => {
    d1.sqlite
      .prepare("UPDATE customers SET archived_at = ? WHERE id = ?")
      .run("2026-06-01T00:00:00.000Z", "cust_edit_1");
    expect(await call(owner, "v_manual")).toEqual({ ok: false, reason: "not_found" });
    const row = d1.sqlite.prepare("SELECT visited_at FROM customer_visits WHERE id = 'v_manual'").get() as {
      visited_at: string;
    };
    expect(row.visited_at).toBe("2026-05-01"); // untouched
  });

  it("returns not_found (idempotency stays started) when the customer is archived before the UPDATE", async () => {
    const racingDb = {
      prepare: d1.prepare.bind(d1),
      batch: async (statements: D1PreparedStatement[]) => {
        d1.sqlite
          .prepare("UPDATE customers SET archived_at = ? WHERE id = ?")
          .run("2026-06-01T00:00:00.000Z", "cust_edit_1");
        return d1.batch(statements);
      },
    } as unknown as D1Database;

    const result = await updateAdminCustomerVisit({
      db: racingDb,
      admin: owner,
      customerId: "cust_edit_1",
      visitId: "v_manual",
      request: { idempotencyKey: "upd-archive-race-1", visitedAt: "2026-05-15" },
    });
    expect(result).toEqual({ ok: false, reason: "not_found" });
    const row = d1.sqlite.prepare("SELECT visited_at FROM customer_visits WHERE id = 'v_manual'").get() as {
      visited_at: string;
    };
    expect(row.visited_at).toBe("2026-05-01"); // untouched
    const idem = d1.sqlite
      .prepare("SELECT status FROM idempotency_keys WHERE idempotency_key = 'upd-archive-race-1'")
      .get() as { status: string } | undefined;
    expect(idem?.status).toBe("started");
  });
});

describe("deleteAdminCustomerVisit — 来店履歴削除", () => {
  let d1: SqliteD1Database;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-06-02T03:00:00.000Z"));
    d1 = createMigratedSqliteD1();
    insertServiceAdmins(d1);
    seedEditFixtures(d1);
  });
  afterEach(() => {
    d1.sqlite.close();
    vi.useRealTimers();
  });

  const call = (admin: AdminUser, visitId: string) =>
    deleteAdminCustomerVisit({
      db: d1 as unknown as D1Database,
      admin,
      customerId: "cust_edit_1",
      visitId,
    });

  it("rejects a staff caller with forbidden", async () => {
    expect(await call(staff, "v_manual")).toEqual({ ok: false, reason: "forbidden" });
  });

  it("still deletes a voided manual visit", async () => {
    d1.sqlite
      .prepare(
        `UPDATE customer_visits
         SET status = 'voided', voided_by = 'seed_admin', voided_at = '2026-05-10T00:00:00.000Z',
             void_reason = 'entered by mistake'
         WHERE id = 'v_manual'`
      )
      .run();
    expect(await call(owner, "v_manual")).toMatchObject({ ok: true });
    expect(
      d1.sqlite.prepare("SELECT COUNT(*) AS n FROM customer_visits WHERE id = 'v_manual'").get()
    ).toEqual({ n: 0 });
  });

  it("rejects an unknown visit with not_found", async () => {
    expect(await call(owner, "v_missing")).toEqual({ ok: false, reason: "not_found" });
  });

  it("rejects a reservation-linked visit with reservation_linked and keeps the row", async () => {
    expect(await call(owner, "v_res")).toEqual({ ok: false, reason: "reservation_linked" });
    const n = (
      d1.sqlite.prepare("SELECT COUNT(*) AS n FROM customer_visits WHERE id = 'v_res'").get() as { n: number }
    ).n;
    expect(n).toBe(1);
  });

  it("deletes a manual visit for an owner and writes an audit row capturing pre-delete fields", async () => {
    expect(await call(owner, "v_manual")).toEqual({ ok: true });
    const n = (
      d1.sqlite.prepare("SELECT COUNT(*) AS n FROM customer_visits WHERE id = 'v_manual'").get() as { n: number }
    ).n;
    expect(n).toBe(0);
    const audit = d1.sqlite
      .prepare(
        "SELECT metadata_json FROM audit_logs WHERE action = 'customer.visit_manual_delete' AND target_id = 'v_manual'"
      )
      .get() as { metadata_json: string };
    expect(audit).toBeTruthy();
    const meta = JSON.parse(audit.metadata_json) as { visited_at: string; visit_source: string };
    expect(meta.visited_at).toBe("2026-05-01");
    expect(meta.visit_source).toBe("manual_import");
  });

  it("rejects an owner revoked immediately before the delete batch without partial writes", async () => {
    let reachedBatch = false;
    const racingDb = {
      prepare: d1.prepare.bind(d1),
      batch: (statements: D1PreparedStatement[]) => {
        reachedBatch = true;
        d1.sqlite.prepare("UPDATE admin_users SET active = 0 WHERE id = ?").run(owner.id);
        return d1.batch(statements);
      },
    } as unknown as D1Database;

    const result = await deleteAdminCustomerVisit({
      db: racingDb,
      admin: owner,
      customerId: "cust_edit_1",
      visitId: "v_manual",
    });

    expect(reachedBatch).toBe(true);
    expect(result).toEqual({ ok: false, reason: "forbidden" });
    expect(d1.sqlite.prepare("SELECT COUNT(*) AS n FROM customer_visits WHERE id = 'v_manual'").get()).toEqual({ n: 1 });
    expect(d1.sqlite.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'customer.visit_manual_delete'").get()).toEqual({ n: 0 });
  });

  it("keeps an unrelated delete batch failure as write_failed", async () => {
    const failingDb = {
      prepare: d1.prepare.bind(d1),
      batch: async () => {
        throw new Error("injected unrelated delete failure");
      },
    } as unknown as D1Database;

    const result = await deleteAdminCustomerVisit({
      db: failingDb,
      admin: owner,
      customerId: "cust_edit_1",
      visitId: "v_manual",
    });

    expect(result).toEqual({ ok: false, reason: "write_failed" });
    expect(d1.sqlite.prepare("SELECT COUNT(*) AS n FROM customer_visits WHERE id = 'v_manual'").get()).toEqual({ n: 1 });
  });

  it("returns not_found (no false ok) when the visit is concurrently deleted before the DELETE", async () => {
    const racingDb = {
      prepare: d1.prepare.bind(d1),
      batch: async (statements: D1PreparedStatement[]) => {
        d1.sqlite.prepare("DELETE FROM customer_visits WHERE id = 'v_manual'").run();
        return d1.batch(statements);
      },
    } as unknown as D1Database;

    const result = await deleteAdminCustomerVisit({
      db: racingDb,
      admin: owner,
      customerId: "cust_edit_1",
      visitId: "v_manual",
    });
    expect(result).toEqual({ ok: false, reason: "not_found" });
  });

  it("rejects a visit on an archived customer with not_found and keeps the row", async () => {
    d1.sqlite
      .prepare("UPDATE customers SET archived_at = ? WHERE id = ?")
      .run("2026-06-01T00:00:00.000Z", "cust_edit_1");
    expect(await call(owner, "v_manual")).toEqual({ ok: false, reason: "not_found" });
    const n = (
      d1.sqlite.prepare("SELECT COUNT(*) AS n FROM customer_visits WHERE id = 'v_manual'").get() as { n: number }
    ).n;
    expect(n).toBe(1); // untouched
  });

  it("returns not_found when the customer is archived before the DELETE (row kept)", async () => {
    const racingDb = {
      prepare: d1.prepare.bind(d1),
      batch: async (statements: D1PreparedStatement[]) => {
        d1.sqlite
          .prepare("UPDATE customers SET archived_at = ? WHERE id = ?")
          .run("2026-06-01T00:00:00.000Z", "cust_edit_1");
        return d1.batch(statements);
      },
    } as unknown as D1Database;

    const result = await deleteAdminCustomerVisit({
      db: racingDb,
      admin: owner,
      customerId: "cust_edit_1",
      visitId: "v_manual",
    });
    expect(result).toEqual({ ok: false, reason: "not_found" });
    const n = (
      d1.sqlite.prepare("SELECT COUNT(*) AS n FROM customer_visits WHERE id = 'v_manual'").get() as { n: number }
    ).n;
    expect(n).toBe(1); // row kept
  });
});
