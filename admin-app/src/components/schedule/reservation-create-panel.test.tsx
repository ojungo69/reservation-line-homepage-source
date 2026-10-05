import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const createReservation = vi.fn();

vi.mock("@/hooks/use-reservations", () => ({
  useCreateReservation: () => ({ mutate: createReservation, isPending: false }),
  useAvailableSlots: () => ({
    data: {
      ok: true,
      slots: [{
        resourceId: "resource-1",
        resourceName: "担当A",
        startAt: "2026-07-24T10:00:00+09:00",
        available: true,
      }],
    },
    isFetching: false,
    isError: false,
  }),
}));

vi.mock("@/hooks/use-settings", () => ({
  useSettings: () => ({
    data: {
      ok: true,
      settings: {
        stores: [{ id: "store-1", name: "新宿店" }],
        resources: [{
          id: "resource-1",
          storeId: "store-1",
          name: "担当A",
          active: true,
        }],
        services: [
          {
            id: "service-1",
            storeId: "store-1",
            name: "基本メニュー",
            durationMinutes: 60,
            active: true,
          },
          {
            id: "service-2",
            storeId: "store-1",
            name: "追加メニュー",
            durationMinutes: 30,
            active: true,
          },
        ],
      },
    },
  }),
}));

vi.mock("@/hooks/use-customers", () => ({
  useCustomerSearch: () => ({
    data: {
      ok: true,
      customers: [{
        id: "customer-2",
        displayName: "検索 花子",
        displayNameKana: "ケンサク ハナコ",
        phoneNormalized: "09012345678",
      }],
    },
    isFetching: false,
    isError: false,
  }),
}));

import { ReservationCreatePanel } from "./reservation-create-panel";

beforeEach(() => {
  createReservation.mockReset();
});

describe("ReservationCreatePanel", () => {
  it("複数メニューと新規顧客を確認して予約作成へ渡す", async () => {
    const user = userEvent.setup();
    render(
      <ReservationCreatePanel
        open
        onClose={() => {}}
        defaultStoreId="store-1"
        defaultResourceId="resource-1"
        defaultDate={new Date("2026-07-24T00:00:00+09:00")}
        defaultMinutes={600}
        defaultServiceIds={["service-1"]}
        defaultCustomer={{
          id: "customer-1",
          displayName: "既存 花子",
          displayNameKana: "キゾン ハナコ",
          phone: "09012345678",
        }}
      />,
    );

    expect(screen.getByText("既存 花子 様で予約")).toBeTruthy();
    await user.click(screen.getByRole("tab", { name: "既存のお客様" }));
    await user.click(screen.getByRole("checkbox", { name: /追加メニュー/ }));
    expect(screen.getByText("選択中 2件・施術 合計90分")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "選び直す" }));
    const search = screen.getByLabelText("既存顧客を検索");
    expect(search.getAttribute("type")).toBe("search");
    expect(search.getAttribute("aria-describedby")).toBe("rcp-customer-search-help");
    await user.type(search, "花子");
    const customerList = await screen.findByRole("list", { name: "顧客候補" });
    expect(search.getAttribute("aria-controls")).toBe(customerList.parentElement?.id);
    const customerOption = screen.getByRole("button", { name: /検索 花子/ });
    await user.tab();
    expect(document.activeElement).toBe(customerOption);
    await user.keyboard("{Enter}");
    expect(screen.getByText("検索 花子 様で予約")).toBeTruthy();

    await user.click(screen.getByRole("tab", { name: "新規のお客様" }));
    const name = screen.getByLabelText("氏名");
    const kana = screen.getByLabelText("カナ");
    const phone = screen.getByLabelText("電話番号");
    await user.clear(name);
    await user.clear(kana);
    await user.clear(phone);
    await user.type(name, "新規 太郎");
    await user.type(kana, "シンキ タロウ");
    await user.type(phone, "090-1111-2222");
    await user.click(screen.getByRole("button", { name: "予約作成" }));

    expect(screen.getByText(/新規 太郎 様/)).toBeTruthy();
    expect(screen.getByText(/基本メニュー \/ 追加メニュー/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "戻る" }));
    await user.click(screen.getByRole("button", { name: "予約作成" }));
    await user.click(screen.getByRole("button", { name: "この内容で予約" }));

    expect(createReservation).toHaveBeenCalledWith(
      expect.objectContaining({
        storeId: "store-1",
        resourceId: "resource-1",
        serviceIds: ["service-1", "service-2"],
        customer: {
          displayName: "新規 太郎",
          displayNameKana: "シンキ タロウ",
          phone: "090-1111-2222",
        },
      }),
      expect.objectContaining({ onSuccess: expect.any(Function) }),
    );
  });

  it("店舗未選択時はメニュー選択前の案内を表示する", () => {
    render(
      <ReservationCreatePanel
        open
        onClose={() => {}}
        defaultStoreId={null}
        defaultResourceId={null}
        defaultDate={new Date("2026-07-24T00:00:00+09:00")}
        defaultMinutes={null}
      />,
    );
    expect(screen.getByText("店舗を選択してください")).toBeTruthy();
  });
});
