import { describe, it, expect, vi } from "vitest";
import type { Context } from "hono";

import { isAdminMutationRateLimited } from "../src/admin/settings-route-helpers";
import { createMigratedSqliteD1 } from "./helpers/sqlite-d1";

// Minimal Context stand-in — isAdminMutationRateLimited only reads c.req.method.
const ctx = (method: string) => ({ req: { method } }) as unknown as Context;

describe("isAdminMutationRateLimited", () => {
  it("never rate-limits read methods and writes no rate_limit_events row", async () => {
    const d1 = createMigratedSqliteD1();
    try {
      for (const method of ["GET", "HEAD", "OPTIONS"]) {
        expect(
          await isAdminMutationRateLimited(ctx(method), d1 as unknown as D1Database, "admin-1")
        ).toBe(false);
      }
      const count = d1.sqlite.prepare("SELECT COUNT(*) AS c FROM rate_limit_events").get() as { c: number };
      expect(count.c).toBe(0);
    } finally {
      d1.sqlite.close();
    }
  });

  it("allows mutations up to the 300/10min cap then blocks the 301st (per-admin bucket)", async () => {
    const d1 = createMigratedSqliteD1();
    try {
      for (let i = 0; i < 300; i++) {
        expect(
          await isAdminMutationRateLimited(ctx("POST"), d1 as unknown as D1Database, "admin-1")
        ).toBe(false);
      }
      expect(
        await isAdminMutationRateLimited(ctx("PATCH"), d1 as unknown as D1Database, "admin-1")
      ).toBe(true);

      // A different admin id has an independent bucket — not affected by admin-1.
      expect(
        await isAdminMutationRateLimited(ctx("DELETE"), d1 as unknown as D1Database, "admin-2")
      ).toBe(false);
    } finally {
      d1.sqlite.close();
    }
  });

  it("fails open (not limited) when the rate-limit store errors — never locks out a trusted admin", async () => {
    const throwingDb = {
      prepare: vi.fn(() => {
        throw new Error("d1_unavailable");
      })
    } as unknown as D1Database;

    expect(await isAdminMutationRateLimited(ctx("POST"), throwingDb, "admin-1")).toBe(false);
  });
});
