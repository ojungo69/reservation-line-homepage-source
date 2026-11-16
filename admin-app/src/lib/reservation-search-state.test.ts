import { describe, expect, it } from "vitest";
import { reservationPresetRange, readReservationSearchState } from "./reservation-search-state";

describe("reservation search view state", () => {
  it("uses inclusive30 JST calendar days across month boundaries", () => {
    const now = new Date("2026-01-30T15:00:00Z");
    expect(reservationPresetRange("today", now)).toEqual({ from: "2026-01-31", to: "2026-01-31" });
    expect(reservationPresetRange("upcoming", now)).toEqual({ from: "2026-01-31", to: "2026-03-01" });
    expect(reservationPresetRange("history", now)).toEqual({ from: "2026-01-02", to: "2026-01-31" });
  });

  it("restores only valid same-login fields without restoring a store selection", () => {
    const value = { from: "2026-10-18", to: "2026-11-16", keyword: "架空", serviceId: "__all__", statusFilter: "__all__", sortKey: "startAt", sortDir: "desc", viewMode: "history" };
    const state = { reservationSearch: { scope: "owner@example.invalid:owner:", value } };
    expect(readReservationSearchState(state, "owner@example.invalid:owner:")).toEqual(value);
    expect(readReservationSearchState(state, "staff@example.invalid:staff:store-1")).toBeNull();
    expect(readReservationSearchState({ reservationSearch: { ...state.reservationSearch, value: { ...value, sortKey: "unexpected" } } }, state.reservationSearch.scope)).toBeNull();
    expect(readReservationSearchState({ reservationSearch: { ...state.reservationSearch, value: { ...value, keyword: {} } } }, state.reservationSearch.scope)).toBeNull();
    expect(readReservationSearchState(null, state.reservationSearch.scope)).toBeNull();
  });
  it.each(["2026-02-31", "2026-02-29", "2026-13-01", "2026-04-31"])("rejects impossible history calendar day %s", (invalid) => {
    const value = { from: "2026-02-01", to: "2026-02-28", keyword: "", serviceId: "__all__", statusFilter: "__all__", sortKey: "startAt", sortDir: "asc", viewMode: "custom" };
    for (const field of ["from", "to"]) {
      expect(readReservationSearchState({ reservationSearch: { scope: "owner", value: { ...value, [field]: invalid } } }, "owner")).toBeNull();
    }
  });

  it("keeps empty date fields and real leap dates available to the view", () => {
    const value = { from: "", to: "2028-02-29", keyword: "", serviceId: "__all__", statusFilter: "__all__", sortKey: "startAt", sortDir: "asc", viewMode: "custom" };
    expect(readReservationSearchState({ reservationSearch: { scope: "owner", value } }, "owner")).toEqual(value);
    expect(readReservationSearchState({ reservationSearch: { scope: "owner", value: { ...value, from: "2028-02-29", to: "" } } }, "owner")).toMatchObject({ from: "2028-02-29", to: "" });
  });

});
