export const RESERVATION_ACTION_MUTATION_KEY = ["reservation-action"] as const;
export const RESERVATION_CAP_MUTATION_KEY = ["settings", "reservation-cap", "update"] as const;
export const BOOKING_WINDOW_MUTATION_KEY = ["settings", "booking-window", "update"] as const;
export const CUSTOMER_NOTICE_MUTATION_KEY = ["settings", "customer-notice", "update"] as const;

/** Collect all entity ids represented by concurrent TanStack Query mutations. */
export const collectPendingMutationIds = (
  variables: readonly unknown[],
  field: "reservationId" | "storeId",
): ReadonlySet<string> => {
  const ids = new Set<string>();
  for (const value of variables) {
    if (typeof value !== "object" || value === null) continue;
    const candidate = (value as Record<string, unknown>)[field];
    if (typeof candidate === "string" && candidate.length > 0) {
      ids.add(candidate);
    }
  }
  return ids;
};
