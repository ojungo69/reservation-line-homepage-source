import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import { showErrorToast } from "@/lib/error-messages";

type GateRequestResponse = { ok: true; challengeId: string; expiresAt: string };
type GateVerifyResponse = { ok: true; grantedUntil: string };

/** オーナー宛メールに確認コードを送らせる。コードは応答には含まれない。 */
export function useCustomerGateRequest() {
  return useMutation({
    mutationFn: () => api.post<GateRequestResponse>("/api/admin/customer-gate/request"),
    onError: (error) => showErrorToast(error),
  });
}

/**
 * 確認コードを検証して承認を得る。成功したら顧客系のクエリを捨てて引き直す
 * (承認前は 403 が入っているため、再取得しないと画面が変わらない)。
 */
export function useCustomerGateVerify() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { challengeId: string; code: string }) =>
      api.post<GateVerifyResponse>("/api/admin/customer-gate/verify", input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["customers"] });
    },
    onError: (error) => showErrorToast(error),
  });
}
