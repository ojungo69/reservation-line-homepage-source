import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api-client";

const mocks = vi.hoisted(() => ({
  action: { mutateAsync: vi.fn() },
  queryClient: { invalidateQueries: vi.fn(() => Promise.resolve()) },
  post: vi.fn(),
  hasData: true,
  query: { isPending: false, isError: false, refetch: vi.fn() },
  reservations: [] as Array<{
    id: string;
    storeId: string;
    storeName: string;
    serviceNames: string;
    startAt: string;
    customerDisplayName: string;
    lineFriendStatus: string;
    version: number;
    createdAt?: string | null;
    pendingExpiresAt?: string | null;
  }>,
}));

vi.mock("@/hooks/use-reservations", () => ({
  usePendingReservations: () => ({ ...mocks.query, data: mocks.hasData ? { ok: true, reservations: mocks.reservations } : undefined }),
  useReservationAction: () => mocks.action,
}));

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => mocks.queryClient,
}));

vi.mock("@/lib/api-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api-client")>()),
  api: { post: mocks.post },
}));

import { PendingApprovalsCard } from "./pending-approvals-card";

const reservation = (id: string, storeId: string, customerDisplayName: string, version: number) => ({
  id,
  storeId,
  storeName: storeId === "store-1" ? "新宿店" : "渋谷店",
  serviceNames: "全身脱毛",
  startAt: id === "reservation-1" ? "2026-07-24T10:00:00+09:00" : "2026-07-24T11:00:00+09:00",
  customerDisplayName,
  lineFriendStatus: "friend",
  version,
});

const renderCard = (selectedStoreId: string | null = null, onSelect = vi.fn()) => {
  render(
    <MemoryRouter>
      <PendingApprovalsCard selectedStoreId={selectedStoreId} onSelect={onSelect} />
    </MemoryRouter>,
  );
  return onSelect;
};

beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-14T00:00:00Z"));
  mocks.reservations = [];
  mocks.hasData = true;
  mocks.query.isPending = false;
  mocks.query.isError = false;
  mocks.query.refetch.mockClear();
  mocks.action.mutateAsync.mockReset();
  mocks.action.mutateAsync.mockResolvedValue({ ok: true });
  mocks.queryClient.invalidateQueries.mockClear();
  mocks.post.mockReset();
});

afterEach(() => vi.restoreAllMocks());

