import { afterEach, describe, expect, it } from "vitest";

import { resolveAdminGoogleConflict } from "../src/admin/sync-recovery";
import { createMigratedSqliteD1, type SqliteD1Database } from "./helpers/sqlite-d1";
import { insertAdminUser as insertAdminUserHelper } from "./helpers/admin-access";

const NOW_MS = Date.parse("2026-05-09T01:00:00.000Z");
const ADMIN_ID = "admin_atomic_resolve_1";

const insertAdminUser = (db: SqliteD1Database) =>
  insertAdminUserHelper(db, {
    id: ADMIN_ID,
    email: "admin@example.com",
    accessSubject: `subject_${ADMIN_ID}`,
    role: "system_admin",
  });

const insertExternalBlockWithLocks = (
  db: SqliteD1Database,
  options: {
    blockId: string;
    googleEventId: string;
    blockStatus?: "active" | "cancelled";
    slotCount?: number;
  }
) => {
  const blockStatus = options.blockStatus ?? "active";
  db.sqlite
    .prepare(
      `
        INSERT INTO external_blocks (
          id, store_id, resource_id, source, google_event_id,
          start_at, end_at, status, created_by, created_at, updated_at
        )
        VALUES (?, 'kyoto', 'resource_kyoto_calendar', 'google_calendar', ?,
                '2026-05-10T01:00:00.000Z', '2026-05-10T02:00:00.000Z',
                ?, ?, '2026-05-09T00:00:00.000Z', '2026-05-09T00:00:00.000Z')
      `
    )
    .run(options.blockId, options.googleEventId, blockStatus, ADMIN_ID);
  const slotCount = options.slotCount ?? 2;
  for (let i = 0; i < slotCount; i += 1) {
    db.sqlite
      .prepare(
        `
          INSERT INTO slot_locks (id, store_id, resource_id, slot_at, owner_type, owner_id, lock_status, created_at)
          VALUES (?, 'kyoto', 'resource_kyoto_calendar', ?, 'external_block', ?, 'confirmed', '2026-05-09T00:00:00.000Z')
        `
      )
      .run(
        `${options.blockId}_lock_${i}`,
        `2026-05-10T0${1 + i}:00:00.000Z`,
        options.blockId
      );
  }
};

const insertConflict = (
  db: SqliteD1Database,
  options: {
    conflictId: string;
    googleEventId: string;
    conflictType?: string;
    externalBlockId?: string | null;
    resolutionStatus?: "open" | "manual_resolved";
  }
) => {
  db.sqlite
    .prepare(
      `
        INSERT INTO google_calendar_conflicts (
          id, store_id, calendar_id, google_event_id, external_block_id,
          conflict_type, google_safe_snapshot_json, resolution_status, created_at
        )
        VALUES (?, 'kyoto', 'calendar-a@example.invalid', ?, ?, ?, '{"kind":"safe"}', ?, '2026-05-09T00:00:00.000Z')
      `
    )
    .run(
      options.conflictId,
      options.googleEventId,
      options.externalBlockId ?? null,
      options.conflictType ?? "external_block_event_deleted",
      options.resolutionStatus ?? "open"
    );
};

const baseInput = (overrides: Record<string, unknown>) => ({
  db: undefined as unknown as D1Database,
  admin: {
    id: ADMIN_ID,
    email: "admin@example.com",
    role: "system_admin" as const, staff_member_id: null, store_id: null
  },
  conflictId: "conflict_atomic_1",
  resolutionStatus: "manual_resolved" as const,
  request: {
    idempotencyKey: "atomic-1"
  },
  now: () => NOW_MS,
  ...overrides
});

