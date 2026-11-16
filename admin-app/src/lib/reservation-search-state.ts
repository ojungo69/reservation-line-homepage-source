import { addDays, formatJstDate } from "@/lib/timeline";

export type ReservationViewMode = "today" | "upcoming" | "history" | "pending" | "custom";
export type ReservationSortKey = "startAt" | "customerDisplayName" | "serviceName" | "storeName" | "status";

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

// History state is a browser boundary; never restore another login's search text.
export function readReservationSearchState(raw: unknown, scope: string): ReservationSearchState | null {
  if (!isRecord(raw) || !isRecord(raw.reservationSearch)) return null;
  const saved = raw.reservationSearch;
  if (saved.scope !== scope || !isRecord(saved.value)) return null;
  const v = saved.value;
  if (
    typeof v.from !== "string" || !/^(\d{4}-\d{2}-\d{2})?$/.test(v.from) ||
    typeof v.to !== "string" || !/^(\d{4}-\d{2}-\d{2})?$/.test(v.to) ||
    typeof v.serviceId !== "string" || v.serviceId.length > 128 ||
    typeof v.statusFilter !== "string" || v.statusFilter.length > 64 ||
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
