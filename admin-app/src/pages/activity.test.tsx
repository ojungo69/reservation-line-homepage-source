import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuditLogItem } from "@/types/api";

let auditState: {
  data: { ok: true; auditLogs: AuditLogItem[] } | undefined;
  isPending: boolean;
  isError: boolean;
};
const refetchAuditLogs = vi.fn();

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ user: { role: "owner" } }),
}));

vi.mock("@/hooks/use-settings", () => ({
  useSettings: () => ({ data: undefined }),
}));

vi.mock("@/hooks/use-audit-logs", () => ({
  useAuditLogs: () => ({ ...auditState, refetch: refetchAuditLogs }),
}));

import ActivityPage from "./activity";

const auditLog = (n: number): AuditLogItem => ({
  id: `log-${n}`,
  actorType: "staff",
  actorId: "staff-1",
  action: "admin_reservation_approve",
  targetType: "reservation",
  targetId: `reservation-${n}`,
  metadataJson: null,
  actorName: null,
  rejectionReason: null,
  createdAt: "2026-07-24T10:00:00+09:00",
});

beforeEach(() => {
  // 既定フィルタは「今日を含む7暦日」なので、固定日にしないと createdAt 固定の
  // フィクスチャがいずれ範囲外になり無変更で腐る ([[date-dependent-admin-tests-rot]])。
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-07-24T12:00:00+09:00"));
  refetchAuditLogs.mockClear();
  auditState = { data: undefined, isPending: true, isError: false };
});

afterEach(() => {
  vi.useRealTimers();
});

describe("ActivityPage", () => {
  it("操作者フィルタをラベル名で取得できる", () => {
    render(<ActivityPage />);

    expect(screen.getByRole("combobox", { name: "操作者" })).toBeTruthy();
  });

  it("読込中・失敗・空一覧を区別する", () => {
    const { rerender } = render(<ActivityPage />);
    expect(document.querySelectorAll(".animate-pulse").length).toBeGreaterThan(0);

    auditState = { data: undefined, isPending: false, isError: true };
    rerender(<ActivityPage />);
    expect(screen.getByRole("alert").textContent).toContain("操作記録の取得に失敗しました");

    auditState = { data: { ok: true, auditLogs: [] }, isPending: false, isError: false };
    rerender(<ActivityPage />);
    expect(screen.getByText("該当する操作記録はありません")).toBeTruthy();
    expect(screen.queryByText(/表示件数が上限に達しました/)).toBeNull();
  });

  it("サーバ上限の200件に達したときだけ打ち切りを警告する", () => {
    auditState = {
      data: { ok: true, auditLogs: Array.from({ length: 200 }, (_, i) => auditLog(i)) },
      isPending: false,
      isError: false,
    };
    const { rerender } = render(<ActivityPage />);
    expect(screen.getByText(/表示件数が上限に達しました/)).toBeTruthy();
    // 記録本体も描画されている(警告だけの画面ではない)。
    expect(screen.getByText("2026-07-24")).toBeTruthy();

    auditState = {
      data: { ok: true, auditLogs: Array.from({ length: 199 }, (_, i) => auditLog(i)) },
      isPending: false,
      isError: false,
    };
    rerender(<ActivityPage />);
    expect(screen.queryByText(/表示件数が上限に達しました/)).toBeNull();
  });

  it("取得失敗時は空一覧を表示せず再読み込みできる", async () => {
    auditState = { data: undefined, isPending: false, isError: true };
    render(<ActivityPage />);

    expect(screen.getByRole("alert").textContent).toContain("操作記録の取得に失敗しました。");
    expect(screen.queryByText("該当する操作記録はありません")).toBeNull();
    await userEvent.setup().click(screen.getByRole("button", { name: "再読み込み" }));
    expect(refetchAuditLogs).toHaveBeenCalledTimes(1);
  });

  it("再取得に失敗したとき前回の記録と上限警告を表示しない", () => {
    auditState = {
      data: { ok: true, auditLogs: Array.from({ length: 200 }, (_, i) => auditLog(i)) },
      isPending: false,
      isError: false,
    };
    const { rerender } = render(<ActivityPage />);
    expect(screen.getByRole("button", { name: "IDをコピー: reservation-0" })).toBeTruthy();
    expect(screen.getByText(/表示件数が上限に達しました/)).toBeTruthy();

    auditState = { ...auditState, isError: true };
    rerender(<ActivityPage />);

    expect(screen.getByRole("alert").textContent).toContain("操作記録の取得に失敗しました。");
    expect(screen.queryAllByRole("button", { name: /IDをコピー:/ })).toHaveLength(0);
    expect(screen.queryByText(/表示件数が上限に達しました/)).toBeNull();
    expect(screen.queryByText("該当する操作記録はありません")).toBeNull();
    expect(screen.getByRole("button", { name: "再読み込み" })).toBeTruthy();
  });
});
