import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, api } from "@/lib/api-client";
import { createTestQueryClient, createQueryWrapper } from "@/test-utils/query-client";
import type { ReservationSearchResponse } from "@/types/api";
import ReservationsPage from "./reservations";

const state = vi.hoisted(() => ({ isNarrow: false }));

vi.mock("react-router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ user: { role: "owner", storeId: null } }),
}));
vi.mock("@/hooks/use-settings", () => ({ useSettings: () => ({ data: undefined }) }));
vi.mock("@/hooks/use-stores", () => ({
  useStores: () => ({ selectedStoreId: null, selectStore: vi.fn(), isStoreFixed: false }),
}));
vi.mock("@/hooks/use-reservations", () => ({
  useReservationAction: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/use-media-query", () => ({
  NARROW_QUERY: "(max-width: 639px)",
  useMediaQuery: () => state.isNarrow,
}));
vi.mock("@/components/schedule/reservation-detail-panel", () => ({
  ReservationDetailPanel: () => null,
}));

const response: ReservationSearchResponse = {
  ok: true,
  from: "2026-10-14",
  to: "2026-11-14",
  reservations: [{
    id: "reservation-1",
    customerId: "customer-1",
    customerDisplayName: "架空 花子",
    customerDisplayNameKana: "カクウ ハナコ",
    serviceName: "全身脱毛",
    storeName: "渋谷店",
    startAt: "2026-10-15T01:00:00.000Z",
    endAt: "2026-10-15T02:00:00.000Z",
    status: "pending_approval",
    source: "line",
    phoneTailMasked: "1234",
    lineFriendStatus: null,
    googleEventId: null,
    cancellationFeeUnpaidAt: null,
  }],
  truncated: false,
  totalCount: 1,
};

function renderSearch() {
  const client = createTestQueryClient();
  render(<ReservationsPage />, { wrapper: createQueryWrapper(client) });
  return client;
}

