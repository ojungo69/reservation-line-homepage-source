import { beforeEach, describe, expect, it } from "vitest";

import { getAvailableSlots } from "../src/admin/operations";
import { jstDayRangeFromKey } from "../src/admin/shared";
import { createMigratedSqliteD1, type SqliteD1Database } from "./helpers/sqlite-d1";

// This file unit-tests getAvailableSlots directly; admin-create-reservation.test.ts covers HTTP routing.
// Seed (`seeds/dev.sql`) gives store `kyoto` a single resource
// `resource_kyoto_calendar` and business hours 10:00-20:00 on weekdays
// 0,1,2,3,4,6 — Friday (weekday 5) is closed. These tests characterize the
// current behavior of `getAvailableSlots` before/after the cognitive-complexity
// refactor so the refactor stays behavior-preserving.
const STORE_ID = "kyoto";
const RESOURCE_ID = "resource_kyoto_calendar";
const RESOURCE_NAME = "Example Calendar A";

// 2026-06-01 is a Monday (open); 2026-06-05 is a Friday (closed for kyoto).
const OPEN_MONDAY = "2026-06-01";
const CLOSED_FRIDAY = "2026-06-05";

// Open window 10:00-20:00 → 600..1200 minutes from JST midnight.
const OPEN_MINUTE = 600;
const CLOSE_MINUTE = 1200;

/** ISO instant for `minute` minutes after JST midnight of `dayKey`. */
const isoAtMinute = (dayKey: string, minute: number): string => {
  const range = jstDayRangeFromKey(dayKey);
  if (!range) throw new Error(`bad day key: ${dayKey}`);
  const dayStartMs = new Date(range.startAt).getTime();
  return new Date(dayStartMs + minute * 60_000).toISOString();
};

/** Expected slot count when the caller supplies raw treatment time and occupancy adds 5 minutes. */
const expectedSlotCount = (durationMinutes: number): number => {
  let count = 0;
  for (let m = OPEN_MINUTE; m + durationMinutes + 5 <= CLOSE_MINUTE; m += 15) count += 1;
  return count;
};

