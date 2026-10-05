import type { ReactNode } from "react";
import type { Reservation } from "@/types/api";
import { useSettings } from "@/hooks/use-settings";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const cancelBlock = vi.fn();
vi.mock("@/components/schedule/sync-attention", () => ({ ScheduleSyncAttention: () => null }));
let privileged = true;
let isNarrow = false;
let selectedStoreId: string | null = "store-1";
// WeekView の読み込み中・失敗分岐を切り替えるため可変にする (7日分の
// useReservations が同一オブジェクトを共有する)。
const reservationsQuery = {
  data: { ok: true, reservations: [] } as { ok: true; reservations: Reservation[] } | undefined,
  isPending: false,
  isError: false,
  dataUpdatedAt: Date.parse("2026-07-24T01:00:00Z"),
  refetch: vi.fn(),
};
const settingsData = { ok: true, settings: { resources: [], businessHours: [], stores: [{ id: "store-1", name: "渋谷店" }, { id: "store-2", name: "新宿店" }] } };
const settingsQuery = {
  data: settingsData as typeof settingsData | undefined,
  isPending: false,
  isError: false,
  dataUpdatedAt: Date.parse("2026-07-24T01:00:00Z"),
  refetch: vi.fn(),
};
const blocksQuery = {
  data: { ok: true, externalBlocks: [{ id: "block-1", storeId: "store-1", titleSnapshot: "研修", startAt: "2026-07-24T10:00:00+09:00", endAt: "2026-07-24T11:00:00+09:00", status: "active" }] },
  isPending: false,
  isError: false,
  dataUpdatedAt: Date.parse("2026-07-24T01:00:00Z"),
  refetch: vi.fn(),
};

vi.mock("react-router", () => ({
  useLocation: () => ({ state: null }),
  useNavigate: () => vi.fn(),
}));

vi.mock("@/hooks/use-stores", () => ({
  useStores: () => ({ selectedStoreId }),
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ isPrivileged: privileged }),
}));

vi.mock("@/hooks/use-media-query", () => ({
  NARROW_QUERY: "(max-width: 639px)",
  useMediaQuery: () => isNarrow,
}));

vi.mock("@/hooks/use-reservations", () => ({
  useReservations: () => reservationsQuery,
  usePendingReservations: () => ({
    data: { ok: true, reservations: [] },
  }),
}));

vi.mock("@/hooks/use-settings", () => ({
  useSettings: vi.fn(() => settingsQuery),
}));

vi.mock("@/hooks/use-external-blocks", () => ({
  useExternalBlocks: () => blocksQuery,
  useExternalBlockCancel: () => ({ mutate: cancelBlock, isPending: false }),
}));

vi.mock("@/components/schedule/schedule-header", () => ({
  ScheduleHeader: ({
    onCreateBlockClick,
    onCreateClick,
    onViewModeChange,
    onMobileViewChange,
    mobileView,
    onDateChange,
  }: {
    onCreateBlockClick?: () => void;
    onCreateClick: () => void;
    onViewModeChange: (mode: "day" | "week") => void;
    onMobileViewChange?: (mode: "agenda" | "timeline") => void;
    mobileView?: "agenda" | "timeline";
    onDateChange: (date: Date) => void;
  }) => (
    <>
      <button onClick={onCreateBlockClick} disabled={!onCreateBlockClick}>ブロック作成</button>
      <button onClick={onCreateClick}>予約作成</button>
      <button onClick={() => onViewModeChange("week")}>週表示へ</button>
      {mobileView && <button onClick={() => onMobileViewChange?.("agenda")}>予定一覧へ</button>}
      {mobileView && <button onClick={() => onMobileViewChange?.("timeline")}>時間軸へ</button>}
      <button onClick={() => onDateChange(new Date("2026-07-25T01:00:00Z"))}>翌日へ</button>
    </>
  ),
}));

vi.mock("@/components/schedule/timeline-grid", () => ({
  TimelineGrid: ({ onBlockClick, isLoading }: { onBlockClick?: (id: string) => void; isLoading: boolean }) => (
    isLoading ? <div role="status">予定を読み込み中</div> : <button disabled={!onBlockClick} onClick={() => onBlockClick?.("block-1")}>既存ブロック</button>
  ),
}));

vi.mock("@/components/schedule/pending-approvals-card", () => ({
  PendingApprovalsCard: () => null,
}));

