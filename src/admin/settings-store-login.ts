import { adminWriteGuard, adminWriteWasRevoked } from "./write-authorization";
import type { AdminUser } from "./access";
import { safeCaptureException } from "../sentry-helpers";
import {
  buildCreateContext,
  fetchAdminActionIdempotency,
  isAdminPrivileged,
  MAX_ID_LENGTH,
  MAX_IDEMPOTENCY_KEY_LENGTH,
  recoverFromCreateBatchFailure,
  sha256Hex,
  startedIdempotencyStatement,
  storeExists,
  succeededIdempotencyStatement,
  trimAndCap,
  type IdempotencyRow
} from "./settings-common";

// Store-login self-service — domain logic ONLY (HTTP wiring + SPA live elsewhere).
//
// Scene: an owner pre-registers a store's SHARED login by email. The login is an
// admin_users row linked (staff_member_id -> staff_members.store_id) to one
// store, grouped under the deterministic sentinel staff_member_id
// `staff_login_<storeId>`. Until the staff's first verified login, the row
// carries access_subject='pending:<uuid>'; that first login binds the real JWT
// subject (resolveHumanAdmin in src/admin/access.ts).
//
// SECURITY POSTURE (this is auth/authz code):
//   * Fail-closed resolver: any system_admin in scope, or >=2 active human
//     logins, collapses to `ambiguous` so the owner UI can never touch elevated
//     or unexpected identities through this surface.
//   * email_in_use guard: an email already attached to ANY admin_users row may
//     only be (re)used for a store login if that row is this store's own
//     canonical/disabled login history. This blocks hijacking a system_admin,
//     an owner's personal account, or another store's login by re-pointing its
//     access_subject to a fresh pending sentinel.
//   * Self-lockout guard on revoke (mirrors settings-staff F-3.2).

const MAX_EMAIL_LENGTH = 320;

// Backtracking-free structural email check (replaces a super-linear regex that
// SonarCloud flagged as a ReDoS hotspot). Validates the same shape the old
// `/^[^@\s]+@[^@\s]+\.[^@\s]+$/` accepted — exactly one non-leading '@' with a
// dotted domain whose dot is neither first nor last char — using only a single
// whitespace-class test and index arithmetic (all O(n), no catastrophic
// backtracking).
const isValidLoginEmail = (email: string): boolean => {
  if (email.length === 0 || email.length > MAX_EMAIL_LENGTH) return false;
  if (/\s/.test(email)) return false; // single character class, linear
  const at = email.indexOf("@");
  if (at <= 0 || at !== email.lastIndexOf("@")) return false; // exactly one '@', not leading
  const domain = email.slice(at + 1);
  const dot = domain.lastIndexOf(".");
  if (dot <= 0 || dot === domain.length - 1) return false; // dot present, not first/last char
  return true;
};

export type StoreLoginStatus = "unset" | "pending" | "active" | "disabled";

export type StoreLoginView = {
  storeId: string;
  storeName: string;
  email: string | null;
  role: "owner" | "staff" | null;
  status: StoreLoginStatus;
  lastSeenAt: string | null;
  attention: "ambiguous_login" | null;
  canConfigure: boolean;
};

export type StoreLoginUpsertRequest = {
  storeId: string;
  email: string;
  role: "owner" | "staff";
  idempotencyKey: string;
};

export type StoreLoginUpsertError =
  | "forbidden"
  | "forbidden_self_deactivation"
  | "invalid_request"
  | "store_not_found"
  | "email_in_use"
  | "idempotency_conflict"
  | "idempotency_in_progress"
  | "missing_database"
  | "write_failed";

export type StoreLoginRevokeError =
  | "forbidden"
  | "forbidden_self_deactivation"
  | "invalid_request"
  | "not_found"
  | "missing_database"
  | "write_failed";

