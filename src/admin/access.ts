import type { WorkerBindings } from "../bindings";
import { isNonEmptyString } from "./reservation-time-utils";

export type AdminRole = "staff" | "owner" | "system_admin";

export type AdminUser = {
  id: string;
  email: string;
  role: AdminRole;
  staff_member_id: string | null;
  store_id: string | null;
};

export type AdminAuthResult =
  | {
      ok: true;
      admin: AdminUser;
    }
  | {
      ok: false;
      reason: "admin_auth_failed" | "admin_not_registered";
    };

type AccessJwtHeader = {
  alg?: unknown;
  kid?: unknown;
};

type AccessJwtPayload = {
  aud?: unknown;
  iss?: unknown;
  email?: unknown;
  sub?: unknown;
  // Cloudflare Access Service Tokens carry an empty email/sub and identify the
  // Service Token Client ID via common_name (verified against Cloudflare docs,
  // 2026-05-16). See classifyAccessPrincipal() for the principal kinds.
  common_name?: unknown;
  exp?: unknown;
  nbf?: unknown;
  iat?: unknown;
};

type AccessPrincipal =
  | { kind: "human"; email: string; sub: string }
  | { kind: "service_token"; commonName: string };

type AccessJwks = {
  keys?: unknown;
};

type AdminUserRow = {
  id: string;
  email: string;
  role: AdminRole;
  staff_member_id: string | null;
  store_id: string | null;
};

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const CLOCK_SKEW_SECONDS = 60;
const ACCESS_JWKS_CACHE_TTL_MS = 5 * 60 * 1000;
const ACCESS_JWKS_FORCE_REFRESH_COOLDOWN_MS = 60 * 1000;

type CachedAccessJwks = {
  keys: JsonWebKey[];
  expiresAtMs: number;
  forceRefreshAfterMs: number;
};

type AccessJwksResult = {
  keys: JsonWebKey[];
  fromCache: boolean;
  canForceRefresh: boolean;
};

type ParsedAccessJwt = {
  kid: string;
  payload: AccessJwtPayload;
  signingInput: string;
  signaturePart: string;
};

const accessJwksCaches = new WeakMap<typeof fetch, Map<string, CachedAccessJwks>>();

const callFetcher = (
  fetcher: typeof fetch,
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1]
) => Reflect.apply(fetcher, globalThis, [input, init]);

const normalizeTeamDomain = (value: string | undefined) => {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed;
};

const base64UrlToBytes = (value: string) => {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.codePointAt(index) ?? 0;
  }
  return bytes;
};

const decodeJsonPart = <T>(part: string): T | undefined => {
  try {
    return JSON.parse(textDecoder.decode(base64UrlToBytes(part))) as T;
  } catch {
    return undefined;
  }
};

const hasAudience = (audience: unknown, expected: string) => {
  if (typeof audience === "string") {
    return audience === expected;
  }
  if (Array.isArray(audience)) {
    return audience.includes(expected);
  }
  return false;
};

const verifyJwtSignature = async (
  signingInput: string,
  signaturePart: string,
  jwk: JsonWebKey
) => {
  try {
    const key = await crypto.subtle.importKey(
      "jwk",
      jwk,
      {
        name: "RSASSA-PKCS1-v1_5",
        hash: "SHA-256"
      },
      false,
      ["verify"]
    );

    return crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      base64UrlToBytes(signaturePart),
      textEncoder.encode(signingInput)
    );
  } catch {
    return false;
  }
};

// Validates JWT envelope claims that are independent of which principal type
// (human IdP vs Service Token) issued the token: iss, aud, exp, nbf, iat.
// Principal claims (email/sub/common_name) are classified separately in
// classifyAccessPrincipal so that downstream code can branch on principal kind
// without retrofitting principal-shape assumptions into the envelope check.
const validateAccessJwtEnvelope = (
  payload: AccessJwtPayload,
  teamDomain: string,
  accessAud: string,
  nowSeconds: number
): boolean => {
  if (payload.iss !== teamDomain) {
    return false;
  }
  if (!hasAudience(payload.aud, accessAud)) {
    return false;
  }
  if (typeof payload.exp !== "number" || payload.exp <= nowSeconds - CLOCK_SKEW_SECONDS) {
    return false;
  }
  if (typeof payload.nbf === "number" && payload.nbf > nowSeconds + CLOCK_SKEW_SECONDS) {
    return false;
  }
  if (typeof payload.iat === "number" && payload.iat > nowSeconds + CLOCK_SKEW_SECONDS) {
    return false;
  }
  return true;
};

