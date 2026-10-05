import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import type { ReservationSearchResponse } from "@/types/api";

export type ReservationSearchFilter = {
  from: string;
  to: string;
  storeId?: string;
  serviceId?: string;
  statuses?: string[];
  keyword?: string;
};

function buildSearchParams(filter: ReservationSearchFilter): string {
  const params = new URLSearchParams();
  params.set("from", filter.from);
  params.set("to", filter.to);
  if (filter.storeId) params.set("storeId", filter.storeId);
  if (filter.serviceId) params.set("serviceId", filter.serviceId);
  if (filter.statuses?.length) {
    for (const s of filter.statuses) params.append("status", s);
  }
  if (filter.keyword?.trim()) params.set("keyword", filter.keyword.trim());
  return params.toString();
}

export function useReservationSearch(filter: ReservationSearchFilter | null) {
  return useQuery({
    queryKey: ["reservations", "search", filter],
    queryFn: () =>
      api.get<ReservationSearchResponse>(
        `/api/admin/reservations/search?${buildSearchParams(filter!)}`,
      ),
    enabled: !!filter,
    staleTime: 30_000,
    placeholderData: (prev) => prev,
  });
}

export function buildCsvExportUrl(filter: ReservationSearchFilter): string {
  return `/api/admin/reservations/export.csv?${buildSearchParams(filter)}`;
}
