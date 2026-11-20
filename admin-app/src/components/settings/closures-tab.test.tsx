import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthContext } from "@/providers/auth-context";
import { StoreProvider } from "@/providers/store-provider";
import type { SettingsResponse } from "@/types/api";
import { ClosuresTab } from "./closures-tab";

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() }));
vi.mock("@/lib/api-client", () => ({ api }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/error-messages", () => ({ showErrorToast: vi.fn() }));

const store = {
  id: "store-1", name: "サンプル中央店", timezone: "Asia/Tokyo",
  googleCalendarId: null, googleControlledEditMode: false,
  maxActiveReservationsPerCustomer: 3, bookingWindowDays: 30, customerNotice: null,
};
const settings: SettingsResponse = {
  ok: true,
  settings: {
    stores: [store], services: [], staff: [], resources: [], businessHours: [],
    closures: [{
      id: "closure-1", storeId: store.id, source: "admin", reason: "夏季休業",
      startsAt: "2026-08-01T00:00:00+09:00", endsAt: "2026-08-03T23:59:59+09:00",
    }],
  },
};

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
        <StoreProvider><ClosuresTab selectedStoreId={store.id} /></StoreProvider>
      </AuthContext.Provider>
    </QueryClientProvider>,
  );
}

const field = (label: string) => screen.getByLabelText(label) as HTMLInputElement;
const setDate = (label: string, value: string) => fireEvent.change(field(label), { target: { value } });

beforeEach(() => {
  vi.clearAllMocks();
  api.get.mockResolvedValue(settings);
  api.post.mockResolvedValue({ ok: true, closureId: "closure-2" });
});

describe("ClosuresTab: 終了日の追従", () => {
  it("追加の画面で開始日を選ぶと、終了日に同じ日付が入る", async () => {
    const user = userEvent.setup();
    renderTab();
    await user.click(await screen.findByRole("button", { name: "+ 追加" }));

    setDate("開始日", "2026-12-24");

    expect(field("終了日").value).toBe("2026-12-24");
  });

  it("終了日を触らない間は、開始日を変えるたびに終了日が追従する", async () => {
    const user = userEvent.setup();
    renderTab();
    await user.click(await screen.findByRole("button", { name: "+ 追加" }));

    setDate("開始日", "2026-12-24");
    setDate("開始日", "2026-12-25");

    expect(field("終了日").value).toBe("2026-12-25");
  });

  it("終了日を自分で変えたあとは、開始日を変えても追従しない", async () => {
    const user = userEvent.setup();
    renderTab();
    await user.click(await screen.findByRole("button", { name: "+ 追加" }));

    setDate("開始日", "2026-12-24");
    setDate("終了日", "2026-12-26");
    setDate("開始日", "2026-12-25");

    expect(field("終了日").value).toBe("2026-12-26");
  });

  it("閉じて開き直すと、終了日の追従が戻る", async () => {
    const user = userEvent.setup();
    renderTab();
    await user.click(await screen.findByRole("button", { name: "+ 追加" }));
    setDate("開始日", "2026-12-24");
    setDate("終了日", "2026-12-26");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByLabelText("開始日")).toBeNull());

    await user.click(screen.getByRole("button", { name: "+ 追加" }));
    setDate("開始日", "2027-01-05");

    expect(field("終了日").value).toBe("2027-01-05");
  });

  it("編集の画面では、開始日を変えても終了日は追従しない", async () => {
    const user = userEvent.setup();
    renderTab();
    await user.click(await screen.findByRole("button", { name: "編集" }));
    expect(field("終了日").value).toBe("2026-08-03");

    setDate("開始日", "2026-08-02");

    expect(field("終了日").value).toBe("2026-08-03");
  });

  it("開始日だけ選んで保存すると、1 日だけの休業日になる", async () => {
    const user = userEvent.setup();
    renderTab();
    await user.click(await screen.findByRole("button", { name: "+ 追加" }));

    setDate("開始日", "2026-12-24");
    await user.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => expect(api.post).toHaveBeenCalledWith("/api/admin/settings/closures", expect.objectContaining({
      storeId: "store-1",
      startsAt: "2026-12-23T15:00:00.000Z",
      endsAt: "2026-12-24T14:59:59.000Z",
    })));
  });
});
