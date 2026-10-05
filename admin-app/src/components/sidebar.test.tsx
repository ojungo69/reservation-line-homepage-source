import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";

let isPrivileged = true;

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    user: {
      role: isPrivileged ? "owner" : "staff",
      email: "test@example.com",
      storeId: isPrivileged ? null : "store-1",
    },
    isPrivileged,
  }),
}));

vi.mock("@/hooks/use-reservations", () => ({
  usePendingReservations: () => ({ data: { ok: true, reservations: [{}, {}] } }),
}));

import { Sidebar } from "./sidebar";

const renderSidebar = () =>
  render(
    <MemoryRouter>
      <Sidebar />
    </MemoryRouter>,
  );

describe("Sidebar 設定セクションの権限ゲート", () => {
  it("owner は設定セクションに5項目すべて見える", () => {
    isPrivileged = true;
    renderSidebar();

    expect(screen.getByText("設定")).toBeTruthy();
    for (const label of ["通知", "店舗設定", "店舗ログイン", "Google連携", "操作記録"]) {
      expect(screen.getByRole("link", { name: label })).toBeTruthy();
    }
    // 未対応バッジ (pending 2件) がスケジュールに付く
    expect(screen.getByLabelText("未対応 2件")).toBeTruthy();
  });

  it("staff は設定セクションが出て、privileged 項目だけ消える", () => {
    isPrivileged = false;
    renderSidebar();

    // セクション自体は「staff に見える項目が1つでもあるか」で表示される
    expect(screen.getByText("設定")).toBeTruthy();
    expect(screen.getByRole("link", { name: "通知" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "店舗設定" })).toBeTruthy();
    for (const label of ["店舗ログイン", "Google連携", "操作記録", "スタッフ"]) {
      expect(screen.queryByRole("link", { name: label })).toBeNull();
    }
  });
});