export type StoreLoginUpsertResult =
  | { ok: true; storeId: string; replayed: boolean }
  | { ok: false; error: StoreLoginUpsertError };

export type StoreLoginRevokeResult =
  | { ok: true; storeId: string }
  | { ok: false; error: StoreLoginRevokeError };

type StoreLoginRole = "owner" | "staff";

const isStoreLoginRole = (value: unknown): value is StoreLoginRole =>
  value === "owner" || value === "staff";

export const parseStoreLoginUpsertRequest = (
  body: unknown
): StoreLoginUpsertRequest | null => {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return null;
  }
  const raw = body as Record<string, unknown>;

  const storeId = trimAndCap(raw.storeId, MAX_ID_LENGTH);
  if (!storeId) return null;

  if (typeof raw.email !== "string") return null;
  const email = raw.email.trim().toLowerCase();
  if (!isValidLoginEmail(email)) {
    return null;
  }

  if (!isStoreLoginRole(raw.role)) return null;

  const idempotencyKey = trimAndCap(raw.idempotencyKey, MAX_IDEMPOTENCY_KEY_LENGTH);
  if (!idempotencyKey) return null;

  return { storeId, email, role: raw.role, idempotencyKey };
};

// --- Resolver ---------------------------------------------------------------

type StoreLoginCandidate = {
  id: string;
  email: string;
  role: AdminUser["role"];
  active: number;
  access_subject: string;
  staff_member_id: string | null;
  last_seen_at: string | null;
};

export type ResolvedStoreLogin =
  | { kind: "none" }
  | { kind: "canonical"; row: StoreLoginCandidate; disabledRows: StoreLoginCandidate[] }
  | { kind: "disabled"; disabledRows: StoreLoginCandidate[] }
  | { kind: "ambiguous" };

const storeLoginStaffId = (storeId: string) => `staff_login_${storeId}`;

// Candidate set = EVERY human admin_users row linked (via staff_member_id) to
// ANY staff_member of the store. The store-login sentinel staff_login_<store> is
// itself such a staff_member, so this store_id JOIN is a SUPERSET that already
// includes the sentinel rows. We deliberately do NOT special-case the sentinel
// first: a fail-closed resolver MUST see legacy / extra rows (e.g. a stray
// system_admin or a second active human login linked to the same store) so they
// trigger `ambiguous`. NO role filter — system_admin must be DETECTED, never
// silently excluded (codex security review B3).
const CANDIDATE_FOR_STORE = `
  SELECT au.id, au.email, au.role, au.active, au.access_subject,
         au.staff_member_id, au.last_seen_at
  FROM admin_users au
  JOIN staff_members sm ON au.staff_member_id = sm.id
  WHERE sm.store_id = ?
    AND au.is_service_token = 0
  ORDER BY au.updated_at DESC, au.rowid DESC
`;

const fetchCandidateSet = async (
  db: D1Database,
  storeId: string
): Promise<StoreLoginCandidate[]> => {
  const rows = await db.prepare(CANDIDATE_FOR_STORE).bind(storeId).all<StoreLoginCandidate>();
  return rows.results ?? [];
};

