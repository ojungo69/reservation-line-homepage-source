import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthContext } from "@/providers/auth-context";
import { StoreProvider } from "@/providers/store-provider";
import type { Resource, SettingsResponse } from "@/types/api";
import { RecurringBlocksTab } from "./recurring-blocks-tab";

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock("@/lib/api-client", () => ({ api }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/error-messages", () => ({ showErrorToast: vi.fn() }));

const store = {
  id: "store-1", name: "サンプル中央店", timezone: "Asia/Tokyo",
  googleCalendarId: null, googleControlledEditMode: false,
  maxActiveReservationsPerCustomer: 3, bookingWindowDays: 30, customerNotice: null,
};
const room = (id: string, name: string): Resource => ({
  id, storeId: store.id, name, resourceType: "staff_calendar", active: true,
});
const NO_RESOURCE_NOTICE = "この店舗は予約枠が未設定です。店舗設定の「リソース」タブで追加してください。";

let resources: Resource[] = [];
let releaseSettings: () => void = () => {};

function renderTab() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <AuthContext.Provider value={{
        user: { email: "owner@example.com", role: "owner", storeId: store.id, staffMemberId: null },
        isPrivileged: true, vapidPublicKey: "",
      }}>
        <StoreProvider><RecurringBlocksTab selectedStoreId={store.id} /></StoreProvider>
      </AuthContext.Provider>
    </QueryClientProvider>,
  );
  return client;
}

const button = (name: string) => screen.getByRole("button", { name }) as HTMLButtonElement;

