import { useEffect, type ReactNode } from "react";
import type { Reservation, SettingsResponse } from "@/types/api";
import type { ScheduleContext } from "@/lib/schedule-context";
import { useSettings } from "@/hooks/use-settings";
import { useExternalBlocks } from "@/hooks/use-external-blocks";
import { useReservations } from "@/hooks/use-reservations";
import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const cancelBlock = vi.fn();
const createReservation = vi.fn();
const routerState = vi.hoisted(() => {
  const location: { state: unknown } = { state: null };
  return { location, navigate: vi.fn() };
});
vi.mock("@/components/schedule/sync-attention", () => ({ ScheduleSyncAttention: () => null }));
let privileged = true;
// 2 店舗の設定は全店舗を見られるオーナーにだけ返る（店舗スタッフには自店舗だけ）。
let signedInAsOwner = false;
let isNarrow = false;
let selectedStoreId: string | null = "store-1";
let renderRealCreatePanel = false;
let pendingReservations: Array<{ id: string; startAt: string; storeId: string }> = [];
let loadingReservationDate: string | null = null;
// WeekView の読み込み中・失敗分岐を切り替えるため可変にする (通常は7日分の
// useReservations が同一オブジェクトを共有する)。
const reservationsQuery = {
  data: { ok: true, reservations: [] } as { ok: true; reservations: Reservation[] } | undefined,
  isPending: false,
  isError: false,
  dataUpdatedAt: Date.parse("2026-07-24T01:00:00Z"),
  refetch: vi.fn(),
};
const storeDefaults = {
  timezone: "Asia/Tokyo", googleCalendarId: null, googleControlledEditMode: false,
  maxActiveReservationsPerCustomer: 3, bookingWindowDays: 30, customerNotice: null,
};
const settingsData: SettingsResponse = { ok: true, settings: {
  resources: [
    { id: "resource-1", storeId: "store-1", name: "担当A", resourceType: "staff_calendar", active: true },
    { id: "resource-2", storeId: "store-2", name: "担当B", resourceType: "staff_calendar", active: true },
  ],
  services: [], businessHours: [], closures: [],
  stores: [
    { id: "store-1", name: "渋谷店", ...storeDefaults },
    { id: "store-2", name: "新宿店", ...storeDefaults },
  ],
} };
const settingsQuery = {
  data: settingsData as SettingsResponse | undefined,
  isPending: false,
  isError: false,
  dataUpdatedAt: Date.parse("2026-07-24T01:00:00Z"),
  refetch: vi.fn(),
};
const trainingBlock = { id: "block-1", storeId: "store-1", titleSnapshot: "研修", startAt: "2026-07-24T10:00:00+09:00", endAt: "2026-07-24T11:00:00+09:00", status: "active" };
const blocksQuery = {
  data: { ok: true, truncated: false, externalBlocks: [trainingBlock] },
  isPending: false,
  isError: false,
  dataUpdatedAt: Date.parse("2026-07-24T01:00:00Z"),
  refetch: vi.fn(),
};

vi.mock("react-router", () => ({
  useLocation: () => routerState.location,
  useNavigate: () => routerState.navigate,
}));

vi.mock("@/hooks/use-stores", () => ({
  useStores: () => ({ selectedStoreId }),
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    isPrivileged: privileged,
    user: signedInAsOwner
      ? { email: "owner@example.test", role: "owner", storeId: null }
      : { email: "staff@example.test", role: "staff", storeId: "store-1" },
  }),
}));

vi.mock("@/hooks/use-media-query", () => ({
  NARROW_QUERY: "(max-width: 639px)",
  useMediaQuery: () => isNarrow,
}));

vi.mock("@/hooks/use-reservations", () => ({
  useReservations: vi.fn((date: string) => date === loadingReservationDate ? { ...reservationsQuery, isPending: true } : reservationsQuery),
  usePendingReservations: () => ({
    data: { ok: true, reservations: pendingReservations },
  }),
  useCreateReservation: () => ({ mutate: createReservation, isPending: false }),
  useAvailableSlots: () => ({ data: { ok: true, slots: [] }, isFetching: false, isError: false }),
}));

vi.mock("@/hooks/use-customers", () => ({
  useCustomerSearch: () => ({ data: { ok: true, customers: [] }, isFetching: false, isError: false }),
}));

vi.mock("@/hooks/use-settings", () => ({
  useSettings: vi.fn(() => settingsQuery),
}));

