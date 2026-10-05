import { describe, expect, it } from "vitest";

import type { AdminUser } from "../src/admin/access";
import {
  commitAdminRecurring,
  parseAdminRecurringCommitRequest,
  type AdminRecurringCommitRequest
} from "../src/admin/recurring-commit";
import { createAdminExternalBlock } from "../src/admin/external-blocks";
import { createMigratedSqliteD1 as createBaseD1, type SqliteD1Database } from "./helpers/sqlite-d1";

const OWNER_ADMIN: AdminUser = {
  id: "admin_owner_1",
  email: "owner@example.com",
  role: "owner",
  staff_member_id: null,
store_id: null
};

const STAFF_ADMIN: AdminUser = {
  id: "admin_staff_1",
  email: "staff@example.com",
  role: "staff",
  staff_member_id: null,
store_id: null
};

const SYSTEM_ADMIN: AdminUser = {
  id: "admin_system_1",
  email: "admin@example.com",
  role: "system_admin",
  staff_member_id: null,
store_id: null
};

// `kyoto` + `resource_kyoto_calendar` are seeded by seeds/dev.sql which the
// migrated helper loads after the schema migrations.
const STORE_ID = "kyoto";
const RESOURCE_ID = "resource_kyoto_calendar";

// Anchor every test to a deterministic "now" so the past-occurrence guard in
// createAdminExternalBlock is predictable. The seeded dtstart sits two weeks
// in the future and a weekly RRULE with COUNT=4 yields four occurrences
// strictly past `now` so the happy path can create all four.
const NOW_MS = Date.UTC(2099, 5, 1, 0, 0, 0); // 2099-06-01T00:00:00Z
const DTSTART_ISO = "2099-06-15T01:00:00.000Z"; // future, 5-min aligned
const WINDOW_END_ISO = "2099-07-31T00:00:00.000Z";

const BASE_REQUEST: AdminRecurringCommitRequest = {
  idempotencyKey: "recurring-commit-1",
  storeId: STORE_ID,
  resourceId: RESOURCE_ID,
  rrule: "RRULE:FREQ=WEEKLY;COUNT=4",
  dtstart: DTSTART_ISO,
  windowEnd: WINDOW_END_ISO,
  durationMinutes: 60,
  title: "週次定休"
};

const runCommit = (
  db: SqliteD1Database,
  admin: AdminUser,
  request: AdminRecurringCommitRequest,
  nowMs = NOW_MS
) =>
  commitAdminRecurring({
    db: db as unknown as D1Database,
    admin,
    request,
    now: () => nowMs
  });

describe("parseAdminRecurringCommitRequest", () => {
  it("returns null for missing fields", () => {
    expect(parseAdminRecurringCommitRequest(null)).toBeNull();
    expect(parseAdminRecurringCommitRequest({})).toBeNull();
    expect(
      parseAdminRecurringCommitRequest({
        idempotencyKey: "k",
        storeId: STORE_ID,
        resourceId: RESOURCE_ID,
        rrule: "RRULE:FREQ=WEEKLY",
        dtstart: DTSTART_ISO,
        windowEnd: WINDOW_END_ISO
        // durationMinutes missing
      })
    ).toBeNull();
  });

  it("returns null for non-integer / non-multiple-of-5 / out-of-range durationMinutes", () => {
    const make = (durationMinutes: unknown) => ({
      ...BASE_REQUEST,
      durationMinutes
    });
    expect(parseAdminRecurringCommitRequest(make(0))).toBeNull();
    expect(parseAdminRecurringCommitRequest(make(7))).toBeNull(); // not multiple of 5
    expect(parseAdminRecurringCommitRequest(make(30.5))).toBeNull();
    expect(parseAdminRecurringCommitRequest(make(12 * 60 + 5))).toBeNull(); // > 12h cap
  });

  it("parses a complete request and trims string fields", () => {
    const parsed = parseAdminRecurringCommitRequest({
      ...BASE_REQUEST,
      idempotencyKey: "  recurring-commit-trim  ",
      title: "  週次  "
    });
    expect(parsed).not.toBeNull();
    expect(parsed?.idempotencyKey).toBe("recurring-commit-trim");
    expect(parsed?.title).toBe("週次");
  });
});

