import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const createReservation = vi.fn();
const slotsState = vi.hoisted(() => {
  const defaultSlot = { resourceId: "resource-1", resourceName: "担当A", startAt: "2026-07-24T10:00:00+09:00", available: true };
  return { defaultSlot, slots: [defaultSlot] };
});
const customerState = vi.hoisted(() => ({ empty: false, isPrivileged: true, truncated: false, pending: false }));
// 設定の状態は試験ごとに差し替える。undefined は「まだ取得できていない」。
const settingsState = vi.hoisted(() => {
  const stopped = { id: "resource-stopped", storeId: "store-1", name: "停止中の担当", active: false };
  const resourceA = { id: "resource-1", storeId: "store-1", name: "担当A", active: true };
  const resourceB = { id: "resource-1b", storeId: "store-1", name: "担当B", active: true };
  const shibuyaResource = { id: "resource-2", storeId: "store-2", name: "渋谷担当", active: true };
  const services = [
    { id: "service-1", storeId: "store-1", name: "基本メニュー", durationMinutes: 60, active: true },
    { id: "service-2", storeId: "store-1", name: "追加メニュー", durationMinutes: 30, active: true },
    { id: "service-3", storeId: "store-2", name: "渋谷メニュー", durationMinutes: 45, active: true },
  ];
  const shinjuku = { id: "store-1", name: "新宿店" };
  const fixtures = {
    soleResource: { stores: [shinjuku], resources: [stopped, resourceA], services },
    twoStores: {
      stores: [shinjuku, { id: "store-2", name: "渋谷店" }],
      resources: [resourceA, shibuyaResource],
      services,
    },
    twoResources: { stores: [shinjuku], resources: [resourceA, resourceB], services },
    noResource: { stores: [shinjuku], resources: [stopped], services },
  };
  type Settings = (typeof fixtures)[keyof typeof fixtures];
  return { fixtures, current: undefined as Settings | undefined, refetchFailed: false };
});

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ isPrivileged: customerState.isPrivileged }),
}));

vi.mock("@/hooks/use-reservations", () => ({
  useCreateReservation: () => ({ mutate: createReservation, isPending: customerState.pending }),
  useAvailableSlots: () => ({
    data: { ok: true, slots: slotsState.slots },
    isFetching: false,
    isError: false,
  }),
}));

