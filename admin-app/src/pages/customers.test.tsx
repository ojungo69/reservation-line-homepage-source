import type { KeyboardEvent } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CustomerListItem, CustomerSearchItem } from "@/types/api";
import {
  CustomerListTable,
  default as CustomersPage,
  SearchResultTable,
  customerRowProps,
} from "./customers";

const customerState = vi.hoisted(() => ({
  params: new URLSearchParams(),
  setParams: vi.fn(),
}));

vi.mock("react-router", () => ({
  useSearchParams: () => [customerState.params, customerState.setParams],
}));

const authState = vi.hoisted(() => ({ isPrivileged: true, storeId: null as string | null }));
const searchState = vi.hoisted(() => ({ empty: false, error: false, noData: false, truncated: false, refetch: vi.fn() }));
const listState = vi.hoisted(() => ({ error: false, noData: false, refetch: vi.fn() }));
// 既定は空 (=セクションは描画されない)。role で出し分けていることを確かめるテストだけが
// 非空にする。空のままだと `groups.length === 0 → null` で owner でも消えるので、
// 「staff には出ない」という assert が role と無関係に通ってしまう。
const mergeState = vi.hoisted(() => ({ groups: [] as Array<{ groupId: string; customers: unknown[] }> }));
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ isPrivileged: authState.isPrivileged, user: { storeId: authState.storeId } }),
}));

vi.mock("@/hooks/use-stores", () => ({
  useStores: () => ({
    stores: [],
    selectedStoreId: null,
    selectStore: vi.fn(),
    isStoreFixed: false,
  }),
}));

