import { describe, expect, it } from "vitest";

import { resolveHumanAdmin } from "../src/admin/access";
import type { AdminUser } from "../src/admin/access";
import {
  listStoreLogins,
  parseStoreLoginUpsertRequest,
  resolveStoreLoginRow,
  revokeStoreLogin,
  upsertStoreLogin
} from "../src/admin/settings-store-login";
import { createMigratedSqliteD1, type SqliteD1Database } from "./helpers/sqlite-d1";
import {
  insertAdminUser as insertAdminUserHelper,
  grantCustomerTabGate,
  type AdminRole,
  type InsertAdminUserOptions
} from "./helpers/admin-access";

// Domain logic for "store login self-service": an owner pre-registers a store's
// shared login by email. The admin_users row is linked (staff_member_id ->
// staff_members.store_id) to a store and carries access_subject='pending:<uuid>'
// until the first verified login binds it (resolveHumanAdmin). These tests
// exercise the security-critical resolver (fail-closed on system_admin /
// ambiguity), the email_in_use hijack guard, and the Case A/B/C upsert paths.

const OWNER: AdminUser = {
  id: "admin_owner_1",
  email: "owner@example.com",
  role: "owner",
  staff_member_id: null,
  store_id: null
};

const SYSTEM_ADMIN: AdminUser = {
  id: "admin_sa_1",
  email: "sa@example.com",
  role: "system_admin",
  staff_member_id: null,
  store_id: null
};

const STAFF: AdminUser = {
  id: "admin_staff_1",
  email: "staff@example.com",
  role: "staff",
  staff_member_id: "staff_login_osaka",
  store_id: "osaka"
};

const asD1 = (db: SqliteD1Database) => db as unknown as D1Database;

