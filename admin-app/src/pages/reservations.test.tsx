import { act, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import ReservationsPage from "./reservations";
import { useReservationSearch } from "@/hooks/use-reservation-search";

const authState = vi.hoisted(() => ({
  storeId: null as string | null,
  selectedStoreId: undefined as string | null | undefined,
  selectStore: vi.fn(),
}));

const reservationState = vi.hoisted(() => ({
  isNarrow: false,
  navigate: vi.fn(),
  mutate: vi.fn(),
  rejectReason: "",
  locationState: null as unknown,
  rows: null as unknown[] | null,
}));

const reservations = [
  {
    id: "reservation-1",
    status: "pending_approval",
    source: "line",
    storeName: "渋谷店",
    serviceName: "全身脱毛",
    startAt: "2026-08-01T01:00:00.000Z",
    endAt: "2026-08-01T02:00:00.000Z",
    customerId: "customer-1",
    customerDisplayName: "山田 花子",
    customerDisplayNameKana: "ヤマダ ハナコ",
    phoneTailMasked: "1234",
    lineFriendStatus: null,
    googleEventId: null,
    cancellationFeeUnpaidAt: null,
  },
  {
    id: "reservation-2",
    status: "confirmed",
    source: "line",
    storeName: "新宿店",
    serviceName: "部分脱毛",
    startAt: "2026-08-02T01:00:00.000Z",
    endAt: "2026-08-02T02:00:00.000Z",
    customerId: "customer-2",
    customerDisplayName: "佐藤 太郎",
    customerDisplayNameKana: "サトウ タロウ",
    phoneTailMasked: "5678",
    lineFriendStatus: null,
    googleEventId: null,
    cancellationFeeUnpaidAt: null,
  },
];

vi.mock("react-router", () => ({
  useNavigate: () => reservationState.navigate,
  useLocation: () => ({ state: reservationState.locationState }),
}));

vi.mock("@tanstack/react-query", () => ({
  useMutationState: () => [],
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    user: {
      id: "user-1",
      role: "owner",
      storeId: authState.storeId,
    },
  }),
}));

vi.mock("@/hooks/use-settings", () => ({
  useSettings: () => ({ data: undefined }),
}));
vi.mock("@/hooks/use-stores", () => ({
  useStores: () => ({
    selectedStoreId: authState.selectedStoreId === undefined ? authState.storeId : authState.selectedStoreId,
    selectStore: authState.selectStore,
    isStoreFixed: false,
  }),
}));

vi.mock("@/hooks/use-reservation-search", () => ({
  useReservationSearch: vi.fn((filter) => {
    const pendingOnly = filter?.statuses?.length === 1 && filter.statuses[0] === "pending_approval";
    const rows = reservationState.rows ?? reservations;
    return {
      data: {
        ok: true,
        from: filter?.from ?? "",
        to: filter?.to ?? "",
        reservations: pendingOnly ? [] : rows,
        truncated: false,
        totalCount: pendingOnly ? 0 : rows.length,
      },
      isPending: false,
      isError: false,
    };
  }),
}));

// Radix の Select は閉じていると選択肢が DOM に無いため、選択肢を読める素の option に置き換える。
vi.mock("@/components/ui/select", () => ({
  Select: ({ value, onValueChange, children }: { value: string; onValueChange: (v: string) => void; children: ReactNode }) => (
    <select value={value} onChange={(event) => onValueChange(event.target.value)}>{children}</select>
  ),
  SelectTrigger: () => null,
  SelectValue: () => null,
  SelectContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  SelectItem: ({ value, children }: { value: string; children: ReactNode }) => <option value={value}>{children}</option>,
}));

vi.mock("@/hooks/use-reservations", () => ({
  useReservationAction: () => ({
    mutate: reservationState.mutate,
    isPending: false,
  }),
}));

vi.mock("@/hooks/use-media-query", () => ({
  NARROW_QUERY: "(max-width: 639px)",
  useMediaQuery: () => reservationState.isNarrow,
}));

vi.mock("@/components/schedule/pending-approvals-card", () => ({
  PendingApprovalsCard: ({ selectedStoreId, fullList, nameFilter }: { selectedStoreId: string | null; fullList?: boolean; nameFilter?: string }) =>
    <p>全期間承認待ち: {selectedStoreId ?? "全店舗"} / {String(fullList)} / {nameFilter}</p>,
}));

vi.mock("@/components/schedule/reservation-detail-panel", () => ({
  ReservationDetailPanel: ({ reservationId }: { reservationId: string | null }) =>
    reservationId ? <p>予約詳細: {reservationId}</p> : null,
}));