vi.mock("@/hooks/use-settings", () => ({
  useSettings: () => ({
    data: settingsState.current ? { ok: true, settings: settingsState.current } : undefined,
    isError: settingsState.refetchFailed,
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
  settingsState.current = settingsState.fixtures.soleResource;
  settingsState.refetchFailed = false;
  slotsState.slots = [slotsState.defaultSlot];
});

afterEach(() => {
  vi.useRealTimers();
});

describe("ReservationCreatePanel", () => {
  it("1文字の名前で候補を選び、入力変更やクリア中に古い候補を選択させない", () => {
    vi.useFakeTimers();
    render(
      <ReservationCreatePanel
        open
        onClose={vi.fn()}
        defaultStoreId="store-1"
        defaultResourceId="resource-1"
        defaultDate={new Date("2026-07-24T00:00:00+09:00")}
        defaultMinutes={600}
      />,
    );
    const search = screen.getByLabelText("既存顧客を検索");
    fireEvent.change(search, { target: { value: "検" } });
    expect(screen.queryByRole("list", { name: "顧客候補" })).toBeNull();
    act(() => vi.advanceTimersByTime(250));
    expect(screen.getByRole("list", { name: "顧客候補" })).toBeTruthy();

    fireEvent.change(search, { target: { value: "検索" } });
    expect(screen.queryByRole("list", { name: "顧客候補" })).toBeNull();
    fireEvent.change(search, { target: { value: "" } });
    expect(screen.queryByRole("list", { name: "顧客候補" })).toBeNull();

    fireEvent.change(search, { target: { value: "検" } });
    act(() => vi.advanceTimersByTime(250));
    fireEvent.click(screen.getByRole("button", { name: /検索 花子/ }));
    expect(screen.getByText("検索 花子 様で予約")).toBeTruthy();
  });


  it.each([
    { privileged: true, hint: "電話番号は数字3桁以上で検索してください" },
    { privileged: false, hint: "電話番号は全桁で入力してください" },
  ])("短い電話入力では旧候補/検索中/該当なしを出さず案内する（owner=$privileged）", ({ privileged, hint }) => {
    vi.useFakeTimers();
    customerState.isPrivileged = privileged;
    render(<ReservationCreatePanel open onClose={vi.fn()} defaultStoreId="store-1" defaultResourceId="resource-1" defaultDate={new Date("2026-07-24T00:00:00+09:00")} defaultMinutes={600} />);
    const search = screen.getByLabelText("既存顧客を検索");
    fireEvent.change(search, { target: { value: "検" } });
    act(() => vi.advanceTimersByTime(250));
    expect(screen.getByRole("list", { name: "顧客候補" })).toBeTruthy();
    fireEvent.change(search, { target: { value: "09" } });
    expect(screen.getByText(hint)).toBeTruthy();
    expect(screen.queryByRole("list", { name: "顧客候補" })).toBeNull();
    act(() => vi.advanceTimersByTime(1000));
    expect(screen.queryByText("検索中...")).toBeNull();
    expect(screen.queryByText("該当する顧客がいません。")).toBeNull();
  });
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
    // 店舗・リソースの欄は、選べる候補が 2 つ以上ある設定でだけ出る。
    if (field === "店舗") settingsState.current = settingsState.fixtures.twoStores;
    if (field === "リソース") settingsState.current = settingsState.fixtures.twoResources;
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
        origin: "walk_in",
        customer: {
          displayName: "新規 太郎",
          displayNameKana: "シンキ タロウ",
          phone: "090-1111-2222",
        },
      }),
      expect.objectContaining({ onSuccess: expect.any(Function) }),
    );
  });

  it("店舗が 2 つあって未選択のときは、メニュー選択前の案内を表示する", () => {
    settingsState.current = settingsState.fixtures.twoStores;
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

type PanelOverrides = Partial<React.ComponentProps<typeof ReservationCreatePanel>>;

function renderPanel(overrides: PanelOverrides = {}) {
  const onClose = vi.fn();
  const props = {
    open: true,
    onClose,
    defaultStoreId: "store-1",
    defaultResourceId: null,
    defaultDate: new Date("2026-07-24T00:00:00+09:00"),
    defaultMinutes: 600,
    defaultServiceIds: ["service-1"],
    defaultCustomer: { id: "customer-1", displayName: "既存 花子" },
    ...overrides,
  };
  const view = render(<ReservationCreatePanel {...props} />);
  return { ...view, props, onClose };
}

async function selectByKeyboard(user: ReturnType<typeof userEvent.setup>, name: string, label: string) {
  const select = screen.getByRole("combobox", { name });
  select.focus();
  await user.keyboard(label);
  expect(select.textContent).toContain(label);
}

async function submitAndConfirm(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "予約作成" }));
  await user.click(screen.getByRole("button", { name: "この内容で予約" }));
}

