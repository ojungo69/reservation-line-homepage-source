import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import { d1SessionMiddleware } from "../src/middleware/d1-session";

function createMockSession(bookmark: string | null = "bk_abc123") {
  return {
    prepare: vi.fn().mockReturnValue({ bind: vi.fn().mockReturnValue({ all: vi.fn().mockResolvedValue({ results: [] }) }) }),
    batch: vi.fn().mockResolvedValue([]),
    getBookmark: vi.fn().mockReturnValue(bookmark)
  };
}

function createMockDb(session?: ReturnType<typeof createMockSession>) {
  return {
    prepare: vi.fn(),
    batch: vi.fn(),
    exec: vi.fn(),
    dump: vi.fn(),
    withSession: vi.fn().mockReturnValue(session ?? createMockSession())
  };
}

describe("d1SessionMiddleware", () => {
  it("skips session when D1_SESSION_ENABLED is false", async () => {
    const app = new Hono();
    app.use("*", d1SessionMiddleware());
    app.get("/test", (c) => {
      const readDb = c.get("readDb");
      return c.json({ hasReadDb: readDb !== undefined });
    });

    const res = await app.request("/test", {}, {
      D1_SESSION_ENABLED: "false",
      DB: createMockDb()
    });
    const body = await res.json() as { hasReadDb: boolean };
    expect(body.hasReadDb).toBe(false);
    expect(res.headers.get("x-d1-bookmark")).toBeNull();
  });

  it("creates session with first-unconstrained by default", async () => {
    const session = createMockSession();
    const db = createMockDb(session);
    const app = new Hono();
    app.use("*", d1SessionMiddleware());
    app.get("/api/admin/dashboard", (c) => c.json({ ok: true }));

    const res = await app.request("/api/admin/dashboard", {}, {
      D1_SESSION_ENABLED: "true",
      DB: db
    });
    expect(db.withSession).toHaveBeenCalledWith("first-unconstrained");
    expect(res.headers.get("x-d1-bookmark")).toBe("bk_abc123");
  });

  it("uses first-primary for /api/public/availability", async () => {
    const session = createMockSession();
    const db = createMockDb(session);
    const app = new Hono();
    app.use("*", d1SessionMiddleware());
    app.get("/api/public/availability", (c) => c.json({ ok: true }));

    await app.request("/api/public/availability", {}, {
      D1_SESSION_ENABLED: "true",
      DB: db
    });
    expect(db.withSession).toHaveBeenCalledWith("first-primary");
  });

  it("uses client bookmark from header when provided", async () => {
    const session = createMockSession();
    const db = createMockDb(session);
    const app = new Hono();
    app.use("*", d1SessionMiddleware());
    app.get("/test", (c) => c.json({ ok: true }));

    await app.request("/test", {
      headers: { "x-d1-bookmark": "client_bk_xyz" }
    }, {
      D1_SESSION_ENABLED: "true",
      DB: db
    });
    expect(db.withSession).toHaveBeenCalledWith("client_bk_xyz");
  });

  it("ignores bookmark longer than 4096 bytes", async () => {
    const session = createMockSession();
    const db = createMockDb(session);
    const app = new Hono();
    app.use("*", d1SessionMiddleware());
    app.get("/test", (c) => c.json({ ok: true }));

    const longBookmark = "x".repeat(5000);
    await app.request("/test", {
      headers: { "x-d1-bookmark": longBookmark }
    }, {
      D1_SESSION_ENABLED: "true",
      DB: db
    });
    expect(db.withSession).toHaveBeenCalledWith("first-unconstrained");
  });

  it("does not set x-d1-bookmark header when getBookmark returns null", async () => {
    const session = createMockSession(null);
    const db = createMockDb(session);
    const app = new Hono();
    app.use("*", d1SessionMiddleware());
    app.get("/test", (c) => c.json({ ok: true }));

    const res = await app.request("/test", {}, {
      D1_SESSION_ENABLED: "true",
      DB: db
    });
    expect(res.headers.get("x-d1-bookmark")).toBeNull();
  });
});
