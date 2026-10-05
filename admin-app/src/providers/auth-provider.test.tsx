import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "./auth-provider";

afterEach(() => vi.unstubAllGlobals());

function renderAuth() {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <AuthProvider><p>管理画面</p></AuthProvider>
    </QueryClientProvider>,
  );
}

describe("AuthProvider recovery", () => {
  it.each(["initial", "expired"])("offers same-origin reauthentication after an Access login redirect (%s)", async (phase) => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const loginResponse = Response.error();
    Object.defineProperty(loginResponse, "type", { value: "opaqueredirect" });
    const fetchMock = vi.fn();
    if (phase === "expired") fetchMock.mockResolvedValueOnce(Response.json({ ok: true, admin: { role: "staff" } }));
    fetchMock.mockResolvedValue(loginResponse);
    vi.stubGlobal("fetch", fetchMock);
    render(<QueryClientProvider client={client}><AuthProvider><p>保護された内容</p></AuthProvider></QueryClientProvider>);
    if (phase === "expired") {
      expect(await screen.findByText("保護された内容")).toBeTruthy();
      await act(async () => { await client.invalidateQueries({ queryKey: ["auth", "me"] }); });
    }
    expect((await screen.findByRole("link", { name: "再ログイン" })).getAttribute("href")).toBe("/cdn-cgi/access/logout");
    expect(screen.queryByText("保護された内容")).toBeNull();
  });

  it.each([401, 403])("offers reauthentication for HTTP %s", async (status) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ error: "forbidden" }, { status })));
    renderAuth();
    expect((await screen.findByRole("link", { name: "再ログイン" })).getAttribute("href")).toBe("/cdn-cgi/access/logout");
    expect(screen.queryByText("管理画面")).toBeNull();
  });

  it.each(["network", "server"])("retries a %s failure without calling it an authentication error", async (kind) => {
    const fetchMock = vi.fn();
    if (kind === "network") fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    else fetchMock.mockResolvedValueOnce(Response.json({ error: "unavailable" }, { status: 503 }));
    fetchMock.mockResolvedValue(Response.json({ ok: true, admin: { email: "staff@example.invalid", role: "staff", storeId: "store-1", staffMemberId: null } }));
    vi.stubGlobal("fetch", fetchMock);
    renderAuth();
    expect(await screen.findByText("接続できませんでした")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "再ログイン" })).toBeNull();
    await userEvent.setup().click(screen.getByRole("button", { name: "再取得" }));
    expect(await screen.findByText("管理画面")).toBeTruthy();
  });

  it("keeps an open draft when only the authentication refresh loses its connection", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const fetchMock = vi.fn().mockResolvedValueOnce(Response.json({ ok: true, admin: { role: "staff" } }))
      .mockRejectedValue(new TypeError("Failed to fetch"));
    vi.stubGlobal("fetch", fetchMock);
    render(<QueryClientProvider client={client}><AuthProvider><input aria-label="下書き" /></AuthProvider></QueryClientProvider>);
    await userEvent.setup().type(await screen.findByRole("textbox", { name: "下書き" }), "作業中");
    await act(async () => { await client.invalidateQueries({ queryKey: ["auth", "me"] }); });
    expect(await screen.findByText(/ログイン状態の更新に失敗しました/)).toBeTruthy();
    expect((screen.getByRole("textbox", { name: "下書き" }) as HTMLInputElement).value).toBe("作業中");
  });

  it("hides protected content when a previously authenticated account loses access", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(Response.json({ ok: true, admin: { role: "staff" } }))
      .mockResolvedValue(Response.json({ error: "forbidden" }, { status: 403 })));
    render(<QueryClientProvider client={client}><AuthProvider><p>保護された内容</p></AuthProvider></QueryClientProvider>);
    expect(await screen.findByText("保護された内容")).toBeTruthy();
    await act(async () => { await client.invalidateQueries({ queryKey: ["auth", "me"] }); });
    expect(await screen.findByRole("link", { name: "再ログイン" })).toBeTruthy();
    expect(screen.queryByText("保護された内容")).toBeNull();
  });
});
