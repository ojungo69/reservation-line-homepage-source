import { describe, expect, it } from "vitest";

import { classifyReservationWriteError } from "../src/reservations/write-error";

describe("classifyReservationWriteError", () => {
  it.each([
    [new Error("store_closed"), "store_closed"],
    [new Error("UNIQUE constraint failed: slot_locks"), "slot_unavailable"],
    ["UNIQUE constraint failed: customer_time_locks.customer_id", "customer_time_conflict"],
  ] as const)("maps %s to %s", (error, expected) => {
    expect(classifyReservationWriteError(error)).toBe(expected);
  });

  it("leaves caller-specific failures unclassified", () => {
    expect(classifyReservationWriteError(new Error("blocked_customer"))).toBeNull();
  });
});
