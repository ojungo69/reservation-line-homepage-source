export type ReservationWriteConflictReason =
  | "store_closed"
  | "slot_unavailable"
  | "customer_time_conflict";

export const classifyReservationWriteError = (
  error: unknown,
): ReservationWriteConflictReason | null => {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("store_closed")) return "store_closed";
  if (message.includes("slot_locks")) return "slot_unavailable";
  if (message.includes("customer_time_locks")) return "customer_time_conflict";
  return null;
};