vi.mock("@/components/schedule/reservation-detail-panel", () => ({
  ReservationDetailPanel: ({ reservationId }: { reservationId: string | null }) => (
    <div>予約詳細: {reservationId ?? "閉じています"}<input aria-label="編集中の詳細メモ" /></div>
  ),
}));

vi.mock("@/components/schedule/reservation-create-panel", () => ({
  ReservationCreatePanel: () => <div>予約作成パネル<input aria-label="作成中の顧客名" /></div>,
}));

vi.mock("@/components/schedule/external-block-create-dialog", () => ({
  ExternalBlockCreateDialog: ({ open }: { open: boolean }) => (
    open ? <div>ブロック作成ダイアログ</div> : null
  ),
}));

vi.mock("@/components/ui/pending-confirm-dialog", () => ({
  PendingConfirmDialog: ({
    open,
    description,
    onConfirm,
  }: {
    open: boolean;
    description: ReactNode;
    onConfirm: () => void;
  }) => (
    open ? (
      <div>
        {description}
        <button onClick={onConfirm}>取消を確定</button>
      </div>
    ) : null
  ),
}));

import SchedulePage from "./schedule";

beforeEach(() => {
  // 表示日は「今日」なので、Date だけを固定してモックブロックと同じ JST 日に揃える。
  // setTimeout は実物のままなので userEvent はそのまま動く。
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-07-24T01:00:00Z"));
  cancelBlock.mockReset();
  privileged = true;
  isNarrow = false;
  selectedStoreId = "store-1";
  reservationsQuery.isPending = false;
  reservationsQuery.data = { ok: true, reservations: [] };
  reservationsQuery.isError = false;
  reservationsQuery.refetch = vi.fn();
  reservationsQuery.dataUpdatedAt = Date.parse("2026-07-24T01:00:00Z");
  settingsQuery.data = settingsData;
  settingsQuery.dataUpdatedAt = Date.parse("2026-07-24T01:00:00Z");
  vi.mocked(useSettings).mockClear();
  for (const query of [settingsQuery, blocksQuery]) {
    query.isPending = false;
    query.isError = false;
    query.refetch.mockClear();
  }
});

afterEach(() => {
  vi.useRealTimers();
});

