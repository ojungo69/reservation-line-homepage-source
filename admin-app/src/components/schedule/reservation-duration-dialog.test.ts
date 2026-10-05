import { describe, it, expect } from "vitest";
import { occupancyToTreatment } from "./reservation-duration-dialog";

describe("occupancyToTreatment", () => {
  it("subtracts the 5-min buffer from occupancy", () => {
    // 09:00–10:00 = 60分占有 → 施術55分
    expect(occupancyToTreatment("2026-09-01T09:00:00+09:00", "2026-09-01T10:00:00+09:00")).toBe(55);
  });

  it("floors at the minimum treatment when occupancy is tiny", () => {
    // 09:00–09:05 = 5分占有 → max(5, 0) = 5
    expect(occupancyToTreatment("2026-09-01T09:00:00+09:00", "2026-09-01T09:05:00+09:00")).toBe(5);
  });

  it("handles a longer occupancy", () => {
    // 09:00–11:00 = 120分占有 → 施術115分
    expect(occupancyToTreatment("2026-09-01T09:00:00+09:00", "2026-09-01T11:00:00+09:00")).toBe(115);
  });
});
