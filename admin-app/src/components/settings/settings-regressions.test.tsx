import type { ReactElement } from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthContext } from "@/providers/auth-context";
import { StoreProvider } from "@/providers/store-provider";
import type { SettingsResponse } from "@/types/api";
import MenuPage from "@/pages/menu";
import SettingsPage from "@/pages/settings";
import { ClosuresTab } from "./closures-tab";
import { ResourcesTab } from "./resources-tab";
import { ReminderTab } from "./reminder-tab";
import { BusinessHoursTab } from "./business-hours-tab";
import { RecurringBlocksTab } from "./recurring-blocks-tab";
import { useStores } from "@/hooks/use-stores";

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() }));
vi.mock("@/lib/api-client", () => ({ api }));

const store = {
  id: "store-1", name: "サンプル中央店", timezone: "Asia/Tokyo",
  googleCalendarId: null, googleControlledEditMode: false,
  maxActiveReservationsPerCustomer: 3, bookingWindowDays: 30, customerNotice: null,
};
const secondStore = { ...store, id: "store-2", name: "サンプル北店" };
const settings: SettingsResponse = {
  ok: true,
  settings: {
    stores: [store], services: [], staff: [], resources: [], businessHours: [], closures: [],
    reminderOffsets: [{ storeId: store.id, offsetMinutes: 60 }],
  },
};
let settingsFail = false;

function renderUi(element: ReactElement, storeId: string | null = store.id) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const result = render(
    <QueryClientProvider client={client}>
      <AuthContext.Provider value={{
        user: { email: "owner@example.com", role: "owner", storeId, staffMemberId: null },
        isPrivileged: true, vapidPublicKey: "",
      }}>
        <StoreProvider><MemoryRouter>{element}</MemoryRouter></StoreProvider>
      </AuthContext.Provider>
    </QueryClientProvider>,
  );
  return { ...result, client };
}

beforeEach(() => {
  settingsFail = false;
  settings.settings.stores = [store];
  vi.clearAllMocks();
  api.put.mockResolvedValue({ ok: true });
  api.get.mockImplementation(async (path: string) => {
    if (path === "/api/admin/settings") {
      if (settingsFail) throw new Error("settings unavailable");
      return settings;
    }
    if (path.startsWith("/api/admin/settings/business-hours/")) {
      return { ok: true, businessHours: [{ weekday: 1, opensAt: "10:00", closesAt: "18:00", closed: false }] };
    }
    if (path === "/api/admin/line-quota") return { ok: true, quota: null };
    throw new Error(`Unexpected GET: ${path}`);
  });
});

describe("F13 設定フォームのラベル", () => {
  it("休業日の開始日・終了日・理由をラベル名で入力できる", async () => {
    const user = userEvent.setup();
    renderUi(<ClosuresTab selectedStoreId={store.id} />);
    await user.click(await screen.findByRole("button", { name: "+ 追加" }));
    expect(screen.getByLabelText("開始日").getAttribute("type")).toBe("date");
    expect(screen.getByLabelText("終了日").getAttribute("type")).toBe("date");
    const reason = screen.getByRole("textbox", { name: "理由" });
    await user.click(screen.getByText("理由", { selector: "label" }));
    expect(document.activeElement).toBe(reason);
  });

  it("リソースの名前をラベル名で入力できる", async () => {
    const user = userEvent.setup();
    renderUi(<ResourcesTab selectedStoreId={store.id} />);
    await user.click(await screen.findByRole("button", { name: "+ 追加" }));
    expect(screen.getByRole("textbox", { name: "名前" })).toBeTruthy();
  });

  it("繰り返しブロックの各入力と曜日の複数選択に名前が付く", async () => {
    const user = userEvent.setup();
    renderUi(<RecurringBlocksTab selectedStoreId={store.id} />);
    expect(screen.getByRole("combobox", { name: "開始時刻" })).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "終了時刻" })).toBeTruthy();
    expect(screen.getByLabelText("開始日")).toBeTruthy();
    expect(screen.getByLabelText("終了日")).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "リソース" })).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "タイトル（任意）" })).toBeTruthy();
    expect(screen.getByRole("group", { name: "曜日" })).toBeTruthy();
    const monday = screen.getByRole("button", { name: "月曜" });
    monday.focus();
    await user.keyboard(" ");
    expect(monday.getAttribute("aria-pressed")).toBe("true");
    await user.keyboard("{Enter}");
    expect(monday.getAttribute("aria-pressed")).toBe("false");
  });

  it("リマインダーの選択は店舗名で区別できる", async () => {
    renderUi(<ReminderTab stores={[store, secondStore]} />);
    expect((await screen.findByRole("combobox", { name: "サンプル中央店 のリマインダー" })).textContent).toContain("1時間前");
    expect(screen.getByRole("combobox", { name: "サンプル北店 のリマインダー" })).toBeTruthy();
  });
});

