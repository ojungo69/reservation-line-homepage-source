import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

import type { AdminUser } from "./access";
import { authenticateAdmin } from "./access";
import { enforceRateLimit } from "../auth/reservation-gate";

// Tier C.3 4b/4c shared route plumbing for the settings editor endpoints.
// The 9 CRUD endpoints (services + resources + staff + closures) all share
// the same authn + DB + JSON-parse preamble and the same ok/error response
// shape; extracting it here lets each route stay ~10 lines instead of ~40.

const SETTINGS_PRIVATE_HEADERS = {
  "Cache-Control": "no-store",
  Pragma: "no-cache"
} as const;

type SettingsRouteFailure = { response: Response };

export type AdminSettingsContext = { db: D1Database; admin: AdminUser };

const failure = (c: Context, status: ContentfulStatusCode, error: string): SettingsRouteFailure => ({
  response: c.json({ ok: false, error }, status, SETTINGS_PRIVATE_HEADERS)
});

// Admin mutations carry only a Cloudflare Access JWT + the Sec-Fetch-Site CSRF
// guard — there was no per-actor throttle, so a stolen Access cookie could drive
// unbounded destructive operations (delete / block / merge / reservation writes).
// Rate-limit state-changing methods per resolved admin id. 300/10min ≈ one every
// 2s sustained: far above any human or single bulk-as-one-request mutation, but a
// hard ceiling on an automated abuse loop. Reads (GET/HEAD/OPTIONS) are never
// throttled. failOpen keeps a transient D1 blip from locking a real owner out.
const ADMIN_MUTATION_METHODS: ReadonlySet<string> = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const ADMIN_MUTATION_RATE_LIMIT = 300;
const ADMIN_MUTATION_RATE_WINDOW_MS = 10 * 60 * 1000;

/**
 * True when a state-changing admin request has exceeded the per-admin mutation
 * rate limit (caller should respond 429). Non-mutation methods always return
 * false. Shared by both admin auth entry points (`requireAdminContext` here and
 * `authenticateAdminWithDb` in admin-api.ts) so all ~60 admin mutations are
 * covered without per-route wiring.
 */
export const isAdminMutationRateLimited = async (
  c: Context,
  db: D1Database,
  adminId: string
): Promise<boolean> => {
  if (!ADMIN_MUTATION_METHODS.has(c.req.method)) {
    return false;
  }
  const result = await enforceRateLimit(
    db,
    "admin_mutation",
    adminId,
    Date.now,
    ADMIN_MUTATION_RATE_LIMIT,
    ADMIN_MUTATION_RATE_WINDOW_MS,
    true // failOpen: never lock a trusted admin out on a transient D1 error
  );
  return !result.ok;
};

export const requireAdminContext = async (
  c: Context
): Promise<AdminSettingsContext | SettingsRouteFailure> => {
  const auth = await authenticateAdmin({
    token: c.req.header("Cf-Access-Jwt-Assertion") ?? undefined,
    env: c.env as Record<string, unknown>
  });
  if (!auth.ok) {
    return failure(c, 403, "forbidden");
  }
  if (!(c.env as { DB?: D1Database }).DB) {
    return failure(c, 500, "missing_database");
  }
  const db = (c.env as { DB: D1Database }).DB;
  if (await isAdminMutationRateLimited(c, db, auth.admin.id)) {
    return failure(c, 429, "rate_limited");
  }
  return { db, admin: auth.admin };
};

export const parseAdminJsonBody = async <T>(
  c: Context,
  parser: (body: unknown) => T | null
): Promise<T | SettingsRouteFailure> => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return failure(c, 400, "invalid_request");
  }
  const parsed = parser(body);
  if (parsed === null) {
    return failure(c, 400, "invalid_request");
  }
  return parsed;
};

export const isRouteFailure = <T>(value: T | SettingsRouteFailure): value is SettingsRouteFailure =>
  typeof value === "object" && value !== null && "response" in value;

type MutationOk = { ok: true } & Record<string, unknown>;
type MutationErr = { ok: false; error: string };
type MutationResult = MutationOk | MutationErr;

export const respondAdminMutation = <T extends MutationResult>(
  c: Context,
  result: T,
  successStatus: ContentfulStatusCode | ((result: T & { ok: true }) => ContentfulStatusCode),
  statusByError: Readonly<Record<string, ContentfulStatusCode>>
): Response => {
  if (result.ok) {
    const status =
      typeof successStatus === "function"
        ? successStatus(result as T & { ok: true })
        : successStatus;
    return c.json(result, status, SETTINGS_PRIVATE_HEADERS);
  }
  return c.json(result, statusByError[result.error] ?? 400, SETTINGS_PRIVATE_HEADERS);
};