const classifyCandidateSet = (
  rows: StoreLoginCandidate[],
  storeId: string
): ResolvedStoreLogin => {
  if (rows.length === 0) return { kind: "none" };
  // Fail-closed: any system_admin in scope is never owner-manageable here. The
  // store-wide set drives ambiguity + active-count detection.
  if (rows.some((row) => row.role === "system_admin")) {
    return { kind: "ambiguous" };
  }
  const activeRows = rows.filter((row) => row.active === 1);
  if (activeRows.length >= 2) {
    return { kind: "ambiguous" };
  }
  // History (revive / email-allow / disabled-status display) is restricted to
  // SENTINEL rows only (staff_login_<store>). A legacy/personal disabled row
  // linked to the store via an ordinary staff_member must NOT be revivable as
  // the shared store login, nor count as store-login history (codex PR #308
  // review, Fix B). It still participates in ambiguity/active detection above.
  const sentinelId = storeLoginStaffId(storeId);
  const disabledRows = rows.filter(
    (row) => row.active === 0 && row.staff_member_id === sentinelId
  );
  const hasSentinelRow = rows.some((row) => row.staff_member_id === sentinelId);
  const activeRow = activeRows[0];
  if (activeRow) {
    // A lone active SENTINEL row is the canonical store login.
    if (activeRow.staff_member_id === sentinelId) {
      return { kind: "canonical", row: activeRow, disabledRows };
    }
    // The lone active row is a legacy/personal row. Adopt it as canonical ONLY
    // when there is NO sentinel store-login lineage at all (first-time legacy
    // migration). If a sentinel row already exists (e.g. a disabled, previously
    // configured staff_login_<store>), this is a mixed state — fail closed so the
    // store-login UI never revokes/rotates a stray personal admin as if it were
    // the shared login (codex PR #308 review).
    if (hasSentinelRow) {
      return { kind: "ambiguous" };
    }
    return { kind: "canonical", row: activeRow, disabledRows: [] };
  }
  // 0 active
  if (disabledRows.length >= 1) {
    return { kind: "disabled", disabledRows };
  }
  return { kind: "none" };
};

export const resolveStoreLoginRow = async (
  db: D1Database,
  storeId: string
): Promise<ResolvedStoreLogin> => {
  const rows = await fetchCandidateSet(db, storeId);
  return classifyCandidateSet(rows, storeId);
};

// --- List -------------------------------------------------------------------

type StoreRow = { id: string; name: string };

// A store-login row can only be owner|staff (system_admin makes the store
// `ambiguous` and never reaches a view mapping). Narrow the AdminUser role to
// the view's owner|staff union without a nested ternary.
const toViewRole = (role: AdminUser["role"]): "owner" | "staff" =>
  role === "owner" ? "owner" : "staff";

const mapResolvedToView = (
  store: StoreRow,
  resolved: ResolvedStoreLogin
): StoreLoginView => {
  const base = {
    storeId: store.id,
    storeName: store.name
  };
  if (resolved.kind === "none") {
    return {
      ...base,
      email: null,
      role: null,
      status: "unset",
      lastSeenAt: null,
      attention: null,
      canConfigure: true
    };
  }
  if (resolved.kind === "ambiguous") {
    return {
      ...base,
      email: null,
      role: null,
      status: "disabled",
      lastSeenAt: null,
      attention: "ambiguous_login",
      canConfigure: false
    };
  }
  if (resolved.kind === "canonical") {
    const isPending = resolved.row.access_subject.startsWith("pending:");
    return {
      ...base,
      email: resolved.row.email,
      role: toViewRole(resolved.row.role),
      status: isPending ? "pending" : "active",
      lastSeenAt: resolved.row.last_seen_at,
      attention: null,
      canConfigure: true
    };
  }
  // disabled — surface the most-recent disabled row (set is ordered newest-first)
  const recent = resolved.disabledRows[0];
  return {
    ...base,
    email: recent?.email ?? null,
    role: recent ? toViewRole(recent.role) : null,
    status: "disabled",
    lastSeenAt: recent?.last_seen_at ?? null,
    attention: null,
    canConfigure: true
  };
};

// Bulk form of CANDIDATE_FOR_STORE for the owner list view: ONE query for every
// store's candidate rows instead of one query per store (the old listStoreLogins
// did 1 + N round-trips). `ORDER BY sm.store_id` clusters rows so JS grouping is
// a single linear pass; the trailing `updated_at DESC, au.rowid DESC` reproduces
// CANDIDATE_FOR_STORE's per-store ordering exactly, so classifyCandidateSet —
// the single source of truth for the resolver — sees identical input.
const CANDIDATE_FOR_ALL_STORES = `
  SELECT au.id, au.email, au.role, au.active, au.access_subject,
         au.staff_member_id, au.last_seen_at, sm.store_id AS store_id
  FROM admin_users au
  JOIN staff_members sm ON au.staff_member_id = sm.id
  WHERE au.is_service_token = 0
  ORDER BY sm.store_id, au.updated_at DESC, au.rowid DESC
`;