const insertStaffMember = (
  db: SqliteD1Database,
  options: { id: string; storeId: string; displayName?: string; role?: string; active?: 0 | 1 }
) => {
  db.sqlite
    .prepare(
      `INSERT INTO staff_members (id, store_id, display_name, role, active)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(
      options.id,
      options.storeId,
      options.displayName ?? "店舗ログイン",
      options.role ?? "staff",
      options.active ?? 1
    );
};

const insertAdminUser = (
  db: SqliteD1Database,
  options: InsertAdminUserOptions & { role?: string }
) =>
  insertAdminUserHelper(db, {
    ...options,
    role: (options.role as AdminRole | undefined) ?? "staff",
    updatedAt: options.updatedAt ?? "2026-05-16T00:00:00.000Z",
  });

const readAdminUser = (db: SqliteD1Database, id: string) =>
  db.sqlite
    .prepare(
      `SELECT id, email, access_subject, role, active, staff_member_id, last_seen_at
       FROM admin_users WHERE id = ?`
    )
    .get(id) as
    | {
        id: string;
        email: string;
        access_subject: string;
        role: string;
        active: number;
        staff_member_id: string | null;
        last_seen_at: string | null;
      }
    | undefined;

const countAdminUsers = (db: SqliteD1Database) =>
  (db.sqlite.prepare(`SELECT COUNT(*) AS c FROM admin_users`).get() as { c: number }).c;

const countAuditLogs = (db: SqliteD1Database, action: string) =>
  (
    db.sqlite
      .prepare(`SELECT COUNT(*) AS c FROM audit_logs WHERE action = ?`)
      .get(action) as { c: number }
  ).c;

const countActiveLoginsForStore = (db: SqliteD1Database, storeId: string) =>
  (
    db.sqlite
      .prepare(
        `SELECT COUNT(*) AS c FROM admin_users
         WHERE staff_member_id = ? AND is_service_token = 0 AND active = 1`
      )
      .get(`staff_login_${storeId}`) as { c: number }
  ).c;

// Fixed operation clock for deterministic updated_at / last_seen_at stamps.
//
// ⚠️ Do NOT use `now: NOW` in any test that reads an idempotency row back
// through `fetchAdminActionIdempotency`. That resolver filters expired rows
// with SQLite `datetime('now')` (the real OS clock, which cannot be faked),
// while a write stamps `expires_at = NOW + IDEMPOTENCY_TTL_MS (24h)`. Because
// NOW is a fixed historical instant, that expires_at is already in the past,
// so the row reads as expired and the replay path breaks once wall-clock time
// passes it. Such tests must stamp from the real clock instead (omit `now`,
// defaulting to Date.now) — see the "replays an identical idempotencyKey"
// test. The other cases keep NOW because they never read an idempotency row
// back through the TTL filter.
const NOW = () => Date.parse("2026-06-03T12:00:00.000Z");

describe("parseStoreLoginUpsertRequest", () => {
  it("accepts a well-formed request and lowercases the email", () => {
    const parsed = parseStoreLoginUpsertRequest({
      storeId: "osaka",
      email: "Umeda@Example.COM",
      role: "staff",
      idempotencyKey: "key-1"
    });
    expect(parsed).toEqual({
      storeId: "osaka",
      email: "umeda@example.com",
      role: "staff",
      idempotencyKey: "key-1"
    });
  });

  it("rejects invalid email / missing fields / non owner|staff role", () => {
    expect(parseStoreLoginUpsertRequest(null)).toBeNull();
    expect(parseStoreLoginUpsertRequest("nope")).toBeNull();
    expect(
      parseStoreLoginUpsertRequest({ storeId: "osaka", email: "bad", role: "staff", idempotencyKey: "k" })
    ).toBeNull();
    expect(
      parseStoreLoginUpsertRequest({ storeId: "osaka", email: "a@b.com", role: "owner", idempotencyKey: "" })
    ).toBeNull();
    expect(
      parseStoreLoginUpsertRequest({ storeId: "", email: "a@b.com", role: "owner", idempotencyKey: "k" })
    ).toBeNull();
    // role must be exactly owner|staff (system_admin not allowed)
    expect(
      parseStoreLoginUpsertRequest({
        storeId: "osaka",
        email: "a@b.com",
        role: "system_admin",
        idempotencyKey: "k"
      })
    ).toBeNull();
    // email too long
    expect(
      parseStoreLoginUpsertRequest({
        storeId: "osaka",
        email: `${"a".repeat(315)}@b.com`,
        role: "owner",
        idempotencyKey: "k"
      })
    ).toBeNull();
  });

  it("email validator accepts/rejects the same set as the (ReDoS-safe replacement) format check", () => {
    const parse = (email: string) =>
      parseStoreLoginUpsertRequest({ storeId: "osaka", email, role: "staff", idempotencyKey: "k" });
    // accepted (structurally valid: exactly one '@' not leading, domain has a dot not first/last).
    // Leading/trailing whitespace is trimmed by parse before validation, so it is accepted.
    for (const ok of [
      "a@b.com",
      "a@b.c",
      "a@b.c.d",
      "first.last@sub.example.co.jp",
      " a@b.com",
      "a@b.com "
    ]) {
      expect(parse(ok), `expected ${ok} accepted`).not.toBeNull();
    }
    // rejected (no dot in domain, dot at boundary, missing/extra '@', leading '@', INTERNAL whitespace)
    for (const bad of [
      "a@b", // no dot in domain
      "a@b.", // dot is last char of domain
      "a@.com", // dot is first char of domain
      "@b.com", // '@' leading
      "a@@b.com", // two '@'
      "a b@c.com", // internal whitespace (survives trim)
      "no-dot@domain"
    ]) {
      expect(parse(bad), `expected ${bad} rejected`).toBeNull();
    }
  });
});

describe("listStoreLogins", () => {
  it("maps unset / pending / active / disabled statuses", async () => {
    const db = createMigratedSqliteD1();
    // kyoto -> pending
    insertStaffMember(db, { id: "staff_login_kyoto", storeId: "kyoto" });
    insertAdminUser(db, {
      id: "au_kyoto",
      email: "kyoto@example.com",
      accessSubject: "pending:abc",
      role: "staff",
      staffMemberId: "staff_login_kyoto"
    });
    // osaka -> active (bound subject + last_seen_at)
    insertStaffMember(db, { id: "staff_login_osaka", storeId: "osaka" });
    insertAdminUser(db, {
      id: "au_osaka",
      email: "osaka@example.com",
      accessSubject: "real-subject-osaka",
      role: "owner",
      staffMemberId: "staff_login_osaka",
      lastSeenAt: "2026-06-01T09:00:00.000Z"
    });
    // nagoya -> disabled
    insertStaffMember(db, { id: "staff_login_nagoya", storeId: "nagoya" });
    insertAdminUser(db, {
      id: "au_nagoya",
      email: "nagoya@example.com",
      accessSubject: "real-subject-nagoya",
      role: "staff",
      active: 0,
      staffMemberId: "staff_login_nagoya"
    });
    // wakayama -> unset (no login)

    const views = await listStoreLogins(asD1(db));
    const byStore = Object.fromEntries(views.map((v) => [v.storeId, v]));

    expect(byStore.wakayama).toMatchObject({
      status: "unset",
      email: null,
      role: null,
      lastSeenAt: null,
      attention: null,
      canConfigure: true
    });
    expect(byStore.kyoto).toMatchObject({
      status: "pending",
      email: "kyoto@example.com",
      role: "staff",
      attention: null,
      canConfigure: true
    });
    expect(byStore.osaka).toMatchObject({
      status: "active",
      email: "osaka@example.com",
      role: "owner",
      lastSeenAt: "2026-06-01T09:00:00.000Z",
      attention: null,
      canConfigure: true
    });
    expect(byStore.nagoya).toMatchObject({
      status: "disabled",
      email: "nagoya@example.com",
      role: "staff",
      attention: null,
      canConfigure: true
    });
    // store names carried through
    expect(byStore.osaka.storeName).toBe("ExampleStore B");
  });

  it("groups candidates per store with no cross-store bleed and correct within-store ordering (bulk query)", async () => {
    const db = createMigratedSqliteD1();
    // osaka: an active sentinel (newer) + a disabled sentinel history row (older).
    insertStaffMember(db, { id: "staff_login_osaka", storeId: "osaka" });
    insertAdminUser(db, {
      id: "au_osaka_old",
      email: "osaka-old@example.com",
      accessSubject: "real-osaka-old",
      role: "staff",
      active: 0,
      staffMemberId: "staff_login_osaka",
      updatedAt: "2026-05-01T00:00:00.000Z"
    });
    insertAdminUser(db, {
      id: "au_osaka_now",
      email: "osaka-now@example.com",
      accessSubject: "pending:osaka",
      role: "owner",
      active: 1,
      staffMemberId: "staff_login_osaka",
      updatedAt: "2026-06-01T00:00:00.000Z"
    });
    // kyoto: disabled-only sentinel history with TWO rows — the NEWEST must surface.
    insertStaffMember(db, { id: "staff_login_kyoto", storeId: "kyoto" });
    insertAdminUser(db, {
      id: "au_kyoto_older",
      email: "kyoto-older@example.com",
      accessSubject: "real-kyoto-older",
      role: "staff",
      active: 0,
      staffMemberId: "staff_login_kyoto",
      updatedAt: "2026-04-01T00:00:00.000Z"
    });
    insertAdminUser(db, {
      id: "au_kyoto_newer",
      email: "kyoto-newer@example.com",
      accessSubject: "real-kyoto-newer",
      role: "owner",
      active: 0,
      staffMemberId: "staff_login_kyoto",
      updatedAt: "2026-05-20T00:00:00.000Z"
    });

    const views = await listStoreLogins(asD1(db));
    const byStore = Object.fromEntries(views.map((v) => [v.storeId, v]));

    // osaka resolves from ITS OWN active sentinel (kyoto's rows must not leak in).
    expect(byStore.osaka).toMatchObject({
      status: "pending",
      email: "osaka-now@example.com",
      role: "owner"
    });
    // kyoto is disabled and surfaces its NEWEST disabled row (within-group ordering).
    expect(byStore.kyoto).toMatchObject({
      status: "disabled",
      email: "kyoto-newer@example.com",
      role: "owner"
    });
  });
});

describe("upsertStoreLogin", () => {
  it("creates a fresh pending login + staff_login_<store> + audit row (none case)", async () => {
    const db = createMigratedSqliteD1();
    insertAdminUserHelper(db, { id: OWNER.id, email: OWNER.email, accessSubject: OWNER.id, role: OWNER.role });
    const request = parseStoreLoginUpsertRequest({
      storeId: "osaka",
      email: "umeda@example.com",
      role: "staff",
      idempotencyKey: "key-create"
    })!;

    const result = await upsertStoreLogin({ db: asD1(db), admin: OWNER, request, now: NOW });
    expect(result).toEqual({ ok: true, storeId: "osaka", replayed: false });

    // staff_login_osaka created
    const staff = db.sqlite
      .prepare(`SELECT id, store_id, role, active FROM staff_members WHERE id = ?`)
      .get("staff_login_osaka") as { id: string; store_id: string; role: string; active: number } | undefined;
    expect(staff).toMatchObject({ store_id: "osaka", role: "staff", active: 1 });

    // admin_users row pending
    const row = db.sqlite
      .prepare(
        `SELECT email, access_subject, role, active, staff_member_id FROM admin_users WHERE staff_member_id = ?`
      )
      .get("staff_login_osaka") as
      | { email: string; access_subject: string; role: string; active: number; staff_member_id: string }
      | undefined;
    expect(row?.email).toBe("umeda@example.com");
    expect(row?.access_subject.startsWith("pending:")).toBe(true);
    expect(row?.role).toBe("staff");
    expect(row?.active).toBe(1);

    expect(countAuditLogs(db, "settings.store_login.upsert")).toBe(1);
  });

  it("does NOT revive a NON-sentinel legacy/personal disabled row; that email is email_in_use (Fix B: sentinel-only history)", async () => {
    const db = createMigratedSqliteD1();
    insertAdminUserHelper(db, { id: OWNER.id, email: OWNER.email, accessSubject: OWNER.id, role: OWNER.role });
    // Legacy disabled login linked to a NON-sentinel staff_member for osaka.
    // Under Fix B the store-login history is restricted to staff_login_<store>
    // rows only, so a former personal/staff login email is NOT revivable as the
    // shared store login — it must be re-registered as a fresh sentinel login.
    insertStaffMember(db, { id: "staff_legacy_osaka", storeId: "osaka" });
    insertAdminUser(db, {
      id: "au_legacy_osaka",
      email: "umeda@example.com",
      accessSubject: "pending:old",
      role: "staff",
      active: 0,
      staffMemberId: "staff_legacy_osaka"
    });

    const request = parseStoreLoginUpsertRequest({
      storeId: "osaka",
      email: "umeda@example.com",
      role: "staff",
      idempotencyKey: "key-revive-legacy"
    })!;
    const result = await upsertStoreLogin({ db: asD1(db), admin: OWNER, request, now: NOW });
    expect(result).toEqual({ ok: false, error: "email_in_use" });

    // legacy row untouched (still disabled, still under its legacy staff_member)
    const row = readAdminUser(db, "au_legacy_osaka");
    expect(row?.active).toBe(0);
    expect(row?.staff_member_id).toBe("staff_legacy_osaka");
    expect(countActiveLoginsForStore(db, "osaka")).toBe(0);
  });

  it("revives a SENTINEL disabled row (staff_login_<store>) with matching email on re-upsert (Fix B)", async () => {
    const db = createMigratedSqliteD1();
    insertAdminUserHelper(db, { id: OWNER.id, email: OWNER.email, accessSubject: OWNER.id, role: OWNER.role });
    insertStaffMember(db, { id: "staff_login_osaka", storeId: "osaka" });
    // a disabled SENTINEL store-login row (was the store login before, now revoked)
    insertAdminUser(db, {
      id: "au_sentinel_disabled",
      email: "umeda@example.com",
      accessSubject: "real-old",
      role: "staff",
      active: 0,
      staffMemberId: "staff_login_osaka"
    });

    const request = parseStoreLoginUpsertRequest({
      storeId: "osaka",
      email: "umeda@example.com",
      role: "owner",
      idempotencyKey: "key-revive-sentinel"
    })!;
    const result = await upsertStoreLogin({ db: asD1(db), admin: OWNER, request, now: NOW });
    expect(result).toEqual({ ok: true, storeId: "osaka", replayed: false });

    const row = readAdminUser(db, "au_sentinel_disabled");
    expect(row?.active).toBe(1); // revived, not a new row
    expect(row?.role).toBe("owner");
    expect(row?.staff_member_id).toBe("staff_login_osaka");
    expect(row?.access_subject.startsWith("pending:")).toBe(true);
    expect(countAdminUsers(db)).toBe(2);
    expect(countActiveLoginsForStore(db, "osaka")).toBe(1);
  });

  it("a store whose only non-active row is a legacy/personal disabled row resolves to none / unset (Fix B)", async () => {
    const db = createMigratedSqliteD1();
    insertStaffMember(db, { id: "staff_legacy_osaka", storeId: "osaka" });
    insertAdminUser(db, {
      id: "au_legacy_disabled",
      email: "former@example.com",
      accessSubject: "real-former",
      role: "staff",
      active: 0,
      staffMemberId: "staff_legacy_osaka"
    });

    const resolved = await resolveStoreLoginRow(asD1(db), "osaka");
    expect(resolved.kind).toBe("none");

    const views = await listStoreLogins(asD1(db));
    const osaka = views.find((v) => v.storeId === "osaka");
    expect(osaka).toMatchObject({ status: "unset", email: null, role: null, canConfigure: true });
  });

  it("Fix A: a single active LEGACY login (non-sentinel staff_member) can be Case C rotated to a NEW email without FK failure", async () => {
    const db = createMigratedSqliteD1();
    insertAdminUserHelper(db, { id: OWNER.id, email: OWNER.email, accessSubject: OWNER.id, role: OWNER.role });
    // Active login adopted from a legacy/ordinary staff_member (NOT the sentinel).
    insertStaffMember(db, { id: "staff_legacy_osaka", storeId: "osaka" });
    insertAdminUser(db, {
      id: "au_legacy_active",
      email: "old@example.com",
      accessSubject: "real-old",
      role: "owner",
      active: 1,
      staffMemberId: "staff_legacy_osaka"
    });

    const request = parseStoreLoginUpsertRequest({
      storeId: "osaka",
      email: "new@example.com",
      role: "staff",
      idempotencyKey: "key-legacy-rotate"
    })!;
    const result = await upsertStoreLogin({ db: asD1(db), admin: OWNER, request, now: NOW });
    // Before Fix A this failed with write_failed (staff_login_osaka never created
    // because ensureStoreLoginStaffStatement upserted only the legacy staff_member id).
    expect(result).toEqual({ ok: true, storeId: "osaka", replayed: false });

    // old legacy row retired
    expect(readAdminUser(db, "au_legacy_active")?.active).toBe(0);

    // new login lives under the sentinel and is pending+active
    const newRow = db.sqlite
      .prepare(
        `SELECT email, access_subject, active, staff_member_id FROM admin_users
         WHERE staff_member_id = 'staff_login_osaka' AND active = 1`
      )
      .get() as
      | { email: string; access_subject: string; active: number; staff_member_id: string }
      | undefined;
    expect(newRow?.email).toBe("new@example.com");
    expect(newRow?.access_subject.startsWith("pending:")).toBe(true);
    // the sentinel staff_members row now exists
    const sentinelStaff = db.sqlite
      .prepare(`SELECT id FROM staff_members WHERE id = 'staff_login_osaka'`)
      .get() as { id: string } | undefined;
    expect(sentinelStaff?.id).toBe("staff_login_osaka");
    expect(countActiveLoginsForStore(db, "osaka")).toBe(1);
  });

  it("rejects an owner self-downgrade to staff on their own store login (security advisory)", async () => {
    const db = createMigratedSqliteD1();
    insertStaffMember(db, { id: "staff_login_osaka", storeId: "osaka", role: "owner" });
    insertAdminUser(db, {
      id: "au_osaka",
      email: "umeda@example.com",
      accessSubject: "real-bound",
      role: "owner",
      staffMemberId: "staff_login_osaka"
    });
    const selfOwner: AdminUser = {
      id: "au_osaka",
      email: "umeda@example.com",
      role: "owner",
      staff_member_id: "staff_login_osaka",
      store_id: "osaka"
    };
    const request = parseStoreLoginUpsertRequest({
      storeId: "osaka",
      email: "umeda@example.com",
      role: "staff",
      idempotencyKey: "key-self-downgrade"
    })!;
    const result = await upsertStoreLogin({ db: asD1(db), admin: selfOwner, request, now: NOW });
    expect(result).toEqual({ ok: false, error: "forbidden_self_deactivation" });
    const row = readAdminUser(db, "au_osaka");
    expect(row?.role).toBe("owner"); // unchanged
    expect(row?.active).toBe(1);
  });

  it("Case B on a legacy canonical does not create an orphan staff_login_<store> row (devin PR #308)", async () => {
    const db = createMigratedSqliteD1();
    insertAdminUserHelper(db, { id: OWNER.id, email: OWNER.email, accessSubject: OWNER.id, role: OWNER.role });
    insertStaffMember(db, { id: "staff_legacy_osaka", storeId: "osaka" });
    insertAdminUser(db, {
      id: "au_legacy",
      email: "umeda@example.com",
      accessSubject: "real-bound",
      role: "staff",
      active: 1,
      staffMemberId: "staff_legacy_osaka"
    });
    // Case B: same email, role refresh on the legacy-adopted canonical.
    const req = parseStoreLoginUpsertRequest({
      storeId: "osaka",
      email: "umeda@example.com",
      role: "owner",
      idempotencyKey: "k-caseB-legacy"
    })!;
    expect(await upsertStoreLogin({ db: asD1(db), admin: OWNER, request: req, now: NOW })).toEqual({
      ok: true,
      storeId: "osaka",
      replayed: false
    });
    expect(readAdminUser(db, "au_legacy")?.role).toBe("owner"); // updated in place
    // No orphan sentinel staff_members row was created.
    const sentinel = db.sqlite
      .prepare(`SELECT id FROM staff_members WHERE id = ?`)
      .get("staff_login_osaka");
    expect(sentinel).toBeUndefined();
  });

  it("re-upserts the same email with a role change (Case B) without touching access_subject", async () => {
    const db = createMigratedSqliteD1();
    insertAdminUserHelper(db, { id: OWNER.id, email: OWNER.email, accessSubject: OWNER.id, role: OWNER.role });
    insertStaffMember(db, { id: "staff_login_osaka", storeId: "osaka" });
    insertAdminUser(db, {
      id: "au_osaka",
      email: "umeda@example.com",
      accessSubject: "real-bound-subject",
      role: "staff",
      staffMemberId: "staff_login_osaka"
    });

    const request = parseStoreLoginUpsertRequest({
      storeId: "osaka",
      email: "umeda@example.com",
      role: "owner",
      idempotencyKey: "key-roleflip"
    })!;
    const result = await upsertStoreLogin({ db: asD1(db), admin: OWNER, request, now: NOW });
    expect(result).toEqual({ ok: true, storeId: "osaka", replayed: false });

    const row = readAdminUser(db, "au_osaka");
    expect(row?.access_subject).toBe("real-bound-subject"); // UNCHANGED
    expect(row?.role).toBe("owner");
    expect(row?.active).toBe(1);
    // no new row
    expect(countAdminUsers(db)).toBe(2);
  });

  it("Case B drops the customer tab grant on a role change, and keeps it on a role-keep", async () => {
    // 顧客タブの承認 (spec 008) は admin_user_id だけで引くので、role を往復させると
    // 12 時間の承認が生き残ってコード無しで顧客タブが開く。updateAdminStaff 側と同じ
    // 掃除がこの経路にも要る。seed している staff_member_id は storeLoginStaffId("osaka")
    // そのもの = sentinel 行なので、ここが固定しているのは sentinel 分岐。DELETE は
    // canonicalRow.id を直接 bind するので legacy 分岐でも同じ動きになる。
    const grantRows = (db: SqliteD1Database) =>
      (
        db.sqlite
          .prepare(`SELECT COUNT(*) AS n FROM admin_customer_gate_challenges WHERE admin_user_id = ?`)
          .get("au_osaka") as { n: number }
      ).n;

    const seed = () => {
      const db = createMigratedSqliteD1();
      insertAdminUserHelper(db, { id: OWNER.id, email: OWNER.email, accessSubject: OWNER.id, role: OWNER.role });
      insertStaffMember(db, { id: "staff_login_osaka", storeId: "osaka" });
      insertAdminUser(db, {
        id: "au_osaka",
        email: "umeda@example.com",
        accessSubject: "real-bound-subject",
        role: "staff",
        staffMemberId: "staff_login_osaka"
      });
      grantCustomerTabGate(db, "au_osaka");
      expect(grantRows(db)).toBe(1);
      return db;
    };

    const changed = seed();
    const toOwner = parseStoreLoginUpsertRequest({
      storeId: "osaka",
      email: "umeda@example.com",
      role: "owner",
      idempotencyKey: "key-gate-changed"
    })!;
    expect(await upsertStoreLogin({ db: asD1(changed), admin: OWNER, request: toOwner, now: NOW })).toEqual({
      ok: true,
      storeId: "osaka",
      replayed: false
    });
    expect(readAdminUser(changed, "au_osaka")?.role).toBe("owner");
    expect(grantRows(changed)).toBe(0);

    const kept = seed();
    const sameRole = parseStoreLoginUpsertRequest({
      storeId: "osaka",
      email: "umeda@example.com",
      role: "staff",
      idempotencyKey: "key-gate-kept"
    })!;
    expect(await upsertStoreLogin({ db: asD1(kept), admin: OWNER, request: sameRole, now: NOW })).toEqual({
      ok: true,
      storeId: "osaka",
      replayed: false
    });
    expect(readAdminUser(kept, "au_osaka")?.role).toBe("staff");
    // 役割が変わらないなら承認を落とす理由が無い。毎回落とすとオーナーが
    // 店舗ログインを触るたびにスタッフが再申請することになる。
    expect(grantRows(kept)).toBe(1);
  });

  it("Case C drops the customer tab grant of the login it retires", async () => {
    // メール差し替え (Case C) は canonical 行をその場で無効化する。dropDisabledGrants が見るのは
    // 「呼び出し時点で既に無効な行」だけなので、この行はそこに入らない。他の経路が結果的に
    // 拾ってはいるが 3 ファイルにまたがる暗黙の分担になるため、Case C 自身で落とす。
    const db = createMigratedSqliteD1();
    insertAdminUserHelper(db, { id: OWNER.id, email: OWNER.email, accessSubject: OWNER.id, role: OWNER.role });
    try {
      insertStaffMember(db, { id: "staff_login_osaka", storeId: "osaka" });
      insertAdminUser(db, {
        id: "au_osaka",
        email: "old@example.com",
        accessSubject: "real-bound-subject",
        role: "staff",
        staffMemberId: "staff_login_osaka"
      });
      grantCustomerTabGate(db, "au_osaka");

      const rotated = parseStoreLoginUpsertRequest({
        storeId: "osaka",
        email: "new@example.com",
        role: "staff",
        idempotencyKey: "key-gate-caseC"
      })!;
      expect(await upsertStoreLogin({ db: asD1(db), admin: OWNER, request: rotated, now: NOW })).toEqual({
        ok: true,
        storeId: "osaka",
        replayed: false
      });

      expect(readAdminUser(db, "au_osaka")?.active).toBe(0);
      expect(
        db.sqlite
          .prepare(`SELECT COUNT(*) AS n FROM admin_customer_gate_challenges WHERE admin_user_id = ?`)
          .get("au_osaka")
      ).toEqual({ n: 0 });
    } finally {
      db.sqlite.close();
    }
  });

  it("rejects a staff actor (forbidden)", async () => {
    const db = createMigratedSqliteD1();
    const request = parseStoreLoginUpsertRequest({
      storeId: "osaka",
      email: "umeda@example.com",
      role: "staff",
      idempotencyKey: "key-x"
    })!;
    const result = await upsertStoreLogin({ db: asD1(db), admin: STAFF, request, now: NOW });
    expect(result).toEqual({ ok: false, error: "forbidden" });
    expect(countAdminUsers(db)).toBe(0);
  });

  it("rejects store_not_found", async () => {
    const db = createMigratedSqliteD1();
    insertAdminUserHelper(db, { id: OWNER.id, email: OWNER.email, accessSubject: OWNER.id, role: OWNER.role });
    const request = parseStoreLoginUpsertRequest({
      storeId: "ghost",
      email: "umeda@example.com",
      role: "staff",
      idempotencyKey: "key-ghost"
    })!;
    const result = await upsertStoreLogin({ db: asD1(db), admin: OWNER, request, now: NOW });
    expect(result).toEqual({ ok: false, error: "store_not_found" });
  });

  it("rejects a request role of system_admin via parse (returns null)", () => {
    const parsed = parseStoreLoginUpsertRequest({
      storeId: "osaka",
      email: "umeda@example.com",
      role: "system_admin",
      idempotencyKey: "key-sa"
    });
    expect(parsed).toBeNull();
  });

  it("blocks an unrelated other-store admin email (email_in_use), leaving that row unchanged", async () => {
    const db = createMigratedSqliteD1();
    insertAdminUserHelper(db, { id: OWNER.id, email: OWNER.email, accessSubject: OWNER.id, role: OWNER.role });
    // an unrelated admin_users row for kyoto store-login
    insertStaffMember(db, { id: "staff_login_kyoto", storeId: "kyoto" });
    insertAdminUser(db, {
      id: "au_kyoto",
      email: "shared@example.com",
      accessSubject: "real-kyoto",
      role: "owner",
      staffMemberId: "staff_login_kyoto"
    });

    const request = parseStoreLoginUpsertRequest({
      storeId: "osaka",
      email: "shared@example.com",
      role: "staff",
      idempotencyKey: "key-hijack"
    })!;
    const result = await upsertStoreLogin({ db: asD1(db), admin: OWNER, request, now: NOW });
    expect(result).toEqual({ ok: false, error: "email_in_use" });

    const untouched = readAdminUser(db, "au_kyoto");
    expect(untouched?.access_subject).toBe("real-kyoto");
    expect(untouched?.role).toBe("owner");
    // no osaka row created
    expect(countActiveLoginsForStore(db, "osaka")).toBe(0);
  });

  it("blocks a system_admin's email (email_in_use)", async () => {
    const db = createMigratedSqliteD1();
    insertAdminUserHelper(db, { id: OWNER.id, email: OWNER.email, accessSubject: OWNER.id, role: OWNER.role });
    insertAdminUser(db, {
      id: "au_sa",
      email: "sa@example.com",
      accessSubject: "real-sa",
      role: "system_admin",
      staffMemberId: null
    });

    const request = parseStoreLoginUpsertRequest({
      storeId: "osaka",
      email: "sa@example.com",
      role: "owner",
      idempotencyKey: "key-sa-hijack"
    })!;
    const result = await upsertStoreLogin({ db: asD1(db), admin: OWNER, request, now: NOW });
    expect(result).toEqual({ ok: false, error: "email_in_use" });

    const untouched = readAdminUser(db, "au_sa");
    expect(untouched?.role).toBe("system_admin");
    expect(untouched?.access_subject).toBe("real-sa");
  });

  it("blocks an admin row with NULL staff_member_id (owner-gmail) email (email_in_use)", async () => {
    const db = createMigratedSqliteD1();
    insertAdminUserHelper(db, { id: OWNER.id, email: OWNER.email, accessSubject: OWNER.id, role: OWNER.role });
    insertAdminUser(db, {
      id: "au_owner_gmail",
      email: "owner-gmail@example.com",
      accessSubject: "real-owner",
      role: "owner",
      staffMemberId: null
    });

    const request = parseStoreLoginUpsertRequest({
      storeId: "osaka",
      email: "owner-gmail@example.com",
      role: "owner",
      idempotencyKey: "key-owner-hijack"
    })!;
    const result = await upsertStoreLogin({ db: asD1(db), admin: OWNER, request, now: NOW });
    expect(result).toEqual({ ok: false, error: "email_in_use" });

    const untouched = readAdminUser(db, "au_owner_gmail");
    expect(untouched?.access_subject).toBe("real-owner");
  });

  it("Case C: re-setting an active login to a NEW email retires the old row and creates a pending new row", async () => {
    const db = createMigratedSqliteD1();
    insertAdminUserHelper(db, { id: OWNER.id, email: OWNER.email, accessSubject: OWNER.id, role: OWNER.role });
    insertStaffMember(db, { id: "staff_login_osaka", storeId: "osaka" });
    insertAdminUser(db, {
      id: "au_old",
      email: "old@example.com",
      accessSubject: "real-old-subject",
      role: "owner",
      staffMemberId: "staff_login_osaka"
    });

    const request = parseStoreLoginUpsertRequest({
      storeId: "osaka",
      email: "new@example.com",
      role: "staff",
      idempotencyKey: "key-rotate"
    })!;
    const result = await upsertStoreLogin({ db: asD1(db), admin: OWNER, request, now: NOW });
    expect(result).toEqual({ ok: true, storeId: "osaka", replayed: false });

    // old row retired
    const oldRow = readAdminUser(db, "au_old");
    expect(oldRow?.active).toBe(0);

    // old email + its old sub can no longer authenticate (it's deactivated)
    const oldAuth = await resolveHumanAdmin(
      asD1(db),
      { email: "old@example.com", sub: "real-old-subject" },
      "2026-06-03T13:00:00.000Z"
    );
    expect(oldAuth).toEqual({ ok: false, reason: "admin_not_registered" });

    // new row pending + active
    const newRow = db.sqlite
      .prepare(
        `SELECT email, access_subject, active FROM admin_users
         WHERE staff_member_id = ? AND active = 1`
      )
      .get("staff_login_osaka") as { email: string; access_subject: string; active: number } | undefined;
    expect(newRow?.email).toBe("new@example.com");
    expect(newRow?.access_subject.startsWith("pending:")).toBe(true);
  });

  it("after Case C, the store has at most one active login row", async () => {
    const db = createMigratedSqliteD1();
    insertAdminUserHelper(db, { id: OWNER.id, email: OWNER.email, accessSubject: OWNER.id, role: OWNER.role });
    insertStaffMember(db, { id: "staff_login_osaka", storeId: "osaka" });
    insertAdminUser(db, {
      id: "au_old",
      email: "old@example.com",
      accessSubject: "real-old-subject",
      role: "owner",
      staffMemberId: "staff_login_osaka"
    });

    const request = parseStoreLoginUpsertRequest({
      storeId: "osaka",
      email: "new@example.com",
      role: "staff",
      idempotencyKey: "key-rotate-2"
    })!;
    await upsertStoreLogin({ db: asD1(db), admin: OWNER, request, now: NOW });

    expect(countActiveLoginsForStore(db, "osaka")).toBe(1);
  });

  it("B2: Case C is blocked when the acting admin IS the canonical login (self-lockout guard)", async () => {
    const db = createMigratedSqliteD1();
    insertStaffMember(db, { id: "staff_login_osaka", storeId: "osaka" });
    insertAdminUser(db, {
      id: "au_self",
      email: "self@example.com",
      accessSubject: "real-self",
      role: "owner",
      staffMemberId: "staff_login_osaka"
    });

    // The actor is the very store login they are about to rotate away from.
    const selfActor: AdminUser = {
      id: "au_self",
      email: "self@example.com",
      role: "owner",
      staff_member_id: "staff_login_osaka",
      store_id: "osaka"
    };
    const request = parseStoreLoginUpsertRequest({
      storeId: "osaka",
      email: "new@example.com",
      role: "owner",
      idempotencyKey: "key-self-rotate"
    })!;
    const result = await upsertStoreLogin({ db: asD1(db), admin: selfActor, request, now: NOW });
    expect(result).toEqual({ ok: false, error: "forbidden_self_deactivation" });

    // canonical row stays active + email unchanged; no new row created
    const row = readAdminUser(db, "au_self");
    expect(row?.active).toBe(1);
    expect(row?.email).toBe("self@example.com");
    expect(countAdminUsers(db)).toBe(1);
    // no idempotency side effects that would block a corrected retry
  });

  it("B2: a DIFFERENT admin can still rotate the email (Case C) when not self-locking", async () => {
    const db = createMigratedSqliteD1();
    insertAdminUserHelper(db, { id: OWNER.id, email: OWNER.email, accessSubject: OWNER.id, role: OWNER.role });
    insertStaffMember(db, { id: "staff_login_osaka", storeId: "osaka" });
    insertAdminUser(db, {
      id: "au_login",
      email: "login@example.com",
      accessSubject: "real-login",
      role: "owner",
      staffMemberId: "staff_login_osaka"
    });

    // OWNER actor is NOT the store login (staff_member_id null), so rotation is fine.
    const request = parseStoreLoginUpsertRequest({
      storeId: "osaka",
      email: "rotated@example.com",
      role: "staff",
      idempotencyKey: "key-diff-rotate"
    })!;
    const result = await upsertStoreLogin({ db: asD1(db), admin: OWNER, request, now: NOW });
    expect(result).toEqual({ ok: true, storeId: "osaka", replayed: false });

    expect(readAdminUser(db, "au_login")?.active).toBe(0);
    expect(countActiveLoginsForStore(db, "osaka")).toBe(1);
  });

  it("rejects a stale owner snapshot after the acting login was demoted", async () => {
    const db = createMigratedSqliteD1();
    insertStaffMember(db, { id: "staff_login_osaka", storeId: "osaka" });
    insertAdminUser(db, {
      id: "au_self",
      email: "self@example.com",
      accessSubject: "real-self",
      role: "staff",
      staffMemberId: "staff_login_osaka"
    });
    const selfActor: AdminUser = {
      id: "au_self",
      email: "self@example.com",
      role: "owner",
      staff_member_id: "staff_login_osaka",
      store_id: "osaka"
    };
    const request = parseStoreLoginUpsertRequest({
      storeId: "osaka",
      email: "self@example.com",
      role: "owner",
      idempotencyKey: "key-self-roleflip"
    })!;
    const result = await upsertStoreLogin({ db: asD1(db), admin: selfActor, request, now: NOW });
    expect(result).toEqual({ ok: false, error: "forbidden" });
    expect(countAuditLogs(db, "settings.store_login.upsert")).toBe(0);
    const row = readAdminUser(db, "au_self");
    expect(row?.active).toBe(1);
    expect(row?.access_subject).toBe("real-self"); // Case B keeps the bound subject
    expect(row?.role).toBe("staff");
  });

  it("replays an identical idempotencyKey + payload without creating a duplicate row", async () => {
    const db = createMigratedSqliteD1();
    insertAdminUserHelper(db, { id: OWNER.id, email: OWNER.email, accessSubject: OWNER.id, role: OWNER.role });
    const body = {
      storeId: "osaka",
      email: "umeda@example.com",
      role: "staff" as const,
      idempotencyKey: "key-replay"
    };
    // This is the only test that exercises the idempotency *read* path
    // (the replay). fetchAdminActionIdempotency filters out expired rows with
    // SQLite `datetime('now')`, which reads the real OS clock and cannot be
    // faked. With the fixed historical `NOW`, the inserted expires_at
    // (NOW + 24h IDEMPOTENCY_TTL_MS) drifts into the past once wall-clock time
    // passes it, making the replay row look expired → the second call would
    // re-insert and fail. So this test must stamp expires_at from the real
    // clock (omit `now`, defaulting to Date.now) so the row is genuinely
    // unexpired when the read happens. The other tests pass the fixed NOW
    // because they never read back an idempotency row through the TTL filter.
    const first = await upsertStoreLogin({
      db: asD1(db),
      admin: OWNER,
      request: parseStoreLoginUpsertRequest(body)!
    });
    expect(first).toEqual({ ok: true, storeId: "osaka", replayed: false });
    const before = countAdminUsers(db);

    const second = await upsertStoreLogin({
      db: asD1(db),
      admin: OWNER,
      request: parseStoreLoginUpsertRequest(body)!
    });
    expect(second).toEqual({ ok: true, storeId: "osaka", replayed: true });
    expect(countAdminUsers(db)).toBe(before);
  });

  it("Case C revives a same-store disabled email when rotating away from the active one", async () => {
    const db = createMigratedSqliteD1();
    insertAdminUserHelper(db, { id: OWNER.id, email: OWNER.email, accessSubject: OWNER.id, role: OWNER.role });
    insertStaffMember(db, { id: "staff_login_osaka", storeId: "osaka" });
    // current active login
    insertAdminUser(db, {
      id: "au_active",
      email: "current@example.com",
      accessSubject: "real-current",
      role: "owner",
      active: 1,
      staffMemberId: "staff_login_osaka",
      updatedAt: "2026-06-01T00:00:00.000Z"
    });
    // a previously-disabled login of the SAME store carrying the email we rotate to
    insertAdminUser(db, {
      id: "au_disabled",
      email: "former@example.com",
      accessSubject: "real-former",
      role: "staff",
      active: 0,
      staffMemberId: "staff_login_osaka",
      updatedAt: "2026-05-01T00:00:00.000Z"
    });

    const request = parseStoreLoginUpsertRequest({
      storeId: "osaka",
      email: "former@example.com",
      role: "owner",
      idempotencyKey: "key-rotate-revive"
    })!;
    const result = await upsertStoreLogin({ db: asD1(db), admin: OWNER, request, now: NOW });
    expect(result).toEqual({ ok: true, storeId: "osaka", replayed: false });

    // old active row retired
    expect(readAdminUser(db, "au_active")?.active).toBe(0);
    // formerly-disabled row revived as pending+active with new role
    const revived = readAdminUser(db, "au_disabled");
    expect(revived?.active).toBe(1);
    expect(revived?.role).toBe("owner");
    expect(revived?.access_subject.startsWith("pending:")).toBe(true);
    // no new row was inserted (revival, not insert)
    expect(countAdminUsers(db)).toBe(3);
    // exactly one active login remains
    expect(countActiveLoginsForStore(db, "osaka")).toBe(1);
  });

  it("revives a previously-disabled email of the SAME store rather than email_in_use", async () => {
    const db = createMigratedSqliteD1();
    insertAdminUserHelper(db, { id: OWNER.id, email: OWNER.email, accessSubject: OWNER.id, role: OWNER.role });
    insertStaffMember(db, { id: "staff_login_osaka", storeId: "osaka" });
    // a disabled historical login for this same store-login
    insertAdminUser(db, {
      id: "au_disabled",
      email: "revive@example.com",
      accessSubject: "real-old",
      role: "staff",
      active: 0,
      staffMemberId: "staff_login_osaka"
    });

    const request = parseStoreLoginUpsertRequest({
      storeId: "osaka",
      email: "revive@example.com",
      role: "owner",
      idempotencyKey: "key-revive"
    })!;
    const result = await upsertStoreLogin({ db: asD1(db), admin: OWNER, request, now: NOW });
    expect(result).toEqual({ ok: true, storeId: "osaka", replayed: false });

    const revived = readAdminUser(db, "au_disabled");
    expect(revived?.active).toBe(1);
    expect(revived?.role).toBe("owner");
    expect(revived?.access_subject.startsWith("pending:")).toBe(true);
    // no extra row created
    expect(countAdminUsers(db)).toBe(2);
  });
});

describe("resolveStoreLoginRow", () => {
  it("picks the active row when an active + historical disabled rows share the staff_login_<store>", async () => {
    const db = createMigratedSqliteD1();
    insertStaffMember(db, { id: "staff_login_osaka", storeId: "osaka" });
    insertAdminUser(db, {
      id: "au_disabled_hist",
      email: "history@example.com",
      accessSubject: "real-history",
      role: "staff",
      active: 0,
      staffMemberId: "staff_login_osaka",
      updatedAt: "2026-05-01T00:00:00.000Z"
    });
    insertAdminUser(db, {
      id: "au_active",
      email: "current@example.com",
      accessSubject: "pending:live",
      role: "owner",
      active: 1,
      staffMemberId: "staff_login_osaka",
      updatedAt: "2026-06-01T00:00:00.000Z"
    });

    const resolved = await resolveStoreLoginRow(asD1(db), "osaka");
    expect(resolved.kind).toBe("canonical");
    if (resolved.kind === "canonical") {
      expect(resolved.row.id).toBe("au_active");
    }

    const views = await listStoreLogins(asD1(db));
    const osaka = views.find((v) => v.storeId === "osaka");
    expect(osaka?.status).toBe("pending");
    expect(osaka?.email).toBe("current@example.com");
  });

  it("B3 unified set: staff_login_<store> active + a legacy active human under a different staff_member -> ambiguous", async () => {
    const db = createMigratedSqliteD1();
    // The store-login sentinel row (one active store login)...
    insertStaffMember(db, { id: "staff_login_osaka", storeId: "osaka" });
    insertAdminUser(db, {
      id: "au_sentinel",
      email: "sentinel@example.com",
      accessSubject: "real-sentinel",
      role: "owner",
      active: 1,
      staffMemberId: "staff_login_osaka"
    });
    // ...PLUS an unrelated active human admin linked to the SAME store via a
    // different staff_member. The old sentinel-first resolver would have hidden
    // this and wrongly reported a single canonical login.
    insertStaffMember(db, { id: "sm_legacy", storeId: "osaka", displayName: "レガシー" });
    insertAdminUser(db, {
      id: "au_legacy",
      email: "legacy@example.com",
      accessSubject: "real-legacy",
      role: "staff",
      active: 1,
      staffMemberId: "sm_legacy"
    });

    const resolved = await resolveStoreLoginRow(asD1(db), "osaka");
    expect(resolved.kind).toBe("ambiguous");

    const views = await listStoreLogins(asD1(db));
    const osaka = views.find((v) => v.storeId === "osaka");
    expect(osaka).toMatchObject({ attention: "ambiguous_login", canConfigure: false });
  });

  it("B3 unified set: staff_login_<store> active + a legacy system_admin -> ambiguous (never silently excluded)", async () => {
    const db = createMigratedSqliteD1();
    insertAdminUserHelper(db, { id: OWNER.id, email: OWNER.email, accessSubject: OWNER.id, role: OWNER.role });
    insertStaffMember(db, { id: "staff_login_osaka", storeId: "osaka" });
    insertAdminUser(db, {
      id: "au_sentinel",
      email: "sentinel@example.com",
      accessSubject: "real-sentinel",
      role: "owner",
      active: 1,
      staffMemberId: "staff_login_osaka"
    });
    // a system_admin linked to the same store via an ordinary staff_member
    insertStaffMember(db, { id: "sm_sa", storeId: "osaka", displayName: "SA", role: "system_admin" });
    insertAdminUser(db, {
      id: "au_sa_legacy",
      email: "sa-legacy@example.com",
      accessSubject: "real-sa-legacy",
      role: "system_admin",
      active: 1,
      staffMemberId: "sm_sa"
    });

    const resolved = await resolveStoreLoginRow(asD1(db), "osaka");
    expect(resolved.kind).toBe("ambiguous");

    // upsert + revoke both fail-closed
    const upsertReq = parseStoreLoginUpsertRequest({
      storeId: "osaka",
      email: "new@example.com",
      role: "owner",
      idempotencyKey: "key-b3-sa"
    })!;
    expect(
      await upsertStoreLogin({ db: asD1(db), admin: OWNER, request: upsertReq, now: NOW })
    ).toEqual({ ok: false, error: "invalid_request" });
    expect(
      await revokeStoreLogin({ db: asD1(db), admin: OWNER, storeId: "osaka", now: NOW })
    ).toEqual({ ok: false, error: "invalid_request" });

    // system_admin row untouched
    const sa = readAdminUser(db, "au_sa_legacy");
    expect(sa?.role).toBe("system_admin");
    expect(sa?.active).toBe(1);
  });

  it("fail-closed ambiguous: legacy fallback with TWO active human admins for a store blocks upsert/revoke and surfaces attention", async () => {
    const db = createMigratedSqliteD1();
    insertAdminUserHelper(db, { id: OWNER.id, email: OWNER.email, accessSubject: OWNER.id, role: OWNER.role });
    // No staff_login_osaka. Two ordinary staff_members under osaka, each linked.
    insertStaffMember(db, { id: "sm_a", storeId: "osaka", displayName: "A" });
    insertStaffMember(db, { id: "sm_b", storeId: "osaka", displayName: "B" });
    insertAdminUser(db, {
      id: "au_a",
      email: "a@example.com",
      accessSubject: "real-a",
      role: "owner",
      staffMemberId: "sm_a"
    });
    insertAdminUser(db, {
      id: "au_b",
      email: "b@example.com",
      accessSubject: "real-b",
      role: "staff",
      staffMemberId: "sm_b"
    });

    const resolved = await resolveStoreLoginRow(asD1(db), "osaka");
    expect(resolved.kind).toBe("ambiguous");

    const upsertReq = parseStoreLoginUpsertRequest({
      storeId: "osaka",
      email: "c@example.com",
      role: "staff",
      idempotencyKey: "key-amb"
    })!;
    const upsertResult = await upsertStoreLogin({
      db: asD1(db),
      admin: OWNER,
      request: upsertReq,
      now: NOW
    });
    expect(upsertResult).toEqual({ ok: false, error: "invalid_request" });

    const revokeResult = await revokeStoreLogin({ db: asD1(db), admin: OWNER, storeId: "osaka", now: NOW });
    expect(revokeResult).toEqual({ ok: false, error: "invalid_request" });

    const views = await listStoreLogins(asD1(db));
    const osaka = views.find((v) => v.storeId === "osaka");
    expect(osaka).toMatchObject({
      status: "disabled",
      email: null,
      role: null,
      attention: "ambiguous_login",
      canConfigure: false
    });
  });

  it("fail-closed ambiguous: a system_admin mixed into a store's set is never touchable", async () => {
    const db = createMigratedSqliteD1();
    insertAdminUserHelper(db, { id: OWNER.id, email: OWNER.email, accessSubject: OWNER.id, role: OWNER.role });
    insertStaffMember(db, { id: "staff_login_osaka", storeId: "osaka" });
    // a system_admin linked under the store-login sentinel
    insertAdminUser(db, {
      id: "au_sa_store",
      email: "sa-store@example.com",
      accessSubject: "real-sa-store",
      role: "system_admin",
      staffMemberId: "staff_login_osaka"
    });

    const resolved = await resolveStoreLoginRow(asD1(db), "osaka");
    expect(resolved.kind).toBe("ambiguous");

    const upsertReq = parseStoreLoginUpsertRequest({
      storeId: "osaka",
      email: "new@example.com",
      role: "owner",
      idempotencyKey: "key-sa-mix"
    })!;
    expect(
      await upsertStoreLogin({ db: asD1(db), admin: OWNER, request: upsertReq, now: NOW })
    ).toEqual({ ok: false, error: "invalid_request" });

    expect(
      await revokeStoreLogin({ db: asD1(db), admin: OWNER, storeId: "osaka", now: NOW })
    ).toEqual({ ok: false, error: "invalid_request" });

    const views = await listStoreLogins(asD1(db));
    const osaka = views.find((v) => v.storeId === "osaka");
    expect(osaka?.attention).toBe("ambiguous_login");
    expect(osaka?.canConfigure).toBe(false);

    // system_admin row untouched
    const untouched = readAdminUser(db, "au_sa_store");
    expect(untouched?.role).toBe("system_admin");
    expect(untouched?.active).toBe(1);
  });

  it("does NOT adopt a legacy/personal active login when sentinel history exists -> ambiguous (codex PR #308)", async () => {
    const db = createMigratedSqliteD1();
    insertAdminUserHelper(db, { id: OWNER.id, email: OWNER.email, accessSubject: OWNER.id, role: OWNER.role });
    // Disabled sentinel store-login history.
    insertStaffMember(db, { id: "staff_login_osaka", storeId: "osaka" });
    insertAdminUser(db, {
      id: "au_sentinel_old",
      email: "umeda@example.com",
      accessSubject: "pending:old",
      role: "staff",
      active: 0,
      staffMemberId: "staff_login_osaka"
    });
    // A stray ACTIVE legacy/personal admin linked to the store via an ordinary staff_member.
    insertStaffMember(db, { id: "staff_legacy_osaka", storeId: "osaka" });
    insertAdminUser(db, {
      id: "au_legacy_active",
      email: "personal@example.com",
      accessSubject: "real-personal",
      role: "owner",
      active: 1,
      staffMemberId: "staff_legacy_osaka"
    });

    const resolved = await resolveStoreLoginRow(asD1(db), "osaka");
    expect(resolved.kind).toBe("ambiguous");

    // upsert + revoke fail closed (never revoke/rotate the stray personal admin).
    const req = parseStoreLoginUpsertRequest({
      storeId: "osaka",
      email: "new@example.com",
      role: "staff",
      idempotencyKey: "k-mixed"
    })!;
    expect(await upsertStoreLogin({ db: asD1(db), admin: OWNER, request: req, now: NOW })).toEqual({
      ok: false,
      error: "invalid_request"
    });
    expect(await revokeStoreLogin({ db: asD1(db), admin: OWNER, storeId: "osaka", now: NOW })).toEqual({
      ok: false,
      error: "invalid_request"
    });
    // the personal admin row is untouched
    const personal = readAdminUser(db, "au_legacy_active");
    expect(personal?.active).toBe(1);

    const views = await listStoreLogins(asD1(db));
    const osaka = views.find((v) => v.storeId === "osaka");
    expect(osaka?.attention).toBe("ambiguous_login");
    expect(osaka?.canConfigure).toBe(false);
  });
});

describe("revokeStoreLogin", () => {
  it("deactivates the canonical login and the store then shows disabled", async () => {
    const db = createMigratedSqliteD1();
    insertAdminUserHelper(db, { id: OWNER.id, email: OWNER.email, accessSubject: OWNER.id, role: OWNER.role });
    insertStaffMember(db, { id: "staff_login_osaka", storeId: "osaka" });
    insertAdminUser(db, {
      id: "au_osaka",
      email: "umeda@example.com",
      accessSubject: "real-osaka",
      role: "owner",
      staffMemberId: "staff_login_osaka"
    });

    const result = await revokeStoreLogin({ db: asD1(db), admin: OWNER, storeId: "osaka", now: NOW });
    expect(result).toEqual({ ok: true, storeId: "osaka" });

    const row = readAdminUser(db, "au_osaka");
    expect(row?.active).toBe(0);
    expect(countAuditLogs(db, "settings.store_login.revoke")).toBe(1);

    const views = await listStoreLogins(asD1(db));
    const osaka = views.find((v) => v.storeId === "osaka");
    expect(osaka?.status).toBe("disabled");
    expect(osaka?.email).toBe("umeda@example.com");
  });

  it("returns not_found when there is no active login", async () => {
    const db = createMigratedSqliteD1();
    insertAdminUserHelper(db, { id: OWNER.id, email: OWNER.email, accessSubject: OWNER.id, role: OWNER.role });
    const result = await revokeStoreLogin({ db: asD1(db), admin: OWNER, storeId: "osaka", now: NOW });
    expect(result).toEqual({ ok: false, error: "not_found" });
  });

  it("blocks self-deactivation (actor's staff_member_id === canonical staff_member_id)", async () => {
    const db = createMigratedSqliteD1();
    insertStaffMember(db, { id: "staff_login_osaka", storeId: "osaka" });
    insertAdminUser(db, {
      id: "au_osaka",
      email: "umeda@example.com",
      accessSubject: "real-osaka",
      role: "owner",
      staffMemberId: "staff_login_osaka"
    });

    const selfActor: AdminUser = {
      id: "au_osaka",
      email: "umeda@example.com",
      role: "owner",
      staff_member_id: "staff_login_osaka",
      store_id: "osaka"
    };
    const result = await revokeStoreLogin({ db: asD1(db), admin: selfActor, storeId: "osaka", now: NOW });
    expect(result).toEqual({ ok: false, error: "forbidden_self_deactivation" });

    // not deactivated
    expect(readAdminUser(db, "au_osaka")?.active).toBe(1);
  });

  it("rejects a staff actor (forbidden)", async () => {
    const db = createMigratedSqliteD1();
    insertStaffMember(db, { id: "staff_login_osaka", storeId: "osaka" });
    insertAdminUser(db, {
      id: "au_osaka",
      email: "umeda@example.com",
      accessSubject: "real-osaka",
      role: "owner",
      staffMemberId: "staff_login_osaka"
    });
    const result = await revokeStoreLogin({ db: asD1(db), admin: STAFF, storeId: "osaka", now: NOW });
    expect(result).toEqual({ ok: false, error: "forbidden" });
    expect(readAdminUser(db, "au_osaka")?.active).toBe(1);
  });

  it("allows a system_admin actor to revoke", async () => {
    const db = createMigratedSqliteD1();
    insertAdminUserHelper(db, { id: SYSTEM_ADMIN.id, email: SYSTEM_ADMIN.email, accessSubject: SYSTEM_ADMIN.id, role: SYSTEM_ADMIN.role });
    insertStaffMember(db, { id: "staff_login_osaka", storeId: "osaka" });
    insertAdminUser(db, {
      id: "au_osaka",
      email: "umeda@example.com",
      accessSubject: "real-osaka",
      role: "owner",
      staffMemberId: "staff_login_osaka"
    });
    const result = await revokeStoreLogin({ db: asD1(db), admin: SYSTEM_ADMIN, storeId: "osaka", now: NOW });
    expect(result).toEqual({ ok: true, storeId: "osaka" });
    expect(readAdminUser(db, "au_osaka")?.active).toBe(0);
  });
});

describe("B1: active store-login partial unique index (migration 0031)", () => {
  const rawInsert = (
    db: SqliteD1Database,
    options: { id: string; email: string; accessSubject: string; active: 0 | 1; staffMemberId: string }
  ) =>
    db.sqlite
      .prepare(
        `INSERT INTO admin_users
          (id, staff_member_id, email, access_subject, role, active, is_service_token, updated_at)
         VALUES (?, ?, ?, ?, 'owner', ?, 0, '2026-05-16T00:00:00.000Z')`
      )
      .run(
        options.id,
        options.staffMemberId,
        options.email,
        options.accessSubject,
        options.active
      );

  it("creates idx_admin_users_active_store_login as a UNIQUE partial index", () => {
    const db = createMigratedSqliteD1();
    const indexes = db.sqlite.prepare(`PRAGMA index_list(admin_users)`).all() as Array<{
      name: string;
      unique: number;
      partial: number;
    }>;
    const idx = indexes.find((i) => i.name === "idx_admin_users_active_store_login");
    expect(idx).toBeDefined();
    expect(idx?.unique).toBe(1);
    expect(idx?.partial).toBe(1);
  });

  it("rejects a SECOND active store-login row under the same staff_login_<store>", () => {
    const db = createMigratedSqliteD1();
    insertStaffMember(db, { id: "staff_login_osaka", storeId: "osaka" });
    rawInsert(db, {
      id: "au_first",
      email: "first@example.com",
      accessSubject: "pending:1",
      active: 1,
      staffMemberId: "staff_login_osaka"
    });
    // a concurrent insert of a second ACTIVE row under the same sentinel must fail
    expect(() =>
      rawInsert(db, {
        id: "au_second",
        email: "second@example.com",
        accessSubject: "pending:2",
        active: 1,
        staffMemberId: "staff_login_osaka"
      })
    ).toThrow();
  });

  it("allows multiple DISABLED rows under the same staff_login_<store> (history)", () => {
    const db = createMigratedSqliteD1();
    insertStaffMember(db, { id: "staff_login_osaka", storeId: "osaka" });
    rawInsert(db, {
      id: "au_d1",
      email: "d1@example.com",
      accessSubject: "real-d1",
      active: 0,
      staffMemberId: "staff_login_osaka"
    });
    expect(() =>
      rawInsert(db, {
        id: "au_d2",
        email: "d2@example.com",
        accessSubject: "real-d2",
        active: 0,
        staffMemberId: "staff_login_osaka"
      })
    ).not.toThrow();
    // an active row alongside the disabled ones is still allowed (single active)
    expect(() =>
      rawInsert(db, {
        id: "au_a",
        email: "a@example.com",
        accessSubject: "pending:a",
        active: 1,
        staffMemberId: "staff_login_osaka"
      })
    ).not.toThrow();
  });

  it("does NOT constrain legacy / non-sentinel staff_member_id rows", () => {
    const db = createMigratedSqliteD1();
    insertStaffMember(db, { id: "sm_legacy", storeId: "osaka" });
    rawInsert(db, {
      id: "au_l1",
      email: "l1@example.com",
      accessSubject: "real-l1",
      active: 1,
      staffMemberId: "sm_legacy"
    });
    // two active rows under a non-staff_login_ staff_member are out of scope
    expect(() =>
      rawInsert(db, {
        id: "au_l2",
        email: "l2@example.com",
        accessSubject: "real-l2",
        active: 1,
        staffMemberId: "sm_legacy"
      })
    ).not.toThrow();
  });
});