describe("commitAdminRecurring happy path", () => {
  it("materialises every future occurrence as an external_blocks row + writes one batch audit + parent idempotency target_id", async () => {
    const db = createMigratedSqliteD1();
    try {
      const result = await runCommit(db, OWNER_ADMIN, BASE_REQUEST);

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("setup failure");
      expect(result.createdCount).toBe(4);
      expect(result.replayedCount).toBe(0);
      expect(result.skippedPastCount).toBe(0);
      expect(result.failedCount).toBe(0);
      expect(result.occurrences).toHaveLength(4);
      for (const occ of result.occurrences) {
        expect(occ.status).toBe("created");
      }

      const blockCount = db.sqlite
        .prepare(
          `SELECT COUNT(*) AS count FROM external_blocks WHERE store_id = ? AND resource_id = ?`
        )
        .get(STORE_ID, RESOURCE_ID) as { count: number };
      expect(blockCount.count).toBe(4);

      const audit = db.sqlite
        .prepare(
          `SELECT action, target_type, target_id, metadata_json FROM audit_logs WHERE action = 'settings.recurring.commit'`
        )
        .get() as { action: string; target_type: string; target_id: string; metadata_json: string };
      expect(audit.action).toBe("settings.recurring.commit");
      expect(audit.target_type).toBe("recurring_batch");
      expect(audit.target_id).toBe(result.auditLogId);
      const meta = JSON.parse(audit.metadata_json) as {
        adminRole: string;
        summary: { createdCount: number; occurrences: unknown[] };
      };
      expect(meta.adminRole).toBe("owner");
      expect(meta.summary.createdCount).toBe(4);
      expect(meta.summary.occurrences).toHaveLength(4);

      const parentIdem = db.sqlite
        .prepare(
          `SELECT status, target_type, target_id FROM idempotency_keys WHERE idempotency_key = ? AND scope = 'admin_action'`
        )
        .get(BASE_REQUEST.idempotencyKey) as { status: string; target_type: string; target_id: string };
      expect(parentIdem.status).toBe("succeeded");
      expect(parentIdem.target_type).toBe("recurring_batch");
      expect(parentIdem.target_id).toBe(result.auditLogId);

      // Each occurrence also writes its own child idempotency row via the
      // inner createAdminExternalBlock path — confirm partial-retry safety
      // has the expected number of children.
      const childCount = db.sqlite
        .prepare(
          `SELECT COUNT(*) AS count FROM idempotency_keys WHERE scope = 'admin_action' AND idempotency_key != ?`
        )
        .get(BASE_REQUEST.idempotencyKey) as { count: number };
      expect(childCount.count).toBe(4);
    } finally {
      db.sqlite.close();
    }
  });

  it("system_admin role can commit (parity with owner)", async () => {
    const db = createMigratedSqliteD1();
    try {
      const result = await runCommit(db, SYSTEM_ADMIN, {
        ...BASE_REQUEST,
        idempotencyKey: "recurring-commit-sysadmin-1"
      });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("setup failure");
      expect(result.createdCount).toBe(4);
    } finally {
      db.sqlite.close();
    }
  });
});

describe("commitAdminRecurring idempotency", () => {
  it("replays same key + same payload as ok:true replayed:true and writes no new rows", async () => {
    const db = createMigratedSqliteD1();
    try {
      const first = await runCommit(db, OWNER_ADMIN, BASE_REQUEST);
      expect(first.ok).toBe(true);

      const blocksAfterFirst = (
        db.sqlite.prepare(`SELECT COUNT(*) AS count FROM external_blocks`).get() as { count: number }
      ).count;

      const second = await runCommit(db, OWNER_ADMIN, BASE_REQUEST);
      expect(second.ok).toBe(true);
      if (!second.ok || !first.ok) throw new Error("setup failure");
      expect(second.replayed).toBe(true);
      expect(second.auditLogId).toBe(first.auditLogId);
      expect(second.createdCount).toBe(first.createdCount);
      expect(second.occurrences).toHaveLength(first.occurrences.length);

      const blocksAfterReplay = (
        db.sqlite.prepare(`SELECT COUNT(*) AS count FROM external_blocks`).get() as { count: number }
      ).count;
      expect(blocksAfterReplay).toBe(blocksAfterFirst);

      const auditCount = (
        db.sqlite
          .prepare(`SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'settings.recurring.commit'`)
          .get() as { count: number }
      ).count;
      expect(auditCount).toBe(1);
    } finally {
      db.sqlite.close();
    }
  });

  it("returns idempotency_conflict (same key + different payload)", async () => {
    const db = createMigratedSqliteD1();
    try {
      const first = await runCommit(db, OWNER_ADMIN, BASE_REQUEST);
      expect(first.ok).toBe(true);

      const second = await runCommit(db, OWNER_ADMIN, {
        ...BASE_REQUEST,
        title: "別のタイトル"
      });
      expect(second).toEqual({ ok: false, error: "idempotency_conflict" });
    } finally {
      db.sqlite.close();
    }
  });
});