beforeEach(() => {
  state.isNarrow = false;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ReservationsPage search feedback", () => {
  it.each([false, true])("条件変更の検索中は旧行・件数・操作を表示しない（モバイル: %s）", async (isNarrow) => {
    state.isNarrow = isNarrow;
    let completeSearch!: (result: ReservationSearchResponse) => void;
    vi.spyOn(api, "get")
      .mockResolvedValueOnce(response)
      .mockImplementationOnce(() => new Promise((resolve) => { completeSearch = resolve; }));
    const client = renderSearch();
    await screen.findByText("架空 花子");
    expect(screen.getByText("1件")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "承認待ちのみ" }));

    // 前の条件の行を操作できると、利用者は新しい検索結果を承認したつもりになる。
    expect(screen.queryByText("架空 花子")).toBeNull();
    expect(screen.queryByText("1件")).toBeNull();
    expect(screen.queryByRole("button", { name: "承認" })).toBeNull();
    expect(screen.queryByRole("button", { name: "却下" })).toBeNull();
    expect(screen.getByRole("status").textContent).toBe("検索中です…");

    completeSearch({ ...response, reservations: [], totalCount: 0 });
    await screen.findByText("該当する予約はありません");
    expect(screen.getByText("0件")).toBeTruthy();
    expect(screen.queryByRole("status")).toBeNull();
    client.clear();
  });

  it.each(["開始日", "終了日"])("%sを空にしたら日付の入力を案内し、旧結果を表示しない", async (label) => {
    const get = vi.spyOn(api, "get").mockResolvedValue(response);
    const client = renderSearch();
    await screen.findByText("架空 花子");

    fireEvent.change(screen.getByLabelText(label), { target: { value: "" } });

    const message = screen.getByRole("alert");
    expect(message.textContent).toBe("日付を入力してください");
    for (const dateLabel of ["開始日", "終了日"]) {
      const input = screen.getByLabelText(dateLabel);
      expect(input.getAttribute("aria-invalid")).toBe("true");
      expect(input.getAttribute("aria-describedby")).toBe(message.id);
    }
    expect(screen.queryByText("架空 花子")).toBeNull();
    expect(screen.queryByText("1件")).toBeNull();
    expect(screen.getByRole("button", { name: "CSV" }).hasAttribute("disabled")).toBe(true);
    expect(screen.queryByRole("status")).toBeNull();
    expect(get).toHaveBeenCalledTimes(1);
    client.clear();
  });

  it.each([
    { from: "2026-11-15", to: "2026-11-14", message: "開始日と終了日の指定が正しくありません" },
    { from: "2026-01-01", to: "2026-04-03", message: "期間が大きすぎます" },
  ])("無効な期間（$from～$to）の原因を日付入力に関連付け、検索を止める", async ({ from, to, message }) => {
    const get = vi.spyOn(api, "get").mockResolvedValue(response);
    const client = renderSearch();
    await screen.findByText("架空 花子");

    // 途中の入力も無効な期間にし、完成前の条件では送信しないことも確認する。
    fireEvent.change(screen.getByLabelText("開始日"), { target: { value: "" } });
    fireEvent.change(screen.getByLabelText("終了日"), { target: { value: to } });
    fireEvent.change(screen.getByLabelText("開始日"), { target: { value: from } });

    const alert = screen.getByRole("alert");
    expect(alert.textContent).toBe(message);
    expect(screen.getByLabelText("開始日").getAttribute("aria-describedby")).toBe(alert.id);
    expect(screen.getByLabelText("終了日").getAttribute("aria-describedby")).toBe(alert.id);
    expect(screen.queryByText("架空 花子")).toBeNull();
    expect(screen.queryByText("1件")).toBeNull();
    expect(screen.getByRole("button", { name: "CSV" }).hasAttribute("disabled")).toBe(true);
    expect(get).toHaveBeenCalledTimes(1);
    client.clear();
  });

  it.each([
    { reason: "invalid_range", message: "開始日と終了日の指定が正しくありません" },
    { reason: "range_too_large", message: "期間が大きすぎます" },
  ])("APIが返す $reason の原因を日本語で表示する", async ({ reason, message }) => {
    vi.spyOn(api, "get").mockRejectedValueOnce(new ApiError(400, { ok: false, reason }));
    const client = renderSearch();

    expect((await screen.findByRole("alert")).textContent).toBe(message);
    expect(screen.queryByText("予約データの取得に失敗しました。")).toBeNull();
    client.clear();
  });

  it.each(["2026-01-01", "2026-04-02"])("日付を直すと同日・両端を含む92日（終了日: %s）の検索を再開する", async (to) => {
    const get = vi.spyOn(api, "get").mockResolvedValue(response);
    const client = renderSearch();
    await screen.findByText("架空 花子");

    fireEvent.change(screen.getByLabelText("開始日"), { target: { value: "" } });
    fireEvent.change(screen.getByLabelText("終了日"), { target: { value: to } });
    fireEvent.change(screen.getByLabelText("開始日"), { target: { value: "2026-01-01" } });

    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
    await screen.findByText("架空 花子");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByLabelText("開始日").getAttribute("aria-invalid")).toBe("false");
    expect(screen.getByLabelText("終了日").hasAttribute("aria-describedby")).toBe(false);
    expect(screen.getByRole("button", { name: "CSV" }).hasAttribute("disabled")).toBe(false);
    client.clear();
  });

  it("同じ条件の再取得中も検索中と伝え、完了後に案内を消す", async () => {
    let completeSearch!: (result: ReservationSearchResponse) => void;
    vi.spyOn(api, "get")
      .mockResolvedValueOnce(response)
      .mockImplementationOnce(() => new Promise((resolve) => { completeSearch = resolve; }));
    const client = renderSearch();
    await screen.findByText("架空 花子");

    void client.invalidateQueries({ queryKey: ["reservations", "search"] });

    await screen.findByRole("status");
    expect(screen.getByRole("status").textContent).toBe("検索中です…");
    completeSearch(response);
    await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
    client.clear();
  });

  it("未登録のAPI理由はコードを表示せず安全な案内にする", async () => {
    vi.spyOn(api, "get").mockRejectedValueOnce(new ApiError(500, { reason: "future_error" }));
    const client = renderSearch();

    expect((await screen.findByRole("alert")).textContent).toBe("予約データの取得に失敗しました。");
    expect(screen.queryByText("future_error")).toBeNull();
    client.clear();
  });
});