describe("ReservationCreatePanel のリソース・店舗・予約経路の自動決定", () => {
  it("FR-001: 枠が 1 つの店舗ではリソースの欄を出さず、その枠で送る", async () => {
    const user = userEvent.setup();
    renderPanel({ defaultResourceId: "resource-stopped", defaultMinutes: null });

    expect(screen.queryByRole("combobox", { name: "リソース" })).toBeNull();
    await submitAndConfirm(user);

    expect(createReservation).toHaveBeenCalledWith(
      expect.objectContaining({ storeId: "store-1", resourceId: "resource-1" }),
      expect.anything(),
    );
  });

  it("FR-002: 稼働中の枠が 0 の店舗では案内を出し、予約作成を押せず、作成も呼ばない", async () => {
    settingsState.current = settingsState.fixtures.noResource;
    const user = userEvent.setup();
    renderPanel();

    expect(screen.getByRole("status").textContent).toBe("この店舗は予約枠が未設定のため、予約を作成できません。");
    const submit = screen.getByRole("button", { name: "予約作成" });
    expect(submit).toHaveProperty("disabled", true);
    await user.click(submit);

    expect(screen.queryByRole("button", { name: "この内容で予約" })).toBeNull();
    expect(createReservation).not.toHaveBeenCalled();
  });

  it("FR-003: 枠が 2 つ以上の店舗では欄が出て、選ばずに送ると必須の案内になり、選ぶとその枠で送る", async () => {
    settingsState.current = settingsState.fixtures.twoResources;
    const user = userEvent.setup();
    renderPanel();

    expect(screen.getByRole("combobox", { name: "リソース" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "予約作成" }));
    expect(screen.getByRole("alert").textContent).toBe("必須項目を入力してください");
    expect(createReservation).not.toHaveBeenCalled();

    await selectByKeyboard(user, "リソース", "担当B");
    await submitAndConfirm(user);

    expect(createReservation).toHaveBeenCalledWith(
      expect.objectContaining({ storeId: "store-1", resourceId: "resource-1b" }),
      expect.anything(),
    );
  });

  it("FR-004: 2 店舗で店舗を切り替えると、送る店舗と枠が新しい店舗のものになり、手で入れた時刻は残る", async () => {
    settingsState.current = settingsState.fixtures.twoStores;
    const user = userEvent.setup();
    renderPanel({ defaultResourceId: "resource-1", defaultMinutes: null });

    fireEvent.change(screen.getByLabelText("時間"), { target: { value: "13:15" } });
    await selectByKeyboard(user, "店舗", "渋谷店");
    await user.click(screen.getByRole("checkbox", { name: /渋谷メニュー/ }));
    await user.click(screen.getByRole("tab", { name: "新規のお客様" }));
    await user.type(screen.getByLabelText("氏名"), "新規 太郎");
    await user.type(screen.getByLabelText("カナ"), "シンキ タロウ");
    await user.type(screen.getByLabelText("電話番号"), "090-1111-2222");
    await submitAndConfirm(user);

    expect(createReservation).toHaveBeenCalledWith(
      expect.objectContaining({ storeId: "store-2", resourceId: "resource-2", startAt: "2026-07-24T13:15:00+09:00" }),
      expect.anything(),
    );
  });

  it("FR-004: 予定表の空きから開いて店舗を切り替えても、今どおり時刻は残り、新しい店舗の枠で送る", async () => {
    settingsState.current = settingsState.fixtures.twoStores;
    const user = userEvent.setup();
    renderPanel({ defaultResourceId: "resource-1", defaultMinutes: 660 });

    await selectByKeyboard(user, "店舗", "渋谷店");
    expect((screen.getByLabelText("時間") as HTMLInputElement).value).toBe("11:00");
    await user.click(screen.getByRole("checkbox", { name: /渋谷メニュー/ }));
    await user.click(screen.getByRole("tab", { name: "新規のお客様" }));
    await user.type(screen.getByLabelText("氏名"), "新規 太郎");
    await user.type(screen.getByLabelText("カナ"), "シンキ タロウ");
    await user.type(screen.getByLabelText("電話番号"), "090-1111-2222");
    await submitAndConfirm(user);
    expect(createReservation).toHaveBeenCalledWith(
      expect.objectContaining({ storeId: "store-2", resourceId: "resource-2", startAt: "2026-07-24T11:00:00+09:00" }),
      expect.anything(),
    );
  });

  it("FR-004: 設定が未取得の間は予約作成を押せず、取得のあとで押せる", () => {
    settingsState.current = undefined;
    const { rerender, props } = renderPanel();
    expect(screen.getByRole("button", { name: "予約作成" })).toHaveProperty("disabled", true);

    settingsState.current = settingsState.fixtures.soleResource;
    rerender(<ReservationCreatePanel {...props} />);
    expect(screen.getByRole("button", { name: "予約作成" })).toHaveProperty("disabled", false);
  });

  it("FR-004: 前の予約から作るときに初期値の枠が停止中でも、枠が 1 つの店舗ではその店舗の稼働中の枠で送る", async () => {
    const user = userEvent.setup();
    renderPanel({ defaultStoreId: "store-1", defaultResourceId: "resource-stopped", defaultMinutes: null });

    await submitAndConfirm(user);

    expect(createReservation).toHaveBeenCalledWith(
      expect.objectContaining({ resourceId: "resource-1" }),
      expect.anything(),
    );
  });

  it("FR-005: 店舗が 1 つなら店舗の欄を出さず、メニューをすぐ選べ、確認の画面に店舗名が出る", async () => {
    const user = userEvent.setup();
    renderPanel({ defaultStoreId: null, defaultServiceIds: null });

    expect(screen.queryByRole("combobox", { name: "店舗" })).toBeNull();
    expect(screen.queryByText("店舗を選択してください")).toBeNull();
    await user.click(screen.getByRole("checkbox", { name: /基本メニュー/ }));
    await user.click(screen.getByRole("button", { name: "予約作成" }));

    const dialog = screen.getByRole("alertdialog");
    expect(within(dialog).getByText("店舗：")).toBeTruthy();
    expect(within(dialog).getByText("新宿店")).toBeTruthy();
  });

  it("FR-005: 店舗が 2 つなら店舗の欄を出す", () => {
    settingsState.current = settingsState.fixtures.twoStores;
    renderPanel();

    expect(screen.getByRole("combobox", { name: "店舗" })).toBeTruthy();
  });

  it("FR-006: 開いた直後の予約経路は「店頭」で、そのまま送ると walk_in になる", async () => {
    const user = userEvent.setup();
    renderPanel();

    expect(screen.getByRole("combobox", { name: "予約経路" }).textContent).toContain("店頭");
    await submitAndConfirm(user);

    expect(createReservation).toHaveBeenCalledWith(
      expect.objectContaining({ origin: "walk_in" }),
      expect.anything(),
    );
  });

  it("FR-006: 店舗が 1 つで初期値が空でも、何も入れずに閉じれば破棄の確認は出ない", async () => {
    const user = userEvent.setup();
    const { onClose } = renderPanel({ defaultStoreId: null, defaultServiceIds: null, defaultCustomer: null });

    await user.click(screen.getByRole("button", { name: "キャンセル" }));

    expect(onClose).toHaveBeenCalledOnce();
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("FR-007: 枠が 1 つなら、確認の画面に担当が無く、空き枠の一覧にリソース名の見出しが無い", async () => {
    const user = userEvent.setup();
    renderPanel();

    expect(screen.getByRole("button", { name: "10:00" })).toBeTruthy();
    expect(screen.queryByText("担当A")).toBeNull();
    await user.click(screen.getByRole("button", { name: "予約作成" }));

    expect(within(screen.getByRole("alertdialog")).queryByText("担当：")).toBeNull();
  });

  it("FR-007: 枠が 2 つ以上なら、確認の画面に担当があり、空き枠の一覧にリソース名の見出しがある", async () => {
    settingsState.current = settingsState.fixtures.twoResources;
    const user = userEvent.setup();
    renderPanel({ defaultResourceId: "resource-1" });

    expect(screen.getByRole("button", { name: "10:00" })).toBeTruthy();
    expect(screen.getAllByText("担当A").some((element) => element.tagName === "P")).toBe(true);
    await user.click(screen.getByRole("button", { name: "予約作成" }));

    const dialog = screen.getByRole("alertdialog");
    expect(within(dialog).getByText("担当：")).toBeTruthy();
    expect(within(dialog).getByText("担当A")).toBeTruthy();
  });

  it("確認を開いたあとに枠が増えても、確認の画面は送る枠の担当を出し、その枠で送る", async () => {
    const user = userEvent.setup();
    const { rerender, props } = renderPanel();
    await user.click(screen.getByRole("button", { name: "予約作成" }));

    settingsState.current = settingsState.fixtures.twoResources;
    rerender(<ReservationCreatePanel {...props} />);
    const dialog = screen.getByRole("alertdialog");
    expect(within(dialog).getByText("担当：")).toBeTruthy();
    expect(within(dialog).getByText("担当A")).toBeTruthy();
    await user.click(within(dialog).getByRole("button", { name: "この内容で予約" }));

    expect(createReservation).toHaveBeenCalledWith(
      expect.objectContaining({ resourceId: "resource-1" }),
      expect.anything(),
    );
  });

  it.each([
    { label: "枠が 1 つ", fixture: "soleResource" as const, pick: "10:30", resourceId: "resource-1" },
    { label: "枠が 2 つ以上", fixture: "twoResources" as const, pick: "10:45", resourceId: "resource-1b" },
  ])("$label の設定にない枠の空きは一覧に出さず、選んだ空き枠の時刻と枠で送る", async ({ fixture, pick, resourceId }) => {
    settingsState.current = settingsState.fixtures[fixture];
    slotsState.slots = [
      ...slotsState.slots,
      { resourceId: "resource-1", resourceName: "担当A", startAt: "2026-07-24T10:30:00+09:00", available: true },
      { resourceId: "resource-1b", resourceName: "担当B", startAt: "2026-07-24T10:45:00+09:00", available: true },
      { resourceId: "resource-unknown", resourceName: "設定にない担当", startAt: "2026-07-24T11:00:00+09:00", available: true },
    ];
    const user = userEvent.setup();
    renderPanel({ defaultResourceId: "resource-1" });

    expect(screen.queryByRole("button", { name: "11:00" })).toBeNull();
    await user.click(screen.getByRole("button", { name: pick }));
    await submitAndConfirm(user);

    expect(createReservation).toHaveBeenCalledWith(
      expect.objectContaining({ resourceId, startAt: `2026-07-24T${pick}:00+09:00` }),
      expect.anything(),
    );
  });

  it("空いている時刻が 1 つも無ければ「空き枠なし」を出す", () => {
    slotsState.slots = [
      { resourceId: "resource-1", resourceName: "担当A", startAt: "2026-07-24T10:00:00+09:00", available: false },
    ];
    renderPanel();

    expect(screen.queryByRole("button", { name: "10:00" })).toBeNull();
    expect(screen.getByText("空き枠なし")).toBeTruthy();
  });

  it("設定のデータがまだ無い間は、空き枠の欄を出さない", () => {
    settingsState.current = undefined;
    renderPanel();

    expect(screen.queryByText("空き枠")).toBeNull();
    expect(screen.queryByRole("button", { name: "10:00" })).toBeNull();
    expect(screen.queryByText("空き枠なし")).toBeNull();
  });

  it("確認を開いたあとに送る枠が止まっても、確認の画面は送る枠の担当を出し、その枠で送る（止まった枠はサーバーが断る）", async () => {
    settingsState.current = settingsState.fixtures.twoResources;
    const [resourceA, resourceB] = settingsState.fixtures.twoResources.resources;
    const user = userEvent.setup();
    const { rerender, props } = renderPanel({ defaultResourceId: "resource-1b" });
    await user.click(screen.getByRole("button", { name: "予約作成" }));

    settingsState.current = { ...settingsState.fixtures.twoResources, resources: [resourceA, { ...resourceB, active: false }] };
    rerender(<ReservationCreatePanel {...props} />);
    const dialog = screen.getByRole("alertdialog");
    expect(within(dialog).getByText("担当：")).toBeTruthy();
    expect(within(dialog).getByText("担当B")).toBeTruthy();
    await user.click(within(dialog).getByRole("button", { name: "この内容で予約" }));

    expect(createReservation).toHaveBeenCalledWith(
      expect.objectContaining({ resourceId: "resource-1b" }),
      expect.anything(),
    );
  });

  it.each([
    { label: "リソースの欄で選んだ枠", open: { defaultResourceId: null, defaultMinutes: 600 }, how: "dropdown" },
    { label: "空き枠で選んだ枠", open: { defaultResourceId: null, defaultMinutes: 600 }, how: "slot" },
    { label: "予定表の空きから開いた枠", open: { defaultResourceId: "resource-1b", defaultMinutes: 660 }, how: "schedule" },
  ] as const)("$label が止まって 1 つだけ残っても、黙って置き換えず、欄で選び直すまで送らない", async ({ open, how }) => {
    settingsState.current = settingsState.fixtures.twoResources;
    const [resourceA, resourceB] = settingsState.fixtures.twoResources.resources;
    slotsState.slots = [
      ...slotsState.slots,
      { resourceId: "resource-1b", resourceName: "担当B", startAt: "2026-07-24T11:00:00+09:00", available: true },
    ];
    const user = userEvent.setup();
    const { rerender, props } = renderPanel(open);
    if (how === "dropdown") await selectByKeyboard(user, "リソース", "担当B");
    if (how === "slot") await user.click(screen.getByRole("button", { name: "11:00" }));

    settingsState.current = { ...settingsState.fixtures.twoResources, resources: [resourceA, { ...resourceB, active: false }] };
    rerender(<ReservationCreatePanel {...props} />);
    expect(screen.getByRole("combobox", { name: "リソース" })).toBeTruthy();
    // 選び直しの間も稼働中の枠は 1 つなので、空き枠に枠の名前の見出しを出さない（FR-007）。
    expect(screen.queryAllByText("担当A").filter((element) => element.tagName === "P")).toEqual([]);
    await user.click(screen.getByRole("button", { name: "予約作成" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(screen.getByRole("alert").textContent).toBe("必須項目を入力してください");

    // Radix の選択肢の文字検索は 1 秒の間に打った文字をつなげて探すので、前の入力が消えるのを待つ。
    if (how === "dropdown") await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1100)); });
    // 残った唯一の枠を選ぶと、枠が 1 つの店舗と同じ扱いに戻って欄は消える。
    screen.getByRole("combobox", { name: "リソース" }).focus();
    await user.keyboard("担当A");
    expect(screen.queryByRole("combobox", { name: "リソース" })).toBeNull();
    await submitAndConfirm(user);
    expect(createReservation).toHaveBeenCalledWith(
      expect.objectContaining({ resourceId: "resource-1" }),
      expect.anything(),
    );
  });

  it("空き枠の選択中の表示は、送る枠とその時刻で出す", async () => {
    settingsState.current = settingsState.fixtures.twoResources;
    slotsState.slots = [
      ...slotsState.slots,
      { resourceId: "resource-1", resourceName: "担当A", startAt: "2026-07-24T11:00:00+09:00", available: true },
      { resourceId: "resource-1b", resourceName: "担当B", startAt: "2026-07-24T11:00:00+09:00", available: true },
    ];
    const user = userEvent.setup();
    renderPanel();
    const group = (name: string) => screen.getAllByText(name).find((element) => element.tagName === "P")?.parentElement as HTMLElement;
    const pressed = (name: string) => within(group(name)).getByRole("button", { name: "11:00" }).getAttribute("aria-pressed");
    await user.click(within(group("担当B")).getByRole("button", { name: "11:00" }));
    expect([pressed("担当A"), pressed("担当B")]).toEqual(["false", "true"]);

    await selectByKeyboard(user, "リソース", "担当A");
    expect([pressed("担当A"), pressed("担当B")]).toEqual(["true", "false"]);
  });

  it("空き枠で選んだ時刻はメニューを変えると消え、保存のときに必須の案内になる", async () => {
    settingsState.current = settingsState.fixtures.twoResources;
    slotsState.slots = [
      ...slotsState.slots,
      { resourceId: "resource-1b", resourceName: "担当B", startAt: "2026-07-24T11:00:00+09:00", available: true },
    ];
    const user = userEvent.setup();
    renderPanel();
    await user.click(screen.getByRole("button", { name: "11:00" }));
    await user.click(screen.getByRole("checkbox", { name: /追加メニュー/ }));
    expect((screen.getByLabelText("時間") as HTMLInputElement).value).toBe("");
    await user.click(screen.getByRole("button", { name: "予約作成" }));
    expect(screen.getByRole("alert").textContent).toBe("必須項目を入力してください");
  });

  it("設定の取り直しに失敗しても、前の設定の枠で送れる", async () => {
    settingsState.refetchFailed = true;
    const user = userEvent.setup();
    renderPanel();
    await submitAndConfirm(user);
    expect(createReservation).toHaveBeenCalledWith(
      expect.objectContaining({ storeId: "store-1", resourceId: "resource-1" }),
      expect.anything(),
    );
  });

  it("枠が 0 の案内は、設定の取得後に表示が変わる同じ通知欄で出す", () => {
    settingsState.current = undefined;
    const { rerender, props } = renderPanel();
    const region = screen.getByRole("status");
    expect(region.textContent).toBe("");

    settingsState.current = settingsState.fixtures.noResource;
    rerender(<ReservationCreatePanel {...props} />);
    expect(screen.getByRole("status")).toBe(region);
    expect(region.textContent).toBe("この店舗は予約枠が未設定のため、予約を作成できません。");
  });
});
