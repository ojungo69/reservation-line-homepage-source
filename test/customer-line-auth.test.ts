import { beforeEach, describe, expect, it, vi } from "vitest";

import { verifyCustomerLineAuth } from "../src/auth/customer-line-auth";
import * as lineApi from "../src/auth/line";
import { createMigratedSqliteD1 } from "./helpers/sqlite-d1";

import type { WorkerBindings } from "../src/bindings";

const env = { LINE_CHANNEL_ID: "channel_t" } as Pick<WorkerBindings, "LINE_CHANNEL_ID">;

const noopFetch = (() => Promise.resolve(new Response())) as typeof fetch;
const fixedNow = () => 1_700_000_000_000;

const seedLineIdentity = (
  d1: ReturnType<typeof createMigratedSqliteD1>,
  options: { blocked?: boolean } = {}
) => {
  d1.sqlite
    .prepare(
      `INSERT INTO customers (id, display_name, phone_normalized, phone_hash, block_status) VALUES (?, ?, ?, ?, ?)`
    )
    .run("customer_t", "C", "0900000000", "h", options.blocked ? "blocked" : "active");
  d1.sqlite
    .prepare(
      `INSERT INTO line_identities (id, customer_id, provider, channel_id, line_user_id) VALUES (?, ?, ?, ?, ?)`
    )
    .run("identity_t", "customer_t", "line", "channel_t", "U" + "f".repeat(32));
};

const wrapD1 = (sqlite: ReturnType<typeof createMigratedSqliteD1>["sqlite"]): D1Database => {
  const make = (sql: string, values: unknown[] = []) =>
    ({
      bind(...next: unknown[]) {
        return make(sql, [...values, ...next]);
      },
      async first<T>() {
        const row = sqlite.prepare(sql).get(...(values as never[]));
        return (row ?? null) as T | null;
      },
      async run() {
        const result = sqlite.prepare(sql).run(...(values as never[]));
        return { success: true, meta: { changes: Number(result.changes) } } as D1Result;
      }
    }) as unknown as D1PreparedStatement;
  return { prepare: (sql: string) => make(sql) } as unknown as D1Database;
};