export const listStoreLogins = async (db: D1Database): Promise<StoreLoginView[]> => {
  const [stores, candidates] = await Promise.all([
    db.prepare(`SELECT id, name FROM stores ORDER BY id`).all<StoreRow>(),
    db.prepare(CANDIDATE_FOR_ALL_STORES).all<StoreLoginCandidate & { store_id: string }>()
  ]);
  const byStore = new Map<string, StoreLoginCandidate[]>();
  for (const row of candidates.results ?? []) {
    const group = byStore.get(row.store_id);
    if (group) group.push(row);
    else byStore.set(row.store_id, [row]);
  }
  return (stores.results ?? []).map((store) =>
    mapResolvedToView(store, classifyCandidateSet(byStore.get(store.id) ?? [], store.id))
  );
};

// --- Upsert -----------------------------------------------------------------

const buildUpsertRequestHash = (request: StoreLoginUpsertRequest) =>
  sha256Hex(
    JSON.stringify({
      storeId: request.storeId,
      email: request.email,
      role: request.role
    })
  );

const resolveUpsertIdempotency = (
  idempotency: IdempotencyRow | null,
  requestHash: string,
  storeId: string
): StoreLoginUpsertResult | undefined => {
  if (!idempotency) return undefined;
  if (idempotency.request_hash !== requestHash) {
    return { ok: false, error: "idempotency_conflict" };
  }
  if (idempotency.status === "succeeded" && idempotency.target_id) {
    return { ok: true, storeId, replayed: true };
  }
  return { ok: false, error: "idempotency_in_progress" };
};

const fetchAdminUserByEmail = async (
  db: D1Database,
  email: string
): Promise<StoreLoginCandidate | null> =>
  db
    .prepare(
      `SELECT id, email, role, active, access_subject, staff_member_id, last_seen_at
       FROM admin_users
       WHERE lower(email) = lower(?)
       LIMIT 1`
    )
    .bind(email)
    .first<StoreLoginCandidate>();

const auditUpsertStatement = (input: {
  db: D1Database;
  admin: AdminUser;
  request: StoreLoginUpsertRequest;
  caseLabel: "A" | "B" | "C";
}): D1PreparedStatement =>
  input.db
    .prepare(
      `INSERT INTO audit_logs (
         id, actor_type, actor_id, action, target_type, target_id, metadata_json
       ) VALUES (?, 'staff', ?, 'settings.store_login.upsert', 'store_login', ?, ?)`
    )
    .bind(
      crypto.randomUUID(),
      input.admin.id,
      input.request.storeId,
      JSON.stringify({
        storeId: input.request.storeId,
        email: input.request.email,
        role: input.request.role,
        case: input.caseLabel
      })
    );