// Classifies the JWT principal as either a human IdP authentication (email + sub)
// or a Cloudflare Access Service Token (empty email/sub, common_name = Client ID).
// Mixed/partial shapes are rejected as undefined so the caller can fail closed.
const classifyAccessPrincipal = (payload: AccessJwtPayload): AccessPrincipal | undefined => {
  const { email, sub, common_name: commonName } = payload;
  const emailValid = isNonEmptyString(email, 320);
  const subValid = isNonEmptyString(sub, 256);
  const commonNameValid = isNonEmptyString(commonName, 256);

  if (emailValid && subValid && !commonNameValid) {
    return { kind: "human", email, sub };
  }
  if (!emailValid && !subValid && commonNameValid) {
    return { kind: "service_token", commonName };
  }
  return undefined;
};

const jwksCacheForFetcher = (fetcher: typeof fetch) => {
  const existing = accessJwksCaches.get(fetcher);
  if (existing) {
    return existing;
  }
  const next = new Map<string, CachedAccessJwks>();
  accessJwksCaches.set(fetcher, next);
  return next;
};

const fetchAccessJwks = async (input: {
  teamDomain: string;
  fetcher: typeof fetch;
  nowMs: number;
  forceRefresh?: boolean;
}): Promise<AccessJwksResult | undefined> => {
  const cache = jwksCacheForFetcher(input.fetcher);
  const cached = cache.get(input.teamDomain);
  if (!input.forceRefresh && cached && cached.expiresAtMs > input.nowMs) {
    return {
      keys: cached.keys,
      fromCache: true,
      canForceRefresh: cached.forceRefreshAfterMs <= input.nowMs
    };
  }

  if (input.forceRefresh && cached) {
    cache.set(input.teamDomain, {
      ...cached,
      forceRefreshAfterMs: input.nowMs + ACCESS_JWKS_FORCE_REFRESH_COOLDOWN_MS
    });
  }

  const response = await callFetcher(
    input.fetcher,
    `${input.teamDomain}/cdn-cgi/access/certs`
  );
  if (!response.ok) {
    return undefined;
  }

  let jwks: AccessJwks;
  try {
    jwks = await response.json<AccessJwks>();
  } catch {
    return undefined;
  }
  const keys = Array.isArray(jwks.keys)
    ? jwks.keys.filter((key): key is JsonWebKey => typeof key === "object" && key !== null)
    : [];
  if (keys.length === 0) {
    return undefined;
  }
  cache.set(input.teamDomain, {
    keys,
    expiresAtMs: input.nowMs + ACCESS_JWKS_CACHE_TTL_MS,
    forceRefreshAfterMs: input.forceRefresh
      ? input.nowMs + ACCESS_JWKS_FORCE_REFRESH_COOLDOWN_MS
      : input.nowMs
  });

  return {
    keys,
    fromCache: false,
    canForceRefresh: false
  };
};

const findJwkByKid = (keys: JsonWebKey[], kid: string) => {
  return keys.find((key) => (key as { kid?: unknown }).kid === kid);
};

const parseAccessJwt = (token: string): ParsedAccessJwt | undefined => {
  const parts = token.split(".");
  if (parts.length !== 3) {
    return undefined;
  }

  const header = decodeJsonPart<AccessJwtHeader>(parts[0]);
  const payload = decodeJsonPart<AccessJwtPayload>(parts[1]);
  if (!header || !payload || header.alg !== "RS256" || !isNonEmptyString(header.kid, 256)) {
    return undefined;
  }

  return {
    kid: header.kid,
    payload,
    signingInput: `${parts[0]}.${parts[1]}`,
    signaturePart: parts[2]
  };
};

