// Service worker for the admin PWA. Its jobs: turn a Web Push message into a
// notification, focus the admin screen when that notification is tapped, and
// re-register the subscription when the browser rotates it.
//
// The response that serves this file carries ADMIN_SW_CSP (src/app.ts), which
// becomes this worker's own policy: `default-src 'none'` plus `connect-src
// 'self'`. Same-origin fetch() is the ONLY network opening — an icon URL or a
// cross-origin request added here would be blocked at runtime with no
// build-time error. There is no offline cache and no fetch handler on purpose:
// the admin screen is useless without the API anyway.

self.addEventListener("install", () => {
  // Take over without waiting for the old worker's clients to close, so a
  // deploy that changes this file starts delivering notifications immediately.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    // Malformed payload. Fall through to the generic notification below rather
    // than returning: Safari revokes the subscription after a few pushes that
    // produce no user-visible notification.
  }

  const title = typeof data.title === "string" && data.title ? data.title : "予約管理";
  const body = typeof data.body === "string" ? data.body : "";
  const url = typeof data.url === "string" && data.url.startsWith("/") ? data.url : "/admin/";

  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      // Same tag collapses repeats of one event instead of stacking them.
      tag: typeof data.tag === "string" ? data.tag : undefined,
      data: { url }
    })
  );
});

// The browser can rotate or invalidate a push subscription on its own (key
// rotation, push-service migration) while no admin page is open — the
// page-level reconcile in use-admin-push.ts never sees that. Without this
// handler the server keeps POSTing to the dead endpoint until the 410 sweep
// drops the row, and this device silently stops receiving notifications.
self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil(
    (async () => {
      const applicationServerKey =
        event.oldSubscription?.options?.applicationServerKey ?? undefined;
      let subscription = event.newSubscription ?? null;
      if (!subscription) {
        // Without the old subscription's VAPID key we cannot resubscribe from
        // here; the next admin visit's reconcile registers whatever the
        // browser holds then.
        if (!applicationServerKey) return;
        subscription = await self.registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey
        });
      }

      const json = subscription.toJSON();
      if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) return;
      // Same-origin POST rides the session cookie; Cloudflare Access covers
      // the edge the same way it does for the page's own API calls. The old
      // endpoint row is not deleted here — the server's 410 cleanup reaps it
      // on the next delivery attempt.
      await fetch("/api/admin/notifications/push/subscriptions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          endpoint: json.endpoint,
          p256dh: json.keys.p256dh,
          auth: json.keys.auth
        })
      });
    })().catch(() => {
      // Best effort: offline or an expired session lands here. The page-level
      // reconcile re-registers the browser's current subscription on the next
      // admin visit, so failure is deferred, not fatal.
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = event.notification.data?.url ?? "/admin/";

  event.waitUntil(
    (async () => {
      const clientList = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true
      });
      // Reuse an open admin window when there is one — on iOS a second
      // openWindow() can land in Safari instead of the home-screen app.
      for (const client of clientList) {
        if (client.url.includes("/admin") && "focus" in client) {
          await client.focus();
          if ("navigate" in client) {
            await client.navigate(target).catch(() => {});
          }
          return;
        }
      }
      await self.clients.openWindow(target);
    })()
  );
});
