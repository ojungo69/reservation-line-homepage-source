import type { MiddlewareHandler } from "hono";

type SessionPolicy = "first-primary" | "first-unconstrained";

const POLICY_MAP: Record<string, SessionPolicy> = {
  "/api/public/availability": "first-primary"
};

const MAX_BOOKMARK_LENGTH = 4096;

export const d1SessionMiddleware = (): MiddlewareHandler => {
  return async (c, next) => {
    const env = c.env as Record<string, unknown> | undefined;
    if (env?.D1_SESSION_ENABLED !== "true") {
      await next();
      return;
    }

    const db = env.DB as D1Database | undefined;
    if (!db || typeof db.withSession !== "function") {
      await next();
      return;
    }

    const policy = POLICY_MAP[c.req.path] ?? "first-unconstrained";
    let bookmark: string;
    if (policy === "first-primary") {
      bookmark = "first-primary";
    } else {
      const header = c.req.header("x-d1-bookmark");
      bookmark = header && header.length <= MAX_BOOKMARK_LENGTH
        ? header
        : "first-unconstrained";
    }

    const session = db.withSession(bookmark);
    c.set("readDb", session);
    await next();

    const newBookmark = session.getBookmark();
    if (newBookmark) {
      c.header("x-d1-bookmark", newBookmark);
    }
  };
};
