import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import NotificationsPage from "./notifications";
import { useAdminPush } from "@/hooks/use-admin-push";

vi.mock("@/hooks/use-admin-push", () => ({
  useAdminPush: vi.fn(),
}));

const subscribe = vi.fn();
const unsubscribe = vi.fn();
const sendTest = vi.fn();

// Everything working, on a device that can subscribe. Each test overrides the
// one field it is about.
const pushState = (overrides: Partial<ReturnType<typeof useAdminPush>> = {}) => ({
  supported: true,
  configured: true,
  needsHomeScreen: false,
  permission: "default" as NotificationPermission,
  isSubscribed: false,
  isChecking: false,
  isBusy: false,
  isTesting: false,
  subscribe,
  unsubscribe,
  sendTest,
  ...overrides,
});

const renderPage = (overrides: Partial<ReturnType<typeof useAdminPush>> = {}) => {
  vi.mocked(useAdminPush).mockReturnValue(pushState(overrides));
  render(<NotificationsPage />);
};

describe("NotificationsPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("offers to register the device", async () => {
    renderPage();

    await userEvent.click(screen.getByRole("button", { name: "通知を受け取る" }));

    expect(subscribe).toHaveBeenCalled();
    // Test send is meaningless before there is a device to send to.
    expect(screen.queryByRole("button", { name: "テスト送信" })).toBeNull();
  });

  it("offers to stop and to test once the device is registered", async () => {
    renderPage({ isSubscribed: true });

    await userEvent.click(screen.getByRole("button", { name: "テスト送信" }));
    await userEvent.click(screen.getByRole("button", { name: "通知を停止する" }));

    expect(sendTest).toHaveBeenCalled();
    expect(unsubscribe).toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "通知を受け取る" })).toBeNull();
  });

  // No key deployed means nothing can be delivered, so the controls must not
  // invite the user to grant a permission that would achieve nothing.
  it("explains when the environment has push turned off", () => {
    renderPage({ configured: false });

    expect(screen.getByText(/設定されていません/)).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("explains when the browser cannot do push at all", () => {
    renderPage({ supported: false });

    expect(screen.getByText(/ご利用いただけません/)).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  // Re-prompting is pointless once the OS has recorded a refusal — iOS in
  // particular will not ask again for days.
  it("points at the OS settings when the permission was denied", () => {
    renderPage({ permission: "denied" });

    expect(screen.getByText(/通知が拒否されています/)).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("shows no controls while the current state is still being read", () => {
    renderPage({ isChecking: true });

    expect(screen.queryByRole("button")).toBeNull();
  });

  it("mentions the home screen only on a device that needs it", () => {
    renderPage({ needsHomeScreen: true });
    expect(screen.getByText(/ホーム画面に追加したアイコン/)).toBeTruthy();
  });

  it("does not mention the home screen on a desktop browser", () => {
    renderPage();
    expect(screen.queryByText(/ホーム画面に追加したアイコン/)).toBeNull();
  });

  it("disables the buttons while a request is in flight", () => {
    renderPage({ isSubscribed: true, isBusy: true, isTesting: true });

    expect(screen.getByRole("button", { name: "通知を停止する" }).hasAttribute("disabled")).toBe(
      true,
    );
    expect(screen.getByRole("button", { name: "テスト送信" }).hasAttribute("disabled")).toBe(true);
  });
});
