import { describe, expect, it } from "vitest";
import { planOutboundDay } from "../src/minimo/outbound";

const date = "2026-09-29";
const at = (time: string) => `${date}T${time}:00.000Z`;
const account = {
  storeId: "osaka", salonId: "salon-osaka", password: "synthetic", intervalMinutes: 30,
  staff: [{ rimaUserId: "artist-1", resourceId: "resource-osaka", maxDurationMinutes: 90 }]
};
const schedule = {
  date,
  entries: [
    { staffId: "artist-1", openSlots: [at("01:00"), at("03:00")], reservations: [] },
    { staffId: "unmapped", openSlots: [at("01:00")], reservations: [] }
  ]
};
const now = Date.parse(at("00:00"));
const inputs = {
  intervals: [{ resourceId: "resource-osaka", startAt: at("02:00"), endAt: at("03:00") }],
  hours: [{ opensAt: "10:00", closesAt: "20:00" }]
};

describe("Minimo availability ownership", () => {
  it("closes a 90-minute start overlapping busy time and reopens only its own closure", () => {
    const closed = planOutboundDay(account, schedule, inputs, null, now);
    expect(closed.schedule.entries[0].openSlots).toEqual([at("03:00")]);
    expect(closed.schedule.entries[1].openSlots).toEqual([at("01:00")]);
    expect(closed.owned).toEqual({ "artist-1": [at("01:00")] });
    expect(closed.closed).toBe(1);
    const reopened = planOutboundDay(account, closed.schedule, { ...inputs, intervals: [] },
      { snapshot: closed.schedule, owned: closed.owned }, now);
    expect(reopened.schedule.entries[0].openSlots).toEqual([at("01:00"), at("03:00")]);
    expect(reopened.reopened).toBe(1);
    expect(reopened.owned).toEqual({});
  });

  it("does not reopen a manually closed start or a slot occupied by a new remote booking", () => {
    const manual = { ...schedule, entries: [{ staffId: "artist-1", openSlots: [at("03:00")], reservations: [] }] };
    expect(planOutboundDay(account, manual, { ...inputs, intervals: [] }, null, now)
      .schedule.entries[0].openSlots).toEqual([at("03:00")]);
    const closed = planOutboundDay(account, schedule, inputs, null, now);
    const booked = { ...closed.schedule, entries: closed.schedule.entries.map((entry) => entry.staffId === "artist-1"
      ? { ...entry, reservations: [{ id: "remote-new", staffId: "artist-1", status: "confirmed" as const, startAt: at("01:30"), endAt: at("02:30") }] }
      : entry) };
    const plan = planOutboundDay(account, booked, { ...inputs, intervals: [] },
      { snapshot: closed.schedule, owned: closed.owned }, now);
    expect(plan.reopened).toBe(0);
    expect(plan.schedule.entries[0].openSlots).toEqual([at("03:00")]);
  });

  it("rejects remote availability edits and missing mapped staff", () => {
    const closed = planOutboundDay(account, schedule, inputs, null, now);
    expect(() => planOutboundDay(account, schedule, inputs,
      { snapshot: closed.schedule, owned: closed.owned }, now)).toThrow("minimo_remote_changed");
    expect(() => planOutboundDay(account, { date, entries: [] }, inputs, null, now))
      .toThrow("minimo_staff_missing");
  });

  it("stops the day when a mapped staff reservation has an unknown or missing status", () => {
    const withReservation = (staffId: string) => ({ ...schedule, entries: schedule.entries.map((entry) => entry.staffId === staffId
      ? { ...entry, reservations: [{ id: "remote-unknown", staffId, status: "ignored" as const, startAt: null, endAt: null }] }
      : entry) });
    expect(() => planOutboundDay(account, withReservation("artist-1"), { ...inputs, intervals: [] }, null, now))
      .toThrow("minimo_unknown_reservation_status");
    expect(planOutboundDay(account, withReservation("unmapped"), { ...inputs, intervals: [] }, null, now).changed).toBe(false);
  });

  it("honors closed days and ignores another resource's busy interval", () => {
    expect(planOutboundDay(account, schedule, { intervals: [], hours: [] }, null, now).closed).toBe(2);
    expect(planOutboundDay(account, schedule,
      { ...inputs, intervals: [{ ...inputs.intervals[0], resourceId: "different-resource" }] }, null, now).closed).toBe(0);
    expect(planOutboundDay(account, schedule,
      { ...inputs, intervals: [{ ...inputs.intervals[0], resourceId: null }] }, null, now).closed).toBe(1);
  });
});