describe("verifyCustomerLineAuth", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns ok with resolved line_identity_id + customer_id for a valid LIFF token", async () => {
    const d1 = createMigratedSqliteD1();
    try {
      seedLineIdentity(d1);
      vi.spyOn(lineApi, "verifyLineIdToken").mockResolvedValue({
        ok: true,
        payload: { sub: "U" + "f".repeat(32), aud: "channel_t", exp: 99, iat: 1, nonce: "n" } as never
      } as never);
      vi.spyOn(lineApi, "verifyLineAccessTokenUser").mockResolvedValue({ ok: true } as never);
      vi.spyOn(lineApi, "verifyLineFriendship").mockResolvedValue({ ok: true, friendFlag: true } as never);

      const result = await verifyCustomerLineAuth(
        wrapD1(d1.sqlite),
        env,
        {
          action: "customer_reservations_read",
          idToken: "id",
          lineAccessToken: "access",
          nonce: "n",
          remoteIp: "1.2.3.4"
        },
        noopFetch,
        fixedNow
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.lineUserId).toBe("U" + "f".repeat(32));
        expect(result.lineIdentityId).toBe("identity_t");
        expect(result.customerId).toBe("customer_t");
        expect(result.channelId).toBe("channel_t");
      }
    } finally {
      d1.sqlite.close();
    }
  });

  it("fails closed (rate_limited) when the client IP is missing, before any LINE verification", async () => {
    const d1 = createMigratedSqliteD1();
    try {
      seedLineIdentity(d1);
      const idTokenSpy = vi.spyOn(lineApi, "verifyLineIdToken");

      const result = await verifyCustomerLineAuth(
        wrapD1(d1.sqlite),
        env,
        {
          action: "customer_reservations_read",
          idToken: "id",
          lineAccessToken: "access",
          nonce: "n"
          // remoteIp intentionally omitted — must not collapse into the shared
          // "unknown" rate-limit bucket; fail closed instead.
        },
        noopFetch,
        fixedNow
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("rate_limited");
      }
      // The IP guard short-circuits ahead of any LINE token verification.
      expect(idTokenSpy).not.toHaveBeenCalled();
    } finally {
      d1.sqlite.close();
    }
  });

  it("rejects with rate_limited when the action quota is exhausted", async () => {
    const d1 = createMigratedSqliteD1();
    try {
      seedLineIdentity(d1);
      vi.spyOn(lineApi, "verifyLineIdToken").mockResolvedValue({
        ok: true,
        payload: { sub: "U" + "f".repeat(32) } as never
      } as never);
      vi.spyOn(lineApi, "verifyLineAccessTokenUser").mockResolvedValue({ ok: true } as never);
      vi.spyOn(lineApi, "verifyLineFriendship").mockResolvedValue({ ok: true, friendFlag: true } as never);

      // Default rate-limit is 30 per 10min; fire 30 hits then expect 31st to fail.
      for (let i = 0; i < 30; i += 1) {
        const ok = await verifyCustomerLineAuth(
          wrapD1(d1.sqlite),
          env,
          {
            action: "customer_reservations_read",
            idToken: "id",
            lineAccessToken: "access",
            nonce: "n",
            remoteIp: "1.2.3.4"
          },
          noopFetch,
          fixedNow
        );
        expect(ok.ok).toBe(true);
      }

      const blocked = await verifyCustomerLineAuth(
        wrapD1(d1.sqlite),
        env,
        {
          action: "customer_reservations_read",
          idToken: "id",
          lineAccessToken: "access",
          nonce: "n",
          remoteIp: "1.2.3.4"
        },
        noopFetch,
        fixedNow
      );
      expect(blocked.ok).toBe(false);
      if (!blocked.ok) {
        expect(blocked.reason).toBe("rate_limited");
      }
    } finally {
      d1.sqlite.close();
    }
  });

  it("returns line_id_token_failed when token verification fails", async () => {
    const d1 = createMigratedSqliteD1();
    try {
      vi.spyOn(lineApi, "verifyLineIdToken").mockResolvedValue({ ok: false, reason: "invalid_signature" } as never);

      const result = await verifyCustomerLineAuth(
        wrapD1(d1.sqlite),
        env,
        {
          action: "customer_reservations_read",
          idToken: "bad",
          lineAccessToken: "access",
          remoteIp: "1.2.3.4"
        },
        noopFetch,
        fixedNow
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("line_id_token_failed");
      }
    } finally {
      d1.sqlite.close();
    }
  });

  it("returns customer_blocked for blocked customers even when LINE tokens are valid", async () => {
    const d1 = createMigratedSqliteD1();
    try {
      seedLineIdentity(d1, { blocked: true });
      vi.spyOn(lineApi, "verifyLineIdToken").mockResolvedValue({
        ok: true,
        payload: { sub: "U" + "f".repeat(32) } as never
      } as never);
      vi.spyOn(lineApi, "verifyLineAccessTokenUser").mockResolvedValue({ ok: true } as never);
      vi.spyOn(lineApi, "verifyLineFriendship").mockResolvedValue({ ok: true, friendFlag: true } as never);

      const result = await verifyCustomerLineAuth(
        wrapD1(d1.sqlite),
        env,
        {
          action: "customer_reservations_read",
          idToken: "id",
          lineAccessToken: "access",
          nonce: "n",
          remoteIp: "1.2.3.4"
        },
        noopFetch,
        fixedNow
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("customer_blocked");
      }
    } finally {
      d1.sqlite.close();
    }
  });

  it("returns line_identity_not_found when LINE token is valid but no DB row exists", async () => {
    const d1 = createMigratedSqliteD1();
    try {
      // No seedLineIdentity call -> empty table.
      vi.spyOn(lineApi, "verifyLineIdToken").mockResolvedValue({
        ok: true,
        payload: { sub: "U" + "0".repeat(32) } as never
      } as never);
      vi.spyOn(lineApi, "verifyLineAccessTokenUser").mockResolvedValue({ ok: true } as never);
      vi.spyOn(lineApi, "verifyLineFriendship").mockResolvedValue({ ok: true, friendFlag: true } as never);

      const result = await verifyCustomerLineAuth(
        wrapD1(d1.sqlite),
        env,
        {
          action: "customer_reservations_read",
          idToken: "id",
          lineAccessToken: "access",
          nonce: "n",
          remoteIp: "1.2.3.4"
        },
        noopFetch,
        fixedNow
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("line_identity_not_found");
      }
    } finally {
      d1.sqlite.close();
    }
  });
});