vi.mock("@/hooks/use-external-blocks", () => ({
  useExternalBlocks: vi.fn(() => blocksQuery),
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
    date,
  }: {
    onCreateBlockClick?: () => void;
    onCreateClick: () => void;
    onViewModeChange: (mode: "day" | "week") => void;
    onMobileViewChange?: (mode: "agenda" | "timeline") => void;
    mobileView?: "agenda" | "timeline";
    onDateChange: (date: Date) => void;
    date: Date;
  }) => (
    <>
      <span data-testid="selected-date">{date.toISOString()}</span>
      <button onClick={onCreateBlockClick} disabled={!onCreateBlockClick}>ブロック作成</button>
      <button onClick={onCreateClick}>予約作成</button>
      <button onClick={() => onViewModeChange("week")}>週表示へ</button>
      {mobileView && <button onClick={() => onMobileViewChange?.("agenda")}>予定一覧へ</button>}
      {mobileView && <button onClick={() => onMobileViewChange?.("timeline")}>時間軸へ</button>}
      <button onClick={() => onDateChange(new Date("2026-07-25T01:00:00Z"))}>翌日へ</button>
      <button onClick={() => onDateChange(new Date())}>今日</button>
    </>
  ),
}));

vi.mock("@/components/schedule/timeline-grid", () => ({
  TimelineGrid: ({ externalBlocks, onBlockClick, onSlotClick, isLoading, onReady }: {
    externalBlocks: Array<{ id: string }>;
    onBlockClick?: (id: string) => void;
    onSlotClick: (resourceId: string, minutes: number) => void;
    isLoading: boolean;
    onReady?: () => void;
  }) => {
    useEffect(() => { if (!isLoading) onReady?.(); }, [isLoading, onReady]);
    return isLoading ? <div role="status">予定を読み込み中</div> : <div data-schedule-scroll="" data-testid="timeline-viewport">
      {externalBlocks.some((block) => block.id === "block-1") && (
        <button disabled={!onBlockClick} onClick={() => onBlockClick?.("block-1")}>既存ブロック</button>
      )}
      <button onClick={() => onSlotClick("resource-2", 690)}>新宿店の空き枠</button>
    </div>;
  },
}));

vi.mock("@/components/schedule/pending-approvals-card", () => ({
  PendingApprovalsCard: ({ onSelect }: { onSelect: (id: string) => void }) => pendingReservations.map((reservation) => (
    <button key={reservation.id} onClick={() => onSelect(reservation.id)}>承認待ちを選択</button>
  )),
}));

vi.mock("@/components/schedule/reservation-detail-panel", () => ({
  ReservationDetailPanel: ({ reservationId, onOpenChart }: {
    reservationId: string | null;
    onOpenChart: (customerId: string, reservationId: string) => void;
  }) => (
    <div>予約詳細: {reservationId ?? "閉じています"}<input aria-label="編集中の詳細メモ" />
      {reservationId && <button onClick={() => onOpenChart("customer-1", reservationId)}>カルテを開く</button>}
    </div>
  ),
}));

