import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "@/providers/auth-provider";
import { AppRoutes } from "./routes";

// The calendar switch (specs/008 T000, T004b): the server's calendarV2 alone picks
// the new schedule and the new shell, and anything else leaves the current screens
// as they are. The round trip pins plan.md's schedule <-> chart rule at the route
// level; the SchedulePage tests cover its navigation arguments and the restored
// state. The mocks move the way the real pages do: the schedule pushes /customers
// with fromSchedule, and the chart goes back with navigate(-1).

vi.mock("@/components/app-shell", async () => {
  const { Outlet } = await import("react-router");
  return { AppShell: () => <div data-testid="current-shell"><Outlet /></div> };
});
vi.mock("@/pages/schedule", async () => {
  const { Link } = await import("react-router");
  return {
    default: () => (
      <><p>今の予定表</p><Link to="/customers?customerId=c1&reservationId=r1" state={{ fromSchedule: true }}>カルテを開く</Link></>
    ),
  };
});
vi.mock("@/components/shell-v2/app-shell-v2", async () => {
  const { Outlet } = await import("react-router");
  return { default: () => <div data-testid="new-shell"><Outlet /></div> };
});
vi.mock("@/pages/schedule-v2", async () => {
  const { Link } = await import("react-router");
  return {
    default: () => (
      <><p>新しい予定表</p><Link to="/customers?customerId=c1&reservationId=r1" state={{ fromSchedule: true }}>カルテを開く</Link></>
    ),
  };
});
vi.mock("@/pages/customers", async () => {
  const { useNavigate } = await import("react-router");
  return {
    default: function CustomersPageMock() {
      const navigate = useNavigate();
      return <><p>顧客カルテ</p><button type="button" onClick={() => navigate(-1)}>予定表に戻る</button></>;
    },
  };
});

afterEach(() => vi.unstubAllGlobals());

const admin = { email: "owner@example.invalid", role: "owner", storeId: null, staffMemberId: null };
const OFF = [{}, { calendarV2: false }, { calendarV2: "true" }];

function renderAt(path: string, me: Record<string, unknown>) {
  // A Response body can be read once, so every /me request gets its own.
  vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(Response.json({ ok: true, admin, ...me }))));
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={[path]}>
        <AuthProvider><AppRoutes /></AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("calendar switch", () => {
  it.each(OFF)("keeps the current schedule unless the server says true (%j)", async (me) => {
    renderAt("/", me);
    expect(await screen.findByText("今の予定表")).toBeTruthy();
    expect(screen.queryByText("新しい予定表")).toBeNull();
    expect(screen.getByTestId("current-shell")).toBeTruthy();
    expect(screen.queryByTestId("new-shell")).toBeNull();
  });

  it("shows the new schedule in the new shell when the server turns calendarV2 on", async () => {
    renderAt("/", { calendarV2: true });
    expect(await screen.findByText("新しい予定表")).toBeTruthy();
    expect(screen.queryByText("今の予定表")).toBeNull();
    expect(screen.getByTestId("new-shell")).toBeTruthy();
    expect(screen.queryByTestId("current-shell")).toBeNull();
  });

  it("opens the customer chart directly in the new shell while the switch is on", async () => {
    renderAt("/customers", { calendarV2: true });
    expect(await screen.findByText("顧客カルテ")).toBeTruthy();
    expect(screen.getByTestId("new-shell")).toBeTruthy();
    expect(screen.queryByTestId("current-shell")).toBeNull();
  });

  it("goes from the new schedule to the chart and back inside one new shell while the switch is on", async () => {
    renderAt("/", { calendarV2: true });
    expect(await screen.findByText("新しい予定表")).toBeTruthy();
    const shell = await screen.findByTestId("new-shell");

    fireEvent.click(screen.getByText("カルテを開く"));
    expect(await screen.findByText("顧客カルテ")).toBeTruthy();
    expect(screen.getByTestId("new-shell")).toBe(shell);

    fireEvent.click(screen.getByText("予定表に戻る"));
    expect(await screen.findByText("新しい予定表")).toBeTruthy();
    expect(screen.getByTestId("new-shell")).toBe(shell);
  });

  it.each(OFF)("opens the customer chart directly in the current shell while the switch is off (%j)", async (me) => {
    renderAt("/customers", me);
    expect(await screen.findByText("顧客カルテ")).toBeTruthy();
    expect(screen.getByTestId("current-shell")).toBeTruthy();
  });

  it.each(OFF)("goes from the schedule to the chart and back inside one shell while the switch is off (%j)", async (me) => {
    renderAt("/", me);
    expect(await screen.findByText("今の予定表")).toBeTruthy();
    const shell = screen.getByTestId("current-shell");

    fireEvent.click(screen.getByText("カルテを開く"));
    expect(await screen.findByText("顧客カルテ")).toBeTruthy();
    expect(screen.getByTestId("current-shell")).toBe(shell);

    fireEvent.click(screen.getByText("予定表に戻る"));
    expect(await screen.findByText("今の予定表")).toBeTruthy();
    expect(screen.getByTestId("current-shell")).toBe(shell);
    expect(screen.queryByText("新しい予定表")).toBeNull();
  });
});
