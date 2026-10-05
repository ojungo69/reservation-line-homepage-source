import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { WorkerBindings } from "../src/bindings";
import { narrowHoursForMensMenu } from "../src/reservations/business-hours";
import { listPublicAvailability } from "../src/reservations/public-options";
import { createMigratedSqliteD1, type SqliteD1Database } from "./helpers/sqlite-d1";

// NOW = 2026-05-09T23:00:00Z = 2026-05-10 08:00 JST, so "today" in Asia/Tokyo is
// 2026-05-10. The per-store window is `today .. today + booking_window_days` (the
// upper bound is INCLUSIVE — isDateInAvailabilityWindow uses dayStart <= latestStart).
const NOW_MS = Date.parse("2026-05-09T23:00:00.000Z");

// Google live availability OFF → availability is computed purely from D1, so the
// window check is exercised without any Google fetch wiring.
const DISABLED_ENV: Partial<WorkerBindings> = {
  GOOGLE_IMPORT_ENABLED: "true",
  GOOGLE_LIVE_AVAILABILITY_ENABLED: "false"
};

const setWindow = (d1: SqliteD1Database, days: number) => {
  d1.sqlite.prepare("UPDATE store_settings SET booking_window_days = ? WHERE store_id = 'kyoto'").run(days);
};

const requestAvailability = (d1: SqliteD1Database, date: string) =>
  listPublicAvailability({
    db: d1 as unknown as D1Database,
    env: DISABLED_ENV,
    storeId: "kyoto",
    serviceId: "service_kyoto_default_60",
    resourceId: "resource_kyoto_calendar",
    date,
    now: () => NOW_MS
  });

describe("narrowHoursForMensMenu", () => {
  const hours = [
    { id: "morning", opens_at: "08:00", closes_at: "21:00" },
    { id: "late", opens_at: "14:00", closes_at: "20:00" }
  ] as const;

  it("keeps Tuesday business hours unchanged", () => {
    expect(narrowHoursForMensMenu("kyoto", 2, true, hours)).toEqual(hours);
  });

  it.each([0, 3, 6])("raises weekday %i opening times to 13:00", (weekday) => {
    expect(narrowHoursForMensMenu("kyoto", weekday, true, hours)).toEqual([
      { id: "morning", opens_at: "13:00", closes_at: "21:00" },
      { id: "late", opens_at: "14:00", closes_at: "20:00" }
    ]);
  });

  it.each([1, 4, 5])("closes weekday %i to men's menus", (weekday) => {
    expect(narrowHoursForMensMenu("kyoto", weekday, true, hours)).toEqual([]);
  });

  it("does not alter other stores or ordinary menus", () => {
    expect(narrowHoursForMensMenu("osaka", 1, true, hours)).toEqual(hours);
    expect(narrowHoursForMensMenu("kyoto", 1, false, hours)).toEqual(hours);
  });

  it("keeps later openings and removes rows closed by 13:00", () => {
    expect(
      narrowHoursForMensMenu("kyoto", 3, true, [
        { opens_at: "14:00", closes_at: "20:00" },
        { opens_at: "08:00", closes_at: "13:00" }
      ])
    ).toEqual([{ opens_at: "14:00", closes_at: "20:00" }]);
  });
});

describe("public availability — per-store booking window (store_settings.booking_window_days)", () => {
  let d1: SqliteD1Database;

  beforeEach(() => {
    d1 = createMigratedSqliteD1();
  });

  afterEach(() => {
    d1.sqlite.close();
  });

  it("defaults to a 30-day window for the seeded store (migration default)", async () => {
    // Within 30 days → accepted (reason is never invalid_request for an in-window date).
    const within = await requestAvailability(d1, "2026-06-01");
    expect(within.ok).toBe(true);

    // Day 30 (2026-06-09) is the inclusive boundary → still accepted.
    const boundary = await requestAvailability(d1, "2026-06-09");
    expect(boundary.ok).toBe(true);

    // Day 31 (2026-06-10) is one past the window → rejected.
    const justBeyond = await requestAvailability(d1, "2026-06-10");
    expect(justBeyond).toEqual({ ok: false, reason: "invalid_request" });

    // Far beyond → rejected.
    const farBeyond = await requestAvailability(d1, "2026-07-15");
    expect(farBeyond).toEqual({ ok: false, reason: "invalid_request" });
  });

  it("accepts a legacy serviceId whose raw length exceeds 128 only because of padding", async () => {
    // 旧 public-options 実装は trim 後の値で128字上限を判定していた。共有ヘルパー化
    // （trim 前判定）で観測可能な回帰にならないよう、呼び出し側の事前 trim を固定する。
    const padded = " ".repeat(110) + "service_kyoto_default_60";
    expect(padded.length).toBeGreaterThan(128);

    const result = await listPublicAvailability({
      db: d1 as unknown as D1Database,
      env: DISABLED_ENV,
      storeId: "kyoto",
      serviceId: padded,
      resourceId: "resource_kyoto_calendar",
      date: "2026-06-01",
      now: () => NOW_MS
    });
    expect(result.ok).toBe(true);
  });

  it("rejects service combinations above 235 treatment minutes with a dedicated reason", async () => {
    const result = await listPublicAvailability({
      db: d1 as unknown as D1Database,
      env: DISABLED_ENV,
      storeId: "kyoto",
      serviceId: "service_kyoto_massage_back_long_90",
      serviceIds: [
        "service_kyoto_massage_back_long_90",
        "service_kyoto_hair_removal_kids_full_60",
        "service_kyoto_massage_kassa_60",
        "service_kyoto_foot_nail_one_color_60"
      ],
      resourceId: "resource_kyoto_calendar",
      date: "2026-06-01",
      now: () => NOW_MS
    });

    expect(result).toEqual({ ok: false, reason: "duration_limit_exceeded" });
  });

  it("widening the window to 90 days admits a date the 30-day window rejected", async () => {
    const before = await requestAvailability(d1, "2026-07-15");
    expect(before).toEqual({ ok: false, reason: "invalid_request" });

    setWindow(d1, 90);

    const after = await requestAvailability(d1, "2026-07-15");
    expect(after.ok).toBe(true);
  });

  it("narrowing the window to 7 days rejects a date the default window allowed", async () => {
    const before = await requestAvailability(d1, "2026-06-01");
    expect(before.ok).toBe(true);

    setWindow(d1, 7);

    // Window now 2026-05-10 .. 2026-05-17; 2026-06-01 is far beyond.
    const after = await requestAvailability(d1, "2026-06-01");
    expect(after).toEqual({ ok: false, reason: "invalid_request" });

    // A date inside the 7-day window is still accepted.
    const inside = await requestAvailability(d1, "2026-05-15");
    expect(inside.ok).toBe(true);
  });

  it("falls back to a 30-day window when the store has no store_settings row", async () => {
    d1.sqlite.prepare("DELETE FROM store_settings WHERE store_id = 'kyoto'").run();

    const within = await requestAvailability(d1, "2026-06-01");
    expect(within.ok).toBe(true);

    const beyond = await requestAvailability(d1, "2026-06-10");
    expect(beyond).toEqual({ ok: false, reason: "invalid_request" });
  });
});

