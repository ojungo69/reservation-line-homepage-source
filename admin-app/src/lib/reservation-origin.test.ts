import { describe, expect, it } from "vitest";
import {
  RESERVATION_ORIGIN_OPTIONS,
  reservationOriginLabel,
  reservationSourceLabel,
} from "@/lib/reservation-origin";

describe("reservationOriginLabel", () => {
  it("maps the four known origins to JP labels", () => {
    expect(reservationOriginLabel("minimo")).toBe("minimo");
    expect(reservationOriginLabel("phone")).toBe("電話");
    expect(reservationOriginLabel("walk_in")).toBe("店頭");
    expect(reservationOriginLabel("other")).toBe("その他");
  });

  it("returns null for null and unknown values", () => {
    expect(reservationOriginLabel(null)).toBeNull();
    expect(reservationOriginLabel("instagram")).toBeNull();
    expect(reservationOriginLabel("")).toBeNull();
  });
});

describe("reservationSourceLabel", () => {
  it("maps technical source keys to JP labels", () => {
    expect(reservationSourceLabel("phone_admin")).toBe("手動予約");
    expect(reservationSourceLabel("admin")).toBe("手動予約");
    expect(reservationSourceLabel("web_line")).toBe("LINE予約");
    expect(reservationSourceLabel("system_import")).toBe("システム取込");
  });

  it("passes through an unrecognized source unchanged", () => {
    expect(reservationSourceLabel("unknown_source")).toBe("unknown_source");
  });
});

describe("RESERVATION_ORIGIN_OPTIONS", () => {
  it("offers current origins while keeping legacy phone labels readable", () => {
    expect(RESERVATION_ORIGIN_OPTIONS.map((o) => o.value)).toEqual([
      "minimo",
      "walk_in",
      "other",
    ]);
    expect(RESERVATION_ORIGIN_OPTIONS.map((o) => o.label)).toEqual([
      "minimo",
      "店頭",
      "その他",
    ]);
  });
});