describe("SchedulePage", () => {
  it("スマホでは選択日の過去・深夜の予約を読め、詳細編集中も幅変更で内容を保持する", async () => {
    const user = userEvent.setup();
    isNarrow = true;
    const early: Reservation = {
      id: "early", status: "completed", source: "admin", storeId: "store-1", storeName: "渋谷店",
      serviceId: "service-1", serviceName: "カット", resourceId: "inactive-resource", resourceName: "担当 佐藤",
      startAt: "2026-07-24T02:00:00+09:00", endAt: "2026-07-24T02:30:00+09:00",
      customerId: "customer-1", customerDisplayName: "山田 花子", lineFriendStatus: null, cancellationFeeUnpaidAt: null,
    };
    reservationsQuery.data = { ok: true, reservations: [
      early,
      { ...early, id: "late", status: "confirmed", startAt: "2026-07-24T23:45:00+09:00", endAt: "2026-07-25T00:30:00+09:00", customerDisplayName: "佐藤 太郎" },
      { ...early, id: "cancelled", status: "cancelled_by_admin", customerDisplayName: "取消した人" },
      { ...early, id: "other", storeId: "store-2", storeName: "新宿店", customerDisplayName: "他店の人" },
    ] };
    const { rerender } = render(<SchedulePage />);

    expect(screen.getByRole("heading", { name: /7月24日.*渋谷店/ })).toBeTruthy();
    const cards = screen.getAllByRole("article");
    expect(cards).toHaveLength(2);
    expect(cards[0].textContent).toContain("02:00");
    expect(cards[0].textContent).toContain("完了");
    expect(cards[0].textContent).toContain("担当 佐藤");
    expect(cards[1].textContent).toContain("23:45–翌日 00:30");
    expect(screen.queryByText("取消した人")).toBeNull();
    expect(screen.queryByText("他店の人")).toBeNull();
    expect(screen.queryByRole("button", { name: "既存ブロック" })).toBeNull();

    await user.click(screen.getAllByRole("button", { name: "詳細" })[0]);
    await user.type(screen.getByLabelText("編集中の詳細メモ"), "確認中");
    isNarrow = false;
    rerender(<SchedulePage />);
    isNarrow = true;
    rerender(<SchedulePage />);
    expect(screen.getByText("予約詳細: early")).toBeTruthy();
    expect((screen.getByLabelText("編集中の詳細メモ") as HTMLInputElement).value).toBe("確認中");
  });

  it("スマホの店舗・日付変更と空状態を区別し、時間軸のブロックへ戻れる", async () => {
    const user = userEvent.setup();
    isNarrow = true;
    const { rerender } = render(<SchedulePage />);
    expect(screen.getByRole("heading", { name: /7月24日.*渋谷店/ })).toBeTruthy();
    expect(screen.getByText("この日の予約はありません")).toBeTruthy();
    selectedStoreId = null;
    rerender(<SchedulePage />);
    expect(screen.getByRole("heading", { name: /7月24日.*全店舗/ })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "翌日へ" }));
    expect(screen.getByRole("heading", { name: /7月25日.*全店舗/ })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "時間軸へ" }));
    expect(screen.getByRole("button", { name: "既存ブロック" })).toBeTruthy();
  });

  it("PCの週表示とスマホの時間軸選択を幅変更後も別々に復元する", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<SchedulePage />);
    await user.click(screen.getByRole("button", { name: "週表示へ" }));
    expect(screen.getAllByText(/最終更新:/)).toHaveLength(7);
    isNarrow = true;
    rerender(<SchedulePage />);
    expect(screen.getByText("この日の予約はありません")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "時間軸へ" }));
    expect(screen.getByRole("button", { name: "既存ブロック" })).toBeTruthy();
    isNarrow = false;
    rerender(<SchedulePage />);
    expect(screen.getAllByText(/最終更新:/)).toHaveLength(7);
    isNarrow = true;
    rerender(<SchedulePage />);
    expect(screen.getByRole("button", { name: "既存ブロック" })).toBeTruthy();
  });

  it("スマホの読込・更新失敗は空日と区別し、既存の再読込を使う", async () => {
    isNarrow = true;
    settingsQuery.isPending = true;
    const { rerender } = render(<SchedulePage />);
    expect(screen.getByRole("status", { name: "予定を読み込み中" })).toBeTruthy();
    expect(screen.queryByText("この日の予約はありません")).toBeNull();
    settingsQuery.isPending = false;
    settingsQuery.isError = true;
    rerender(<SchedulePage />);
    expect(screen.getByRole("alert").textContent).toContain("店舗設定の更新に失敗");
    expect(screen.queryByText("この日の予約はありません")).toBeNull();
    await userEvent.setup().click(screen.getByRole("button", { name: "再読み込み" }));
    expect(settingsQuery.refetch).toHaveBeenCalled();
  });

  it("設定も含む最も古い取得時刻を表示し、設定の更新失敗でも新しい予定時刻に置換しない", () => {
    settingsQuery.dataUpdatedAt = Date.parse("2026-07-24T00:30:00Z");
    const { rerender } = render(<SchedulePage />);
    expect(useSettings).toHaveBeenCalledWith({ live: true });
    expect(screen.getByText(/予定の最終更新/).textContent).toContain("09:30");
    settingsQuery.isError = true;
    rerender(<SchedulePage />);
    expect(screen.getByRole("alert").textContent).toContain("前回の取得: 7/24 09:30");
  });

  it("設定を一度も取得できていない場合は予定全体の前回取得時刻を表示しない", () => {
    settingsQuery.data = undefined;
    settingsQuery.dataUpdatedAt = 0;
    settingsQuery.isError = true;
    render(<SchedulePage />);
    expect(screen.getByRole("alert").textContent).toContain("店舗設定の読み込みに失敗");
    expect(screen.getByRole("alert").textContent).not.toContain("前回の取得");
  });
  it("週表示でも色だけでなく予約状態を表示する", async () => {
    reservationsQuery.data = { ok: true, reservations: [{ id: "reservation-1", status: "completed", source: "phone_admin", storeId: "store-1", storeName: "渋谷店", serviceId: "service-1", serviceName: "カット", resourceId: "resource-1", resourceName: "担当者", startAt: "2026-07-24T10:00:00+09:00", endAt: "2026-07-24T10:30:00+09:00", customerId: "customer-1", customerDisplayName: "予約 花子", lineFriendStatus: "friend", cancellationFeeUnpaidAt: null }] };
    render(<SchedulePage />);
    await userEvent.setup().click(screen.getByRole("button", { name: "週表示へ" }));
    expect(screen.getAllByRole("button", { name: /完了.*予約 花子|予約 花子.*完了/ })).toHaveLength(7);
  });
  it("週表示でも日ごとの更新時刻と更新失敗を区別する", async () => {
    const { rerender } = render(<SchedulePage />);
    await userEvent.setup().click(screen.getByRole("button", { name: "週表示へ" }));
    expect(screen.getAllByText(/最終更新: 7\/24 10:00/)).toHaveLength(7);
    reservationsQuery.isError = true;
    rerender(<SchedulePage />);
    expect(screen.getAllByRole("alert")[0].textContent).toContain("更新に失敗しました");
    expect(screen.getAllByRole("alert")[0].textContent).toContain("前回の取得: 7/24 10:00");
  });

  it("予定の再取得や失敗で作成パネルの入力を破棄しない", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<SchedulePage />);
    await user.click(screen.getByRole("button", { name: "予約作成" }));
    await user.type(screen.getByLabelText("作成中の顧客名"), "入力途中");
    reservationsQuery.dataUpdatedAt += 30_000;
    rerender(<SchedulePage />);
    expect((screen.getByLabelText("作成中の顧客名") as HTMLInputElement).value).toBe("入力途中");
    blocksQuery.isError = true;
    rerender(<SchedulePage />);
    expect((screen.getByLabelText("作成中の顧客名") as HTMLInputElement).value).toBe("入力途中");
  });
  it.each([
    { query: blocksQuery, label: "ブロック" },
    { query: settingsQuery, label: "店舗設定" },
  ])("$labelだけ失敗しても空きグリッドを出さず、対象を再取得する", async ({ query, label }) => {
    query.isError = true;
    render(<SchedulePage />);
    expect(screen.getByRole("alert").textContent).toContain(label);
    expect(screen.queryByRole("button", { name: "既存ブロック" })).toBeNull();
    await userEvent.setup().click(screen.getByRole("button", { name: "再読み込み" }));
    expect(query.refetch).toHaveBeenCalled();
  });

  it("設定・ブロックの初期読込中は空きグリッドを出さない", () => {
    blocksQuery.isPending = true;
    render(<SchedulePage />);
    expect(screen.getByText("予定を読み込み中")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "既存ブロック" })).toBeNull();
  });

  it("最終更新時刻を表示し、更新失敗では古い取得時刻を最新と扱わない", () => {
    const { rerender } = render(<SchedulePage />);
    expect(screen.getByText(/予定の最終更新/).textContent).toContain("10:00");
    blocksQuery.isError = true;
    rerender(<SchedulePage />);
    expect(screen.getByRole("alert").textContent).toContain("更新に失敗");
    expect(screen.getByRole("alert").textContent).toContain("前回の取得");
    expect(screen.queryByText(/予定の最終更新/)).toBeNull();
  });
  it("権限ユーザーへブロック作成・取消操作を配線する", async () => {
    const user = userEvent.setup();
    render(<SchedulePage />);

    await user.click(screen.getByRole("button", { name: "ブロック作成" }));
    expect(screen.getByText("ブロック作成ダイアログ")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "既存ブロック" }));
    expect(screen.getByText(/研修/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "取消を確定" }));
    expect(cancelBlock).toHaveBeenCalledWith(
      { externalBlockId: "block-1" },
      expect.objectContaining({ onSuccess: expect.any(Function) }),
    );
  });

  it("一般スタッフにはブロック操作を配線しない", () => {
    privileged = false;
    render(<SchedulePage />);
    expect((screen.getByRole("button", { name: "ブロック作成" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "既存ブロック" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("週表示で取得中の日は読み込み状態を出す", async () => {
    const user = userEvent.setup();
    reservationsQuery.isPending = true;
    render(<SchedulePage />);

    await user.click(screen.getByRole("button", { name: "週表示へ" }));
    expect(screen.getAllByRole("status", { name: "読み込み中" })).toHaveLength(7);
  });

  it("週表示で取得失敗した日は再試行を出し、クリックで refetch する", async () => {
    const user = userEvent.setup();
    reservationsQuery.isError = true;
    reservationsQuery.data = undefined;
    reservationsQuery.dataUpdatedAt = 0;
    render(<SchedulePage />);

    await user.click(screen.getByRole("button", { name: "週表示へ" }));
    expect(screen.getAllByRole("alert")).toHaveLength(7);
    expect(screen.getAllByText("読み込みに失敗しました")).toHaveLength(7);

    await user.click(screen.getAllByRole("button", { name: "再試行" })[0]);
    expect(reservationsQuery.refetch).toHaveBeenCalled();
  });
});