describe("public availability — Kyoto men's menu hours", () => {
  let d1: SqliteD1Database;

  beforeEach(() => {
    d1 = createMigratedSqliteD1();
    d1.sqlite
      .prepare(
        `UPDATE store_business_hours
         SET opens_at = '08:00', closes_at = '21:00'
         WHERE store_id IN ('kyoto', 'osaka')`
      )
      .run();
    // Exercise the store fence independently from naming and seeded defaults.
    d1.sqlite
      .prepare(
        `UPDATE services
         SET mens_menu = 1
         WHERE id = 'service_osaka_hair_removal_vio_men_45'`
      )
      .run();
  });

  afterEach(() => {
    d1.sqlite.close();
  });

  const availability = (
    storeId: string,
    serviceIds: string[],
    date: string
  ) =>
    listPublicAvailability({
      db: d1 as unknown as D1Database,
      env: DISABLED_ENV,
      storeId,
      serviceId: serviceIds[0],
      serviceIds,
      resourceId: `resource_${storeId}_calendar`,
      date,
      now: () => NOW_MS
    });

  it("uses the full Tuesday hours and returns the men's notice", async () => {
    const result = await availability(
      "kyoto",
      ["service_kyoto_mens_hair_removal_beard_30"],
      "2026-05-12"
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    expect(result.slots[0]?.startAt).toBe("2026-05-11T23:00:00.000Z");
    expect(result.notice).toBe(
      "メンズメニューのご予約は、火曜日は営業時間内すべて、水・土・日曜日は13時以降のみ承っております（月・木曜日はメンズメニューのご予約を承っておりません）。"
    );
  });

  it("starts Wednesday at 13:00 and returns no Monday slots", async () => {
    const wednesday = await availability(
      "kyoto",
      ["service_kyoto_mens_hair_removal_beard_30"],
      "2026-05-13"
    );
    expect(wednesday.ok).toBe(true);
    if (!wednesday.ok) throw new Error(wednesday.reason);
    expect(wednesday.slots[0]?.startAt).toBe("2026-05-13T04:00:00.000Z");
    expect(
      wednesday.slots.every((slot) => slot.startAt >= "2026-05-13T04:00:00.000Z")
    ).toBe(true);

    const monday = await availability(
      "kyoto",
      ["service_kyoto_mens_hair_removal_beard_30"],
      "2026-05-11"
    );
    expect(monday.ok).toBe(true);
    if (!monday.ok) throw new Error(monday.reason);
    expect(monday.slots).toEqual([]);
  });

  it("leaves ordinary menus unchanged and lets a men's selection win in a combination", async () => {
    const ordinary = await availability(
      "kyoto",
      ["service_kyoto_default_60"],
      "2026-05-11"
    );
    expect(ordinary.ok).toBe(true);
    if (!ordinary.ok) throw new Error(ordinary.reason);
    expect(ordinary.slots[0]?.startAt).toBe("2026-05-10T23:00:00.000Z");
    expect("notice" in ordinary).toBe(false);

    const combined = await availability(
      "kyoto",
      [
        "service_kyoto_default_60",
        "service_kyoto_mens_hair_removal_beard_30"
      ],
      "2026-05-11"
    );
    expect(combined.ok).toBe(true);
    if (!combined.ok) throw new Error(combined.reason);
    expect(combined.slots).toEqual([]);
  });

  it("does not restrict an Osaka service marked as a men's menu", async () => {
    const result = await availability(
      "osaka",
      ["service_osaka_hair_removal_vio_men_45"],
      "2026-05-11"
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    expect(result.slots[0]?.startAt).toBe("2026-05-10T23:00:00.000Z");
    expect("notice" in result).toBe(false);
  });
});
