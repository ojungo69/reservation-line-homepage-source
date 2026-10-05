import type { WorkerBindings } from "../bindings";
import { getCached, CACHE_KEYS } from "../cache/kv-cache";
import { isGoogleLiveAvailabilityEnabled } from "../runtime-config";
import { fetchGoogleBusyIntervals, type BusyInterval } from "../google/availability-live-check";
export { _resetCacheForTesting as _resetGoogleLiveCacheForTesting } from "../google/availability-live-check";
import {
  generateSlotTimesForDuration,
  normalizeServiceIds,
  resolveTotalTreatmentDuration,
  SLOT_LOCK_INTERVAL_MINUTES
} from "./slot-times";
import { MENS_MENU_WINDOW_STORE_ID, narrowHoursForMensMenu } from "./business-hours";
import { toIso, addMinutes, WEEKDAY_MAP } from "../time-utils";

export type PublicReservationOptionsResult =
  | {
      ok: true;
      liffId: string;
      turnstile: {
        siteKey: string;
        action: string;
      };
      consentVersions: {
        notice: string;
        cancellationPolicy: string;
        privacyPolicy: string;
        minorGuardian: string;
        duplicateReservationWarning: string;
      };
      stores: PublicStoreOption[];
      services: PublicServiceOption[];
      resources: PublicResourceOption[];
      businessHours: PublicBusinessHourOption[];
    }
  | {
      ok: false;
      reason: "missing_database";
    };

export type PublicAvailabilityResult =
  | {
      ok: true;
      storeId: string;
      serviceId: string;
      serviceIds: string[];
      resourceId: string;
      date: string;
      timezone: string;
      durationMinutes: number;
      availabilityStatus: "ready" | "unavailable";
      slots: PublicAvailabilitySlot[];
      notice?: string;
    }
  | {
      ok: false;
      // duration_limit_exceeded is separated from invalid_request so the public
      // UI can tell the customer to reduce the selection instead of showing a
      // generic availability error.
      reason: "invalid_request" | "not_found" | "duration_limit_exceeded";
    };

type PublicStoreOption = {
  id: string;
  name: string;
  timezone: string;
  // How many days ahead this store accepts public bookings (store_settings.booking_window_days,
  // default 30). The booking UI date dropdown reads this so it never offers a date the
  // server-side window check would reject.
  bookingWindowDays: number;
  // Store owner's customer-facing notice (store_settings.customer_notice, NULL = none).
  // Rendered on the booking page with textContent when the store is selected; never
  // innerHTML — it is free-form operator text and must not inject markup.
  customerNotice: string | null;
  // How many active future reservations one customer may hold when booking THIS store
  // (store_settings.max_active_reservations_per_customer). Mirrors the fallback in
  // trg_reservations_web_cap (migrations/0045). The booking page reads it so a customer
  // who is already at the cap is told up front instead of being walked through the whole
  // form and rejected at submit. Authoritative enforcement stays in the DB trigger.
  maxActiveReservationsPerCustomer: number;
};

type PublicServiceOption = {
  id: string;
  storeId: string;
  name: string;
  priceLabel: string | null;
  priceAmount: number | null;
  comboPriceAmount: number | null;
  comboWithPrefix: string | null;
  durationMinutes: number;
  /**
   * Serialized so the customer screen groups and labels by the SAME thing that gates
   * the booking window. The admin checkbox lets the owner flag a menu whose free-form
   * name has no `メンズ｜` prefix; deriving the category from the name would then put
   * it under その他 while the men's-hours restriction silently applies to it.
   */
  mensMenu: boolean;
};

type PublicResourceOption = {
  id: string;
  storeId: string;
  name: string;
};

type PublicBusinessHourOption = {
  id: string;
  storeId: string;
  weekday: number;
  opensAt: string;
  closesAt: string;
};

type PublicAvailabilitySlot = {
  startAt: string;
  endAt: string;
};

type AvailabilityContext = {
  storeId: string;
  timezone: string;
  serviceId: string;
  serviceIds: string[];
  durationMinutes: number;
  resourceId: string;
  resourceStoreId: string;
  googleCalendarId: string | null;
  bookingWindowDays: number;
  hasMensMenu: boolean;
};

type BusinessHourRow = {
  id: string;
  opens_at: string;
  closes_at: string;
};

type ClosureRow = {
  starts_at: string;
  ends_at: string;
};