// Statement that points the store-login admin_users row at `email`, either by
// reviving a same-store disabled row that already carries that email, or by
// inserting a fresh pending row. New/revived rows always get a brand-new
// pending sentinel so the next verified login re-binds.
const writeForEmailStatements = (input: {
  db: D1Database;
  storeId: string;
  request: StoreLoginUpsertRequest;
  disabledRows: StoreLoginCandidate[];
  nowIso: string;
}): D1PreparedStatement => {
  const reusable = input.disabledRows.find(
    (row) => row.email.toLowerCase() === input.request.email.toLowerCase()
  );
  const pendingSentinel = `pending:${crypto.randomUUID()}`;
  if (reusable) {
    // Move the revived row UNDER the staff_login_<store> sentinel so every active
    // store-login is covered by the 0031 partial UNIQUE index (codex security B1
    // follow-up): a legacy disabled row reactivated in place would otherwise keep
    // its legacy staff_member_id and escape the index, letting concurrent revives
    // create multiple active logins for one store.
    return input.db
      .prepare(
        `UPDATE admin_users
         SET staff_member_id = ?, role = ?, active = 1, access_subject = ?, updated_at = ?
         WHERE id = ?`
      )
      .bind(
        storeLoginStaffId(input.storeId),
        input.request.role,
        pendingSentinel,
        input.nowIso,
        reusable.id
      );
  }
  return input.db
    .prepare(
      `INSERT INTO admin_users (
         id, staff_member_id, email, access_subject, role, active, is_service_token,
         last_seen_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, 1, 0, NULL, ?, ?)`
    )
    .bind(
      crypto.randomUUID(),
      storeLoginStaffId(input.storeId),
      input.request.email,
      pendingSentinel,
      input.request.role,
      input.nowIso,
      input.nowIso
    );
};

// Ensures the deterministic staff_login_<store> staff_members row exists and is
// active with the requested role. ALWAYS targets the sentinel id (not the
// canonical row's staff_member_id): every NEW or REVIVED store-login admin_users
// row lands under staff_login_<store> (see writeForEmailStatements), so the
// sentinel staff_members row must exist or the FK fails. Case C rotation away
// from a LEGACY adopted login is the path that exposed this — the legacy
// staff_member existed but the sentinel did not (codex PR #308 review, Fix A).
// Case B updates the canonical row in place and does not depend on this; ensuring
// the sentinel additionally is harmless.
const ensureStoreLoginStaffStatement = (input: {
  db: D1Database;
  storeId: string;
  storeName: string;
  role: StoreLoginRole;
  nowIso: string;
}): D1PreparedStatement =>
  input.db
    .prepare(
      `INSERT INTO staff_members (id, store_id, display_name, role, active, created_at, updated_at)
       VALUES (?, ?, ?, ?, 1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET role = excluded.role, active = 1, updated_at = excluded.updated_at`
    )
    .bind(
      storeLoginStaffId(input.storeId),
      input.storeId,
      `${input.storeName} ログイン`,
      input.role,
      input.nowIso,
      input.nowIso
    );

const fetchStoreName = async (db: D1Database, storeId: string): Promise<string> => {
  const row = await db
    .prepare(`SELECT name FROM stores WHERE id = ? LIMIT 1`)
    .bind(storeId)
    .first<{ name: string }>();
  return row?.name ?? storeId;
};

// EMAIL ALLOW CHECK — an email already attached to another admin_users row is
// only acceptable if it belongs to THIS store's own login (the canonical row, or
// its disabled history). Anything else is a hijack attempt. Returns
// "email_in_use" to block, or null to allow.
const checkEmailAllowed = (input: {
  existingEmailRow: StoreLoginCandidate | null;
  canonicalRow: StoreLoginCandidate | null;
  disabledRows: StoreLoginCandidate[];
}): "email_in_use" | null => {
  const { existingEmailRow, canonicalRow, disabledRows } = input;
  if (!existingEmailRow) return null;
  const isCanonical = existingEmailRow.id === canonicalRow?.id;
  const isOwnDisabled = disabledRows.some((row) => row.id === existingEmailRow.id);
  return isCanonical || isOwnDisabled ? null : "email_in_use";
};

