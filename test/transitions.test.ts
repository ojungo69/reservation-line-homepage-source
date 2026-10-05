import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  calculateReservationDuration,
  generateSlotTimes,
  generateSlotTimesForDuration,
  generateSlotTimesForRange,
  MAX_TOTAL_SERVICE_DURATION_MINUTES,
  MAX_SERVICE_SELECTIONS,
  normalizeServiceIds
} from "../src/reservations/slot-times";
import {
  buildCancelStatements,
  buildRescheduleStatements
} from "../src/reservations/transitions";
import { createMigratedSqliteD1 } from "./helpers/sqlite-d1";

type CapturedStatement = { sql: string; bindings: unknown[] };

describe("shared multi-service reservation helpers", () => {
  it("normalizes service IDs once with trim, dedupe, and the 12-item cap", () => {
    const ids = Array.from({ length: MAX_SERVICE_SELECTIONS + 1 }, (_, index) => `service_${index + 1}`);

    expect(normalizeServiceIds([` ${ids[0]} `, ids[0], ...ids.slice(1)])).toEqual(
      ids.slice(0, MAX_SERVICE_SELECTIONS)
    );
  });

  it("adds the cleanup interval to the summed service durations", () => {
    expect(calculateReservationDuration([60, 45])).toBe(110);
    expect(MAX_TOTAL_SERVICE_DURATION_MINUTES).toBe(235);
  });

  // admin-app は worker src を import しない構成のため、選択上限の定数は
  // admin-app/src/lib/service-selection.ts に複製されている。片側だけ変更される
  // ドリフトをここで検出する（値はソーステキストから抽出して比較）。
  it("keeps the admin-app selection-limit constants in sync with the worker", () => {
    const frontendSource = readFileSync("admin-app/src/lib/service-selection.ts", "utf8");
    const maxSelections = frontendSource.match(/MAX_SERVICE_SELECTIONS = (\d+)/)?.[1];
    const maxDuration = frontendSource.match(
      /MAX_ADMIN_TOTAL_SERVICE_DURATION_MINUTES = (\d+)/
    )?.[1];

    expect(Number(maxSelections)).toBe(MAX_SERVICE_SELECTIONS);
    expect(Number(maxDuration)).toBe(MAX_TOTAL_SERVICE_DURATION_MINUTES);
  });
});

/**
 * DB stub that records the SQL text + bind array of every prepare/bind call.
 * Used to assert statement ordering and bind-count regression guards without
 * executing against SQLite.
 */
const createCapturingDb = (): { db: D1Database; captured: CapturedStatement[] } => {
  const captured: CapturedStatement[] = [];
  const db = {
    prepare(sql: string) {
      const bindings: unknown[] = [];
      const entry: CapturedStatement = { sql, bindings };
      captured.push(entry);
      const stmt = {
        bind(...values: unknown[]) {
          entry.bindings.push(...values);
          return stmt;
        }
      };
      return stmt as unknown as D1PreparedStatement;
    }
  } as unknown as D1Database;
  return { db, captured };
};

describe("generateSlotTimes", () => {
  it("returns ISO timestamps with the configured interval and excludes the terminal boundary", () => {
    const slots = generateSlotTimes("2026-06-01T01:00:00.000Z", "2026-06-01T01:20:00.000Z", 5);
    expect(slots).toEqual([
      "2026-06-01T01:00:00.000Z",
      "2026-06-01T01:05:00.000Z",
      "2026-06-01T01:10:00.000Z",
      "2026-06-01T01:15:00.000Z"
    ]);
  });

  it("produces 48 slots for the 4h cap at the documented interval", () => {
    const slots = generateSlotTimes("2026-06-01T00:00:00.000Z", "2026-06-01T04:00:00.000Z", 5);
    expect(slots).toHaveLength(48);
    expect(slots[0]).toBe("2026-06-01T00:00:00.000Z");
    expect(slots[slots.length - 1]).toBe("2026-06-01T03:55:00.000Z");
  });

  it("throws when end is not strictly after start", () => {
    expect(() => generateSlotTimes("2026-06-01T01:00:00.000Z", "2026-06-01T01:00:00.000Z", 5)).toThrow();
    expect(() => generateSlotTimes("2026-06-01T02:00:00.000Z", "2026-06-01T01:00:00.000Z", 5)).toThrow();
  });

  it("rejects invalid ISO inputs", () => {
    expect(() => generateSlotTimes("not-a-date", "2026-06-01T01:00:00.000Z", 5)).toThrow();
    expect(() => generateSlotTimes("2026-06-01T01:00:00.000Z", "also-not", 5)).toThrow();
  });

  it("rejects non-positive intervalMinutes", () => {
    expect(() => generateSlotTimes("2026-06-01T01:00:00.000Z", "2026-06-01T02:00:00.000Z", 0)).toThrow();
    expect(() => generateSlotTimes("2026-06-01T01:00:00.000Z", "2026-06-01T02:00:00.000Z", -1)).toThrow();
  });
});