vi.mock("@/components/schedule/reservation-create-panel", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/schedule/reservation-create-panel")>();
  return {
    ReservationCreatePanel: (props: Parameters<typeof actual.ReservationCreatePanel>[0]) => renderRealCreatePanel
      ? <actual.ReservationCreatePanel {...props} />
      : <div>予約作成パネル<input aria-label="作成中の顧客名" /></div>,
  };
});

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
  createReservation.mockReset();
  routerState.location.state = null;
  routerState.navigate.mockReset();
  privileged = true;
  signedInAsOwner = false;
  isNarrow = false;
  selectedStoreId = "store-1";
  renderRealCreatePanel = false;
  pendingReservations = [];
  loadingReservationDate = null;
  reservationsQuery.isPending = false;
  reservationsQuery.data = { ok: true, reservations: [] };
  reservationsQuery.isError = false;
  reservationsQuery.refetch = vi.fn();
  reservationsQuery.dataUpdatedAt = Date.parse("2026-07-24T01:00:00Z");
  settingsQuery.data = settingsData;
  settingsQuery.dataUpdatedAt = Date.parse("2026-07-24T01:00:00Z");
  vi.mocked(useSettings).mockClear();
  vi.mocked(useExternalBlocks).mockClear();
  blocksQuery.data = { ok: true, truncated: false, externalBlocks: [trainingBlock] };
  vi.mocked(useReservations).mockClear();
  for (const query of [settingsQuery, blocksQuery]) {
    query.isPending = false;
    query.isError = false;
    query.refetch.mockClear();
  }
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("SchedulePage", () => {
  const savedScheduleContext: ScheduleContext = {
    scope: JSON.stringify(["staff@example.test", "staff", "store-1", "store-1"]),
    date: "2026-08-03T00:30:00.000Z", viewMode: "week", mobileView: "timeline",
    reservationId: "pending-1", mainScroll: 45, scheduleScroll: 625, scheduleScrollLeft: 80,
  };

  it.each(["day", "week"])("承認待ちからカルテを開くと%s表示の日付・詳細・縦横スクロールを元の履歴に保存する", async (viewMode) => {
    const user = userEvent.setup();
    pendingReservations = [{ id: "pending-1", startAt: savedScheduleContext.date, storeId: "store-1" }];
    render(<main id="main-content"><SchedulePage /></main>);
    if (viewMode === "week") await user.click(screen.getByRole("button", { name: "週表示へ" }));
    await user.click(screen.getByRole("button", { name: "承認待ちを選択" }));
    const main = screen.getByRole("main");
    const viewport = main.querySelector<HTMLElement>("[data-schedule-scroll]");
    if (!viewport) throw new Error("カレンダーのスクロール領域がありません");
    main.scrollTop = 45;
    viewport.scrollTop = 625;
    viewport.scrollLeft = 80;

    await user.click(screen.getByRole("button", { name: "カルテを開く" }));

    expect(routerState.navigate).toHaveBeenNthCalledWith(1, ".", { replace: true, state: {
      scheduleContext: { ...savedScheduleContext, viewMode, mobileView: "agenda" },
    } });
    expect(routerState.navigate).toHaveBeenNthCalledWith(2, "/customers?customerId=customer-1&reservationId=pending-1", { state: { fromSchedule: true } });
  });

  it("カルテから時間軸に戻ると読込完了後に日付・詳細・縦横スクロールを復元する", () => {
    routerState.location.state = { scheduleContext: { ...savedScheduleContext, viewMode: "day" } };
    reservationsQuery.isPending = true;
    const { rerender } = render(<main id="main-content"><SchedulePage /></main>);
    expect(screen.getByTestId("selected-date").textContent).toBe(savedScheduleContext.date);
    expect(screen.getByText("予約詳細: pending-1")).toBeTruthy();
    expect(screen.getByRole("main").scrollTop).toBe(0);
    expect(screen.queryByTestId("timeline-viewport")).toBeNull();
    expect(routerState.navigate).toHaveBeenCalledExactlyOnceWith(".", { replace: true, state: null });

    reservationsQuery.isPending = false;
    rerender(<main id="main-content"><SchedulePage /></main>);

    expect(screen.getByRole("main").scrollTop).toBe(45);
    expect(screen.getByTestId("timeline-viewport").scrollTop).toBe(625);
    expect(screen.getByTestId("timeline-viewport").scrollLeft).toBe(80);
  });

  it("週表示への復帰は最後の曜日の読込完了を待ってスクロールを復元する", () => {
    routerState.location.state = { scheduleContext: savedScheduleContext };
    loadingReservationDate = "2026-08-08";
    const { rerender } = render(<main id="main-content"><SchedulePage /></main>);
    const main = screen.getByRole("main");
    const scroller = main.querySelector<HTMLElement>("[data-schedule-scroll]");
    if (!scroller) throw new Error("週表示のスクロール領域がありません");
    expect(screen.getAllByRole("button", { name: /の日表示を開く/ })).toHaveLength(7);
    expect(screen.getByText("予約詳細: pending-1")).toBeTruthy();
    expect(main.scrollTop).toBe(0);
    expect(scroller.scrollLeft).toBe(0);

    loadingReservationDate = null;
    rerender(<main id="main-content"><SchedulePage /></main>);

    expect(main.scrollTop).toBe(45);
    expect(scroller.scrollTop).toBe(625);
    expect(scroller.scrollLeft).toBe(80);
  });

  it("狭幅の一覧に戻ると読込後に本文スクロールを一度だけ復元し、広幅では元の週表示へ戻る", () => {
    isNarrow = true;
    routerState.location.state = { scheduleContext: { ...savedScheduleContext, mobileView: "agenda", mainScroll: 180 } };
    settingsQuery.isPending = true;
    const { rerender } = render(<main id="main-content"><SchedulePage /></main>);
    const main = screen.getByRole("main");
    expect(main.scrollTop).toBe(0);

    settingsQuery.isPending = false;
    rerender(<main id="main-content"><SchedulePage /></main>);
    expect(main.scrollTop).toBe(180);
    expect(screen.getByRole("heading", { name: /8月3日.*渋谷店/ })).toBeTruthy();
    expect(screen.queryByTestId("timeline-viewport")).toBeNull();
    main.scrollTop = 70;
    settingsQuery.isPending = true;
    rerender(<main id="main-content"><SchedulePage /></main>);
    settingsQuery.isPending = false;
    rerender(<main id="main-content"><SchedulePage /></main>);
    expect(main.scrollTop).toBe(70);
    isNarrow = false;
    rerender(<main id="main-content"><SchedulePage /></main>);
    expect(screen.getAllByRole("button", { name: /の日表示を開く/ })).toHaveLength(7);
    expect(screen.getByText("予約詳細: pending-1")).toBeTruthy();
  });

  it.each([
    { label: "別ログイン", scope: JSON.stringify(["other@example.test", "staff", "store-1", "store-1"]) },
    { label: "別店舗", scope: JSON.stringify(["staff@example.test", "staff", "store-1", "store-2"]) },
  ])("$labelの履歴から予約詳細やカレンダー位置を復元しない", ({ scope }) => {
    routerState.location.state = { scheduleContext: { ...savedScheduleContext, scope } };
    render(<main id="main-content"><SchedulePage /></main>);

    expect(screen.getByTestId("selected-date").textContent).toBe("2026-07-24T01:00:00.000Z");
    expect(screen.getByText("予約詳細: 閉じています")).toBeTruthy();
    expect(screen.getByRole("main").scrollTop).toBe(0);
    expect(screen.getByTestId("timeline-viewport").scrollTop).toBe(0);
    expect(routerState.navigate).not.toHaveBeenCalled();
  });

  it("別日の承認待ちを選ぶとその日の予約詳細を開く", async () => {
    pendingReservations = [{ id: "pending-1", startAt: "2026-08-03T00:30:00Z", storeId: "store-1" }];
    render(<SchedulePage />);
    await userEvent.setup().click(screen.getByRole("button", { name: "承認待ちを選択" }));
    expect(useReservations).toHaveBeenLastCalledWith("2026-08-03");
    expect(screen.getByText(/予約詳細: pending-1/)).toBeTruthy();
  });
  it("表示日の変更を外部ブロックの取得範囲にも反映する", async () => {
    render(<SchedulePage />);
    expect(useExternalBlocks).toHaveBeenLastCalledWith("2026-07-24");
    await userEvent.setup().click(screen.getByRole("button", { name: "翌日へ" }));
    expect(useExternalBlocks).toHaveBeenLastCalledWith("2026-07-25");
  });

  it("外部ブロックが上限を超えた場合は日表示で空き状況の警告を出す", async () => {
    blocksQuery.data.truncated = true;
    const { rerender } = render(<SchedulePage />);
    expect(screen.getByRole("alert").textContent).toContain("空き状況を正確に確認できません");
    blocksQuery.data.truncated = false;
    rerender(<SchedulePage />);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("F32: 今日の予定を表示したままJSTの午前0時を越えると翌日へ進む", () => {
    isNarrow = true;
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    vi.setSystemTime(new Date("2026-07-24T14:59:50Z"));
    render(<SchedulePage />);
    expect(screen.getByRole("heading", { name: /7月24日.*渋谷店/ })).toBeTruthy();

    act(() => { vi.advanceTimersByTime(30_000); });

    expect(screen.getByRole("heading", { name: /7月25日.*渋谷店/ })).toBeTruthy();
    expect(useReservations).toHaveBeenLastCalledWith("2026-07-25");
  });

  it("F32: 背景で複数日を越えても画面復帰時に今日へ進む", () => {
    isNarrow = true;
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    render(<SchedulePage />);

    vi.setSystemTime(new Date("2026-07-27T15:00:00Z"));
    act(() => { document.dispatchEvent(new Event("visibilitychange")); });

    expect(screen.getByRole("heading", { name: /7月28日.*渋谷店/ })).toBeTruthy();
    expect(useReservations).toHaveBeenLastCalledWith("2026-07-28");
  });

  it("F32: 手動で選んだ翌日は今日になった後も保持し、今日ボタンで追従を再開する", async () => {
    isNarrow = true;
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    render(<SchedulePage />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "翌日へ" }));

    for (const now of ["2026-07-25T01:00:00Z", "2026-07-26T01:00:00Z"]) {
      vi.setSystemTime(new Date(now));
      act(() => { vi.advanceTimersByTime(30_000); });
      expect(screen.getByRole("heading", { name: /7月25日.*渋谷店/ })).toBeTruthy();
      expect(useReservations).toHaveBeenLastCalledWith("2026-07-25");
    }

    await user.click(screen.getByRole("button", { name: "今日" }));
    vi.setSystemTime(new Date("2026-07-26T15:00:00Z"));
    act(() => { vi.advanceTimersByTime(30_000); });
    expect(screen.getByRole("heading", { name: /7月27日.*渋谷店/ })).toBeTruthy();
    expect(useReservations).toHaveBeenLastCalledWith("2026-07-27");
  });

  it("F32: 週表示で手動選択した日も画面復帰時に保持する", async () => {
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    render(<SchedulePage />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "週表示へ" }));
    await user.click(screen.getByRole("button", { name: "2026年7月25日 (土)の日表示を開く" }));

    vi.setSystemTime(new Date("2026-07-28T01:00:00Z"));
    act(() => { document.dispatchEvent(new Event("visibilitychange")); });

    expect(useReservations).toHaveBeenLastCalledWith("2026-07-25");
  });

  it("F5: 全店舗の空き枠から店舗を選択した予約作成を開き、リソースの欄は出さずその店舗の枠で送る", async () => {
    selectedStoreId = null;
    signedInAsOwner = true;
    renderRealCreatePanel = true;
    settingsQuery.data = {
      ...settingsData,
      settings: {
        ...settingsData.settings,
        services: [{
          id: "service-9", storeId: "store-2", name: "新宿メニュー", durationMinutes: 30,
          priceLabel: null, priceAmount: null, comboPriceAmount: null, comboWithPrefix: null,
          active: true, mensMenu: false,
        }],
      },
    };
    render(<SchedulePage />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "新宿店の空き枠" }));

    expect(screen.getByRole("combobox", { name: "店舗" }).textContent).toBe("新宿店");
    expect(screen.queryByRole("combobox", { name: "リソース" })).toBeNull();
    expect((screen.getByLabelText("時間") as HTMLInputElement).value).toBe("11:30");

    await user.click(screen.getByRole("checkbox", { name: /新宿メニュー/ }));
    await user.click(screen.getByRole("tab", { name: "新規のお客様" }));
    await user.type(screen.getByLabelText("氏名"), "新規 太郎");
    await user.type(screen.getByLabelText("カナ"), "シンキ タロウ");
    await user.type(screen.getByLabelText("電話番号"), "090-1111-2222");
    await user.click(screen.getAllByRole("button", { name: "予約作成" }).at(-1)!);
    // このファイルでは確認ダイアログを差し替えてあり、確定ボタンは「取消を確定」になる。
    await user.click(screen.getByRole("button", { name: "取消を確定" }));

    expect(createReservation).toHaveBeenCalledWith(
      expect.objectContaining({ storeId: "store-2", resourceId: "resource-2" }),
      expect.anything(),
    );
  });

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
    expect(cards[0].textContent).toContain("渋谷店");
    expect(cards[0].textContent).not.toContain("担当 佐藤");
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

  it("ブロック取消の確認中にJSTの午前0時を越えても、開いたブロックを示したまま取り消す", () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    vi.setSystemTime(new Date("2026-07-24T14:59:50Z"));
    render(<SchedulePage />);
    fireEvent.click(screen.getByRole("button", { name: "既存ブロック" }));
    expect(screen.getByText(/研修/)).toBeTruthy();

    // The schedule follows the new day, whose block list no longer contains block-1.
    blocksQuery.data = { ...blocksQuery.data, externalBlocks: [] };
    act(() => { vi.advanceTimersByTime(30_000); });
    expect(screen.queryByRole("button", { name: "既存ブロック" })).toBeNull();

    expect(screen.getByText(/研修/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "取消を確定" }));
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
