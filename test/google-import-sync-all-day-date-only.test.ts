import { describe, expect, it } from "vitest";
import { __testing__ } from "../src/google/import-sync";

const { createSafeSnapshot, readDateAsUtcIso, buildConflictSnapshot } = __testing__;

// ---------------------------------------------------------------------------
// readDateAsUtcIso — JST midnight interpretation
// ---------------------------------------------------------------------------

describe("readDateAsUtcIso", () => {
  it("converts a single-day date to UTC ISO Z (JST midnight)", () => {
    // 2026-05-25 JST midnight = 2026-05-24T15:00:00.000Z
    const result = readDateAsUtcIso("2026-05-25");
    expect(result).toBe("2026-05-24T15:00:00.000Z");
  });

  it("converts end.date (exclusive) for a 1-day all-day event", () => {
    // Google end.date='2026-05-26' (exclusive) → JST midnight
    const result = readDateAsUtcIso("2026-05-26");
    expect(result).toBe("2026-05-25T15:00:00.000Z");
  });

  it("handles multi-day ranges", () => {
    const start = readDateAsUtcIso("2026-12-28");
    const end = readDateAsUtcIso("2027-01-04");
    expect(start).toBe("2026-12-27T15:00:00.000Z");
    expect(end).toBe("2027-01-03T15:00:00.000Z");
  });

  it("returns null for invalid date format", () => {
    expect(readDateAsUtcIso("not-a-date")).toBeNull();
    expect(readDateAsUtcIso("2026/05/25")).toBeNull();
    expect(readDateAsUtcIso("")).toBeNull();
  });

  it("returns null for invalid date values", () => {
    expect(readDateAsUtcIso("9999-99-99")).toBeNull();
  });

  it("rejects dates that JavaScript silently normalizes (strict round-trip)", () => {
    // Feb 30 → JS normalizes to Mar 2, but strict validation rejects it
    expect(readDateAsUtcIso("2026-02-30")).toBeNull();
    // Apr 31 → JS normalizes to May 1
    expect(readDateAsUtcIso("2026-04-31")).toBeNull();
    // Month 13
    expect(readDateAsUtcIso("2026-13-01")).toBeNull();
    // Day 0
    expect(readDateAsUtcIso("2026-01-00")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// createSafeSnapshot — date-only all-day events
// ---------------------------------------------------------------------------

describe("createSafeSnapshot for all-day events", () => {
  it("produces start_at/end_at in UTC ISO Z for a 1-day all-day event", () => {
    const event = {
      id: "evt_allday_1",
      status: "confirmed",
      start: { date: "2026-05-25" },
      end: { date: "2026-05-26" },
      summary: "店休"
    };

    const snapshot = createSafeSnapshot(event);
    expect(snapshot).toBeDefined();
    expect(snapshot!.all_day).toBe(true);
    expect(snapshot!.start_at).toBe("2026-05-24T15:00:00.000Z");
    expect(snapshot!.end_at).toBe("2026-05-25T15:00:00.000Z");
    expect(snapshot!.start_date).toBe("2026-05-25");
    expect(snapshot!.end_date).toBe("2026-05-26");
  });

  it("produces correct UTC range for a multi-day all-day event", () => {
    const event = {
      id: "evt_allday_multi",
      status: "confirmed",
      start: { date: "2026-12-29" },
      end: { date: "2027-01-03" },
      summary: "年末年始休業"
    };

    const snapshot = createSafeSnapshot(event);
    expect(snapshot).toBeDefined();
    expect(snapshot!.all_day).toBe(true);
    expect(snapshot!.start_at).toBe("2026-12-28T15:00:00.000Z");
    expect(snapshot!.end_at).toBe("2027-01-02T15:00:00.000Z");
    expect(snapshot!.start_date).toBe("2026-12-29");
    expect(snapshot!.end_date).toBe("2027-01-03");
  });

  it("does not regress dateTime events (non-all-day)", () => {
    const event = {
      id: "evt_normal_1",
      status: "confirmed",
      start: { dateTime: "2026-05-25T10:00:00+09:00" },
      end: { dateTime: "2026-05-25T11:00:00+09:00" },
      summary: "通常予約"
    };

    const snapshot = createSafeSnapshot(event);
    expect(snapshot).toBeDefined();
    expect(snapshot!.all_day).toBe(false);
    expect(snapshot!.start_at).toBe("2026-05-25T01:00:00.000Z");
    expect(snapshot!.end_at).toBe("2026-05-25T02:00:00.000Z");
    // date-only fields should NOT be present
    expect(snapshot!.start_date).toBeUndefined();
    expect(snapshot!.end_date).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// buildConflictSnapshot — includes date-only fields
// ---------------------------------------------------------------------------

describe("buildConflictSnapshot with date-only fields", () => {
  it("includes start_date and end_date in conflict snapshot for all-day events", () => {
    const event = {
      id: "evt_allday_snapshot",
      status: "confirmed",
      start: { date: "2026-06-15" },
      end: { date: "2026-06-16" },
      summary: "店休 2026-06-15"
    };

    const safe = createSafeSnapshot(event)!;
    const conflict = buildConflictSnapshot(safe, event);

    expect(conflict.summary).toBe("店休 2026-06-15");
    expect(conflict.start_date).toBe("2026-06-15");
    expect(conflict.end_date).toBe("2026-06-16");
    expect(conflict.start_at).toBe("2026-06-14T15:00:00.000Z");
    expect(conflict.end_at).toBe("2026-06-15T15:00:00.000Z");
    expect(conflict.all_day).toBe(true);
  });

  it("does not include date-only fields for dateTime events", () => {
    const event = {
      id: "evt_normal_snapshot",
      status: "confirmed",
      start: { dateTime: "2026-06-15T10:00:00+09:00" },
      end: { dateTime: "2026-06-15T11:00:00+09:00" },
      summary: "通常ブロック"
    };

    const safe = createSafeSnapshot(event)!;
    const conflict = buildConflictSnapshot(safe, event);

    expect(conflict.start_date).toBeUndefined();
    expect(conflict.end_date).toBeUndefined();
    expect(conflict.all_day).toBe(false);
  });
});
