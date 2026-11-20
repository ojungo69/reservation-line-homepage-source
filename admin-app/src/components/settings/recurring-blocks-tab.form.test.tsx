import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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

  it("読み込みが終わったあとに、冪等性のキーが新しく作られる", async () => {
    resources = [room("resource-1", "施術室1")];
    let issued = 0;
    const uuid = vi.spyOn(crypto, "randomUUID").mockImplementation(() => `00000000-0000-4000-8000-${String(++issued).padStart(12, "0")}`);
    renderTab();
    const issuedBeforeLoad = uuid.mock.calls.length;

    releaseSettings();

    await waitFor(() => expect(uuid.mock.calls.length).toBeGreaterThan(issuedBeforeLoad));
  });
});
