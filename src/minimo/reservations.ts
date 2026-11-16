import { parseMinimoDateTime, parseMinimoIdentifier, parseMinimoReservationStatus, type MinimoReservation } from "./schedule";

export type MinimoReservationIndex = {
  id: string; staffId: string; status: MinimoReservation["status"]; date: string | null; startAt: string | null;
};
export type MinimoReservationPage = {
  reservations: MinimoReservationIndex[]; page: number; maxPage: number; total: number;
};

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Minimo reservation response");
  return value as Record<string, unknown>;
}

function reservation(value: unknown): MinimoReservationIndex {
  const row = object(value);
  const id = parseMinimoIdentifier(row.reservation_id);
  if (id === "." || id === "..") throw new Error("Invalid Minimo reservation response");
  const staffId = parseMinimoIdentifier(row.staff_id);
  if (!Number.isSafeInteger(row.status) && !(typeof row.status === "string" && /^\d{1,4}$/.test(row.status))) {
    throw new Error("Invalid Minimo reservation response");
  }
  const status = parseMinimoReservationStatus(row.status);
  if (status !== "confirmed") return { id, staffId, status, date: null, startAt: null };
  if (typeof row.visit_datetime !== "string") throw new Error("Invalid Minimo reservation response");
  const date = row.visit_datetime.slice(0, 10);
  return { id, staffId, status, date, startAt: parseMinimoDateTime(row.visit_datetime, date) };
}

export function parseMinimoReservationPage(value: unknown, expectedPage: number): MinimoReservationPage {
  const root = object(value);
  const paging = object(root._page);
  const { current_page: page, max_page: maxPage, entities: total, entities_by_page: pageSize } = paging;
  if (page !== expectedPage || !Number.isInteger(page) || !Number.isInteger(maxPage) || !Number.isInteger(total)
    || !Number.isInteger(pageSize) || Number(pageSize) < 1 || Number(pageSize) > 1000
    || Number(total) < 0 || Number(total) > 2000 || Number(maxPage) < 0 || Number(maxPage) > 100
    || (Number(maxPage) !== 0 && Number(page) > Number(maxPage)) || !Array.isArray(root.reservations)
    || root.reservations.length > Number(pageSize) || root.reservations.length > Number(total)
    || (Number(maxPage) === 0 && (page !== 1 || total !== 0 || root.reservations.length !== 0))) {
    throw new Error("Invalid Minimo reservation response");
  }
  const reservations = root.reservations.map(reservation);
  if (new Set(reservations.map(row => row.id)).size !== reservations.length) throw new Error("Invalid Minimo reservation response");
  return { reservations, page: Number(page), maxPage: Number(maxPage), total: Number(total) };
}

export function parseMinimoReservationDetail(value: unknown, expectedId: string): MinimoReservationIndex {
  const parsed = reservation(object(value).reservation);
  if (parsed.id !== expectedId) throw new Error("Invalid Minimo reservation response");
  return parsed;
}

export function parseMinimoStaffIds(value: unknown): string[] {
  const rows = object(value).staffs;
  if (!Array.isArray(rows) || rows.length > 200) throw new Error("Invalid Minimo staff response");
  const ids = rows.map(row => parseMinimoIdentifier(object(row).staff_id));
  if (new Set(ids).size !== ids.length) throw new Error("Invalid Minimo staff response");
  return ids;
}

export function parseMinimoBookableMenuDurations(value: unknown): number[] {
  const rows = object(value).menus;
  if (!Array.isArray(rows) || rows.length > 1000) throw new Error("Invalid Minimo menu response");
  return rows.flatMap(value => {
    const row = object(value);
    if (typeof row.is_open !== "boolean" || typeof row.is_enable !== "boolean") throw new Error("Invalid Minimo menu response");
    if (!row.is_open || !row.is_enable) return [];
    const duration = row.time_required;
    if (typeof duration !== "number" || !Number.isInteger(duration) || duration < 5 || duration > 720 || duration % 5 !== 0) {
      throw new Error("Invalid Minimo menu response");
    }
    return [duration];
  });
}
