/**
 * Cloudflare Access JWT fixture for admin route tests.
 *
 * Every admin test needs a signed Access JWT plus a fetch mock that serves the
 * matching JWKS from `<issuer>/cdn-cgi/access/certs`. Before this helper each
 * test file carried its own copy — including its own 2048-bit RSA keypair
 * generation, which is the slowest single operation in those files.
 *
 * The signing key is generated per call. Pass `signingKey` to reuse one across
 * fixtures, which is what tests that need two tokens from the SAME key (e.g. a
 * second admin, or a token that must validate against an already-served JWKS)
 * should do. Passing a DIFFERENT key is how you build the "signed by an unknown
 * key" rejection case.
 */
import { createSign, generateKeyPairSync, type KeyObject } from "node:crypto";

import { vi } from "vitest";

import type { AdminRole } from "../../src/admin/access";
import type { SqliteD1Database } from "./sqlite-d1";

export type { AdminRole };

export type AccessJwk = JsonWebKey & {
  kid: string;
  alg: string;
  use: string;
};

export type AccessSigningKey = {
  privateKey: KeyObject;
  jwk: AccessJwk;
};

export type AccessJwtFixture = AccessSigningKey & {
  token: string;
};

export type AccessJwtFixtureOptions = {
  /** Team domain, e.g. "https://team.example.cloudflareaccess.com". */
  issuer: string;
  /** Access application AUD tag. */
  audience: string;
  /** JWK `kid`. Ignored when `signingKey` is supplied. */
  keyId: string;
  /**
   * Extra JWT claims (`email`, `sub`, ...). Spread last, so a test can also
   * override `exp` / `nbf` / `iat` to build expiry and not-yet-valid cases.
   */
  claims?: Record<string, unknown>;
  /** Reuse an existing keypair instead of generating a fresh one. */
  signingKey?: AccessSigningKey;
};

export const createAccessSigningKey = (keyId: string): AccessSigningKey => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = publicKey.export({ format: "jwk" }) as unknown as AccessJwk;
  jwk.kid = keyId;
  jwk.alg = "RS256";
  jwk.use = "sig";
  return { privateKey, jwk };
};

export const createAccessJwtFixture = (options: AccessJwtFixtureOptions): AccessJwtFixture => {
  const signingKey = options.signingKey ?? createAccessSigningKey(options.keyId);
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", kid: signingKey.jwk.kid, typ: "JWT" };
  const payload = {
    aud: [options.audience],
    iss: options.issuer,
    exp: now + 600,
    nbf: now - 60,
    iat: now - 60,
    ...options.claims
  };
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const signingInput = `${encode(header)}.${encode(payload)}`;
  const signature = createSign("RSA-SHA256")
    .update(signingInput)
    .end()
    .sign(signingKey.privateKey)
    .toString("base64url");

  return { token: `${signingInput}.${signature}`, jwk: signingKey.jwk, privateKey: signingKey.privateKey };
};

export const requestUrl = (input: RequestInfo | URL): string =>
  typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

/**
 * fetch mock serving the JWKS for `issuer`. Any other URL gets a 404 with a
 * recognisable body, so an unexpected outbound call fails loudly instead of
 * silently returning undefined.
 */
export const createAccessJwksFetchMock = (issuer: string, ...jwks: AccessJwk[]) =>
  vi.fn(async (input: RequestInfo | URL) => {
    if (requestUrl(input) === `${issuer}/cdn-cgi/access/certs`) {
      return Response.json({ keys: jwks });
    }
    return Response.json({ message: "unexpected test URL" }, { status: 404 });
  });

export type InsertAdminUserOptions = {
  id: string;
  email: string;
  accessSubject: string;
  role?: AdminRole;
  staffMemberId?: string | null;
  active?: 0 | 1;
  isServiceToken?: 0 | 1;
  lastSeenAt?: string | null;
  updatedAt?: string;
};

/** Shared seed for admin_users rows used across admin route tests. */
export const insertAdminUser = (db: SqliteD1Database, options: InsertAdminUserOptions): void => {
  db.sqlite
    .prepare(
      `INSERT INTO admin_users
        (id, staff_member_id, email, access_subject, role, active, is_service_token, last_seen_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      options.id,
      options.staffMemberId ?? null,
      options.email,
      options.accessSubject,
      options.role ?? "owner",
      options.active ?? 1,
      options.isServiceToken ?? 0,
      options.lastSeenAt ?? null,
      options.updatedAt ?? "2026-05-19T00:00:00.000Z"
    );
};

/**
 * Give a staff admin the customer-tab approval (spec 008) so a test can exercise
 * the customer routes without walking the code-request / code-verify flow. The
 * verified challenge row IS the grant, so this writes the same shape
 * `verifyCustomerGateCode` writes. `code_hash` is a throwaway 64-char value: the
 * row is already verified, so nothing ever compares against it.
 */
export const grantCustomerTabGate = (
  db: SqliteD1Database,
  adminUserId: string,
  grantedUntil = "2099-01-01T00:00:00.000Z"
): void => {
  db.sqlite
    .prepare(
      `INSERT INTO admin_customer_gate_challenges
        (id, admin_user_id, code_hash, expires_at, attempts, verified_at, granted_until)
       VALUES (?, ?, ?, ?, 1, ?, ?)`
    )
    .run(
      `gate_${adminUserId}`,
      adminUserId,
      "0".repeat(64),
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:00:00.000Z",
      grantedUntil
    );
};
