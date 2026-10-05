/**
 * Shared store-hours / store-closures validator.
 *
 * Centralizes the `store_business_hours` + `store_closures` lookup used by
 * every reservation write path that gates on store hours:
 *   - src/reservations/public-submit.ts        (public web submit)
 *   - src/admin/reservation-create.ts          (admin phone-create)
 *   - src/admin/reservation-reschedule.ts      (admin reschedule)
 *
 * public-options.ts performs a multi-row enumeration of business hours (for
 * availability slot rendering) and shares narrowHoursForMensMenu below;
 * google/import-sync.ts hits store_business_hours from a different
 * conflict-detection angle and is intentionally out of scope.
 */

import { WEEKDAY_MAP } from "../time-utils";
import { INSTANCE_CONFIG } from "../instance-config";

type StoreLocalParts = {
  dateKey: string;
  weekday: number | undefined;
  time: string;
};

/**
 * The men's-menu booking window is a Kyoto-only, customer-facing display rule
 * (owner decision 2026-07-27). Exported so public-options.ts pins the notice to
 * the same store as the filter — the two must never disagree.
 */
export const MENS_MENU_WINDOW_STORE_ID = INSTANCE_CONFIG.mensMenuStoreId;

/**
 * Men's-menu opening time per weekday (0=Sun .. 6=Sat).
 *
 * - `"13:00"`: afternoon only. The CLOSING time is intentionally NOT pinned here
 *   — it stays whatever `store_business_hours` says, so extending the store's
 *   hours extends the men's window too instead of silently capping it at a
 *   number only a code change could move.
 * - `null`: the store's full configured hours (Tuesday).
 * - absent: no men's bookings that weekday. Monday (1) and Thursday (4) are the
 *   owner's rule; Friday (5) is absent because the store itself is closed then.
 *   If Friday ever reopens, add it here too — an active Friday row alone would
 *   not open men's bookings.
 */
const KYOTO_MENS_MENU_START_BY_WEEKDAY = new Map<number, string | null>([
  [0, "13:00"],
  [2, null],
  [3, "13:00"],
  [6, "13:00"]
]);

export const narrowHoursForMensMenu = <T extends { opens_at: string; closes_at: string }>(
  storeId: string,
  weekday: number,
  hasMensMenu: boolean,
  hours: readonly T[]
): T[] => {
  if (!hasMensMenu || storeId !== MENS_MENU_WINDOW_STORE_ID) return [...hours];

  const mensMenuStart = KYOTO_MENS_MENU_START_BY_WEEKDAY.get(weekday);
  if (mensMenuStart === undefined) return [];
  if (mensMenuStart === null) return [...hours];

  return hours
    .map((hour) => hour.opens_at < mensMenuStart
      ? { ...hour, opens_at: mensMenuStart }
      : hour)
    .filter((hour) => hour.opens_at < hour.closes_at);
};

const getStoreLocalParts = (date: Date, timezone: string): StoreLocalParts => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";
  return {
    dateKey: `${value("year")}-${value("month")}-${value("day")}`,
    weekday: WEEKDAY_MAP[value("weekday")],
    time: `${value("hour")}:${value("minute")}`
  };
};

type BusinessTimeFailure = "outside_business_hours" | "store_closed";

type ValidateBusinessTimeInput = {
  db: D1Database;
  storeId: string;
  timezone: string;
  startAt: Date;
  endAt: Date;
  serviceIds?: readonly string[];
};

/**
 * Returns `undefined` when the [startAt, endAt) window is fully inside an
 * active `store_business_hours` row on a single local weekday and not
 * overlapped by any `store_closures` row. Otherwise returns the failure
 * reason matching the public/admin reservation result enums.
 */
const validateBusinessTime = async (
  input: ValidateBusinessTimeInput
): Promise<BusinessTimeFailure | undefined> => {
  const startParts = getStoreLocalParts(input.startAt, input.timezone);
  const endParts = getStoreLocalParts(input.endAt, input.timezone);
  if (startParts.weekday === undefined || startParts.dateKey !== endParts.dateKey) {
    return "outside_business_hours";
  }

  let hasMensMenu = false;
  if (input.serviceIds?.length) {
    const placeholders = input.serviceIds.map(() => "?").join(", ");
    const services = await input.db
      .prepare(`SELECT mens_menu FROM services WHERE id IN (${placeholders})`)
      .bind(...input.serviceIds)
      .all<{ mens_menu: number }>();
    hasMensMenu = (services.results ?? []).some((service) => service.mens_menu === 1);
  }

  const businessHours = await input.db
    .prepare(
      `
        SELECT opens_at, closes_at
        FROM store_business_hours
        WHERE store_id = ?
          AND weekday = ?
          AND active = 1
        ORDER BY opens_at ASC
      `
    )
    .bind(input.storeId, startParts.weekday)
    .all<{ opens_at: string; closes_at: string }>();

  const narrowedHours = narrowHoursForMensMenu(
    input.storeId,
    startParts.weekday,
    hasMensMenu,
    businessHours.results ?? []
  );
  if (!narrowedHours.some(
    (hour) => hour.opens_at <= startParts.time && hour.closes_at >= endParts.time
  )) {
    return "outside_business_hours";
  }

  const closure = await input.db
    .prepare(
      `
        SELECT id
        FROM store_closures
        WHERE store_id = ?
          AND starts_at < ?
          AND ends_at > ?
        LIMIT 1
      `
    )
    .bind(input.storeId, input.endAt.toISOString(), input.startAt.toISOString())
    .first<{ id: string }>();

  if (closure) {
    return "store_closed";
  }

  return undefined;
};

export const ensureBusinessTime = async (
  db: D1Database,
  storeId: string,
  timezone: string,
  startAt: Date,
  endAt: Date,
  serviceIds?: readonly string[]
): Promise<{ ok: false; reason: BusinessTimeFailure } | undefined> => {
  const failure = await validateBusinessTime({ db, storeId, timezone, startAt, endAt, serviceIds });
  return failure ? { ok: false, reason: failure } : undefined;
};
