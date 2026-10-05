import type { AdminUser } from "../src/admin/access";
import { generateVAPIDKeys } from "web-push-neo";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildAdminPushPayload,
  deletePushSubscription,
  dispatchExpiringApprovalPush,
  normalizePushEndpoint,
  parsePushSubscription,
  savePushSubscription,
  sendAdminPushTest,
} from "../src/notifications/admin-push";
import { createMigratedSqliteD1, type SqliteD1Database } from "./helpers/sqlite-d1";

// A real Apple endpoint shape. The suffix is opaque to us, only the host matters.
const APPLE_ENDPOINT = "https://web.push.apple.com/QAAAAA_test_endpoint_1";
const APPLE_ENDPOINT_2 = "https://web.push.apple.com/QAAAAA_test_endpoint_2";

// Nothing key-shaped is written as a literal here. A real VAPID private key in
// the repository would be a live secret; the rest are high-entropy strings that
// look exactly like one to a scanner and would train everyone to ignore it.
//
// p256dh must be a genuine 65-byte P-256 point because registration imports it,
// so it is generated. auth is any 16 bytes, so it comes from readable text.
const AUTH = btoa("test-auth-secret").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
let P256DH = "";
let VAPID_PUBLIC = "";
let VAPID_PRIVATE = "";

beforeAll(async () => {
  const keys = await generateVAPIDKeys();
  VAPID_PUBLIC = keys.publicKey;
  VAPID_PRIVATE = keys.privateKey;
  // A VAPID public key IS a raw uncompressed P-256 point — the same shape
  // pushManager.subscribe() hands back as p256dh.
  P256DH = (await generateVAPIDKeys()).publicKey;
});

const pushEnv = (overrides: Record<string, string | undefined> = {}) => ({
  VAPID_PUBLIC_KEY: VAPID_PUBLIC,
  VAPID_PRIVATE_KEY: VAPID_PRIVATE,
  OPERATIONS_NOTIFICATION_EMAIL: "ops@example.com",
  ...overrides,
});

// seeds/dev.sql already creates the four real stores, so this upserts the name
// instead of failing on the primary key.
const seedStore = (db: SqliteD1Database, id: string, name: string) => {
  db.sqlite
    .prepare(
      `INSERT INTO stores (id, name, timezone) VALUES (?, ?, 'Asia/Tokyo')
       ON CONFLICT(id) DO UPDATE SET name = excluded.name`
    )
    .run(id, name);
};

const seedAdmin = (
  db: SqliteD1Database,
  options: {
    id: string;
    role: "owner" | "staff" | "system_admin";
    staffMemberId?: string | null;
    active?: 0 | 1;
    isServiceToken?: 0 | 1;
  }
) => {
  db.sqlite
    .prepare(
      `INSERT INTO admin_users (id, staff_member_id, email, access_subject, role, active, is_service_token, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, '2026-07-27T00:00:00.000Z')`
    )
    .run(
      options.id,
      options.staffMemberId ?? null,
      `${options.id}@example.com`,
      `sub_${options.id}`,
      options.role,
      options.active ?? 1,
      options.isServiceToken ?? 0
    );
};

const seedStaffMember = (db: SqliteD1Database, id: string, storeId: string) => {
  db.sqlite
    .prepare(
      "INSERT INTO staff_members (id, store_id, display_name, role, active) VALUES (?, ?, ?, 'staff', 1)"
    )
    .run(id, storeId, id);
};

const seedSubscription = (db: SqliteD1Database, endpoint: string, adminUserId: string) => {
  db.sqlite
    .prepare(
      "INSERT INTO admin_push_subscriptions (endpoint, admin_user_id, p256dh, auth) VALUES (?, ?, ?, ?)"
    )
    .run(endpoint, adminUserId, P256DH, AUTH);
};