const resolveJwkByKid = async (input: {
  jwks: AccessJwksResult;
  kid: string;
  teamDomain: string;
  fetcher: typeof fetch;
  now: () => number;
}) => {
  const jwk = findJwkByKid(input.jwks.keys, input.kid);
  if (jwk || !input.jwks.fromCache || !input.jwks.canForceRefresh) {
    return {
      jwk,
      jwks: input.jwks
    };
  }

  const refreshedJwks = await fetchAccessJwks({
    teamDomain: input.teamDomain,
    fetcher: input.fetcher,
    nowMs: input.now(),
    forceRefresh: true
  });

  if (!refreshedJwks) {
    return {
      jwk: undefined,
      jwks: input.jwks
    };
  }

  return {
    jwk: findJwkByKid(refreshedJwks.keys, input.kid),
    jwks: refreshedJwks
  };
};

const verifyAccessJwtSignature = async (input: {
  jwk: JsonWebKey;
  jwks: AccessJwksResult;
  kid: string;
  signingInput: string;
  signaturePart: string;
  teamDomain: string;
  fetcher: typeof fetch;
  now: () => number;
}) => {
  const signatureValid = await verifyJwtSignature(input.signingInput, input.signaturePart, input.jwk);
  if (signatureValid) {
    return true;
  }
  if (!input.jwks.fromCache || !input.jwks.canForceRefresh) {
    return false;
  }

  const refreshedJwks = await fetchAccessJwks({
    teamDomain: input.teamDomain,
    fetcher: input.fetcher,
    nowMs: input.now(),
    forceRefresh: true
  });
  const refreshedJwk = refreshedJwks ? findJwkByKid(refreshedJwks.keys, input.kid) : undefined;

  return refreshedJwk
    ? verifyJwtSignature(input.signingInput, input.signaturePart, refreshedJwk)
    : false;
};

async function verifyCloudflareAccessJwt(input: {
  token: string | undefined;
  env: Partial<WorkerBindings>;
  fetcher?: typeof fetch;
  now?: () => number;
}): Promise<
  | {
      ok: true;
      principal: AccessPrincipal;
    }
  | {
      ok: false;
    }
> {
  const fail = {
    ok: false
  } as const;
  const teamDomain = normalizeTeamDomain(input.env.ACCESS_TEAM_DOMAIN);
  const accessAud = input.env.ACCESS_AUD?.trim();
  if (!input.token || !teamDomain || !accessAud) {
    return fail;
  }

  const parsed = parseAccessJwt(input.token);
  if (!parsed) {
    return fail;
  }

  const now = input.now ?? Date.now;
  if (!validateAccessJwtEnvelope(parsed.payload, teamDomain, accessAud, Math.floor(now() / 1000))) {
    return fail;
  }

  const principal = classifyAccessPrincipal(parsed.payload);
  if (!principal) {
    return fail;
  }

  try {
    // Do NOT replace with `fetch.bind(globalThis)` here: jwksCacheForFetcher keys its WeakMap by
    // fetcher identity, and `bind` returns a fresh function each call, which would defeat the
    // JWKS cache and trigger a fetch per JWT verification.
    const fetcher = input.fetcher ?? fetch;
    const jwks = await fetchAccessJwks({
      teamDomain,
      fetcher,
      nowMs: now()
    });
    if (!jwks) {
      return fail;
    }

    const resolved = await resolveJwkByKid({
      jwks,
      kid: parsed.kid,
      teamDomain,
      fetcher,
      now
    });
    if (!resolved.jwk) {
      return fail;
    }

    const signatureValid = await verifyAccessJwtSignature({
      jwk: resolved.jwk,
      jwks: resolved.jwks,
      kid: parsed.kid,
      signingInput: parsed.signingInput,
      signaturePart: parsed.signaturePart,
      teamDomain,
      fetcher,
      now
    });
    if (!signatureValid) {
      return fail;
    }

    return {
      ok: true,
      principal
    };
  } catch {
    return fail;
  }
}