// Self-lockout guards (codex security review B2 + advisory): when the acting
// admin IS this store's canonical login, two self-mutations would strip their
// own access. (1) Email rotation (Case C) deactivates the canonical row while
// the new email is still an unbound `pending:` row. (2) An owner→staff
// self-downgrade (Case B) drops their own owner privilege. Both must be done by
// a different owner / system_admin. Same-email role-keep and create/revive (Case
// A) never affect the acting login. Mirrors the revoke-path F-3.2 guard. Returns
// "forbidden_self_deactivation" to block, or null to allow.
const checkSelfLockout = (
  admin: AdminUser,
  canonicalRow: StoreLoginCandidate | null,
  request: StoreLoginUpsertRequest
): "forbidden_self_deactivation" | null => {
  // Split the null checks from the id comparison so canonicalRow is narrowed
  // non-null for the property access below (an optional-chain collapse here would
  // break TS narrowing on canonicalRow.email/.role — SonarCloud S6582 vs TS).
  if (admin.staff_member_id === null || canonicalRow === null) {
    return null;
  }
  if (admin.staff_member_id !== canonicalRow.staff_member_id) {
    return null;
  }
  const emailRotating = canonicalRow.email.toLowerCase() !== request.email.toLowerCase();
  const selfDowngrade = canonicalRow.role === "owner" && request.role === "staff";
  return emailRotating || selfDowngrade ? "forbidden_self_deactivation" : null;
};

// Builds the case-specific admin_users mutation(s) for the upsert batch and the
// audit case label, WITHOUT performing any I/O. Case A (no active canonical):
// create or revive. Case B (same email): role/active refresh, keeping
// access_subject so a bound login stays logged in. Case C (email rotation):
// retire the old shared login then create/revive the new email as a fresh
// pending row, atomically in the same batch (old row deactivated first).
const buildCaseWrites = (input: {
  db: D1Database;
  request: StoreLoginUpsertRequest;
  canonicalRow: StoreLoginCandidate | null;
  disabledRows: StoreLoginCandidate[];
  nowIso: string;
}): { caseLabel: "A" | "B" | "C"; writes: D1PreparedStatement[] } => {
  const { db, request, canonicalRow, disabledRows, nowIso } = input;
  const emailWrite = () =>
    writeForEmailStatements({ db, storeId: request.storeId, request, disabledRows, nowIso });
  // 無効化されている行は、この upsert が revive するとき staff_member_id も access_subject も
  // 差し替わる (次にログインした別人がその行に紐付く)。そこに 12 時間の承認が残っていると
  // 引き継がれるので、無効化行の承認はまとめて落とす。active = 0 のあいだ承認は
  // authenticateAdmin に弾かれて既に死んでいるので、消して失うものは無い。
  const dropDisabledGrants = (): D1PreparedStatement[] =>
    disabledRows.length === 0
      ? []
      : [
          db
            .prepare(
              `DELETE FROM admin_customer_gate_challenges
               WHERE admin_user_id IN (${disabledRows.map(() => "?").join(", ")})`
            )
            .bind(...disabledRows.map((row) => row.id))
        ];

  if (!canonicalRow) {
    return { caseLabel: "A", writes: [...dropDisabledGrants(), emailWrite()] };
  }
  if (canonicalRow.email.toLowerCase() === request.email.toLowerCase()) {
    return {
      caseLabel: "B",
      writes: [
        ...dropDisabledGrants(),
        // 顧客タブの承認 (spec 008) は admin_user_id だけで引くので、役割を入れ替えても
        // 12 時間の承認が残る。この経路も admin_users.role を書き換えるので、
        // updateAdminStaff 側 (settings-staff.ts) と同じ掃除を入れる。sentinel 行だけを触るとは
        // 限らず、classifyCandidateSet は sentinel の系譜が無いときに個人の行を canonical に
        // 採るため、実在の staff の行がここに来る。UPDATE より前に置くのは、比較する role が
        // 変更前の値である必要があるから。settings-staff 側にある `OR active = 0` はここには
        // 不要 — canonicalRow は activeRows[0] 由来で必ず active = 1 なので発火しない。
        db
          .prepare(
            `DELETE FROM admin_customer_gate_challenges
             WHERE admin_user_id IN (
               SELECT id FROM admin_users WHERE id = ? AND role <> ?
             )`
          )
          .bind(canonicalRow.id, request.role),
        db
          .prepare(`UPDATE admin_users SET role = ?, active = 1, updated_at = ? WHERE id = ?`)
          .bind(request.role, nowIso, canonicalRow.id)
      ]
    };
  }
  return {
    caseLabel: "C",
    writes: [
      ...dropDisabledGrants(),
      // Case C はこれから canonical を無効化する。dropDisabledGrants が見るのは呼び出し時点で
      // 既に無効な行だけなので、この行はそこに入っていない。他の経路 (次の upsert・
      // updateAdminStaff の復帰時の掃除) が結果的に拾ってはいるが、3 ファイルにまたがる暗黙の
      // 分担になるので、ここで自己完結させる。
      db
        .prepare(`DELETE FROM admin_customer_gate_challenges WHERE admin_user_id = ?`)
        .bind(canonicalRow.id),
      db
        .prepare(`UPDATE admin_users SET active = 0, updated_at = ? WHERE id = ?`)
        .bind(nowIso, canonicalRow.id),
      emailWrite()
    ]
  };
};

