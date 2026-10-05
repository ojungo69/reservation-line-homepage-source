import { fireEvent, render, screen } from "@testing-library/react";
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
    return {
      data: {
        ok: true,
        from: filter?.from ?? "",
        to: filter?.to ?? "",
        reservations: pendingOnly ? [] : reservations,
        truncated: false,
        totalCount: pendingOnly ? 0 : reservations.length,
      },
      isPending: false,
      isError: false,
    };
  }),
  buildCsvExportUrl: vi.fn(() => "/api/admin/reservations/export"),
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

  it("承認待ちフィルタでは空状態と絞り込みヒントを表示する", () => {
    render(<ReservationsPage />);

    fireEvent.click(screen.getByRole("button", { name: "承認待ちのみ" }));

    expect(screen.getByText("該当する予約はありません")).toBeTruthy();
    expect(screen.getByText("絞り込み条件を変更すると見つかる場合があります")).toBeTruthy();
    expect(useReservationSearch).toHaveBeenLastCalledWith(
      expect.objectContaining({ statuses: ["pending_approval"] }),
    );
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
