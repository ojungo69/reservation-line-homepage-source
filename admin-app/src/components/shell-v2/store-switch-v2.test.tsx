import { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Store } from "@/types/api";

const makeStores = (names: string[]): Store[] =>
  names.map((name, index) => ({
    id: `store-${index + 1}`,
    name,
    timezone: "Asia/Tokyo",
    googleCalendarId: null,
    googleControlledEditMode: false,
    maxActiveReservationsPerCustomer: 2,
    bookingWindowDays: 30,
    customerNotice: null,
  }));

let stores = makeStores(["本店", "支店"]);
let initialStoreId: string | null = null;
let isStoreFixed = false;

vi.mock("@/hooks/use-stores", () => ({
  useStores: () => {
    const [selectedStoreId, selectStore] = useState(initialStoreId);
    return { stores, selectedStoreId, selectStore, isStoreFixed };
  },
}));

import { StoreSwitchV2 } from "./store-switch-v2";

beforeEach(() => {
  stores = makeStores(["本店", "支店"]);
  initialStoreId = null;
  isStoreFixed = false;
});

describe("StoreSwitchV2", () => {
  it("複数の店舗を見られる人は、全店舗と各店舗から選べる", async () => {
    const user = userEvent.setup();
    render(<StoreSwitchV2 />);
    await user.click(screen.getByRole("button", { name: "店舗を切り替え（現在：全店舗）" }));
    const options = screen.getAllByRole("menuitemradio");
    expect(options.map((option) => option.textContent)).toEqual(["全店舗", "本店", "支店"]);
    expect(options[0].getAttribute("aria-checked")).toBe("true");

    await user.click(screen.getByRole("menuitemradio", { name: "支店" }));
    expect(screen.getByRole("button", { name: "店舗を切り替え（現在：支店）" })).toBeTruthy();
  });

  it("店舗スタッフは自分の店舗の名前だけを見て、切り替えられない", () => {
    isStoreFixed = true;
    initialStoreId = "store-1";
    render(<StoreSwitchV2 />);
    expect(screen.queryByRole("button", { name: /店舗を切り替え/ })).toBeNull();
    expect(screen.getByText("本店")).toBeTruthy();
  });

  it("見られる店舗が 1 つだけなら、全店舗ではなくその店舗の名前を出す", () => {
    stores = makeStores(["本店"]);
    render(<StoreSwitchV2 />);
    expect(screen.queryByRole("button", { name: /店舗を切り替え/ })).toBeNull();
    expect(screen.getByText("本店")).toBeTruthy();
    expect(screen.queryByText("全店舗")).toBeNull();
  });
});
