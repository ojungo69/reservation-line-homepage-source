import { useCallback, useEffect, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/lib/api-client";
import { showErrorToast } from "@/lib/error-messages";
import { useAuth } from "@/hooks/use-auth";
import type {
  AdminPushSubscribeRequest,
  AdminPushTestResponse,
  AdminPushUnsubscribeRequest,
  MutationOkResponse,
} from "@/types/api";

const SW_PATH = "/admin/sw.js";

/**
 * The VAPID public key travels as base64url text but `pushManager.subscribe`
 * wants raw bytes.
 */
const applicationServerKey = (base64Url: string): ArrayBuffer => {
  const padded = base64Url.padEnd(base64Url.length + ((4 - (base64Url.length % 4)) % 4), "=");
  const binary = atob(padded.replaceAll("-", "+").replaceAll("_", "/"));
  // atob yields Latin-1, so every char is a single code point — but codePointAt
  // is what does not silently split a surrogate pair if that ever stops holding.
  return Uint8Array.from(binary, (char) => char.codePointAt(0) ?? 0).buffer;
};

/**
 * Whether an existing subscription was made against the key we would use now.
 * Rotating the VAPID pair invalidates every subscription, and the browser keeps
 * handing back the stale one until something notices.
 */
const matchesServerKey = (subscription: PushSubscription, base64Url: string): boolean => {
  const applied = subscription.options?.applicationServerKey;
  // Not every browser exposes `options`; without it, assume the key is current
  // rather than dropping a working subscription.
  if (!applied) return true;
  const expected = new Uint8Array(applicationServerKey(base64Url));
  const actual = new Uint8Array(applied);
  return (
    expected.length === actual.length && expected.every((byte, i) => byte === actual[i])
  );
};

const pushSupported = () =>
  typeof navigator !== "undefined" &&
  "serviceWorker" in navigator &&
  typeof window !== "undefined" &&
  "PushManager" in window &&
  "Notification" in window;

/**
 * iOS only exposes Push to a web app launched from the home screen. Safari tabs
 * report the APIs as missing, but Chrome/Edge on iOS can report them present in
 * a normal tab and then fail at subscribe time — so the card also tells the user
 * about the home-screen requirement rather than relying on this alone.
 */
const isStandalone = () =>
  typeof window !== "undefined" &&
  (window.matchMedia?.("(display-mode: standalone)").matches === true ||
    (navigator as { standalone?: boolean }).standalone === true);

/**
 * The home-screen requirement is an iOS one. A desktop browser subscribes fine
 * from a normal tab, so telling that user about the home screen would just be
 * confusing. iPadOS reports itself as MacIntel — the touch points are the tell.
 */
const isIOS = () =>
  typeof navigator !== "undefined" &&
  (/iP(hone|ad|od)/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1));

/**
 * Re-register the subscription this browser already has against whoever is
 * signed in NOW, and report the endpoint the server confirmed.
 *
 * A browser subscription outlives the admin session, so without this the shared
 * shop tablet keeps delivering to the row of the person who first enabled
 * notifications on it, and a row the server dropped (a 410 during an offline
 * spell) never comes back. Never prompts — the permission is already granted.
 *
 * Memoized per page load so the notifications page and the app shell, which both
 * want this, produce one request between them rather than one each.
 */
let reconciliation: Promise<string | null> | null = null;

const reconcileSubscription = (vapidPublicKey: string): Promise<string | null> => {
  reconciliation ??= (async () => {
    const registration = await navigator.serviceWorker.getRegistration(SW_PATH);
    const existing = await registration?.pushManager.getSubscription();
    if (!existing) return null;
    const json = existing.toJSON();
    if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) return null;
    // A subscription made against a retired VAPID key can never be delivered
    // to. Report it as "not subscribed" so the button comes back and a fresh
    // subscribe replaces it.
    if (!matchesServerKey(existing, vapidPublicKey)) return null;
    await api.post<MutationOkResponse>("/api/admin/notifications/push/subscriptions", {
      endpoint: json.endpoint,
      p256dh: json.keys.p256dh,
      auth: json.keys.auth,
    });
    return json.endpoint;
  })();
  return reconciliation;
};

/** Test seam: the memo above is per page load, which a test process is not. */
export const resetAdminPushReconciliationForTest = () => {
  reconciliation = null;
};

/**
 * Mount this app-wide. The rebind has to happen wherever the admin lands, not
 * only if they open the notifications page — on a shared device the row stays
 * bound to the previous admin until it runs, and the wrong store's alerts keep
 * arriving in the meantime.
 */
export function useAdminPushReconcile() {
  const { vapidPublicKey } = useAuth();
  const supported = pushSupported();

  useEffect(() => {
    if (!supported || vapidPublicKey === "") return;
    void reconcileSubscription(vapidPublicKey).catch(() => undefined);
  }, [supported, vapidPublicKey]);
}