const insertSlotLock = async (
  db: SqliteD1Database,
  resourceId: string,
  slotAtIso: string,
  opts?: { ownerType?: string; ownerId?: string; lockStatus?: string; expiresAt?: string | null }
) => {
  await db
    .prepare(
      `INSERT INTO slot_locks (id, store_id, resource_id, slot_at, owner_type, owner_id, lock_status, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      `lock_${resourceId}_${slotAtIso}_${opts?.ownerId ?? "owner-x"}`,
      STORE_ID,
      resourceId,
      slotAtIso,
      opts?.ownerType ?? "admin_hold",
      opts?.ownerId ?? "owner-x",
      opts?.lockStatus ?? "confirmed",
      opts?.expiresAt ?? null
    )
    .run();
};

const insertCustomer = async (db: SqliteD1Database, customerId: string) => {
  await db
    .prepare(`INSERT INTO customers (id, display_name) VALUES (?, '空き枠テスト顧客')`)
    .bind(customerId)
    .run();
};

const insertCustomerTimeLock = async (
  db: SqliteD1Database,
  customerId: string,
  slotAtIso: string,
  opts?: { ownerId?: string; lockStatus?: string; expiresAt?: string | null }
) => {
  await db
    .prepare(
      `INSERT INTO customer_time_locks (id, customer_id, slot_at, owner_type, owner_id, lock_status, expires_at)
       VALUES (?, ?, ?, 'reservation', ?, ?, ?)`
    )
    .bind(
      `ctl_${customerId}_${slotAtIso}`,
      customerId,
      slotAtIso,
      opts?.ownerId ?? "resv-other",
      opts?.lockStatus ?? "confirmed",
      opts?.expiresAt ?? null
    )
    .run();
};

const insertExternalBlock = async (
  db: SqliteD1Database,
  resourceId: string,
  startIso: string,
  endIso: string
) => {
  await db
    .prepare(
      `INSERT INTO external_blocks (id, store_id, resource_id, source, start_at, end_at, status)
       VALUES (?, ?, ?, 'admin_block', ?, ?, 'active')`
    )
    .bind(`block_${resourceId}_${startIso}`, STORE_ID, resourceId, startIso, endIso)
    .run();
};

describe("getAvailableSlots", () => {
  let db: SqliteD1Database;

  beforeEach(() => {
    db = createMigratedSqliteD1();
  });

  it("returns invalid_date for a malformed date", async () => {
    const result = await getAvailableSlots({ db: db as unknown as D1Database, storeId: STORE_ID, date: "2026-13-99" });
    expect(result).toEqual({ ok: false, reason: "invalid_date" });
  });

  it("returns an empty slot list on a closed weekday", async () => {
    const result = await getAvailableSlots({
      db: db as unknown as D1Database,
      storeId: STORE_ID,
      date: CLOSED_FRIDAY,
    });
    expect(result).toEqual({ ok: true, slots: [] });
  });

  it("generates every 15-minute slot across the open window, all available by default", async () => {
    const result = await getAvailableSlots({
      db: db as unknown as D1Database,
      storeId: STORE_ID,
      date: OPEN_MONDAY,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.slots).toHaveLength(expectedSlotCount(15));
    expect(result.slots.every((s) => s.available)).toBe(true);
    // First slot starts at 10:00 JST, carries resource identity.
    expect(result.slots[0]).toEqual({
      resourceId: RESOURCE_ID,
      resourceName: RESOURCE_NAME,
      startAt: isoAtMinute(OPEN_MONDAY, OPEN_MINUTE),
      available: true,
    });
    // Slots are spaced 15 minutes apart.
    expect(result.slots[1].startAt).toBe(isoAtMinute(OPEN_MONDAY, OPEN_MINUTE + 15));
  });

  it("omits inactive resources from both all-resource and explicit-resource queries", async () => {
    db.sqlite
      .prepare(
        `INSERT INTO store_resources (id, store_id, name, resource_type, active)
         VALUES ('resource_kyoto_inactive', ?, '停止中リソース', 'staff_calendar', 0)`
      )
      .run(STORE_ID);

    const allResources = await getAvailableSlots({
      db: db as unknown as D1Database,
      storeId: STORE_ID,
      date: OPEN_MONDAY
    });
    expect(allResources.ok).toBe(true);
    if (!allResources.ok) return;
    expect(new Set(allResources.slots.map((slot) => slot.resourceId))).toEqual(new Set([RESOURCE_ID]));

    const inactiveOnly = await getAvailableSlots({
      db: db as unknown as D1Database,
      storeId: STORE_ID,
      date: OPEN_MONDAY,
      resourceId: "resource_kyoto_inactive"
    });
    expect(inactiveOnly).toEqual({ ok: true, slots: [] });
  });

  it("generates slots inside each split business-hours window without filling the break", async () => {
    db.sqlite.exec(`
      DELETE FROM store_business_hours WHERE store_id = 'kyoto' AND weekday = 1;
      INSERT INTO store_business_hours (id, store_id, weekday, opens_at, closes_at, active)
      VALUES
        ('hours_kyoto_mon_morning', 'kyoto', 1, '10:00', '12:00', 1),
        ('hours_kyoto_mon_afternoon', 'kyoto', 1, '13:00', '20:00', 1);
    `);

    const result = await getAvailableSlots({
      db: db as unknown as D1Database,
      storeId: STORE_ID,
      date: OPEN_MONDAY,
      durationMinutes: 15,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const starts = new Set(result.slots.map((slot) => slot.startAt));
    expect(starts.has(isoAtMinute(OPEN_MONDAY, 11 * 60 + 30))).toBe(true);
    expect(starts.has(isoAtMinute(OPEN_MONDAY, 11 * 60 + 45))).toBe(false);
    expect(starts.has(isoAtMinute(OPEN_MONDAY, 12 * 60))).toBe(false);
    expect(starts.has(isoAtMinute(OPEN_MONDAY, 13 * 60))).toBe(true);
  });

  it("deduplicates overlapping bands without creating slots across an adjacent boundary", async () => {
    db.sqlite.exec(`
      DELETE FROM store_business_hours WHERE store_id = 'kyoto' AND weekday = 1;
      INSERT INTO store_business_hours (id, store_id, weekday, opens_at, closes_at, active)
      VALUES
        ('hours_kyoto_mon_overlap_1', 'kyoto', 1, '10:00', '14:00', 1),
        ('hours_kyoto_mon_overlap_2', 'kyoto', 1, '12:00', '14:00', 1),
        ('hours_kyoto_mon_adjacent', 'kyoto', 1, '14:00', '18:00', 1);
    `);

    const result = await getAvailableSlots({
      db: db as unknown as D1Database,
      storeId: STORE_ID,
      date: OPEN_MONDAY,
      durationMinutes: 15,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const starts = result.slots.map((slot) => slot.startAt);
    expect(starts).toHaveLength(30);
    expect(starts).toEqual([...new Set(starts)]);
    expect(starts).toEqual([...starts].sort());
    expect(starts).toContain(isoAtMinute(OPEN_MONDAY, 13 * 60 + 30));
    expect(starts).not.toContain(isoAtMinute(OPEN_MONDAY, 13 * 60 + 45));
    expect(starts).toContain(isoAtMinute(OPEN_MONDAY, 14 * 60));
  });

  it("marks a slot unavailable when a slot lock covers its start", async () => {
    await insertSlotLock(db, RESOURCE_ID, isoAtMinute(OPEN_MONDAY, OPEN_MINUTE));

    const result = await getAvailableSlots({
      db: db as unknown as D1Database,
      storeId: STORE_ID,
      date: OPEN_MONDAY,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const firstSlot = result.slots.find((s) => s.startAt === isoAtMinute(OPEN_MONDAY, OPEN_MINUTE));
    expect(firstSlot?.available).toBe(false);
    // Exactly one slot is consumed by the lock; the rest stay open.
    expect(result.slots.filter((s) => !s.available)).toHaveLength(1);
  });

  it("detects a lock on a sub-slot 5-minute step within the booking window", async () => {
    // 10:05 is not a slot start (slots land on :00/:15/:30/:45). With the default
    // 15-minute booking it falls inside the 10:00 slot's 5-minute scan
    // (offsets 0/5/10 → 10:00/10:05/10:10), so only the 10:00 slot is consumed.
    await insertSlotLock(db, RESOURCE_ID, isoAtMinute(OPEN_MONDAY, OPEN_MINUTE + 5));

    const result = await getAvailableSlots({
      db: db as unknown as D1Database,
      storeId: STORE_ID,
      date: OPEN_MONDAY,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const firstSlot = result.slots.find((s) => s.startAt === isoAtMinute(OPEN_MONDAY, OPEN_MINUTE));
    expect(firstSlot?.available).toBe(false);
    expect(result.slots.filter((s) => !s.available)).toHaveLength(1);
  });

  it("marks a slot unavailable when an active external block overlaps it", async () => {
    await insertExternalBlock(
      db,
      RESOURCE_ID,
      isoAtMinute(OPEN_MONDAY, OPEN_MINUTE),
      isoAtMinute(OPEN_MONDAY, OPEN_MINUTE + 15)
    );

    const result = await getAvailableSlots({
      db: db as unknown as D1Database,
      storeId: STORE_ID,
      date: OPEN_MONDAY,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const firstSlot = result.slots.find((s) => s.startAt === isoAtMinute(OPEN_MONDAY, OPEN_MINUTE));
    expect(firstSlot?.available).toBe(false);
    expect(result.slots.filter((s) => !s.available)).toHaveLength(1);
  });

  it("honors a longer durationMinutes when laying out slots", async () => {
    const result = await getAvailableSlots({
      db: db as unknown as D1Database,
      storeId: STORE_ID,
      date: OPEN_MONDAY,
      durationMinutes: 30,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.slots).toHaveLength(expectedSlotCount(30));
  });

  it("ends 60-minute service slots at 18:45 instead of the unbookable 19:00 slot", async () => {
    const result = await getAvailableSlots({
      db: db as unknown as D1Database,
      storeId: STORE_ID,
      date: OPEN_MONDAY,
      durationMinutes: 60,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.slots[result.slots.length - 1]?.startAt).toBe(
      isoAtMinute(OPEN_MONDAY, 18 * 60 + 45)
    );
  });

  it("marks a slot unavailable when its cleanup buffer overlaps a locked 5-minute slot", async () => {
    // A 15-minute reservation's final occupied lock is the 10:15 cleanup-buffer slot.
    await insertSlotLock(db, RESOURCE_ID, isoAtMinute(OPEN_MONDAY, OPEN_MINUTE + 15));

    const result = await getAvailableSlots({
      db: db as unknown as D1Database,
      storeId: STORE_ID,
      date: OPEN_MONDAY,
      durationMinutes: 15,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const firstSlot = result.slots.find((s) => s.startAt === isoAtMinute(OPEN_MONDAY, OPEN_MINUTE));
    expect(firstSlot?.available).toBe(false);
  });

  it("ignores business-hours rows that fail to parse, keeping valid rows", async () => {
    // A malformed row (opens_at/closes_at not "HH:MM") parses to NaN. The window
    // computation must skip it via guarded comparison and still derive the window
    // from the valid seeded 10:00-20:00 row — not collapse to an empty day.
    await db
      .prepare(
        `INSERT INTO store_business_hours (id, store_id, weekday, opens_at, closes_at, active)
         VALUES ('hours_kyoto_mon_broken', ?, 1, 'aa:aa', 'bb:bb', 1)`
      )
      .bind(STORE_ID)
      .run();

    const result = await getAvailableSlots({
      db: db as unknown as D1Database,
      storeId: STORE_ID,
      date: OPEN_MONDAY,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.slots).toHaveLength(expectedSlotCount(15));
  });

  describe("excludeReservationId (self-lock exclusion)", () => {
    const SELF_ID = "resv-self";
    const OTHER_ID = "resv-other";
    const at1000 = () => isoAtMinute(OPEN_MONDAY, OPEN_MINUTE);

    it("frees a slot locked only by the excluded reservation", async () => {
      await insertSlotLock(db, RESOURCE_ID, at1000(), { ownerType: "reservation", ownerId: SELF_ID });

      const without = await getAvailableSlots({
        db: db as unknown as D1Database,
        storeId: STORE_ID,
        date: OPEN_MONDAY,
      });
      const withExclude = await getAvailableSlots({
        db: db as unknown as D1Database,
        storeId: STORE_ID,
        date: OPEN_MONDAY,
        excludeReservationId: SELF_ID,
      });
      expect(without.ok && withExclude.ok).toBe(true);
      if (!without.ok || !withExclude.ok) return;

      expect(without.slots.find((s) => s.startAt === at1000())?.available).toBe(false);
      expect(withExclude.slots.find((s) => s.startAt === at1000())?.available).toBe(true);
      expect(withExclude.slots.every((s) => s.available)).toBe(true);
    });

    it("keeps another reservation's lock busy while excluding the target's", async () => {
      await insertSlotLock(db, RESOURCE_ID, at1000(), { ownerType: "reservation", ownerId: SELF_ID });
      await insertSlotLock(db, RESOURCE_ID, isoAtMinute(OPEN_MONDAY, OPEN_MINUTE + 60), {
        ownerType: "reservation",
        ownerId: OTHER_ID,
      });

      const result = await getAvailableSlots({
        db: db as unknown as D1Database,
        storeId: STORE_ID,
        date: OPEN_MONDAY,
        excludeReservationId: SELF_ID,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.slots.find((s) => s.startAt === at1000())?.available).toBe(true);
      expect(
        result.slots.find((s) => s.startAt === isoAtMinute(OPEN_MONDAY, OPEN_MINUTE + 60))?.available
      ).toBe(false);
    });

    it("does not exclude a non-reservation lock that shares the owner id", async () => {
      // admin_hold / external_block owners must never be unmasked, even on id collision.
      await insertSlotLock(db, RESOURCE_ID, at1000(), { ownerType: "admin_hold", ownerId: SELF_ID });

      const result = await getAvailableSlots({
        db: db as unknown as D1Database,
        storeId: STORE_ID,
        date: OPEN_MONDAY,
        excludeReservationId: SELF_ID,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.slots.find((s) => s.startAt === at1000())?.available).toBe(false);
    });
  });

  describe("customerId (customer time-conflict exclusion)", () => {
    const CUSTOMER_ID = "cust-availability";
    const at1000 = () => isoAtMinute(OPEN_MONDAY, OPEN_MINUTE);

    beforeEach(async () => {
      await insertCustomer(db, CUSTOMER_ID);
    });

    it("marks slots overlapping the customer's other bookings unavailable, on every resource", async () => {
      await db
        .prepare(
          `INSERT INTO store_resources (id, store_id, name, resource_type)
           VALUES ('resource_kyoto_2', ?, 'Example Calendar A2', 'staff_calendar')`
        )
        .bind(STORE_ID)
        .run();
      await insertCustomerTimeLock(db, CUSTOMER_ID, at1000());

      const without = await getAvailableSlots({
        db: db as unknown as D1Database,
        storeId: STORE_ID,
        date: OPEN_MONDAY,
      });
      const withCustomer = await getAvailableSlots({
        db: db as unknown as D1Database,
        storeId: STORE_ID,
        date: OPEN_MONDAY,
        customerId: CUSTOMER_ID,
      });
      expect(without.ok && withCustomer.ok).toBe(true);
      if (!without.ok || !withCustomer.ok) return;

      expect(without.slots.every((s) => s.available)).toBe(true);
      // customer_time_locks has no resource column: the busy window blanks the
      // 10:00 candidate on BOTH resource columns.
      const busy = withCustomer.slots.filter((s) => !s.available);
      expect(busy.map((s) => s.startAt)).toEqual([at1000(), at1000()]);
      expect(new Set(busy.map((s) => s.resourceId)).size).toBe(2);
    });

    it("excludes the target reservation's own customer lock but keeps other bookings busy", async () => {
      const SELF_ID = "resv-self";
      await insertCustomerTimeLock(db, CUSTOMER_ID, at1000(), { ownerId: SELF_ID });
      await insertCustomerTimeLock(db, CUSTOMER_ID, isoAtMinute(OPEN_MONDAY, OPEN_MINUTE + 60), {
        ownerId: "resv-other",
      });

      const result = await getAvailableSlots({
        db: db as unknown as D1Database,
        storeId: STORE_ID,
        date: OPEN_MONDAY,
        customerId: CUSTOMER_ID,
        excludeReservationId: SELF_ID,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.slots.find((s) => s.startAt === at1000())?.available).toBe(true);
      expect(
        result.slots.find((s) => s.startAt === isoAtMinute(OPEN_MONDAY, OPEN_MINUTE + 60))?.available
      ).toBe(false);
    });
  });

  describe("expired pending locks stay busy (no TTL filtering — regression pin)", () => {
    // The admin create/reschedule batches do NOT delete expired pending lock
    // rows before INSERT (unlike public-submit), so the picker must keep them
    // busy or it would offer slots the UNIQUE constraint rejects at submit.
    const PAST_EXPIRES = "2020-01-01T00:00:00.000Z";

    it("slot_locks: expired pending row still blocks its slot", async () => {
      await insertSlotLock(db, RESOURCE_ID, isoAtMinute(OPEN_MONDAY, OPEN_MINUTE), {
        ownerType: "reservation",
        ownerId: "resv-stale",
        lockStatus: "pending",
        expiresAt: PAST_EXPIRES,
      });

      const result = await getAvailableSlots({
        db: db as unknown as D1Database,
        storeId: STORE_ID,
        date: OPEN_MONDAY,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(
        result.slots.find((s) => s.startAt === isoAtMinute(OPEN_MONDAY, OPEN_MINUTE))?.available
      ).toBe(false);
    });

    it("customer_time_locks: expired pending row still blocks its slot", async () => {
      await insertCustomer(db, "cust-stale");
      await insertCustomerTimeLock(db, "cust-stale", isoAtMinute(OPEN_MONDAY, OPEN_MINUTE), {
        lockStatus: "pending",
        expiresAt: PAST_EXPIRES,
      });

      const result = await getAvailableSlots({
        db: db as unknown as D1Database,
        storeId: STORE_ID,
        date: OPEN_MONDAY,
        customerId: "cust-stale",
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(
        result.slots.find((s) => s.startAt === isoAtMinute(OPEN_MONDAY, OPEN_MINUTE))?.available
      ).toBe(false);
    });
  });

  it("restricts results to a single resource when resourceId is given", async () => {
    await db
      .prepare(
        `INSERT INTO store_resources (id, store_id, name, resource_type)
         VALUES ('resource_kyoto_2', ?, 'Example Calendar A2', 'staff_calendar')`
      )
      .bind(STORE_ID)
      .run();

    const all = await getAvailableSlots({
      db: db as unknown as D1Database,
      storeId: STORE_ID,
      date: OPEN_MONDAY,
    });
    const filtered = await getAvailableSlots({
      db: db as unknown as D1Database,
      storeId: STORE_ID,
      date: OPEN_MONDAY,
      resourceId: RESOURCE_ID,
    });
    expect(all.ok && filtered.ok).toBe(true);
    if (!all.ok || !filtered.ok) return;

    expect(all.slots).toHaveLength(expectedSlotCount(15) * 2);
    expect(filtered.slots).toHaveLength(expectedSlotCount(15));
    expect(filtered.slots.every((s) => s.resourceId === RESOURCE_ID)).toBe(true);
  });
});