vi.mock("@/components/schedule/reject-reason-dialog", () => ({
  RejectReasonDialog: ({
    open,
    onConfirm,
  }: {
    open: boolean;
    onConfirm: (reason: string) => void;
  }) => open ? (
    <div>
      <h2>予約を却下しますか?</h2>
      <label htmlFor="reject-reason">却下理由（任意・お客様に通知されます）</label>
      <textarea
        id="reject-reason"
        onChange={(event) => { reservationState.rejectReason = event.target.value; }}
      />
      <button type="button" onClick={() => onConfirm(reservationState.rejectReason.trim())}>
        却下する
      </button>
    </div>
  ) : null,
}));

afterEach(() => {
  authState.storeId = null;
  authState.selectedStoreId = undefined;
  authState.selectStore.mockClear();
  reservationState.isNarrow = false;
  reservationState.navigate.mockClear();
  reservationState.mutate.mockClear();
  reservationState.rejectReason = "";
  reservationState.locationState = null;
  reservationState.rows = null;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.mocked(useReservationSearch).mockClear();
});

describe("ReservationsPage initial store filter", () => {
  it("ヘッダーで選択した店舗と、その後の切替を一覧へ反映する", () => {
    authState.storeId = "store-1";
    authState.selectedStoreId = "store-2";
    const { rerender } = render(<ReservationsPage />);
    expect(useReservationSearch).toHaveBeenLastCalledWith(expect.objectContaining({ storeId: "store-2" }));
    authState.selectedStoreId = null;
    rerender(<ReservationsPage />);
    expect(useReservationSearch).toHaveBeenLastCalledWith(expect.objectContaining({ storeId: undefined }));
  });
  it.each([
    { userStoreId: null, expectedStoreId: undefined },
    { userStoreId: "store-1", expectedStoreId: "store-1" },
  ])(
    "ログインユーザーの店舗 $userStoreId を検索条件へ反映する",
    ({ userStoreId, expectedStoreId }) => {
      authState.storeId = userStoreId;

      render(<ReservationsPage />);

      expect(screen.getByRole("heading", { name: "予約管理" })).toBeTruthy();
      expect(useReservationSearch).toHaveBeenCalledWith(
        expect.objectContaining({ storeId: expectedStoreId }),
      );
    },
  );
});