describe("F14 予約ルールと通知の見つけやすさ", () => {
  it("予約ルール・通知タブで店舗別の設定を一覧する範囲が分かる", async () => {
    settings.settings.stores = [store, secondStore];
    const user = userEvent.setup();
    renderUi(<SettingsPage />);
    await user.click(screen.getByRole("tab", { name: "予約ルール・通知" }));
    expect(screen.getByText("各店舗の予約ルールと通知設定を一覧で表示しています。上部の店舗選択による絞り込みは適用されません。")).toBeTruthy();
    expect(await screen.findByRole("spinbutton", { name: "サンプル中央店 の予約受付期間（日先まで）" })).toBeTruthy();
    expect(screen.getByRole("spinbutton", { name: "サンプル北店 の予約受付期間（日先まで）" })).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "サンプル中央店 の予約ページのお知らせ" })).toBeTruthy();
    expect(screen.getByRole("spinbutton", { name: "サンプル北店 の1人あたり予約上限（件）" })).toBeTruthy();
  });
});

function HeaderStoreSwitch() {
  const { selectStore } = useStores();
  return <button type="button" onClick={() => selectStore(secondStore.id)}>ヘッダーで店舗を切り替える</button>;
}

describe("F29 営業時間の下書き保護", () => {
  it("休業日タブへ移動して戻っても下書きが残り、元の店舗に保存できる", async () => {
    const user = userEvent.setup();
    renderUi(<SettingsPage />);
    await user.click(await screen.findByRole("button", { name: "編集" }));
    await user.click(screen.getByRole("button", { name: "月曜 営業" }));
    await user.click(screen.getByRole("tab", { name: "休業日" }));
    expect(screen.queryByRole("button", { name: "月曜 休業" })).toBeNull();
    await user.click(screen.getByRole("tab", { name: "営業時間" }));
    expect(screen.getByRole("button", { name: "月曜 休業" }).getAttribute("aria-pressed")).toBe("true");
    await user.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(api.put).toHaveBeenCalledWith(
      "/api/admin/settings/business-hours/store-1",
      { hours: [{ weekday: 1, opensAt: "10:00", closesAt: "18:00", closed: true }] },
    ));
  });

  it("ヘッダーで店舗を切り替えても破棄確認のキャンセルで下書きを維持する", async () => {
    settings.settings.stores = [store, secondStore];
    const user = userEvent.setup();
    renderUi(<><HeaderStoreSwitch /><SettingsPage /></>);
    await user.click(await screen.findByRole("button", { name: "編集" }));
    await user.click(screen.getByRole("button", { name: "月曜 営業" }));
    await user.click(screen.getByRole("button", { name: "ヘッダーで店舗を切り替える" }));
    expect(screen.getByRole("alertdialog").textContent).toContain("営業時間の変更を破棄しますか？");
    await user.click(screen.getByRole("button", { name: "キャンセル" }));
    expect(screen.getByRole("button", { name: "月曜 休業" }).getAttribute("aria-pressed")).toBe("true");
    expect(api.put).not.toHaveBeenCalled();
  });

  it("ページで店舗を切り替える際は確認後に下書きを破棄し、新しい店舗には持ち込まない", async () => {
    settings.settings.stores = [store, secondStore];
    const user = userEvent.setup();
    renderUi(<SettingsPage />);
    await user.click(await screen.findByRole("button", { name: "編集" }));
    await user.click(screen.getByRole("button", { name: "月曜 営業" }));
    screen.getByRole("combobox").focus();
    await user.keyboard("サンプル北店");
    expect(screen.getByRole("alertdialog")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "破棄して切り替える" }));
    expect(await screen.findByRole("button", { name: "編集" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "編集" }));
    expect(screen.getByRole("button", { name: "月曜 営業" }).getAttribute("aria-pressed")).toBe("false");
    await user.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(api.put).toHaveBeenCalledWith(
      "/api/admin/settings/business-hours/store-2",
      { hours: [{ weekday: 1, opensAt: "10:00", closesAt: "18:00", closed: false }] },
    ));
  });

  it("保存中は店舗切り替えの破棄確認を操作できず、元の店舗への保存を待つ", async () => {
    settings.settings.stores = [store, secondStore];
    let finishSave: () => void = () => { throw new Error("Save has not started"); };
    api.put.mockImplementationOnce(() => new Promise((resolve) => {
      finishSave = () => resolve({ ok: true });
    }));
    const user = userEvent.setup();
    renderUi(<><HeaderStoreSwitch /><SettingsPage /></>);
    await user.click(await screen.findByRole("button", { name: "編集" }));
    await user.click(screen.getByRole("button", { name: "月曜 営業" }));
    await user.click(screen.getByRole("button", { name: "保存" }));
    await user.click(screen.getByRole("button", { name: "ヘッダーで店舗を切り替える" }));
    expect(screen.getByRole("button", { name: "処理中..." }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "キャンセル" }).hasAttribute("disabled")).toBe(true);
    await act(async () => finishSave());
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(api.put).toHaveBeenCalledWith(
      "/api/admin/settings/business-hours/store-1",
      { hours: [{ weekday: 1, opensAt: "10:00", closesAt: "18:00", closed: true }] },
    );
  });

  it("設定の再取得が失敗しても再読み込み後に編集中の営業時間が残る", async () => {
    const user = userEvent.setup();
    const { client } = renderUi(<SettingsPage />);
    await user.click(await screen.findByRole("button", { name: "編集" }));
    await user.click(screen.getByRole("button", { name: "月曜 営業" }));
    settingsFail = true;
    await act(() => client.refetchQueries({ queryKey: ["settings"] }));
    expect(await screen.findByRole("alert")).toBeTruthy();
    settingsFail = false;
    await user.click(screen.getByRole("button", { name: "再読み込み" }));
    expect((await screen.findByRole("button", { name: "月曜 休業" })).getAttribute("aria-pressed")).toBe("true");
  });
});

