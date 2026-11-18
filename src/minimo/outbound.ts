import { parseDateJstToUtcIso } from "../date-parse";
import type { MinimoAccount } from "./config";
import type { MinimoSchedule } from "./schedule";

type BusyInterval = { resourceId: string | null; startAt: string; endAt: string; reopenOnly?: boolean };
export type AvailabilityInputs = {
  intervals: BusyInterval[];
  hours: { opensAt: string; closesAt: string }[];
};
export type ScheduleOwnership = { snapshot: MinimoSchedule; owned: Record<string, string[]> };

function availabilityKey(schedule: MinimoSchedule): string {
  return JSON.stringify(schedule.entries.map((entry) => ({
    staffId: entry.staffId, openSlots: [...entry.openSlots].sort((a, b) => a.localeCompare(b))
  })).sort((a, b) => a.staffId.localeCompare(b.staffId)));
}

export function scheduleKey(schedule: MinimoSchedule): string {
  return JSON.stringify({ date: schedule.date, entries: schedule.entries.map((entry) => ({
    staffId: entry.staffId,
    openSlots: [...entry.openSlots].sort((a, b) => a.localeCompare(b)),
    reservations: [...entry.reservations].sort((a, b) => a.id.localeCompare(b.id))
  })).sort((a, b) => a.staffId.localeCompare(b.staffId)) });
}

function overlaps(start: number, end: number, interval: BusyInterval): boolean {
  return start < Date.parse(interval.endAt) && end > Date.parse(interval.startAt);
}

export function planOutboundDay(
  account: MinimoAccount,
  schedule: MinimoSchedule,
  inputs: AvailabilityInputs,
  previous: ScheduleOwnership | null,
  nowMs: number
): { schedule: MinimoSchedule; owned: Record<string, string[]>; closed: number; reopened: number; changed: boolean } {
  if (previous && Object.values(previous.owned).some((slots) => slots.length > 0)
    && availabilityKey(previous.snapshot) !== availabilityKey(schedule)) {
    throw new Error("minimo_remote_changed");
  }
  for (const mapping of account.staff) {
    const entry = schedule.entries.find((row) => row.staffId === mapping.rimaUserId);
    if (!entry) {
      throw new Error("minimo_staff_missing");
    }
    // A status other than confirmed 1/2 or cancelled 11/12 may still hold the slot, so stop before reopening it.
    if (entry.reservations.some((reservation) => reservation.status === "ignored")) {
      throw new Error("minimo_unknown_reservation_status");
    }
    if (entry.reservations.some((reservation) => reservation.status === "confirmed"
      && reservation.startAt && reservation.endAt
      && Date.parse(reservation.endAt) - Date.parse(reservation.startAt) > mapping.maxDurationMinutes * 60_000)) {
      throw new Error("minimo_duration_exceeds_mapping");
    }
  }
  const midnight = Date.parse(parseDateJstToUtcIso(schedule.date) ?? "");
  if (!Number.isFinite(midnight)) throw new Error("minimo_invalid_date");
  const hours = inputs.hours.map((row) => ({
    start: Date.parse(`${schedule.date}T${row.opensAt}:00+09:00`),
    end: Date.parse(`${schedule.date}T${row.closesAt}:00+09:00`)
  }));
  const owned: Record<string, string[]> = Object.create(null);
  const previousOwned: Record<string, string[]> = previous?.owned ?? {};
  let closed = 0;
  let reopened = 0;
  const entries = schedule.entries.map((entry) => {
    const mapping = account.staff.find((staff) => staff.rimaUserId === entry.staffId);
    if (!mapping) return entry;
    const current = new Set(entry.openSlots);
    const priorSlots = Object.hasOwn(previousOwned, entry.staffId) ? previousOwned[entry.staffId] : [];
    const candidates = new Set([...current, ...priorSlots]);
    const openSlots: string[] = [];
    const retained: string[] = [];
    for (const slot of [...candidates].sort((a, b) => a.localeCompare(b))) {
      const start = Date.parse(slot);
      const end = start + mapping.maxDurationMinutes * 60_000;
      if (start <= nowMs) {
        if (current.has(slot)) openSlots.push(slot);
        continue;
      }
      const available = hours.some((hour) => start >= hour.start && end <= hour.end)
        && !inputs.intervals.some((interval) =>
          (!interval.reopenOnly || !current.has(slot))
          && (interval.resourceId === null || interval.resourceId === mapping.resourceId) && overlaps(start, end, interval));
      const remoteBusy = !current.has(slot) && entry.reservations.some((reservation) =>
        reservation.status === "confirmed" && reservation.startAt && reservation.endAt
        && overlaps(start, end, { resourceId: mapping.resourceId, startAt: reservation.startAt, endAt: reservation.endAt }));
      if (available && !remoteBusy) {
        openSlots.push(slot);
        reopened += Number(!current.has(slot));
      } else {
        retained.push(slot);
        closed += Number(current.has(slot));
      }
    }
    if (retained.length) owned[entry.staffId] = retained;
    return { ...entry, openSlots };
  });
  return { schedule: { date: schedule.date, entries }, owned, closed, reopened, changed: closed + reopened > 0 };
}

export async function loadAvailabilityInputs(
  db: D1Database,
  account: MinimoAccount,
  date: string,
  nowMs: number
): Promise<AvailabilityInputs> {
  const start = parseDateJstToUtcIso(date);
  if (!start) throw new Error("minimo_invalid_date");
  const end = new Date(Date.parse(start) + 86_400_000).toISOString();
  const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
  const [reservations, blocks, closures, hours] = await Promise.all([
    db.prepare(`SELECT resource_id AS resourceId, start_at AS startAt, end_at AS endAt,
        reservation_origin = 'minimo' AS reopenOnly FROM reservations
      WHERE store_id = ? AND start_at < ? AND end_at > ?
        AND (status = 'confirmed' OR (status = 'pending_approval' AND pending_expires_at > ?))
      ORDER BY resource_id, start_at, end_at`)
      .bind(account.storeId, end, start, new Date(nowMs).toISOString()).all<BusyInterval>(),
    db.prepare(`SELECT resource_id AS resourceId, start_at AS startAt, end_at AS endAt,
        source = 'minimo' AS reopenOnly FROM external_blocks
      WHERE store_id = ? AND status = 'active' AND start_at < ? AND end_at > ?
      ORDER BY resource_id, start_at, end_at`).bind(account.storeId, end, start).all<BusyInterval>(),
    db.prepare(`SELECT NULL AS resourceId, starts_at AS startAt, ends_at AS endAt FROM store_closures
      WHERE store_id = ? AND starts_at < ? AND ends_at > ? ORDER BY starts_at, ends_at`)
      .bind(account.storeId, end, start).all<BusyInterval>(),
    db.prepare(`SELECT opens_at AS opensAt, closes_at AS closesAt FROM store_business_hours
      WHERE store_id = ? AND weekday = ? AND active = 1 ORDER BY opens_at, closes_at`)
      .bind(account.storeId, weekday).all<AvailabilityInputs["hours"][number]>()
  ]);
  return {
    intervals: [...reservations.results, ...blocks.results, ...closures.results]
      .map((interval) => ({ ...interval, reopenOnly: Boolean(interval.reopenOnly) })),
    hours: hours.results
  };
}
