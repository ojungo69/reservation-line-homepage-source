import type { PropsWithChildren } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestQueryClient as createClient } from "@/test-utils/query-client";
import { mocks } from "@/test-utils/hook-mocks";
import { resetAdminPushReconciliationForTest, useAdminPush } from "./use-admin-push";
import { AuthContext, type AuthContextValue } from "@/providers/auth-context";

// 65 bytes of the right shape (0x04 + 64), built rather than pasted: the hook
// only base64url-decodes it, and a random-looking literal reads as live key
// material to a secret scanner.
const VAPID = btoa(String.fromCharCode(4, ...Array.from({ length: 64 }, (_, i) => i)))
  .replaceAll("+", "-")
  .replaceAll("/", "_")
  .replace(/=+$/, "");

const authValue = (vapidPublicKey: string): AuthContextValue => ({
  user: { email: "owner@example.com", role: "owner", staffMemberId: null, storeId: null },
  isPrivileged: true,
  vapidPublicKey,
});

const createWrapper = (vapidPublicKey: string) => {
  const client = createClient();
  return function Wrapper({ children }: PropsWithChildren) {
    return (
      <QueryClientProvider client={client}>
        <AuthContext value={authValue(vapidPublicKey)}>{children}</AuthContext>
      </QueryClientProvider>
    );
  };
};

/** Minimal stand-ins for the browser push APIs jsdom does not implement. */
const installPushApis = (options: { permission: NotificationPermission; endpoint?: string }) => {
  const subscription = {
    endpoint: options.endpoint ?? "https://web.push.apple.com/QAAAAA_hook_test",
    toJSON: () => ({
      endpoint: options.endpoint ?? "https://web.push.apple.com/QAAAAA_hook_test",
      keys: { p256dh: "p256dh-value", auth: "auth-value" },
    }),
    unsubscribe: vi.fn(async () => true),
  };
  const registration = {
    pushManager: {
      getSubscription: vi.fn<() => Promise<unknown>>(async () => null),
      subscribe: vi.fn(async () => subscription),
    },
  };
  const requestPermission = vi.fn(async () => options.permission);

  vi.stubGlobal("Notification", { permission: "default", requestPermission });
  vi.stubGlobal("PushManager", class {});
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: {
      register: vi.fn(async () => registration),
      getRegistration: vi.fn(async () => registration),
      ready: Promise.resolve(registration),
    },
  });

  return { registration, requestPermission, subscription };
};

const removePushApis = () => {
  vi.unstubAllGlobals();
  Reflect.deleteProperty(navigator, "serviceWorker");
};