const HUMAN_ADMIN_SELECT = `
  SELECT au.id, au.email, au.role, au.staff_member_id, sm.store_id
  FROM admin_users au
  LEFT JOIN staff_members sm ON au.staff_member_id = sm.id
  WHERE lower(au.email) = lower(?)
    AND au.access_subject = ?
    AND au.is_service_token = 0
    AND au.active = 1
  LIMIT 1
`;

const fetchHumanAdmin = (db: D1Database, email: string, sub: string) =>
  db.prepare(HUMAN_ADMIN_SELECT).bind(email, sub).first<AdminUserRow>();

// Binds the current verified subject to a pending store-login row (access_subject='pending:%').
// email is UNIQUE so at most one row matches. We do NOT rely on changes count; we re-fetch by
// (email, sub) so a concurrent first-login with the SAME sub (double submit) still resolves.
// An email already bound to a DIFFERENT real subject never matches 'pending:%' and the re-fetch
// by THIS sub returns null -> admin_not_registered (prevents hijacking an existing identity).
const bindPendingAdmin = async (
  db: D1Database,
  email: string,
  sub: string,
  nowIso: string
): Promise<AdminUserRow | null> => {
  try {
    await db
      .prepare(
        `UPDATE admin_users
           SET access_subject = ?, last_seen_at = ?, updated_at = ?
         WHERE lower(email) = lower(?)
           AND access_subject LIKE 'pending:%'
           AND is_service_token = 0
           AND active = 1`
      )
      .bind(sub, nowIso, nowIso, email)
      .run();
  } catch (error) {
    // access_subject is UNIQUE. If this verified sub is already stored on a
    // DIFFERENT admin_users row, the bind UPDATE collides with that constraint.
    // Fail CLOSED (return null -> admin_not_registered) rather than bubbling a
    // 500 on every login for the account. Re-throw any other DB error.
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("UNIQUE constraint failed: admin_users.access_subject")) {
      return null;
    }
    throw error;
  }
  return fetchHumanAdmin(db, email, sub);
};

// Best-effort first-bind audit (codex PR #308 review, Fix E): record when an
// external identity first claims a pre-registered store-login row. The raw
// subject is intentionally NOT logged; the bound admin id + email suffice.
const recordPendingBindAudit = async (
  db: D1Database,
  admin: AdminUserRow,
  nowIso: string
): Promise<void> => {
  try {
    await db
      .prepare(
        `INSERT INTO audit_logs (
           id, actor_type, actor_id, action, target_type, target_id, metadata_json, created_at
         ) VALUES (?, 'staff', ?, 'admin.login.pending_bind', 'admin_user', ?, ?, ?)`
      )
      .bind(
        crypto.randomUUID(),
        admin.id,
        admin.id,
        JSON.stringify({ email: admin.email, role: admin.role, storeId: admin.store_id }),
        nowIso
      )
      .run();
  } catch (error) {
    console.warn("[access] pending_bind audit write failed", {
      adminId: admin.id,
      error: error instanceof Error ? error.message : String(error)
    });
  }
};

/**
 * Resolves a verified human principal to an admin_users row.
 *
 * Exact (email, access_subject) matches authenticate directly. When no exact match
 * exists, a pre-registered "pending" store-login row (access_subject='pending:%') for
 * the same email is bound to this verified subject on first login. See bindPendingAdmin
 * for the no-hijack invariant.
 */
export const resolveHumanAdmin = async (
  db: D1Database,
  principal: { email: string; sub: string },
  nowIso: string
): Promise<AdminAuthResult> => {
  const exact = await fetchHumanAdmin(db, principal.email, principal.sub);
  if (exact) {
    await db
      .prepare(`UPDATE admin_users SET last_seen_at = ?, updated_at = ? WHERE id = ?`)
      .bind(nowIso, nowIso, exact.id)
      .run();
    return { ok: true, admin: exact };
  }
  const bound = await bindPendingAdmin(db, principal.email, principal.sub, nowIso);
  if (bound) {
    await recordPendingBindAudit(db, bound, nowIso);
    return { ok: true, admin: bound };
  }
  return { ok: false, reason: "admin_not_registered" };
};