describe("commitAdminRecurring partial outcomes", () => {
  it("skips past occurrences (status=skipped_past) when dtstart precedes now", async () => {
    const db = createMigratedSqliteD1();
    try {
      // Move "now" forward so the first three of the four occurrences fall in
      // the past. expandRrule returns all four (preview-style); commit then
      // refuses the past ones and creates only the future remainder.
      const lateNow = Date.UTC(2099, 6, 5, 0, 0, 0); // 2099-07-05
      const result = await runCommit(db, OWNER_ADMIN, BASE_REQUEST, lateNow);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("setup failure");
      expect(result.skippedPastCount).toBeGreaterThan(0);
      expect(result.createdCount).toBeGreaterThan(0);
      expect(result.createdCount + result.skippedPastCount).toBe(4);
    } finally {
      db.sqlite.close();
    }
  });

  it("sets truncatedByCap=true when future occurrences exceed MAX_COMMIT_OCCURRENCES", async () => {
    const db = createMigratedSqliteD1();
    try {
      // 80 future daily occurrences within the 90-day window — raw
      // expansion returns all 80 (truncatedByCap from the expander stays
      // false), but the future-slice keeps only the first 50. The summary
      // must still report truncatedByCap so the operator knows 30
      // occurrences need a follow-up commit.
      const result = await runCommit(db, OWNER_ADMIN, {
        ...BASE_REQUEST,
        idempotencyKey: "recurring-commit-truncate-future",
        rrule: "RRULE:FREQ=DAILY;COUNT=80",
        durationMinutes: 30,
        windowEnd: "2099-09-30T00:00:00.000Z"
      });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("setup failure");
      expect(result.createdCount).toBe(50);
      expect(result.truncatedByCap).toBe(true);
    } finally {
      db.sqlite.close();
    }
  });

  it("anchors the 90-day window cap on max(dtstart, now) so old-anchor RRULEs still see future occurrences", async () => {
    const db = createMigratedSqliteD1();
    try {
      // dtstart sits 1 year before NOW_MS. The legacy implementation
      // capped windowEnd to dtstart+90d, landing the entire expansion in
      // the past. The fixed implementation caps to now+90d so the
      // expansion still finds upcoming occurrences.
      const result = await runCommit(db, OWNER_ADMIN, {
        ...BASE_REQUEST,
        idempotencyKey: "recurring-commit-old-anchor",
        rrule: "RRULE:FREQ=WEEKLY",
        dtstart: "2098-06-01T01:00:00.000Z", // ~1 year before NOW_MS
        windowEnd: "2099-09-01T00:00:00.000Z",
        durationMinutes: 30
      });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("setup failure");
      expect(result.createdCount).toBeGreaterThan(0);
    } finally {
      db.sqlite.close();
    }
  });

  it("materialises future occurrences when dtstart sits well in the past", async () => {
    const db = createMigratedSqliteD1();
    try {
      // Anchor dtstart 1 month before NOW_MS so a naive expansion cap of
      // MAX_COMMIT_OCCURRENCES would consume its entire return slice on
      // already-past dates. The RAW_EXPANSION_MAX bump + future-slice
      // post-filter must still surface enough future ones to materialise.
      const result = await runCommit(db, OWNER_ADMIN, {
        ...BASE_REQUEST,
        idempotencyKey: "recurring-commit-past-anchor",
        rrule: "RRULE:FREQ=DAILY;COUNT=80",
        dtstart: "2099-05-01T01:00:00.000Z", // 1 month before NOW_MS
        windowEnd: "2099-09-01T00:00:00.000Z",
        durationMinutes: 30
      });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("setup failure");
      expect(result.skippedPastCount).toBeGreaterThan(0);
      expect(result.createdCount).toBeGreaterThan(0);
      // skippedPastCount is the only past-occurrence channel — per-row
      // occurrences must not carry skipped entries.
      for (const occ of result.occurrences) {
        expect(["created", "replayed", "failed"]).toContain(occ.status);
      }
    } finally {
      db.sqlite.close();
    }
  });

  it("marks per-occurrence slot conflicts as failed without aborting the batch", async () => {
    const db = createMigratedSqliteD1();
    try {
      // Pre-seed an external_blocks row covering the SECOND occurrence's slot
      // (DTSTART + 7d). The commit should create 3 of 4 occurrences and
      // report the conflicting one as failed/slot_unavailable.
      const conflictStart = "2099-06-22T01:00:00.000Z";
      const conflictEnd = "2099-06-22T02:00:00.000Z";
      const pre = await createAdminExternalBlock({
        db: db as unknown as D1Database,
        admin: OWNER_ADMIN,
        request: {
          idempotencyKey: "preseed-conflict-1",
          storeId: STORE_ID,
          resourceId: RESOURCE_ID,
          startAt: conflictStart,
          endAt: conflictEnd,
          title: "既存ブロック"
        },
        now: () => NOW_MS
      });
      expect(pre.ok).toBe(true);

      const result = await runCommit(db, OWNER_ADMIN, BASE_REQUEST);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("setup failure");
      expect(result.failedCount).toBe(1);
      expect(result.createdCount).toBe(3);
      const failed = result.occurrences.find((o) => o.status === "failed");
      expect(failed).toBeDefined();
      if (failed && failed.status === "failed") {
        expect(failed.reason).toBe("slot_unavailable");
        expect(failed.startAt).toBe(conflictStart);
      }
    } finally {
      db.sqlite.close();
    }
  });
});

