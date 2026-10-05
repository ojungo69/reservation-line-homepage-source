import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Service } from "@/types/api";

type AuthState = {
  user: { role: "owner" | "system_admin" | "staff"; storeId: string | null };
  isPrivileged: boolean;
};

let auth: AuthState = { user: { role: "owner", storeId: null }, isPrivileged: true };
let services: Service[] = [];

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => auth,
}));

vi.mock("@/hooks/use-stores", () => ({
  useStores: () => ({
    stores: [{ id: "store-1", name: "和歌山店" }],
    selectedStoreId: null,
    selectStore: () => {},
    isStoreFixed: auth.user.role === "staff",
  }),
}));

vi.mock("@/hooks/use-services", () => ({
  useServiceList: () => ({
    serviceList: services,
    storeNames: new Map([["store-1", "和歌山店"]]),
    isPending: false,
  }),
}));

// 権限導出 (canManageMenus / canEditSelected) の検証が目的なので、
// 子コンポーネントは受け取った props を可視化するだけの stub にする。
vi.mock("@/components/menu/service-detail-panel", () => ({
  ServiceDetailPanel: ({ service, canEdit }: { service: Service | null; canEdit: boolean }) =>
    service ? <div>panel:{service.id}:canEdit={String(canEdit)}</div> : null,
}));

vi.mock("@/components/menu/service-create-dialog", () => ({
  ServiceCreateDialog: () => <div>create-dialog</div>,
}));

import MenuPage from "./menu";

const makeService = (id: string, storeId: string): Service => ({
  id,
  storeId,
  name: "脱毛｜全身",
  durationMinutes: 60,
  priceLabel: null,
  priceAmount: null,
  comboPriceAmount: null,
  comboWithPrefix: null,
  active: true,
  mensMenu: false,
});

beforeEach(() => {
  auth = { user: { role: "owner", storeId: null }, isPrivileged: true };
  services = [makeService("service-1", "store-1")];
});

describe("MenuPage 権限マトリクス", () => {
  it("owner は追加ボタンが見え、選択したメニューを編集できる", async () => {
    const user = userEvent.setup();
    render(<MenuPage />);

    expect(screen.getByRole("button", { name: "+ 追加" })).toBeTruthy();
    await user.click(screen.getByText("脱毛｜全身"));
    expect(screen.getByText("panel:service-1:canEdit=true")).toBeTruthy();
  });

  it("自店舗の staff は追加ボタンが見え、自店舗メニューを編集できる", async () => {
    auth = { user: { role: "staff", storeId: "store-1" }, isPrivileged: false };
    const user = userEvent.setup();
    render(<MenuPage />);

    expect(screen.getByRole("button", { name: "+ 追加" })).toBeTruthy();
    await user.click(screen.getByText("脱毛｜全身"));
    expect(screen.getByText("panel:service-1:canEdit=true")).toBeTruthy();
  });

  it("staff が他店舗のメニューを開いても編集は出ない (防御的ゲート)", async () => {
    auth = { user: { role: "staff", storeId: "store-1" }, isPrivileged: false };
    services = [makeService("service-2", "store-2")];
    const user = userEvent.setup();
    render(<MenuPage />);

    await user.click(screen.getByText("脱毛｜全身"));
    expect(screen.getByText("panel:service-2:canEdit=false")).toBeTruthy();
  });

  it("店舗未紐付けの staff には追加ボタンを出さない", () => {
    auth = { user: { role: "staff", storeId: null }, isPrivileged: false };
    render(<MenuPage />);

    expect(screen.queryByRole("button", { name: "+ 追加" })).toBeNull();
    expect(screen.queryByText("create-dialog")).toBeNull();
  });
});
