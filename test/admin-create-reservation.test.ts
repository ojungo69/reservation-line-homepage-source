import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/sentry-helpers", () => ({
  captureBatchWriteFailure: vi.fn(),
  safeCaptureException: vi.fn()
}));

import { createApp } from "../src/app";
import type { AdminUser } from "../src/admin/access";
import { createAdminReservation, type AdminCreateReservationRequest } from "../src/admin/reservation-create";
import { rescheduleAdminReservation } from "../src/admin/reservation-reschedule";
import { listPublicAvailability } from "../src/reservations/public-options";
import { createPublicReservation } from "../src/reservations/public-submit";
import { listMyReservations } from "../src/reservations/my-reservations";
import { processDueLineNotificationJobs } from "../src/line/notifications";
import { getAvailableSlots } from "../src/admin/operations";
import { sha256Hex } from "../src/admin/settings-common";
import { normalizePhone } from "../src/admin/shared";
import { captureBatchWriteFailure } from "../src/sentry-helpers";
import { createMigratedSqliteD1, type SqliteD1Database } from "./helpers/sqlite-d1";
import { createAccessJwksFetchMock, createAccessJwtFixture as createSignedAccessJwtFixture, insertAdminUser as insertAdminUserHelper, type AdminRole } from "./helpers/admin-access";

describe("reservation write authorization boundary", () => {
  const actor: AdminUser = {
    id: "boundary_actor", email: "boundary@example.com", role: "owner",
    staff_member_id: "staff_owner_kyoto", store_id: "kyoto"
  };
  const now = () => Date.parse("2026-05-09T00:00:00.000Z");
  const request = (mode: "id" | "phone" = "id"): AdminCreateReservationRequest => ({
    idempotencyKey: "boundary_create", source: "admin", storeId: "kyoto",
    serviceIds: ["service_kyoto_default_60"], resourceId: "resource_kyoto_calendar",
    startAt: "2026-06-01T03:00:00.000Z",
    ...(mode === "id" ? { customerId: "boundary_customer" }
      : { customer: { displayName: "既存客", phone: "0759990000" } })
  });
  const snapshot = (db: SqliteD1Database) => {
    const tables = db.sqlite.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[];
    return Object.fromEntries(tables.map(({ name }) => [name,
      db.sqlite.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}" ORDER BY rowid`).all()
    ]));
  };
  const seed = async (db: SqliteD1Database, role: AdminRole = "owner") => {
    insertAdminUserHelper(db, { id: actor.id, email: actor.email, accessSubject: "boundary_subject", role, staffMemberId: actor.staff_member_id });
    db.sqlite.prepare("INSERT INTO customers (id, display_name, phone_normalized, phone_hash) VALUES ('boundary_customer', '既存客', '0759990000', ?)")
      .run(await sha256Hex("0759990000"));
  };
  const seedReservation = (db: SqliteD1Database) => {
    db.sqlite.exec(`
      INSERT INTO line_identities (id, customer_id, channel_id, line_user_id, official_friend_status)
      VALUES ('boundary_line', 'boundary_customer', 'channel', 'boundary_line_user', 'friend');
      INSERT INTO reservations (id, store_id, service_id, resource_id, customer_id, line_identity_id, source, status, start_at, end_at, duration_minutes, idempotency_key)
      VALUES ('boundary_reservation', 'kyoto', 'service_kyoto_default_60', 'resource_kyoto_calendar', 'boundary_customer', 'boundary_line', 'web_line', 'confirmed', '2026-06-01T01:00:00.000Z', '2026-06-01T02:00:00.000Z', 60, 'boundary_original');
      INSERT INTO slot_locks (id, store_id, resource_id, slot_at, owner_type, owner_id, lock_status)
      VALUES ('boundary_slot', 'kyoto', 'resource_kyoto_calendar', '2026-06-01T01:00:00.000Z', 'reservation', 'boundary_reservation', 'confirmed');
      INSERT INTO customer_time_locks (id, customer_id, slot_at, owner_type, owner_id, lock_status)
      VALUES ('boundary_time', 'boundary_customer', '2026-06-01T01:00:00.000Z', 'reservation', 'boundary_reservation', 'confirmed');
    `);
  };
  const operations = [
    { name: "create", run: (db: D1Database, admin: AdminUser) => createAdminReservation({ db, admin, request: request("phone"), now }) },
    { name: "create new customer", run: (db: D1Database, admin: AdminUser) => createAdminReservation({
      db, admin, request: { ...request("phone"), customer: { displayName: "新規客", phone: "0759990001" } }, now
    }) },
    { name: "reschedule", run: (db: D1Database, admin: AdminUser) => rescheduleAdminReservation({
      db, admin, reservationId: "boundary_reservation", request: { idempotencyKey: "boundary_reschedule", startAt: "2026-06-01T03:00:00.000Z" }, now
    }) }
  ];
  const revocations = [
    "UPDATE admin_users SET active = 0 WHERE id = 'boundary_actor'",
    "UPDATE admin_users SET role = 'staff' WHERE id = 'boundary_actor'",
    "UPDATE admin_users SET staff_member_id = 'staff_owner_osaka' WHERE id = 'boundary_actor'",
    "UPDATE admin_users SET staff_member_id = NULL WHERE id = 'boundary_actor'",
    "UPDATE staff_members SET store_id = 'osaka' WHERE id = 'staff_owner_kyoto'",
    "DELETE FROM admin_users WHERE id = 'boundary_actor'"
  ];
  it("resolves the LINE link inside the booking transaction after a concurrent unlink", async () => {
    const db = createMigratedSqliteD1();
    try {
      await seed(db);
      seedReservation(db);
      const racing = { prepare: db.prepare.bind(db), batch: (statements: D1PreparedStatement[]) => {
        db.sqlite.exec("DELETE FROM line_identities WHERE id = 'boundary_line'");
        return db.batch(statements);
      } } as unknown as D1Database;
      const result = await createAdminReservation({ db: racing, admin: actor, request: request(), now, lineChannelId: "channel" });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.reason);
      expect(db.sqlite.prepare("SELECT line_identity_id FROM reservations WHERE id = ?")
        .get(result.reservationId)).toEqual({ line_identity_id: null });
      expect(db.sqlite.prepare("SELECT COUNT(*) AS n FROM notification_jobs").get()).toEqual({ n: 0 });
    } finally { db.sqlite.close(); }
  });
  for (const operation of operations) {
    it.each(revocations)(`${operation.name} rejects a stale actor without any persisted side effect: %s`, async revoke => {
      const db = createMigratedSqliteD1();
      try {
        await seed(db);
        seedReservation(db);
        let before: ReturnType<typeof snapshot> | undefined;
        const racing = { prepare: db.prepare.bind(db), batch: (statements: D1PreparedStatement[]) => {
          db.sqlite.exec(revoke);
          before = snapshot(db);
          return db.batch(statements);
        } } as unknown as D1Database;
        expect(await operation.run(racing, actor)).toEqual({ ok: false, reason: "forbidden" });
        expect(before, "must reach the actual mutation batch").toBeDefined();
        expect(snapshot(db)).toEqual(before);
      } finally { db.sqlite.close(); }
    });
    it.each(["staff", "owner", "system_admin"] as const)(`${operation.name} keeps a current %s authorized`, async role => {
      const db = createMigratedSqliteD1();
      try {
        await seed(db, role);
        seedReservation(db);
        expect(await operation.run(db as unknown as D1Database, { ...actor, role })).toMatchObject({ ok: true });
      } finally { db.sqlite.close(); }
    });
    it(`${operation.name} does not misclassify an actor restored after rollback`, async () => {
      const db = createMigratedSqliteD1();
      try {
        await seed(db);
        seedReservation(db);
        const before = snapshot(db);
        const racing = { prepare: db.prepare.bind(db), batch: async (statements: D1PreparedStatement[]) => {
          db.sqlite.exec("UPDATE admin_users SET active = 0 WHERE id = 'boundary_actor'");
          try { return await db.batch(statements); }
          finally { db.sqlite.exec("UPDATE admin_users SET active = 1 WHERE id = 'boundary_actor'"); }
        } } as unknown as D1Database;
        expect(await operation.run(racing, actor)).toEqual({ ok: false, reason: "write_failed" });
        expect(snapshot(db)).toEqual(before);
      } finally { db.sqlite.close(); }
    });
    it(`${operation.name} rejects an already-missing actor`, async () => {
      const db = createMigratedSqliteD1();
      try {
        await seed(db);
        seedReservation(db);
        db.sqlite.exec("DELETE FROM admin_users WHERE id = 'boundary_actor'");
        const before = snapshot(db);
        expect(await operation.run(db as unknown as D1Database, actor)).toEqual({ ok: false, reason: "forbidden" });
        expect(snapshot(db)).toEqual(before);
      } finally { db.sqlite.close(); }
    });
    it.each([
      "INSERT INTO idempotency_keys (id, scope, idempotency_key, status) VALUES ('boundary_bad', 'invalid_scope', 'boundary_bad', 'started')",
      "INSERT INTO audit_logs (id, actor_type, actor_id, action, target_type, target_id) VALUES ('boundary_bad', 'invalid_actor', 'fixture', 'fixture', 'customer', 'boundary_customer')"
    ])(`${operation.name} preserves unrelated CHECK errors and rolls back: %s`, async sql => {
      const db = createMigratedSqliteD1();
      try {
        await seed(db);
        seedReservation(db);
        const before = snapshot(db);
        const failing = { prepare: db.prepare.bind(db), batch: (statements: D1PreparedStatement[]) => db.batch([...statements, db.prepare(sql)]) } as unknown as D1Database;
        expect(await operation.run(failing, actor)).toEqual({ ok: false, reason: "write_failed" });
        expect(snapshot(db)).toEqual(before);
      } finally { db.sqlite.close(); }
    });
  }
  it("reschedule preserves the current target store and every side effect when that store changes", async () => {
    const db = createMigratedSqliteD1();
    try {
      await seed(db, "staff");
      seedReservation(db);
      let before: ReturnType<typeof snapshot> | undefined;
      const racing = { prepare: db.prepare.bind(db), batch: (statements: D1PreparedStatement[]) => {
        db.sqlite.exec(`
          DELETE FROM slot_locks WHERE owner_id = 'boundary_reservation';
          UPDATE reservations SET store_id = 'osaka', service_id = 'service_osaka_default_60', resource_id = 'resource_osaka_calendar'
          WHERE id = 'boundary_reservation';
        `);
        before = snapshot(db);
        return db.batch(statements);
      } } as unknown as D1Database;
      expect(await operations[2].run(racing, { ...actor, role: "staff" })).toEqual({ ok: false, reason: "write_failed" });
      expect(before).toBeDefined();
      expect(snapshot(db)).toEqual(before);
    } finally { db.sqlite.close(); }
  });
  const membershipArms = [
    { name: "reservation", add: "INSERT INTO reservations (id, store_id, service_id, resource_id, customer_id, source, status, start_at, end_at, duration_minutes, idempotency_key) VALUES ('boundary_membership', 'kyoto', 'service_kyoto_default_60', 'resource_kyoto_calendar', 'boundary_customer', 'admin', 'completed', '2026-01-01T01:00:00Z', '2026-01-01T02:00:00Z', 60, 'boundary_membership')", revoke: "DELETE FROM reservations WHERE id = 'boundary_membership'" },
    { name: "valid visit", add: "INSERT INTO customer_visits (id, customer_id, store_id, visited_at, visit_source, status, recorded_by) VALUES ('boundary_membership', 'boundary_customer', 'kyoto', '2026-01-01', 'manual_import', 'valid', 'fixture')", revoke: "UPDATE customer_visits SET status = 'voided', voided_by = 'fixture', voided_at = '2026-05-09T00:00:00Z', void_reason = '訂正' WHERE id = 'boundary_membership'" },
    { name: "manual registration", add: "UPDATE customers SET created_store_id = 'kyoto' WHERE id = 'boundary_customer'", revoke: "UPDATE customers SET created_store_id = NULL WHERE id = 'boundary_customer'" }
  ];
  for (const mode of ["id", "phone"] as const) {
    for (const membership of membershipArms) {
      it.each([false, true])(`create ${mode} checks current ${membership.name} membership before inserting the new reservation (revoked=%s)`, async revoked => {
        const db = createMigratedSqliteD1();
        try {
          await seed(db, "staff");
          db.sqlite.exec(membership.add);
          let before: ReturnType<typeof snapshot> | undefined;
          const racing = { prepare: db.prepare.bind(db), batch: (statements: D1PreparedStatement[]) => {
            if (revoked) db.sqlite.exec(membership.revoke);
            before = snapshot(db);
            return db.batch(statements);
          } } as unknown as D1Database;
          const result = await createAdminReservation({ db: racing, admin: { ...actor, role: "staff" }, request: request(mode), now });
          expect(before, "must reach the actual mutation batch").toBeDefined();
          if (revoked) {
            expect(result).toEqual({ ok: false, reason: "forbidden" });
            expect(snapshot(db)).toEqual(before);
          } else {
            expect(result).toMatchObject({ ok: true });
            expect(db.sqlite.prepare("SELECT COUNT(*) AS n FROM customers WHERE phone_normalized = '0759990000'").get()).toEqual({ n: 1 });
          }
        } finally { db.sqlite.close(); }
      });
    }
    it.each(["archived_at = '2026-05-09T00:00:00Z'", "merged_into_id = 'boundary_merge_target'"])(`create ${mode} refuses an existing customer who stops being canonical: %s`, async change => {
      const db = createMigratedSqliteD1();
      try {
        await seed(db);
        db.sqlite.exec("INSERT INTO customers (id, display_name) VALUES ('boundary_merge_target', '統合先')");
        let before: ReturnType<typeof snapshot> | undefined;
        const racing = { prepare: db.prepare.bind(db), batch: (statements: D1PreparedStatement[]) => {
          db.sqlite.exec(`UPDATE customers SET ${change} WHERE id = 'boundary_customer'`);
          before = snapshot(db);
          return db.batch(statements);
        } } as unknown as D1Database;
        expect(await createAdminReservation({ db: racing, admin: actor, request: request(mode), now }))
          .toEqual({ ok: false, reason: "customer_not_found" });
        expect(before).toBeDefined();
        expect(snapshot(db)).toEqual(before);
      } finally { db.sqlite.close(); }
    });
  }
});

beforeEach(() => {
  vi.mocked(captureBatchWriteFailure).mockClear();
});

const TEAM_DOMAIN = "https://team.example.cloudflareaccess.com";
const ACCESS_AUD = "admin-access-aud";
const ADMIN_EMAIL = "owner@example.com";
const ADMIN_ACCESS_SUBJECT = "access-subject-admin-create";

const createAccessJwtFixture = () =>
  createSignedAccessJwtFixture({
    issuer: TEAM_DOMAIN,
    audience: ACCESS_AUD,
    keyId: "admin-create-key-1",
    claims: { email: ADMIN_EMAIL, sub: ADMIN_ACCESS_SUBJECT }
  });

const createFetchMock = (jwk: Parameters<typeof createAccessJwksFetchMock>[1]) =>
  createAccessJwksFetchMock(TEAM_DOMAIN, jwk);

// staffMemberId を渡すと staff_members 行も作成して紐付ける（HTTP 認証後の
// store_id は admin_users.staff_member_id → staff_members.store_id JOIN 由来のため、
// 紐付けの無い staff は store_id=null = fail-closed 分岐しか踏めない）。
const insertAdminUser = (
  db: SqliteD1Database,
  role: AdminRole = "owner",
  staffMemberId?: { id: string; storeId: string }
) => {
  if (staffMemberId) {
    db.sqlite
      .prepare(
        `
          INSERT INTO staff_members (id, store_id, display_name, role, active, updated_at)
          VALUES (?, ?, 'テスト スタッフ', 'staff', 1, '2026-05-09T00:00:00.000Z')
        `
      )
      .run(staffMemberId.id, staffMemberId.storeId);
  }
  insertAdminUserHelper(db, {
    id: "admin_create_owner_1",
    email: ADMIN_EMAIL,
    accessSubject: ADMIN_ACCESS_SUBJECT,
    role,
    staffMemberId: staffMemberId?.id ?? null,
    updatedAt: "2026-05-09T00:00:00.000Z",
  });
};

const baseEnv = (db: SqliteD1Database): Record<string, unknown> => ({
  ACCESS_TEAM_DOMAIN: TEAM_DOMAIN,
  ACCESS_AUD,
  LINE_CHANNEL_ID: "line_channel_admin",
  DB: db
});

const createRequestBody = (overrides: Record<string, unknown> = {}) => {
  return {
    idempotencyKey: "admin-create-phone-1",
    source: "phone_admin",
    storeId: "kyoto",
    serviceIds: ["service_kyoto_default_60"],
    resourceId: "resource_kyoto_calendar",
    startAt: "2026-06-01T01:00:00.000Z",
    customer: {
      displayName: "電話 予約",
      displayNameKana: "デンワ ヨヤク",
      phone: "075-000-0000"
    },
    ...overrides
  };
};

