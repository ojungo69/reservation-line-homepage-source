import type { CreateReservationPayload } from "@/types/api";

export type ReservationCreatePayloadWithoutKey = CreateReservationPayload extends infer Payload
  ? Payload extends unknown
    ? Omit<Payload, "idempotencyKey">
    : never
  : never;

export type ReservationCreateKeyState = {
  signature: string;
  key: string;
};

const sortForStableJson = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(sortForStableJson);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entryValue]) => [key, sortForStableJson(entryValue)]),
  );
};

export const createReservationPayloadSignature = (
  payload: ReservationCreatePayloadWithoutKey,
): string => JSON.stringify(sortForStableJson(payload));

/**
 * Keep the same key only while retrying the exact same reservation payload.
 * A changed payload represents a new operation and must not replay the prior result.
 */
export const resolveReservationCreateKey = (
  previous: ReservationCreateKeyState | null,
  signature: string,
  mintKey: () => string,
): ReservationCreateKeyState => {
  if (previous?.signature === signature) return previous;
  return { signature, key: mintKey() };
};