describe("useAdminPush", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    removePushApis();
    // The reconcile is memoized per page load; a test process is many.
    resetAdminPushReconciliationForTest();
  });

  it("reports the feature as unavailable when the browser has no push APIs", async () => {
    const { result } = renderHook(() => useAdminPush(), { wrapper: createWrapper(VAPID) });

    await waitFor(() => expect(result.current.isChecking).toBe(false));
    expect(result.current.supported).toBe(false);

    await act(async () => {
      await result.current.subscribe();
    });
    expect(mocks.api.post).not.toHaveBeenCalled();
  });

  // Without a key the SPA cannot build a subscription at all, so the card has to
  // stay off rather than prompting the user for a permission it cannot use.
  it("stays off when the deployment has no VAPID public key", async () => {
    installPushApis({ permission: "granted" });
    const { result } = renderHook(() => useAdminPush(), { wrapper: createWrapper("") });

    await waitFor(() => expect(result.current.isChecking).toBe(false));
    expect(result.current.configured).toBe(false);

    await act(async () => {
      await result.current.subscribe();
    });
    expect(mocks.api.post).not.toHaveBeenCalled();
  });

  it("does not register the device when the user declines the permission prompt", async () => {
    const { requestPermission } = installPushApis({ permission: "denied" });
    const { result } = renderHook(() => useAdminPush(), { wrapper: createWrapper(VAPID) });

    await waitFor(() => expect(result.current.isChecking).toBe(false));
    await act(async () => {
      await result.current.subscribe();
    });

    expect(requestPermission).toHaveBeenCalled();
    expect(mocks.api.post).not.toHaveBeenCalled();
    expect(mocks.toast.error).toHaveBeenCalled();
  });

  it("registers the device once permission is granted", async () => {
    installPushApis({ permission: "granted" });
    mocks.api.post.mockResolvedValue({ ok: true });
    const { result } = renderHook(() => useAdminPush(), { wrapper: createWrapper(VAPID) });

    await waitFor(() => expect(result.current.isChecking).toBe(false));
    await act(async () => {
      await result.current.subscribe();
    });

    expect(mocks.api.post).toHaveBeenCalledWith("/api/admin/notifications/push/subscriptions", {
      endpoint: "https://web.push.apple.com/QAAAAA_hook_test",
      p256dh: "p256dh-value",
      auth: "auth-value",
    });
    await waitFor(() => expect(result.current.isSubscribed).toBe(true));
  });

  // A browser subscription outlives the admin session. Without this the shared
  // shop tablet keeps delivering to whoever enabled notifications on it first,
  // and a row the server dropped never comes back.
  it("re-registers an existing subscription against the admin signed in now", async () => {
    const { subscription, registration } = installPushApis({ permission: "granted" });
    registration.pushManager.getSubscription.mockResolvedValue(subscription);
    mocks.api.post.mockResolvedValue({ ok: true });
    const { result } = renderHook(() => useAdminPush(), { wrapper: createWrapper(VAPID) });

    await waitFor(() =>
      expect(mocks.api.post).toHaveBeenCalledWith("/api/admin/notifications/push/subscriptions", {
        endpoint: subscription.endpoint,
        p256dh: "p256dh-value",
        auth: "auth-value",
      }),
    );
    expect(result.current.isSubscribed).toBe(true);
  });

  // Rotating the VAPID pair invalidates every subscription, but the browser goes
  // on handing back the stale one. Reporting it as subscribed would leave the
  // user with a device that can never be delivered to and no button to fix it.
  it("treats a subscription made against a retired key as not subscribed", async () => {
    const { subscription, registration } = installPushApis({ permission: "granted" });
    const retired = new Uint8Array(65).fill(9).buffer;
    registration.pushManager.getSubscription.mockResolvedValue({
      ...subscription,
      options: { applicationServerKey: retired },
    });
    const { result } = renderHook(() => useAdminPush(), { wrapper: createWrapper(VAPID) });

    await waitFor(() => expect(result.current.isChecking).toBe(false));
    expect(result.current.isSubscribed).toBe(false);
    expect(mocks.api.post).not.toHaveBeenCalled();
  });

  // "0 sent" has two very different causes and the button exists to tell them
  // apart: nothing registered vs. registered and failing.
  it("distinguishes an empty device list from a failed delivery", async () => {
    const { subscription, registration } = installPushApis({ permission: "granted" });
    registration.pushManager.getSubscription.mockResolvedValue(subscription);
    mocks.api.post.mockResolvedValue({ ok: true, devices: 2, sent: 0 });
    const { result } = renderHook(() => useAdminPush(), { wrapper: createWrapper(VAPID) });

    await waitFor(() => expect(result.current.isSubscribed).toBe(true));
    await act(async () => {
      result.current.sendTest();
    });
    await waitFor(() => expect(mocks.toast.error).toHaveBeenCalled());

    mocks.api.post.mockResolvedValue({ ok: true, devices: 0, sent: 0 });
    await act(async () => {
      result.current.sendTest();
    });
    await waitFor(() => expect(mocks.toast.warning).toHaveBeenCalled());
  });

  // Server first: a browser-side unsubscribe that leaves the row behind would
  // keep this device buzzing with no UI left to turn it off.
  it("tells the server before unsubscribing in the browser", async () => {
    const { subscription, registration } = installPushApis({ permission: "granted" });
    registration.pushManager.getSubscription.mockResolvedValue(subscription);
    mocks.api.post.mockResolvedValue({ ok: true });
    const { result } = renderHook(() => useAdminPush(), { wrapper: createWrapper(VAPID) });

    await waitFor(() => expect(result.current.isSubscribed).toBe(true));
    await act(async () => {
      await result.current.unsubscribe();
    });

    expect(mocks.api.post).toHaveBeenCalledWith("/api/admin/notifications/push/unsubscribe", {
      endpoint: subscription.endpoint,
    });
    expect(subscription.unsubscribe).toHaveBeenCalled();
  });
});
