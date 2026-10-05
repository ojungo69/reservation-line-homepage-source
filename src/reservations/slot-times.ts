/**
 * Phase 3 slot-time generator (ISO-in, ISO-out).
 *
 * Returns the ISO timestamps that represent the start of each lock-interval
 * slot covering the half-open range [startAtIso, endAtIso). The terminal
 * boundary is NEVER included (Codex review iter3: "終端 slot を含まない").
 *
 * Duration and Date-range adapters below keep legacy callers on the same
 * half-open slot semantics while centralizing validation and overflow capping.
 */

/**
 * Cleanup gap every booking occupies after its treatment ends. A reservation's real
 * occupancy — the span that takes slot_locks and must fit inside store hours — is
 * always `services.duration_minutes + RESERVATION_INTERVAL_MINUTES`. Any path that
 * lays out or validates bookings and forgets it will offer slots the write paths
 * reject (admin available-slots did, until 2026-07-15).
 */
export const RESERVATION_INTERVAL_MINUTES = 5;

// Grid unit for slot_locks: a reservation's occupancy is tiled into locks of this
// many minutes, and generateSlotTimesForDuration is called with it. A service's
// duration must be a whole multiple of this grid to be bookable. Semantically
// DISTINCT from RESERVATION_INTERVAL_MINUTES (the post-treatment cleanup buffer):
// they are equal today but govern different things — keep the "duration aligns to
// the write grid" check on THIS constant, not the cleanup buffer (both public and
// admin create paths used this grid unit before the check moved into
// collectBookingServices).
export const SLOT_LOCK_INTERVAL_MINUTES = 5;
export const MAX_SERVICE_SELECTIONS = 12;
// Reschedule approval (validateRescheduleSlots in transitions.ts) hard-rejects a
// span needing more than 48 five-minute slot_locks (4h occupancy). Cap admin and
// public multi-service creation to the same envelope — 48×5 minus the cleanup buffer —
// so every reservation created by the admin or public path stays reschedulable later.
export const MAX_TOTAL_SERVICE_DURATION_MINUTES = 48 * 5 - RESERVATION_INTERVAL_MINUTES;

export const normalizeServiceIds = (
  serviceIds: readonly unknown[] | undefined,
  fallbackServiceId?: unknown
) => {
  let rawIds: readonly unknown[];
  if (Array.isArray(serviceIds) && serviceIds.length > 0) {
    rawIds = serviceIds;
  } else if (fallbackServiceId === undefined) {
    rawIds = [];
  } else {
    rawIds = [fallbackServiceId];
  }
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const rawId of rawIds) {
    if (typeof rawId !== "string" || rawId.length > 128) {
      continue;
    }
    const id = rawId.trim();
    if (!id || seen.has(id)) {
      continue;
    }
    seen.add(id);
    normalized.push(id);
    if (normalized.length >= MAX_SERVICE_SELECTIONS) {
      break;
    }
  }
  return normalized;
};

export const calculateReservationDuration = (durations: number[]) =>
  durations.reduce((total, duration) => total + duration, 0) + RESERVATION_INTERVAL_MINUTES;

// フォト光アドオン（サービスID接尾辞 _facial_photo_30, 5分）を全身脱毛系メニューと
// 同時予約したとき、フォト光は同一セッション内で行うため占有時間に加算しない
// （= 全身脱毛系の 55 分のまま）。既存の「全身脱毛（フォト付き）」55分バンドル、および
// フォト光の料金コンボ（combo_with_prefix "脱毛" で ¥1,000）と挙動を揃える。
//
// メニューの identity は ID 接尾辞で判定する（ID は不変。名称・料金・施術時間は管理画面で
// 変更されうるので名称一致では判定しない）。先頭アンダースコアで別メニューへの部分一致を
// 防ぐ（例: service_<store>_hair_removal_kids_full_60 は _hair_removal_full_60 に一致しない）。
// admin-app/src/lib/service-selection.ts の totalServiceDuration と keep-in-sync。
// ponytail: 対象は現行の全身脱毛系4メニューのみ。新しい全身脱毛メニューを吸収対象に
// するならここに接尾辞を追加する。
const PHOTO_ADDON_ID_SUFFIX = "_facial_photo_30";
const FULL_BODY_ABSORB_ID_SUFFIXES = [
  "_hair_removal_full_60",
  "_hair_removal_growth_45",
  "_hair_removal_upper_focus_45",
  "_hair_removal_lower_focus_45"
];