beforeEach(() => {
  resources = [];
  vi.clearAllMocks();
  const gate = new Promise<void>((resolve) => { releaseSettings = resolve; });
  api.get.mockImplementation(async (path: string) => {
    if (path !== "/api/admin/settings") throw new Error(`Unexpected GET: ${path}`);
    await gate;
    const settings: SettingsResponse = {
      ok: true,
      settings: { stores: [store], services: [], staff: [], resources, businessHours: [], closures: [] },
    };
    return settings;
  });
  api.post.mockImplementation(async (path: string) => {
    if (path === "/api/admin/recurring/preview") {
      return { ok: true, occurrences: ["2026-12-07T03:00:00.000Z"], truncatedByWindow: false, truncatedByCap: false, windowCapped: false };
    }
    return { ok: true, createdCount: 1, replayedCount: 0, skippedPastCount: 0, failedCount: 0 };
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("RecurringBlocksTab: 枠の数による出し分け", () => {
  it("枠が 1 つなら欄を出さず、プレビューから作成まで、その枠で送る", async () => {
    resources = [room("resource-1", "施術室1")];
    const user = userEvent.setup();
    renderTab();
    releaseSettings();

    await user.click(screen.getByRole("button", { name: "月曜" }));
    fireEvent.change(screen.getByLabelText("開始日"), { target: { value: "2026-12-07" } });
    fireEvent.change(screen.getByLabelText("終了日"), { target: { value: "2026-12-14" } });
    await waitFor(() => expect(button("プレビュー").disabled).toBe(false));
    expect(screen.queryByRole("combobox", { name: "リソース" })).toBeNull();
    expect(screen.queryByText(NO_RESOURCE_NOTICE)).toBeNull();

    await user.click(button("プレビュー"));
    await waitFor(() => expect(button("作成").disabled).toBe(false));
    await user.click(button("作成"));

    await waitFor(() => expect(api.post).toHaveBeenCalledWith("/api/admin/recurring/commit", expect.objectContaining({
      storeId: "store-1",
      resourceId: "resource-1",
      rrule: "FREQ=WEEKLY;BYDAY=MO",
      durationMinutes: 60,
    })));
    expect(api.post).toHaveBeenCalledWith("/api/admin/recurring/preview", expect.objectContaining({
      resourceId: "resource-1",
    }));
  });

  it("枠が 0 なら案内を出し、プレビューできない", async () => {
    renderTab();
    releaseSettings();

    expect(await screen.findByText(NO_RESOURCE_NOTICE)).toBeTruthy();
    expect(screen.queryByRole("combobox", { name: "リソース" })).toBeNull();
    expect(button("プレビュー").disabled).toBe(true);
  });

  it("枠が 2 つなら欄を出す", async () => {
    resources = [room("resource-1", "施術室1"), room("resource-2", "施術室2")];
    renderTab();
    releaseSettings();

    expect(await screen.findByRole("combobox", { name: "リソース" })).toBeTruthy();
    expect(screen.queryByText(NO_RESOURCE_NOTICE)).toBeNull();
  });

  it("読み込み中は欄も案内も出さない", () => {
    renderTab();

    expect(screen.queryByRole("combobox", { name: "リソース" })).toBeNull();
    expect(screen.queryByText(NO_RESOURCE_NOTICE)).toBeNull();
  });

  it("選んだ枠が止まって 1 つだけ残っても、黙って置き換えず、選び直すまでプレビューできない", async () => {
    resources = [room("resource-1", "施術室1"), room("resource-2", "施術室2")];
    const user = userEvent.setup();
    const client = renderTab();
    releaseSettings();
    await user.click(screen.getByRole("button", { name: "月曜" }));
    fireEvent.change(screen.getByLabelText("開始日"), { target: { value: "2026-12-07" } });
    fireEvent.change(screen.getByLabelText("終了日"), { target: { value: "2026-12-14" } });
    (await screen.findByRole("combobox", { name: "リソース" })).focus();
    await user.keyboard("施術室2");
    await waitFor(() => expect(button("プレビュー").disabled).toBe(false));

    resources = [room("resource-1", "施術室1"), { ...room("resource-2", "施術室2"), active: false }];
    await act(async () => {
      await client.refetchQueries({ queryKey: ["settings"] });
    });
    // TanStack Query は描画への知らせを setTimeout の後に送るので、それを待ってから見る。
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(screen.getByRole("combobox", { name: "リソース" })).toBeTruthy();
    expect(button("プレビュー").disabled).toBe(true);
  });

  it("読み込み前に作ったキーは送らず、同じ内容の作り直しでは送ったキーを使い続ける", async () => {
    resources = [room("resource-1", "施術室1")];
    const issued: string[] = [];
    vi.spyOn(crypto, "randomUUID").mockImplementation(() => {
      const key = `00000000-0000-4000-8000-${String(issued.length + 1).padStart(12, "0")}` as const;
      issued.push(key);
      return key;
    });
    let commits = 0;
    api.post.mockImplementation(async (path: string) => {
      if (path === "/api/admin/recurring/preview") {
        return { ok: true, occurrences: ["2026-12-07T03:00:00.000Z"], truncatedByWindow: false, truncatedByCap: false, windowCapped: false };
      }
      commits += 1;
      if (commits === 1) throw new Error("network");
      return { ok: true, createdCount: 1, replayedCount: 0, skippedPastCount: 0, failedCount: 0 };
    });
    const user = userEvent.setup();
    renderTab();
    await user.click(screen.getByRole("button", { name: "月曜" }));
    fireEvent.change(screen.getByLabelText("開始日"), { target: { value: "2026-12-07" } });
    fireEvent.change(screen.getByLabelText("終了日"), { target: { value: "2026-12-14" } });
    const beforeLoad = [...issued];

    releaseSettings();
    await waitFor(() => expect(button("プレビュー").disabled).toBe(false));
    await user.click(button("プレビュー"));
    await waitFor(() => expect(button("作成").disabled).toBe(false));
    await user.click(button("作成"));
    await waitFor(() => expect(commits).toBe(1));
    await waitFor(() => expect(button("作成").disabled).toBe(false));
    await user.click(button("作成"));
    await waitFor(() => expect(commits).toBe(2));

    const keys = api.post.mock.calls
      .filter(([path]) => path === "/api/admin/recurring/commit")
      .map(([, body]) => (body as { idempotencyKey: string }).idempotencyKey);
    expect(beforeLoad).not.toContain(keys[0]);
    expect(keys[1]).toBe(keys[0]);
  });
});