const SLOT_START_INTERVAL_MINUTES = 15;
// Deliberately states the weekday rule only. The actual open/close times come from
// store_business_hours, which the owner can edit from the admin screen, so spelling
// out "8:00〜21:00" here would silently turn into a lie the day they change hours.
const KYOTO_MENS_MENU_NOTICE =
  "メンズメニューのご予約は、火曜日は営業時間内すべて、水・土・日曜日は13時以降のみ承っております（月・木曜日はメンズメニューのご予約を承っておりません）。";
// Effective public booking window when a store has no store_settings row yet.
// Mirrors the store_settings.booking_window_days DEFAULT in migration 0032 and the
// COALESCE(..., 30) fallback in the catalog/context queries below. The actual
// per-store value (1..90) is read from store_settings; this is only the fallback.
const DEFAULT_BOOKING_WINDOW_DAYS = 30;
// Effective per-customer active-reservation cap when a store has no store_settings row.
// MUST stay in sync with the COALESCE(..., 1) fallback inside trg_reservations_web_cap
// (migrations/0045_reservation_cap_default_one.sql) — the client uses this only to warn
// early; the trigger is what actually rejects the insert.
const DEFAULT_RESERVATION_CAP = 1;
const DEFAULT_TURNSTILE_ACTION = "reservation-submit";
// Bumped 2026-06: the consent documents were published at /legal/ (terms folded
// into the notice consent — see public/legal/), so the recorded versions change.
const DEFAULT_NOTICE_VERSION = "notice-terms-2026-06";
// Bumped 2026-08-31: the store does not take phone enquiries, so the policy now names
// the official LINE talk as the only route. Recorded consents must distinguish which
// text was accepted.
const DEFAULT_CANCELLATION_POLICY_VERSION = "cancel-2026-08-31";
const DEFAULT_PRIVACY_POLICY_VERSION = "privacy-2026-06";
const DEFAULT_MINOR_GUARDIAN_VERSION = "minor-guardian-2026-06";
// Version string for the duplicate-reservation warning shown when a LINE-recognized
// customer already holds active future reservations. The client echoes the version it
// displayed; the submit path validates it against this server-canonical value (forge
// guard) and records the canonical value as consent evidence. Bump when the warning
// copy materially changes.
const DEFAULT_DUPLICATE_WARNING_VERSION = "dup-warning-2026-08-31";
const datePattern = /^\d{4}-\d{2}-\d{2}$/;

const isSafePublicString = (value: unknown, maxLength: number) => {
  return typeof value === "string" && value.length <= maxLength ? value : "";
};

const getConfiguredString = (env: Partial<WorkerBindings>, key: keyof WorkerBindings, fallback = "") => {
  return isSafePublicString(env[key], 512) || fallback;
};

export type PublicConsentVersions = {
  notice: string;
  cancellationPolicy: string;
  privacyPolicy: string;
  minorGuardian: string;
  duplicateReservationWarning: string;
};

// Single source of truth for the currently-published consent versions, so the
// options endpoint (what the client sees) and the submit path (what gets recorded)
// resolve the SAME canonical strings. The submit path records these server values
// rather than trusting the client-echoed ones — the recorded consent versions can
// never be an arbitrary/forged string.
export const resolvePublicConsentVersions = (env: Partial<WorkerBindings>): PublicConsentVersions => ({
  notice: getConfiguredString(env, "RESERVATION_NOTICE_VERSION", DEFAULT_NOTICE_VERSION),
  cancellationPolicy: getConfiguredString(
    env,
    "RESERVATION_CANCELLATION_POLICY_VERSION",
    DEFAULT_CANCELLATION_POLICY_VERSION
  ),
  privacyPolicy: getConfiguredString(env, "RESERVATION_PRIVACY_POLICY_VERSION", DEFAULT_PRIVACY_POLICY_VERSION),
  minorGuardian: getConfiguredString(env, "RESERVATION_MINOR_GUARDIAN_VERSION", DEFAULT_MINOR_GUARDIAN_VERSION),
  duplicateReservationWarning: getConfiguredString(
    env,
    "RESERVATION_DUPLICATE_WARNING_VERSION",
    DEFAULT_DUPLICATE_WARNING_VERSION
  )
});

const parseDateKey = (date: string) => {
  if (!datePattern.test(date)) {
    return undefined;
  }
  const [year, month, day] = date.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    return undefined;
  }
  return {
    year,
    month,
    day
  };
};