// seeds/dev.sql already provides a service, a resource and the stores for every
// store id used here, so this only adds the customer and the reservation itself.
const seedReservation = (
  db: SqliteD1Database,
  options: {
    id: string;
    storeId: string;
    status?: string;
    startAt?: string;
    pendingExpiresAt?: string | null;
    pushedAt?: string | null;
  }
) => {
  db.sqlite
    .prepare(
      "INSERT OR IGNORE INTO customers (id, display_name, phone_normalized, phone_hash) VALUES (?, ?, ?, ?)"
    )
    .run("cus_1", "山田花子", "09012345678", "hash_1");
  db.sqlite
    .prepare(
      `INSERT INTO reservations
         (id, store_id, service_id, customer_id, resource_id, source, status, start_at, end_at,
          duration_minutes, idempotency_key, pending_expires_at, approval_expiry_pushed_at)
       VALUES (?, ?, ?, 'cus_1', ?, 'web_line', ?, ?, ?, 60, ?, ?, ?)`
    )
    .run(
      options.id,
      options.storeId,
      `service_${options.storeId}_default_60`,
      `resource_${options.storeId}_calendar`,
      options.status ?? "pending_approval",
      options.startAt ?? "2026-08-01T02:00:00.000Z",
      options.startAt ?? "2026-08-01T03:00:00.000Z",
      `idem_${options.id}`,
      options.pendingExpiresAt ?? null,
      options.pushedAt ?? null
    );
};

