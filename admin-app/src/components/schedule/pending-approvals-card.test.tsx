import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

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

describe("PendingApprovalsCard", () => {
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