const formatDateKey = (date: Date) => {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(
    date.getUTCDate()
  ).padStart(2, "0")}`;
};

const nextDateKey = (date: string) => {
  const parsed = parseDateKey(date);
  if (!parsed) {
    return undefined;
  }
  return formatDateKey(new Date(Date.UTC(parsed.year, parsed.month - 1, parsed.day + 1)));
};

const getTimeZoneParts = (date: Date, timezone: string) => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "0";
  return {
    year: Number(value("year")),
    month: Number(value("month")),
    day: Number(value("day")),
    hour: Number(value("hour")),
    minute: Number(value("minute")),
    second: Number(value("second"))
  };
};

const getTimeZoneOffsetMs = (date: Date, timezone: string) => {
  const parts = getTimeZoneParts(date, timezone);
  const localAsUtcMs = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return localAsUtcMs - date.getTime();
};

const zonedTimeToUtc = (date: string, time: string, timezone: string) => {
  const parsed = parseDateKey(date);
  const timeMatch = /^(\d{2}):(\d{2})$/.exec(time);
  if (!parsed || !timeMatch) {
    return undefined;
  }

  const hour = Number(timeMatch[1]);
  const minute = Number(timeMatch[2]);
  if (hour > 23 || minute > 59) {
    return undefined;
  }

  const localUtcMs = Date.UTC(parsed.year, parsed.month - 1, parsed.day, hour, minute, 0);
  let candidate = new Date(localUtcMs);
  for (let index = 0; index < 3; index += 1) {
    candidate = new Date(localUtcMs - getTimeZoneOffsetMs(candidate, timezone));
  }
  return candidate;
};

const getWeekday = (date: string, timezone: string) => {
  const midday = zonedTimeToUtc(date, "12:00", timezone);
  if (!midday) {
    return undefined;
  }
  const weekday = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short"
  }).format(midday);
  return WEEKDAY_MAP[weekday];
};

const isDateInAvailabilityWindow = (
  date: string,
  timezone: string,
  nowMs: number,
  lookaheadDays: number
) => {
  const dayStart = zonedTimeToUtc(date, "00:00", timezone);
  if (!dayStart) {
    return false;
  }
  const todayKey = formatDateKey(new Date(nowMs + getTimeZoneOffsetMs(new Date(nowMs), timezone)));
  const todayStart = zonedTimeToUtc(todayKey, "00:00", timezone);
  if (!todayStart) {
    return false;
  }
  const latestStart = addMinutes(todayStart, lookaheadDays * 24 * 60);
  return dayStart >= todayStart && dayStart <= latestStart;
};

// Shared booking-window check for a precise instant (used by the SUBMIT path so the
// reservation-create endpoint enforces the SAME per-store window the availability
// endpoint displays). A tampered submit body with a startAt beyond the window must
// be rejected server-side, not just hidden from the UI dropdown. We derive the
// store-local calendar date of the instant and reuse isDateInAvailabilityWindow so
// the boundary semantics (inclusive upper bound) are identical on both paths.
export const isInstantWithinBookingWindow = (
  startAt: Date,
  timezone: string,
  nowMs: number,
  lookaheadDays: number
): boolean => {
  const localDateKey = formatDateKey(new Date(startAt.getTime() + getTimeZoneOffsetMs(startAt, timezone)));
  return isDateInAvailabilityWindow(localDateKey, timezone, nowMs, lookaheadDays);
};

// Exported so the submit path can fall back to the same default window (30 days)
// when a store_settings row is somehow absent, matching the COALESCE(..., 30) in
// the catalog/context queries here.
export const DEFAULT_BOOKING_WINDOW_DAYS_FALLBACK = DEFAULT_BOOKING_WINDOW_DAYS;

const overlaps = (startAt: Date, endAt: Date, range: ClosureRow) => {
  return new Date(range.starts_at).getTime() < endAt.getTime() && new Date(range.ends_at).getTime() > startAt.getTime();
};

const fetchAvailabilityContext = async (
  db: D1Database,
  storeId: string,
  serviceIds: string[],
  resourceId: string
): Promise<AvailabilityContext | "duration_limit_exceeded" | undefined> => {
  const context = await db
    .prepare(
      `
        SELECT
          stores.id AS storeId,
          stores.timezone AS timezone,
          stores.google_calendar_id AS googleCalendarId,
          COALESCE(store_settings.booking_window_days, ${DEFAULT_BOOKING_WINDOW_DAYS}) AS bookingWindowDays,
          store_resources.id AS resourceId,
          store_resources.store_id AS resourceStoreId
        FROM stores
        JOIN store_resources ON store_resources.id = ?
        LEFT JOIN store_settings ON store_settings.store_id = stores.id
        WHERE stores.id = ?
          AND store_resources.active = 1
        LIMIT 1
      `
    )
    .bind(resourceId, storeId)
    .first<Omit<AvailabilityContext, "durationMinutes" | "serviceId" | "serviceIds" | "hasMensMenu">>();

  if (!context) {
    return undefined;
  }
  if (context.resourceStoreId !== storeId || serviceIds.length === 0) {
    return undefined;
  }
  const placeholders = serviceIds.map(() => "?").join(", ");
  const serviceRows = await db
    .prepare(
      `
        SELECT id, store_id, duration_minutes, mens_menu
        FROM services
        WHERE active = 1
          AND id IN (${placeholders})
      `
    )
    .bind(...serviceIds)
    .all<{ id: string; store_id: string; duration_minutes: number; mens_menu: number }>();
  const serviceById = new Map((serviceRows.results ?? []).map((service) => [service.id, service]));
  for (const serviceId of serviceIds) {
    const service = serviceById.get(serviceId);
    if (!service) {
      return undefined;
    }
    if (
      service.store_id !== storeId ||
      service.duration_minutes <= 0 ||
      service.duration_minutes % SLOT_LOCK_INTERVAL_MINUTES !== 0
    ) {
      return undefined;
    }
  }
  const durationResult = resolveTotalTreatmentDuration(serviceRows.results ?? []);
  if (!durationResult.ok) {
    return durationResult.reason;
  }
  const durationMinutes = durationResult.durationMinutes;
  if (durationMinutes <= 0 || durationMinutes % SLOT_LOCK_INTERVAL_MINUTES !== 0) {
    return undefined;
  }
  return {
    ...context,
    serviceId: serviceIds[0],
    serviceIds,
    durationMinutes,
    hasMensMenu: (serviceRows.results ?? []).some((service) => service.mens_menu === 1)
  };
};

const getBusySlots = async (
  db: D1Database,
  input: {
    storeId: string;
    resourceId: string;
    dayStart: Date;
    dayEnd: Date;
    nowIso: string;
    /**
     * Reschedule only: the id of the reservation being moved. Its own slot_locks are
     * excluded so the picker can offer a same-day shift that merely overlaps the
     * customer's current booking — approval deletes those locks before re-inserting, so
     * they are not a real conflict for this reservation. Booking (new) passes nothing.
     */
    excludeReservationLockOwnerId?: string;
  }
) => {
  // Ignore ONLY a pending lock whose TTL has already lapsed. Pending web bookings hold a
  // slot with a future expires_at (still busy); confirmed / external-block locks are busy
  // regardless of expires_at (they use NULL by design, but a non-NULL past value on a
  // confirmed lock must still block). Filtering only stranded/orphaned PENDING locks makes
  // availability self-correcting against the documented bulk-cleanup incident class without
  // ever freeing a genuinely-held confirmed slot.
  const excludeOwn = input.excludeReservationLockOwnerId
    ? " AND NOT (owner_type = 'reservation' AND owner_id = ?)"
    : "";
  const statement = db.prepare(
    `
        SELECT slot_at
        FROM slot_locks
        WHERE store_id = ?
          AND resource_id = ?
          AND slot_at >= ?
          AND slot_at < ?
          AND NOT (lock_status = 'pending' AND expires_at IS NOT NULL AND datetime(expires_at) <= datetime(?))${excludeOwn}
      `
  );
  const bindings: (string)[] = [
    input.storeId,
    input.resourceId,
    toIso(input.dayStart),
    toIso(input.dayEnd),
    input.nowIso
  ];
  if (input.excludeReservationLockOwnerId) {
    bindings.push(input.excludeReservationLockOwnerId);
  }
  const rows = await statement.bind(...bindings).all<{ slot_at: string }>();
  return new Set((rows.results ?? []).map((row) => row.slot_at));
};

const getClosures = async (
  db: D1Database,
  input: {
    storeId: string;
    dayStart: Date;
    dayEnd: Date;
  }
) => {
  const rows = await db
    .prepare(
      `
        SELECT starts_at, ends_at
        FROM store_closures
        WHERE store_id = ?
          AND starts_at < ?
          AND ends_at > ?
      `
    )
    .bind(input.storeId, toIso(input.dayEnd), toIso(input.dayStart))
    .all<ClosureRow>();
  return rows.results ?? [];
};

const isUnavailableSlot = (input: {
  startAt: Date;
  endAt: Date;
  nowMs: number;
  closures: ClosureRow[];
  busySlots: Set<string>;
  durationMinutes: number;
}) => {
  if (input.startAt.getTime() <= input.nowMs) {
    return true;
  }
  if (input.closures.some((closure) => overlaps(input.startAt, input.endAt, closure))) {
    return true;
  }
  return (
    generateSlotTimesForDuration(input.startAt, input.durationMinutes, SLOT_LOCK_INTERVAL_MINUTES) ?? []
  ).some((slotAt) => input.busySlots.has(slotAt));
};

const buildBusinessHourSlots = (input: {
  date: string;
  context: AvailabilityContext;
  hour: BusinessHourRow;
  busySlots: Set<string>;
  closures: ClosureRow[];
  nowMs: number;
}) => {
  const opensAt = zonedTimeToUtc(input.date, input.hour.opens_at, input.context.timezone);
  const closesAt = zonedTimeToUtc(input.date, input.hour.closes_at, input.context.timezone);
  if (!opensAt || !closesAt || closesAt <= opensAt) {
    return [];
  }

  const slots: PublicAvailabilitySlot[] = [];
  for (
    let startAt = opensAt;
    addMinutes(startAt, input.context.durationMinutes) <= closesAt;
    startAt = addMinutes(startAt, SLOT_START_INTERVAL_MINUTES)
  ) {
    const endAt = addMinutes(startAt, input.context.durationMinutes);
    if (
      isUnavailableSlot({
        startAt,
        endAt,
        nowMs: input.nowMs,
        closures: input.closures,
        busySlots: input.busySlots,
        durationMinutes: input.context.durationMinutes
      })
    ) {
      continue;
    }
    slots.push({
      startAt: toIso(startAt),
      endAt: toIso(endAt)
    });
  }
  return slots;
};

const buildAvailabilitySlots = (input: {
  date: string;
  context: AvailabilityContext;
  hours: BusinessHourRow[];
  busySlots: Set<string>;
  closures: ClosureRow[];
  nowMs: number;
}) => {
  const slots: PublicAvailabilitySlot[] = [];
  for (const hour of input.hours) {
    slots.push(...buildBusinessHourSlots({ ...input, hour }));
  }
  return slots;
};

type CatalogCache = {
  stores: PublicStoreOption[];
  services: PublicServiceOption[];
  resources: PublicResourceOption[];
  businessHours: PublicBusinessHourOption[];
};

async function fetchCatalogFromD1(db: D1Database): Promise<CatalogCache> {
  const [stores, services, resources, businessHours] = await Promise.all([
    db
      .prepare(
        `
          SELECT
            stores.id AS id,
            stores.name AS name,
            stores.timezone AS timezone,
            COALESCE(store_settings.booking_window_days, ${DEFAULT_BOOKING_WINDOW_DAYS}) AS booking_window_days,
            store_settings.customer_notice AS customer_notice,
            COALESCE(store_settings.max_active_reservations_per_customer, ${DEFAULT_RESERVATION_CAP})
              AS max_active_reservations_per_customer
          FROM stores
          LEFT JOIN store_settings ON store_settings.store_id = stores.id
          ORDER BY stores.name ASC
        `
      )
      .all<{
        id: string;
        name: string;
        timezone: string;
        booking_window_days: number;
        customer_notice: string | null;
        max_active_reservations_per_customer: number;
      }>(),
    db
      .prepare(
        `
          SELECT id, store_id, name, price_label, price_amount, combo_price_amount, combo_with_prefix,
                 duration_minutes, mens_menu
          FROM services
          WHERE active = 1
          ORDER BY
            store_id ASC,
            CASE
              -- Checked before the name prefixes: the flag is what actually gates
              -- the booking window, and menus the owner adds from the admin screen
              -- get a UUID id and a free-form name. Men's menus group right after
              -- 脱毛 either way, but flagging an existing menu now moves it too.
              WHEN mens_menu = 1 THEN 15
              WHEN name LIKE '脱毛｜%' THEN 10
              WHEN name LIKE 'フェイシャル｜%' THEN 20
              WHEN name LIKE 'マッサージ｜%' THEN 30
              WHEN name LIKE 'ネイル・フットケア｜%' THEN 40
              ELSE 90
            END ASC,
            CASE
              WHEN id LIKE '%hair_removal_full_60' THEN 11
              WHEN id LIKE '%hair_removal_upper_focus_45' THEN 12
              WHEN id LIKE '%hair_removal_lower_focus_45' THEN 13
              WHEN id LIKE '%hair_removal_growth_45' THEN 14
              WHEN id LIKE '%hair_removal_beard_30' THEN 15
              WHEN id LIKE '%hair_removal_face_photo_45' THEN 16
              WHEN id LIKE '%hair_removal_vio_women_45' THEN 17
              WHEN id LIKE '%hair_removal_vio_men_45' THEN 18
              WHEN id LIKE '%hair_removal_legs_45' THEN 19
              WHEN id LIKE '%hair_removal_arms_15' THEN 20
              WHEN id LIKE '%hair_removal_kids_full_60' THEN 21
              WHEN id LIKE '%hair_removal_partial_armpits_5' THEN 22
              WHEN id LIKE '%hair_removal_partial_nape_5' THEN 23
              WHEN id LIKE '%hair_removal_partial_stomach_5' THEN 24
              WHEN id LIKE '%hair_removal_partial_chest_5' THEN 25
              WHEN id LIKE '%hair_removal_partial_back_5' THEN 26
              WHEN id LIKE '%hair_removal_partial_forearms_10' THEN 27
              WHEN id LIKE '%hair_removal_partial_lower_legs_10' THEN 28
              WHEN id LIKE '%facial_hydra_photo_60' THEN 31
              WHEN id LIKE '%facial_hydra_45' THEN 32
              WHEN id LIKE '%facial_photo_30' THEN 33
              WHEN id LIKE '%default_60' THEN 41
              WHEN id LIKE '%massage_back_long_90' THEN 42
              WHEN id LIKE '%massage_upper_30' THEN 43
              WHEN id LIKE '%massage_lower_30' THEN 44
              WHEN id LIKE '%massage_kassa_60' THEN 45
              WHEN id LIKE '%foot_korean_care_45' THEN 51
              WHEN id LIKE '%foot_nail_one_color_60' THEN 52
              ELSE 90
            END ASC,
            name ASC
        `
      )
      .all<{ id: string; store_id: string; name: string; price_label: string | null; price_amount: number | null; combo_price_amount: number | null; combo_with_prefix: string | null; duration_minutes: number; mens_menu: number }>(),
    db
      .prepare(
        `
          SELECT id, store_id, name
          FROM store_resources
          WHERE active = 1
          ORDER BY store_id ASC, name ASC
        `
      )
      .all<{ id: string; store_id: string; name: string }>(),
    db
      .prepare(
        `
          SELECT id, store_id, weekday, opens_at, closes_at
          FROM store_business_hours
          WHERE active = 1
          ORDER BY store_id ASC, weekday ASC, opens_at ASC
        `
      )
      .all<{ id: string; store_id: string; weekday: number; opens_at: string; closes_at: string }>()
  ]);

  return {
    stores: (stores.results ?? []).map((store) => ({
      id: store.id,
      name: store.name,
      timezone: store.timezone,
      bookingWindowDays: store.booking_window_days ?? DEFAULT_BOOKING_WINDOW_DAYS,
      customerNotice: store.customer_notice ?? null,
      maxActiveReservationsPerCustomer:
        store.max_active_reservations_per_customer ?? DEFAULT_RESERVATION_CAP
    })),
    services: (services.results ?? []).map((service) => ({
      id: service.id,
      storeId: service.store_id,
      name: service.name,
      priceLabel: service.price_label,
      priceAmount: service.price_amount,
      comboPriceAmount: service.combo_price_amount,
      comboWithPrefix: service.combo_with_prefix,
      durationMinutes: service.duration_minutes,
      mensMenu: service.mens_menu === 1
    })),
    resources: (resources.results ?? []).map((resource) => ({
      id: resource.id,
      storeId: resource.store_id,
      name: resource.name
    })),
    businessHours: (businessHours.results ?? []).map((hour) => ({
      id: hour.id,
      storeId: hour.store_id,
      weekday: hour.weekday,
      opensAt: hour.opens_at,
      closesAt: hour.closes_at
    }))
  };
}

export async function listPublicReservationOptions(input: {
  db?: D1Database;
  kv?: KVNamespace;
  env: Partial<WorkerBindings>;
}): Promise<PublicReservationOptionsResult> {
  if (!input.db) {
    return {
      ok: false,
      reason: "missing_database"
    };
  }

  const db = input.db;
  const catalog = await getCached<CatalogCache>(
    input.kv,
    CACHE_KEYS.allStores(),
    () => fetchCatalogFromD1(db)
  );

  return {
    ok: true,
    liffId: getConfiguredString(input.env, "LINE_LIFF_ID"),
    turnstile: {
      siteKey: getConfiguredString(input.env, "TURNSTILE_SITE_KEY"),
      action: getConfiguredString(input.env, "TURNSTILE_EXPECTED_ACTION", DEFAULT_TURNSTILE_ACTION)
    },
    consentVersions: resolvePublicConsentVersions(input.env),
    stores: catalog.stores,
    services: catalog.services,
    resources: catalog.resources,
    businessHours: catalog.businessHours
  };
}

const mergeGoogleBusyIntoSlots = (
  busySlots: Set<string>,
  googleBusy: BusyInterval[],
  dayStart: Date,
  dayEnd: Date
) => {
  const slotIntervalMs = SLOT_LOCK_INTERVAL_MINUTES * 60 * 1000;
  for (const interval of googleBusy) {
    const intervalStart = new Date(interval.startUtc);
    const intervalEnd = new Date(interval.endUtc);
    // Generate 5-minute slot keys that overlap with the busy interval within the day window
    const effectiveStart = intervalStart < dayStart ? dayStart : intervalStart;
    const effectiveEnd = intervalEnd > dayEnd ? dayEnd : intervalEnd;
    for (
      let slotMs = Math.floor(effectiveStart.getTime() / slotIntervalMs) * slotIntervalMs;
      slotMs < effectiveEnd.getTime();
      slotMs += slotIntervalMs
    ) {
      busySlots.add(new Date(slotMs).toISOString());
    }
  }
};

export async function listPublicAvailability(input: {
  db?: D1Database;
  env?: Partial<WorkerBindings>;
  storeId: string | undefined;
  serviceId: string | undefined;
  serviceIds?: string[];
  resourceId: string | undefined;
  date: string | undefined;
  now?: () => number;
  /** Injected fetcher for testing Google API calls. */
  fetcher?: typeof fetch;
  /** Injected access-token provider for testing. */
  accessTokenProvider?: (env: Partial<WorkerBindings>) => Promise<string | undefined>;
}): Promise<PublicAvailabilityResult> {
  // 旧ローカル実装は trim 後の値で128字上限を判定していた（共有ヘルパーは
  // public-submit 互換で trim 前判定）。先に trim して渡し、旧契約を保存する。
  const serviceIds = normalizeServiceIds(
    input.serviceIds?.map((id) => id.trim()),
    input.serviceId?.trim()
  );
  if (!input.db || !input.storeId || serviceIds.length === 0 || !input.resourceId || !input.date) {
    return {
      ok: false,
      reason: "invalid_request"
    };
  }
  if (!parseDateKey(input.date)) {
    return {
      ok: false,
      reason: "invalid_request"
    };
  }

  const context = await fetchAvailabilityContext(input.db, input.storeId, serviceIds, input.resourceId);
  if (context === "duration_limit_exceeded") {
    return {
      ok: false,
      reason: "duration_limit_exceeded"
    };
  }
  if (!context) {
    return {
      ok: false,
      reason: "not_found"
    };
  }
  const nowMs = input.now?.() ?? Date.now();
  if (!isDateInAvailabilityWindow(input.date, context.timezone, nowMs, context.bookingWindowDays)) {
    return {
      ok: false,
      reason: "invalid_request"
    };
  }

  const slots = await computeAvailabilitySlots({
    db: input.db,
    env: input.env ?? {},
    context,
    date: input.date,
    nowMs,
    fetcher: input.fetcher,
    accessTokenProvider: input.accessTokenProvider,
    now: input.now
  });
  if (slots === "invalid") {
    return { ok: false, reason: "invalid_request" };
  }
  return buildAvailabilityResult(context, input.date, slots);
}

const buildAvailabilityResult = (
  context: AvailabilityContext,
  date: string,
  slots: PublicAvailabilitySlot[] | "fail_closed"
): PublicAvailabilityResult => ({
  ok: true,
  storeId: context.storeId,
  serviceId: context.serviceId,
  serviceIds: context.serviceIds,
  resourceId: context.resourceId,
  date,
  timezone: context.timezone,
  durationMinutes: context.durationMinutes,
  availabilityStatus: slots === "fail_closed" ? "unavailable" : "ready",
  slots: slots === "fail_closed" ? [] : slots,
  ...(context.storeId === MENS_MENU_WINDOW_STORE_ID && context.hasMensMenu
    ? { notice: KYOTO_MENS_MENU_NOTICE }
    : {})
});

// Shared "context + date → slots" core used by both the booking path (new reservation)
// and the reschedule path. Returns "invalid" for an unrenderable date, "fail_closed" when
// the Google live check cannot confirm availability, or the slot list otherwise.
const computeAvailabilitySlots = async (input: {
  db: D1Database;
  env: Partial<WorkerBindings>;
  context: AvailabilityContext;
  date: string;
  nowMs: number;
  fetcher?: typeof fetch;
  accessTokenProvider?: (env: Partial<WorkerBindings>) => Promise<string | undefined>;
  now?: () => number;
  excludeReservationLockOwnerId?: string;
}): Promise<PublicAvailabilitySlot[] | "invalid" | "fail_closed"> => {
  const { context, date, nowMs } = input;
  const weekday = getWeekday(date, context.timezone);
  const followingDate = nextDateKey(date);
  const dayStart = zonedTimeToUtc(date, "00:00", context.timezone);
  const dayEnd = followingDate ? zonedTimeToUtc(followingDate, "00:00", context.timezone) : undefined;
  if (weekday === undefined || !dayStart || !dayEnd) {
    return "invalid";
  }

  // Three independent reads on the hottest public path (the booking UI polls this every
  // 30s per visitor) — issue them concurrently instead of paying three serial D1 hops.
  const [hours, busySlots, closures] = await Promise.all([
    input.db
      .prepare(
        `
        SELECT id, opens_at, closes_at
        FROM store_business_hours
        WHERE store_id = ?
          AND weekday = ?
          AND active = 1
        ORDER BY opens_at ASC
      `
      )
      .bind(context.storeId, weekday)
      .all<BusinessHourRow>(),
    getBusySlots(input.db, {
      storeId: context.storeId,
      resourceId: context.resourceId,
      dayStart,
      dayEnd,
      nowIso: new Date(nowMs).toISOString(),
      excludeReservationLockOwnerId: input.excludeReservationLockOwnerId
    }),
    getClosures(input.db, {
      storeId: context.storeId,
      dayStart,
      dayEnd
    })
  ]);

  // Google live availability check (fail-closed)
  let googleBusyIntervals: BusyInterval[] | "fail_closed" | undefined;
  if (isGoogleLiveAvailabilityEnabled(input.env)) {
    if (context.googleCalendarId) {
      const googleResult = await fetchGoogleBusyIntervals({
        env: input.env,
        storeId: context.storeId,
        calendarId: context.googleCalendarId,
        rangeStartUtc: toIso(dayStart),
        rangeEndUtc: toIso(dayEnd),
        fetcher: input.fetcher,
        accessTokenProvider: input.accessTokenProvider,
        now: input.now
      });
      googleBusyIntervals = googleResult.ok ? googleResult.busyIntervals : "fail_closed";
    } else {
      // No calendar configured -- fail-closed: all slots unavailable
      googleBusyIntervals = "fail_closed";
    }
  }

  if (googleBusyIntervals === "fail_closed") {
    return "fail_closed";
  }

  if (googleBusyIntervals && googleBusyIntervals.length > 0) {
    mergeGoogleBusyIntoSlots(busySlots, googleBusyIntervals, dayStart, dayEnd);
  }

  return buildAvailabilitySlots({
    date,
    context,
    hours: narrowHoursForMensMenu(
      context.storeId,
      weekday,
      context.hasMensMenu,
      hours.results ?? []
    ),
    busySlots,
    closures,
    nowMs
  });
};