describe("generateSlotTimesForDuration", () => {
  it("returns half-open ISO slots for a duration-based reservation lock", () => {
    const slots = generateSlotTimesForDuration(new Date("2026-06-01T01:00:00.000Z"), 20, 5);
    expect(slots).toEqual([
      "2026-06-01T01:00:00.000Z",
      "2026-06-01T01:05:00.000Z",
      "2026-06-01T01:10:00.000Z",
      "2026-06-01T01:15:00.000Z"
    ]);
  });

  it("returns undefined for invalid duration inputs", () => {
    expect(generateSlotTimesForDuration(new Date("2026-06-01T01:00:00.000Z"), 0, 5)).toBeUndefined();
    expect(generateSlotTimesForDuration(new Date("2026-06-01T01:00:00.000Z"), 17, 5)).toBeUndefined();
    expect(generateSlotTimesForDuration(new Date("not-a-date"), 20, 5)).toBeUndefined();
  });
});

describe("generateSlotTimesForRange", () => {
  it("returns half-open ISO slots for an aligned date range", () => {
    const slots = generateSlotTimesForRange(
      new Date("2026-06-01T01:00:00.000Z"),
      new Date("2026-06-01T01:20:00.000Z"),
      5
    );
    expect(slots).toEqual([
      "2026-06-01T01:00:00.000Z",
      "2026-06-01T01:05:00.000Z",
      "2026-06-01T01:10:00.000Z",
      "2026-06-01T01:15:00.000Z"
    ]);
  });

  it("rejects invalid or unaligned range boundaries", () => {
    expect(
      generateSlotTimesForRange(new Date("2026-06-01T01:00:00.000Z"), new Date("2026-06-01T01:00:00.000Z"), 5)
    ).toBeUndefined();
    expect(
      generateSlotTimesForRange(new Date("2026-06-01T01:02:00.000Z"), new Date("2026-06-01T01:20:00.000Z"), 5)
    ).toBeUndefined();
    expect(
      generateSlotTimesForRange(new Date("2026-06-01T01:00:01.000Z"), new Date("2026-06-01T01:20:00.000Z"), 5)
    ).toBeUndefined();
  });

  it("enforces duration caps and keeps one overflow sentinel slot when requested", () => {
    expect(
      generateSlotTimesForRange(new Date("2026-06-01T01:00:00.000Z"), new Date("2026-06-01T01:20:00.000Z"), 5, {
        maxDurationMs: 15 * 60 * 1000
      })
    ).toBeUndefined();

    const capped = generateSlotTimesForRange(
      new Date("2026-06-01T01:00:00.000Z"),
      new Date("2026-06-01T01:30:00.000Z"),
      5,
      { maxSlotsForOverflowSignal: 4 }
    );
    expect(capped).toHaveLength(5);
    expect(capped?.[4]).toBe("2026-06-01T01:20:00.000Z");
  });
});

