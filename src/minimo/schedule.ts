import { parseDateJstToUtcIso } from "../date-parse";

export type MinimoReservation = {
  id: string;
  staffId: string;
  status: "confirmed" | "cancelled" | "ignored";
  startAt: string | null;
  endAt: string | null;
};

export type MinimoSchedule = {
  date: string;
  entries: Array<{ staffId: string; openSlots: string[]; reservations: MinimoReservation[] }>;
};

function invalid(): never { throw new Error("Invalid Minimo schedule"); }
export class MinimoDurationMismatch extends Error {
  constructor() { super("Minimo reservation duration mismatch"); this.name = "MinimoDurationMismatch"; }
}
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : invalid();
const identifier = (value: unknown): string => {
  const id = typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? String(value) : value;
  return typeof id === "string" && id.length > 0 && id.length <= 128 && !/[\s\u0000-\u0008\u000e-\u001f\u007f]/.test(id)
    ? id : invalid();
};

function dateTime(value: unknown, requestedDate: string): string {
  if (typeof value !== "string" || value.length > 40) invalid();
  const datePart = /^(\d{4}-\d{2}-\d{2})[ T](.+)$/.exec(value);
  if (!datePart || !parseDateJstToUtcIso(datePart[1])) invalid();
  const zonePart = /(Z|[+-]\d{2}:?\d{2})$/.exec(datePart[2]);
  const timePart = zonePart ? datePart[2].slice(0, zonePart.index) : datePart[2];
  const time = /^(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/.exec(timePart);
  if (!time) invalid();
  const hour = Number(time[1]);
  const minute = Number(time[2]);
  if (hour > 23 || minute > 59 || minute % 5 !== 0 || Number(time[3] ?? 0) !== 0
    || /[1-9]/.test(time[4] ?? "")) invalid();
  const zone = zonePart?.[1] ?? "+09:00";
  if (zone !== "Z" && (Number(zone.slice(1, 3)) > 23 || Number(zone.slice(-2)) > 59)) invalid();
  const normalizedZone = zone.length === 5 ? `${zone.slice(0, 3)}:${zone.slice(3)}` : zone;
  const milliseconds = Date.parse(`${datePart[1]}T${time[1]}:${time[2]}:00.000${normalizedZone}`);
  if (!Number.isFinite(milliseconds)
    || new Date(milliseconds + 9 * 3_600_000).toISOString().slice(0, 10) !== requestedDate
    || milliseconds % 300_000 !== 0) invalid();
  return new Date(milliseconds).toISOString();
}

/** Serialize a validated UTC slot using the original salon-tool JST protocol. */
export function formatMinimoDateTimeJst(value: string, date: string): string {
  const canonical = dateTime(value, date);
  if (canonical !== value) invalid();
  return new Date(Date.parse(canonical) + 9 * 3_600_000).toISOString().slice(0, 19).replace("T", " ");
}

function validateReservationArtist(profile: unknown, staffId: string): void {
  if (profile === undefined || profile === null) return;
  const artist = object(profile);
  const nested = artist.new_entity == null ? {} : object(artist.new_entity);
  for (const embedded of [artist.rima_user_id, nested.rima_user_id]) {
    if (embedded !== undefined && identifier(embedded) !== staffId) invalid();
  }
}

function reservationStatus(value: unknown): MinimoReservation["status"] {
  let status: number | null = null;
  if (typeof value === "number") status = value;
  else if (typeof value === "string" && /^\d{1,4}$/.test(value)) status = Number(value);
  if (status === 1 || status === 2) return "confirmed";
  return status === 11 || status === 12 ? "cancelled" : "ignored";
}

export function parseMinimoSchedule(value: unknown, date: string): MinimoSchedule {
  if (!parseDateJstToUtcIso(date)) invalid();
  const root = object(value);
  if (root.date !== undefined && root.date !== date) invalid();
  if (!Array.isArray(root.entries) || root.entries.length > 200) invalid();
  const seenStaff = new Set<string>();
  const seenReservations = new Set<string>();
  const entries = root.entries.map((value) => {
    const row = object(value);
    const staffId = identifier(object(row.staff).rima_user_id);
    if (seenStaff.has(staffId)) invalid();
    seenStaff.add(staffId);
    if (!Array.isArray(row.schedule) || row.schedule.length > 288
      || !Array.isArray(row.reservation) || row.reservation.length > 500) invalid();
    const openSlots = row.schedule.map((slot) => dateTime(slot, date));
    if (new Set(openSlots).size !== openSlots.length) invalid();
    const reservations = row.reservation.map((value): MinimoReservation => {
      const reservation = object(value);
      const id = identifier(reservation.reservation_id);
      if (seenReservations.has(id) || seenReservations.size >= 2000) invalid();
      seenReservations.add(id);
      validateReservationArtist(reservation.artist_profile, staffId);
      const kind = reservationStatus(reservation.status);
      if (kind !== "confirmed") return { id, staffId, status: kind, startAt: null, endAt: null };
      const startAt = dateTime(reservation.visit_datetime, date);
      const duration = object(reservation.new_menu_entity).time_required;
      if (typeof duration !== "number" || !Number.isInteger(duration)
        || duration < 5 || duration > 720 || duration % 5 !== 0) invalid();
      if (reservation.time_required !== undefined && reservation.time_required !== duration) throw new MinimoDurationMismatch();
      return { id, staffId, status: kind, startAt,
        endAt: new Date(Date.parse(startAt) + duration * 60_000).toISOString() };
    });
    return { staffId, openSlots, reservations };
  });
  return { date, entries };
}

export { identifier as parseMinimoIdentifier, dateTime as parseMinimoDateTime, reservationStatus as parseMinimoReservationStatus };
