import type { ReactElement } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthContext } from "@/providers/auth-context";
import { StoreProvider } from "@/providers/store-provider";
import type { ExternalBlockActionResponse, Resource, SettingsResponse } from "@/types/api";
import { ExternalBlockCreateDialog } from "./external-block-create-dialog";

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock("@/lib/api-client", () => ({ api }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

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
let settingsFail = false;

function renderDialog(element: ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <AuthContext.Provider value={{
        user: { email: "owner@example.com", role: "owner", storeId: null, staffMemberId: null },
        isPrivileged: true, vapidPublicKey: "",
      }}>
        <StoreProvider>{element}</StoreProvider>
      </AuthContext.Provider>
    </QueryClientProvider>,
  );
  return client;
}

const openDialog = () => (
  <ExternalBlockCreateDialog open onOpenChange={vi.fn()} defaultStoreId={store.id} />
);

function fillTimes() {
  fireEvent.change(screen.getByLabelText("開始日時"), { target: { value: "2026-12-01T10:00" } });
  fireEvent.change(screen.getByLabelText("終了日時"), { target: { value: "2026-12-01T11:00" } });
}

const createButton = () => screen.getByRole("button", { name: "作成" });

beforeEach(() => {
  resources = [];
  settingsFail = false;
  vi.clearAllMocks();
  // Radix Select が jsdom に無い API を呼ぶ。
  Object.defineProperty(HTMLElement.prototype, "hasPointerCapture", { configurable: true, value: () => false });
  Object.defineProperty(HTMLElement.prototype, "releasePointerCapture", { configurable: true, value: vi.fn() });
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
  const created: ExternalBlockActionResponse = {
    ok: true,
    externalBlockId: "block-1",
    status: "active",
    storeId: store.id,
    startAt: "2026-12-01T01:00:00.000Z",
    endAt: "2026-12-01T02:00:00.000Z",
    replayed: false,
  };
  api.post.mockResolvedValue(created);
  api.get.mockImplementation(async (path: string) => {
    if (path !== "/api/admin/settings") throw new Error(`Unexpected GET: ${path}`);
    if (settingsFail) throw new Error("settings unavailable");
    const settings: SettingsResponse = {
      ok: true,
      settings: { stores: [store], services: [], staff: [], resources, businessHours: [], closures: [] },
    };
    return settings;
  });
});

afterEach(() => {
  for (const key of ["hasPointerCapture", "releasePointerCapture", "scrollIntoView"]) {
    Reflect.deleteProperty(HTMLElement.prototype, key);
  }
});

describe("ExternalBlockCreateDialog: 枠の数による出し分け", () => {
  it("枠が 1 つなら欄を出さず、その枠で送る", async () => {
    resources = [room("resource-1", "施術室1")];
    renderDialog(openDialog());
    fillTimes();

    await waitFor(() => expect((createButton() as HTMLButtonElement).disabled).toBe(false));
    expect(screen.getByText("選んだ時間帯を予約不可にします。時刻は5分単位で指定してください。")).toBeTruthy();
    expect(screen.queryByText(/リソース/)).toBeNull();

    fireEvent.click(createButton());
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
    expect(api.post).toHaveBeenCalledWith("/api/admin/external-blocks", expect.objectContaining({
      storeId: "store-1",
      resourceId: "resource-1",
      startAt: "2026-12-01T01:00:00.000Z",
      endAt: "2026-12-01T02:00:00.000Z",
    }));
  });

  it("枠が 0 なら案内を出し、作成できない", async () => {
    renderDialog(openDialog());
    fillTimes();

    expect(await screen.findByText(NO_RESOURCE_NOTICE)).toBeTruthy();
    expect(screen.queryByRole("combobox", { name: "リソース" })).toBeNull();
    expect((createButton() as HTMLButtonElement).disabled).toBe(true);
  });

  it("枠が 0 の案内は、設定の取得前から置かれた通知欄に入る", async () => {
    renderDialog(openDialog());
    const region = screen.getByRole("status");
    expect(region.textContent).toBe("");

    expect((await screen.findByText(NO_RESOURCE_NOTICE)).closest("output")).toBe(region);
  });

  it("枠が 2 つなら欄を出し、選ぶまで作成できない", async () => {
    resources = [room("resource-1", "施術室1"), room("resource-2", "施術室2")];
    const user = userEvent.setup();
    renderDialog(openDialog());
    fillTimes();

    const field = await screen.findByRole("combobox", { name: "リソース" });
    expect(screen.queryByText(NO_RESOURCE_NOTICE)).toBeNull();
    expect((createButton() as HTMLButtonElement).disabled).toBe(true);

    await user.click(field);
    await user.click(await screen.findByRole("option", { name: "施術室2" }));
    await waitFor(() => expect((createButton() as HTMLButtonElement).disabled).toBe(false));

    fireEvent.click(createButton());
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
    expect(api.post).toHaveBeenCalledWith("/api/admin/external-blocks", expect.objectContaining({
      resourceId: "resource-2",
    }));
  });

  it("選んだ枠が止まって 1 つだけ残っても、黙って置き換えず、選び直すまで作成できない", async () => {
    resources = [room("resource-1", "施術室1"), room("resource-2", "施術室2")];
    const user = userEvent.setup();
    const client = renderDialog(openDialog());
    fillTimes();
    await user.click(await screen.findByRole("combobox", { name: "リソース" }));
    await user.click(await screen.findByRole("option", { name: "施術室2" }));
    await waitFor(() => expect((createButton() as HTMLButtonElement).disabled).toBe(false));

    resources = [room("resource-1", "施術室1"), { ...room("resource-2", "施術室2"), active: false }];
    await act(async () => {
      await client.refetchQueries({ queryKey: ["settings"] });
    });
    // TanStack Query は描画への知らせを setTimeout の後に送るので、それを待ってから見る。
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(screen.getByRole("combobox", { name: "リソース" })).toBeTruthy();
    expect((createButton() as HTMLButtonElement).disabled).toBe(true);

    await user.click(screen.getByRole("combobox", { name: "リソース" }));
    await user.click(await screen.findByRole("option", { name: "施術室1" }));
    await waitFor(() => expect((createButton() as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(createButton());
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
    expect(api.post).toHaveBeenCalledWith("/api/admin/external-blocks", expect.objectContaining({ resourceId: "resource-1" }));
  });

  it("設定の取得に失敗したら、0 件の案内を出さず、作成できない", async () => {
    settingsFail = true;
    const client = renderDialog(openDialog());
    fillTimes();

    await waitFor(() => expect(client.getQueryState(["settings"])?.status).toBe("error"));
    expect(screen.queryByText(NO_RESOURCE_NOTICE)).toBeNull();
    expect(screen.queryByRole("combobox", { name: "リソース" })).toBeNull();
    expect((createButton() as HTMLButtonElement).disabled).toBe(true);
  });
});