vi.mock("@/hooks/use-customers", () => ({
  useCustomerList: (offset: number, archivedOnly: boolean, _storeId: string | null) => {
    return {
    data: listState.noData ? undefined : {
      customers: archivedOnly
        ? [{
            id: "archived-customer",
            displayName: "保管 花子",
            displayNameKana: "ホカン ハナコ",
            phoneNormalizedMasked: "090-****-9999",
            blockStatus: "active",
            visitCount: 1,
            lastVisitAt: null,
            memo: null,
          }]
        : offset === 0
          ? [{
              id: "customer-1",
              displayName: "山田 花子",
              displayNameKana: "ヤマダ ハナコ",
              phoneNormalizedMasked: "090-****-1234",
              blockStatus: "active",
              visitCount: 2,
              lastVisitAt: null,
              memo: null,
            }]
          : [{
              id: "customer-2",
              displayName: "佐藤 太郎",
              displayNameKana: "サトウ タロウ",
              phoneNormalizedMasked: "090-****-5678",
              blockStatus: "active",
              visitCount: 3,
              lastVisitAt: null,
              memo: null,
            }],
      total: 201,
    },
    isPending: false,
    isError: listState.error,
    refetch: listState.refetch,
    };
  },
  useCustomerSearch: (query: string) => ({
    data: searchState.noData ? undefined : {
      ok: true,
      truncated: searchState.truncated,
      customers: query.length >= 2 && !searchState.empty
        ? [{
            id: "search-customer",
            displayName: "検索 花子",
            displayNameKana: "ケンサク ハナコ",
            phoneNormalized: "09012345678",
            blockStatus: "active",
            memo: null,
          }]
        : [],
    },
    isPending: false,
    isError: searchState.error,
    refetch: searchState.refetch,
  }),
  useMergeCandidates: () => ({ data: { groups: mergeState.groups }, isPending: false, isError: false }),
  useCustomerMerge: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock("@/components/customers/customer-detail-panel", () => ({
  CustomerDetailPanel: ({ customerId }: { customerId: string | null }) =>
    customerId ? <p>顧客詳細: {customerId}</p> : null,
}));

vi.mock("@/components/customers/add-customer-dialog", () => ({
  AddCustomerDialog: () => null,
}));

afterEach(() => {
  customerState.params = new URLSearchParams();
  customerState.setParams.mockClear();
  authState.isPrivileged = true;
  authState.storeId = null;
  searchState.empty = false;
  searchState.error = false;
  searchState.noData = false;
  searchState.truncated = false;
  searchState.refetch.mockClear();
  listState.error = false;
  listState.noData = false;
  listState.refetch.mockClear();
  mergeState.groups = [];
  vi.useRealTimers();
});

describe("customerRowProps", () => {
  it("クリックで顧客を選択する", () => {
    const onSelect = vi.fn();
    const props = customerRowProps(
      { id: "customer-1", displayName: "山田 花子" },
      onSelect,
    );

    props.onClick();

    expect(props.tabIndex).toBe(0);
    expect(props["aria-label"]).toBe("山田 花子の顧客詳細を開く");
    expect(onSelect).toHaveBeenCalledWith("customer-1");
  });

  it.each(["Enter", " "])("%s キーで顧客を選択する", (key) => {
    const onSelect = vi.fn();
    const preventDefault = vi.fn();
    const props = customerRowProps(
      { id: "customer-1", displayName: "山田 花子" },
      onSelect,
    );

    props.onKeyDown({
      key,
      preventDefault,
    } as unknown as KeyboardEvent<HTMLTableRowElement>);

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(onSelect).toHaveBeenCalledWith("customer-1");
  });

  it("その他のキーでは選択しない", () => {
    const onSelect = vi.fn();
    const preventDefault = vi.fn();
    const props = customerRowProps(
      { id: "customer-1", displayName: "山田 花子" },
      onSelect,
    );

    props.onKeyDown({
      key: "Escape",
      preventDefault,
    } as unknown as KeyboardEvent<HTMLTableRowElement>);

    expect(preventDefault).not.toHaveBeenCalled();
    expect(onSelect).not.toHaveBeenCalled();
  });
});

describe("customer tables", () => {
  it("顧客一覧の行から選択を通知する", () => {
    const onSelect = vi.fn();
    const customer = {
      id: "customer-1",
      displayName: "山田 花子",
      displayNameKana: "ヤマダ ハナコ",
      phoneNormalizedMasked: "090-****-1234",
      blockStatus: "active",
      visitCount: 2,
      lastVisitAt: null,
      memo: null,
    } as CustomerListItem;

    render(
      <CustomerListTable
        rows={[customer]}
        onSelect={onSelect}
        showArchived={false}
        isStoreFiltered={false}
      />,
    );
    fireEvent.click(
      screen.getByRole("row", { name: "山田 花子の顧客詳細を開く" }),
    );

    expect(onSelect).toHaveBeenCalledWith("customer-1");
  });

  it("検索結果の行から選択を通知する", () => {
    const onSelect = vi.fn();
    const customer = {
      id: "customer-2",
      displayName: "佐藤 太郎",
      displayNameKana: "サトウ タロウ",
      blockStatus: "active",
      memo: null,
    } as CustomerSearchItem;

    render(<SearchResultTable rows={[customer]} onSelect={onSelect} />);
    fireEvent.click(
      screen.getByRole("row", { name: "佐藤 太郎の顧客詳細を開く" }),
    );

    expect(onSelect).toHaveBeenCalledWith("customer-2");
  });
});

describe("CustomersPage", () => {
  it.each([true, false])("検索結果の切り詰め %s を名前の絞り込み案内に反映する", (truncated) => {
    vi.useFakeTimers();
    searchState.truncated = truncated;
    render(<CustomersPage />);
    fireEvent.change(screen.getByRole("textbox", { name: "顧客を検索" }), { target: { value: "検索" } });
    act(() => vi.advanceTimersByTime(300));

    expect(screen.getByText("検索 花子")).toBeTruthy();
    expect(screen.queryByText("候補が多いため一部のみ表示しています。名前をもう少し入力してください") !== null).toBe(truncated);
  });

  it.each([
    { mode: "一覧", noData: true },
    { mode: "一覧", noData: false },
    { mode: "検索", noData: true },
    { mode: "検索", noData: false },
  ])("$mode の取得失敗時はデータ有無 $noData によらず結果を隠し、その取得を再試行する", ({ mode, noData }) => {
    vi.useFakeTimers();
    const queryState = mode === "検索" ? searchState : listState;
    queryState.error = true;
    queryState.noData = noData;
    render(<CustomersPage />);
    if (mode === "検索") {
      fireEvent.change(screen.getByRole("textbox", { name: "顧客を検索" }), { target: { value: "検索" } });
      act(() => vi.advanceTimersByTime(300));
    }

    expect(screen.getByText("顧客データの取得に失敗しました。")).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.queryByText("顧客がまだ登録されていません")).toBeNull();
    expect(screen.queryByText("該当する顧客が見つかりません")).toBeNull();
    expect(screen.getByRole("alert")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "再読み込み" }));
    expect(queryState.refetch).toHaveBeenCalledOnce();
    expect((mode === "検索" ? listState : searchState).refetch).not.toHaveBeenCalled();
  });

  it.each(["123", "1234", "1234567890"])("スタッフの短い電話検索 %s は全桁入力を案内する", (query) => {
    vi.useFakeTimers();
    authState.isPrivileged = false;
    authState.storeId = "kyoto";
    searchState.empty = true;
    render(<CustomersPage />);

    const search = screen.getByRole("textbox", { name: "顧客を検索" });
    fireEvent.change(search, { target: { value: query } });
    act(() => vi.advanceTimersByTime(300));

    expect(screen.getByText("該当する顧客が見つかりません")).toBeTruthy();
    expect(screen.queryByText("電話番号は全桁で入力してください")).not.toBeNull();
    expect(search.getAttribute("placeholder")).toBe("名前・カナ・電話番号（全桁）で検索...");
  });

  it.each([
    { isPrivileged: true, query: "1234" },
    { isPrivileged: false, query: "山田" },
    { isPrivileged: false, query: "09012345678" },
  ])("$isPrivileged / $query の空検索結果には全桁入力の案内を出さない", ({ isPrivileged, query }) => {
    vi.useFakeTimers();
    authState.isPrivileged = isPrivileged;
    searchState.empty = true;
    render(<CustomersPage />);
    fireEvent.change(screen.getByRole("textbox", { name: "顧客を検索" }), { target: { value: query } });
    act(() => vi.advanceTimersByTime(300));

    expect(screen.getByText("該当する顧客が見つかりません")).toBeTruthy();
    expect(screen.queryByText("電話番号は全桁で入力してください")).toBeNull();
  });

  it("検索入力はアーカイブ表示中も顧客検索の名前で識別できる", () => {
    render(<CustomersPage />);

    const search = screen.getByRole("textbox", { name: "顧客を検索" });
    fireEvent.click(screen.getByRole("button", { name: "アーカイブ済みを表示" }));

    expect(screen.getByRole("textbox", { name: "顧客を検索" })).toBe(search);
    expect(search).toHaveProperty("disabled", true);
  });

  // 顧客の手動追加とアーカイブ済み一覧はスタッフにも開いている (2026-08-26)。
  // 統合候補セクションだけは owner+ のまま。
  it("スタッフにも顧客追加とアーカイブ表示切替を出す", () => {
    authState.isPrivileged = false;
    authState.storeId = "kyoto";
    render(<CustomersPage />);

    expect(screen.getByRole("button", { name: "顧客を追加" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "アーカイブ済みを表示" })).toBeTruthy();
  });

  // 統合はオーナー限定のまま。候補を1件返させたうえで owner に出て staff に出ないことを
  // 見る — 空のまま assert すると `groups.length === 0 → null` で role と無関係に通る。
  // (verify-tasks T017)
  it("統合候補セクションは owner に出て staff には出ない", () => {
    mergeState.groups = [
      {
        groupId: "g1",
        customers: [
          {
            id: "c1",
            displayName: "重複 太郎",
            displayNameKana: null,
            phoneNormalizedMasked: "090****5678",
            blockStatus: "active",
            lastReservationAt: null,
          },
          {
            id: "c2",
            displayName: "重複 太郎",
            displayNameKana: null,
            phoneNormalizedMasked: "090****5678",
            blockStatus: "active",
            lastReservationAt: null,
          },
        ],
      },
    ];

    const owner = render(<CustomersPage />);
    expect(screen.getByText("統合候補（重複の可能性）")).toBeTruthy();
    owner.unmount();

    authState.isPrivileged = false;
    authState.storeId = "kyoto";
    render(<CustomersPage />);
    expect(screen.queryByText("統合候補（重複の可能性）")).toBeNull();
  });

  // 店舗に紐付いていない staff はサーバー側で全部 403 になるので、押せば必ず失敗する
  // 追加ボタンを出さない。(/code-review 指摘)
  it("店舗未紐付けのスタッフには顧客追加を出さない", () => {
    authState.isPrivileged = false;
    authState.storeId = null;
    render(<CustomersPage />);

    expect(screen.queryByRole("button", { name: "顧客を追加" })).toBeNull();
  });

  it("ページを移動して選んだ顧客の詳細を開く", () => {
    render(<CustomersPage />);

    expect(screen.getByText("全201件")).toBeTruthy();
    expect(screen.getByText("1 / 2")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "次へ" }));

    expect(screen.getByText("2 / 2")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("佐藤 太郎の顧客詳細を開く"));

    expect(screen.getByText("顧客詳細: customer-2")).toBeTruthy();
  });

  it("アーカイブ表示へ切り替えると検索語を解除して入力を無効化する", () => {
    vi.useFakeTimers();
    render(<CustomersPage />);

    const search = screen.getByPlaceholderText("名前・カナ・電話番号で検索...");
    fireEvent.change(search, { target: { value: "検索" } });
    act(() => vi.advanceTimersByTime(300));
    expect(screen.getByText("検索 花子")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "アーカイブ済みを表示" }));

    expect(search).toHaveProperty("value", "");
    expect(search).toHaveProperty("disabled", true);
    expect(screen.getByText("アーカイブ済み201件")).toBeTruthy();
  });

  // 1 文字だけ入れた状態は検索が走らず一覧に戻る。何も言わないと「その 1 文字で
  // 絞った結果、これだけしか居ない」と読めてしまう。
  it("検索語が1文字のときは絞り込めていないことを伝える", () => {
    vi.useFakeTimers();
    render(<CustomersPage />);

    const search = screen.getByPlaceholderText("名前・カナ・電話番号で検索...");
    fireEvent.change(search, { target: { value: "検" } });
    act(() => vi.advanceTimersByTime(300));

    expect(screen.getByText(/2 文字以上入力してください/)).toBeTruthy();

    fireEvent.change(search, { target: { value: "検索" } });
    act(() => vi.advanceTimersByTime(300));
    expect(screen.queryByText(/2 文字以上入力してください/)).toBeNull();
  });

  // 「絞り込んでいません」の判定は trim 後、検索に出すかどうかは trim 前、という
  // ずれがあると、見える文字 1 つ + 空白のときに「一覧です」と書いてある表の中身が
  // 絞り込まれる。居る顧客を居ないと読み違える。
  it("見える文字が1つで後ろに空白があっても検索に出さない", () => {
    vi.useFakeTimers();
    render(<CustomersPage />);

    const search = screen.getByPlaceholderText("名前・カナ・電話番号で検索...");
    fireEvent.change(search, { target: { value: "検 " } });
    act(() => vi.advanceTimersByTime(300));

    expect(screen.getByText(/2 文字以上入力してください/)).toBeTruthy();
    // 一覧のままであること。検索結果に切り替わっていれば「検索 花子」だけが並ぶ。
    expect(screen.queryByText("検索 花子")).toBeNull();
    expect(screen.getByText("山田 花子")).toBeTruthy();
  });

  // debounce は 300ms 遅れる。2 文字から 1 文字へ消した直後は「短すぎる」が先に true に
  // なる一方 debouncedQuery はまだ前の 2 文字なので、「絞り込み前の一覧です」と書いてある
  // 下に前の語の検索結果が出続ける。表示は同時に切り替える。
  it("2文字から1文字へ消した直後に前の語の検索結果を出し続けない", () => {
    vi.useFakeTimers();
    render(<CustomersPage />);

    const search = screen.getByPlaceholderText("名前・カナ・電話番号で検索...");
    fireEvent.change(search, { target: { value: "検索" } });
    act(() => vi.advanceTimersByTime(300));
    expect(screen.getByText("検索 花子")).toBeTruthy();

    // 1 文字消す。debounce が明ける前の状態を見る。
    fireEvent.change(search, { target: { value: "検" } });
    expect(screen.getByText(/2 文字以上入力してください/)).toBeTruthy();
    expect(screen.queryByText("検索 花子")).toBeNull();
    expect(screen.getByText("山田 花子")).toBeTruthy();
  });

  it("スタッフはコード入力なしで顧客一覧を開く", () => {
    authState.isPrivileged = false;
    authState.storeId = "kyoto";

    render(<CustomersPage />);

    expect(screen.getByText("山田 花子")).not.toBeNull();
    expect(screen.queryByText("顧客情報の閲覧にはオーナーの確認が必要です")).toBeNull();
  });

  it("有効な customerId URL パラメータから顧客詳細を開く", () => {
    customerState.params = new URLSearchParams("customerId=customer_42");

    render(<CustomersPage />);

    expect(screen.getByText("顧客詳細: customer_42")).toBeTruthy();
  });
});