describe("ReservationsPage user flows", () => {
  it("デスクトップで顧客順へ並べ替え、予約詳細を開く", () => {
    render(<ReservationsPage />);

    fireEvent.click(screen.getByRole("button", { name: "顧客" }));

    const rows = screen.getAllByRole("row");
    expect(rows[1]?.textContent).toContain("佐藤 太郎");
    expect(rows[2]?.textContent).toContain("山田 花子");

    fireEvent.click(screen.getByLabelText("佐藤 太郎の予約詳細を開く"));

    expect(screen.getByText("予約詳細: reservation-2")).toBeTruthy();
  });

  it("承認待ちは日付検索を停止して現在の店舗の全期間キューを開く", () => {
    authState.selectedStoreId = "store-1";
    render(<ReservationsPage />);
    fireEvent.click(screen.getByRole("button", { name: "承認待ち" }));
    expect(screen.getByText(/全期間承認待ち: store-1 \/ true \//)).toBeTruthy();
    expect(useReservationSearch).toHaveBeenLastCalledWith(null);
    expect(screen.queryByLabelText("開始日")).toBeNull();
    expect(screen.getByText("予約日の指定なし・承認期限順")).toBeTruthy();
  });

  it("今日/今後30日/過去30日を選び、検索語を解除しても期間と店舗は保つ", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-16T05:00:00Z"));
    authState.selectedStoreId = "store-1";
    render(<ReservationsPage />);
    expect(useReservationSearch).toHaveBeenLastCalledWith(expect.objectContaining({ from: "2026-11-16", to: "2026-12-15" }));
    fireEvent.click(screen.getByRole("button", { name: "過去30日" }));
    expect(useReservationSearch).toHaveBeenLastCalledWith(expect.objectContaining({ from: "2026-10-18", to: "2026-11-16" }));
    fireEvent.change(screen.getByLabelText("顧客名・カナ・電話番号"), { target: { value: "架" } });
    expect(screen.queryByText("山田 花子")).toBeNull();
    expect(screen.getByText("検索中です…")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "絞り込みを解除" }));
    expect(screen.getByLabelText("顧客名・カナ・電話番号")).toHaveProperty("value", "");
    expect(useReservationSearch).toHaveBeenLastCalledWith(expect.objectContaining({ from: "2026-10-18", to: "2026-11-16", storeId: "store-1", keyword: undefined }));
    expect(authState.selectStore).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "今日" }));
    expect(useReservationSearch).toHaveBeenLastCalledWith(expect.objectContaining({ from: "2026-11-16", to: "2026-11-16" }));
  });

  it("同一ログインの履歴stateから条件を復元し、検索語をURLへ入れず保存する", () => {
    reservationState.locationState = { reservationSearch: { scope: "undefined:owner:", value: { from: "2026-10-18", to: "2026-11-16", keyword: "山田", serviceId: "__all__", statusFilter: "__all__", sortKey: "startAt", sortDir: "desc", viewMode: "history" } } };
    render(<ReservationsPage />);
    expect(screen.getByLabelText("顧客名・カナ・電話番号")).toHaveProperty("value", "山田");
    expect(useReservationSearch).toHaveBeenLastCalledWith(expect.objectContaining({ from: "2026-10-18", to: "2026-11-16", keyword: "山田" }));
    fireEvent.click(screen.getByRole("button", { name: "今日" }));
    expect(reservationState.navigate).toHaveBeenLastCalledWith(".", expect.objectContaining({ replace: true, state: expect.objectContaining({ reservationSearch: expect.objectContaining({ value: expect.objectContaining({ keyword: "山田" }) }) }) }));
  });

  it("狭い一覧領域では画面全体の幅に関わらずカードを使う", () => {
    let onResize: ResizeObserverCallback = () => {};
    vi.stubGlobal("ResizeObserver", class { constructor(callback: ResizeObserverCallback) { onResize = callback; } observe() {} disconnect() {} });
    render(<ReservationsPage />);
    expect(screen.getByRole("table")).toBeTruthy();
    act(() => onResize([{ contentRect: { width: 800 } } as ResizeObserverEntry], {} as ResizeObserver));
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.getAllByRole("button", { name: "詳細" })).toHaveLength(2);
  });

  it("モバイルで承認確認を経て予約を承認する", () => {
    reservationState.isNarrow = true;
    render(<ReservationsPage />);

    fireEvent.click(screen.getByRole("button", { name: "承認" }));
    expect(screen.getByRole("heading", { name: "予約を承認しますか?" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "承認する" }));

    expect(reservationState.mutate).toHaveBeenCalledWith({
      reservationId: "reservation-1",
      action: "approve",
    });
    expect(screen.queryByRole("heading", { name: "予約を承認しますか?" })).toBeNull();
  });

  it("モバイルで理由を添えて予約を却下する", () => {
    reservationState.isNarrow = true;
    render(<ReservationsPage />);

    fireEvent.click(screen.getByRole("button", { name: "却下" }));
    expect(screen.getByRole("heading", { name: "予約を却下しますか?" })).toBeTruthy();
    fireEvent.change(
      screen.getByLabelText("却下理由（任意・お客様に通知されます）"),
      { target: { value: "同時間帯に別のご予約が重なったため" } },
    );
    fireEvent.click(screen.getByRole("button", { name: "却下する" }));

    expect(reservationState.mutate).toHaveBeenCalledWith({
      reservationId: "reservation-1",
      action: "reject",
      reason: "同時間帯に別のご予約が重なったため",
    });
    expect(screen.queryByRole("heading", { name: "予約を却下しますか?" })).toBeNull();
  });
});