export const applyPhotoComboDuration = (
  services: ReadonlyArray<{ id: string; durationMinutes: number }>
): number[] => {
  const hasFullBody = services.some((service) =>
    FULL_BODY_ABSORB_ID_SUFFIXES.some((suffix) => service.id.endsWith(suffix))
  );
  return services.map((service) =>
    hasFullBody && service.id.endsWith(PHOTO_ADDON_ID_SUFFIX) ? 0 : service.durationMinutes
  );
};

export const resolveTotalTreatmentDuration = (
  services: readonly { id: string; duration_minutes: number }[]
): { ok: true; durationMinutes: number } | { ok: false; reason: "duration_limit_exceeded" } => {
  const serviceDurations = applyPhotoComboDuration(
    services.map((service) => ({ id: service.id, durationMinutes: service.duration_minutes }))
  );
  if (
    serviceDurations.reduce((total, duration) => total + duration, 0) >
    MAX_TOTAL_SERVICE_DURATION_MINUTES
  ) {
    return { ok: false, reason: "duration_limit_exceeded" };
  }
  return { ok: true, durationMinutes: calculateReservationDuration(serviceDurations) };
};

export type BookingService = { id: string; name: string; durationMinutes: number };

// Fetch and validate the active services for a booking: every requested id must
// exist, be active, belong to `storeId`, and carry a positive duration aligned to
// the slot-lock interval; the combined treatment must also stay within the
// reschedulable envelope (resolveTotalTreatmentDuration). This rule is IDENTICAL
// for the public (public-submit.ts) and admin (reservation-create.ts) create
// paths — kept here so a fix to service validation can't land on one path and
// silently miss the other.
export const collectBookingServices = async (
  db: D1Database,
  storeId: string,
  serviceIds: string[]
): Promise<
  | { ok: true; services: BookingService[]; durationMinutes: number }
  | { ok: false; reason: "service_not_available" | "invalid_request" }
> => {
  // Guard the empty case fail-closed: an empty selection would build invalid `IN ()`
  // SQL and, if it somehow returned, the loop below skips and 0-duration would pass
  // the cap as a nonsensical service-less booking. Today's callers pre-validate a
  // non-empty list (normalizeServiceIds length > 0); this keeps the shared helper
  // robust against future call-sites.
  if (serviceIds.length === 0) {
    return { ok: false, reason: "service_not_available" };
  }
  const placeholders = serviceIds.map(() => "?").join(", ");
  const serviceRows = await db
    .prepare(
      `
        SELECT id, store_id, name, duration_minutes
        FROM services
        WHERE active = 1
          AND id IN (${placeholders})
      `
    )
    .bind(...serviceIds)
    .all<{ id: string; store_id: string; name: string; duration_minutes: number }>();
  const serviceById = new Map((serviceRows.results ?? []).map((service) => [service.id, service]));
  const services: BookingService[] = [];
  for (const serviceId of serviceIds) {
    const service = serviceById.get(serviceId);
    if (
      service?.store_id !== storeId ||
      service.duration_minutes <= 0 ||
      service.duration_minutes % SLOT_LOCK_INTERVAL_MINUTES !== 0
    ) {
      return { ok: false, reason: "service_not_available" };
    }
    services.push({
      id: service.id,
      name: service.name,
      durationMinutes: service.duration_minutes
    });
  }

  const durationResult = resolveTotalTreatmentDuration(serviceRows.results ?? []);
  if (!durationResult.ok) {
    return { ok: false, reason: "invalid_request" };
  }

  return { ok: true, services, durationMinutes: durationResult.durationMinutes };
};

// Shared tail of both create-flows' fetchBookingContext: validate the already-fetched
// store/resource row, then attach the validated services + total treatment duration.
// The store/resource SELECT itself stays in each caller (the public flow adds a
// store_settings LEFT JOIN for booking_window_days that the admin flow has no use for);
// everything downstream is identical and lives here so the two flows can't drift.
// Generic over the row shape so each caller keeps its own BookingContext type (the
// public one carries bookingWindowDays; the admin one does not).
export const buildBookingContext = async <T extends { resourceStoreId: string }>(
  db: D1Database,
  storeId: string,
  serviceIds: string[],
  contextRow: T | null
): Promise<
  | { ok: true; context: T & { serviceId: string; serviceIds: string[]; services: BookingService[]; durationMinutes: number } }
  | { ok: false; reason: 'store_not_found' | 'resource_not_available' | 'service_not_available' | 'invalid_request' }