const postAdminReservation = async (
  db: SqliteD1Database,
  token: string,
  body: Record<string, unknown>
) => {
  const app = createApp();
  return app.request(
    "/api/admin/reservations",
    {
      method: "POST",
      body: JSON.stringify(body),
      headers: {
        "Content-Type": "application/json",
        "Cf-Access-Jwt-Assertion": token
      }
    },
    baseEnv(db)
  );
};

describe("admin reservation creation API", () => {
  beforeEach(() => {
    // Freeze only Date (real timers preserved for async flow) so the hard-coded
    // 2026-06-01 slots stay in the future regardless of wall-clock run date.
    vi.useFakeTimers({ now: new Date("2026-05-09T00:00:00.000Z"), toFake: ["Date"] });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("serves available slots without /reservations/:id swallowing the static route", async () => {
    const db = createMigratedSqliteD1();
    const access = createAccessJwtFixture();
    vi.stubGlobal("fetch", createFetchMock(access.jwk));

    try {
      insertAdminUser(db);

      // Prevent the static route from being swallowed by /reservations/:id and returning 404.
      const response = await createApp().request(
        "/api/admin/reservations/available-slots?storeId=kyoto&date=2026-06-01&durationMinutes=60",
        {
          method: "GET",
          headers: {
            "Cf-Access-Jwt-Assertion": access.token
          }
        },
        baseEnv(db)
      );

      expect(response.status).toBe(200);
      const body = await response.json() as { ok: boolean; slots: unknown[] };
      expect(body.ok).toBe(true);
      expect(body.slots.length).toBeGreaterThanOrEqual(1);
    } finally {
      db.sqlite.close();
    }
  });

  it("accepts the 235-minute available-slots boundary and rejects 236 minutes", async () => {
    const db = createMigratedSqliteD1();
    const access = createAccessJwtFixture();
    vi.stubGlobal("fetch", createFetchMock(access.jwk));

    try {
      insertAdminUser(db);
      const headers = { "Cf-Access-Jwt-Assertion": access.token };
      const app = createApp();

      const boundary = await app.request(
        "/api/admin/reservations/available-slots?storeId=kyoto&date=2026-06-01&durationMinutes=235",
        { headers },
        baseEnv(db)
      );
      const overLimit = await app.request(
        "/api/admin/reservations/available-slots?storeId=kyoto&date=2026-06-01&durationMinutes=236",
        { headers },
        baseEnv(db)
      );

      expect(boundary.status).toBe(200);
      expect(overLimit.status).toBe(400);
      await expect(overLimit.json()).resolves.toEqual({ ok: false, reason: "invalid_request" });

      // 240 は5分グリッド上の値のため、上限判定単独の違反を検証できる
      // （236 だとグリッド違反と重なり、上限が緩んでもテストが通ってしまう）。
      const overLimitOnGrid = await app.request(
        "/api/admin/reservations/available-slots?storeId=kyoto&date=2026-06-01&durationMinutes=240",
        { headers },
        baseEnv(db)
      );
      expect(overLimitOnGrid.status).toBe(400);

      // 作成側は各メニュー duration を5分グリッドに限定している。空き枠側も
      // 非整数・非5分単位を拒否し、直接 API 利用時の契約を一致させる。
      for (const invalid of ["7.5", "233"]) {
        const offGrid = await app.request(
          `/api/admin/reservations/available-slots?storeId=kyoto&date=2026-06-01&durationMinutes=${invalid}`,
          { headers },
          baseEnv(db)
        );
        expect(offGrid.status, `durationMinutes=${invalid}`).toBe(400);
      }
    } finally {
      db.sqlite.close();
    }
  });

  describe("available-slots excludeReservationId / customerId modes", () => {
    // 2026-06-01 (Mon, kyoto open 10:00-20:00 JST). JST 10:00 = 01:00Z, 12:00 = 03:00Z.
    const AT_1000 = "2026-06-01T01:00:00.000Z";
    const AT_1200 = "2026-06-01T03:00:00.000Z";
    const CUSTOMER_ID = "cust-slots-http";
    const RESV_A = "resv-slots-a";

    /** Slot count for raw treatment time (occupancy adds the 5-min buffer) in the 10:00-20:00 window. */
    const expectedSlotCount = (treatmentMinutes: number): number => {
      let count = 0;
      for (let m = 600; m + treatmentMinutes + 5 <= 1200; m += 15) count += 1;
      return count;
    };

    const seedCustomer = (db: SqliteD1Database, id: string) => {
      db.sqlite.prepare(`INSERT INTO customers (id, display_name) VALUES (?, '配線 テスト')`).run(id);
    };

    /** Reservation row + its own slot_locks / customer_time_locks (both owner_type='reservation'). */
    const seedReservation = (
      db: SqliteD1Database,
      opts: {
        id: string;
        customerId: string;
        status?: string;
        checkedInAt?: string | null;
        withOwnLocks?: boolean;
      }
    ) => {
      db.sqlite
        .prepare(
          `INSERT INTO reservations (
             id, store_id, service_id, customer_id, resource_id, source, status,
             start_at, end_at, duration_minutes, checked_in_at, idempotency_key
           ) VALUES (?, 'kyoto', 'service_kyoto_default_60', ?, 'resource_kyoto_calendar', 'phone_admin', ?,
             ?, ?, 60, ?, ?)`
        )
        .run(
          opts.id,
          opts.customerId,
          opts.status ?? "confirmed",
          AT_1000,
          "2026-06-01T02:00:00.000Z",
          opts.checkedInAt ?? null,
          `idem-${opts.id}`
        );
      if (opts.withOwnLocks) {
        for (let step = 0; step < 12; step++) {
          const slotAt = new Date(Date.parse(AT_1000) + step * 5 * 60_000).toISOString();
          db.sqlite
            .prepare(
              `INSERT INTO slot_locks (id, store_id, resource_id, slot_at, owner_type, owner_id, lock_status)
               VALUES (?, 'kyoto', 'resource_kyoto_calendar', ?, 'reservation', ?, 'confirmed')`
            )
            .run(`sl_${opts.id}_${step}`, slotAt, opts.id);
          db.sqlite
            .prepare(
              `INSERT INTO customer_time_locks (id, customer_id, slot_at, owner_type, owner_id, lock_status)
               VALUES (?, ?, ?, 'reservation', ?, 'confirmed')`
            )
            .run(`ctl_${opts.id}_${step}`, opts.customerId, slotAt, opts.id);
        }
      }
    };

    const seedOtherCustomerBusy = (db: SqliteD1Database, customerId: string, slotAt: string) => {
      db.sqlite
        .prepare(
          `INSERT INTO customer_time_locks (id, customer_id, slot_at, owner_type, owner_id, lock_status)
           VALUES (?, ?, ?, 'reservation', 'resv-elsewhere', 'confirmed')`
        )
        .run(`ctl_other_${slotAt}`, customerId, slotAt);
    };

    const getSlots = async (db: SqliteD1Database, token: string, query: string) => {
      return createApp().request(
        `/api/admin/reservations/available-slots?${query}`,
        { headers: { "Cf-Access-Jwt-Assertion": token } },
        baseEnv(db)
      );
    };

    it("reschedule mode: derives resource/duration/customer from the row and excludes only self locks", async () => {
      const db = createMigratedSqliteD1();
      const access = createAccessJwtFixture();
      vi.stubGlobal("fetch", createFetchMock(access.jwk));

      try {
        insertAdminUser(db);
        seedCustomer(db, CUSTOMER_ID);
        seedReservation(db, { id: RESV_A, customerId: CUSTOMER_ID, withOwnLocks: true });
        // Same customer, different booking elsewhere: must stay busy via the
        // DERIVED customerId (fails if the route drops the derivation).
        seedOtherCustomerBusy(db, CUSTOMER_ID, AT_1200);

        const response = await getSlots(
          db,
          access.token,
          `storeId=kyoto&date=2026-06-01&excludeReservationId=${RESV_A}`
        );
        expect(response.status).toBe(200);
        const body = (await response.json()) as {
          ok: boolean;
          slots: { resourceId: string; startAt: string; available: boolean }[];
        };
        expect(body.ok).toBe(true);
        // Own span freed (fails if excludeReservationId is not wired through).
        expect(body.slots.find((s) => s.startAt === AT_1000)?.available).toBe(true);
        // Other booking of the same customer stays busy.
        expect(body.slots.find((s) => s.startAt === AT_1200)?.available).toBe(false);
        // Resource + duration derived from the reservation row (occupied 60 → treatment 55).
        expect(body.slots.every((s) => s.resourceId === "resource_kyoto_calendar")).toBe(true);
        expect(body.slots).toHaveLength(expectedSlotCount(55));

        // Tampered duration/resource are ignored, not honored and not a 400:
        // 235 minutes would shrink the layout, the osaka resource would empty it.
        const tampered = await getSlots(
          db,
          access.token,
          `storeId=kyoto&date=2026-06-01&excludeReservationId=${RESV_A}&durationMinutes=235&resourceId=resource_osaka_calendar`
        );
        expect(tampered.status).toBe(200);
        const tamperedBody = (await tampered.json()) as {
          ok: boolean;
          slots: { resourceId: string }[];
        };
        expect(tamperedBody.slots).toHaveLength(expectedSlotCount(55));
        expect(tamperedBody.slots.every((s) => s.resourceId === "resource_kyoto_calendar")).toBe(true);
      } finally {
        db.sqlite.close();
      }
    });

    it("reschedule mode accepts the write-path minimum duration_minutes = 5 (legacy rows)", async () => {
      const db = createMigratedSqliteD1();
      const access = createAccessJwtFixture();
      vi.stubGlobal("fetch", createFetchMock(access.jwk));

      try {
        insertAdminUser(db);
        seedCustomer(db, CUSTOMER_ID);
        // Occupied span 5 = zero treatment beyond the cleanup buffer. The write
        // path (rescheduleAdminReservation) moves such a row without complaint,
        // so the picker must not 403 it. (chatgpt-codex-connector regression)
        db.sqlite
          .prepare(
            `INSERT INTO reservations (
               id, store_id, service_id, customer_id, resource_id, source, status,
               start_at, end_at, duration_minutes, idempotency_key
             ) VALUES ('resv-legacy-5min', 'kyoto', 'service_kyoto_default_60', ?, 'resource_kyoto_calendar',
               'system_import', 'confirmed', ?, ?, 5, 'idem-legacy-5min')`
          )
          .run(CUSTOMER_ID, AT_1000, "2026-06-01T01:05:00.000Z");

        const response = await getSlots(
          db,
          access.token,
          "storeId=kyoto&date=2026-06-01&excludeReservationId=resv-legacy-5min"
        );
        expect(response.status).toBe(200);
        const body = (await response.json()) as { ok: boolean; slots: unknown[] };
        expect(body.ok).toBe(true);
        // Treatment 0 → occupied 5 layout across the 10:00-20:00 window.
        expect(body.slots).toHaveLength(expectedSlotCount(0));
      } finally {
        db.sqlite.close();
      }
    });

    it("reschedule mode fails closed with one uniform 403 body", async () => {
      const db = createMigratedSqliteD1();
      const access = createAccessJwtFixture();
      vi.stubGlobal("fetch", createFetchMock(access.jwk));

      try {
        insertAdminUser(db);
        seedCustomer(db, CUSTOMER_ID);
        seedReservation(db, { id: RESV_A, customerId: CUSTOMER_ID, withOwnLocks: true });
        seedReservation(db, {
          id: "resv-checked-in",
          customerId: CUSTOMER_ID,
          checkedInAt: "2026-05-08T00:00:00.000Z",
        });
        seedReservation(db, { id: "resv-completed", customerId: CUSTOMER_ID, status: "completed" });

        const forbiddenQueries = [
          // Missing row, cross-store target, checked-in and terminal states all
          // collapse into the same 403 so reservation ids cannot be probed.
          "storeId=kyoto&date=2026-06-01&excludeReservationId=resv-missing",
          `storeId=osaka&date=2026-06-01&excludeReservationId=${RESV_A}`,
          "storeId=kyoto&date=2026-06-01&excludeReservationId=resv-checked-in",
          "storeId=kyoto&date=2026-06-01&excludeReservationId=resv-completed",
        ];
        for (const query of forbiddenQueries) {
          const response = await getSlots(db, access.token, query);
          expect(response.status, query).toBe(403);
          await expect(response.json()).resolves.toEqual({ ok: false, reason: "forbidden" });
        }

        // Both extras together is a client bug → 400, not a silent pick.
        const both = await getSlots(
          db,
          access.token,
          `storeId=kyoto&date=2026-06-01&excludeReservationId=${RESV_A}&customerId=${CUSTOMER_ID}`
        );
        expect(both.status).toBe(400);
        await expect(both.json()).resolves.toEqual({ ok: false, reason: "invalid_request" });
      } finally {
        db.sqlite.close();
      }
    });

    it("create mode: own-store staff sees the customer's conflicts; out-of-scope customers are 403", async () => {
      const db = createMigratedSqliteD1();
      const access = createAccessJwtFixture();
      vi.stubGlobal("fetch", createFetchMock(access.jwk));

      try {
        insertAdminUser(db, "staff", { id: "staff_kyoto_slots", storeId: "kyoto" });
        seedCustomer(db, CUSTOMER_ID);
        // A kyoto reservation makes the customer visible in the staff's store
        // scope (staffCanAccessCustomer) AND provides the busy span to hide.
        seedReservation(db, { id: RESV_A, customerId: CUSTOMER_ID, withOwnLocks: true });
        seedCustomer(db, "cust-no-scope");

        const ok = await getSlots(
          db,
          access.token,
          `storeId=kyoto&date=2026-06-01&customerId=${CUSTOMER_ID}`
        );
        expect(ok.status).toBe(200);
        const body = (await ok.json()) as {
          ok: boolean;
          slots: { startAt: string; available: boolean }[];
        };
        // No exclusion in create mode: the customer's own booking stays busy
        // (fails if the route drops the customerId wiring).
        expect(body.slots.find((s) => s.startAt === AT_1000)?.available).toBe(false);

        // Customer without any kyoto reservation/visit (and nonexistent ids)
        // fail closed with the same 403 body.
        for (const customerId of ["cust-no-scope", "cust-missing"]) {
          const forbidden = await getSlots(
            db,
            access.token,
            `storeId=kyoto&date=2026-06-01&customerId=${customerId}`
          );
          expect(forbidden.status, customerId).toBe(403);
          await expect(forbidden.json()).resolves.toEqual({ ok: false, reason: "forbidden" });
        }
      } finally {
        db.sqlite.close();
      }
    });

    it("reschedule mode: own-store staff succeeds; cross-store staff is 403 before any lookup", async () => {
      const db = createMigratedSqliteD1();
      const access = createAccessJwtFixture();
      vi.stubGlobal("fetch", createFetchMock(access.jwk));

      try {
        insertAdminUser(db, "staff", { id: "staff_kyoto_resched", storeId: "kyoto" });
        seedCustomer(db, CUSTOMER_ID);
        seedReservation(db, { id: RESV_A, customerId: CUSTOMER_ID, withOwnLocks: true });

        const ok = await getSlots(
          db,
          access.token,
          `storeId=kyoto&date=2026-06-01&excludeReservationId=${RESV_A}`
        );
        expect(ok.status).toBe(200);
        const body = (await ok.json()) as { slots: { startAt: string; available: boolean }[] };
        expect(body.slots.find((s) => s.startAt === AT_1000)?.available).toBe(true);

        // The staff store gate fires on the query storeId itself.
        const crossStore = await getSlots(
          db,
          access.token,
          `storeId=osaka&date=2026-06-01&excludeReservationId=${RESV_A}`
        );
        expect(crossStore.status).toBe(403);
        await expect(crossStore.json()).resolves.toEqual({ ok: false, reason: "forbidden" });
      } finally {
        db.sqlite.close();
      }
    });

    it("create mode: owner may query any customerId; unknown ids just return open slots", async () => {
      const db = createMigratedSqliteD1();
      const access = createAccessJwtFixture();
      vi.stubGlobal("fetch", createFetchMock(access.jwk));

      try {
        insertAdminUser(db);

        const response = await getSlots(
          db,
          access.token,
          "storeId=kyoto&date=2026-06-01&customerId=cust-unknown"
        );
        expect(response.status).toBe(200);
        const body = (await response.json()) as { ok: boolean; slots: { available: boolean }[] };
        expect(body.ok).toBe(true);
        expect(body.slots.every((s) => s.available)).toBe(true);
      } finally {
        db.sqlite.close();
      }
    });
  });

  it("creates phone reservations as formal confirmed D1 reservations with locks and audit logs", async () => {
    const db = createMigratedSqliteD1();
    const access = createAccessJwtFixture();
    vi.stubGlobal("fetch", createFetchMock(access.jwk));

    try {
      insertAdminUser(db);

      const response = await postAdminReservation(db, access.token, createRequestBody());

      expect(response.status).toBe(201);
      const json = await response.json() as {
        ok: boolean;
        reservationId: string;
        status: string;
        source: string;
        replayed: boolean;
      };
      expect(json).toMatchObject({
        ok: true,
        status: "confirmed",
        source: "phone_admin",
        replayed: false
      });

      const reservation = db.sqlite
        .prepare("SELECT source, status, service_id, duration_minutes, line_identity_id, created_by FROM reservations WHERE id = ?")
        .get(json.reservationId) as {
          source: string;
          status: string;
          service_id: string;
          duration_minutes: number;
          line_identity_id: string | null;
          created_by: string;
        };
      const reservationServices = db.sqlite
        .prepare(
          "SELECT service_id, display_order, duration_minutes FROM reservation_services WHERE reservation_id = ? ORDER BY display_order"
        )
        .all(json.reservationId) as Array<{
          service_id: string;
          display_order: number;
          duration_minutes: number;
        }>;
      const auditMetadata = JSON.parse(
        (
          db.sqlite
            .prepare(
              "SELECT metadata_json FROM audit_logs WHERE target_id = ? AND action = 'admin_reservation_created'"
            )
            .get(json.reservationId) as { metadata_json: string }
        ).metadata_json
      ) as { serviceId: string; serviceIds: string[] };
      const locks = db.sqlite
        .prepare(
          `
            SELECT
              (SELECT COUNT(*) FROM slot_locks WHERE owner_id = ? AND lock_status = 'confirmed' AND expires_at IS NULL) AS slotCount,
              (SELECT COUNT(*) FROM customer_time_locks WHERE owner_id = ? AND lock_status = 'confirmed' AND expires_at IS NULL) AS customerLockCount,
              (SELECT COUNT(*) FROM calendar_sync_jobs WHERE owner_id = ? AND google_action = 'upsert') AS calendarJobCount,
              (SELECT COUNT(*) FROM audit_logs WHERE target_id = ? AND action = 'admin_reservation_created') AS auditCount
          `
        )
        .get(json.reservationId, json.reservationId, json.reservationId, json.reservationId) as {
          slotCount: number;
          customerLockCount: number;
          calendarJobCount: number;
          auditCount: number;
        };

      expect(reservation).toEqual({
        source: "phone_admin",
        status: "confirmed",
        service_id: "service_kyoto_default_60",
        duration_minutes: 65,
        line_identity_id: null,
        created_by: "admin_create_owner_1"
      });
      expect(reservationServices).toEqual([
        {
          service_id: "service_kyoto_default_60",
          display_order: 0,
          duration_minutes: 60
        }
      ]);
      expect(auditMetadata).toMatchObject({
        serviceId: "service_kyoto_default_60",
        serviceIds: ["service_kyoto_default_60"]
      });
      expect(locks).toEqual({
        slotCount: 13,
        customerLockCount: 13,
        calendarJobCount: 1,
        auditCount: 1
      });
    } finally {
      db.sqlite.close();
    }
  });

  it("creates an authenticated multi-service reservation with ordered snapshots and audit metadata", async () => {
    const db = createMigratedSqliteD1();
    const access = createAccessJwtFixture();
    vi.stubGlobal("fetch", createFetchMock(access.jwk));

    try {
      insertAdminUser(db);
      const serviceIds = [
        "service_kyoto_default_60",
        "service_kyoto_hair_removal_upper_focus_45"
      ];
      const response = await postAdminReservation(
        db,
        access.token,
        createRequestBody({
          idempotencyKey: "admin-create-multi-1",
          serviceIds
        })
      );

      expect(response.status).toBe(201);
      const result = await response.json() as { reservationId: string; endAt: string };
      expect(result.endAt).toBe("2026-06-01T02:50:00.000Z");

      const reservation = db.sqlite
        .prepare("SELECT service_id, duration_minutes, end_at FROM reservations WHERE id = ?")
        .get(result.reservationId) as { service_id: string; duration_minutes: number; end_at: string };
      const snapshots = db.sqlite
        .prepare(
          `SELECT service_id, display_order, name_snapshot, duration_minutes
           FROM reservation_services WHERE reservation_id = ? ORDER BY display_order`
        )
        .all(result.reservationId) as Array<{
          service_id: string;
          display_order: number;
          name_snapshot: string;
          duration_minutes: number;
        }>;
      const audit = db.sqlite
        .prepare(
          "SELECT metadata_json FROM audit_logs WHERE target_id = ? AND action = 'admin_reservation_created'"
        )
        .get(result.reservationId) as { metadata_json: string };

      expect(reservation).toEqual({
        service_id: serviceIds[0],
        duration_minutes: 110,
        end_at: "2026-06-01T02:50:00.000Z"
      });
      expect(snapshots).toEqual([
        {
          service_id: serviceIds[0],
          display_order: 0,
          name_snapshot: "マッサージ｜サンプル 04",
          duration_minutes: 60
        },
        {
          service_id: serviceIds[1],
          display_order: 1,
          name_snapshot: "脱毛｜サンプル 14",
          duration_minutes: 45
        }
      ]);
      expect(JSON.parse(audit.metadata_json)).toMatchObject({
        serviceId: serviceIds[0],
        serviceIds
      });
    } finally {
      db.sqlite.close();
    }
  });

  it("deduplicates normalized service IDs before duration, hashing, and persistence", async () => {
    const db = createMigratedSqliteD1();
    const access = createAccessJwtFixture();
    vi.stubGlobal("fetch", createFetchMock(access.jwk));

    try {
      insertAdminUser(db);
      const response = await postAdminReservation(
        db,
        access.token,
        createRequestBody({
          idempotencyKey: "admin-create-multi-dedupe-1",
          serviceIds: [
            " service_kyoto_default_60 ",
            "service_kyoto_hair_removal_upper_focus_45",
            "service_kyoto_default_60"
          ]
        })
      );

      expect(response.status).toBe(201);
      const result = await response.json() as { reservationId: string };
      const reservation = db.sqlite
        .prepare("SELECT duration_minutes FROM reservations WHERE id = ?")
        .get(result.reservationId) as { duration_minutes: number };
      const services = db.sqlite
        .prepare(
          "SELECT service_id FROM reservation_services WHERE reservation_id = ? ORDER BY display_order"
        )
        .all(result.reservationId) as Array<{ service_id: string }>;

      expect(reservation.duration_minutes).toBe(110);
      expect(services.map((service) => service.service_id)).toEqual([
        "service_kyoto_default_60",
        "service_kyoto_hair_removal_upper_focus_45"
      ]);
    } finally {
      db.sqlite.close();
    }
  });

  it("replays and conflicts multi-service requests based on the normalized ID list", async () => {
    const db = createMigratedSqliteD1();
    const access = createAccessJwtFixture();
    vi.stubGlobal("fetch", createFetchMock(access.jwk));

    try {
      insertAdminUser(db);
      // 3件目の同一店舗サービス: conflict ケースで第1IDを固定したまま
      // 後続IDの順序だけを入れ替えるために必要。
      db.sqlite
        .prepare(
          "INSERT INTO services (id, store_id, name, duration_minutes) VALUES ('service_kyoto_multi_order_30', 'kyoto', '順序確認30分', 30)"
        )
        .run();
      const key = "admin-create-multi-idem-1";
      const normalized = [
        "service_kyoto_default_60",
        "service_kyoto_hair_removal_upper_focus_45",
        "service_kyoto_multi_order_30"
      ];

      // 初回: 空白・重複を含む raw 入力（正規化後は normalized と一致する）。
      const first = await postAdminReservation(
        db,
        access.token,
        createRequestBody({
          idempotencyKey: key,
          serviceIds: [
            " service_kyoto_default_60 ",
            "service_kyoto_hair_removal_upper_focus_45",
            "service_kyoto_multi_order_30",
            "service_kyoto_default_60"
          ]
        })
      );
      expect(first.status).toBe(201);
      const created = await first.json() as { reservationId: string };

      const countRows = () =>
        db.sqlite
          .prepare(
            `SELECT
               (SELECT COUNT(*) FROM reservations) AS reservations,
               (SELECT COUNT(*) FROM reservation_services) AS junctions,
               (SELECT COUNT(*) FROM slot_locks) AS locks,
               (SELECT COUNT(*) FROM audit_logs WHERE action = 'admin_reservation_created') AS audits`
          )
          .get() as { reservations: number; junctions: number; locks: number; audits: number };
      const before = countRows();

      // 別の raw 形（trim 差・重複なし）でも正規化結果が同じなら replay になる
      // = hash が正規化後の値から計算されていることの証明。
      const replay = await postAdminReservation(
        db,
        access.token,
        createRequestBody({
          idempotencyKey: key,
          serviceIds: [
            "service_kyoto_default_60",
            " service_kyoto_hair_removal_upper_focus_45 ",
            "service_kyoto_multi_order_30"
          ]
        })
      );
      expect(replay.status).toBe(200);
      await expect(replay.json()).resolves.toMatchObject({
        ok: true,
        replayed: true,
        reservationId: created.reservationId
      });
      expect(countRows()).toEqual(before);

      // 第1IDを固定したまま後続IDの順序だけ入れ替えると conflict
      // = hash が第1IDだけでなく後続IDとその順序を含むことの証明
      // （第1IDのみで hash する誤実装なら replay 200 になりこの assert が落ちる）。
      const conflict = await postAdminReservation(
        db,
        access.token,
        createRequestBody({
          idempotencyKey: key,
          serviceIds: [
            "service_kyoto_default_60",
            "service_kyoto_multi_order_30",
            "service_kyoto_hair_removal_upper_focus_45"
          ]
        })
      );
      expect(conflict.status).toBe(409);
      await expect(conflict.json()).resolves.toEqual({
        ok: false,
        reason: "idempotency_conflict"
      });
      expect(countRows()).toEqual(before);

      // audit metadata は raw 入力ではなく正規化後の値と完全一致する。
      const audit = db.sqlite
        .prepare(
          "SELECT metadata_json FROM audit_logs WHERE target_id = ? AND action = 'admin_reservation_created'"
        )
        .get(created.reservationId) as { metadata_json: string };
      const metadata = JSON.parse(audit.metadata_json) as { serviceId: string; serviceIds: string[] };
      expect(metadata.serviceId).toBe(normalized[0]);
      expect(metadata.serviceIds).toEqual(normalized);
    } finally {
      db.sqlite.close();
    }
  });

  it("rejects a multi-service request when any service is from another store or inactive", async () => {
    const db = createMigratedSqliteD1();
    const access = createAccessJwtFixture();
    vi.stubGlobal("fetch", createFetchMock(access.jwk));

    try {
      insertAdminUser(db);
      const otherStore = await postAdminReservation(
        db,
        access.token,
        createRequestBody({
          idempotencyKey: "admin-create-multi-other-store-1",
          serviceIds: ["service_kyoto_default_60", "service_osaka_default_60"]
        })
      );
      db.sqlite
        .prepare("UPDATE services SET active = 0 WHERE id = 'service_kyoto_hair_removal_upper_focus_45'")
        .run();
      const inactive = await postAdminReservation(
        db,
        access.token,
        createRequestBody({
          idempotencyKey: "admin-create-multi-inactive-1",
          serviceIds: [
            "service_kyoto_default_60",
            "service_kyoto_hair_removal_upper_focus_45"
          ]
        })
      );

      expect(otherStore.status).toBe(400);
      await expect(otherStore.json()).resolves.toEqual({ ok: false, reason: "service_not_available" });
      expect(inactive.status).toBe(400);
      await expect(inactive.json()).resolves.toEqual({ ok: false, reason: "service_not_available" });
    } finally {
      db.sqlite.close();
    }
  });

  it("keeps the legacy serviceId request payload compatible at the route boundary", async () => {
    const db = createMigratedSqliteD1();
    const access = createAccessJwtFixture();
    vi.stubGlobal("fetch", createFetchMock(access.jwk));

    try {
      insertAdminUser(db);
      const response = await postAdminReservation(
        db,
        access.token,
        createRequestBody({
          idempotencyKey: "admin-create-legacy-service-id-1",
          serviceIds: undefined,
          serviceId: "service_kyoto_default_60"
        })
      );

      expect(response.status).toBe(201);
      const result = await response.json() as { reservationId: string };
      const services = db.sqlite
        .prepare("SELECT service_id FROM reservation_services WHERE reservation_id = ?")
        .all(result.reservationId) as Array<{ service_id: string }>;
      expect(services).toEqual([{ service_id: "service_kyoto_default_60" }]);
    } finally {
      db.sqlite.close();
    }
  });

  it("fails closed on malformed serviceIds arrays", async () => {
    const db = createMigratedSqliteD1();
    const access = createAccessJwtFixture();
    vi.stubGlobal("fetch", createFetchMock(access.jwk));

    try {
      insertAdminUser(db);
      const validId = "service_kyoto_default_60";
      const cases: Array<[string, unknown, string | undefined]> = [
        ["missing", undefined, undefined],
        ["empty array", [], undefined],
        ["non-array", validId, undefined],
        ["non-string item", [validId, 1], undefined],
        ["overlength item", ["x".repeat(129)], undefined],
        ["mixed overlength item", [validId, "x".repeat(129)], undefined],
        ["empty item", [validId, ""], undefined],
        ["whitespace item", [validId, "   "], undefined],
        ["invalid array wins over legacy", [], validId]
      ];

      for (const [label, serviceIds, serviceId] of cases) {
        const response = await postAdminReservation(
          db,
          access.token,
          createRequestBody({
            idempotencyKey: `admin-create-invalid-service-ids-${label}`,
            serviceIds,
            serviceId
          })
        );
        expect(response.status, label).toBe(400);
        await expect(response.json(), label).resolves.toEqual({ ok: false, reason: "invalid_request" });
      }
    } finally {
      db.sqlite.close();
    }
  });

  it("prefers serviceIds over a simultaneously supplied legacy serviceId", async () => {
    const db = createMigratedSqliteD1();
    const access = createAccessJwtFixture();
    vi.stubGlobal("fetch", createFetchMock(access.jwk));

    try {
      insertAdminUser(db);
      const preferred = "service_kyoto_hair_removal_upper_focus_45";
      const response = await postAdminReservation(
        db,
        access.token,
        createRequestBody({
          idempotencyKey: "admin-create-service-ids-priority-1",
          serviceIds: [preferred],
          serviceId: "service_kyoto_default_60"
        })
      );

      expect(response.status).toBe(201);
      const result = await response.json() as { reservationId: string };
      const reservation = db.sqlite
        .prepare("SELECT service_id FROM reservations WHERE id = ?")
        .get(result.reservationId) as { service_id: string };
      expect(reservation.service_id).toBe(preferred);
    } finally {
      db.sqlite.close();
    }
  });

  it("caps normalized service selections at the first 12 IDs", async () => {
    const db = createMigratedSqliteD1();
    const access = createAccessJwtFixture();
    vi.stubGlobal("fetch", createFetchMock(access.jwk));

    try {
      insertAdminUser(db);
      const serviceIds = Array.from({ length: 13 }, (_, index) =>
        `service_kyoto_multi_cap_${String(index + 1).padStart(2, "0")}`
      );
      const insertService = db.sqlite.prepare(
        "INSERT INTO services (id, store_id, name, duration_minutes) VALUES (?, 'kyoto', ?, 5)"
      );
      for (const [index, serviceId] of serviceIds.entries()) {
        insertService.run(serviceId, `上限確認 ${index + 1}`);
      }

      const response = await postAdminReservation(
        db,
        access.token,
        createRequestBody({ idempotencyKey: "admin-create-multi-cap-1", serviceIds })
      );

      expect(response.status).toBe(201);
      const result = await response.json() as { reservationId: string };
      const persisted = db.sqlite
        .prepare(
          "SELECT service_id FROM reservation_services WHERE reservation_id = ? ORDER BY display_order"
        )
        .all(result.reservationId) as Array<{ service_id: string }>;
      expect(persisted.map((service) => service.service_id)).toEqual(serviceIds.slice(0, 12));

      // 同一キー + 先頭12件のみの再送が replay になる
      // = hash が切り詰め前の13件ではなく正規化後の12件から計算されていることの証明。
      const truncatedReplay = await postAdminReservation(
        db,
        access.token,
        createRequestBody({
          idempotencyKey: "admin-create-multi-cap-1",
          serviceIds: serviceIds.slice(0, 12)
        })
      );
      expect(truncatedReplay.status).toBe(200);
      await expect(truncatedReplay.json()).resolves.toMatchObject({
        ok: true,
        replayed: true,
        reservationId: result.reservationId
      });
      const junctionCount = db.sqlite
        .prepare("SELECT COUNT(*) AS count FROM reservation_services")
        .get() as { count: number };
      expect(junctionCount.count).toBe(12);
    } finally {
      db.sqlite.close();
    }
  });

  it("accepts exactly 235 total treatment minutes and rejects a larger multi-service total", async () => {
    const db = createMigratedSqliteD1();
    const access = createAccessJwtFixture();
    vi.stubGlobal("fetch", createFetchMock(access.jwk));

    try {
      insertAdminUser(db);
      // 各サービス単体は上限内。「合計」で判定されることを複数メニューで検証する
      // （単一サービスだと、実装が各行だけ検査する回帰でもテストが通ってしまう）。
      db.sqlite
        .prepare(
          `INSERT INTO services (id, store_id, name, duration_minutes) VALUES
           ('service_kyoto_duration_120', 'kyoto', '120分', 120),
           ('service_kyoto_duration_115', 'kyoto', '115分', 115),
           ('service_kyoto_duration_125', 'kyoto', '125分', 125)`
        )
        .run();

      const boundary = await postAdminReservation(
        db,
        access.token,
        createRequestBody({
          idempotencyKey: "admin-create-duration-sum-235",
          serviceIds: ["service_kyoto_duration_120", "service_kyoto_duration_115"]
        })
      );
      // 超過側は 235 の次に有効な5分単位 = 240分（115+125）。245分だと
      // 「作成側だけ誤って240分を許可する」比較ミスを検出できない。
      const overLimit = await postAdminReservation(
        db,
        access.token,
        createRequestBody({
          idempotencyKey: "admin-create-duration-sum-240",
          serviceIds: ["service_kyoto_duration_115", "service_kyoto_duration_125"]
        })
      );

      expect(boundary.status).toBe(201);
      const boundaryResult = await boundary.json() as { reservationId: string; endAt: string };
      // 01:00Z 開始 + 合計235分 + バッファ5分 = 占有240分。
      expect(boundaryResult.endAt).toBe("2026-06-01T05:00:00.000Z");
      // 占有240分 = 5分ロック48個（終端排他）。
      const boundaryLocks = db.sqlite
        .prepare("SELECT COUNT(*) AS count FROM slot_locks WHERE owner_type = 'reservation' AND owner_id = ?")
        .get(boundaryResult.reservationId) as { count: number };
      expect(boundaryLocks.count).toBe(48);
      expect(overLimit.status).toBe(400);
      await expect(overLimit.json()).resolves.toEqual({ ok: false, reason: "invalid_request" });
      // 上限超過側は予約関連の行が一切作成されない。
      const overLimitRows = db.sqlite
        .prepare(
          `SELECT
             (SELECT COUNT(*) FROM reservations) AS reservations,
             (SELECT COUNT(*) FROM reservation_services) AS junctions
           `
        )
        .get() as { reservations: number; junctions: number };
      expect(overLimitRows).toEqual({ reservations: 1, junctions: 2 });
    } finally {
      db.sqlite.close();
    }
  });

  it("replays a completed reservation even when its service combination now exceeds 235 minutes", async () => {
    const db = createMigratedSqliteD1();
    const access = createAccessJwtFixture();
    vi.stubGlobal("fetch", createFetchMock(access.jwk));

    try {
      insertAdminUser(db);
      const serviceIds = ["service_kyoto_duration_115", "service_kyoto_duration_125"];
      const body = createRequestBody({
        idempotencyKey: "admin-create-over-cap-replay-1",
        serviceIds
      });
      const requestHash = await sha256Hex(
        JSON.stringify({
          source: "phone_admin",
          storeId: "kyoto",
          serviceIds,
          resourceId: "resource_kyoto_calendar",
          startAt: "2026-06-01T01:00:00.000Z",
          origin: null,
          customerId: null,
          customer: {
            displayName: "電話 予約",
            displayNameKana: "デンワ ヨヤク",
            phone: "0750000000"
          }
        })
      );
      db.sqlite.exec(`
        INSERT INTO services (id, store_id, name, duration_minutes) VALUES
          ('service_kyoto_duration_115', 'kyoto', '115分', 115),
          ('service_kyoto_duration_125', 'kyoto', '125分', 125);

        INSERT INTO customers (
          id, display_name, display_name_kana, phone_normalized, phone_hash, block_status
        ) VALUES (
          'customer_over_cap_replay_1', '電話 予約', 'デンワ ヨヤク',
          '0750000000', '${await sha256Hex("0750000000")}', 'active'
        );

        INSERT INTO reservations (
          id, store_id, service_id, customer_id, resource_id, source, status,
          start_at, end_at, duration_minutes, idempotency_key
        ) VALUES (
          'reservation_over_cap_replay_1', 'kyoto', 'service_kyoto_duration_115',
          'customer_over_cap_replay_1', 'resource_kyoto_calendar', 'phone_admin', 'confirmed',
          '2026-06-01T01:00:00.000Z', '2026-06-01T05:05:00.000Z', 245,
          'admin-create-over-cap-replay-1'
        );
      `);
      db.sqlite
        .prepare(
          `INSERT INTO idempotency_keys (
             id, scope, idempotency_key, status, target_type, target_id,
             request_hash, expires_at, updated_at
           ) VALUES (
             'idempotency_over_cap_replay_1', 'admin_action',
             'admin-create-over-cap-replay-1', 'succeeded', 'reservation',
             'reservation_over_cap_replay_1', ?, '2026-06-02T00:00:00.000Z',
             '2026-05-09T00:00:00.000Z'
           )`
        )
        .run(requestHash);

      const response = await postAdminReservation(db, access.token, body);

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        ok: true,
        reservationId: "reservation_over_cap_replay_1",
        replayed: true
      });
    } finally {
      db.sqlite.close();
    }
  });

  it.each([undefined, "phone"] as const)("replays a legacy single-service receipt with origin %s", async (origin) => {
    const db = createMigratedSqliteD1();
    const access = createAccessJwtFixture();
    vi.stubGlobal("fetch", createFetchMock(access.jwk));

    try {
      insertAdminUser(db);
      const legacyBody = createRequestBody({
        idempotencyKey: "admin-create-legacy-hash-1",
        serviceIds: undefined,
        serviceId: "service_kyoto_default_60",
        origin
      });
      const legacyHash = await sha256Hex(
        JSON.stringify({
          source: "phone_admin",
          storeId: "kyoto",
          serviceId: "service_kyoto_default_60",
          resourceId: "resource_kyoto_calendar",
          startAt: "2026-06-01T01:00:00.000Z",
          origin: origin ?? null,
          customerId: null,
          customer: {
            displayName: "電話 予約",
            displayNameKana: "デンワ ヨヤク",
            phone: "0750000000"
          }
        })
      );
      db.sqlite
        .prepare(
          `INSERT INTO customers (
             id, display_name, display_name_kana, phone_normalized, phone_hash, block_status
           ) VALUES (
             'customer_legacy_hash_1', '電話 予約', 'デンワ ヨヤク', '0750000000', ?, 'active'
           )`
        )
        .run(await sha256Hex("0750000000"));
      db.sqlite
        .prepare(
          `INSERT INTO reservations (
             id, store_id, service_id, customer_id, resource_id, source, status,
             start_at, end_at, duration_minutes, idempotency_key, reservation_origin
           ) VALUES (
             'reservation_legacy_hash_1', 'kyoto', 'service_kyoto_default_60',
             'customer_legacy_hash_1', 'resource_kyoto_calendar', 'phone_admin', 'confirmed',
             '2026-06-01T01:00:00.000Z', '2026-06-01T02:05:00.000Z', 65,
             'admin-create-legacy-hash-1', ?
           )`
        )
        .run(origin ?? null);
      db.sqlite
        .prepare(
          `INSERT INTO idempotency_keys (
             id, scope, idempotency_key, status, target_type, target_id,
             request_hash, expires_at, updated_at
           ) VALUES (
             'idempotency_legacy_hash_1', 'admin_action', 'admin-create-legacy-hash-1',
             'succeeded', 'reservation', 'reservation_legacy_hash_1', ?,
             '2026-06-02T00:00:00.000Z', '2026-05-09T00:00:00.000Z'
           )`
        )
        .run(legacyHash);

      const response = await postAdminReservation(db, access.token, legacyBody);

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        ok: true,
        reservationId: "reservation_legacy_hash_1",
        replayed: true
      });
      expect(db.sqlite.prepare("SELECT COUNT(*) AS n FROM reservations").get()).toMatchObject({ n: 1 });
      if (origin === "phone") {
        const changed = await postAdminReservation(db, access.token, { ...legacyBody, origin: "walk_in" });
        expect(changed.status).toBe(409);
        const newRequest = await postAdminReservation(db, access.token, { ...legacyBody, idempotencyKey: "new-phone-key" });
        expect(newRequest.status).toBe(400);
        db.sqlite.prepare("UPDATE idempotency_keys SET expires_at = '2026-05-08T00:00:00Z' WHERE idempotency_key = ?")
          .run(legacyBody.idempotencyKey);
        expect((await postAdminReservation(db, access.token, legacyBody)).status).toBe(400);
        expect(db.sqlite.prepare("SELECT COUNT(*) AS n FROM reservations").get()).toMatchObject({ n: 1 });
      }
    } finally {
      db.sqlite.close();
    }
  });

  it("accepts a start on the 5-minute lock grid but off the 15-minute public grid, and rejects a finer one", async () => {
    const db = createMigratedSqliteD1();
    const access = createAccessJwtFixture();
    vi.stubGlobal("fetch", createFetchMock(access.jwk));

    try {
      insertAdminUser(db);

      // 10:40 JST — a phone-booking time the public availability grid never offers.
      const accepted = await postAdminReservation(
        db,
        access.token,
        createRequestBody({
          idempotencyKey: "admin-create-lock-grid-1",
          startAt: "2026-06-01T01:40:00.000Z"
        })
      );
      expect(accepted.status).toBe(201);
      const { reservationId } = await accepted.json() as { reservationId: string };
      // The locks must land on the 5-minute grid anchored at the off-15-grid start —
      // that is what keeps the public path's collision check able to see this booking.
      const lockGrid = db.sqlite
        .prepare("SELECT slot_at FROM slot_locks WHERE owner_id = ? ORDER BY slot_at")
        .all(reservationId) as { slot_at: string }[];
      expect(lockGrid.map((l) => l.slot_at)).toEqual([
        "2026-06-01T01:40:00.000Z",
        "2026-06-01T01:45:00.000Z",
        "2026-06-01T01:50:00.000Z",
        "2026-06-01T01:55:00.000Z",
        "2026-06-01T02:00:00.000Z",
        "2026-06-01T02:05:00.000Z",
        "2026-06-01T02:10:00.000Z",
        "2026-06-01T02:15:00.000Z",
        "2026-06-01T02:20:00.000Z",
        "2026-06-01T02:25:00.000Z",
        "2026-06-01T02:30:00.000Z",
        "2026-06-01T02:35:00.000Z",
        "2026-06-01T02:40:00.000Z"
      ]);

      // 10:42 JST — off the slot_locks grid: its locks could never collide with the
      // public path's 5-minute checks, so it stays rejected.
      const rejected = await postAdminReservation(
        db,
        access.token,
        createRequestBody({
          idempotencyKey: "admin-create-lock-grid-2",
          startAt: "2026-06-01T01:42:00.000Z"
        })
      );
      expect(rejected.status).toBe(400);
      await expect(rejected.json()).resolves.toEqual({
        ok: false,
        reason: "invalid_time"
      });
    } finally {
      db.sqlite.close();
    }
  });

  it("offers no slot that create then rejects — the last slot of the day is bookable", async () => {
    const db = createMigratedSqliteD1();
    const access = createAccessJwtFixture();
    vi.stubGlobal("fetch", createFetchMock(access.jwk));

    try {
      insertAdminUser(db);

      // The panel asks for slots with the RAW service duration; the endpoint must lay them
      // out against the same occupancy (duration + cleanup buffer) that create enforces.
      const slots = await getAvailableSlots({
        db: db as unknown as D1Database,
        storeId: "kyoto",
        date: "2026-06-01",
        durationMinutes: 60
      });
      expect(slots.ok).toBe(true);
      if (!slots.ok) return;

      const last = slots.slots.at(-1)!;
      const response = await postAdminReservation(
        db,
        access.token,
        createRequestBody({
          idempotencyKey: "admin-create-last-slot-1",
          startAt: last.startAt,
          resourceId: last.resourceId
        })
      );

      expect(response.status).toBe(201);
    } finally {
      db.sqlite.close();
    }
  });

  it("blocks a public 15-grid submit that overlaps an admin booking started off the 15-grid", async () => {
    const db = createMigratedSqliteD1();
    const access = createAccessJwtFixture();
    vi.stubGlobal("fetch", createFetchMock(access.jwk));

    try {
      insertAdminUser(db);

      // 10:40 JST phone booking — locks 01:40Z through 02:40Z on the 5-minute grid.
      const admin = await postAdminReservation(
        db,
        access.token,
        createRequestBody({
          idempotencyKey: "admin-create-cross-grid-1",
          startAt: "2026-06-01T01:40:00.000Z"
        })
      );
      expect(admin.status).toBe(201);

      // 10:45 JST — the next start the public 15-minute grid offers. It overlaps the
      // admin booking, so the shared 5-minute lock grid must refuse it.
      const publicResult = await createPublicReservation({
        db: db as unknown as D1Database,
        request: {
          idempotencyKey: "public-cross-grid-1",
          storeId: "kyoto",
          serviceId: "service_kyoto_default_60",
          resourceId: "resource_kyoto_calendar",
          startAt: "2026-06-01T01:45:00.000Z",
          customer: {
            displayName: "予約 太郎",
            displayNameKana: "ヨヤク タロウ",
            phone: "075-123-4567"
          },
          consents: {
            noticeVersion: "notice-terms-2026-06",
            cancellationPolicyVersion: "cancel-2026-08-31",
            privacyPolicyVersion: "privacy-2026-06"
          }
        },
        line: { lineUserId: "line_user_cross_grid", channelId: "line_channel_id" }
      });

      expect(publicResult).toEqual({
        ok: false,
        reason: "slot_unavailable"
      });
      const reservationCount = db.sqlite
        .prepare("SELECT COUNT(*) AS count FROM reservations")
        .get() as { count: number };
      expect(reservationCount.count).toBe(1);
    } finally {
      db.sqlite.close();
    }
  });

  it("removes public availability that overlaps an off-grid multi-service admin booking", async () => {
    const db = createMigratedSqliteD1();
    const access = createAccessJwtFixture();
    vi.stubGlobal("fetch", createFetchMock(access.jwk));

    try {
      insertAdminUser(db);
      const fetchAvailability = async () => {
        const availability = await listPublicAvailability({
          db: db as unknown as D1Database,
          storeId: "kyoto",
          serviceId: "service_kyoto_default_60",
          resourceId: "resource_kyoto_calendar",
          date: "2026-06-01",
          now: () => Date.parse("2026-05-09T00:00:00.000Z")
        });
        expect(availability.ok).toBe(true);
        return availability.ok ? availability.slots.map((slot) => slot.startAt) : [];
      };

      // 管理予約 01:40Z + (60+45+5)分 = 03:30Z 終了。第1サービスのみなら
      // 02:45Z 終了のため、probe は 03:00Z 開始の公開枠（03:00–04:05 占有）
      // — 第2サービス分の占有延長がロックへ反映されない回帰を検出する。
      const before = await fetchAvailability();
      expect(before).toContain("2026-06-01T03:00:00.000Z");
      expect(before).toContain("2026-06-01T05:00:00.000Z");

      const admin = await postAdminReservation(
        db,
        access.token,
        createRequestBody({
          idempotencyKey: "admin-create-cross-grid-multi-1",
          startAt: "2026-06-01T01:40:00.000Z",
          serviceIds: [
            "service_kyoto_default_60",
            "service_kyoto_hair_removal_upper_focus_45"
          ]
        })
      );
      expect(admin.status).toBe(201);
      const created = await admin.json() as { reservationId: string };

      // 占有110分（施術105分+バッファ5分）= 5分ロック22個（終端は排他）。
      const lockCount = db.sqlite
        .prepare(
          "SELECT COUNT(*) AS count FROM slot_locks WHERE owner_type = 'reservation' AND owner_id = ?"
        )
        .get(created.reservationId) as { count: number };
      expect(lockCount.count).toBe(22);

      const after = await fetchAvailability();
      expect(after).not.toContain("2026-06-01T03:00:00.000Z");
      // 予約に重ならない別の枠は残る。
      expect(after).toContain("2026-06-01T05:00:00.000Z");
    } finally {
      db.sqlite.close();
    }
  });

  it("replays identical admin reservation creation requests by idempotency key", async () => {
    const db = createMigratedSqliteD1();
    const access = createAccessJwtFixture();
    vi.stubGlobal("fetch", createFetchMock(access.jwk));

    try {
      insertAdminUser(db);
      const body = createRequestBody({
        idempotencyKey: "admin-create-replay-1"
      });

      const first = await postAdminReservation(db, access.token, body);
      const second = await postAdminReservation(db, access.token, body);

      expect(first.status).toBe(201);
      expect(second.status).toBe(200);
      await expect(second.json()).resolves.toMatchObject({
        ok: true,
        replayed: true
      });
      const reservationCount = db.sqlite.prepare("SELECT COUNT(*) AS count FROM reservations").get() as { count: number };
      expect(reservationCount.count).toBe(1);
    } finally {
      db.sqlite.close();
    }
  });

  it("rejects phone reservations for a blocked existing customer", async () => {
    const db = createMigratedSqliteD1();
    const access = createAccessJwtFixture();
    vi.stubGlobal("fetch", createFetchMock(access.jwk));

    try {
      insertAdminUser(db);

      const first = await postAdminReservation(db, access.token, createRequestBody());
      expect(first.status).toBe(201);
      db.sqlite
        .prepare("UPDATE customers SET block_status = 'blocked' WHERE phone_normalized = '0750000000'")
        .run();

      const blocked = await postAdminReservation(
        db,
        access.token,
        createRequestBody({
          idempotencyKey: "admin-create-phone-blocked-1",
          startAt: "2026-06-01T02:00:00.000Z"
        })
      );

      expect(blocked.status).toBe(400);
      await expect(blocked.json()).resolves.toEqual({
        ok: false,
        reason: "customer_blocked"
      });
      const reservationCount = db.sqlite
        .prepare("SELECT COUNT(*) AS count FROM reservations")
        .get() as { count: number };
      expect(reservationCount.count).toBe(1);
    } finally {
      db.sqlite.close();
    }
  });

  // The phone-wide block gate sits AFTER idempotency resolution on purpose: a retry
  // of an already-succeeded create must return the cached reservation even once the
  // number became blocked. Moving the check into resolveAdminCreateCustomer (which
  // runs before the idempotency read) would turn this replay into customer_blocked.
  it("still replays an already-succeeded create after the phone became blocked", async () => {
    const db = createMigratedSqliteD1();
    const access = createAccessJwtFixture();
    vi.stubGlobal("fetch", createFetchMock(access.jwk));

    try {
      insertAdminUser(db);

      const body = createRequestBody({ idempotencyKey: "admin-create-blocked-replay-1" });
      const first = await postAdminReservation(db, access.token, body);
      expect(first.status).toBe(201);
      const firstJson = (await first.json()) as { reservationId: string };

      db.sqlite
        .prepare("UPDATE customers SET block_status = 'blocked' WHERE phone_normalized = '0750000000'")
        .run();

      const replay = await postAdminReservation(db, access.token, body);
      expect(replay.status).toBe(200);
      await expect(replay.json()).resolves.toMatchObject({
        ok: true,
        reservationId: firstJson.reservationId,
        replayed: true
      });
    } finally {
      db.sqlite.close();
    }
  });

  it("rejects phone reservations when any duplicate phone customer is blocked", async () => {
    const db = createMigratedSqliteD1();
    const access = createAccessJwtFixture();
    vi.stubGlobal("fetch", createFetchMock(access.jwk));

    try {
      insertAdminUser(db);

      const first = await postAdminReservation(db, access.token, createRequestBody());
      expect(first.status).toBe(201);
      const existing = db.sqlite
        .prepare("SELECT phone_hash FROM customers WHERE phone_normalized = '0750000000' LIMIT 1")
        .get() as { phone_hash: string };
      db.sqlite
        .prepare(
          `
            INSERT INTO customers (
              id,
              display_name,
              phone_normalized,
              phone_hash,
              block_status,
              created_at,
              updated_at
            ) VALUES (
              'customer_duplicate_blocked_phone',
              '重複 ブロック',
              '0750000000',
              ?,
              'blocked',
              '2026-05-10T00:00:00.000Z',
              '2026-05-10T00:00:00.000Z'
            )
          `
        )
        .run(existing.phone_hash);

      const blocked = await postAdminReservation(
        db,
        access.token,
        createRequestBody({
          idempotencyKey: "admin-create-phone-duplicate-blocked-1",
          startAt: "2026-06-01T02:00:00.000Z"
        })
      );

      expect(blocked.status).toBe(400);
      await expect(blocked.json()).resolves.toEqual({
        ok: false,
        reason: "customer_blocked"
      });
      const reservationCount = db.sqlite
        .prepare("SELECT COUNT(*) AS count FROM reservations")
        .get() as { count: number };
      expect(reservationCount.count).toBe(1);
    } finally {
      db.sqlite.close();
    }
  });

  it("keeps a same-phone block in force even after that blocked customer is archived (no block bypass)", async () => {
    const db = createMigratedSqliteD1();
    const access = createAccessJwtFixture();
    vi.stubGlobal("fetch", createFetchMock(access.jwk));

    try {
      insertAdminUser(db);
      const first = await postAdminReservation(db, access.token, createRequestBody());
      expect(first.status).toBe(201);
      const existing = db.sqlite
        .prepare("SELECT phone_hash FROM customers WHERE phone_normalized = '0750000000' LIMIT 1")
        .get() as { phone_hash: string };
      // A blocked customer that was ALSO archived must still block the same phone —
      // archiving must not clear a block (the phone-hash block lookup intentionally
      // does NOT filter archived rows).
      db.sqlite
        .prepare(
          `INSERT INTO customers (id, display_name, phone_normalized, phone_hash, block_status, archived_at, created_at, updated_at)
           VALUES ('cust_blocked_archived_1', 'ブロック アーカイブ', '0750000000', ?, 'blocked', '2026-05-10T00:00:00.000Z', '2026-05-10T00:00:00.000Z', '2026-05-10T00:00:00.000Z')`
        )
        .run(existing.phone_hash);

      const blocked = await postAdminReservation(
        db,
        access.token,
        createRequestBody({ idempotencyKey: "admin-create-blocked-archived-1", startAt: "2026-06-01T03:00:00.000Z" })
      );

      expect(blocked.status).toBe(400);
      await expect(blocked.json()).resolves.toEqual({ ok: false, reason: "customer_blocked" });
      const reservationCount = db.sqlite.prepare("SELECT COUNT(*) AS count FROM reservations").get() as { count: number };
      expect(reservationCount.count).toBe(1);
    } finally {
      db.sqlite.close();
    }
  });

  it("prefers an active customer over an older archived row with the same phone (no duplicate)", async () => {
    const db = createMigratedSqliteD1();
    const access = createAccessJwtFixture();
    vi.stubGlobal("fetch", createFetchMock(access.jwk));

    try {
      insertAdminUser(db);
      // First create makes the canonical ACTIVE customer A (phone 0750000000).
      const first = await postAdminReservation(db, access.token, createRequestBody());
      expect(first.status).toBe(201);
      const active = db.sqlite
        .prepare("SELECT id, phone_hash FROM customers WHERE phone_normalized = '0750000000' AND archived_at IS NULL LIMIT 1")
        .get() as { id: string; phone_hash: string };
      // Insert an OLDER, archived, non-blocked row sharing the same phone_hash.
      // Under created_at ASC alone it would sort first and shadow the active row,
      // nulling the match and creating a duplicate. The active-before-archived
      // ordering must keep customer A as the reused row. (devin/codex)
      db.sqlite
        .prepare(
          `INSERT INTO customers (id, display_name, phone_normalized, phone_hash, block_status, archived_at, created_at, updated_at)
           VALUES ('cust_archived_old_1', 'アーカイブ 旧', '0750000000', ?, 'active', '2026-05-01T00:00:00.000Z', '2026-05-01T00:00:00.000Z', '2026-05-01T00:00:00.000Z')`
        )
        .run(active.phone_hash);

      const second = await postAdminReservation(
        db,
        access.token,
        createRequestBody({ idempotencyKey: "admin-create-active-pref-1", startAt: "2026-06-01T05:00:00.000Z" })
      );
      expect(second.status).toBe(201);

      // No third (duplicate) customer was created: still 2 rows (active A + inserted archived).
      const customerCount = db.sqlite.prepare("SELECT COUNT(*) AS count FROM customers").get() as { count: number };
      expect(customerCount.count).toBe(2);
      // Both reservations belong to the active customer A.
      const reservations = db.sqlite
        .prepare("SELECT customer_id FROM reservations ORDER BY start_at ASC")
        .all() as Array<{ customer_id: string }>;
      expect(reservations).toHaveLength(2);
      expect(reservations.every((r) => r.customer_id === active.id)).toBe(true);
    } finally {
      db.sqlite.close();
    }
  });

  it("rejects idempotency key reuse with different reservation content", async () => {
    const db = createMigratedSqliteD1();
    const access = createAccessJwtFixture();
    vi.stubGlobal("fetch", createFetchMock(access.jwk));

    try {
      insertAdminUser(db);
      await postAdminReservation(db, access.token, createRequestBody({
        idempotencyKey: "admin-create-conflict-1"
      }));

      const conflict = await postAdminReservation(
        db,
        access.token,
        createRequestBody({
          idempotencyKey: "admin-create-conflict-1",
          startAt: "2026-06-01T02:00:00.000Z"
        })
      );

      expect(conflict.status).toBe(409);
      await expect(conflict.json()).resolves.toEqual({
        ok: false,
        reason: "idempotency_conflict"
      });
    } finally {
      db.sqlite.close();
    }
  });

  it("returns write_failed (not idempotency_in_progress) when the colliding create idempotency row is expired", async () => {
    const db = createMigratedSqliteD1();
    try {
      insertAdminUser(db);
      // A "started" row left behind by a crashed request, already past its TTL
      // relative to the action clock below (expires 2026-05-09, now 2026-05-12).
      db.sqlite
        .prepare(
          `
            INSERT INTO idempotency_keys (
              id, scope, idempotency_key, status, request_hash, expires_at
            ) VALUES (
              'admin_create_expired_started_1', 'admin_action',
              'admin-create-expired-started-1', 'started', 'stale-request-hash',
              '2026-05-09T00:00:00.000Z'
            )
          `
        )
        .run();

      const admin: AdminUser = {
        id: "admin_create_owner_1",
        email: ADMIN_EMAIL,
        role: "owner",
        staff_member_id: null,
        store_id: null
      };
      const result = await createAdminReservation({
        db: db as unknown as D1Database,
        admin,
        request: createRequestBody({
          idempotencyKey: "admin-create-expired-started-1"
        }) as unknown as AdminCreateReservationRequest,
        now: () => Date.parse("2026-05-12T00:00:00.000Z")
      });

      // The TTL read skips the expired row, the flow proceeds, the fresh started
      // INSERT collides with the still-present row on the UNIQUE key, and the
      // TTL-aware re-resolve finds nothing in flight -> terminal write_failed (NOT
      // the old, permanently-stuck idempotency_in_progress).
      expect(result).toEqual({ ok: false, reason: "write_failed" });
      expect(captureBatchWriteFailure).toHaveBeenCalledTimes(1);
      expect(captureBatchWriteFailure).toHaveBeenCalledWith(expect.any(Error), {
        component: "reservation-create",
        op: "batch_write_failed",
        helper: "createAdminReservation"
      });

      const counts = db.sqlite
        .prepare(
          `
            SELECT
              (SELECT COUNT(*) FROM reservations WHERE created_by = 'admin_create_owner_1') AS reservationCount,
              (SELECT COUNT(*) FROM idempotency_keys WHERE idempotency_key = 'admin-create-expired-started-1') AS idempotencyCount
          `
        )
        .get() as { reservationCount: number; idempotencyCount: number };
      // Atomic rollback: no reservation written, only the pre-existing expired row remains.
      expect(counts).toEqual({ reservationCount: 0, idempotencyCount: 1 });
    } finally {
      db.sqlite.close();
    }
  });

  it("rejects slot conflicts without creating a second reservation", async () => {
    const db = createMigratedSqliteD1();
    const access = createAccessJwtFixture();
    vi.stubGlobal("fetch", createFetchMock(access.jwk));

    try {
      insertAdminUser(db);
      await postAdminReservation(db, access.token, createRequestBody({
        idempotencyKey: "admin-create-slot-1"
      }));

      const conflict = await postAdminReservation(
        db,
        access.token,
        createRequestBody({
          idempotencyKey: "admin-create-slot-2",
          customer: {
            displayName: "別 顧客",
            displayNameKana: "ベツ コキャク",
            phone: "075-000-0001"
          }
        })
      );

      expect(conflict.status).toBe(409);
      await expect(conflict.json()).resolves.toEqual({
        ok: false,
        reason: "slot_unavailable"
      });
      expect(captureBatchWriteFailure).not.toHaveBeenCalled();
      const reservationCount = db.sqlite.prepare("SELECT COUNT(*) AS count FROM reservations").get() as { count: number };
      expect(reservationCount.count).toBe(1);
    } finally {
      db.sqlite.close();
    }
  });

  it("rejects same-customer overlapping reservations across stores", async () => {
    const db = createMigratedSqliteD1();
    const access = createAccessJwtFixture();
    vi.stubGlobal("fetch", createFetchMock(access.jwk));

    try {
      insertAdminUser(db);
      await postAdminReservation(db, access.token, createRequestBody({
        idempotencyKey: "admin-create-customer-time-1"
      }));

      const conflict = await postAdminReservation(
        db,
        access.token,
        createRequestBody({
          idempotencyKey: "admin-create-customer-time-2",
          storeId: "osaka",
          serviceIds: ["service_osaka_default_60"],
          resourceId: "resource_osaka_calendar"
        })
      );

      expect(conflict.status).toBe(409);
      await expect(conflict.json()).resolves.toEqual({
        ok: false,
        reason: "customer_time_conflict"
      });
    } finally {
      db.sqlite.close();
    }
  });

  it("rejects phone reservations outside store business hours", async () => {
    const db = createMigratedSqliteD1();
    const access = createAccessJwtFixture();
    vi.stubGlobal("fetch", createFetchMock(access.jwk));

    try {
      insertAdminUser(db);

      const response = await postAdminReservation(
        db,
        access.token,
        createRequestBody({
          idempotencyKey: "admin-create-closed-friday-1",
          startAt: "2026-06-05T01:00:00.000Z"
        })
      );

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        ok: false,
        reason: "outside_business_hours"
      });
    } finally {
      db.sqlite.close();
    }
  });

  // 管理画面の枠表示 (getAvailableSlots) はメンズの曜日制限で狭めていない。
  // ここだけ書込時に弾くと「枠は出るのに最後に拒否される」行き止まりになるため
  // (#503 で潰したのと同じ形)、管理者作成は制限の外に置く。制限はあくまで
  // 顧客向けの表示ルールで、スタッフの手動リカバリ枠は残す。
  it("lets admins book Kyoto men's menus outside the customer-facing window", async () => {
    const db = createMigratedSqliteD1();
    const access = createAccessJwtFixture();
    vi.stubGlobal("fetch", createFetchMock(access.jwk));

    try {
      insertAdminUser(db);
      const serviceIds = ["service_kyoto_mens_hair_removal_beard_30"];

      const monday = await postAdminReservation(
        db,
        access.token,
        createRequestBody({
          idempotencyKey: "admin-create-mens-monday",
          serviceIds,
          startAt: "2026-06-01T01:00:00.000Z"
        })
      );
      expect(monday.status).toBe(201);
      await expect(monday.json()).resolves.toMatchObject({
        ok: true,
        storeId: "kyoto",
        replayed: false
      });

      const tuesday = await postAdminReservation(
        db,
        access.token,
        createRequestBody({
          idempotencyKey: "admin-create-mens-tuesday",
          serviceIds,
          startAt: "2026-06-02T01:00:00.000Z"
        })
      );
      expect(tuesday.status).toBe(201);
      await expect(tuesday.json()).resolves.toMatchObject({
        ok: true,
        storeId: "kyoto",
        replayed: false
      });
    } finally {
      db.sqlite.close();
    }
  });

  it("rejects admin phone reservation when another customer with the same phone_hash already holds the slot lock (codex #16)", async () => {
    const db = createMigratedSqliteD1();
    const access = createAccessJwtFixture();
    vi.stubGlobal("fetch", createFetchMock(access.jwk));

    try {
      insertAdminUser(db);

      const first = await postAdminReservation(db, access.token, createRequestBody());
      expect(first.status).toBe(201);

      const existing = db.sqlite
        .prepare("SELECT id, phone_hash FROM customers WHERE phone_normalized = '0750000000' LIMIT 1")
        .get() as { id: string; phone_hash: string };
      db.sqlite
        .prepare("UPDATE customers SET created_at = '2026-06-01T00:00:00.000Z' WHERE id = ?")
        .run(existing.id);

      db.sqlite
        .prepare(
          `
            INSERT INTO customers (
              id,
              display_name,
              phone_normalized,
              phone_hash,
              block_status,
              created_at,
              updated_at
            ) VALUES (
              'customer_codex16_ghost',
              '幽霊 重複',
              '0750000000',
              ?,
              'active',
              '2020-01-01T00:00:00.000Z',
              '2020-01-01T00:00:00.000Z'
            )
          `
        )
        .run(existing.phone_hash);

      const conflict = await postAdminReservation(
        db,
        access.token,
        createRequestBody({
          idempotencyKey: "admin-create-codex16-1",
          storeId: "osaka",
          serviceIds: ["service_osaka_default_60"],
          resourceId: "resource_osaka_calendar"
        })
      );

      expect(conflict.status).toBe(409);
      await expect(conflict.json()).resolves.toEqual({
        ok: false,
        reason: "customer_time_conflict"
      });

      const reservationCount = db.sqlite
        .prepare("SELECT COUNT(*) AS count FROM reservations")
        .get() as { count: number };
      expect(reservationCount.count).toBe(1);

      const phoneSlotCount = db.sqlite
        .prepare(
          `
            SELECT COUNT(*) AS count
            FROM customer_time_locks
            WHERE phone_hash = ? AND slot_at = '2026-06-01T01:00:00.000Z'
          `
        )
        .get(existing.phone_hash) as { count: number };
      expect(phoneSlotCount.count).toBe(1);
    } finally {
      db.sqlite.close();
    }
  });

  it("phone_hash slot lock allows different phones at the same slot (codex #16)", async () => {
    const db = createMigratedSqliteD1();
    const access = createAccessJwtFixture();
    vi.stubGlobal("fetch", createFetchMock(access.jwk));

    try {
      insertAdminUser(db);

      const first = await postAdminReservation(db, access.token, createRequestBody());
      expect(first.status).toBe(201);

      const second = await postAdminReservation(
        db,
        access.token,
        createRequestBody({
          idempotencyKey: "admin-create-codex16-different-phone-1",
          storeId: "osaka",
          serviceIds: ["service_osaka_default_60"],
          resourceId: "resource_osaka_calendar",
          customer: {
            displayName: "別人 予約",
            displayNameKana: "ベツジン ヨヤク",
            phone: "075-111-1111"
          }
        })
      );

      expect(second.status).toBe(201);

      const reservationCount = db.sqlite
        .prepare("SELECT COUNT(*) AS count FROM reservations WHERE start_at = '2026-06-01T01:00:00.000Z'")
        .get() as { count: number };
      expect(reservationCount.count).toBe(2);
    } finally {
      db.sqlite.close();
    }
  });

  it("customer_time_locks schema has phone_hash column and partial UNIQUE index (codex #16)", () => {
    const db = createMigratedSqliteD1();
    try {
      const columns = db.sqlite
        .prepare("PRAGMA table_info('customer_time_locks')")
        .all() as Array<{ name: string }>;
      expect(columns.some((column) => column.name === "phone_hash")).toBe(true);

      const indexRow = db.sqlite
        .prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_customer_time_locks_phone_slot'")
        .get() as { sql: string } | undefined;
      expect(indexRow?.sql).toContain("UNIQUE");
      expect(indexRow?.sql).toContain("phone_hash");
      expect(indexRow?.sql).toContain("slot_at");
      expect(indexRow?.sql).toContain("WHERE phone_hash IS NOT NULL");
    } finally {
      db.sqlite.close();
    }
  });

  it.each(["phone", "instagram"])("rejects unavailable origin %s without creating records", async (origin) => {
    const db = createMigratedSqliteD1();
    const access = createAccessJwtFixture();
    vi.stubGlobal("fetch", createFetchMock(access.jwk));
    try {
      insertAdminUser(db);
      const response = await postAdminReservation(db, access.token, createRequestBody({ origin }));
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ ok: false, reason: "invalid_request" });
      expect(db.sqlite.prepare("SELECT COUNT(*) AS n FROM reservations").get()).toMatchObject({ n: 0 });
    } finally {
      db.sqlite.close();
    }
  });

  it("books against an existing customerId without a new customers INSERT and stores the origin", async () => {
    const db = createMigratedSqliteD1();
    const access = createAccessJwtFixture();
    vi.stubGlobal("fetch", createFetchMock(access.jwk));

    try {
      insertAdminUser(db);
      // Seed an existing customer WITH a phone (paper-chart customer that also
      // has a phone on file).
      db.sqlite
        .prepare(
          `
            INSERT INTO customers (
              id, display_name, display_name_kana, phone_normalized, phone_hash,
              block_status, created_at, updated_at
            ) VALUES (
              'customer_existing_1', '既存 太郎', 'キゾン タロウ', '0900000001',
              'phonehash_existing_1', 'active',
              '2026-05-01T00:00:00.000Z', '2026-05-01T00:00:00.000Z'
            )
          `
        )
        .run();
      const before = db.sqlite
        .prepare("SELECT COUNT(*) AS count FROM customers")
        .get() as { count: number };

      const response = await postAdminReservation(
        db,
        access.token,
        createRequestBody({
          idempotencyKey: "admin-create-existing-1",
          customerId: "customer_existing_1",
          origin: "minimo",
          customer: undefined,
        })
      );

      expect(response.status).toBe(201);
      const json = (await response.json()) as { ok: boolean; reservationId: string };
      expect(json.ok).toBe(true);

      const after = db.sqlite
        .prepare("SELECT COUNT(*) AS count FROM customers")
        .get() as { count: number };
      // No new customers row was inserted — the existing row was reused.
      expect(after.count).toBe(before.count);

      const reservation = db.sqlite
        .prepare(
          "SELECT customer_id, source, reservation_origin FROM reservations WHERE id = ?"
        )
        .get(json.reservationId) as {
          customer_id: string;
          source: string;
          reservation_origin: string | null;
        };
      expect(reservation).toEqual({
        customer_id: "customer_existing_1",
        source: "phone_admin",
        reservation_origin: "minimo",
      });

      // A customer without a linked LINE identity has no notification recipient.
      const notificationCount = db.sqlite
        .prepare("SELECT COUNT(*) AS count FROM notification_jobs WHERE reservation_id = ?")
        .get(json.reservationId) as { count: number };
      expect(notificationCount.count).toBe(0);
    } finally {
      db.sqlite.close();
    }
  });

  it.each([
    ["phone_admin", "id"], ["phone_admin", "phone"], ["admin", "id"], ["admin", "phone"]
  ])("shows and notifies linked manual bookings exactly once (%s, %s)", async (source, mode) => {
    const db = createMigratedSqliteD1();
    const access = createAccessJwtFixture();
    vi.stubGlobal("fetch", createFetchMock(access.jwk));
    try {
      insertAdminUser(db);
      db.sqlite.prepare(`INSERT INTO customers (id, display_name, phone_normalized, phone_hash)
        VALUES ('linked_customer', '既存客', '0750000000', ?)`)
        .run(await sha256Hex("0750000000"));
      db.sqlite.exec(`INSERT INTO line_identities (id, customer_id, channel_id, line_user_id, official_friend_status)
        VALUES ('linked_identity', 'linked_customer', 'line_channel_admin', 'linked_line_user', 'friend'),
          ('foreign_identity', 'linked_customer', 'other_channel', 'foreign_line_user', 'friend');`);
      const request = createRequestBody({ source,
        ...(mode === "id" ? { customerId: "linked_customer", customer: undefined } : {}) });
      const response = await postAdminReservation(db, access.token, request);
      expect(response.status).toBe(201);
      const result = await response.json() as { reservationId: string };
      expect(db.sqlite.prepare("SELECT customer_id, line_identity_id FROM reservations WHERE id = ?")
        .get(result.reservationId)).toEqual({ customer_id: "linked_customer", line_identity_id: "linked_identity" });
      expect(await listMyReservations(db as unknown as D1Database, { lineIdentityId: "linked_identity", nowIso: new Date().toISOString() }))
        .toMatchObject([{ id: result.reservationId, status: "confirmed" }]);

      const replay = await postAdminReservation(db, access.token, request);
      expect(replay.status).toBe(200);
      expect(await replay.json()).toMatchObject({ reservationId: result.reservationId, replayed: true });
      expect(db.sqlite.prepare("SELECT template_key, recipient_id FROM notification_jobs WHERE reservation_id = ?")
        .all(result.reservationId)).toEqual([{ template_key: "reservation_confirmed", recipient_id: "linked_customer" }]);

      const fetcher = vi.fn<typeof fetch>(async () => Response.json({ sentMessages: [{ id: "test_message" }] }));
      expect(await processDueLineNotificationJobs({ db: db as unknown as D1Database, env: { LINE_MESSAGING_CHANNEL_ACCESS_TOKEN: "test_token" }, fetcher }))
        .toEqual({ processed: 1, succeeded: 1, failed: 0 });
      expect(fetcher).toHaveBeenCalledTimes(1);
      const sent = await new Response(vi.mocked(fetcher).mock.calls[0]?.[1]?.body).json() as { to: string };
      expect(sent.to).toBe("linked_line_user");
      expect(JSON.stringify(sent)).toContain("予約が確定しました");
    } finally {
      db.sqlite.close();
    }
  });

  it.each(["unlinked", "other channel", "other provider", "ambiguous"])(
    "creates the reservation without guessing a LINE recipient: %s", async (scenario) => {
      const db = createMigratedSqliteD1();
      const access = createAccessJwtFixture();
      vi.stubGlobal("fetch", createFetchMock(access.jwk));
      try {
        insertAdminUser(db);
        db.sqlite.exec("INSERT INTO customers (id, display_name) VALUES ('linked_customer', '既存客')");
        if (scenario !== "unlinked") {
          db.sqlite.prepare(`INSERT INTO line_identities (id, customer_id, provider, channel_id, line_user_id)
            VALUES ('identity_one', 'linked_customer', ?, ?, 'user_one')`)
            .run(scenario === "other provider" ? "other" : "line",
              scenario === "other channel" ? "other_channel" : "line_channel_admin");
        }
        if (scenario === "ambiguous") {
          db.sqlite.exec(`INSERT INTO line_identities (id, customer_id, channel_id, line_user_id)
            VALUES ('identity_two', 'linked_customer', 'line_channel_admin', 'user_two')`);
        }
        const response = await postAdminReservation(db, access.token,
          createRequestBody({ customerId: "linked_customer", customer: undefined }));
        expect(response.status).toBe(201);
        const result = await response.json() as { reservationId: string };
        expect(db.sqlite.prepare("SELECT line_identity_id FROM reservations WHERE id = ?")
          .get(result.reservationId)).toEqual({ line_identity_id: null });
        expect(db.sqlite.prepare("SELECT COUNT(*) AS n FROM notification_jobs").get()).toEqual({ n: 0 });
      } finally {
        db.sqlite.close();
      }
    }
  );

  it("rolls back the reservation and locks if creating its LINE notification fails", async () => {
    const db = createMigratedSqliteD1();
    const access = createAccessJwtFixture();
    vi.stubGlobal("fetch", createFetchMock(access.jwk));
    try {
      insertAdminUser(db);
      db.sqlite.exec(`
        INSERT INTO customers (id, display_name) VALUES ('linked_customer', '既存客');
        INSERT INTO line_identities (id, customer_id, channel_id, line_user_id)
        VALUES ('linked_identity', 'linked_customer', 'line_channel_admin', 'linked_user');
        CREATE TRIGGER reject_notification BEFORE INSERT ON notification_jobs
        BEGIN SELECT RAISE(ABORT, 'simulated notification write failure'); END;
      `);
      const response = await postAdminReservation(db, access.token,
        createRequestBody({ customerId: "linked_customer", customer: undefined }));
      expect(response.status).toBe(500);
      expect(await response.json()).toMatchObject({ ok: false, reason: "write_failed" });
      for (const table of ["reservations", "slot_locks", "customer_time_locks", "notification_jobs", "calendar_sync_jobs", "idempotency_keys"]) {
        expect(db.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
      }
    } finally {
      db.sqlite.close();
    }
  });

  it("books against a phone-less existing customer (customerId, no phone on file)", async () => {
    const db = createMigratedSqliteD1();
    const access = createAccessJwtFixture();
    vi.stubGlobal("fetch", createFetchMock(access.jwk));

    try {
      insertAdminUser(db);
      // Paper-chart customer with NO phone (phone_normalized / phone_hash NULL).
      db.sqlite
        .prepare(
          `
            INSERT INTO customers (
              id, display_name, display_name_kana, phone_normalized, phone_hash,
              block_status, created_at, updated_at
            ) VALUES (
              'customer_phoneless_1', '紙カルテ 花子', NULL, NULL, NULL, 'active',
              '2026-05-01T00:00:00.000Z', '2026-05-01T00:00:00.000Z'
            )
          `
        )
        .run();

      const response = await postAdminReservation(
        db,
        access.token,
        createRequestBody({
          idempotencyKey: "admin-create-phoneless-1",
          customerId: "customer_phoneless_1",
          origin: "walk_in",
          customer: undefined,
        })
      );

      expect(response.status).toBe(201);
      const json = (await response.json()) as { ok: boolean; reservationId: string };
      expect(json.ok).toBe(true);

      // The customer_time_lock for a phone-less customer carries a NULL phone_hash.
      const phoneHashRow = db.sqlite
        .prepare(
          "SELECT phone_hash FROM customer_time_locks WHERE customer_id = ? LIMIT 1"
        )
        .get("customer_phoneless_1") as { phone_hash: string | null };
      expect(phoneHashRow.phone_hash).toBeNull();
    } finally {
      db.sqlite.close();
    }
  });

  it("rejects a customerId that does not exist with customer_not_found (404)", async () => {
    const db = createMigratedSqliteD1();
    const access = createAccessJwtFixture();
    vi.stubGlobal("fetch", createFetchMock(access.jwk));

    try {
      insertAdminUser(db);
      const response = await postAdminReservation(
        db,
        access.token,
        createRequestBody({
          idempotencyKey: "admin-create-missing-customer-1",
          customerId: "customer_does_not_exist",
          customer: undefined,
        })
      );

      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toEqual({
        ok: false,
        reason: "customer_not_found",
      });
      const reservationCount = db.sqlite
        .prepare("SELECT COUNT(*) AS count FROM reservations")
        .get() as { count: number };
      expect(reservationCount.count).toBe(0);
    } finally {
      db.sqlite.close();
    }
  });

  // issue #639: 管理画面の電話番号入力モードでも、ブロック済みの番号を国際表記で
  // 打ち直すだけで別ハッシュになり予約が通っていた。normalizePhone が保存前に国内表記へ
  // 寄せることで、どの表記で打っても同じ 1 個のハッシュに解決される。
  it("rejects the international spelling of a phone number blocked in domestic form", async () => {
    const db = createMigratedSqliteD1();
    const access = createAccessJwtFixture();
    vi.stubGlobal("fetch", createFetchMock(access.jwk));

    try {
      insertAdminUser(db);
      const blockedHash = await sha256Hex("0750000000");
      db.sqlite
        .prepare(
          `
            INSERT INTO customers (
              id, display_name, phone_normalized, phone_hash, block_status, created_at, updated_at
            ) VALUES (
              'customer_blocked_intl', 'ブロック 客', '0750000000', ?,
              'blocked', '2026-05-01T00:00:00.000Z', '2026-05-01T00:00:00.000Z'
            )
          `
        )
        .run(blockedHash);

      const response = await postAdminReservation(
        db,
        access.token,
        createRequestBody({
          idempotencyKey: "admin-create-blocked-intl-1",
          customer: { displayName: "別 名義", displayNameKana: "ベツ メイギ", phone: "+81 75-000-0000" }
        })
      );

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ ok: false, reason: "customer_blocked" });
      expect((db.sqlite.prepare("SELECT COUNT(*) AS n FROM reservations").get() as { n: number }).n).toBe(0);
    } finally {
      db.sqlite.close();
    }
  });

  it("rejects a blocked existing customer selected by customerId", async () => {
    const db = createMigratedSqliteD1();
    const access = createAccessJwtFixture();
    vi.stubGlobal("fetch", createFetchMock(access.jwk));

    try {
      insertAdminUser(db);
      db.sqlite
        .prepare(
          `
            INSERT INTO customers (
              id, display_name, phone_normalized, phone_hash, block_status,
              created_at, updated_at
            ) VALUES (
              'customer_blocked_1', 'ブロック 客', '0900000002', 'phonehash_blocked_1',
              'blocked', '2026-05-01T00:00:00.000Z', '2026-05-01T00:00:00.000Z'
            )
          `
        )
        .run();

      const response = await postAdminReservation(
        db,
        access.token,
        createRequestBody({
          idempotencyKey: "admin-create-blocked-by-id-1",
          customerId: "customer_blocked_1",
          customer: undefined,
        })
      );

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        ok: false,
        reason: "customer_blocked",
      });
    } finally {
      db.sqlite.close();
    }
  });

  it("rejects a request that supplies neither customerId nor customer", async () => {
    const db = createMigratedSqliteD1();
    const access = createAccessJwtFixture();
    vi.stubGlobal("fetch", createFetchMock(access.jwk));

    try {
      insertAdminUser(db);
      const response = await postAdminReservation(
        db,
        access.token,
        createRequestBody({
          idempotencyKey: "admin-create-neither-1",
          customerId: undefined,
          customer: undefined,
        })
      );

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        ok: false,
        reason: "invalid_request",
      });
    } finally {
      db.sqlite.close();
    }
  });

  it("forbids a store-unlinked staff from booking any customer by customerId (fail-closed)", async () => {
    const db = createMigratedSqliteD1();
    const access = createAccessJwtFixture();
    vi.stubGlobal("fetch", createFetchMock(access.jwk));

    try {
      insertAdminUser(db, "staff");
      db.sqlite
        .prepare(
          `
            INSERT INTO customers (
              id, display_name, phone_normalized, phone_hash, block_status,
              created_at, updated_at
            ) VALUES (
              'customer_for_staff_1', '既存 客', '0900000003', 'phonehash_staff_1',
              'active', '2026-05-01T00:00:00.000Z', '2026-05-01T00:00:00.000Z'
            )
          `
        )
        .run();

      const response = await postAdminReservation(
        db,
        access.token,
        createRequestBody({
          idempotencyKey: "admin-create-staff-customerid-1",
          customerId: "customer_for_staff_1",
          customer: undefined,
        })
      );

      // Staff may book existing customers only within their own-store scope
      // (staffCanAccessCustomer). Without a staff_members binding there is no
      // store to scope to, so the gate fails closed — same semantics as
      // assertStaffCustomerStoreScope. (PR#462: staff rebook)
      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toEqual({
        ok: false,
        reason: "forbidden",
      });
    } finally {
      db.sqlite.close();
    }
  });

  // The headline flow: register the paper-chart customer, then take their phone
  // booking. Without created_store_id in the own-store phone lookup, the booking
  // would silently create a SECOND row for the same number — and staff cannot merge.
  it("reuses the manually registered customer when staff type the same phone number", async () => {
    const db = createMigratedSqliteD1();
    const access = createAccessJwtFixture();
    vi.stubGlobal("fetch", createFetchMock(access.jwk));

    try {
      insertAdminUser(db, "staff", { id: "staff_kyoto_phone_reuse", storeId: "kyoto" });
      // 予約作成が打ち込み電話番号から作るのと同じ正規化値 + hash でなければ、
      // このテストは何も検証しない (別 hash の行が増えても気付けない)。
      const typedPhone = "090-0000-0055";
      const phone = normalizePhone(typedPhone) as string;
      const phoneHash = await sha256Hex(phone);
      db.sqlite
        .prepare(
          `
            INSERT INTO customers (
              id, display_name, phone_normalized, phone_hash, block_status,
              created_store_id, created_at, updated_at
            ) VALUES (
              'customer_registered_phone', '紙カルテ 客', ?, ?,
              'active', 'kyoto', '2026-05-01T00:00:00.000Z', '2026-05-01T00:00:00.000Z'
            )
          `
        )
        .run(phone, phoneHash);

      const response = await postAdminReservation(
        db,
        access.token,
        createRequestBody({
          idempotencyKey: "admin-create-staff-phone-reuse-1",
          customer: { displayName: "紙カルテ 客", displayNameKana: "カミカルテ キャク", phone: typedPhone },
        })
      );

      expect(response.status).toBe(201);
      const rows = db.sqlite.prepare("SELECT id FROM customers").all() as Array<{ id: string }>;
      expect(rows.map((r) => r.id)).toEqual(["customer_registered_phone"]);
      const linked = db.sqlite
        .prepare("SELECT customer_id FROM reservations WHERE store_id = 'kyoto'")
        .get() as { customer_id: string };
      expect(linked.customer_id).toBe("customer_registered_phone");
    } finally {
      db.sqlite.close();
    }
  });

  // A staff-registered customer (created_store_id) has no reservation and no visit
  // yet — the whole point of the manual-registration flow is to book them next.
  it("lets a store-bound staff book a customer their own store registered manually", async () => {
    const db = createMigratedSqliteD1();
    const access = createAccessJwtFixture();
    vi.stubGlobal("fetch", createFetchMock(access.jwk));

    try {
      insertAdminUser(db, "staff", { id: "staff_kyoto_registered", storeId: "kyoto" });
      db.sqlite
        .prepare(
          `
            INSERT INTO customers (
              id, display_name, phone_normalized, phone_hash, block_status,
              created_store_id, created_at, updated_at
            ) VALUES (
              'customer_registered_by_staff', '紙カルテ 客', '0900000004', 'phonehash_staff_2',
              'active', 'kyoto', '2026-05-01T00:00:00.000Z', '2026-05-01T00:00:00.000Z'
            )
          `
        )
        .run();

      const response = await postAdminReservation(
        db,
        access.token,
        createRequestBody({
          idempotencyKey: "admin-create-staff-registered-1",
          customerId: "customer_registered_by_staff",
          customer: undefined,
        })
      );

      expect(response.status).toBe(201);
    } finally {
      db.sqlite.close();
    }
  });

  it("returns store_closed when a closure is committed after the create precheck", async () => {
    const db = createMigratedSqliteD1();
    const access = createAccessJwtFixture();
    vi.stubGlobal("fetch", createFetchMock(access.jwk));

    try {
      insertAdminUser(db);
      const originalBatch = db.batch.bind(db);
      let injected = false;
      db.batch = async (statements) => {
        if (!injected) {
          injected = true;
          db.sqlite
            .prepare(
              `INSERT INTO store_closures (id, store_id, starts_at, ends_at, source)
               VALUES ('closure_admin_create_race', 'kyoto',
                       '2026-06-01T01:00:00.000Z', '2026-06-01T02:00:00.000Z', 'admin')`
            )
            .run();
        }
        return originalBatch(statements);
      };

      const response = await postAdminReservation(
        db,
        access.token,
        createRequestBody({ idempotencyKey: "admin-create-closure-race" })
      );

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ ok: false, reason: "store_closed" });
      expect(
        (db.sqlite.prepare("SELECT COUNT(*) AS count FROM reservations").get() as { count: number }).count
      ).toBe(0);
      expect(captureBatchWriteFailure).not.toHaveBeenCalled();
    } finally {
      db.sqlite.close();
    }
  });

  it("uses the customer's current phone_hash when it changes after the create precheck", async () => {
    const db = createMigratedSqliteD1();
    const access = createAccessJwtFixture();
    vi.stubGlobal("fetch", createFetchMock(access.jwk));

    try {
      insertAdminUser(db);
      const customerId = "customer_admin_create_phone_race";
      const currentPhoneHash = "phone_hash_admin_create_after";
      db.sqlite
        .prepare(
          `INSERT INTO customers (
             id, display_name, phone_normalized, phone_hash, block_status, created_at, updated_at
           ) VALUES (?, '電話 競合', '0900000011', 'phone_hash_admin_create_before',
                     'active', '2026-05-01T00:00:00.000Z', '2026-05-01T00:00:00.000Z')`
        )
        .run(customerId);

      const originalBatch = db.batch.bind(db);
      db.batch = async (statements) => {
        db.sqlite
          .prepare("UPDATE customers SET phone_normalized = '0900000012', phone_hash = ? WHERE id = ?")
          .run(currentPhoneHash, customerId);
        return originalBatch(statements);
      };

      const response = await postAdminReservation(
        db,
        access.token,
        createRequestBody({
          idempotencyKey: "admin-create-phone-hash-race",
          customerId,
          customer: undefined,
        })
      );

      expect(response.status).toBe(201);
      const lockHashes = db.sqlite
        .prepare("SELECT DISTINCT phone_hash FROM customer_time_locks WHERE customer_id = ?")
        .all(customerId) as Array<{ phone_hash: string | null }>;
      expect(lockHashes).toEqual([{ phone_hash: currentPhoneHash }]);
    } finally {
      db.sqlite.close();
    }
  });

  it("rejects a merged tombstone customerId with customer_not_found (404)", async () => {
    const db = createMigratedSqliteD1();
    const access = createAccessJwtFixture();
    vi.stubGlobal("fetch", createFetchMock(access.jwk));

    try {
      insertAdminUser(db);
      // Canonical survivor + a merged tombstone pointing at it. getCustomerById
      // filters merged_into_id IS NULL, so the tombstone must be unbookable.
      db.sqlite
        .prepare(
          `
            INSERT INTO customers (
              id, display_name, phone_normalized, phone_hash, block_status,
              created_at, updated_at
            ) VALUES (
              'customer_canonical_1', '統合先 客', '0900000004', 'phonehash_canonical_1',
              'active', '2026-05-01T00:00:00.000Z', '2026-05-01T00:00:00.000Z'
            )
          `
        )
        .run();
      db.sqlite
        .prepare(
          `
            INSERT INTO customers (
              id, display_name, phone_normalized, phone_hash, block_status,
              merged_into_id, created_at, updated_at
            ) VALUES (
              'customer_tombstone_1', '統合元 客', NULL, NULL, 'blocked',
              'customer_canonical_1', '2026-05-01T00:00:00.000Z', '2026-05-01T00:00:00.000Z'
            )
          `
        )
        .run();

      const response = await postAdminReservation(
        db,
        access.token,
        createRequestBody({
          idempotencyKey: "admin-create-tombstone-1",
          customerId: "customer_tombstone_1",
          customer: undefined,
        })
      );

      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toEqual({
        ok: false,
        reason: "customer_not_found",
      });
    } finally {
      db.sqlite.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Archived customers must never be reused/booked by the admin create path.
// ---------------------------------------------------------------------------
describe("admin create reservation ignores archived customers", () => {
  beforeEach(() => {
    // Freeze Date so the hard-coded 2026-06-01 slot stays in the future.
    vi.useFakeTimers({ now: new Date("2026-05-09T00:00:00.000Z"), toFake: ["Date"] });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("creates a new customer rather than reusing an archived same-phone row (phone_hash path)", async () => {
    const db = createMigratedSqliteD1();
    const access = createAccessJwtFixture();
    vi.stubGlobal("fetch", createFetchMock(access.jwk));
    try {
      insertAdminUser(db);
      const normalized = normalizePhone("075-000-0000")!;
      const hash = await sha256Hex(normalized);
      db.sqlite
        .prepare(
          `INSERT INTO customers (id, display_name, phone_normalized, phone_hash, block_status, archived_at, updated_at)
           VALUES ('cust_archived_phone', '旧客', ?, ?, 'active', '2026-05-08T00:00:00.000Z', '2026-05-08T00:00:00.000Z')`
        )
        .run(normalized, hash);

      const response = await postAdminReservation(db, access.token, createRequestBody());
      expect(response.status).toBe(201);

      const row = db.sqlite
        .prepare(
          "SELECT customer_id FROM reservations WHERE source = 'phone_admin' ORDER BY created_at DESC LIMIT 1"
        )
        .get() as { customer_id: string } | undefined;
      // The reservation's customer must NOT be the archived row.
      expect(row?.customer_id).not.toBe("cust_archived_phone");
    } finally {
      db.sqlite.close();
    }
  });

  it("rejects existing-customer mode booking against an archived customer (customer_not_found)", async () => {
    const db = createMigratedSqliteD1();
    const access = createAccessJwtFixture();
    vi.stubGlobal("fetch", createFetchMock(access.jwk));
    try {
      insertAdminUser(db);
      db.sqlite
        .prepare(
          `INSERT INTO customers (id, display_name, block_status, archived_at, updated_at)
           VALUES ('cust_archived_existing', 'アーカイブ既存客', 'active', '2026-05-08T00:00:00.000Z', '2026-05-08T00:00:00.000Z')`
        )
        .run();

      const response = await postAdminReservation(
        db,
        access.token,
        createRequestBody({
          idempotencyKey: "admin-create-archived-existing-1",
          customerId: "cust_archived_existing",
          customer: undefined,
        })
      );

      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toEqual({
        ok: false,
        reason: "customer_not_found",
      });
    } finally {
      db.sqlite.close();
    }
  });
});

describe("admin reservation creation — staff store-scope (membership-fabrication defense)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-05-09T23:00:00.000Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const staffKyoto: AdminUser = {
    id: "admin_create_owner_1",
    email: ADMIN_EMAIL,
    role: "staff",
    staff_member_id: "staff_owner_kyoto",
    store_id: "kyoto",
  };

  const staffReq = (overrides: Record<string, unknown> = {}): AdminCreateReservationRequest =>
    ({
      idempotencyKey: "staff-create-1",
      source: "admin",
      storeId: "kyoto",
      serviceIds: ["service_kyoto_default_60"],
      resourceId: "resource_kyoto_calendar",
      startAt: "2026-05-14T01:00:00.000Z", // Thursday 10:00 JST — open + within window
      customer: { displayName: "新規 客", displayNameKana: "シンキ キャク", phone: "075-111-2222" },
      ...overrides,
    }) as AdminCreateReservationRequest;

  const seedCustomerWithReservation = async (
    db: SqliteD1Database,
    customerId: string,
    phone: string,
    reservationStore: string
  ) => {
    const normalized = normalizePhone(phone)!;
    const hash = await sha256Hex(normalized);
    db.sqlite
      .prepare(
        `INSERT INTO customers (id, display_name, phone_normalized, phone_hash, block_status, created_at, updated_at)
         VALUES (?, '既存 客', ?, ?, 'active', '2026-05-01T00:00:00Z', '2026-05-01T00:00:00Z')`
      )
      .run(customerId, normalized, hash);
    db.sqlite
      .prepare(
        `INSERT INTO reservations (id, store_id, service_id, customer_id, resource_id, source, status, duration_minutes, idempotency_key, start_at, end_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'admin', 'completed', 60, ?, '2026-04-01T10:00:00Z', '2026-04-01T11:00:00Z', '2026-04-01T10:00:00Z', '2026-04-01T10:00:00Z')`
      )
      .run(`r_${customerId}`, reservationStore, `service_${reservationStore}_default_60`, customerId, `resource_${reservationStore}_calendar`, `ik_${customerId}`);
    return hash;
  };

  it("rejects a staff booking for a store other than their own (forbidden)", async () => {
    const db = createMigratedSqliteD1();
    try {
      insertAdminUser(db, "staff");
      db.sqlite.exec("UPDATE admin_users SET staff_member_id = 'staff_owner_kyoto' WHERE id = 'admin_create_owner_1'");
      const result = await createAdminReservation({
        db: db as unknown as D1Database,
        admin: staffKyoto,
        request: staffReq({ storeId: "osaka" }),
        now: () => Date.parse("2026-05-09T23:00:00.000Z"),
      });
      expect(result).toEqual({ ok: false, reason: "forbidden" });
    } finally {
      db.sqlite.close();
    }
  });

  it("does NOT reuse a non-own-store customer matched by phone (blocks membership fabrication)", async () => {
    const db = createMigratedSqliteD1();
    try {
      insertAdminUser(db, "staff");
      db.sqlite.exec("UPDATE admin_users SET staff_member_id = 'staff_owner_kyoto' WHERE id = 'admin_create_owner_1'");
      // Victim belongs to OSAKA only; the kyoto staff types the victim's phone.
      const hash = await seedCustomerWithReservation(db, "c_victim", "075-111-2222", "osaka");
      db.sqlite.exec(`INSERT INTO line_identities (id, customer_id, channel_id, line_user_id)
        VALUES ('victim_identity', 'c_victim', 'line_channel_admin', 'victim_line_user')`);
      const result = await createAdminReservation({
        db: db as unknown as D1Database,
        admin: staffKyoto,
        lineChannelId: "line_channel_admin",
        request: staffReq(),
        now: () => Date.parse("2026-05-09T23:00:00.000Z"),
      });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.reason);
      // A fresh own-store row was created; the kyoto reservation is NOT linked to the victim.
      const resvCustomer = db.sqlite
        .prepare("SELECT customer_id FROM reservations WHERE id = ?")
        .get(result.reservationId) as { customer_id: string };
      expect(resvCustomer.customer_id).not.toBe("c_victim");
      expect(db.sqlite.prepare("SELECT line_identity_id FROM reservations WHERE id = ?")
        .get(result.reservationId)).toEqual({ line_identity_id: null });
      expect(db.sqlite.prepare("SELECT COUNT(*) AS n FROM notification_jobs").get()).toEqual({ n: 0 });
      // Two rows now share the phone_hash → a merge candidate for the owner; victim untouched.
      const n = (db.sqlite.prepare("SELECT COUNT(*) AS n FROM customers WHERE phone_hash = ?").get(hash) as { n: number }).n;
      expect(n).toBe(2);
    } finally {
      db.sqlite.close();
    }
  });

  it("DOES reuse an own-store customer matched by phone (legit returning customer, no duplicate)", async () => {
    const db = createMigratedSqliteD1();
    try {
      insertAdminUser(db, "staff");
      db.sqlite.exec("UPDATE admin_users SET staff_member_id = 'staff_owner_kyoto' WHERE id = 'admin_create_owner_1'");
      const hash = await seedCustomerWithReservation(db, "c_return", "075-111-2222", "kyoto");
      const result = await createAdminReservation({
        db: db as unknown as D1Database,
        admin: staffKyoto,
        request: staffReq(),
        now: () => Date.parse("2026-05-09T23:00:00.000Z"),
      });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.reason);
      const resvCustomer = db.sqlite
        .prepare("SELECT customer_id FROM reservations WHERE id = ?")
        .get(result.reservationId) as { customer_id: string };
      expect(resvCustomer.customer_id).toBe("c_return"); // reused, not duplicated
      const n = (db.sqlite.prepare("SELECT COUNT(*) AS n FROM customers WHERE phone_hash = ?").get(hash) as { n: number }).n;
      expect(n).toBe(1);
    } finally {
      db.sqlite.close();
    }
  });
});

// PR#462: staff may book existing customers by customerId within their own-store
// scope (staffCanAccessCustomer). HTTP-level tests so the whole chain is covered:
// Access JWT auth → staff_members store derivation → authz gate → 201/403/409 mapping.
describe("admin reservation creation — staff customerId booking (own-store scope, HTTP)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: new Date("2026-05-09T00:00:00.000Z"), toFake: ["Date"] });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const STAFF_KYOTO = { id: "staff_member_kyoto_http", storeId: "kyoto" };

  const seedCustomer = (db: SqliteD1Database, customerId: string, phoneHash: string) => {
    db.sqlite
      .prepare(
        `INSERT INTO customers (id, display_name, phone_normalized, phone_hash, block_status, created_at, updated_at)
         VALUES (?, '既存 客', ?, ?, 'active', '2026-05-01T00:00:00Z', '2026-05-01T00:00:00Z')`
      )
      .run(customerId, `090${phoneHash.slice(0, 7)}`, phoneHash);
  };

  const seedReservationAt = (db: SqliteD1Database, customerId: string, storeId: string) => {
    const serviceId = storeId === "kyoto" ? "service_kyoto_default_60" : `service_${storeId}_default_60`;
    const resourceId = `resource_${storeId}_calendar`;
    db.sqlite
      .prepare(
        `INSERT INTO reservations (id, store_id, service_id, customer_id, resource_id, source, status, duration_minutes, idempotency_key, start_at, end_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'admin', 'completed', 60, ?, '2026-04-01T10:00:00Z', '2026-04-01T11:00:00Z', '2026-04-01T10:00:00Z', '2026-04-01T10:00:00Z')`
      )
      .run(`r_${customerId}_${storeId}`, storeId, serviceId, customerId, resourceId, `ik_${customerId}_${storeId}`);
  };

  const seedVisit = (
    db: SqliteD1Database,
    customerId: string,
    storeId: string,
    status: "valid" | "voided"
  ) => {
    db.sqlite
      .prepare(
        `INSERT INTO customer_visits (id, customer_id, reservation_id, store_id, visited_at, visit_source, status, recorded_by, voided_by, voided_at, void_reason)
         VALUES (?, ?, NULL, ?, '2026-04-15', 'manual_import', ?, 'admin_create_owner_1', ?, ?, ?)`
      )
      .run(
        `v_${customerId}_${status}`,
        customerId,
        storeId,
        status,
        status === "voided" ? "admin_create_owner_1" : null,
        status === "voided" ? "2026-04-16T00:00:00Z" : null,
        status === "voided" ? "誤登録" : null
      );
  };

  const staffCustomerIdBody = (customerId: string, overrides: Record<string, unknown> = {}) =>
    createRequestBody({
      idempotencyKey: `staff-rebook-${customerId}`,
      source: "admin",
      customerId,
      customer: undefined,
      ...overrides,
    });

  const sideEffectCounts = (db: SqliteD1Database) =>
    db.sqlite
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM reservations) AS reservations,
           (SELECT COUNT(*) FROM slot_locks) AS slotLocks,
           (SELECT COUNT(*) FROM customer_time_locks) AS customerTimeLocks,
           (SELECT COUNT(*) FROM idempotency_keys) AS idempotencyKeys`
      )
      .get() as { reservations: number; slotLocks: number; customerTimeLocks: number; idempotencyKeys: number };

  it("allows a linked staff to book an own-store customer by customerId (201, customer row reused)", async () => {
    const db = createMigratedSqliteD1();
    const access = createAccessJwtFixture();
    vi.stubGlobal("fetch", createFetchMock(access.jwk));

    try {
      insertAdminUser(db, "staff", STAFF_KYOTO);
      seedCustomer(db, "c_staff_own", "hash_staff_own");
      seedReservationAt(db, "c_staff_own", "kyoto");

      const response = await postAdminReservation(db, access.token, staffCustomerIdBody("c_staff_own"));

      expect(response.status).toBe(201);
      const json = (await response.json()) as { ok: boolean; reservationId: string };
      expect(json).toMatchObject({ ok: true });

      const created = db.sqlite
        .prepare("SELECT customer_id, store_id FROM reservations WHERE id = ?")
        .get(json.reservationId) as { customer_id: string; store_id: string };
      expect(created).toEqual({ customer_id: "c_staff_own", store_id: "kyoto" });
      const customerCount = (db.sqlite.prepare("SELECT COUNT(*) AS n FROM customers").get() as { n: number }).n;
      expect(customerCount).toBe(1); // reused, no new customer row
    } finally {
      db.sqlite.close();
    }
  });

  it("allows a linked staff to book a customer whose only own-store relationship is a valid visit (201)", async () => {
    const db = createMigratedSqliteD1();
    const access = createAccessJwtFixture();
    vi.stubGlobal("fetch", createFetchMock(access.jwk));

    try {
      insertAdminUser(db, "staff", STAFF_KYOTO);
      seedCustomer(db, "c_staff_visit", "hash_staff_visit");
      seedVisit(db, "c_staff_visit", "kyoto", "valid");

      const response = await postAdminReservation(db, access.token, staffCustomerIdBody("c_staff_visit"));

      expect(response.status).toBe(201);
      await expect(response.json()).resolves.toMatchObject({ ok: true });
    } finally {
      db.sqlite.close();
    }
  });

  // specs/006 lets staff register customers, so staff can now put a SECOND active row
  // on a number that already belongs to a blocked customer and book that row by id.
  // Blocks are keyed on the number (public submit and the typed-phone admin path both
  // reject the whole phone_hash), so the id path must reject it too. Without the wide
  // gate this books successfully and store A's block is silently defeated by store B.
  it("rejects booking a staff-registered duplicate of a blocked number (400, no reservation)", async () => {
    const db = createMigratedSqliteD1();
    const access = createAccessJwtFixture();
    vi.stubGlobal("fetch", createFetchMock(access.jwk));

    try {
      insertAdminUser(db, "staff", STAFF_KYOTO);
      // Blocked canonical row, reachable only from the OTHER store — staff cannot
      // unblock it (staffCanAccessCustomer fails), so re-registration is the only
      // route they have to it.
      seedCustomer(db, "c_blocked_osaka", "hash_shared_number");
      seedReservationAt(db, "c_blocked_osaka", "osaka");
      db.sqlite.prepare("UPDATE customers SET block_status = 'blocked' WHERE id = 'c_blocked_osaka'").run();
      // The row staff just created from 顧客を追加: same number, active, own store.
      seedCustomer(db, "c_staff_dupe", "hash_shared_number");
      db.sqlite.prepare("UPDATE customers SET created_store_id = 'kyoto' WHERE id = 'c_staff_dupe'").run();
      const before = sideEffectCounts(db);

      const response = await postAdminReservation(db, access.token, staffCustomerIdBody("c_staff_dupe"));

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ ok: false, reason: "customer_blocked" });
      expect(sideEffectCounts(db)).toEqual(before);
    } finally {
      db.sqlite.close();
    }
  });

  // The preflight gate is preflight: another operator can block a SIBLING row between
  // the check and the insert, and the original trigger only re-checks NEW.customer_id.
  // migration 0052 closes that window at the DB boundary — asserted by writing the
  // reservation directly, which is exactly what the race would do.
  it("rejects a direct reservation insert when a sibling row with the same phone is blocked", () => {
    const db = createMigratedSqliteD1();
    try {
      db.sqlite
        .prepare(
          `INSERT INTO customers (id, display_name, phone_normalized, phone_hash, block_status, created_at, updated_at)
           VALUES
             ('c_race_blocked', 'ブロック 側', '09099998888', 'hash_race', 'blocked', '2026-05-01T00:00:00Z', '2026-05-01T00:00:00Z'),
             ('c_race_active', '重複 側', '09099998888', 'hash_race', 'active', '2026-05-01T00:00:00Z', '2026-05-01T00:00:00Z')`
        )
        .run();

      const insertReservation = (customerId: string) =>
        db.sqlite
          .prepare(
            `INSERT INTO reservations (id, store_id, service_id, customer_id, resource_id, source, status, duration_minutes, idempotency_key, start_at, end_at, created_at, updated_at)
             VALUES (?, 'kyoto', 'service_kyoto_default_60', ?, 'resource_kyoto_calendar', 'admin', 'confirmed', 60, ?, '2026-06-01T02:00:00Z', '2026-06-01T03:00:00Z', '2026-05-09T00:00:00Z', '2026-05-09T00:00:00Z')`
          )
          .run(`r_${customerId}`, customerId, `ik_${customerId}`);

      expect(() => insertReservation("c_race_active")).toThrow(/blocked_customer/);
      // Same-phone is the only reason: unblock the sibling and the row goes in.
      db.sqlite.prepare("UPDATE customers SET block_status = 'active' WHERE id = 'c_race_blocked'").run();
      expect(() => insertReservation("c_race_active")).not.toThrow();
    } finally {
      db.sqlite.close();
    }
  });

  // The wide gate keys on phone_hash, so it must not fire for paper-chart customers:
  // two NULL hashes are not "the same number". A blocked phone-less customer blocks
  // only itself (recorded limitation, not a defect the gate can fix).
  it("still books a phone-less staff-registered customer while another phone-less customer is blocked", async () => {
    const db = createMigratedSqliteD1();
    const access = createAccessJwtFixture();
    vi.stubGlobal("fetch", createFetchMock(access.jwk));

    try {
      insertAdminUser(db, "staff", STAFF_KYOTO);
      db.sqlite
        .prepare(
          `INSERT INTO customers (id, display_name, phone_normalized, phone_hash, block_status, created_store_id, created_at, updated_at)
           VALUES
             ('c_phoneless_blocked', 'ブロック 台帳', NULL, NULL, 'blocked', NULL, '2026-05-01T00:00:00Z', '2026-05-01T00:00:00Z'),
             ('c_phoneless_staff', '紙カルテ 客', NULL, NULL, 'active', 'kyoto', '2026-05-01T00:00:00Z', '2026-05-01T00:00:00Z')`
        )
        .run();

      const response = await postAdminReservation(db, access.token, staffCustomerIdBody("c_phoneless_staff"));

      expect(response.status).toBe(201);
      await expect(response.json()).resolves.toMatchObject({ ok: true });
    } finally {
      db.sqlite.close();
    }
  });

  it("rejects a voided-visit-only customer (403, voided visits grant no scope)", async () => {
    const db = createMigratedSqliteD1();
    const access = createAccessJwtFixture();
    vi.stubGlobal("fetch", createFetchMock(access.jwk));

    try {
      insertAdminUser(db, "staff", STAFF_KYOTO);
      seedCustomer(db, "c_staff_voided", "hash_staff_voided");
      seedVisit(db, "c_staff_voided", "kyoto", "voided");

      const response = await postAdminReservation(db, access.token, staffCustomerIdBody("c_staff_voided"));

      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toEqual({ ok: false, reason: "forbidden" });
    } finally {
      db.sqlite.close();
    }
  });

  it("rejects an other-store-only customer with no side effects (403)", async () => {
    const db = createMigratedSqliteD1();
    const access = createAccessJwtFixture();
    vi.stubGlobal("fetch", createFetchMock(access.jwk));

    try {
      insertAdminUser(db, "staff", STAFF_KYOTO);
      seedCustomer(db, "c_staff_osaka", "hash_staff_osaka");
      seedReservationAt(db, "c_staff_osaka", "osaka");
      const before = sideEffectCounts(db);

      const response = await postAdminReservation(db, access.token, staffCustomerIdBody("c_staff_osaka"));

      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toEqual({ ok: false, reason: "forbidden" });
      // forbidden must be a pure no-op: no reservation, lock, or idempotency rows.
      expect(sideEffectCounts(db)).toEqual(before);
    } finally {
      db.sqlite.close();
    }
  });

  it("returns the identical 403 body for a nonexistent customerId (no existence oracle)", async () => {
    const db = createMigratedSqliteD1();
    const access = createAccessJwtFixture();
    vi.stubGlobal("fetch", createFetchMock(access.jwk));

    try {
      insertAdminUser(db, "staff", STAFF_KYOTO);

      const response = await postAdminReservation(db, access.token, staffCustomerIdBody("c_no_such_customer"));

      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toEqual({ ok: false, reason: "forbidden" });
    } finally {
      db.sqlite.close();
    }
  });

  it("still rejects a blocked own-store customer for staff (customer_blocked)", async () => {
    const db = createMigratedSqliteD1();
    const access = createAccessJwtFixture();
    vi.stubGlobal("fetch", createFetchMock(access.jwk));

    try {
      insertAdminUser(db, "staff", STAFF_KYOTO);
      seedCustomer(db, "c_staff_blocked", "hash_staff_blocked");
      seedReservationAt(db, "c_staff_blocked", "kyoto");
      db.sqlite.prepare("UPDATE customers SET block_status = 'blocked' WHERE id = 'c_staff_blocked'").run();

      const response = await postAdminReservation(db, access.token, staffCustomerIdBody("c_staff_blocked"));

      // Own-store scope passes, but the role-independent blocked gate still fires.
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ ok: false, reason: "customer_blocked" });
    } finally {
      db.sqlite.close();
    }
  });

  it("treats an archived own-store customer as out of scope for staff (403)", async () => {
    const db = createMigratedSqliteD1();
    const access = createAccessJwtFixture();
    vi.stubGlobal("fetch", createFetchMock(access.jwk));

    try {
      insertAdminUser(db, "staff", STAFF_KYOTO);
      seedCustomer(db, "c_staff_archived", "hash_staff_archived");
      seedReservationAt(db, "c_staff_archived", "kyoto");
      db.sqlite
        .prepare("UPDATE customers SET archived_at = '2026-05-01T00:00:00Z' WHERE id = 'c_staff_archived'")
        .run();

      const response = await postAdminReservation(db, access.token, staffCustomerIdBody("c_staff_archived"));

      // staffCanAccessCustomer excludes archived customers → same bare 403.
      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toEqual({ ok: false, reason: "forbidden" });
    } finally {
      db.sqlite.close();
    }
  });

  it("returns a bare customer_time_conflict when the customer is busy at another store (409, no cross-store details)", async () => {
    const db = createMigratedSqliteD1();
    const access = createAccessJwtFixture();
    vi.stubGlobal("fetch", createFetchMock(access.jwk));

    try {
      insertAdminUser(db, "staff", STAFF_KYOTO);
      seedCustomer(db, "c_staff_busy", "hash_staff_busy");
      seedReservationAt(db, "c_staff_busy", "kyoto"); // own-store membership → authz passes
      // The customer's conflicting osaka booking, represented by its
      // customer_time_locks row (UNIQUE(customer_id, slot_at) is what raises the
      // conflict — a reservations row alone never does).
      seedReservationAt(db, "c_staff_busy", "osaka");
      db.sqlite
        .prepare(
          `INSERT INTO customer_time_locks (id, customer_id, slot_at, owner_type, owner_id, lock_status, expires_at, phone_hash)
           VALUES ('ctl_busy_1', 'c_staff_busy', '2026-06-01T01:00:00.000Z', 'reservation', 'r_c_staff_busy_osaka', 'confirmed', NULL, 'hash_staff_busy')`
        )
        .run();

      const response = await postAdminReservation(db, access.token, staffCustomerIdBody("c_staff_busy"));

      expect(response.status).toBe(409);
      // Exact body: the accepted time-oracle discloses ONLY "busy at this time" —
      // never the other store, reservation id, or any detail.
      await expect(response.json()).resolves.toEqual({ ok: false, reason: "customer_time_conflict" });
    } finally {
      db.sqlite.close();
    }
  });
});