describe("resolveAdminGoogleConflict — atomic external_block cancel", () => {
  let db: SqliteD1Database;

  afterEach(() => {
    db?.sqlite.close();
  });

  it("happy path: cancels block, deletes locks, writes history, resolves conflict, logs audit", async () => {
    db = createMigratedSqliteD1();
    insertAdminUser(db);
    insertExternalBlockWithLocks(db, { blockId: "block_1", googleEventId: "gev_1", slotCount: 2 });
    insertConflict(db, { conflictId: "conflict_atomic_1", googleEventId: "gev_1", externalBlockId: "block_1" });

    const result = await resolveAdminGoogleConflict({
      ...baseInput({ db: db as unknown as D1Database }),
      request: { idempotencyKey: "atomic-1", cancelExternalBlock: true }
    } as Parameters<typeof resolveAdminGoogleConflict>[0]);

    expect(result.ok).toBe(true);

    const block = db.sqlite.prepare(`SELECT status FROM external_blocks WHERE id = 'block_1'`).get() as { status: string };
    expect(block.status).toBe("cancelled");

    const locks = db.sqlite
      .prepare(`SELECT COUNT(*) AS c FROM slot_locks WHERE owner_type = 'external_block' AND owner_id = 'block_1'`)
      .get() as { c: number };
    expect(locks.c).toBe(0);

    const history = db.sqlite
      .prepare(
        `
          SELECT COUNT(*) AS c
          FROM slot_lock_history
          WHERE action = 'released'
            AND actor_type = 'staff'
            AND actor_id = ?
            AND reason = 'admin_atomic_resolve_external_block_cancel'
        `
      )
      .get(ADMIN_ID) as { c: number };
    expect(history.c).toBe(2);

    const conflict = db.sqlite
      .prepare(`SELECT resolution_status FROM google_calendar_conflicts WHERE id = 'conflict_atomic_1'`)
      .get() as { resolution_status: string };
    expect(conflict.resolution_status).toBe("manual_resolved");

    const audit = db.sqlite
      .prepare(
        `
          SELECT metadata_json
          FROM audit_logs
          WHERE action = 'admin_google_conflict_manual_resolved'
            AND target_id = 'conflict_atomic_1'
        `
      )
      .get() as { metadata_json: string } | undefined;
    expect(audit).toBeTruthy();
    const metadata = JSON.parse(audit!.metadata_json);
    expect(metadata.cancelledExternalBlockId).toBe("block_1");
  });

  it("already-cancelled block: idempotent — block stays cancelled, locks freed, conflict resolves", async () => {
    db = createMigratedSqliteD1();
    insertAdminUser(db);
    insertExternalBlockWithLocks(db, {
      blockId: "block_2",
      googleEventId: "gev_2",
      blockStatus: "cancelled",
      slotCount: 1
    });
    insertConflict(db, { conflictId: "conflict_atomic_1", googleEventId: "gev_2", externalBlockId: "block_2" });

    const result = await resolveAdminGoogleConflict({
      ...baseInput({ db: db as unknown as D1Database }),
      request: { idempotencyKey: "atomic-2", cancelExternalBlock: true }
    } as Parameters<typeof resolveAdminGoogleConflict>[0]);
    expect(result.ok).toBe(true);

    const block = db.sqlite.prepare(`SELECT status FROM external_blocks WHERE id = 'block_2'`).get() as { status: string };
    expect(block.status).toBe("cancelled");
    const locks = db.sqlite
      .prepare(`SELECT COUNT(*) AS c FROM slot_locks WHERE owner_type = 'external_block' AND owner_id = 'block_2'`)
      .get() as { c: number };
    expect(locks.c).toBe(0);
  });

  it("rejects cancelExternalBlock when conflict_type is not external_block_event_deleted", async () => {
    db = createMigratedSqliteD1();
    insertAdminUser(db);
    insertExternalBlockWithLocks(db, { blockId: "block_3", googleEventId: "gev_3" });
    insertConflict(db, {
      conflictId: "conflict_atomic_1",
      googleEventId: "gev_3",
      conflictType: "reservation_event_deleted",
      externalBlockId: "block_3"
    });

    const result = await resolveAdminGoogleConflict({
      ...baseInput({ db: db as unknown as D1Database }),
      request: { idempotencyKey: "atomic-3", cancelExternalBlock: true }
    } as Parameters<typeof resolveAdminGoogleConflict>[0]);
    expect(result).toEqual({ ok: false, reason: "invalid_transition" });

    const block = db.sqlite.prepare(`SELECT status FROM external_blocks WHERE id = 'block_3'`).get() as { status: string };
    expect(block.status).toBe("active");
    const conflict = db.sqlite
      .prepare(`SELECT resolution_status FROM google_calendar_conflicts WHERE id = 'conflict_atomic_1'`)
      .get() as { resolution_status: string };
    expect(conflict.resolution_status).toBe("open");
  });

  it("rejects cancelExternalBlock when resolutionStatus is 'ignored'", async () => {
    db = createMigratedSqliteD1();
    insertAdminUser(db);
    insertExternalBlockWithLocks(db, { blockId: "block_4", googleEventId: "gev_4" });
    insertConflict(db, { conflictId: "conflict_atomic_1", googleEventId: "gev_4", externalBlockId: "block_4" });

    const result = await resolveAdminGoogleConflict({
      ...baseInput({ db: db as unknown as D1Database, resolutionStatus: "ignored" }),
      request: { idempotencyKey: "atomic-4", cancelExternalBlock: true }
    } as Parameters<typeof resolveAdminGoogleConflict>[0]);
    expect(result).toEqual({ ok: false, reason: "invalid_transition" });
  });

  it("rejects cancelExternalBlock when external_block_id is null on the conflict", async () => {
    db = createMigratedSqliteD1();
    insertAdminUser(db);
    insertConflict(db, {
      conflictId: "conflict_atomic_1",
      googleEventId: "gev_5",
      externalBlockId: null
    });

    const result = await resolveAdminGoogleConflict({
      ...baseInput({ db: db as unknown as D1Database }),
      request: { idempotencyKey: "atomic-5", cancelExternalBlock: true }
    } as Parameters<typeof resolveAdminGoogleConflict>[0]);
    expect(result).toEqual({ ok: false, reason: "invalid_transition" });
  });

  it("idempotency replay with same flag returns the cached result and does not double-cancel", async () => {
    db = createMigratedSqliteD1();
    insertAdminUser(db);
    insertExternalBlockWithLocks(db, { blockId: "block_6", googleEventId: "gev_6", slotCount: 2 });
    insertConflict(db, { conflictId: "conflict_atomic_1", googleEventId: "gev_6", externalBlockId: "block_6" });

    const first = await resolveAdminGoogleConflict({
      ...baseInput({ db: db as unknown as D1Database }),
      request: { idempotencyKey: "atomic-6", cancelExternalBlock: true }
    } as Parameters<typeof resolveAdminGoogleConflict>[0]);
    expect(first.ok).toBe(true);

    const second = await resolveAdminGoogleConflict({
      ...baseInput({ db: db as unknown as D1Database }),
      request: { idempotencyKey: "atomic-6", cancelExternalBlock: true }
    } as Parameters<typeof resolveAdminGoogleConflict>[0]);
    expect(second.ok).toBe(true);
    if (second.ok) {
      expect(second.replayed).toBe(true);
    }

    // History should still only show the original 2 release rows; not 4.
    const history = db.sqlite
      .prepare(`SELECT COUNT(*) AS c FROM slot_lock_history WHERE actor_id = ?`)
      .get(ADMIN_ID) as { c: number };
    expect(history.c).toBe(2);
  });

  it("idempotency replay with FLIPPED flag returns idempotency_conflict", async () => {
    db = createMigratedSqliteD1();
    insertAdminUser(db);
    insertExternalBlockWithLocks(db, { blockId: "block_7", googleEventId: "gev_7" });
    insertConflict(db, { conflictId: "conflict_atomic_1", googleEventId: "gev_7", externalBlockId: "block_7" });

    const first = await resolveAdminGoogleConflict({
      ...baseInput({ db: db as unknown as D1Database }),
      request: { idempotencyKey: "atomic-7", cancelExternalBlock: true }
    } as Parameters<typeof resolveAdminGoogleConflict>[0]);
    expect(first.ok).toBe(true);

    // Same key, flag flipped — should be detected as a different request.
    const second = await resolveAdminGoogleConflict({
      ...baseInput({ db: db as unknown as D1Database }),
      request: { idempotencyKey: "atomic-7", cancelExternalBlock: false }
    } as Parameters<typeof resolveAdminGoogleConflict>[0]);
    expect(second).toEqual({ ok: false, reason: "idempotency_conflict" });
  });

  it("backward compat: omitting cancelExternalBlock behaves exactly like before", async () => {
    db = createMigratedSqliteD1();
    insertAdminUser(db);
    insertExternalBlockWithLocks(db, { blockId: "block_8", googleEventId: "gev_8" });
    insertConflict(db, { conflictId: "conflict_atomic_1", googleEventId: "gev_8", externalBlockId: "block_8" });

    const result = await resolveAdminGoogleConflict({
      ...baseInput({ db: db as unknown as D1Database }),
      request: { idempotencyKey: "atomic-8" } // cancelExternalBlock omitted
    } as Parameters<typeof resolveAdminGoogleConflict>[0]);
    expect(result.ok).toBe(true);

    // Block + locks should NOT be cancelled because cancelExternalBlock was omitted.
    const block = db.sqlite.prepare(`SELECT status FROM external_blocks WHERE id = 'block_8'`).get() as { status: string };
    expect(block.status).toBe("active");
    const locks = db.sqlite
      .prepare(`SELECT COUNT(*) AS c FROM slot_locks WHERE owner_type = 'external_block' AND owner_id = 'block_8'`)
      .get() as { c: number };
    expect(locks.c).toBeGreaterThan(0);

    // But the conflict itself should still be resolved.
    const conflict = db.sqlite
      .prepare(`SELECT resolution_status FROM google_calendar_conflicts WHERE id = 'conflict_atomic_1'`)
      .get() as { resolution_status: string };
    expect(conflict.resolution_status).toBe("manual_resolved");
  });
});
