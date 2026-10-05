import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import type { AuditLogResponse } from "@/types/api";

export type AuditLogFilter = {
  from?: string;
  to?: string;
  actorType?: string;
  keyword?: string;
};

export function useAuditLogs(filter: AuditLogFilter) {
  const params = new URLSearchParams();
  if (filter.from) params.set("from", filter.from);
  if (filter.to) params.set("to", filter.to);
  if (filter.actorType) params.set("actorType", filter.actorType);
  if (filter.keyword?.trim()) params.set("keyword", filter.keyword.trim());
  const qs = params.toString();
  const qsSuffix = qs ? `?${qs}` : "";
  return useQuery({
    queryKey: ["audit-logs", filter],
    queryFn: () =>
      api.get<AuditLogResponse>(`/api/admin/audit-logs${qsSuffix}`),
    staleTime: 30_000,
    placeholderData: (prev) => prev,
  });
}
