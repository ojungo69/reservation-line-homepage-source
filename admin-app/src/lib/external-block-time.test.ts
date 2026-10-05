import { describe, expect, it } from "vitest";
import {
  buildExternalBlockTimes,
  EXTERNAL_BLOCK_TIME_MESSAGES,
} from "./external-block-time";

describe("buildExternalBlockTimes", () => {
  it("converts valid JST datetime-local values to UTC ISO boundaries", () => {
    expect(
      buildExternalBlockTimes(
        "2026-07-24T10:00",
        "2026-07-24T11:05",
      ),
    ).toEqual({
      ok: true,
      startAt: "2026-07-24T01:00:00.000Z",
      endAt: "2026-07-24T02:05:00.000Z",
    });
  });

  it.each([
    ["", "2026-07-24T11:00", "missing_start"],
    ["2026-07-24T10:00", "", "missing_end"],
  ])(
    "reports a missing boundary",
    (start, end, reason) => {
      expect(buildExternalBlockTimes(start, end)).toEqual({
        ok: false,
        reason,
      });
    },
  );

  it.each([
    ["not-a-date", "2026-07-24T11:00", "invalid_start"],
    ["2026-07-24T10:00:30", "2026-07-24T11:00", "invalid_start"],
    ["2026-07-24T25:00", "2026-07-24T11:00", "invalid_start"],
    ["2026-02-30T10:00", "2026-03-02T11:00", "invalid_start"],
    ["2026-07-24T10:00", "not-a-date", "invalid_end"],
    ["2026-07-24T10:00", "2025-02-29T11:00", "invalid_end"],
  ])(
    "rejects malformed or nonexistent local dates",
    (start, end, reason) => {
      expect(buildExternalBlockTimes(start, end)).toEqual({
        ok: false,
        reason,
      });
    },
  );

  it.each([
    ["2026-07-24T10:02", "2026-07-24T11:00"],
    ["2026-07-24T10:00", "2026-07-24T11:03"],
  ])(
    "requires both ends to be on a five-minute boundary",
    (start, end) => {
      expect(buildExternalBlockTimes(start, end)).toEqual({
        ok: false,
        reason: "not_slot_boundary",
      });
    },
  );

  it.each([
    ["2026-07-24T10:00", "2026-07-24T10:00"],
    ["2026-07-24T10:05", "2026-07-24T10:00"],
  ])(
    "requires the end to be later than the start",
    (start, end) => {
      expect(buildExternalBlockTimes(start, end)).toEqual({
        ok: false,
        reason: "invalid_range",
      });
    },
  );

  it("accepts a real leap day", () => {
    expect(
      buildExternalBlockTimes(
        "2028-02-29T23:55",
        "2028-03-01T00:05",
      ),
    ).toEqual({
      ok: true,
      startAt: "2028-02-29T14:55:00.000Z",
      endAt: "2028-02-29T15:05:00.000Z",
    });
  });
});

describe("EXTERNAL_BLOCK_TIME_MESSAGES", () => {
  it("provides the exact user-facing message for every failure reason", () => {
    expect(EXTERNAL_BLOCK_TIME_MESSAGES).toEqual({
      missing_start: "開始日時を入力してください",
      missing_end: "終了日時を入力してください",
      invalid_start: "開始日時が正しくありません",
      invalid_end: "終了日時が正しくありません",
      not_slot_boundary: "時刻は5分単位で指定してください",
      invalid_range: "終了日時は開始日時より後にしてください",
    });
  });
});
