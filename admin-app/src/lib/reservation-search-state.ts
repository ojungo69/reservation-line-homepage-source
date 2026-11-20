import { addDays, formatJstDate } from "@/lib/timeline";

export type ReservationViewMode = "today" | "upcoming" | "history" | "pending" | "custom";
export type ReservationSortKey = "startAt" | "customerDisplayName" | "serviceName" | "storeName" | "status";

export const ALL_SENTINEL = "__all__";
// checked_in is not offered: stores do not use the in-visit status.
export const RESERVATION_STATUSES = [
  "pending_approval",
  "confirmed",
  "completed",
  "cancelled_by_admin",
  "cancelled_by_customer",
  "rejected",
  "no_show",
  "expired",
] as const;

function isOfferedStatusFilter(value: unknown): value is string {
  return value === ALL_SENTINEL || (RESERVATION_STATUSES as readonly unknown[]).includes(value);
}

export type ReservationSearchState = {
  from: string;
  to: string;
  serviceId: string;
  statusFilter: string;
  keyword: string;
  sortKey: ReservationSortKey;
  sortDir: "asc" | "desc";
  viewMode: ReservationViewMode;
};

export function reservationPresetRange(mode: "today" | "upcoming" | "history", now = new Date()) {
  return {
    from: formatJstDate(mode === "history" ? addDays(now, -29) : now),
    to: formatJstDate(mode === "upcoming" ? addDays(now, 29) : now),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSearchDate(value: unknown): value is string {
  if (value === "") return true;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

// History state is a browser boundary; never restore another login's search text.
export function readReservationSearchState(raw: unknown, scope: string): ReservationSearchState | null {
  if (!isRecord(raw) || !isRecord(raw.reservationSearch)) return null;
  const saved = raw.reservationSearch;
  if (saved.scope !== scope || !isRecord(saved.value)) return null;
  const v = saved.value;
  if (
    !isSearchDate(v.from) || !isSearchDate(v.to) ||
    typeof v.serviceId !== "string" || v.serviceId.length > 128 ||
    !isOfferedStatusFilter(v.statusFilter) ||
    typeof v.keyword !== "string" || v.keyword.length > 200 ||
    (v.sortKey !== "startAt" && v.sortKey !== "customerDisplayName" && v.sortKey !== "serviceName" && v.sortKey !== "storeName" && v.sortKey !== "status") ||
    (v.sortDir !== "asc" && v.sortDir !== "desc") ||
    (v.viewMode !== "today" && v.viewMode !== "upcoming" && v.viewMode !== "history" && v.viewMode !== "pending" && v.viewMode !== "custom")
  ) return null;
  return {
    from: v.from,
    to: v.to,
    serviceId: v.serviceId,
    statusFilter: v.statusFilter,
    keyword: v.keyword,
    sortKey: v.sortKey,
    sortDir: v.sortDir,
    viewMode: v.viewMode,
  };
}
