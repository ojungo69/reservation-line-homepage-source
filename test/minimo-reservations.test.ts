import { describe, expect, it } from "vitest";
import { parseMinimoReservationDetail, parseMinimoReservationPage, parseMinimoStaffIds, parseMinimoBookableMenuDurations } from "../src/minimo/reservations";

const booking = { reservation_id: 42, staff_id: "staff-v2", status: 1, visit_datetime: "2026-10-01 10:00:00",
  customer_id: "discard", message_box_id: 9, menu_id: 8 };
const page = { _page: { current_page: 1, entities: 1, entities_by_page: 100, max_page: 1, type: "page" },
  reservations: [booking], _embed: { customers: [{ phone_number: "discard" }] } };

describe("Minimo reservation read contracts", () => {
  it("keeps only identity, status and date from the observed paginated shape", () => {
    expect(parseMinimoReservationPage(page, 1)).toEqual({ page: 1, maxPage: 1, total: 1,
      reservations: [{ id: "42", staffId: "staff-v2", status: "confirmed", date: "2026-10-01", startAt: "2026-10-01T01:00:00.000Z" }] });
    expect(parseMinimoReservationPage({ _page: { ...page._page, entities: 0, max_page: 0 }, reservations: [] }, 1).reservations).toEqual([]);
  });

  it.each([11, 12])("accepts an explicit cancellation %i without appointment details", (status) => {
    expect(parseMinimoReservationDetail({ reservation: { reservation_id: 42, staff_id: "staff-v2", status } }, "42"))
      .toEqual({ id: "42", staffId: "staff-v2", status: "cancelled", date: null, startAt: null });
  });

  it("validates observed staff identity and only bookable menu durations", () => {
    expect(parseMinimoStaffIds({ staffs: [{ staff_id: "first" }, { staff_id: "second" }] })).toEqual(["first", "second"]);
    expect(() => parseMinimoStaffIds({ staffs: [{ staff_id: "same" }, { staff_id: "same" }] })).toThrow();
    expect(parseMinimoBookableMenuDurations({ menus: [
      { is_open: true, is_enable: true, time_required: 120 },
      { is_open: false, is_enable: true, time_required: null },
      { is_open: true, is_enable: false, time_required: null }
    ] })).toEqual([120]);
    for (const row of [{ is_open: 1, is_enable: true, time_required: 120 },
      { is_open: true, is_enable: true, time_required: 121 },
      { is_open: true, is_enable: true, time_required: "120" }]) {
      expect(() => parseMinimoBookableMenuDurations({ menus: [row] })).toThrow();
    }
  });

  it("retains unknown statuses and rejects identity, paging and datetime mismatches", () => {
    expect(parseMinimoReservationDetail({ reservation: { ...booking, status: 999 } }, "42").status).toBe("ignored");
    expect(() => parseMinimoReservationDetail({ reservation: booking }, "other")).toThrow();
    for (const value of [null, {}, { ...page, reservations: null }, { ...page, reservations: [booking, booking] },
      { ...page, _page: { ...page._page, max_page: 101 } }, { ...page, _page: { ...page._page, current_page: 2 } },
      { ...page, reservations: [{ ...booking, status: undefined }] },
      { ...page, reservations: [{ ...booking, visit_datetime: "invalid" }] },
      { ...page, reservations: [{ ...booking, reservation_id: ".." }] }]) {
      expect(() => parseMinimoReservationPage(value, 1)).toThrow();
    }
  });
});