describe("PendingApprovalsCard", () => {
  it("単件失敗後の一括再試行は対象の古い案内だけを消し、他店舗の案内を保持する", async () => {
    const user = userEvent.setup();
    mocks.reservations = [reservation("reservation-1", "store-1", "申込 花子", 3), reservation("reservation-2", "store-1", "申込 太郎", 4), reservation("reservation-3", "store-2", "申込 次郎", 5)];
    mocks.action.mutateAsync.mockRejectedValue(new ApiError(409, { reason: "invalid_transition" }));
    mocks.post.mockResolvedValue({ ok: true });
    const { rerender } = render(<MemoryRouter><PendingApprovalsCard selectedStoreId={null} onSelect={() => {}} /></MemoryRouter>);
    for (const name of ["申込 花子", "申込 次郎"]) {
      await user.click(within(screen.getByText(name).closest("li") as HTMLElement).getByRole("button", { name: "承認" }));
      await user.click(screen.getByRole("button", { name: "承認する" }));
    }
    expect(screen.getAllByRole("alert")).toHaveLength(2);
    rerender(<MemoryRouter><PendingApprovalsCard selectedStoreId="store-1" onSelect={() => {}} /></MemoryRouter>);
    await user.click(screen.getByRole("button", { name: "表示中の2件をまとめて承認" }));
    await user.click(screen.getByRole("button", { name: "2 件を承認する" }));
    expect(await screen.findByText("成功 2 件 / 失敗 0 件")).toBeTruthy();
    await user.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "閉じる" }));
    const results = within(screen.getByRole("list", { name: "承認できなかった予約" }));
    expect(results.getAllByRole("listitem")).toHaveLength(1);
    expect(results.getByRole("listitem").textContent).toContain("申込 次郎");
    expect(results.queryByText(/申込 花子/)).toBeNull();
  });

  it("複数の単件承認を並行送信し、一覧欠落後も各予約の失敗案内を保持する", async () => {
    const user = userEvent.setup();
    mocks.reservations = [reservation("reservation-1", "store-1", "申込 花子", 3), reservation("reservation-2", "store-1", "申込 太郎", 4)];
    const failActions: Array<(error: unknown) => void> = [];
    mocks.action.mutateAsync.mockImplementation(() => new Promise((_resolve, reject) => { failActions.push(reject); }));
    const { rerender } = render(<MemoryRouter><PendingApprovalsCard selectedStoreId={null} onSelect={() => {}} /></MemoryRouter>);
    await user.click(screen.getAllByRole("button", { name: "承認" })[0]);
    await user.click(screen.getByRole("button", { name: "承認する" }));
    await user.click(screen.getByRole("button", { name: "承認" }));
    await user.click(screen.getByRole("button", { name: "承認する" }));
    expect(mocks.action.mutateAsync).toHaveBeenCalledTimes(2);
    await act(async () => { failActions[0](new ApiError(409, { reason: "invalid_transition" })); });
    const firstRow = within(screen.getByText("申込 花子").closest("li") as HTMLElement);
    const secondRow = within(screen.getByText("申込 太郎").closest("li") as HTMLElement);
    expect(firstRow.getByRole("button", { name: "承認" })).toHaveProperty("disabled", false);
    expect(secondRow.getByRole("button", { name: "処理中…" })).toHaveProperty("disabled", true);
    mocks.reservations = [];
    rerender(<MemoryRouter><PendingApprovalsCard selectedStoreId={null} onSelect={() => {}} /></MemoryRouter>);
    await act(async () => { failActions[1](new ApiError(409, { reason: "invalid_transition" })); });
    const results = within(screen.getByRole("list", { name: "承認できなかった予約" }));
    expect(results.getAllByRole("alert")).toHaveLength(2);
    expect(results.getAllByRole("listitem")[0].textContent).toContain("申込 花子");
    expect(results.getAllByRole("listitem")[1].textContent).toContain("申込 太郎");
  });

  it("一覧欠落後の単件409でも承認の具体案内をカードに残す", async () => {
    const user = userEvent.setup();
    mocks.reservations = [{ ...reservation("reservation-1", "store-1", "申込 花子", 3), pendingExpiresAt: "2026-10-14T01:00:00Z" }];
    let failApproval: ((error: unknown) => void) | undefined;
    mocks.action.mutateAsync.mockImplementation(() => new Promise((_resolve, reject) => { failApproval = reject; }));
    const { rerender } = render(<MemoryRouter><PendingApprovalsCard selectedStoreId={null} onSelect={() => {}} /></MemoryRouter>);
    await user.click(screen.getByRole("button", { name: "承認" }));
    mocks.reservations = [];
    rerender(<MemoryRouter><PendingApprovalsCard selectedStoreId={null} onSelect={() => {}} /></MemoryRouter>);
    await user.click(screen.getByRole("button", { name: "承認する" }));
    await act(async () => { failApproval?.(new ApiError(409, { reason: "invalid_transition" })); });
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("承認できません。LINEの友だち状態・承認期限・予約状態を再確認してください。");
    expect(alert.closest("li")?.textContent).toContain("申込 花子");
    mocks.reservations = [];
    rerender(<MemoryRouter><PendingApprovalsCard selectedStoreId={null} onSelect={() => {}} /></MemoryRouter>);
    expect(screen.getByRole("alert").textContent).toContain("LINEの友だち状態・承認期限・予約状態を再確認してください");
    await user.click(screen.getByRole("button", { name: "申込 花子様の承認エラーを閉じる" }));
    expect(screen.queryByRole("region", { name: "承認待ちの予約" })).toBeNull();
  });

  it.each(["blocked", "not_friend", "unknown"])("表示用LINE状態%sで予約自身の承認を禁止しない", async (status) => {
    const user = userEvent.setup();
    // lineFriendStatus は顧客の最新identityの表示値。承認先の予約自身identityとは異なる。
    mocks.reservations = [{ ...reservation("reservation-1", "store-1", "申込 花子", 3), lineFriendStatus: status }];
    renderCard();
    expect(screen.getByRole("button", { name: "承認" })).toHaveProperty("disabled", false);
    await user.click(screen.getByRole("button", { name: "承認" }));
    await user.click(screen.getByRole("button", { name: "承認する" }));
    expect(mocks.action.mutateAsync).toHaveBeenCalledWith({ reservationId: "reservation-1", action: "approve", reason: undefined });
  });

  it("単件承認のinvalid_transitionでは対象予約と一緒に承認の確認点を残す", async () => {
    const user = userEvent.setup();
    mocks.reservations = [reservation("reservation-1", "store-1", "申込 花子", 3)];
    mocks.action.mutateAsync.mockRejectedValue(new ApiError(409, { reason: "invalid_transition" }));
    renderCard();
    await user.click(screen.getByRole("button", { name: "承認" }));
    await user.click(screen.getByRole("button", { name: "承認する" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("承認できません。LINEの友だち状態・承認期限・予約状態を再確認してください。");
    expect(alert.closest("li")?.textContent).toContain("申込 花子");
  });

  it.each(["deadline", "missing"] as const)("一括実行の待機中は%sの期限を再確認し、一覧欠落だけで送信を禁止しない", async (change) => {
    const user = userEvent.setup();
    mocks.reservations = [
      { ...reservation("reservation-1", "store-1", "先行 花子", 3), pendingExpiresAt: "2026-10-14T00:00:00.500Z" },
      { ...reservation("reservation-2", "store-1", "待機 太郎", 4), pendingExpiresAt: "2026-10-14T00:00:01Z" },
    ];
    let finishFirst: (() => void) | undefined;
    mocks.post.mockImplementationOnce(() => new Promise((resolve) => { finishFirst = () => resolve({ ok: true }); }));
    mocks.post.mockResolvedValue({ ok: true });
    const { rerender } = render(<MemoryRouter><PendingApprovalsCard selectedStoreId={null} onSelect={() => {}} /></MemoryRouter>);
    await user.click(screen.getByRole("button", { name: /まとめて承認/ }));
    await user.click(screen.getByRole("button", { name: "2 件を承認する" }));
    if (change === "deadline") vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-14T00:00:01Z"));
    else mocks.reservations = [mocks.reservations[0]];
    rerender(<MemoryRouter><PendingApprovalsCard selectedStoreId={null} onSelect={() => {}} /></MemoryRouter>);
    await act(async () => { finishFirst?.(); });
    expect(await screen.findByText(change === "deadline" ? "成功 1 件 / 失敗 1 件" : "成功 2 件 / 失敗 0 件")).toBeTruthy();
    expect(mocks.post).toHaveBeenCalledTimes(change === "deadline" ? 1 : 2);
    if (change === "deadline") expect(screen.getByText(/LINEの友だち状態・承認期限・予約状態を再確認してください/)).toBeTruthy();
  });

  it("一括承認でサーバーがinvalid_transitionを返した場合に承認の確認点を伝える", async () => {
    const user = userEvent.setup();
    mocks.reservations = [reservation("reservation-1", "store-1", "申込 花子", 3), reservation("reservation-2", "store-1", "申込 太郎", 4)];
    mocks.post.mockRejectedValueOnce(new ApiError(409, { reason: "invalid_transition" })).mockResolvedValueOnce({ ok: true });
    renderCard();
    await user.click(screen.getByRole("button", { name: /まとめて承認/ }));
    await user.click(screen.getByRole("button", { name: "2 件を承認する" }));
    expect(await screen.findByText("成功 1 件 / 失敗 1 件")).toBeTruthy();
    expect(screen.getByText(/LINEの友だち状態・承認期限・予約状態を再確認してください/)).toBeTruthy();
  });

  it.each(["single", "bulk"] as const)("%s確認中の一覧欠落では期限内のsnapshotを承認でき、新着を確認対象に加えない", async (mode) => {
    const user = userEvent.setup();
    mocks.reservations = [
      reservation("reservation-1", "store-1", "確認済み 花子", 3),
      reservation("reservation-2", "store-1", "確認済み 太郎", 4),
    ];
    const { rerender } = render(<MemoryRouter><PendingApprovalsCard selectedStoreId={null} onSelect={() => {}} /></MemoryRouter>);
    await user.click(mode === "single"
      ? screen.getAllByRole("button", { name: "承認" })[0]
      : screen.getByRole("button", { name: /まとめて承認/ }));
    mocks.reservations = [
      reservation("reservation-3", "store-1", "未確認の新着 次郎", 5),
    ];
    mocks.post.mockResolvedValue({ ok: true });
    rerender(<MemoryRouter><PendingApprovalsCard selectedStoreId={null} onSelect={() => {}} /></MemoryRouter>);
    const dialog = within(screen.getByRole("alertdialog"));
    const confirm = dialog.getByRole("button", { name: mode === "single" ? "承認する" : "2 件を承認する" });
    expect(confirm).toHaveProperty("disabled", false);
    expect(dialog.queryByText("未確認の新着 次郎 様")).toBeNull();
    await user.click(confirm);
    if (mode === "single") {
      expect(mocks.action.mutateAsync).toHaveBeenCalledWith({ reservationId: "reservation-1", action: "approve", reason: undefined });
    } else {
      expect(await screen.findByText("成功 2 件 / 失敗 0 件")).toBeTruthy();
      expect(mocks.post).toHaveBeenCalledTimes(2);
      expect(mocks.post).toHaveBeenCalledWith("/api/admin/reservations/reservation-1/approve", expect.objectContaining({ expectedVersion: 3 }));
      expect(mocks.post).toHaveBeenCalledWith("/api/admin/reservations/reservation-2/approve", expect.objectContaining({ expectedVersion: 4 }));
    }
  });

  it.each(["single", "bulk"] as const)("%s確認中に一覧が空になってもsnapshotの期限到達を理由付きで無効にする", async (mode) => {
    vi.restoreAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-14T00:00:00Z"));
    try {
      mocks.reservations = [
        { ...reservation("reservation-1", "store-1", "期限間近 花子", 3), pendingExpiresAt: "2026-10-14T00:00:01Z" },
        { ...reservation("reservation-2", "store-1", "期限間近 太郎", 4), pendingExpiresAt: "2026-10-14T00:00:01Z" },
      ];
      const { rerender } = render(<MemoryRouter><PendingApprovalsCard selectedStoreId={null} onSelect={() => {}} /></MemoryRouter>);
      fireEvent.click(mode === "single" ? screen.getAllByRole("button", { name: "承認" })[0] : screen.getByRole("button", { name: /まとめて承認/ }));
      mocks.reservations = [];
      rerender(<MemoryRouter><PendingApprovalsCard selectedStoreId={null} onSelect={() => {}} /></MemoryRouter>);
      expect(within(screen.getByRole("alertdialog")).getByRole("button", { name: mode === "single" ? "承認する" : "2 件を承認する" })).toHaveProperty("disabled", false);
      await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
      const dialog = within(screen.getByRole("alertdialog"));
      const confirm = dialog.getByRole("button", { name: mode === "single" ? "承認する" : "0 件を承認する" });
      expect(confirm).toHaveProperty("disabled", true);
      expect(dialog.getAllByText("承認期限が過ぎています。却下をご利用ください。").length).toBeGreaterThan(0);
      fireEvent.click(confirm);
      expect(mocks.action.mutateAsync).not.toHaveBeenCalled();
      expect(mocks.post).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(["single", "bulk"] as const)("%s確認中に期限に達した時点で承認を無効にする", async (mode) => {
    vi.restoreAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-14T00:00:00Z"));
    try {
      mocks.reservations = [
        { ...reservation("reservation-1", "store-1", "期限間近 花子", 3), pendingExpiresAt: "2026-10-14T00:00:01Z" },
        { ...reservation("reservation-2", "store-1", "期限間近 太郎", 4), pendingExpiresAt: "2026-10-14T00:00:01Z" },
      ];
      renderCard();
      fireEvent.click(mode === "single"
        ? screen.getAllByRole("button", { name: "承認" })[0]
        : screen.getByRole("button", { name: /まとめて承認/ }));
      await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
      const dialog = within(screen.getByRole("alertdialog"));
      const confirm = dialog.getByRole("button", { name: mode === "single" ? "承認する" : "0 件を承認する" });
      expect(confirm).toHaveProperty("disabled", true);
      expect(dialog.getAllByText("承認期限が過ぎています。却下をご利用ください。").length).toBeGreaterThan(0);
      fireEvent.click(confirm);
      expect(mocks.action.mutateAsync).not.toHaveBeenCalled();
      expect(mocks.post).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("一括承認の確認は期限切れを別に表示し、表示用LINE状態で対象を除外しない", async () => {
    const user = userEvent.setup();
    mocks.reservations = [
      { ...reservation("reservation-1", "store-1", "承認対象 花子", 3), pendingExpiresAt: "2026-10-14T01:00:00Z" },
      { ...reservation("reservation-2", "store-1", "未友だち 太郎", 4), lineFriendStatus: "not_friend" },
      { ...reservation("reservation-3", "store-1", "期限切れ 次郎", 5), pendingExpiresAt: "2026-10-14T00:00:00Z" },
    ];
    mocks.post.mockResolvedValue({ ok: true });
    renderCard();
    await user.click(screen.getByRole("button", { name: /まとめて承認/ }));
    const dialog = within(screen.getByRole("alertdialog"));
    const included = dialog.getByRole("list", { name: "承認対象" });
    expect(included.textContent).toContain("承認対象 花子");
    expect(included.textContent).toContain("未友だち 太郎");
    const excluded = dialog.getByRole("list", { name: "承認対象外" });
    expect(excluded.textContent).not.toContain("未友だち 太郎");
    expect(excluded.textContent).toContain("期限切れ 次郎");
    expect(excluded.textContent).toContain("承認期限が過ぎています。却下をご利用ください。");
    await user.click(dialog.getByRole("button", { name: "2 件を承認する" }));
    expect(await screen.findByText("成功 2 件 / 失敗 0 件")).toBeTruthy();
    expect(mocks.post).toHaveBeenCalledTimes(2);
    expect(mocks.post).toHaveBeenCalledWith("/api/admin/reservations/reservation-1/approve", expect.objectContaining({ expectedVersion: 3 }));
    expect(mocks.post).toHaveBeenCalledWith("/api/admin/reservations/reservation-2/approve", expect.objectContaining({ expectedVersion: 4 }));
  });

  it.each([
    { status: "friend", deadline: "2026-10-13T23:59:59Z", reason: "承認期限が過ぎています。却下をご利用ください。" },
    { status: "friend", deadline: "2026-10-14T00:00:00Z", reason: "承認期限が過ぎています。却下をご利用ください。" },
  ])("$status・期限$deadlineの承認を理由付きで無効にし、却下は送信できる", async ({ status, deadline, reason }) => {
    const user = userEvent.setup();
    mocks.reservations = [{ ...reservation("reservation-1", "store-1", "申込 花子", 1), lineFriendStatus: status, pendingExpiresAt: deadline }];
    renderCard();

    expect(screen.getByRole("button", { name: "承認" })).toHaveProperty("disabled", true);
    expect(screen.getByText(reason)).toBeTruthy();
    expect(screen.getByRole("button", { name: "却下" })).toHaveProperty("disabled", false);
    await user.click(screen.getByRole("button", { name: "却下" }));
    await user.click(screen.getByRole("button", { name: "却下する" }));
    expect(mocks.action.mutateAsync).toHaveBeenCalledWith({ reservationId: "reservation-1", action: "reject", reason: undefined });
  });

  it.each([
    { action: "承認", confirm: "承認する", flag: "isError" as const },
    { action: "却下", confirm: "却下する", flag: "isError" as const },
    { action: "承認", confirm: "承認する", flag: "isPending" as const },
    { action: "却下", confirm: "却下する", flag: "isPending" as const },
  ])("$action確認を開いた後の$flagで送信を止め、復旧後に同じ確認から再開できる", async ({ action, confirm, flag }) => {
    const user = userEvent.setup();
    mocks.reservations = [reservation("reservation-1", "store-1", "予約 花子", 3)];
    const { rerender } = render(<MemoryRouter><PendingApprovalsCard selectedStoreId={null} onSelect={() => {}} /></MemoryRouter>);
    await user.click(screen.getByRole("button", { name: action }));
    if (action === "却下") await user.type(screen.getByLabelText("却下理由（任意・お客様に通知されます）"), "予定を調整します");
    mocks.query[flag] = true;
    rerender(<MemoryRouter><PendingApprovalsCard selectedStoreId={null} onSelect={() => {}} /></MemoryRouter>);
    expect((screen.getByRole("button", { name: confirm }) as HTMLButtonElement).disabled).toBe(true);
    await user.click(screen.getByRole("button", { name: confirm }));
    expect(mocks.action.mutateAsync).not.toHaveBeenCalled();
    expect(screen.getByRole("alertdialog").textContent).toContain("再取得が完了するまで操作できません");
    mocks.query[flag] = false;
    rerender(<MemoryRouter><PendingApprovalsCard selectedStoreId={null} onSelect={() => {}} /></MemoryRouter>);
    if (action === "却下") expect((screen.getByLabelText("却下理由（任意・お客様に通知されます）") as HTMLTextAreaElement).value).toBe("予定を調整します");
    await user.click(screen.getByRole("button", { name: confirm }));
    expect(mocks.action.mutateAsync).toHaveBeenCalledTimes(1);
  });

  it.each(["isError", "isPending"] as const)("一括確認後の%sでも新しい承認batchを開始しない", async (flag) => {
    const user = userEvent.setup();
    mocks.reservations = [reservation("reservation-1", "store-1", "予約 花子", 3), reservation("reservation-2", "store-1", "予約 太郎", 4)];
    const { rerender } = render(<MemoryRouter><PendingApprovalsCard selectedStoreId={null} onSelect={() => {}} /></MemoryRouter>);
    await user.click(screen.getByRole("button", { name: "表示中の2件をまとめて承認" }));
    mocks.query[flag] = true;
    rerender(<MemoryRouter><PendingApprovalsCard selectedStoreId={null} onSelect={() => {}} /></MemoryRouter>);
    expect((screen.getByRole("button", { name: "2 件を承認する" }) as HTMLButtonElement).disabled).toBe(true);
    await user.click(screen.getByRole("button", { name: "2 件を承認する" }));
    expect(mocks.post).not.toHaveBeenCalled();
  });
  it.each([
    { name: "古いWorker", metadata: {}, expected: "—" },
    { name: "期限なし", metadata: { createdAt: null, pendingExpiresAt: null }, expected: "期限なし" },
  ])("$nameの日時を架空の期限に変えずに表示する", ({ metadata, expected }) => {
    mocks.reservations = [{ ...reservation("reservation-1", "store-1", "予約 花子", 1), ...metadata }];
    renderCard();
    expect(screen.getByText(/受付:/).textContent).toContain(`受付: — · 承認期限: ${expected}`);
  });
  it("承認待ちの取得失敗を0件と扱わず、再読み込みを提供する", async () => {
    mocks.hasData = false;
    mocks.query.isError = true;
    renderCard();
    expect(screen.getByRole("alert").textContent).toContain("承認待ちの読み込みに失敗");
    await userEvent.setup().click(screen.getByRole("button", { name: "承認待ちを再読み込み" }));
    expect(mocks.query.refetch).toHaveBeenCalled();
  });

  it("取得中は0件として消さず、更新失敗では前回の予約と編集状態を保持する", () => {
    mocks.hasData = false;
    mocks.query.isPending = true;
    const { rerender } = render(<MemoryRouter><PendingApprovalsCard selectedStoreId={null} onSelect={() => {}} /></MemoryRouter>);
    expect(screen.getByRole("status").textContent).toContain("承認待ちを読み込み中");
    mocks.hasData = true;
    mocks.query.isPending = false;
    mocks.query.isError = true;
    mocks.reservations = [reservation("reservation-1", "store-1", "前回の予約", 1)];
    rerender(<MemoryRouter><PendingApprovalsCard selectedStoreId={null} onSelect={() => {}} /></MemoryRouter>);
    expect(screen.getByRole("alert").textContent).toContain("更新に失敗");
    expect(screen.getByText("前回の予約")).toBeTruthy();
    expect((screen.getByRole("button", { name: "承認" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("予約日順でなく承認期限順に並べ、受付と期限をJSTで表示する", () => {
    mocks.reservations = [
      { ...reservation("reservation-1", "store-1", "明日の申込", 1), createdAt: "2026-09-29T01:00:00Z", pendingExpiresAt: "2026-09-30T01:00:00Z" },
      { ...reservation("reservation-2", "store-1", "先に期限が来る申込", 1), createdAt: "2026-09-28T03:00:00Z", pendingExpiresAt: "2026-09-29T03:00:00Z" },
    ];
    renderCard();
    const rows = screen.getAllByRole("listitem");
    expect(rows[0].textContent).toContain("先に期限が来る申込");
    expect(rows[0].textContent).toContain("受付: 9/28 12:00");
    expect(rows[0].textContent).toContain("承認期限: 9/29 12:00");
  });
  it("承認待ちがなければ表示せず、選択店舗の予約だけを表示する", async () => {
    const { rerender } = render(
      <MemoryRouter>
        <PendingApprovalsCard selectedStoreId={null} onSelect={() => {}} />
      </MemoryRouter>,
    );
    expect(screen.queryByRole("region", { name: "承認待ちの予約" })).toBeNull();

    mocks.reservations = [
      reservation("reservation-1", "store-1", "予約 花子", 3),
      reservation("reservation-2", "store-2", "予約 太郎", 4),
    ];
    const onSelect = vi.fn();
    rerender(
      <MemoryRouter>
        <PendingApprovalsCard selectedStoreId="store-1" onSelect={onSelect} />
      </MemoryRouter>,
    );

    expect(screen.getByText("予約 花子")).toBeTruthy();
    expect(screen.queryByText("予約 太郎")).toBeNull();
    expect(screen.queryByText("· 新宿店")).toBeNull();
    await userEvent.setup().click(screen.getByRole("button", { name: /予約 花子/ }));
    expect(onSelect).toHaveBeenCalledWith("reservation-1");
  });

  it("承認と却下を確認ダイアログから実行し、送信中はその行を無効化する", async () => {
    const user = userEvent.setup();
    mocks.reservations = [reservation("reservation-1", "store-1", "予約 花子", 3)];
    let settleAction: (() => void) | undefined;
    mocks.action.mutateAsync.mockImplementation(
      () => new Promise((resolve) => { settleAction = () => resolve({ ok: true }); }),
    );
    renderCard();

    await user.click(screen.getByRole("button", { name: "承認" }));
    expect(screen.getByRole("heading", { name: "予約を承認しますか?" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "承認する" }));
    expect(mocks.action.mutateAsync).toHaveBeenCalledWith({ reservationId: "reservation-1", action: "approve", reason: undefined });
    expect((screen.getByRole("button", { name: "処理中…" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "却下" }) as HTMLButtonElement).disabled).toBe(true);
    settleAction?.();
    expect(await screen.findByRole("button", { name: "承認" })).toBeTruthy();

    mocks.action.mutateAsync.mockResolvedValue({ ok: true });
    await user.click(screen.getByRole("button", { name: "却下" }));
    await user.type(screen.getByLabelText("却下理由（任意・お客様に通知されます）"), "予定変更のため");
    await user.click(screen.getByRole("button", { name: "却下する" }));
    expect(mocks.action.mutateAsync).toHaveBeenLastCalledWith({
      reservationId: "reservation-1",
      action: "reject",
      reason: "予定変更のため",
    });
  });

  it("一括承認の結果で失敗した予約と理由を表示する", async () => {
    const user = userEvent.setup();
    mocks.reservations = [
      reservation("reservation-1", "store-1", "予約 花子", 3),
      reservation("reservation-2", "store-2", "予約 太郎", 4),
    ];
    mocks.post
      .mockResolvedValueOnce({ ok: true })
      .mockRejectedValueOnce(new Error("枠が埋まりました"));
    renderCard();

    await user.click(screen.getByRole("button", { name: "表示中の2件をまとめて承認" }));
    expect(screen.getByText("表示中の承認待ち 2 件をすべて承認して確定します。顧客に通知されます。")).toBeTruthy();
    // 全店舗表示の一括承認では、同名・同時刻の別店舗予約を取り違えないよう、確認一覧に
    // 店舗名とメニューまで出す。
    const dialog = within(screen.getByRole("alertdialog"));
    expect(dialog.getByText("予約 花子 様")).toBeTruthy();
    expect(dialog.getAllByText(/全身脱毛/)).toHaveLength(2);
    expect(dialog.getByText(/· 新宿店/)).toBeTruthy();
    expect(dialog.getByText(/· 渋谷店/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "2 件を承認する" }));

    expect(await screen.findByText("成功 1 件 / 失敗 1 件")).toBeTruthy();
    expect(mocks.post).toHaveBeenCalledTimes(2);
    expect(mocks.post).toHaveBeenNthCalledWith(
      1,
      "/api/admin/reservations/reservation-1/approve",
      expect.objectContaining({ expectedVersion: 3, reason: "" }),
    );
    expect(screen.getByText("予約 太郎 様")).toBeTruthy();
    expect(screen.getByText(/通信に失敗しました/)).toBeTruthy();
    expect(mocks.queryClient.invalidateQueries).toHaveBeenCalledWith({ queryKey: ["reservations"] });
  });
});
