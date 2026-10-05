import { describe, expect, it } from "vitest";

import { collectPendingMutationIds } from "./pending-mutation-ids";

describe("collectPendingMutationIds", () => {
  it("collects every concurrent reservation id, including the first and last mutation", () => {
    const result = collectPendingMutationIds(
      [
        { reservationId: "reservation_first", action: "approve" },
        { reservationId: "reservation_middle", action: "reject" },
        { reservationId: "reservation_last", action: "approve" },
      ],
      "reservationId",
    );

    expect([...result]).toEqual([
      "reservation_first",
      "reservation_middle",
      "reservation_last",
    ]);
  });

  it("collects unique store ids and ignores malformed mutation variables", () => {
    const result = collectPendingMutationIds(
      [
        { storeId: "store_a" },
        undefined,
        { storeId: "" },
        { storeId: 42 },
        { storeId: "store_b" },
        { storeId: "store_a" },
      ],
      "storeId",
    );

    expect([...result]).toEqual(["store_a", "store_b"]);
  });
});