describe("ReservationsPage 店舗を選んでいるときの表示", () => {
  it("店舗を選んでいると、表の店舗の列が無い", () => {
    authState.selectedStoreId = "store-1";
    render(<ReservationsPage />);

    expect(screen.queryByRole("columnheader", { name: "店舗" })).toBeNull();
    expect(screen.getAllByRole("columnheader")).toHaveLength(5);
    const rows = screen.getAllByRole("row");
    expect(rows[1]?.textContent).toContain("山田 花子");
    expect(rows[1]?.textContent).not.toContain("渋谷店");
  });

  it("全店舗なら、表の店舗の列と店舗名が出る", () => {
    authState.selectedStoreId = null;
    render(<ReservationsPage />);

    expect(screen.getByRole("columnheader", { name: "店舗" })).toBeTruthy();
    expect(screen.getAllByRole("columnheader")).toHaveLength(6);
    expect(screen.getAllByRole("row")[1]?.textContent).toContain("渋谷店");
  });

  it("店舗を選んでいると、カード表示の並べ替えに店舗が無く、カードに店舗名が出ない", () => {
    reservationState.isNarrow = true;
    authState.selectedStoreId = "store-1";
    render(<ReservationsPage />);

    expect(screen.queryByRole("option", { name: "店舗" })).toBeNull();
    expect(screen.getByRole("option", { name: "日時" })).toBeTruthy();
    const cards = screen.getAllByRole("article");
    expect(cards).toHaveLength(2);
    expect(cards[0]?.textContent).not.toContain("渋谷店");
  });

  it("全店舗なら、カード表示の並べ替えに店舗があり、カードに店舗名が出る", () => {
    reservationState.isNarrow = true;
    authState.selectedStoreId = null;
    render(<ReservationsPage />);

    expect(screen.getByRole("option", { name: "店舗" })).toBeTruthy();
    expect(screen.getAllByRole("article")[0]?.textContent).toContain("渋谷店");
  });

  it("店舗を選んだ状態で、店舗で並べ替えた保存値を復元すると、同じ店舗の予約が日時の降順に並ぶ", () => {
    authState.selectedStoreId = "store-1";
    reservationState.rows = [
      { ...reservations[0], id: "reservation-early", customerDisplayName: "早い予約", customerDisplayNameKana: "ハヤイ", startAt: "2026-11-01T01:00:00.000Z", endAt: "2026-11-01T02:00:00.000Z" },
      { ...reservations[0], id: "reservation-late", customerDisplayName: "遅い予約", customerDisplayNameKana: "オソイ", startAt: "2026-11-05T01:00:00.000Z", endAt: "2026-11-05T02:00:00.000Z" },
    ];
    reservationState.locationState = { reservationSearch: { scope: "undefined:owner:", value: { from: "2026-10-18", to: "2026-11-16", keyword: "", serviceId: "__all__", statusFilter: "__all__", sortKey: "storeName", sortDir: "desc", viewMode: "history" } } };
    render(<ReservationsPage />);

    expect(screen.getByRole("columnheader", { name: "日時" }).getAttribute("aria-sort")).toBe("descending");
    const rows = screen.getAllByRole("row");
    expect(rows[1]?.textContent).toContain("遅い予約");
    expect(rows[2]?.textContent).toContain("早い予約");
  });

  it("店舗の並べ替えを隠している間に日時の向きを変えても、全店舗へ戻したとき店舗の並べ替えが復活しない", () => {
    authState.selectedStoreId = null;
    const { rerender } = render(<ReservationsPage />);
    fireEvent.click(screen.getByRole("button", { name: "店舗" }));
    expect(screen.getByRole("columnheader", { name: "店舗" }).getAttribute("aria-sort")).toBe("ascending");

    authState.selectedStoreId = "store-1";
    rerender(<ReservationsPage />);
    fireEvent.click(screen.getByRole("button", { name: "日時" }));
    expect(screen.getByRole("columnheader", { name: "日時" }).getAttribute("aria-sort")).toBe("descending");

    authState.selectedStoreId = null;
    rerender(<ReservationsPage />);
    expect(screen.getByRole("columnheader", { name: "日時" }).getAttribute("aria-sort")).toBe("descending");
    expect(screen.getByRole("columnheader", { name: "店舗" }).getAttribute("aria-sort")).toBe("none");
    const rows = screen.getAllByRole("row");
    expect(rows[1]?.textContent).toContain("佐藤 太郎");
    expect(rows[2]?.textContent).toContain("山田 花子");
  });

  it("カード表示でも、店舗の並べ替えを隠している間に向きを変えたあと、全店舗へ戻して店舗の並べ替えが復活しない", () => {
    reservationState.isNarrow = true;
    authState.selectedStoreId = null;
    const { rerender } = render(<ReservationsPage />);
    fireEvent.change(screen.getByDisplayValue("日時"), { target: { value: "storeName" } });

    authState.selectedStoreId = "store-1";
    rerender(<ReservationsPage />);
    fireEvent.click(screen.getByRole("button", { name: "昇順 ↑" }));
    expect(screen.getByRole("button", { name: "降順 ↓" })).toBeTruthy();

    authState.selectedStoreId = null;
    rerender(<ReservationsPage />);
    expect(screen.getByDisplayValue("日時")).toBeTruthy();
    expect(screen.getByRole("button", { name: "降順 ↓" })).toBeTruthy();
  });
});

describe("ReservationsPage 状態の選択肢", () => {
  it("状態の選択肢に「来店中」が無い", () => {
    render(<ReservationsPage />);

    expect(screen.getByRole("option", { name: "全ステータス" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "確定" })).toBeTruthy();
    expect(screen.queryByRole("option", { name: "来店中" })).toBeNull();
  });

  it("来店中の保存値で開くと、既定の絞り込みになる", () => {
    reservationState.locationState = { reservationSearch: { scope: "undefined:owner:", value: { from: "2026-10-18", to: "2026-11-16", keyword: "山田", serviceId: "__all__", statusFilter: "checked_in", sortKey: "startAt", sortDir: "desc", viewMode: "history" } } };
    render(<ReservationsPage />);

    expect(screen.getByLabelText("顧客名・カナ・電話番号")).toHaveProperty("value", "");
    expect(useReservationSearch).toHaveBeenLastCalledWith(expect.objectContaining({ statuses: undefined, keyword: undefined }));
  });
});