describe("commitAdminRecurring validation", () => {
  it("returns forbidden for staff role and writes nothing", async () => {
    const db = createMigratedSqliteD1();
    try {
      const result = await runCommit(db, STAFF_ADMIN, BASE_REQUEST);
      expect(result).toEqual({ ok: false, error: "forbidden" });
      const blockCount = (
        db.sqlite.prepare(`SELECT COUNT(*) AS count FROM external_blocks`).get() as { count: number }
      ).count;
      expect(blockCount).toBe(0);
      const idemCount = (
        db.sqlite
          .prepare(`SELECT COUNT(*) AS count FROM idempotency_keys WHERE idempotency_key = ?`)
          .get(BASE_REQUEST.idempotencyKey) as { count: number }
      ).count;
      expect(idemCount).toBe(0);
    } finally {
      db.sqlite.close();
    }
  });

  it("returns invalid_request for non-canonical dtstart (Feb 30)", async () => {
    const db = createMigratedSqliteD1();
    try {
      const result = await runCommit(db, OWNER_ADMIN, {
        ...BASE_REQUEST,
        idempotencyKey: "recurring-commit-bad-dtstart",
        dtstart: "2099-02-30T01:00:00.000Z"
      });
      expect(result).toEqual({ ok: false, error: "invalid_request" });
    } finally {
      db.sqlite.close();
    }
  });

  it("returns invalid_request when windowEnd is malformed or invalid", async () => {
    const db = createMigratedSqliteD1();
    try {
      const result = await runCommit(db, OWNER_ADMIN, {
        ...BASE_REQUEST,
        idempotencyKey: "recurring-commit-bad-windowEnd",
        windowEnd: "NOT A VALID DATE"
      });
      expect(result).toEqual({ ok: false, error: "invalid_request" });
    } finally {
      db.sqlite.close();
    }
  });

  it("returns invalid_request for windowEnd before dtstart", async () => {
    const db = createMigratedSqliteD1();
    try {
      const result = await runCommit(db, OWNER_ADMIN, {
        ...BASE_REQUEST,
        idempotencyKey: "recurring-commit-window-before-dtstart",
        windowEnd: "2099-05-01T00:00:00.000Z" // before DTSTART
      });
      expect(result).toEqual({ ok: false, error: "invalid_request" });
    } finally {
      db.sqlite.close();
    }
  });

  it("returns invalid_request when dtstart is not 5-min aligned", async () => {
    const db = createMigratedSqliteD1();
    try {
      const result = await runCommit(db, OWNER_ADMIN, {
        ...BASE_REQUEST,
        idempotencyKey: "recurring-commit-misaligned-dtstart",
        dtstart: "2099-06-15T01:03:00.000Z"
      });
      expect(result).toEqual({ ok: false, error: "invalid_request" });
    } finally {
      db.sqlite.close();
    }
  });

  it("returns invalid_rrule for malformed RRULE input", async () => {
    const db = createMigratedSqliteD1();
    try {
      const result = await runCommit(db, OWNER_ADMIN, {
        ...BASE_REQUEST,
        idempotencyKey: "recurring-commit-bad-rrule",
        rrule: "RRULE:NOTAFREQ"
      });
      expect(result).toEqual({ ok: false, error: "invalid_rrule" });
    } finally {
      db.sqlite.close();
    }
  });

  it("returns unsupported_freq for FREQ values outside DAILY/WEEKLY/MONTHLY", async () => {
    const db = createMigratedSqliteD1();
    try {
      const result = await runCommit(db, OWNER_ADMIN, {
        ...BASE_REQUEST,
        idempotencyKey: "recurring-commit-unsupported-freq",
        rrule: "RRULE:FREQ=YEARLY;COUNT=2"
      });
      expect(result).toEqual({ ok: false, error: "unsupported_freq" });
    } finally {
      db.sqlite.close();
    }
  });

  it("returns invalid_request when expanded slot count exceeds the batch ceiling", async () => {
    const db = createMigratedSqliteD1();
    try {
      // 50 daily occurrences × 4h × (60/5 slots/hr) = 50 × 48 = 2400 slots
      // → above MAX_BATCH_SLOTS=1500. DAILY frequency keeps the expansion
      // within the 90-day window cap; WEEKLY at the same COUNT would be
      // truncated to ~13 occurrences and pass the slot guard.
      const result = await runCommit(db, OWNER_ADMIN, {
        ...BASE_REQUEST,
        idempotencyKey: "recurring-commit-too-many-slots",
        rrule: "RRULE:FREQ=DAILY;COUNT=50",
        durationMinutes: 240,
        windowEnd: "2099-12-31T00:00:00.000Z"
      });
      expect(result).toEqual({ ok: false, error: "invalid_request" });
      const idemCount = (
        db.sqlite
          .prepare(`SELECT COUNT(*) AS count FROM idempotency_keys WHERE idempotency_key = ?`)
          .get("recurring-commit-too-many-slots") as { count: number }
      ).count;
      // Parent idempotency must NOT be persisted on pre-write validation
      // rejection — otherwise legitimate later attempts would 409 conflict.
      expect(idemCount).toBe(0);
    } finally {
      db.sqlite.close();
    }
  });
});