/**
 * Authenticates an admin request against admin_users.
 *
 * @param input.token - The Cf-Access-Jwt-Assertion header value.
 * @param input.env  - Worker bindings (DB + Access config + flags).
 * @param options.allowServiceToken
 *   When `true`, allows Cloudflare Access Service Token JWTs (empty `email`/`sub`,
 *   `common_name` = Service Token Client ID) to authenticate against admin_users
 *   rows flagged `is_service_token = 1`. Defaults to `false` (human IdP only).
 *
 *   OPERATIONAL RULES (do not bypass):
 *   1. `allowServiceToken: true` MUST only appear on staging-only machine endpoints
 *      whose purpose is non-PII bulk processing (e.g. the 25K CSV smoke runner).
 *      It MUST NOT be used on routes that mutate human-scoped data, expose PII,
 *      or run in production traffic patterns.
 *   2. Even when `allowServiceToken: true`, the Service Token path is gated again
 *      by `env.ENVIRONMENT === "staging"` and `env.STAGING_SERVICE_TOKEN_AUTH === "true"`.
 *      Production cannot grant access via Service Token regardless of this option.
 *   3. The human path always filters `is_service_token = 0`, so Service Token rows
 *      never satisfy a human-authenticated route.
 *   4. PR review checklist: `grep -rn "allowServiceToken: true" src/` and confirm
 *      every site is a staging-only machine endpoint.
 */
export async function authenticateAdmin(
  input: {
    token: string | undefined;
    env: Partial<WorkerBindings>;
    fetcher?: typeof fetch;
    now?: () => number;
  },
  options?: {
    allowServiceToken?: boolean;
  }
): Promise<AdminAuthResult> {
  if (!input.env.DB) {
    return {
      ok: false,
      reason: "admin_auth_failed"
    };
  }

  const jwt = await verifyCloudflareAccessJwt(input);
  if (!jwt.ok) {
    return {
      ok: false,
      reason: "admin_auth_failed"
    };
  }

  const db = input.env.DB;
  const nowIso = new Date((input.now ?? Date.now)()).toISOString();

  if (jwt.principal.kind === "service_token") {
    // Five layers of defense-in-depth must all hold for the Service Token path:
    //   1. The caller route explicitly opts in via allowServiceToken.
    //   2. ENVIRONMENT must be exactly "staging".
    //   3. STAGING_SERVICE_TOKEN_AUTH must be exactly "true".
    //   4. The admin_users row must be flagged is_service_token = 1.
    //   5. The human path (below) filters is_service_token = 0, preventing the
    //      same row from satisfying both paths.
    if (!options?.allowServiceToken) {
      return {
        ok: false,
        reason: "admin_auth_failed"
      };
    }
    if (input.env.ENVIRONMENT !== "staging") {
      return {
        ok: false,
        reason: "admin_auth_failed"
      };
    }
    if (input.env.STAGING_SERVICE_TOKEN_AUTH !== "true") {
      return {
        ok: false,
        reason: "admin_auth_failed"
      };
    }

    const admin = await db
      .prepare(
        `
          SELECT au.id, au.email, au.role, au.staff_member_id, sm.store_id
          FROM admin_users au
          LEFT JOIN staff_members sm ON au.staff_member_id = sm.id
          WHERE au.access_subject = ?
            AND au.is_service_token = 1
            AND au.active = 1
          LIMIT 1
        `
      )
      .bind(jwt.principal.commonName)
      .first<AdminUserRow>();

    if (!admin) {
      return {
        ok: false,
        reason: "admin_not_registered"
      };
    }

    await db
      .prepare(
        `
          UPDATE admin_users
          SET last_seen_at = ?,
              updated_at = ?
          WHERE id = ?
        `
      )
      .bind(nowIso, nowIso, admin.id)
      .run();

    return {
      ok: true,
      admin
    };
  }

  return resolveHumanAdmin(db, { email: jwt.principal.email, sub: jwt.principal.sub }, nowIso);
}
