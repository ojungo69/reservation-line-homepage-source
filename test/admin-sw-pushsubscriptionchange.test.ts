import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

// The service worker is a plain script with no exports, so these tests load it
// the way a browser does: evaluate the source against a fake `self` and capture
// the listeners it registers. What is under test is the pushsubscriptionchange
// wiring — the browser rotating a subscription while no admin page is open must
// end in a POST that rebinds THIS device, or it silently stops receiving
// notifications (the gap found in the 2026-07-29 audit).

const SW_SOURCE = readFileSync(
  path.resolve(__dirname, "../admin-app/public/sw.js"),
  "utf8"
);

type Listener = (event: unknown) => void;
const fetchMockOf = (impl: (url: string, init?: RequestInit) => Promise<unknown>) =>
  vi.fn(impl);
type FetchMock = ReturnType<typeof fetchMockOf>;

const loadWorker = (fetchMock: FetchMock) => {
  const listeners = new Map<string, Listener>();
  const self = {
    addEventListener: (name: string, listener: Listener) => listeners.set(name, listener),
    skipWaiting: vi.fn(),
    clients: { claim: vi.fn(), matchAll: vi.fn(), openWindow: vi.fn() },
    registration: {
      showNotification: vi.fn(),
      pushManager: { subscribe: vi.fn() }
    }
  };
  // eslint-disable-next-line no-new-func -- evaluating the worker script is the point
  new Function("self", "fetch", SW_SOURCE)(self, fetchMock);
  return { listeners, self };
};

const subscriptionOf = (endpoint: string) => ({
  toJSON: () => ({ endpoint, keys: { p256dh: "p256dh-key", auth: "auth-key" } }),
  options: { applicationServerKey: new Uint8Array([1, 2, 3]).buffer }
});

const fireSubscriptionChange = async (
  listeners: Map<string, Listener>,
  event: Record<string, unknown>
) => {
  const listener = listeners.get("pushsubscriptionchange");
  expect(listener).toBeDefined();
  let settled: Promise<unknown> = Promise.resolve();
  listener!({
    ...event,
    waitUntil: (p: Promise<unknown>) => {
      settled = p;
    }
  });
  await settled;
};

describe("admin sw.js pushsubscriptionchange", () => {
  it("re-registers the replacement subscription the browser already made", async () => {
    const fetchMock = fetchMockOf(async () => ({ ok: true }));
    const { listeners, self } = loadWorker(fetchMock);

    await fireSubscriptionChange(listeners, {
      oldSubscription: subscriptionOf("https://push.example/old"),
      newSubscription: subscriptionOf("https://push.example/new")
    });

    expect(self.registration.pushManager.subscribe).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/admin/notifications/push/subscriptions");
    expect(init?.method).toBe("POST");
    expect(init?.credentials).toBe("same-origin");
    expect(JSON.parse(init?.body as string)).toEqual({
      endpoint: "https://push.example/new",
      p256dh: "p256dh-key",
      auth: "auth-key"
    });
  });

  it("resubscribes with the old VAPID key when the browser did not provide a replacement", async () => {
    const fetchMock = fetchMockOf(async () => ({ ok: true }));
    const { listeners, self } = loadWorker(fetchMock);
    self.registration.pushManager.subscribe.mockResolvedValue(
      subscriptionOf("https://push.example/resubscribed")
    );

    await fireSubscriptionChange(listeners, {
      oldSubscription: subscriptionOf("https://push.example/old")
    });

    expect(self.registration.pushManager.subscribe).toHaveBeenCalledWith({
      userVisibleOnly: true,
      applicationServerKey: expect.anything()
    });
    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init?.body as string).endpoint).toBe(
      "https://push.example/resubscribed"
    );
  });

  it("does nothing when the old subscription exposes no applicationServerKey", async () => {
    const fetchMock = fetchMockOf(async () => ({ ok: true }));
    const { listeners, self } = loadWorker(fetchMock);

    await fireSubscriptionChange(listeners, {
      oldSubscription: { toJSON: () => ({}), options: {} }
    });

    expect(self.registration.pushManager.subscribe).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("swallows a failed re-registration instead of rejecting waitUntil", async () => {
    const fetchMock = fetchMockOf(async () => {
      throw new Error("offline");
    });
    const { listeners } = loadWorker(fetchMock);

    await expect(
      fireSubscriptionChange(listeners, {
        oldSubscription: subscriptionOf("https://push.example/old"),
        newSubscription: subscriptionOf("https://push.example/new")
      })
    ).resolves.toBeUndefined();
  });
});
