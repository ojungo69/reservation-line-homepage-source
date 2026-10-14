import { useState } from "react";
import { isInaccessible, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Store } from "@/types/api";

let initialStoreId: string | null = null;
let isStoreFixed = false;

const stores: Store[] = ["本店", "支店"].map((name, index) => ({
  id: `store-${index + 1}`,
  name,
  timezone: "Asia/Tokyo",
  googleCalendarId: null,
  googleControlledEditMode: false,
  maxActiveReservationsPerCustomer: 2,
  bookingWindowDays: 30,
  customerNotice: null,
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ user: { email: "owner@example.com", role: "owner" }, isPrivileged: true }),
}));

vi.mock("@/hooks/use-theme", () => ({
  useTheme: () => ({ theme: "system", setTheme: vi.fn() }),
}));

vi.mock("@/hooks/use-stores", () => ({
  useStores: () => {
    const [selectedStoreId, selectStore] = useState(initialStoreId);
    return { stores, selectedStoreId, selectStore, isStoreFixed };
  },
}));

import { Header } from "./header";

beforeEach(() => {
  initialStoreId = null;
  isStoreFixed = false;
});

const renderHeader = () => render(
  <MemoryRouter>
    {/* Tailwind の base hidden を適用し、sm より小さい画面の非表示を再現する。 */}
    <style>{".hidden { display: none; } .invisible { visibility: hidden; }"}</style>
    <Header />
  </MemoryRouter>,
);

describe("Header の店舗スコープ", () => {
  it.each([
    { storeId: null, fixed: false, label: "全店舗" },
    { storeId: "store-2", fixed: false, label: "支店" },
    { storeId: "store-1", fixed: true, label: "本店" },
  ])("小さい画面でも現在の $label を表示する", ({ storeId, fixed, label }) => {
    initialStoreId = storeId;
    isStoreFixed = fixed;
    renderHeader();

    expect(isInaccessible(screen.getByText(label))).toBe(false);
    if (fixed) expect(screen.queryByRole("button", { name: /^店舗を切り替え/ })).toBeNull();
  });

  it.each([
    { storeId: null, label: "全店舗" },
    { storeId: "store-2", label: "支店" },
  ])("店舗切替の読み上げ名にも現在の $label を含める", ({ storeId, label }) => {
    initialStoreId = storeId;
    renderHeader();

    expect(screen.getByRole("button", { name: `店舗を切り替え（現在：${label}）` })).toBeTruthy();
  });

  it("全店舗と特定店舗の選択状態を読み取り、マウスとキーボードで切り替えられる", async () => {
    const user = userEvent.setup();
    renderHeader();
    const switcher = screen.getByRole("button", { name: /^店舗を切り替え/ });

    await user.click(switcher);
    const allStores = screen.getByRole("menuitemradio", { name: "全店舗", checked: true });
    const branch = screen.getByRole("menuitemradio", { name: "支店", checked: false });
    const allStoresMarker = allStores.querySelector("svg");
    const branchMarker = branch.querySelector("svg");
    expect(allStoresMarker && getComputedStyle(allStoresMarker).visibility).toBe("visible");
    expect(branchMarker && getComputedStyle(branchMarker).visibility).toBe("hidden");
    await user.click(branch);

    expect(within(switcher).getByText("支店")).toBeTruthy();
    switcher.focus();
    await user.keyboard("{ArrowDown}");
    const selectedBranch = screen.getByRole("menuitemradio", { name: "支店", checked: true });
    expect(screen.getByRole("menuitemradio", { name: "全店舗", checked: false })).toBeTruthy();
    const selectedMarker = selectedBranch.querySelector("svg");
    expect(selectedMarker && getComputedStyle(selectedMarker).visibility).toBe("visible");

    selectedBranch.focus();
    await user.keyboard("{Home}{Enter}");
    expect(within(switcher).getByText("全店舗")).toBeTruthy();
    await user.click(switcher);
    expect(screen.getByRole("menuitemradio", { name: "全店舗", checked: true })).toBeTruthy();
    expect(screen.getByRole("menuitemradio", { name: "支店", checked: false })).toBeTruthy();
  });
});