> => {
  if (!contextRow) {
    return { ok: false, reason: 'store_not_found' };
  }
  if (contextRow.resourceStoreId !== storeId) {
    return { ok: false, reason: 'resource_not_available' };
  }
  const collected = await collectBookingServices(db, storeId, serviceIds);
  if (!collected.ok) {
    return collected;
  }
  return {
    ok: true,
    context: {
      ...contextRow,
      serviceId: serviceIds[0],
      serviceIds,
      services: collected.services,
      durationMinutes: collected.durationMinutes
    }
  };
};

const MINUTE_MS = 60 * 1000;

type GenerateSlotTimesForRangeOptions = {
  maxDurationMs?: number;
  /**
   * Emit at most N+1 slots. Callers can test `slots.length > N` without
   * allocating unbounded slot arrays for very long imported calendar events.
   */
  maxSlotsForOverflowSignal?: number;
};

const parseIsoStrict = (value: string, label: string): number => {
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) {
    throw new TypeError(`slot-times: invalid ISO string for ${label}: ${value}`);
  }
  return ms;
};

const getPositiveStepMs = (intervalMinutes: number) => {
  if (!Number.isFinite(intervalMinutes) || intervalMinutes <= 0) {
    return undefined;
  }
  return intervalMinutes * MINUTE_MS;
};

const isValidDate = (date: Date) => Number.isFinite(date.getTime());

const isAlignedBoundary = (date: Date, intervalMinutes: number) => {
  return (
    date.getUTCSeconds() === 0 &&
    date.getUTCMilliseconds() === 0 &&
    date.getUTCMinutes() % intervalMinutes === 0
  );
};

const buildSlotTimes = (
  startMs: number,
  endMs: number,
  stepMs: number,
  maxSlotsForOverflowSignal?: number
) => {
  const maxEmittedSlots =
    maxSlotsForOverflowSignal === undefined ? undefined : maxSlotsForOverflowSignal + 1;
  const slots: string[] = [];
  for (let ts = startMs; ts < endMs; ts += stepMs) {
    slots.push(new Date(ts).toISOString());
    if (maxEmittedSlots !== undefined && slots.length >= maxEmittedSlots) {
      break;
    }
  }
  return slots;
};

export const generateSlotTimes = (
  startAtIso: string,
  endAtIso: string,
  intervalMinutes: number
): string[] => {
  const stepMs = getPositiveStepMs(intervalMinutes);
  if (!stepMs) {
    throw new Error(`slot-times: intervalMinutes must be > 0 (got ${intervalMinutes})`);
  }
  const startMs = parseIsoStrict(startAtIso, "startAtIso");
  const endMs = parseIsoStrict(endAtIso, "endAtIso");
  if (endMs <= startMs) {
    throw new Error(
      `slot-times: endAtIso (${endAtIso}) must be strictly after startAtIso (${startAtIso})`
    );
  }
  return buildSlotTimes(startMs, endMs, stepMs);
};

export const generateSlotTimesForDuration = (
  startAt: Date,
  durationMinutes: number,
  intervalMinutes: number
): string[] | undefined => {
  const stepMs = getPositiveStepMs(intervalMinutes);
  if (
    !stepMs ||
    !isValidDate(startAt) ||
    !Number.isFinite(durationMinutes) ||
    durationMinutes <= 0 ||
    durationMinutes % intervalMinutes !== 0
  ) {
    return undefined;
  }
  const durationMs = durationMinutes * MINUTE_MS;
  return buildSlotTimes(startAt.getTime(), startAt.getTime() + durationMs, stepMs);
};

export const generateSlotTimesForRange = (
  startAt: Date,
  endAt: Date,
  intervalMinutes: number,
  options: GenerateSlotTimesForRangeOptions = {}
): string[] | undefined => {
  const stepMs = getPositiveStepMs(intervalMinutes);
  if (!stepMs || !isValidDate(startAt) || !isValidDate(endAt)) {
    return undefined;
  }
  if (!isAlignedBoundary(startAt, intervalMinutes) || !isAlignedBoundary(endAt, intervalMinutes)) {
    return undefined;
  }
  const startMs = startAt.getTime();
  const endMs = endAt.getTime();
  const durationMs = endMs - startMs;
  if (durationMs <= 0 || durationMs % stepMs !== 0) {
    return undefined;
  }
  if (options.maxDurationMs !== undefined && durationMs > options.maxDurationMs) {
    return undefined;
  }
  if (
    options.maxSlotsForOverflowSignal !== undefined &&
    (!Number.isFinite(options.maxSlotsForOverflowSignal) || options.maxSlotsForOverflowSignal < 0)
  ) {
    return undefined;
  }
  return buildSlotTimes(startMs, endMs, stepMs, options.maxSlotsForOverflowSignal);
};
