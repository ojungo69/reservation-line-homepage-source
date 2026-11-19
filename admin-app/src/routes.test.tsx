import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "@/providers/auth-provider";
import { AppRoutes } from "./routes";

// The calendar switch (specs/008 T000): the server's calendarV2 alone picks the
// new schedule, and anything else leaves the current screens as they are.

vi.mock("@/components/app-shell", async () => {
  const { Outlet } = await import("react-router");
  return { AppShell: () => <div data-testid="current-shell"><Outlet /></div> };
});
vi.mock("@/pages/schedule", () => ({ default: () => <p>今の予定表</p> }));
vi.mock("@/pages/schedule-v2", () => ({ default: () => <p>新しい予定表</p> }));
vi.mock("@/pages/customers", () => ({ default: () => <p>顧客カルテ</p> }));

afterEach(() => vi.unstubAllGlobals());

const admin = { email: "owner@example.invalid", role: "owner", storeId: null, staffMemberId: null };

function renderAt(path: string, me: Record<string, unknown>) {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ ok: true, admin, ...me })));
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={[path]}>
        <AuthProvider><AppRoutes /></AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("calendar switch", () => {
  it.each([{}, { calendarV2: false }, { calendarV2: "true" }])("keeps the current schedule unless the server says true (%j)", async (me) => {
    renderAt("/", me);
    expect(await screen.findByText("今の予定表")).toBeTruthy();
    expect(screen.queryByText("新しい予定表")).toBeNull();
    expect(screen.getByTestId("current-shell")).toBeTruthy();
  });

  it("shows the new schedule when the server turns calendarV2 on", async () => {
    renderAt("/", { calendarV2: true });
    expect(await screen.findByText("新しい予定表")).toBeTruthy();
    expect(screen.queryByText("今の予定表")).toBeNull();
  });

  it("opens the customer chart directly in the current shell while the switch is off", async () => {
    renderAt("/customers", {});
    expect(await screen.findByText("顧客カルテ")).toBeTruthy();
    expect(screen.getByTestId("current-shell")).toBeTruthy();
  });
});
