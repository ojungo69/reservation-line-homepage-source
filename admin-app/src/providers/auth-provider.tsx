import { type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, ApiError } from "@/lib/api-client";
import { ACCESS_LOGOUT_PATH } from "@/lib/auth-logout";
import { Button } from "@/components/ui/button";
import { AuthContext, type AuthUser } from "@/providers/auth-context";

type MeResponse = {
  ok: true;
  admin: AuthUser;
  /** Absent on older deployments — treated as "push not configured". */
  vapidPublicKey?: string;
};

export function AuthProvider({ children }: Readonly<{ children: ReactNode }>) {
  const { data, isPending, isError, error, refetch, isFetching } = useQuery({
    queryKey: ["auth", "me"],
    queryFn: ({ signal }) => api.get<MeResponse>("/api/admin/me", { signal }),
    staleTime: 5 * 60_000,
    retry: false,
  });

  if (isPending) {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="h-8 w-48 animate-pulse rounded bg-muted" />
      </div>
    );
  }

  const authError = error instanceof ApiError && (error.status === 401 || error.status === 403);
  if (!data?.ok || (isError && authError)) {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="max-w-sm space-y-4 p-4 text-center" role="alert">
          <h1 className="text-lg font-semibold">{authError ? "ログイン・権限を確認してください" : "接続できませんでした"}</h1>
          <p className="text-muted-foreground">
            {authError
              ? "ログインの有効期限、または管理者アカウントの権限を確認してください。"
              : "通信またはサーバーの問題で管理画面を読み込めません。時間をおいて再取得してください。"}
          </p>
          <div className="flex justify-center gap-2">
            <Button onClick={() => { void refetch(); }} disabled={isFetching}>再取得</Button>
            {authError && <Button asChild variant="outline"><a href={ACCESS_LOGOUT_PATH}>再ログイン</a></Button>}
          </div>
        </div>
      </div>
    );
  }

  const user = data.admin;
  const isPrivileged = user.role === "owner" || user.role === "system_admin";

  return (
    <AuthContext value={{ user, isPrivileged, vapidPublicKey: data.vapidPublicKey ?? "" }}>
      {isError && <div className="flex items-center justify-center gap-2 border-b p-2 text-sm" role="alert">
        <p>ログイン状態の更新に失敗しました。入力内容は保持されています。</p>
        <Button size="sm" variant="outline" onClick={() => { void refetch(); }} disabled={isFetching}>再取得</Button>
      </div>}
      {children}
    </AuthContext>
  );
}