describe("commitAdminRecurring crash recovery", () => {
  // STALE_PARENT_LEASE_MS in the helper is 60_000ms; bump every staged
  // mutation past that threshold so the lease check classifies the parent
  // as a crashed-out previous attempt rather than an active peer.
  const STALE_BEFORE_ISO = new Date(NOW_MS - 120_000).toISOString();

  it("resumes a stale 'started' parent (older than the lease) and converges to succeeded", async () => {
    const db = createMigratedSqliteD1();
    try {
      // Drive an initial successful commit so the child idempotency rows
      // exist, then roll the parent back to a stale started state to fake
      // a crashed mid-flight attempt that never reached finalize.
      const initial = await runCommit(db, OWNER_ADMIN, BASE_REQUEST);
      expect(initial.ok).toBe(true);
      if (!initial.ok) throw new Error("setup failure");
      db.sqlite.prepare(`DELETE FROM audit_logs WHERE id = ?`).run(initial.auditLogId);
      db.sqlite
        .prepare(
          `UPDATE idempotency_keys SET status = 'started', target_id = NULL, target_type = NULL, updated_at = ? WHERE idempotency_key = ?`
        )
        .run(STALE_BEFORE_ISO, BASE_REQUEST.idempotencyKey);

      const retry = await runCommit(db, OWNER_ADMIN, BASE_REQUEST);
      expect(retry.ok).toBe(true);
      if (!retry.ok) throw new Error("retry failed");
      expect(retry.replayed).toBe(true);
      expect(retry.replayedCount).toBe(4);
      expect(retry.createdCount).toBe(0);

      const blockCount = (
        db.sqlite
          .prepare(`SELECT COUNT(*) AS count FROM external_blocks WHERE store_id = ?`)
          .get(STORE_ID) as { count: number }
      ).count;
      expect(blockCount).toBe(4);

      const parent = db.sqlite
        .prepare(
          `SELECT status, target_id FROM idempotency_keys WHERE idempotency_key = ?`
        )
        .get(BASE_REQUEST.idempotencyKey) as { status: string; target_id: string };
      expect(parent.status).toBe("succeeded");
      expect(parent.target_id).toBe(retry.auditLogId);
    } finally {
      db.sqlite.close();
    }
  });

  it("rejects a fresh 'started' parent (active peer) with idempotency_in_progress and writes nothing", async () => {
    const db = createMigratedSqliteD1();
    try {
      const initial = await runCommit(db, OWNER_ADMIN, BASE_REQUEST);
      expect(initial.ok).toBe(true);
      if (!initial.ok) throw new Error("setup failure");
      const blocksBefore = (
        db.sqlite
          .prepare(`SELECT COUNT(*) AS count FROM external_blocks WHERE store_id = ?`)
          .get(STORE_ID) as { count: number }
      ).count;
      const auditBefore = (
        db.sqlite
          .prepare(
            `SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'settings.recurring.commit'`
          )
          .get() as { count: number }
      ).count;
      // Simulate an active peer: a 'started' parent with a recent
      // updated_at (well within STALE_PARENT_LEASE_MS = 60s).
      db.sqlite
        .prepare(
          `UPDATE idempotency_keys SET status = 'started', target_id = NULL, target_type = NULL, updated_at = ? WHERE idempotency_key = ?`
        )
        .run(new Date(NOW_MS - 5_000).toISOString(), BASE_REQUEST.idempotencyKey);

      const concurrent = await runCommit(db, OWNER_ADMIN, BASE_REQUEST);
      expect(concurrent).toEqual({ ok: false, error: "idempotency_in_progress" });

      // Nothing new must have been written by the rejected concurrent call.
      const blocksAfter = (
        db.sqlite
          .prepare(`SELECT COUNT(*) AS count FROM external_blocks WHERE store_id = ?`)
          .get(STORE_ID) as { count: number }
      ).count;
      expect(blocksAfter).toBe(blocksBefore);
      const auditAfter = (
        db.sqlite
          .prepare(
            `SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'settings.recurring.commit'`
          )
          .get() as { count: number }
      ).count;
      expect(auditAfter).toBe(auditBefore);
    } finally {
      db.sqlite.close();
    }
  });

  it("resumes a parent marked 'failed' by a previous failed attempt regardless of lease age", async () => {
    const db = createMigratedSqliteD1();
    try {
      const initial = await runCommit(db, OWNER_ADMIN, BASE_REQUEST);
      expect(initial.ok).toBe(true);
      if (!initial.ok) throw new Error("setup failure");
      db.sqlite.prepare(`DELETE FROM audit_logs WHERE id = ?`).run(initial.auditLogId);
      // 'failed' is always resume-eligible — the lease only gates
      // 'started' rows. updated_at is fresh on purpose to prove the failed
      // state takes precedence over the stale check.
      db.sqlite
        .prepare(
          `UPDATE idempotency_keys SET status = 'failed', target_id = NULL, target_type = NULL, updated_at = ? WHERE idempotency_key = ?`
        )
        .run(new Date(NOW_MS).toISOString(), BASE_REQUEST.idempotencyKey);

      const retry = await runCommit(db, OWNER_ADMIN, BASE_REQUEST);
      expect(retry.ok).toBe(true);
      if (!retry.ok) throw new Error("retry failed");
      expect(retry.replayedCount).toBe(4);
      const parent = db.sqlite
        .prepare(
          `SELECT status FROM idempotency_keys WHERE idempotency_key = ?`
        )
        .get(BASE_REQUEST.idempotencyKey) as { status: string };
      expect(parent.status).toBe("succeeded");
    } finally {
      db.sqlite.close();
    }
  });
});

// Domain calls use the same persisted actor snapshot as authenticated routes.
const createMigratedSqliteD1 = () => {
  const db = createBaseD1();
  db.sqlite.exec("INSERT INTO admin_users(id,email,access_subject,role) VALUES ('admin_owner_1','admin_owner_1@example.test','admin_owner_1','owner'), ('admin_system_1','admin_system_1@example.test','admin_system_1','system_admin')");
  return db;
};
