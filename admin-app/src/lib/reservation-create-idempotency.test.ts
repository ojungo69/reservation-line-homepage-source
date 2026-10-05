import { describe, expect, it } from "vitest";

import {
  createReservationPayloadSignature,
  resolveReservationCreateKey,
} from "./reservation-create-idempotency";

const basePayload = {
  storeId: "store_1",
  serviceIds: ["service_1"],
  serviceId: "service_1",
  resourceId: "resource_1",
  startAt: "2026-08-01T10:00:00+09:00",
  origin: "walk_in" as const,
  customerId: "customer_1",
};

describe("reservation create idempotency", () => {
  it("reuses the key when the payload is unchanged", () => {
    let minted = 0;
    const signature = createReservationPayloadSignature(basePayload);
    const first = resolveReservationCreateKey(null, signature, () => `key-${++minted}`);
    const retry = resolveReservationCreateKey(first, signature, () => `key-${++minted}`);

    expect(retry).toBe(first);
    expect(retry.key).toBe("key-1");
    expect(minted).toBe(1);
  });

  it("mints a new key when the payload changes", () => {
    let minted = 0;
    const first = resolveReservationCreateKey(
      null,
      createReservationPayloadSignature(basePayload),
      () => `key-${++minted}`,
    );
    const changed = resolveReservationCreateKey(
      first,
      createReservationPayloadSignature({ ...basePayload, resourceId: "resource_2" }),
      () => `key-${++minted}`,
    );

    expect(changed).toEqual({
      signature: createReservationPayloadSignature({ ...basePayload, resourceId: "resource_2" }),
      key: "key-2",
    });
  });

  it("produces the same signature regardless of object property insertion order", () => {
    const reordered = {
      customerId: "customer_1",
      origin: "walk_in" as const,
      startAt: "2026-08-01T10:00:00+09:00",
      resourceId: "resource_1",
      serviceId: "service_1",
      serviceIds: ["service_1"],
      storeId: "store_1",
    };

    expect(createReservationPayloadSignature(reordered)).toBe(
      createReservationPayloadSignature(basePayload),
    );
  });

  it("starts a fresh key lifecycle after success clears the previous state", () => {
    let minted = 0;
    const signature = createReservationPayloadSignature(basePayload);
    const first = resolveReservationCreateKey(null, signature, () => `key-${++minted}`);
    const afterSuccess = resolveReservationCreateKey(null, signature, () => `key-${++minted}`);

    expect(afterSuccess.key).toBe("key-2");
    expect(afterSuccess).not.toBe(first);
  });
});
