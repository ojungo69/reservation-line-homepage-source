import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, expect, it, vi } from "vitest";
import { AuthProvider } from "@/providers/auth-provider";
import { AppRoutes } from "./routes";

// Production keeps the calendar switch off, so it must never download the V2 shell
// (specs/008 T004b). Nothing in this file turns the switch on, so the flag is set
// only if the routes import the shell statically or a render with the switch off
// imports it. A separate file, because a module mock stays loaded for the rest of
// the file that first loads it.
const shellV2 = vi.hoisted(() => ({ loaded: false }));
vi.mock("@/components/shell-v2/app-shell-v2", () => {
  shellV2.loaded = true;
  return { default: () => null };
});
vi.mock("@/components/app-shell", async () => {
  const { Outlet } = await import("react-router");
  return { AppShell: () => <Outlet /> };
});
vi.mock("@/pages/schedule", () => ({ default: () => <p>今の予定表</p> }));

// Read after the imports above have run, before the test renders anything.
const loadedWithRoutes = shellV2.loaded;

afterEach(() => vi.unstubAllGlobals());

it("does not load the V2 shell with the routes, or when rendering with the switch off", async () => {
  expect(loadedWithRoutes).toBe(false);
  const admin = { email: "owner@example.invalid", role: "owner", storeId: null, staffMemberId: null };
  vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(Response.json({ ok: true, admin }))));
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={["/"]}>
        <AuthProvider>
          <AppRoutes />
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  expect(await screen.findByText("今の予定表")).toBeTruthy();
  expect(shellV2.loaded).toBe(false);
});
