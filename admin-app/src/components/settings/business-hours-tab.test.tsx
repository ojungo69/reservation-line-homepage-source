import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthContext } from "@/providers/auth-context";
import { StoreContext } from "@/providers/store-context";
import type { BusinessHourRow, BusinessHoursResponse } from "@/types/api";
import { BusinessHoursTab } from "./business-hours-tab";

const store = { id: "hours-store", name: "テスト店" };
const closedHours: BusinessHourRow[] = Array.from({ length: 7 }, (_, weekday) => ({
  weekday, opensAt: "10:00", closesAt: "19:00", closed: true
}));
let response: BusinessHoursResponse;
let writes: BusinessHourRow[][];
let failSave: boolean;

beforeEach(() => {
  response = { ok: true, configured: false, businessHours: structuredClone(closedHours) };
  writes = [];
  failSave = false;
  vi.stubGlobal("fetch", vi.fn(async (path: string, init?: RequestInit) => {
    if (path === "/api/admin/settings") {
      return Response.json({ ok: true, settings: { stores: [store] } });
    }
    if (path !== "/api/admin/settings/business-hours/hours-store") throw new Error(`Unexpected URL: ${path}`);
    if (init?.method === "PUT") {
      const { hours } = JSON.parse(String(init.body)) as { hours: BusinessHourRow[] };
      writes.push(hours);
      if (failSave) return Response.json({ ok: false, error: "write_failed" }, { status: 500 });
      response = { ok: true, configured: true, businessHours: hours };
      return Response.json({ ok: true });
    }
    return Response.json(response);
  }));
});

afterEach(() => vi.unstubAllGlobals());

function renderHours() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <AuthContext.Provider value={{
        user: { email: "owner@example.test", role: "owner", storeId: null, staffMemberId: null },
        isPrivileged: true, vapidPublicKey: ""
      }}>
        <StoreContext.Provider value={{ selectedStoreId: store.id, selectStore: () => {} }}>
          <BusinessHoursTab stores={[store]} selectedStoreId={store.id} />
        </StoreContext.Provider>
      </AuthContext.Provider>
    </QueryClientProvider>
  );
}

describe("営業時間の初期設定", () => {
  it("未設定では書き込まず、明示して営業にした曜日だけを保存する", async () => {
    const user = userEvent.setup();
    renderHours();
    expect(await screen.findByText("未設定・予約受付不可")).toBeTruthy();
    expect(screen.queryByText("営業", { exact: true })).toBeNull();
    expect(writes).toHaveLength(0);

    await user.click(screen.getByRole("button", { name: "営業時間を設定" }));
    expect(screen.getAllByRole("button", { name: /曜 休業$/ })).toHaveLength(7);
    expect(writes).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: "月曜 休業" }));
    await user.click(screen.getByRole("button", { name: "保存" }));

    await screen.findByRole("button", { name: "編集" });
    await waitFor(() => expect(screen.queryByText("未設定・予約受付不可")).toBeNull());
    expect(writes).toHaveLength(1);
    expect(writes[0].filter((row) => !row.closed)).toEqual([{ weekday: 1, opensAt: "10:00", closesAt: "19:00", closed: false }]);
  });

  it("設定を始めてキャンセルしても未設定のままで書き込まない", async () => {
    const user = userEvent.setup();
    renderHours();
    await user.click(await screen.findByRole("button", { name: "営業時間を設定" }));
    await user.click(screen.getByRole("button", { name: "月曜 休業" }));
    await user.click(screen.getByRole("button", { name: "キャンセル" }));
    expect(screen.getByText("未設定・予約受付不可")).toBeTruthy();
    expect(screen.getByRole("button", { name: "営業時間を設定" })).toBeTruthy();
    expect(writes).toHaveLength(0);
  });

  it("保存に失敗したときは未設定表示と下書きを残す", async () => {
    failSave = true;
    const user = userEvent.setup();
    renderHours();
    await user.click(await screen.findByRole("button", { name: "営業時間を設定" }));
    await user.click(screen.getByRole("button", { name: "月曜 休業" }));
    await user.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(screen.getByText("未設定・予約受付不可")).toBeTruthy();
    expect(screen.getByRole("button", { name: "月曜 営業" })).toBeTruthy();
    expect(response.configured).toBe(false);
  });

  it("明示的な全曜日休業は未設定と表示しない", async () => {
    response.configured = true;
    renderHours();
    await screen.findByRole("button", { name: "編集" });
    expect(screen.queryByText("未設定・予約受付不可")).toBeNull();
    expect(screen.getAllByText("休業", { exact: true })).toHaveLength(7);
    expect(writes).toHaveLength(0);
  });
});
