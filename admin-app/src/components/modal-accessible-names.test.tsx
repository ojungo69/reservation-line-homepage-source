import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Service, StaffMember } from "@/types/api";

vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ user: { role: "owner", storeId: null, staffMemberId: null }, isPrivileged: true }) }));
vi.mock("@/hooks/use-services", () => ({ useServiceUpdate: () => ({ mutate: vi.fn(), isPending: false }), useServiceDelete: () => ({ mutate: vi.fn(), isPending: false }) }));
vi.mock("@/hooks/use-staff", () => ({ useStaffUpdate: () => ({ mutate: vi.fn(), isPending: false }), useStaffDelete: () => ({ mutate: vi.fn(), isPending: false }) }));
vi.mock("@/hooks/use-admin-push", () => ({ useAdminPushReconcile: () => {} }));
vi.mock("@/hooks/use-media-query", () => ({ useMediaQuery: () => false }));
vi.mock("@/components/header", () => ({ Header: ({ onMenuToggle }: { onMenuToggle: () => void }) => <button onClick={onMenuToggle}>メニューを開く</button> }));
vi.mock("@/components/sidebar", () => ({ Sidebar: () => <nav>予約メニュー</nav> }));

import { AppShell } from "./app-shell";
import { CommandPalette } from "./command-palette";
import { ServiceDetailPanel } from "./menu/service-detail-panel";
import { StaffDetailPanel } from "./staff/staff-detail-panel";

const service: Service = { id: "service-1", storeId: "store-1", name: "テストメニュー", durationMinutes: 60, priceLabel: null, priceAmount: null, comboPriceAmount: null, comboWithPrefix: null, active: true, mensMenu: false };
const staff: StaffMember = { id: "staff-1", storeId: "store-1", displayName: "担当見本", role: "staff", active: true, version: 1 };
const errors: string[] = [];

beforeEach(() => {
  errors.length = 0;
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => errors.push(args.join(" ")));
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
  expect(errors.some((message) => message.includes("requires a `DialogTitle`"))).toBe(false);
});

describe("モーダルの読み上げ名", () => {
  it("モバイルメニューを識別できる", () => {
    render(<MemoryRouter><AppShell /></MemoryRouter>);
    fireEvent.click(screen.getByRole("button", { name: "メニューを開く" }));
    expect(screen.getByRole("dialog", { name: "メニュー" })).toBeTruthy();
  });

  it("メニュー詳細を保存済みのメニュー名で識別できる", () => {
    render(<ServiceDetailPanel service={service} stores={[]} services={[service]} canEdit onClose={vi.fn()} />);
    expect(screen.getByRole("dialog", { name: "テストメニュー" })).toBeTruthy();
    expect(screen.getByRole("heading", { level: 2, name: "テストメニュー" })).toBeTruthy();
  });

  it("スタッフ詳細を担当者名で識別できる", () => {
    render(<StaffDetailPanel staff={staff} stores={[]} onClose={vi.fn()} />);
    expect(screen.getByRole("dialog", { name: "担当見本" })).toBeTruthy();
    expect(screen.getByRole("heading", { level: 2, name: "担当見本" })).toBeTruthy();
  });

  it("ページ移動ダイアログを識別できる", () => {
    render(<MemoryRouter><CommandPalette open onOpenChange={vi.fn()} /></MemoryRouter>);
    expect(screen.getByRole("dialog", { name: "ページ移動" })).toBeTruthy();
  });
});