export function useAdminPush() {
  const { vapidPublicKey } = useAuth();
  const supported = pushSupported();
  const configured = vapidPublicKey !== "";

  const [permission, setPermission] = useState<NotificationPermission | "unsupported">(
    supported ? Notification.permission : "unsupported",
  );
  const [endpoint, setEndpoint] = useState<string | null>(null);
  const [isChecking, setIsChecking] = useState(supported);

  // Open the card in the right state after a reload. The endpoint comes from the
  // shared reconcile above, so the UI only claims "subscribed" once the SERVER
  // confirms the row — the browser object alone decides nothing.
  useEffect(() => {
    if (!supported) {
      setIsChecking(false);
      return;
    }
    let cancelled = false;
    void reconcileSubscription(vapidPublicKey)
      .then((confirmed) => {
        if (!cancelled) setEndpoint(confirmed);
      })
      .catch(() => {
        if (!cancelled) setEndpoint(null);
      })
      .finally(() => {
        if (!cancelled) setIsChecking(false);
      });
    return () => {
      cancelled = true;
    };
  }, [supported, vapidPublicKey]);

  const subscribeMutation = useMutation({
    mutationFn: (req: AdminPushSubscribeRequest) =>
      api.post<MutationOkResponse>("/api/admin/notifications/push/subscriptions", req),
    onError: (err) => showErrorToast(err, "通知の登録に失敗しました"),
  });

  const unsubscribeMutation = useMutation({
    mutationFn: (req: AdminPushUnsubscribeRequest) =>
      api.post<MutationOkResponse>("/api/admin/notifications/push/unsubscribe", req),
    onError: (err) => showErrorToast(err, "通知の解除に失敗しました"),
  });

  const testMutation = useMutation({
    mutationFn: () => api.post<AdminPushTestResponse>("/api/admin/notifications/push/test"),
    onSuccess: (result) => {
      if (result.sent > 0) {
        toast.success("テスト通知を送信しました");
        return;
      }
      // Zero sent with devices registered is a delivery failure, not an empty
      // list — saying "no device registered" would send the user looking in the
      // wrong place.
      if (result.devices > 0) {
        toast.error("登録済みの端末に送信できませんでした");
        return;
      }
      toast.warning("この端末はまだ登録されていません");
      setEndpoint(null);
    },
    onError: (err) => showErrorToast(err, "テスト通知の送信に失敗しました"),
  });

  const subscribe = useCallback(async () => {
    if (!supported || !configured) return;
    // Must run synchronously inside the click handler: iOS resolves
    // requestPermission() with "denied" — no error thrown — when it is not
    // triggered by a user gesture, and then refuses to prompt again for days.
    const granted = await Notification.requestPermission();
    setPermission(granted);
    if (granted !== "granted") {
      toast.error("通知が許可されませんでした");
      return;
    }

    try {
      const registration = await navigator.serviceWorker.register(SW_PATH);
      await navigator.serviceWorker.ready;
      let existing = await registration.pushManager.getSubscription();
      // The browser hands back a subscription made against a RETIRED VAPID key
      // forever unless it is explicitly dropped. Reusing it here would save the
      // stale keys and report success for a device that can never be delivered
      // to — the one case where this button silently does nothing.
      if (existing && !matchesServerKey(existing, vapidPublicKey)) {
        await existing.unsubscribe();
        existing = null;
      }
      const subscription =
        existing ??
        (await registration.pushManager.subscribe({
          // Required by every browser, and iOS additionally enforces it at
          // runtime: a push that shows no notification revokes the subscription.
          userVisibleOnly: true,
          applicationServerKey: applicationServerKey(vapidPublicKey),
        }));

      const json = subscription.toJSON();
      if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) {
        toast.error("この端末の通知情報を取得できませんでした");
        return;
      }
      await subscribeMutation.mutateAsync({
        endpoint: json.endpoint,
        p256dh: json.keys.p256dh,
        auth: json.keys.auth,
      });
      setEndpoint(json.endpoint);
      toast.success("この端末で通知を受け取ります");
    } catch (error) {
      showErrorToast(error, "通知の登録に失敗しました");
    }
  }, [supported, configured, vapidPublicKey, subscribeMutation]);

  const unsubscribe = useCallback(async () => {
    if (!supported) return;
    try {
      const registration = await navigator.serviceWorker.getRegistration(SW_PATH);
      const subscription = await registration?.pushManager.getSubscription();
      const target = subscription?.endpoint ?? endpoint;
      if (target) {
        // Tell the server first: if the browser-side unsubscribe succeeded but
        // the row survived, this device would keep receiving pushes with no UI
        // left to turn them off.
        await unsubscribeMutation.mutateAsync({ endpoint: target });
      }
      await subscription?.unsubscribe();
      setEndpoint(null);
      toast.success("この端末の通知を停止しました");
    } catch (error) {
      showErrorToast(error, "通知の解除に失敗しました");
    }
  }, [supported, endpoint, unsubscribeMutation]);

  return {
    supported,
    configured,
    needsHomeScreen: isIOS() && !isStandalone(),
    permission,
    isSubscribed: endpoint !== null,
    isChecking,
    isBusy: subscribeMutation.isPending || unsubscribeMutation.isPending,
    isTesting: testMutation.isPending,
    subscribe,
    unsubscribe,
    sendTest: () => testMutation.mutate(),
  };
}