export const upsertStoreLogin = async (input: {
  db: D1Database;
  admin: AdminUser;
  request: StoreLoginUpsertRequest;
  now?: () => number;
}): Promise<StoreLoginUpsertResult> => {
  if (!isAdminPrivileged(input.admin.role)) {
    return { ok: false, error: "forbidden" };
  }
  // Double-check role (parse already enforces owner|staff).
  if (!isStoreLoginRole(input.request.role)) {
    return { ok: false, error: "invalid_request" };
  }

  if (!(await storeExists(input.db, input.request.storeId))) {
    return { ok: false, error: "store_not_found" };
  }

  const requestHash = await buildUpsertRequestHash(input.request);
  // Derive the idempotency clock before the TTL read so the read, the expires_at write, and the catch re-read share one injected now (B8).
  const { nowIso, expiresAt, idempotencyId } = buildCreateContext(input.now);
  const existingIdempotency = await fetchAdminActionIdempotency(
    input.db,
    input.request.idempotencyKey,
    nowIso
  );
  const idempotencyResult = resolveUpsertIdempotency(
    existingIdempotency,
    requestHash,
    input.request.storeId
  );
  if (idempotencyResult) return idempotencyResult;

  const resolved = await resolveStoreLoginRow(input.db, input.request.storeId);
  if (resolved.kind === "ambiguous") {
    return { ok: false, error: "invalid_request" };
  }

  const canonicalRow = resolved.kind === "canonical" ? resolved.row : null;
  const disabledRows =
    resolved.kind === "canonical" || resolved.kind === "disabled"
      ? resolved.disabledRows
      : [];

  const existingEmailRow = await fetchAdminUserByEmail(input.db, input.request.email);
  const emailError = checkEmailAllowed({ existingEmailRow, canonicalRow, disabledRows });
  if (emailError) {
    return { ok: false, error: emailError };
  }

  const lockoutError = checkSelfLockout(input.admin, canonicalRow, input.request);
  if (lockoutError) {
    return { ok: false, error: lockoutError };
  }

  const { caseLabel, writes } = buildCaseWrites({
    db: input.db,
    request: input.request,
    canonicalRow,
    disabledRows,
    nowIso
  });

  // The staff_login_<store> sentinel staff_members row is only needed when a
  // NEW or REVIVED login row is written under it — Case A (create/revive) and
  // Case C (rotation). Case B updates the existing canonical (possibly a legacy
  // row) in place, so ensuring the sentinel there would leave an orphan
  // staff_members row (devin PR #308 review). Only ensure for A/C.
  const ensureStatements: D1PreparedStatement[] = [];
  if (caseLabel !== "B") {
    const storeName = await fetchStoreName(input.db, input.request.storeId);
    ensureStatements.push(
      ensureStoreLoginStaffStatement({
        db: input.db,
        storeId: input.request.storeId,
        storeName,
        role: input.request.role,
        nowIso
      })
    );
  }

  try {
    await input.db.batch([
      adminWriteGuard(input.db, input.admin),
      startedIdempotencyStatement({
        db: input.db,
        id: idempotencyId,
        key: input.request.idempotencyKey,
        requestHash,
        expiresAt,
        nowIso
      }),
      ...ensureStatements,
      ...writes,
      auditUpsertStatement({
        db: input.db,
        admin: input.admin,
        request: input.request,
        caseLabel
      }),
      succeededIdempotencyStatement({
        db: input.db,
        idempotencyId,
        targetType: "store_login",
        targetId: input.request.storeId,
        nowIso
      })
    ]);
  } catch (error) {
    if (await adminWriteWasRevoked(input.db, input.admin, error)) {
      return { ok: false, error: "forbidden" };
    }
    return recoverFromCreateBatchFailure({
      db: input.db,
      idempotencyKey: input.request.idempotencyKey,
      error,
      errorLabel: "upsertStoreLogin",
      nowIso,
      resolveReplay: (row) => resolveUpsertIdempotency(row, requestHash, input.request.storeId)
    });
  }

  return { ok: true, storeId: input.request.storeId, replayed: false };
};

