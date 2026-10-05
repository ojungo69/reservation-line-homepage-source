import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import type { LineQuotaResponse, LineQuotaStatus } from "@/types/api";

/**
 * This month's LINE push usage vs the free-plan 200/month cap (owner-only).
 * Returns null until the cron has fetched the quota at least once this month.
 */
export function useLineQuota() {
  const query = useQuery({
    queryKey: ["line-quota"],
    queryFn: () => api.get<LineQuotaResponse>("/api/admin/line-quota"),
    staleTime: 5 * 60_000,
    select: (d): LineQuotaStatus | null => d?.quota ?? null,
  });
  return { quota: query.data ?? null, isPending: query.isPending, isError: query.isError };
}