describe("admin web push", () => {
  let db: SqliteD1Database;

  beforeEach(() => {
    db = createMigratedSqliteD1();
  });

  describe("payload", () => {
    // The single most important property of this feature: a push notification is
    // rendered on a lock screen and decrypted by a device we do not control.
    it("carries the store and the appointment time only — never customer data", () => {
      const payload = buildAdminPushPayload({
        event: "reservation_created",
        reservationId: "res_1",
        storeName: "京都店",
        startAt: "2026-08-01T02:00:00.000Z",
        timezone: "Asia/Tokyo",
      });

      const rendered = `${payload.title}\n${payload.body}`;
      expect(rendered).toContain("京都店");
      expect(rendered).toContain("11:00");
      for (const leak of ["山田", "090", "@", "全身脱毛", "res_1"]) {
        expect(payload.body).not.toContain(leak);
      }
      expect(payload.url).toBe("/admin/reservations");
    });

  });

  describe("endpoint allow-list", () => {
    it("accepts the real push services", () => {
      expect(normalizePushEndpoint(APPLE_ENDPOINT)).toBe(APPLE_ENDPOINT);
      expect(normalizePushEndpoint("https://fcm.googleapis.com/fcm/send/abc")).not.toBeNull();
      expect(
        normalizePushEndpoint("https://updates.push.services.mozilla.com/wpush/v2/abc")
      ).not.toBeNull();
      expect(
        normalizePushEndpoint("https://wns2-par02p.notify.windows.com/w/?token=abc")
      ).not.toBeNull();
    });

    it("rejects anything else, so a signed-in admin cannot aim the Worker at a host of their choosing", () => {
      expect(normalizePushEndpoint("https://attacker.example.com/collect")).toBeNull();
      expect(normalizePushEndpoint("http://web.push.apple.com/x")).toBeNull();
      expect(normalizePushEndpoint("https://web.push.apple.com.attacker.example.com/x")).toBeNull();
      expect(normalizePushEndpoint("not a url")).toBeNull();
      // Credentials in the URL clear a hostname check but make a Request that
      // fetch() refuses to construct, so the row could only ever be dead weight.
      expect(normalizePushEndpoint("https://evil@web.push.apple.com/x")).toBeNull();
    });

    // Two spellings of one endpoint would otherwise take two PRIMARY KEY rows
    // and the "re-registering this device rebinds it" upsert would never fire.
    it("normalizes so the same device cannot occupy two rows", () => {
      expect(normalizePushEndpoint(`${APPLE_ENDPOINT}#frag`)).toBe(APPLE_ENDPOINT);
      expect(normalizePushEndpoint("https://web.push.apple.com:443/QAAAAA_test_endpoint_1")).toBe(
        APPLE_ENDPOINT
      );
    });

    // The key sizes are fixed by RFC 8291. Checking base64url character counts
    // instead would admit values that only fail later, at send time.
    it("requires keys that decode to the exact Web Push sizes", async () => {
      const valid = { endpoint: APPLE_ENDPOINT, p256dh: P256DH, auth: AUTH };
      await expect(parsePushSubscription(valid)).resolves.toEqual(valid);
      await expect(parsePushSubscription({ ...valid, p256dh: P256DH.slice(0, 80) })).resolves.toBeNull();
      await expect(parsePushSubscription({ ...valid, auth: `${AUTH}AAAA` })).resolves.toBeNull();
      await expect(
        parsePushSubscription({ ...valid, auth: "not base64url!!!!!!!!!" })
      ).resolves.toBeNull();
      await expect(parsePushSubscription({ ...valid, endpoint: 42 })).resolves.toBeNull();
      // 65 bytes of the right shape but not a point on P-256: accepted by a
      // length check, then fatal inside the encryption on every single send.
      await expect(
        parsePushSubscription({ ...valid, p256dh: `BA${"A".repeat(85)}` })
      ).resolves.toBeNull();
    });
  });

  describe("sending", () => {
    it("does nothing at all when the VAPID keys are not configured", async () => {
      seedAdmin(db, { id: "admin_owner", role: "owner" });
      seedSubscription(db, APPLE_ENDPOINT, "admin_owner");
      const fetcher = vi.fn();

      const sent = await sendAdminPushTest(
        pushEnv({ VAPID_PRIVATE_KEY: undefined }),
        db as unknown as D1Database,
        pushActor("admin_owner"),
        fetcher as unknown as typeof fetch
      );

      expect(sent).toEqual({ ok: true, devices: 1, sent: 0 });
      expect(fetcher).not.toHaveBeenCalled();
    });

    it("drops the subscription when the push service reports it gone", async () => {
      seedAdmin(db, { id: "admin_owner", role: "owner" });
      seedSubscription(db, APPLE_ENDPOINT, "admin_owner");
      const fetcher = vi.fn(async (_url: string) => new Response(null, { status: 410 }));

      const sent = await sendAdminPushTest(
        pushEnv(),
        db as unknown as D1Database,
        pushActor("admin_owner"),
        fetcher as unknown as typeof fetch
      );

      expect(sent).toEqual({ ok: true, devices: 1, sent: 0 });
      expect(
        db.sqlite.prepare("SELECT COUNT(*) AS n FROM admin_push_subscriptions").get()
      ).toEqual({ n: 0 });
    });

    it("keeps the subscription on a retryable failure", async () => {
      seedAdmin(db, { id: "admin_owner", role: "owner" });
      seedSubscription(db, APPLE_ENDPOINT, "admin_owner");
      const fetcher = vi.fn(async (_url: string) => new Response(null, { status: 429 }));

      await sendAdminPushTest(
        pushEnv(),
        db as unknown as D1Database,
        pushActor("admin_owner"),
        fetcher as unknown as typeof fetch
      );

      expect(
        db.sqlite.prepare("SELECT COUNT(*) AS n FROM admin_push_subscriptions").get()
      ).toEqual({ n: 1 });
    });

    it.each([
      { change: "owner", owner: "admin_other", rotatePublicKey: false, rotateAuth: false },
      { change: "public key", owner: "admin_owner", rotatePublicKey: true, rotateAuth: false },
      { change: "auth key", owner: "admin_owner", rotatePublicKey: false, rotateAuth: true },
      { change: "owner and keys", owner: "admin_other", rotatePublicKey: true, rotateAuth: true },
    ])("preserves a subscription with changed $change when an old send returns 410", async ({ owner, rotatePublicKey, rotateAuth }) => {
      seedAdmin(db, { id: "admin_owner", role: "owner" });
      seedAdmin(db, { id: "admin_other", role: "owner" });
      seedSubscription(db, APPLE_ENDPOINT, "admin_owner");
      const p256dh = rotatePublicKey ? (await generateVAPIDKeys()).publicKey : P256DH;
      const auth = rotateAuth ? Buffer.from("next-auth-secret").toString("base64url") : AUTH;
      const fetcher = vi.fn(async () => {
        // The old request is in flight while the shared device is rebound and
        // its current owner registers fresh keys through the real service.
        expect(await savePushSubscription(db as unknown as D1Database, pushActor(owner), {
          endpoint: APPLE_ENDPOINT, p256dh: P256DH, auth: AUTH,
        })).toEqual({ ok: true });
        if (rotatePublicKey || rotateAuth) {
          expect(await savePushSubscription(db as unknown as D1Database, pushActor(owner), {
            endpoint: APPLE_ENDPOINT, p256dh, auth,
          })).toEqual({ ok: true });
        }
        return new Response(null, { status: 410 });
      });

      expect(await sendAdminPushTest(pushEnv(), db as unknown as D1Database, pushActor("admin_owner"), fetcher))
        .toEqual({ ok: true, devices: 1, sent: 0 });
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(db.sqlite.prepare("SELECT admin_user_id, p256dh, auth FROM admin_push_subscriptions WHERE endpoint = ?").get(APPLE_ENDPOINT))
        .toEqual({ admin_user_id: owner, p256dh, auth });
    });

    it("still removes the same expired subscription after its actor is revoked", async () => {
      seedAdmin(db, { id: "admin_owner", role: "owner" });
      seedSubscription(db, APPLE_ENDPOINT, "admin_owner");
      const fetcher = vi.fn(async () => {
        db.sqlite.exec("UPDATE admin_users SET active = 0 WHERE id = 'admin_owner'");
        return new Response(null, { status: 410 });
      });

      expect(await sendAdminPushTest(pushEnv(), db as unknown as D1Database, pushActor("admin_owner"), fetcher))
        .toEqual({ ok: true, devices: 1, sent: 0 });
      expect(db.sqlite.prepare("SELECT COUNT(*) AS n FROM admin_push_subscriptions").get()).toEqual({ n: 0 });
    });

    // Workers' fetch implements only "follow" and "manual" — passing "error"
    // throws a TypeError before the request is even made, which is exactly how
    // every push send failed in production on 2026-07-29 (devices registered,
    // sent always 0). "manual" keeps the security property the option is there
    // for: a redirect comes back as the response instead of being followed, so
    // the VAPID-signed request never travels to a host the allow-list never saw.
    it('sends with redirect "manual", the only non-following mode Workers implements', async () => {
      seedAdmin(db, { id: "admin_owner", role: "owner" });
      seedSubscription(db, APPLE_ENDPOINT, "admin_owner");
      const fetcher = vi.fn(async (_url: string, _init?: RequestInit) =>
        new Response(null, { status: 201 })
      );

      await sendAdminPushTest(
        pushEnv(),
        db as unknown as D1Database,
        pushActor("admin_owner"),
        fetcher as unknown as typeof fetch
      );

      expect(fetcher.mock.calls[0]?.[1]?.redirect).toBe("manual");
    });

    it("only ever tests the caller's own devices", async () => {
      seedAdmin(db, { id: "admin_owner", role: "owner" });
      seedAdmin(db, { id: "admin_other", role: "owner" });
      seedSubscription(db, APPLE_ENDPOINT, "admin_owner");
      seedSubscription(db, APPLE_ENDPOINT_2, "admin_other");
      const fetcher = vi.fn(async (_url: string) => new Response(null, { status: 201 }));

      const sent = await sendAdminPushTest(
        pushEnv(),
        db as unknown as D1Database,
        pushActor("admin_owner"),
        fetcher as unknown as typeof fetch
      );

      expect(sent).toEqual({ ok: true, devices: 1, sent: 1 });
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(fetcher.mock.calls[0]?.[0]).toBe(APPLE_ENDPOINT);
    });
  });

  describe("subscription rows", () => {
    it("rebinds the row when the same device registers again", async () => {
      seedAdmin(db, { id: "admin_owner", role: "owner" });
      await savePushSubscription(db as unknown as D1Database, pushActor("admin_owner"), {
        endpoint: APPLE_ENDPOINT,
        p256dh: P256DH,
        auth: AUTH,
      });
      await savePushSubscription(db as unknown as D1Database, pushActor("admin_owner"), {
        endpoint: APPLE_ENDPOINT,
        p256dh: P256DH,
        auth: "rotated_auth_secret_x",
      });

      const rows = db.sqlite.prepare("SELECT auth FROM admin_push_subscriptions").all();
      expect(rows).toEqual([{ auth: "rotated_auth_secret_x" }]);
    });

    // The shop tablet gets handed between staff; whoever is signed in should be
    // the one hearing its notifications. Possession of the subscription's own
    // keys is what proves the caller is that device.
    it("rebinds a shared device to the admin who registers it next", async () => {
      seedAdmin(db, { id: "admin_a", role: "owner" });
      seedAdmin(db, { id: "admin_b", role: "owner" });
      seedSubscription(db, APPLE_ENDPOINT, "admin_a");

      await savePushSubscription(db as unknown as D1Database, pushActor("admin_b"), {
        endpoint: APPLE_ENDPOINT,
        p256dh: P256DH,
        auth: AUTH,
      });

      expect(
        db.sqlite.prepare("SELECT admin_user_id FROM admin_push_subscriptions").get()
      ).toEqual({ admin_user_id: "admin_b" });
    });

    // An endpoint on its own leaks easily (a log line, a screenshot). Without
    // the keys it must not be enough to point someone else's device at you.
    it("refuses to take over a device when the subscription keys do not match", async () => {
      seedAdmin(db, { id: "admin_a", role: "owner" });
      seedAdmin(db, { id: "admin_thief", role: "owner" });
      seedSubscription(db, APPLE_ENDPOINT, "admin_a");

      await savePushSubscription(db as unknown as D1Database, pushActor("admin_thief"), {
        endpoint: APPLE_ENDPOINT,
        p256dh: P256DH.replace(/.$/, "Z"),
        auth: "guessed_auth_secretX",
      });

      expect(
        db.sqlite.prepare("SELECT admin_user_id, auth FROM admin_push_subscriptions").get()
      ).toEqual({ admin_user_id: "admin_a", auth: AUTH });
    });

    // Registration is open to every signed-in admin, so the row count needs a
    // ceiling — otherwise every booking fans out over as many POSTs as someone
    // cared to register.
    it("keeps only the newest devices per admin", async () => {
      seedAdmin(db, { id: "admin_owner", role: "owner" });
      for (let i = 0; i < 14; i += 1) {
        await savePushSubscription(db as unknown as D1Database, pushActor("admin_owner"), {
          endpoint: `https://web.push.apple.com/QAAAAA_device_${i}`,
          p256dh: P256DH,
          auth: AUTH,
        });
      }

      const rows = db.sqlite
        .prepare("SELECT endpoint FROM admin_push_subscriptions WHERE admin_user_id = ?")
        .all("admin_owner") as { endpoint: string }[];
      expect(rows).toHaveLength(10);
      expect(rows.map((r) => r.endpoint)).toContain(
        "https://web.push.apple.com/QAAAAA_device_13"
      );
    });

    // The rebind and the per-admin trim run in one batch. If the rebound row
    // kept its original timestamp it could be the oldest of the eleven and get
    // deleted on the spot, with the API still answering ok.
    it("keeps a rebound device when the new owner is already at the limit", async () => {
      seedAdmin(db, { id: "admin_a", role: "owner" });
      seedAdmin(db, { id: "admin_b", role: "owner" });
      db.sqlite
        .prepare(
          "INSERT INTO admin_push_subscriptions (endpoint, admin_user_id, p256dh, auth, created_at) VALUES (?, 'admin_a', ?, ?, '2020-01-01T00:00:00Z')"
        )
        .run(APPLE_ENDPOINT, P256DH, AUTH);
      for (let i = 0; i < 10; i += 1) {
        await savePushSubscription(db as unknown as D1Database, pushActor("admin_b"), {
          endpoint: `https://web.push.apple.com/QAAAAA_b_${i}`,
          p256dh: P256DH,
          auth: AUTH,
        });
      }

      await savePushSubscription(db as unknown as D1Database, pushActor("admin_b"), {
        endpoint: APPLE_ENDPOINT,
        p256dh: P256DH,
        auth: AUTH,
      });

      const row = db.sqlite
        .prepare("SELECT admin_user_id FROM admin_push_subscriptions WHERE endpoint = ?")
        .get(APPLE_ENDPOINT);
      expect(row).toEqual({ admin_user_id: "admin_b" });
    });

    it("refuses to delete another admin's subscription", async () => {
      seedAdmin(db, { id: "admin_owner", role: "owner" });
      seedAdmin(db, { id: "admin_other", role: "owner" });
      seedSubscription(db, APPLE_ENDPOINT, "admin_other");

      await deletePushSubscription(db as unknown as D1Database, pushActor("admin_owner"), APPLE_ENDPOINT);

      expect(
        db.sqlite.prepare("SELECT COUNT(*) AS n FROM admin_push_subscriptions").get()
      ).toEqual({ n: 1 });
    });
  });

  describe("expiring approvals", () => {
    const NOW = Date.parse("2026-07-27T10:00:00.000Z");
    const iso = (offsetMinutes: number) => new Date(NOW + offsetMinutes * 60_000).toISOString();

    const runDispatch = (fetcher: ReturnType<typeof vi.fn>, atMs: number = NOW) =>
      dispatchExpiringApprovalPush(
        pushEnv(),
        db as unknown as D1Database,
        atMs,
        fetcher as unknown as typeof fetch
      );

    beforeEach(() => {
      seedStore(db, "kyoto", "京都店");
      seedAdmin(db, { id: "admin_owner", role: "owner" });
      seedSubscription(db, APPLE_ENDPOINT, "admin_owner");
    });

    it("pushes only reservations expiring inside the next hour", async () => {
      seedReservation(db, { id: "res_soon", storeId: "kyoto", pendingExpiresAt: iso(30) });
      seedReservation(db, { id: "res_later", storeId: "kyoto", pendingExpiresAt: iso(90) });
      seedReservation(db, { id: "res_past", storeId: "kyoto", pendingExpiresAt: iso(-5) });
      const fetcher = vi.fn(async (_url: string) => new Response(null, { status: 201 }));

      expect(await runDispatch(fetcher)).toBe(1);
      expect(fetcher).toHaveBeenCalledTimes(1);
    });

    it("preserves a rebound device when an earlier cron push returns 410", async () => {
      seedAdmin(db, { id: "admin_other", role: "owner" });
      seedReservation(db, { id: "res_soon", storeId: "kyoto", pendingExpiresAt: iso(30) });
      const fetcher = vi.fn(async () => {
        expect(await savePushSubscription(db as unknown as D1Database, pushActor("admin_other"), {
          endpoint: APPLE_ENDPOINT, p256dh: P256DH, auth: AUTH,
        })).toEqual({ ok: true });
        return new Response(null, { status: 410 });
      });

      expect(await runDispatch(fetcher)).toBe(0);
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(db.sqlite.prepare("SELECT admin_user_id FROM admin_push_subscriptions WHERE endpoint = ?").get(APPLE_ENDPOINT))
        .toEqual({ admin_user_id: "admin_other" });
    });

    // Every reservation in a tick fans out to that store's devices in the SAME
    // invocation the LINE dispatcher shares — so the batch stays small as an
    // operational bound and the leftovers wait for the next tick.
    it("leaves the overflow of a large batch for the next tick", async () => {
      for (let i = 0; i < 6; i += 1) {
        seedReservation(db, {
          id: `res_bulk_${i}`,
          storeId: "kyoto",
          pendingExpiresAt: iso(10 + i),
        });
      }
      const fetcher = vi.fn(async (_url: string) => new Response(null, { status: 201 }));

      expect(await runDispatch(fetcher)).toBe(4);
      const remaining = db.sqlite
        .prepare(
          "SELECT COUNT(*) AS n FROM reservations WHERE approval_expiry_pushed_at IS NULL AND id LIKE 'res_bulk_%'"
        )
        .get() as { n: number };
      expect(remaining.n).toBe(2);

      // The next tick picks them up; nothing is dropped.
      expect(await runDispatch(fetcher)).toBe(2);
    });

    it("defers whole reservations over the tick budget and delivers them in full next tick", async () => {
      for (let i = 1; i < 70; i += 1) {
        seedSubscription(db, `https://web.push.apple.com/QAAAAA_budget_${i}`, "admin_owner");
      }
      for (let i = 0; i < 4; i += 1) {
        seedReservation(db, {
          id: `res_budget_${i}`,
          storeId: "kyoto",
          pendingExpiresAt: iso(10 + i),
        });
      }
      const fetcher = vi.fn(async (_url: string) => new Response(null, { status: 201 }));
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

      try {
        // 4 × 70 devices against a budget of 250: the first three reservations
        // fit (210), the fourth must NOT be stamped-and-truncated — it stays
        // unstamped for the next tick.
        expect(await runDispatch(fetcher)).toBe(210);
        expect(fetcher).toHaveBeenCalledTimes(210);
        expect(warn).toHaveBeenCalledWith("admin_push_expiring_fanout_deferred", {
          limit: 250,
          deferred: 1,
        });
        expect(
          db.sqlite
            .prepare(
              "SELECT approval_expiry_pushed_at FROM reservations WHERE id = 'res_budget_3'"
            )
            .get()
        ).toEqual({ approval_expiry_pushed_at: null });

        // Next REAL tick, ten minutes later: the deferred reservation (expiry
        // +13min, still inside its window) is picked up and every one of its
        // 70 devices is delivered to — nothing was silently lost. Admission
        // runs in expiry order, so the deferred reservation is now the soonest
        // unstamped candidate and is guaranteed a full budget.
        fetcher.mockClear();
        warn.mockClear();
        expect(await runDispatch(fetcher, NOW + 10 * 60_000)).toBe(70);
        expect(fetcher).toHaveBeenCalledTimes(70);
        expect(warn).not.toHaveBeenCalled();
      } finally {
        warn.mockRestore();
      }
    });

    it("skips reservations that are no longer awaiting approval", async () => {
      seedReservation(db, {
        id: "res_confirmed",
        storeId: "kyoto",
        status: "confirmed",
        pendingExpiresAt: iso(30),
      });
      const fetcher = vi.fn(async (_url: string) => new Response(null, { status: 201 }));

      expect(await runDispatch(fetcher)).toBe(0);
    });

    // The marker is what lets the window be a full hour: without it the same
    // reservation would be pushed on all six ticks of that hour.
    it("pushes each reservation once, even across ticks", async () => {
      seedReservation(db, { id: "res_soon", storeId: "kyoto", pendingExpiresAt: iso(30) });
      const fetcher = vi.fn(async (_url: string) => new Response(null, { status: 201 }));

      await runDispatch(fetcher);
      await runDispatch(fetcher);

      expect(fetcher).toHaveBeenCalledTimes(1);
      const row = db.sqlite
        .prepare("SELECT approval_expiry_pushed_at FROM reservations WHERE id = 'res_soon'")
        .get() as { approval_expiry_pushed_at: string | null };
      expect(row.approval_expiry_pushed_at).not.toBeNull();
    });
  });

  describe("who receives a store's push", () => {
    const NOW = Date.parse("2026-07-27T10:00:00.000Z");

    beforeEach(() => {
      seedStore(db, "kyoto", "京都店");
      seedStore(db, "osaka", "大阪店");
      seedReservation(db, {
        id: "res_kyoto",
        storeId: "kyoto",
        pendingExpiresAt: new Date(NOW + 30 * 60_000).toISOString(),
      });
    });

    const dispatch = (fetcher: ReturnType<typeof vi.fn>) =>
      dispatchExpiringApprovalPush(
        pushEnv(),
        db as unknown as D1Database,
        NOW,
        fetcher as unknown as typeof fetch
      );

    it("reaches owners and only the staff of that store", async () => {
      seedStaffMember(db, "staff_kyoto", "kyoto");
      seedStaffMember(db, "staff_osaka", "osaka");
      seedAdmin(db, { id: "admin_owner", role: "owner" });
      seedAdmin(db, { id: "admin_kyoto", role: "staff", staffMemberId: "staff_kyoto" });
      seedAdmin(db, { id: "admin_osaka", role: "staff", staffMemberId: "staff_osaka" });
      seedSubscription(db, "https://web.push.apple.com/owner", "admin_owner");
      seedSubscription(db, "https://web.push.apple.com/kyoto", "admin_kyoto");
      seedSubscription(db, "https://web.push.apple.com/osaka", "admin_osaka");
      const fetcher = vi.fn(async (_url: string) => new Response(null, { status: 201 }));

      await dispatch(fetcher);

      const targets = fetcher.mock.calls.map((call) => call[0]).sort();
      expect(targets).toEqual([
        "https://web.push.apple.com/kyoto",
        "https://web.push.apple.com/owner",
      ]);
    });

    // Deactivating an admin is how access is revoked. The subscription row is
    // not deleted by that, so the query has to exclude it or a former employee's
    // phone keeps buzzing with the salon's schedule.
    it("stops sending to a deactivated admin and to service tokens", async () => {
      seedAdmin(db, { id: "admin_gone", role: "owner", active: 0 });
      seedAdmin(db, { id: "admin_token", role: "owner", isServiceToken: 1 });
      seedSubscription(db, "https://web.push.apple.com/gone", "admin_gone");
      seedSubscription(db, "https://web.push.apple.com/token", "admin_token");
      const fetcher = vi.fn(async (_url: string) => new Response(null, { status: 201 }));

      await dispatch(fetcher);

      expect(fetcher).not.toHaveBeenCalled();
    });
  });
});

const pushActor = (id: string): AdminUser => ({ id, email: `${id}@example.com`, role: "owner", staff_member_id: null, store_id: null });
