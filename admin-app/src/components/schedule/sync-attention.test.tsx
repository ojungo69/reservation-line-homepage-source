import { act, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router";
import { AuthContext, type AdminRole } from "@/providers/auth-context";
import { ACCESS_LOGOUT_PATH } from "@/lib/auth-logout";
import { ScheduleSyncAttention } from "./sync-attention";

afterEach(() => vi.unstubAllGlobals());

function renderAttention(client: QueryClient, role: AdminRole = "staff") {
  return render(<QueryClientProvider client={client}><MemoryRouter><AuthContext value={{
    user: { role, email: "staff@example.test", staffMemberId: "staff", storeId: "kyoto" },
    isPrivileged: role !== "staff", vapidPublicKey: "",
  }}><ScheduleSyncAttention /></AuthContext></MemoryRouter></QueryClientProvider>);
}

it("shows staff warnings from the real query without linking to an owner-only screen", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ok: true, role: "staff", warnings: [{ kind: "google_sync_attention", count: 2, message: "Google反映で確認が必要です。管理者に確認してください。" }] })));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = renderAttention(client);
  expect(await screen.findByText(/Google・LINEの確認が必要です（2件）/)).toBeTruthy();
  expect(screen.queryByRole("link", { name: "連携状況を確認する" })).toBeNull();
  view.unmount(); client.clear();
});

it("does not present a failed status query as no outstanding work", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ok: false }, { status: 503 })));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = renderAttention(client);
  expect(await screen.findByRole("alert")).toBeTruthy();
  expect(screen.getByRole("alert").textContent).toContain("読み込みに失敗しました");
  expect(screen.getByRole("button", { name: "再取得" })).toBeTruthy();
  view.unmount(); client.clear();
});

it("identifies a refresh failure after a previously successful empty response", async () => {
  const fetcher = vi.fn()
    .mockResolvedValueOnce(Response.json({ ok: true, role: "staff", warnings: [] }))
    .mockResolvedValueOnce(Response.json({ ok: false }, { status: 503 }));
  vi.stubGlobal("fetch", fetcher);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = renderAttention(client);
  await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
  await act(async () => { await client.refetchQueries(); });
  expect((await screen.findByRole("alert")).textContent).toContain("更新に失敗しました");
  expect(screen.queryByText(/確認が必要です（/)).toBeNull();
  view.unmount(); client.clear();
});

it.each([401, 403])("offers the existing re-login action when sync status returns %s", async (status) => {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ok: false, reason: "admin_auth_failed" }, { status })));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = renderAttention(client);
  const login = await screen.findByRole("link", { name: "再ログイン" });
  expect(login.getAttribute("href")).toBe(ACCESS_LOGOUT_PATH);
  expect(screen.getByRole("alert").textContent).toContain("ログインの有効期限、または権限を確認してください");
  view.unmount(); client.clear();
});

it("distinguishes the initial read from a confirmed empty response", async () => {
  let resolveResponse!: (response: Response) => void;
  const response = new Promise<Response>((resolve) => { resolveResponse = resolve; });
  vi.stubGlobal("fetch", vi.fn(() => response));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = renderAttention(client);
  expect(screen.getByRole("status").textContent).toContain("連携状況を確認しています");
  await act(async () => resolveResponse(Response.json({ ok: true, role: "staff", warnings: [] })));
  await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
  expect(screen.queryByRole("alert")).toBeNull();
  view.unmount(); client.clear();
});

it("does not fetch or poll discarded sync details on the system-admin schedule", async () => {
  const fetcher = vi.fn(async () => Response.json({ ok: true, role: "system_admin" }));
  vi.stubGlobal("fetch", fetcher);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.useFakeTimers();
  const view = renderAttention(client, "system_admin");
  try {
    await act(async () => { await vi.advanceTimersByTimeAsync(90_000); });
    expect(fetcher).not.toHaveBeenCalled();
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  } finally {
    view.unmount(); client.clear(); vi.useRealTimers();
  }
});
