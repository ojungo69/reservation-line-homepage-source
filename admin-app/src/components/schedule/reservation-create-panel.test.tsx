import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const createReservation = vi.fn();
const customerState = vi.hoisted(() => ({ empty: false, isPrivileged: true, truncated: false, pending: false }));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ isPrivileged: customerState.isPrivileged }),
}));

vi.mock("@/hooks/use-reservations", () => ({
  useCreateReservation: () => ({ mutate: createReservation, isPending: customerState.pending }),
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
      truncated: customerState.truncated,
      customers: customerState.empty ? [] : [{
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

async function dismissPanel(user: ReturnType<typeof userEvent.setup>, dismissal: string) {
  if (dismissal === "Escape") {
    await user.keyboard("{Escape}");
  } else if (dismissal === "オーバーレイ") {
    const overlay = screen.getByRole("dialog", { name: "予約作成" }).previousElementSibling;
    if (!overlay) throw new Error("sheet overlay missing");
    await user.click(overlay);
  } else {
    await user.click(screen.getByRole("button", { name: dismissal }));
  }
}

beforeEach(() => {
  createReservation.mockReset();
  customerState.empty = false;
  customerState.isPrivileged = true;
  customerState.truncated = false;
  customerState.pending = false;
});

describe("ReservationCreatePanel", () => {
  it("日付をまたいでスケジュールの初期日が変わっても未入力の予約は確認なしで閉じる", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const props = {
      open: true,
      onClose,
      defaultStoreId: "store-1",
      defaultResourceId: "resource-1",
      defaultDate: new Date("2026-07-24T00:00:00+09:00"),
      defaultMinutes: 600,
    };
    const { rerender } = render(<ReservationCreatePanel {...props} />);
    rerender(<ReservationCreatePanel {...props} defaultDate={new Date("2026-07-25T00:00:00+09:00")} />);

    expect(screen.getByLabelText("日付")).toHaveProperty("value", "2026-07-24");
    await user.click(screen.getByRole("button", { name: "キャンセル" }));

    expect(onClose).toHaveBeenCalledOnce();
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("顧客検索中に Esc で閉じようとして編集に戻っても検索語を保持する", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <ReservationCreatePanel
        open
        onClose={onClose}
        defaultStoreId="store-1"
        defaultResourceId="resource-1"
        defaultDate={new Date("2026-07-24T00:00:00+09:00")}
        defaultMinutes={600}
      />,
    );
    const search = screen.getByLabelText("既存顧客を検索");
    await user.type(search, "検索");
    await screen.findByRole("list", { name: "顧客候補" });
    await user.keyboard("{Escape}");
    expect(onClose).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "編集に戻る" }));

    expect(search).toHaveProperty("value", "検索");
  });

  it.each(["メニュー", "顧客検索", "既存顧客", "リソース", "日付", "時間", "カナ", "電話番号", "予約経路", "店舗"])("%s だけの入力でも閉じる前に確認する", async (field) => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <ReservationCreatePanel
        open
        onClose={onClose}
        defaultStoreId={field === "店舗" ? null : "store-1"}
        defaultResourceId={field === "リソース" ? null : "resource-1"}
        defaultDate={new Date("2026-07-24T00:00:00+09:00")}
        defaultMinutes={600}
      />,
    );

    if (field === "メニュー") {
      await user.click(screen.getByRole("checkbox", { name: /基本メニュー/ }));
    } else if (field === "顧客検索" || field === "既存顧客") {
      fireEvent.change(screen.getByLabelText("既存顧客を検索"), { target: { value: "検索" } });
      if (field === "既存顧客") await user.click(await screen.findByRole("button", { name: /検索 花子/ }));
    } else if (field === "日付" || field === "時間") {
      fireEvent.change(screen.getByLabelText(field), { target: { value: field === "日付" ? "2026-07-25" : "11:00" } });
    } else if (field === "カナ" || field === "電話番号") {
      await user.click(screen.getByRole("tab", { name: "新規のお客様" }));
      await user.type(screen.getByLabelText(field), field === "カナ" ? "ハナコ" : "09012345678");
    } else {
      const label = field === "リソース" ? "担当A" : field === "店舗" ? "新宿店" : "その他";
      const select = screen.getByRole("combobox", { name: field });
      select.focus();
      await user.keyboard(label);
      expect(select.textContent).toContain(label);
    }

    await user.click(screen.getByRole("button", { name: "キャンセル" }));

    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("alertdialog", { name: "予約の入力を取り消しますか？" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "編集に戻る" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("予約作成中は Esc でも閉じず、作成成功後は破棄確認なしで閉じる", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const props = {
      open: true,
      onClose,
      defaultStoreId: "store-1",
      defaultResourceId: "resource-1",
      defaultDate: new Date("2026-07-24T00:00:00+09:00"),
      defaultMinutes: 600,
      defaultServiceIds: ["service-1"],
      defaultCustomer: { id: "customer-1", displayName: "既存 花子" },
    };
    const { rerender } = render(<ReservationCreatePanel {...props} />);
    customerState.pending = true;
    rerender(<ReservationCreatePanel {...props} />);
    await user.keyboard("{Escape}");
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.queryByRole("alertdialog")).toBeNull();

    customerState.pending = false;
    rerender(<ReservationCreatePanel {...props} />);
    createReservation.mockImplementationOnce((_payload, callbacks: { onSuccess: () => void }) => callbacks.onSuccess());
    await user.click(screen.getByRole("button", { name: "予約作成" }));
    await user.click(screen.getByRole("button", { name: "この内容で予約" }));

    expect(onClose).toHaveBeenCalledOnce();
    expect(screen.queryByRole("alertdialog", { name: "予約の入力を取り消しますか？" })).toBeNull();
  });

  it.each(["キャンセル", "Close", "Escape", "オーバーレイ"])("書きかけの予約は %s で閉じる前に確認し、編集に戻れる", async (dismissal) => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <ReservationCreatePanel
        open
        onClose={onClose}
        defaultStoreId="store-1"
        defaultResourceId="resource-1"
        defaultDate={new Date("2026-07-24T00:00:00+09:00")}
        defaultMinutes={600}
      />,
    );
    await user.click(screen.getByRole("tab", { name: "新規のお客様" }));
    await user.type(screen.getByLabelText("氏名"), "入力途中 花子");

    await dismissPanel(user, dismissal);

    expect(onClose).not.toHaveBeenCalled();
    const confirmation = screen.getByRole("alertdialog", { name: "予約の入力を取り消しますか？" });
    await user.click(within(confirmation).getByRole("button", { name: "編集に戻る" }));
    expect(screen.getByLabelText("氏名")).toHaveProperty("value", "入力途中 花子");
    expect(onClose).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "キャンセル" }));
    await user.click(screen.getByRole("button", { name: "取り消す" }));
    expect(onClose).toHaveBeenCalledOnce();
    expect(createReservation).not.toHaveBeenCalled();
  });

  it.each(["キャンセル", "Close", "Escape", "オーバーレイ"])("未入力の予約は %s で確認せず閉じる", async (dismissal) => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <ReservationCreatePanel
        open
        onClose={onClose}
        defaultStoreId="store-1"
        defaultResourceId="resource-1"
        defaultDate={new Date("2026-07-24T00:00:00+09:00")}
        defaultMinutes={600}
      />,
    );

    await dismissPanel(user, dismissal);

    expect(onClose).toHaveBeenCalledOnce();
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it.each([true, false])("顧客候補の切り詰め %s を名前の絞り込み案内に反映する", async (truncated) => {
    customerState.truncated = truncated;
    render(
      <ReservationCreatePanel
        open
        onClose={() => {}}
        defaultStoreId="store-1"
        defaultResourceId="resource-1"
        defaultDate={new Date("2026-07-24T00:00:00+09:00")}
        defaultMinutes={600}
      />,
    );
    fireEvent.change(screen.getByLabelText("既存顧客を検索"), { target: { value: "検索" } });
    await screen.findByRole("list", { name: "顧客候補" });

    expect(screen.queryByText("候補が多いため一部のみ表示しています。名前をもう少し入力してください") !== null).toBe(truncated);
  });

  it.each(["123", "1234", "1234567890"])("スタッフの顧客候補検索 %s は全桁入力を案内する", async (query) => {
    customerState.isPrivileged = false;
    customerState.empty = true;
    render(
      <ReservationCreatePanel
        open
        onClose={() => {}}
        defaultStoreId="store-1"
        defaultResourceId="resource-1"
        defaultDate={new Date("2026-07-24T00:00:00+09:00")}
        defaultMinutes={600}
      />,
    );

    const search = screen.getByLabelText("既存顧客を検索");
    fireEvent.change(search, { target: { value: query } });
    await screen.findByText("該当する顧客がいません。");

    expect(screen.getByText("電話番号は全桁で入力してください")).not.toBeNull();
    expect(search.getAttribute("placeholder")).toBe("名前・カナ・電話番号（全桁）で検索");
  });

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