describe("F6 設定の取得失敗", () => {
  it.each([
    ["メニュー", <MenuPage />, "メニューがありません"],
    ["店舗設定", <SettingsPage />, "店舗を選択してください"],
    ["休業日", <ClosuresTab selectedStoreId={store.id} />, "休業日がありません"],
    ["リソース", <ResourcesTab selectedStoreId={store.id} />, "リソースがありません"],
    ["通知", <ReminderTab stores={[]} />, "予約前にLINEでリマインダーを送信するタイミングを設定します。"],
  ] as const)("%s は失敗を空の設定として表示せず再読み込みできる", async (_name, element, misleadingCopy) => {
    settingsFail = true;
    const user = userEvent.setup();
    const { client } = renderUi(element, null);
    await waitFor(() => expect(client.getQueryState(["settings"])?.status).toBe("error"));

    expect(screen.getByRole("alert").textContent).toContain("設定を読み込めませんでした");
    if (_name === "店舗設定") {
      expect(screen.queryByRole("tabpanel")).toBeNull();
    } else {
      expect(screen.queryByText(misleadingCopy)).toBeNull();
    }
    settingsFail = false;
    await user.click(screen.getByRole("button", { name: "再読み込み" }));
    await waitFor(() => expect(client.getQueryState(["settings"])?.status).toBe("success"));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });

  it("店舗設定の再取得が失敗しても休業日の下書きを再読み込み後に復元する", async () => {
    const user = userEvent.setup();
    const { client } = renderUi(<SettingsPage />);
    await user.click(screen.getByRole("tab", { name: "休業日" }));
    await user.click(await screen.findByRole("button", { name: "+ 追加" }));
    await user.type(screen.getByRole("textbox", { name: "理由" }), "サンプルの休業予定");
    settingsFail = true;
    await act(() => client.refetchQueries({ queryKey: ["settings"] }));
    expect(await screen.findByRole("alert")).toBeTruthy();
    settingsFail = false;
    await user.click(screen.getByRole("button", { name: "再読み込み" }));
    expect((await screen.findByRole("textbox", { name: "理由" }) as HTMLInputElement).value).toBe("サンプルの休業予定");
  });

  it("通知設定の再取得が失敗してもお知らせと受付期間の下書きが残る", async () => {
    const user = userEvent.setup();
    const { client } = renderUi(<ReminderTab stores={[store]} />);
    await user.type(await screen.findByRole("textbox", { name: "サンプル中央店 の予約ページのお知らせ" }), "サンプルのお知らせ");
    const windowInput = screen.getByRole("spinbutton", { name: "サンプル中央店 の予約受付期間（日先まで）" });
    await user.clear(windowInput);
    await user.type(windowInput, "45");
    settingsFail = true;
    await act(() => client.refetchQueries({ queryKey: ["settings"] }));
    expect(await screen.findByRole("alert")).toBeTruthy();
    settingsFail = false;
    await user.click(screen.getByRole("button", { name: "再読み込み" }));
    expect((await screen.findByRole("textbox", { name: "サンプル中央店 の予約ページのお知らせ" }) as HTMLTextAreaElement).value).toBe("サンプルのお知らせ");
    expect((screen.getByRole("spinbutton", { name: "サンプル中央店 の予約受付期間（日先まで）" }) as HTMLInputElement).value).toBe("45");
  });
});

describe("F12 営業時間のキーボード操作", () => {
  it("曜日を含む名前のボタンで営業と休業を切り替えられる", async () => {
    const user = userEvent.setup();
    renderUi(<BusinessHoursTab stores={[store]} selectedStoreId={store.id} />);
    await user.click(await screen.findByRole("button", { name: "編集" }));
    const toggle = screen.getByRole("button", { name: "月曜 営業" });
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    toggle.focus();
    await user.keyboard(" ");
    expect(screen.getByRole("button", { name: "月曜 休業" }).getAttribute("aria-pressed")).toBe("true");
    await user.keyboard("{Enter}");
    expect(screen.getByRole("button", { name: "月曜 営業" }).getAttribute("aria-pressed")).toBe("false");
  });

  it("時刻の選択には曜日と開始・終了の名前が付く", async () => {
    const user = userEvent.setup();
    renderUi(<BusinessHoursTab stores={[store]} selectedStoreId={store.id} />);
    await user.click(await screen.findByRole("button", { name: "編集" }));
    expect(screen.getByRole("combobox", { name: "月曜 開始" }).textContent).toContain("10:00");
    expect(screen.getByRole("combobox", { name: "月曜 終了" }).textContent).toContain("18:00");
  });
});