// --- Revoke -----------------------------------------------------------------

export const revokeStoreLogin = async (input: {
  db: D1Database;
  admin: AdminUser;
  storeId: string;
  now?: () => number;
}): Promise<StoreLoginRevokeResult> => {
  if (!isAdminPrivileged(input.admin.role)) {
    return { ok: false, error: "forbidden" };
  }

  const resolved = await resolveStoreLoginRow(input.db, input.storeId);
  if (resolved.kind === "ambiguous") {
    return { ok: false, error: "invalid_request" };
  }
  if (resolved.kind === "none" || resolved.kind === "disabled") {
    return { ok: false, error: "not_found" };
  }

  // Self-lockout guard (mirrors settings-staff F-3.2): an admin must not
  // deactivate the very login they are authenticated as.
  if (
    input.admin.staff_member_id !== null &&
    input.admin.staff_member_id === resolved.row.staff_member_id
  ) {
    return { ok: false, error: "forbidden_self_deactivation" };
  }

  const nowIso = new Date((input.now ?? Date.now)()).toISOString();

  try {
    await input.db.batch([
      adminWriteGuard(input.db, input.admin),
      input.db
        .prepare(`UPDATE admin_users SET active = 0, updated_at = ? WHERE id = ?`)
        .bind(nowIso, resolved.row.id),
      input.db
        .prepare(
          `INSERT INTO audit_logs (
             id, actor_type, actor_id, action, target_type, target_id, metadata_json
           ) VALUES (?, 'staff', ?, 'settings.store_login.revoke', 'store_login', ?, ?)`
        )
        .bind(
          crypto.randomUUID(),
          input.admin.id,
          input.storeId,
          JSON.stringify({
            storeId: input.storeId,
            revokedAdminUserId: resolved.row.id,
            email: resolved.row.email,
            adminRole: input.admin.role
          })
        )
    ]);
  } catch (error) {
    if (await adminWriteWasRevoked(input.db, input.admin, error)) {
      return { ok: false, error: "forbidden" };
    }
    // Security-sensitive: a swallowed failure leaves the staff login active
    // even though the owner believes it was revoked. Surface to Sentry.
    safeCaptureException(error instanceof Error ? error : new Error(String(error)), {
      tags: { component: "store-login", op: "revoke_batch_failed" },
      contexts: { revoke: { storeId: input.storeId, adminRole: input.admin.role } }
    });
    console.error("revokeStoreLogin batch failed", {
      storeId: input.storeId,
      error: error instanceof Error ? error.message : String(error)
    });
    return { ok: false, error: "write_failed" };
  }

  return { ok: true, storeId: input.storeId };
};
