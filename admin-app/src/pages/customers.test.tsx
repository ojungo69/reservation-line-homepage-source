import type { KeyboardEvent } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CustomerListItem, CustomerSearchItem } from "@/types/api";
import { ApiError } from "@/lib/api-client";
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
// 既定は空 (=セクションは描画されない)。role で出し分けていることを確かめるテストだけが
// 非空にする。空のままだと `groups.length === 0 → null` で owner でも消えるので、
// 「staff には出ない」という assert が role と無関係に通ってしまう。
const mergeState = vi.hoisted(() => ({ groups: [] as Array<{ groupId: string; customers: unknown[] }> }));
// 顧客一覧が返すエラー。既定は null (=承認済み)。顧客タブのゲート (specs/008) を見る
// テストだけが 403 customer_gate_required を入れる。
const gateState = vi.hoisted(() => ({ error: null as unknown, failureReason: null as unknown }));
// useCustomerList に渡った引数の記録。承認失効のポーリングが止まっていないかを見る。
const listCalls = vi.hoisted(() => ({ pausePolling: [] as boolean[] }));

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
  useCustomerList: (offset: number, archivedOnly: boolean, _storeId: string | null, pausePolling = false) => {
    listCalls.pausePolling.push(pausePolling);
    return {
    data: {
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
    isError: false,
    error: gateState.error,
    // 本番の QueryClient は `retry: 1`。1 回目の失敗はここにしか入らず `error` は
    // null のままなので、モックも両方を持つ。
    failureReason: gateState.failureReason,
    };
  },
  useCustomerSearch: (query: string) => ({
    data: {
      ok: true,
      customers: query.length >= 2
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
    isError: false,
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

const gateMutations = vi.hoisted(() => ({
  request: vi.fn(),
  verify: vi.fn(),
}));

// mutate の第2引数の onSuccess だけがカードを「送信済み」に進める。mock 側で data を
// 返して初めから開いた状態にすると、発行の成否で表示が変わることを一度も通らない。
vi.mock("@/hooks/use-customer-gate", () => ({
  useCustomerGateRequest: () => ({ mutate: gateMutations.request, isPending: false }),
  useCustomerGateVerify: () => ({ mutate: gateMutations.verify, isPending: false }),
}));

// verify の失敗を、hook の onError ではなく呼び出し側に渡した onError で再現する
// (画面が入力回数を数えているのはそちら)。
const verifyFails = (status: number) => {
  const onError = gateMutations.verify.mock.calls.at(-1)?.[1]?.onError;
  act(() => onError?.(new ApiError(status, { ok: false, reason: status === 429 ? "rate_limited" : "invalid_code" })));
};

// サーバーまで届かなかった失敗 (通信断・5xx・認証エラー)。verifyCustomerGateCode を
// 通っていないので D1 の attempts は増えていない。
const verifyErrorsBeforeServer = () => {
  const onError = gateMutations.verify.mock.calls.at(-1)?.[1]?.onError;
  act(() => onError?.(new ApiError(500, { ok: false, reason: "internal_error" })));
};

const sendSucceeds = (challengeId: string) => {
  const onSuccess = gateMutations.request.mock.calls.at(-1)?.[1]?.onSuccess;
  expect(onSuccess).toBeTypeOf("function");
  act(() => onSuccess({ ok: true, challengeId, expiresAt: "2026-08-30T01:10:00.000Z" }));
};

afterEach(() => {
  customerState.params = new URLSearchParams();
  customerState.setParams.mockClear();
  authState.isPrivileged = true;
  authState.storeId = null;
  mergeState.groups = [];
  gateState.error = null;
  gateState.failureReason = null;
  gateMutations.request.mockClear();
  gateMutations.verify.mockClear();
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

  // 5 分ごとの再取得は、12 時間の承認がセッション中に切れたことに画面が気付く唯一の
  // 経路 (/me は起動時に 1 回しか引かない)。詳細を開いている間だけ止めると、パネルを
  // 開いたままにするだけで失効に気付かない時間をいくらでも延ばせる (#651 の P1)。
  // 書きかけのメモが消える件 (#652-3) は、承認が切れている以上その保存はサーバー側でも
  // 弾かれるので、こちらを止める理由にはしない。
  it("顧客詳細を開いても承認失効のポーリングは止めない", () => {
    listCalls.pausePolling.length = 0;
    render(<CustomersPage />);

    expect(listCalls.pausePolling.at(-1)).toBe(false);

    fireEvent.click(screen.getByLabelText("山田 花子の顧客詳細を開く"));
    expect(listCalls.pausePolling.at(-1)).toBe(false);
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

  it("有効な customerId URL パラメータから顧客詳細を開く", () => {
    customerState.params = new URLSearchParams("customerId=customer_42");

    render(<CustomersPage />);

    expect(screen.getByText("顧客詳細: customer_42")).toBeTruthy();
  });
});

describe("顧客タブのオーナー承認ゲート", () => {
  const gateError = () =>
    new ApiError(403, { ok: false, reason: "customer_gate_required" });

  it("承認が無いときは顧客データを一切描画せず、コード入力の案内だけを出す", () => {
    authState.isPrivileged = false;
    authState.storeId = "kyoto";
    gateState.error = gateError();

    render(<CustomersPage />);

    expect(screen.getByText("顧客情報の閲覧にはオーナーの確認が必要です")).not.toBeNull();
    // 一覧のモックは顧客を返しているので、これが出たらゲートが描画を止めていない。
    expect(screen.queryByText("山田 花子")).toBeNull();
    expect(screen.queryByText("090-****-1234")).toBeNull();
    expect(screen.queryByRole("table")).toBeNull();
  });

  // 本番の QueryClient は `retry: 1` なので、1 回目の 403 は `error` ではなく
  // `failureReason` に入る。`error` だけを見ていると、リトライが済むまで理由の無い
  // スケルトンが出る。さらに React Query は networkMode の既定でリトライを
  // `fetchStatus: "paused"` にして待つため、オンライン判定が false のあいだは
  // `error` が永久に埋まらずカードが一度も出ない (staging の実機で観測)。
  // 既存のテストは `retry: false` の QueryClient を使うのでこの経路を通らない。
  it("リトライ前で error がまだ null でも、1回目の403で案内を出す", () => {
    authState.isPrivileged = false;
    authState.storeId = "kyoto";
    gateState.error = null;
    gateState.failureReason = gateError();

    render(<CustomersPage />);

    expect(screen.getByText("顧客情報の閲覧にはオーナーの確認が必要です")).not.toBeNull();
    expect(screen.queryByText("山田 花子")).toBeNull();
    expect(screen.queryByRole("table")).toBeNull();
  });

  // 同じ 403 でも理由が違えばカードを出してはいけない。店舗に紐付いていない staff は
  // `staffHasStore` で `forbidden` の 403 を受ける (src/routes/admin-api.ts)。ここで
  // 案内を出すと、コードを入れても永久に開かない画面をスタッフに見せることになる。
  it("同じ403でも理由が customer_gate_required でなければ案内を出さない", () => {
    authState.isPrivileged = false;
    authState.storeId = "kyoto";
    gateState.error = null;
    gateState.failureReason = new ApiError(403, { ok: false, reason: "forbidden" });

    render(<CustomersPage />);

    expect(screen.queryByText("顧客情報の閲覧にはオーナーの確認が必要です")).toBeNull();
  });

  it("ゲート以外のエラーでも案内を出さない", () => {
    authState.isPrivileged = false;
    authState.storeId = "kyoto";
    gateState.error = null;
    gateState.failureReason = new ApiError(500, { ok: false, reason: "internal" });

    render(<CustomersPage />);

    expect(screen.queryByText("顧客情報の閲覧にはオーナーの確認が必要です")).toBeNull();
  });

  it("コードを送ってから6桁を入力すると検証に進む", () => {
    authState.isPrivileged = false;
    authState.storeId = "kyoto";
    gateState.error = gateError();

    render(<CustomersPage />);
    // 送る前は入力欄を出さない。
    expect(screen.queryByLabelText("確認コード")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "確認コードを送る" }));
    expect(gateMutations.request).toHaveBeenCalledTimes(1);
    sendSucceeds("challenge-1");

    const input = screen.getByLabelText("確認コード");
    // 数字以外は落ちる。
    fireEvent.change(input, { target: { value: "12a34b56789" } });
    expect((input as HTMLInputElement).value).toBe("123456");

    fireEvent.click(screen.getByRole("button", { name: "顧客情報を開く" }));
    expect(gateMutations.verify).toHaveBeenCalledWith(
      { challengeId: "challenge-1", code: "123456" },
      expect.anything(),
    );
  });

  it("再送が失敗しても入力欄と手元のコードが残る", () => {
    // 60 秒のクールダウン中に再送を押すと 429 で終わる。この 429 は発行経路の掃除より手前で
    // 返るので最初のコードはまだ生きている。ここで入力欄が消えると、オーナーから聞いた
    // 有効なコードを入れる場所が無くなり、待って送り直して 2 通目を出すしかなくなる。
    authState.isPrivileged = false;
    authState.storeId = "kyoto";
    gateState.error = gateError();

    render(<CustomersPage />);
    fireEvent.click(screen.getByRole("button", { name: "確認コードを送る" }));
    sendSucceeds("challenge-1");
    expect(screen.getByLabelText("確認コード")).not.toBeNull();

    // 再送 → 失敗 (onSuccess は呼ばれない)。
    fireEvent.click(screen.getByRole("button", { name: "確認コードを再送する" }));
    expect(gateMutations.request).toHaveBeenCalledTimes(2);

    fireEvent.change(screen.getByLabelText("確認コード"), { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: "顧客情報を開く" }));
    expect(gateMutations.verify).toHaveBeenCalledWith(
      { challengeId: "challenge-1", code: "123456" },
      expect.anything(),
    );
  });

  // 5 回外すとサーバー側の試行枠を使い切り、そのあとは正しいコードを入れても同じ
  // 「正しくないか期限切れ」しか返らない。何も言わないと、正しいコードを何度も
  // 入れ直す (そのたびに監査行だけ増える) ことになる。
  it("入力を5回間違えたら再送を促し、それ以上送信させない", () => {
    authState.isPrivileged = false;
    authState.storeId = "kyoto";
    gateState.error = gateError();

    render(<CustomersPage />);
    fireEvent.click(screen.getByRole("button", { name: "確認コードを送る" }));
    sendSucceeds("challenge-1");
    fireEvent.change(screen.getByLabelText("確認コード"), { target: { value: "123456" } });

    for (let i = 0; i < 5; i += 1) {
      fireEvent.click(screen.getByRole("button", { name: "顧客情報を開く" }));
      verifyFails(400);
    }

    expect(screen.getByText(/入力の回数が上限に達したため/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "顧客情報を開く" })).toHaveProperty("disabled", true);

    // 再送が通れば数え直す。
    fireEvent.click(screen.getByRole("button", { name: "確認コードを再送する" }));
    sendSucceeds("challenge-2");
    expect(screen.queryByText(/入力の回数が上限に達したため/)).toBeNull();
  });

  // verify の応答が返る前に再送が成功すると、遅れて届いた**前の**チャレンジの
  // invalid_code が新しいチャレンジの回数を潰す。5 回残っている画面が先に
  // 「再送しかない」と言い出し、オーナーにコード送信をもう 1 通強いることになる。
  it("再送のあとに届いた前のチャレンジの失敗は数えない", () => {
    authState.isPrivileged = false;
    authState.storeId = "kyoto";
    gateState.error = gateError();

    render(<CustomersPage />);
    fireEvent.click(screen.getByRole("button", { name: "確認コードを送る" }));
    sendSucceeds("challenge-1");
    fireEvent.change(screen.getByLabelText("確認コード"), { target: { value: "123456" } });

    // challenge-1 の verify を送信した状態で、応答が返る前に再送が成功する。
    fireEvent.click(screen.getByRole("button", { name: "顧客情報を開く" }));
    const staleOnError = gateMutations.verify.mock.calls.at(-1)?.[1]?.onError;
    fireEvent.click(screen.getByRole("button", { name: "確認コードを再送する" }));
    sendSucceeds("challenge-2");

    // ここで challenge-1 の invalid_code が遅れて届く。数えてしまうと challenge-2 の
    // 残り回数が 1 つ減る。
    act(() => staleOnError?.(new ApiError(400, { ok: false, reason: "invalid_code" })));

    // challenge-2 で 4 回外す。数え違いが無ければ 5 回目がまだ残っている。
    fireEvent.change(screen.getByLabelText("確認コード"), { target: { value: "654321" } });
    for (let i = 0; i < 4; i += 1) {
      fireEvent.click(screen.getByRole("button", { name: "顧客情報を開く" }));
      verifyFails(400);
    }

    expect(screen.queryByText(/入力の回数が上限に達したため/)).toBeNull();
    expect(screen.getByRole("button", { name: "顧客情報を開く" })).toHaveProperty("disabled", false);
  });

  // 429 はサーバー側の試行を消費しないので、上限の数にも入れない。
  it("レート制限で弾かれた回は入力回数に数えない", () => {
    authState.isPrivileged = false;
    authState.storeId = "kyoto";
    gateState.error = gateError();

    render(<CustomersPage />);
    fireEvent.click(screen.getByRole("button", { name: "確認コードを送る" }));
    sendSucceeds("challenge-1");
    fireEvent.change(screen.getByLabelText("確認コード"), { target: { value: "123456" } });

    for (let i = 0; i < 6; i += 1) {
      fireEvent.click(screen.getByRole("button", { name: "顧客情報を開く" }));
      verifyFails(429);
    }

    expect(screen.queryByText(/入力の回数が上限に達したため/)).toBeNull();
  });

  // サーバーまで届かなかった失敗も同じ。数えてしまうと、まだ試行が残っている
  // チャレンジを画面が先に閉じ、オーナーへのコード送信をもう 1 通強いることになる。
  it("サーバーに届かなかった失敗は入力回数に数えない", () => {
    authState.isPrivileged = false;
    authState.storeId = "kyoto";
    gateState.error = gateError();

    render(<CustomersPage />);
    fireEvent.click(screen.getByRole("button", { name: "確認コードを送る" }));
    sendSucceeds("challenge-1");
    fireEvent.change(screen.getByLabelText("確認コード"), { target: { value: "123456" } });

    for (let i = 0; i < 6; i += 1) {
      fireEvent.click(screen.getByRole("button", { name: "顧客情報を開く" }));
      verifyErrorsBeforeServer();
    }

    expect(screen.queryByText(/入力の回数が上限に達したため/)).toBeNull();
    expect(screen.getByRole("button", { name: "顧客情報を開く" })).toHaveProperty("disabled", false);
  });

  it("再送が成功したときは入力済みのコードを消す", () => {
    // 再送が成功した時点で前のコードは失効する (理由は customer-gate-card.tsx の onSend)。
    authState.isPrivileged = false;
    authState.storeId = "kyoto";
    gateState.error = gateError();

    render(<CustomersPage />);
    fireEvent.click(screen.getByRole("button", { name: "確認コードを送る" }));
    sendSucceeds("challenge-1");
    fireEvent.change(screen.getByLabelText("確認コード"), { target: { value: "123456" } });
    expect((screen.getByLabelText("確認コード") as HTMLInputElement).value).toBe("123456");

    fireEvent.click(screen.getByRole("button", { name: "確認コードを再送する" }));
    sendSucceeds("challenge-2");

    expect((screen.getByLabelText("確認コード") as HTMLInputElement).value).toBe("");
    expect(screen.getByRole("button", { name: "顧客情報を開く" }).hasAttribute("disabled")).toBe(true);
  });

  it("承認済み (エラー無し) のときは通常どおり一覧を描画する", () => {
    authState.isPrivileged = false;
    authState.storeId = "kyoto";

    render(<CustomersPage />);

    expect(screen.getByText("山田 花子")).not.toBeNull();
    expect(screen.queryByText("顧客情報の閲覧にはオーナーの確認が必要です")).toBeNull();
  });
});
