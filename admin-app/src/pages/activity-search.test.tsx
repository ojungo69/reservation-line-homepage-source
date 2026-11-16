import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, api } from "@/lib/api-client";
import { createTestQueryClient, createQueryWrapper } from "@/test-utils/query-client";
import type { AuditLogResponse } from "@/types/api";
import ActivityPage from "./activity";

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ user: { role: "owner" } }),
}));
vi.mock("@/hooks/use-settings", () => ({ useSettings: () => ({ data: undefined }) }));

const response: AuditLogResponse = {
  ok: true,
  auditLogs: [{
    id: "log-1",
    actorType: "staff",
    actorId: "staff-1",
    action: "admin_reservation_approve",
    targetType: "reservation",
    targetId: "reservation-1",
    metadataJson: null,
    actorName: null,
    rejectionReason: null,
    createdAt: "2026-11-16T10:00:00+09:00",
  }],
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ActivityPage search feedback", () => {
  it("debounce中と遅い検索中に旧記録・上限警告・空一覧を表示しない", async () => {
    let completeSearch!: (result: AuditLogResponse) => void;
    const get = vi.spyOn(api, "get")
      .mockResolvedValueOnce({
        ...response,
        auditLogs: Array.from({ length: 200 }, (_, i) => ({
          ...response.auditLogs[0], id: `log-${i}`, targetId: `reservation-${i}`,
        })),
      })
      .mockImplementationOnce(() => new Promise((resolve) => { completeSearch = resolve; }));
    const client = createTestQueryClient();
    render(<ActivityPage />, { wrapper: createQueryWrapper(client) });
    await screen.findByRole("button", { name: "IDをコピー: reservation-0" });
    expect(screen.getByText(/表示件数が上限に達しました/)).toBeTruthy();

    fireEvent.change(screen.getByLabelText("キーワード"), { target: { value: "存在しない操作" } });

    expect(screen.queryAllByRole("button", { name: /IDをコピー:/ })).toHaveLength(0);
    expect(screen.queryByText(/表示件数が上限に達しました/)).toBeNull();
    expect(screen.queryByText("該当する操作記録はありません")).toBeNull();
    expect(screen.getByRole("status").textContent).toContain("検索中です");
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
    expect(screen.queryAllByRole("button", { name: /IDをコピー:/ })).toHaveLength(0);
    expect(screen.getByRole("status")).toBeTruthy();

    completeSearch({ ok: true, auditLogs: [] });
    await screen.findByText("該当する操作記録はありません");
    expect(screen.queryByRole("status")).toBeNull();
    client.clear();
  });

  it("同条件の再取得中も旧記録を隠し、失敗は空一覧と区別して再読み込みできる", async () => {
    let failRefresh!: (error: unknown) => void;
    vi.spyOn(api, "get")
      .mockResolvedValueOnce(response)
      .mockImplementationOnce(() => new Promise((_resolve, reject) => { failRefresh = reject; }))
      .mockResolvedValueOnce(response);
    const client = createTestQueryClient();
    render(<ActivityPage />, { wrapper: createQueryWrapper(client) });
    await screen.findByRole("button", { name: "IDをコピー: reservation-1" });

    act(() => { void client.invalidateQueries({ queryKey: ["audit-logs"] }); });
    await screen.findByRole("status");
    expect(screen.queryAllByRole("button", { name: /IDをコピー:/ })).toHaveLength(0);

    failRefresh(new ApiError(500, { ok: false }));
    await screen.findByRole("alert");
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryAllByRole("button", { name: /IDをコピー:/ })).toHaveLength(0);
    expect(screen.queryByText("該当する操作記録はありません")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "再読み込み" }));
    await screen.findByRole("button", { name: "IDをコピー: reservation-1" });
    expect(screen.queryByRole("alert")).toBeNull();
    client.clear();
  });
});