const seedReservationContext = (
  d1: ReturnType<typeof createMigratedSqliteD1>,
  overrides: { startAt: string; endAt: string; duration: number; status?: string; version?: number }
) => {
  d1.sqlite.prepare(`INSERT INTO stores (id, name, timezone) VALUES (?, ?, ?)`).run("store_t", "S", "Asia/Tokyo");
  d1.sqlite
    .prepare(`INSERT INTO store_resources (id, store_id, name) VALUES (?, ?, ?)`)
    .run("resource_t", "store_t", "R");
  d1.sqlite
    .prepare(`INSERT INTO customers (id, display_name, phone_normalized, phone_hash) VALUES (?, ?, ?, ?)`)
    .run("customer_t", "C", "0900000000", "phone_hash_t");
  d1.sqlite
    .prepare(`INSERT INTO services (id, store_id, name, duration_minutes) VALUES (?, ?, ?, ?)`)
    .run("service_t", "store_t", "S", overrides.duration);
  d1.sqlite
    .prepare(
      `INSERT INTO reservations (
        id, store_id, service_id, customer_id, resource_id, source, status,
        start_at, end_at, duration_minutes, idempotency_key, version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      "reservation_t",
      "store_t",
      "service_t",
      "customer_t",
      "resource_t",
      "web_line",
      overrides.status ?? "confirmed",
      overrides.startAt,
      overrides.endAt,
      overrides.duration,
      "idem_t",
      overrides.version ?? 1
    );
};

const wrapSqliteDb = (sqlite: ReturnType<typeof createMigratedSqliteD1>["sqlite"]) => {
  return {
    prepare(sql: string) {
      const params: unknown[] = [];
      return {
        bind(...values: unknown[]) {
          params.push(...values);
          return this;
        },
        async run() {
          const result = sqlite.prepare(sql).run(...(params as never[]));
          return { success: true, meta: { changes: Number(result.changes) } } as D1Result;
        }
      } as unknown as D1PreparedStatement;
    }
  } as unknown as D1Database;
};

const runBatch = async (
  d1: ReturnType<typeof createMigratedSqliteD1>,
  statements: D1PreparedStatement[]
) => {
  for (const stmt of statements) {
    await (stmt as unknown as { run: () => Promise<unknown> }).run();
  }
  // Surface changes from the most-recent statement via a helper SELECT.
  return d1.sqlite.prepare(`SELECT changes() AS changes`).get() as { changes: number };
};

describe("buildCancelStatements - admin actor", () => {
  it("emits [UPDATE, release history, DELETE slot_locks, DELETE customer_time_locks]", () => {
    const { db, captured } = createCapturingDb();
    buildCancelStatements({
      db,
      reservationId: "reservation_t",
      customerId: "customer_t",
      expectedStatusList: ["pending_approval", "confirmed"],
      nowIso: "2026-06-01T00:30:00.000Z",
      actor: { kind: "admin", adminId: "admin_t", reason: "admin_cancel" }
    });

    expect(captured).toHaveLength(4);
    expect(captured[0].sql.trim()).toMatch(/^UPDATE reservations/);
    expect(captured[0].sql).toContain("cancelled_by_admin");
    expect(captured[0].sql).toContain("pending_expires_at = NULL");
    expect(captured[0].sql).not.toContain("version = ?");
    expect(captured[1].sql).toContain("INSERT INTO slot_lock_history");
    expect(captured[1].sql).toContain("'released'");
    expect(captured[1].bindings).toEqual(["admin_t", "admin_cancel", "reservation_t"]);
    expect(captured[2].sql.trim()).toMatch(/^DELETE FROM slot_locks/);
    expect(captured[3].sql.trim()).toMatch(/^DELETE FROM customer_time_locks/);
  });

  it("preserves transition[0] ordering contract: only [0] contains UPDATE reservations", () => {
    const { db, captured } = createCapturingDb();
    buildCancelStatements({
      db,
      reservationId: "reservation_t",
      customerId: "customer_t",
      expectedStatusList: ["pending_approval", "confirmed"],
      nowIso: "2026-06-01T00:30:00.000Z",
      actor: { kind: "admin", adminId: "admin_t", reason: "x" }
    });
    expect(captured[0].sql.trim().startsWith("UPDATE reservations")).toBe(true);
    for (const stmt of captured.slice(1)) {
      expect(stmt.sql).not.toMatch(/UPDATE\s+reservations/i);
    }
  });

  it("ignores a smuggled snapshot field on admin input", () => {
    const { db, captured } = createCapturingDb();
    buildCancelStatements({
      db,
      reservationId: "reservation_t",
      customerId: "customer_t",
      expectedStatusList: ["confirmed"],
      nowIso: "2026-06-01T00:30:00.000Z",
      actor: { kind: "admin", adminId: "admin_t", reason: "x" },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      snapshot: { expectedVersion: 99, expectedStartAt: "x", expectedEndAt: "y" }
    } as any);
    expect(captured[0].sql).not.toContain("version = ?");
    expect(captured[0].bindings).not.toContain(99);
  });
});

describe("buildRescheduleStatements - admin actor", () => {
  it.each([
    ["phone_admin", "changed_phone_hash"],
    ["admin", "changed_phone_hash"],
    ["web_line", null],
    ["system_import", null]
  ])("reschedule locks use the current phone policy for %s after a concurrent edit", async (source, expectedHash) => {
    const d1 = createMigratedSqliteD1();
    try {
      seedReservationContext(d1, {
        startAt: "2026-06-01T01:00:00.000Z", endAt: "2026-06-01T02:00:00.000Z", duration: 60
      });
      d1.sqlite.prepare("UPDATE reservations SET source = ? WHERE id = 'reservation_t'").run(source);
      const statements = buildRescheduleStatements({
        db: d1 as unknown as D1Database, reservationId: "reservation_t", customerId: "customer_t",
        storeId: "store_t", resourceId: "resource_t", expectedStatusList: ["confirmed"],
        newStartAt: "2026-06-02T01:00:00.000Z", newEndAt: "2026-06-02T01:10:00.000Z",
        newDurationMinutes: 10, nowIso: "2026-06-01T00:30:00.000Z",
        newLockExpiresAt: null, newLockStatus: "confirmed", actor: { kind: "admin", adminId: "admin_t" }
      });
      d1.sqlite.exec("UPDATE customers SET phone_hash = 'changed_phone_hash' WHERE id = 'customer_t'");
      await d1.batch(statements);

      expect(d1.sqlite.prepare("SELECT DISTINCT phone_hash FROM customer_time_locks WHERE customer_id = 'customer_t'").all())
        .toEqual([{ phone_hash: expectedHash }]);
    } finally {
      d1.sqlite.close();
    }
  });

  it("emits [UPDATE, release history, 2 DELETEs, per-slot triple of (slot_lock, customer_time_lock, created history)]", () => {
    const { db, captured } = createCapturingDb();
    buildRescheduleStatements({
      db,
      reservationId: "reservation_t",
      customerId: "customer_t",
      storeId: "store_t",
      resourceId: "resource_t",
      expectedStatusList: ["confirmed"],
      newStartAt: "2026-06-02T01:00:00.000Z",
      newEndAt: "2026-06-02T01:15:00.000Z", // 3 slots
      newDurationMinutes: 15,
      nowIso: "2026-06-01T00:30:00.000Z",
      newLockExpiresAt: null,
      newLockStatus: "confirmed",
      actor: { kind: "admin", adminId: "admin_t" }
    });

    // 4 prefix + 3 slots * 3 statements = 13
    expect(captured).toHaveLength(13);
    expect(captured[0].sql.trim()).toMatch(/^UPDATE reservations/);
    expect(captured[0].sql).not.toContain("version = ?");
    expect(captured[1].sql).toContain("INSERT INTO slot_lock_history");
    expect(captured[1].sql).toContain("'released'");
    expect(captured[2].sql.trim()).toMatch(/^DELETE FROM slot_locks/);
    expect(captured[3].sql.trim()).toMatch(/^DELETE FROM customer_time_locks/);

    // per-slot triples
    const created = captured.slice(4);
    expect(created).toHaveLength(9);
    for (let i = 0; i < 3; i += 1) {
      expect(created[i * 3].sql).toContain("INSERT INTO slot_locks");
      expect(created[i * 3 + 1].sql).toContain("INSERT INTO customer_time_locks");
      expect(created[i * 3 + 2].sql).toContain("INSERT INTO slot_lock_history");
      expect(created[i * 3 + 2].sql).toContain("'created'");
    }
  });

  it("preserves transition[0] ordering contract", () => {
    const { db, captured } = createCapturingDb();
    buildRescheduleStatements({
      db,
      reservationId: "reservation_t",
      customerId: "customer_t",
      storeId: "store_t",
      resourceId: "resource_t",
      expectedStatusList: ["confirmed"],
      newStartAt: "2026-06-02T01:00:00.000Z",
      newEndAt: "2026-06-02T01:15:00.000Z",
      newDurationMinutes: 15,
      nowIso: "2026-06-01T00:30:00.000Z",
      newLockExpiresAt: null,
      newLockStatus: "confirmed",
      actor: { kind: "admin", adminId: "admin_t" }
    });
    expect(captured[0].sql.trim().startsWith("UPDATE reservations")).toBe(true);
    for (const stmt of captured.slice(1)) {
      expect(stmt.sql).not.toMatch(/UPDATE\s+reservations/i);
    }
  });

  it("keeps bind-count per statement at most 100 (48-slot upper bound, per-slot variant)", () => {
    const { db, captured } = createCapturingDb();
    buildRescheduleStatements({
      db,
      reservationId: "reservation_t",
      customerId: "customer_t",
      storeId: "store_t",
      resourceId: "resource_t",
      expectedStatusList: ["confirmed"],
      newStartAt: "2026-06-02T00:00:00.000Z",
      newEndAt: "2026-06-02T04:00:00.000Z", // 48 slots
      newDurationMinutes: 240,
      nowIso: "2026-06-01T00:30:00.000Z",
      newLockExpiresAt: null,
      newLockStatus: "confirmed",
      actor: { kind: "admin", adminId: "admin_t" }
    });
    for (const stmt of captured) {
      expect(stmt.bindings.length).toBeLessThanOrEqual(100);
    }
  });
});

describe("buildRescheduleStatements - admin actor (D1 integration)", () => {
  it("does not update reservation when checked_in_at IS NOT NULL (TOCTOU SQL guard, admin actor)", async () => {
    const d1 = createMigratedSqliteD1();
    try {
      seedReservationContext(d1, {
        startAt: "2026-06-01T01:00:00.000Z",
        endAt: "2026-06-01T02:00:00.000Z",
        duration: 60
      });
      d1.sqlite
        .prepare(`UPDATE reservations SET checked_in_at = ? WHERE id = ?`)
        .run("2026-06-01T00:30:00.000Z", "reservation_t");

      const db = wrapSqliteDb(d1.sqlite);
      const statements = buildRescheduleStatements({
        db,
        reservationId: "reservation_t",
        customerId: "customer_t",
        storeId: "store_t",
        resourceId: "resource_t",
        expectedStatusList: ["pending_approval", "confirmed"],
        newStartAt: "2026-06-02T01:00:00.000Z",
        newEndAt: "2026-06-02T02:00:00.000Z",
        newDurationMinutes: 60,
        nowIso: "2026-06-01T00:30:00.000Z",
        newLockExpiresAt: null,
        newLockStatus: "confirmed",
        actor: { kind: "admin", adminId: "admin_t" }
      });
      await runBatch(d1, statements);

      const reservation = d1.sqlite
        .prepare(`SELECT start_at, end_at, version FROM reservations WHERE id = ?`)
        .get("reservation_t") as { start_at: string; end_at: string; version: number };
      expect(reservation.start_at).toBe("2026-06-01T01:00:00.000Z");
      expect(reservation.end_at).toBe("2026-06-01T02:00:00.000Z");
      expect(reservation.version).toBe(1);
    } finally {
      d1.sqlite.close();
    }
  });
});
