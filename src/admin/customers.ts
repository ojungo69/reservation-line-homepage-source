import {
  VISITED_AT_JST_ORDER_KEY,
  escapeLikePattern,
  exceedsLikePatternBudget,
  phoneExactSearchVariants
} from "./shared";

type AdminCustomerSearchItem = {
  id: string;
  displayName: string;
  displayNameKana: string | null;
  phoneNormalized: string | null;
  blockStatus: string;
  memo: string | null;
};

export type AdminCustomerSearchResult =
  | { ok: true; customers: AdminCustomerSearchItem[] }
  | { ok: false; reason: "invalid_request" };

type CustomerRow = {
  id: string;
  display_name: string;
  display_name_kana: string | null;
  phone_normalized: string | null;
  block_status: string;
  memo: string | null;
};

const PHONE_LIKE_CHARS = /^[+\d\s\-().]*$/;

type NormalizedCustomerSearchQuery = {
  text: string | null;
  phoneA: string | null;
  phoneB: string | null;
};

export type NormalizeCustomerSearchQueryResult =
  | NormalizedCustomerSearchQuery
  | { ok: false; reason: "invalid_request" };

export const normalizeCustomerSearchQuery = (
  raw: string
): NormalizeCustomerSearchQueryResult => {
  const trimmed = raw.trim();
  if (trimmed === "") {
    return { ok: false, reason: "invalid_request" };
  }

  const digits = trimmed.replace(/\D/g, "");
  // 完全一致の候補は phoneExactSearchVariants が唯一の出所。ここに二つ目の双子ロジックを
  // 置くと、片方だけ直したときに検索とブロックがずれる。番号として成立しない入力では
  // 空配列が返るので、その判定もこれ 1 本で足りる。
  const variants = phoneExactSearchVariants(trimmed);

  let phoneA: string | null;
  let phoneB: string | null;
  const [exact, twin] = variants;
  if (exact !== undefined) {
    phoneA = exact;
    phoneB = twin ?? exact;
  } else if (digits.length >= 3 && digits.length <= 7) {
    phoneA = digits;
    phoneB = digits;
  } else {
    phoneA = null;
    phoneB = null;
  }

  const text = PHONE_LIKE_CHARS.test(trimmed) ? null : trimmed;
  return { text, phoneA, phoneB };
};

const isFailure = (
  value: NormalizeCustomerSearchQueryResult
): value is { ok: false; reason: "invalid_request" } =>
  (value as { ok?: false }).ok === false;

// Store-scope predicate for staff customer access. A staff member may act on a
// customer ONLY when the customer is canonical (not merged) AND has at least one
// reservation (any status) OR one VALID customer_visit at the staff's store OR
// was manually registered by that store (created_store_id). A voided visit alone
// does NOT grant access (fail-closed). Owner / system_admin bypass this entirely
// (callers gate on role). customer_id is a UUID so the 403-vs-404 existence
// oracle this introduces is not enumerable.
//
// opts.includeArchived drops ONLY the archived_at filter — the merge-tombstone
// and store conditions always apply. Used by the unarchive path (and the staff
// customer detail read behind it): an archived customer is by definition the
// target of "restore", so requiring archived_at IS NULL there would make archive
// a one-way door for staff. Everything that WRITES to a customer keeps the
// default (archived customers are read-only for staff and owner alike).
// The three membership arms as one SQL fragment, for the per-row form of the test
// (the list/search form is STORE_MEMBERSHIP_UNION below). The customers row must be
// aliased `c`, and the three `?` bind the same storeId in this order. Shared rather
// than copied: reservation-create.ts needs the identical predicate, and a comment
// asking two copies to stay identical is a request to make it structural.
export const OWN_STORE_MEMBERSHIP_ARMS =
  `(
     EXISTS (SELECT 1 FROM reservations r WHERE r.customer_id = c.id AND r.store_id = ?)
     OR EXISTS (
       SELECT 1 FROM customer_visits cv
       WHERE cv.customer_id = c.id AND cv.store_id = ? AND cv.status = 'valid'
     )
     OR c.created_store_id = ?
   )`;

export const staffCanAccessCustomer = async (
  db: D1Database,
  customerId: string,
  storeId: string,
  opts: { includeArchived?: boolean } = {}
): Promise<boolean> => {
  const row = await db
    .prepare(
      `SELECT 1 AS hit
       FROM customers c
       WHERE c.id = ?
         AND c.merged_into_id IS NULL
         ${opts.includeArchived ? "" : "AND c.archived_at IS NULL"}
         AND ${OWN_STORE_MEMBERSHIP_ARMS}
       LIMIT 1`
    )
    .bind(customerId, storeId, storeId, storeId)
    .first<{ hit: number }>();
  return row != null;
};

// Single source of truth for the own-store membership sub-select (a customer
// "belongs" to a store if they have a reservation there, a valid visit there, or
// were manually registered there). THREE `?` bind the storeId — keep every call
// site's bind list in lockstep. Reused by storeScopeMembership and
// listAllCustomers so the SQL text isn't hand-copied across the three query sites.
const STORE_MEMBERSHIP_UNION =
  "SELECT customer_id FROM reservations WHERE store_id = ?" +
  " UNION ALL SELECT customer_id FROM customer_visits WHERE store_id = ? AND status = 'valid'" +
  " UNION ALL SELECT id FROM customers WHERE created_store_id = ?";

// Reusable own-store membership filter for staff list/search. Returns the SQL
// fragment + ordered bind params; empty when no scope (owner/system_admin see all
// stores). Kept as a single builder so the body and count queries stay in lockstep.
//
// Only null / undefined mean "no scope". A blank store id is a broken staff row,
// not a privilege — it gets bound like any other value and matches nothing, so the
// staff sees an empty list instead of every store (issue #640 B-1). staffHasStore
// rejects the same value one layer earlier.
const storeScopeMembership = (storeId: string | null | undefined): { clause: string; params: string[] } => {
  if (storeId === null || storeId === undefined) return { clause: "", params: [] };
  return {
    clause: ` AND id IN (${STORE_MEMBERSHIP_UNION})`,
    params: [storeId, storeId, storeId]
  };
};

export async function searchAdminCustomers(input: {
  db: D1Database;
  query: string;
  limit?: number;
  // When set (staff), results are limited to the staff's own-store customers.
  storeScope?: string | null;
  // Staff see only the last-4 masked phone (matches the list view + customer/
  // reservation detail); owner / system_admin receive the raw phone_normalized.
  isStaff?: boolean;
  // Customer-tab gate (spec 008): a staff member without the owner's approval still
  // needs name search — the reservation-create picker and the LINE friend-link dialog
  // both call this route — but must not read memos through it. Decided server-side
  // from the grant, never from a client-supplied parameter.
  redactMemo?: boolean;
}): Promise<AdminCustomerSearchResult> {
  const normalized = normalizeCustomerSearchQuery(input.query);
  if (isFailure(normalized)) {
    return normalized;
  }

  const conditions: string[] = [];
  const bindings: (string | number)[] = [];

  if (normalized.text !== null) {
    const textPattern = `%${escapeLikePattern(normalized.text)}%`;
    if (exceedsLikePatternBudget(textPattern)) {
      return { ok: false, reason: "invalid_request" };
    }
    conditions.push(String.raw`display_name LIKE ? ESCAPE '\'`);
    bindings.push(textPattern);
    conditions.push(String.raw`display_name_kana LIKE ? ESCAPE '\'`);
    bindings.push(textPattern);
  }

  // Phone matching. Owner/system_admin use substring LIKE for convenience. Staff
  // get EXACT match (= ?): they only ever see the last-4 masked phone, so a
  // substring LIKE would be a recovery oracle — a store-scoped staff member could
  // binary-search the masked middle digits by probing `%partial%` and watching
  // which result appears. Exact match still serves the real workflow (look a
  // customer up by their FULL number — both canonical variants are matched),
  // while a partial (3-7 digit) probe matches nothing. Returns null only when a
  // non-staff LIKE pattern blows D1's 50-byte cap.
  const phoneMatch = (value: string): { clause: string; bind: string } | null => {
    if (input.isStaff) {
      return { clause: "phone_normalized = ?", bind: value };
    }
    const pattern = `%${value}%`;
    return exceedsLikePatternBudget(pattern) ? null : { clause: "phone_normalized LIKE ?", bind: pattern };
  };

  if (normalized.phoneA !== null) {
    const match = phoneMatch(normalized.phoneA);
    if (!match) {
      return { ok: false, reason: "invalid_request" };
    }
    conditions.push(match.clause);
    bindings.push(match.bind);
  }

  if (normalized.phoneB !== null && normalized.phoneB !== normalized.phoneA) {
    const match = phoneMatch(normalized.phoneB);
    if (!match) {
      return { ok: false, reason: "invalid_request" };
    }
    conditions.push(match.clause);
    bindings.push(match.bind);
  }

  if (conditions.length === 0) {
    return { ok: false, reason: "invalid_request" };
  }

  // Staff store-scope membership filter is appended AFTER the text/phone match
  // params and BEFORE the limit, so the bind order matches the textual order of
  // the `?` placeholders exactly.
  const scope = storeScopeMembership(input.storeScope);
  bindings.push(...scope.params);

  const limit = input.limit ?? 20;
  bindings.push(limit);

  const rows = await input.db
    .prepare(
      `
        SELECT id, display_name, display_name_kana, phone_normalized, block_status, memo
        FROM customers
        WHERE merged_into_id IS NULL
          AND archived_at IS NULL
          AND (${conditions.join(" OR ")})${scope.clause}
        ORDER BY updated_at DESC
        LIMIT ?
      `
    )
    .bind(...bindings)
    .all<CustomerRow>();

  return {
    ok: true,
    customers: (rows.results ?? []).map((r) => ({
      id: r.id,
      displayName: r.display_name,
      displayNameKana: r.display_name_kana,
      phoneNormalized: input.isStaff && r.phone_normalized ? maskPhoneTail(r.phone_normalized) : r.phone_normalized,
      blockStatus: r.block_status,
      memo: input.redactMemo ? null : r.memo
    }))
  };
}

// ── All-customers list (paginated, no search filter) ────────────────
// Returns every customer with aggregated reservation stats for the
// admin customer list view. Merged tombstones (merged_into_id IS NOT
// NULL) are excluded so the list only shows canonical records.

export type CustomerListRow = {
  id: string;
  displayName: string;
  displayNameKana: string | null;
  phoneNormalizedMasked: string;
  blockStatus: string;
  visitCount: number;
  lastVisitAt: string | null;
  nextReservationAt: string | null;
  memo: string | null;
};

export const listAllCustomers = async (
  db: D1Database,
  limit = 200,
  offset = 0,
  opts: { archivedOnly?: boolean; storeScope?: string | null } = {}
): Promise<{ customers: CustomerListRow[]; total: number }> => {
  // Active list hides archived rows; the archived view shows only them.
  // Both clauses are derived from a boolean (opts.archivedOnly), never from
  // user input — no injection surface.
  const archiveClause = opts.archivedOnly ? "c.archived_at IS NOT NULL" : "c.archived_at IS NULL";
  const archiveCountClause = opts.archivedOnly ? "archived_at IS NOT NULL" : "archived_at IS NULL";

  // Staff store-scope (storeScope set): every derived value must be scoped to the
  // staff's own store, not just the row set — otherwise a cross-store customer would
  // leak other stores' visitCount / lastVisitAt / nextReservationAt to staff. The
  // per-subquery store filter does that; the membership clause limits which
  // customers appear at all. Owner / system_admin pass storeScope=null → full view.
  // Scoped on anything but null/undefined — see storeScopeMembership for why a
  // blank store id must stay scoped rather than fall through to the full view.
  const storeId = opts.storeScope ?? null;
  const scoped = storeId !== null;
  const visitStore = scoped ? " AND cv.store_id = ?" : "";
  const resvStore = scoped ? " AND r.store_id = ?" : "";
  // c.id (body, aliased table) and id (count, single table) both resolve to
  // customers.id; reuse the shared membership sub-select. THREE storeId binds per
  // clause (reservation / valid visit / created_store_id), in textual position.
  const memberBody = scoped ? ` AND c.id IN (${STORE_MEMBERSHIP_UNION})` : "";
  const memberCount = scoped ? ` AND id IN (${STORE_MEMBERSHIP_UNION})` : "";

  // Bind order = textual `?` order: visitCount store, lastVisitAt store,
  // nextReservationAt store, member-IN store x3, list-order store, then limit, offset.
  const bodyParams: (string | number)[] = [];
  if (scoped) bodyParams.push(storeId, storeId, storeId, storeId, storeId, storeId, storeId);
  bodyParams.push(limit, offset);
  const countParams: string[] = scoped ? [storeId, storeId, storeId] : [];

  const [rows, countRow] = await Promise.all([
    db
      .prepare(
        // visitCount / lastVisitAt come from the customer_visits ledger
        // (status='valid'), NOT from completed reservations directly. The
        // ledger is the single source of truth used everywhere else
        // (valid_visit_count for new/existing detection, the Google title
        // self-exclusion, and the customer detail panel). Every admin
        // "complete" action writes one ledger row (reservation_id UNIQUE,
        // status default 'valid'), so completed reservations are still
        // counted exactly once; manual_import / paper_chart_import visits
        // (paper-chart history added from the card) are now included too,
        // and voided visits are correctly excluded. Correlated subqueries
        // avoid the reservations×visits fan-out a double JOIN would create.
        `
        SELECT
          c.id,
          c.display_name       AS displayName,
          c.display_name_kana  AS displayNameKana,
          CASE
            WHEN c.phone_normalized IS NOT NULL
            THEN '***-****-' || substr(c.phone_normalized, -4)
            ELSE ''
          END                  AS phoneNormalizedMasked,
          c.block_status       AS blockStatus,
          c.memo,
          (SELECT COUNT(*) FROM customer_visits cv
            WHERE cv.customer_id = c.id AND cv.status = 'valid'${visitStore})        AS visitCount,
          (SELECT cv.visited_at FROM customer_visits cv
            WHERE cv.customer_id = c.id AND cv.status = 'valid'${visitStore}
            ORDER BY ${VISITED_AT_JST_ORDER_KEY} DESC, cv.created_at DESC, cv.id DESC
            LIMIT 1)                                                               AS lastVisitAt,
          (SELECT MIN(r.start_at) FROM reservations r
            WHERE r.customer_id = c.id AND r.status = 'confirmed'
              AND datetime(r.start_at) > datetime('now')${resvStore})              AS nextReservationAt
        FROM customers c
        WHERE c.merged_into_id IS NULL
          AND ${archiveClause}${memberBody}
        ORDER BY (SELECT MAX(${VISITED_AT_JST_ORDER_KEY})
                  FROM customer_visits cv
                  WHERE cv.customer_id = c.id AND cv.status = 'valid'${visitStore}) DESC NULLS LAST,
                 c.created_at DESC
        LIMIT ? OFFSET ?
        `
      )
      .bind(...bodyParams)
      .all<CustomerListRow>(),
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM customers WHERE merged_into_id IS NULL AND ${archiveCountClause}${memberCount}`
      )
      .bind(...countParams)
      .first<{ n: number }>()
  ]);

  return {
    customers: rows.results ?? [],
    total: countRow?.n ?? 0
  };
};

// Read-only merge candidate detection.
// Groups customers by phone_hash and surfaces every (phone_hash, [customer
// list]) pair where the same phone_hash appears on multiple rows. This is
// the input the merge UI consumes — the admin sees side-by-side candidates
// and chooses which row to keep. The merge endpoint
// (POST /api/admin/customers/:id/merge) is in src/admin/customer-merge.ts.
//
// phone_hash is SHA-256(normalised_phone) (see src/admin/shared.ts), so two
// rows with the same phone_hash had identical pre-hash phone digits at
// write time — a strong signal of a duplicate customer record (most
// commonly: same person registered twice via LINE login + walk-in).

export type AdminMergeCandidateCustomer = {
  id: string;
  displayName: string;
  displayNameKana: string | null;
  phoneNormalizedMasked: string;
  blockStatus: string;
  // ISO timestamp of the most recent reservation tied to this customer.
  // NULL means "no reservation history" — operator-facing UI can sort
  // candidates by this to surface the row most recently active.
  lastReservationAt: string | null;
};

export type AdminMergeCandidateGroup = {
  phoneHash: string;
  customers: AdminMergeCandidateCustomer[];
};

export type AdminMergeCandidatesResult = {
  ok: true;
  groups: AdminMergeCandidateGroup[];
  // truncated=true when the query hit `limit` groups; UI surfaces a
  // "more candidates exist, narrow the search" notice.
  truncated: boolean;
};

const maskPhoneTail = (raw: string | null): string => {
  if (!raw) return "****";
  const digits = raw.replace(/\D/g, "");
  if (digits.length < 4) return "****";
  return `***-****-${digits.slice(-4)}`;
};

export async function listCustomerMergeCandidates(input: {
  db: D1Database;
  // Hard cap on returned groups so a runaway dataset can't blow up memory
  // before the (rare) merge UI ever opens. Default 50; production has
  // <500 customer rows total, so this is well above the realistic cap.
  limit?: number;
}): Promise<AdminMergeCandidatesResult> {
  const limit = Math.max(1, Math.min(500, Math.floor(input.limit ?? 50)));
  // Probe one extra group to detect the truncation cliff cheaply.
  const probeLimit = limit + 1;

  // Tombstoned merge sources (merged_into_id IS NOT NULL) keep the same
  // phone_hash as their canonical target by design. Excluding them from
  // the candidate grouping prevents the merge UI from re-surfacing the
  // already-merged pair forever (clicking it would just return
  // already_merged); the count of remaining canonical rows per hash is
  // what tells the admin whether a duplicate still exists.
  const groupResult = await input.db
    .prepare(
      `
        SELECT phone_hash, COUNT(*) AS group_size
        FROM customers
        WHERE phone_hash IS NOT NULL
          AND merged_into_id IS NULL
          AND archived_at IS NULL
        GROUP BY phone_hash
        HAVING COUNT(*) > 1
        ORDER BY group_size DESC, phone_hash ASC
        LIMIT ?
      `
    )
    .bind(probeLimit)
    .all<{ phone_hash: string; group_size: number }>();
  const hashRows = groupResult.results ?? [];

  if (hashRows.length === 0) {
    return { ok: true, groups: [], truncated: false };
  }

  // Fetch every customer in the duplicate groups with one IN query, for ALL
  // probed hashes (up to limit + 1). Slicing to `limit` before this fetch would
  // drop the probe's extra group, so a group removed by the `> 1` filter below
  // could not be backfilled and truncation could not be judged on the filtered
  // set — yielding a false "more exists" or, worse, a false "no more". The
  // index on customers(phone_hash) (migration 0001) keeps this fast. Subquery
  // returns latest reservation timestamp per customer.
  const placeholders = hashRows.map(() => "?").join(",");
  const customerResult = await input.db
    .prepare(
      `
        SELECT
          c.id,
          c.display_name,
          c.display_name_kana,
          c.phone_normalized,
          c.phone_hash,
          c.block_status,
          (SELECT MAX(start_at) FROM reservations WHERE customer_id = c.id) AS last_reservation_at
        FROM customers c
        WHERE c.phone_hash IN (${placeholders})
          AND c.merged_into_id IS NULL
          AND c.archived_at IS NULL
        ORDER BY c.phone_hash ASC, last_reservation_at DESC NULLS LAST, c.id ASC
      `
    )
    .bind(...hashRows.map((g) => g.phone_hash))
    .all<{
      id: string;
      display_name: string;
      display_name_kana: string | null;
      phone_normalized: string | null;
      phone_hash: string;
      block_status: string;
      last_reservation_at: string | null;
    }>();

  const byHash = new Map<string, AdminMergeCandidateCustomer[]>();
  for (const row of customerResult.results ?? []) {
    const list = byHash.get(row.phone_hash) ?? [];
    list.push({
      id: row.id,
      displayName: row.display_name,
      displayNameKana: row.display_name_kana,
      phoneNormalizedMasked: maskPhoneTail(row.phone_normalized),
      blockStatus: row.block_status,
      lastReservationAt: row.last_reservation_at
    });
    byHash.set(row.phone_hash, list);
  }

  // Preserve the group ordering from the GROUP BY query (descending group
  // size, then ascending phone_hash) so the operator sees the biggest
  // duplicate clusters first. Filter to groups that still have a real duplicate
  // (> 1 canonical record) after the merged_into_id IS NULL fetch.
  const allGroups: AdminMergeCandidateGroup[] = hashRows
    .map((g) => ({
      phoneHash: g.phone_hash,
      customers: byHash.get(g.phone_hash) ?? []
    }))
    .filter((group) => group.customers.length > 1);

  // Derive both the visible page and `truncated` from the same post-filter set
  // so the "more candidates exist" hint matches what is actually shown: there
  // are more real duplicate groups than fit on this page.
  const groups = allGroups.slice(0, limit);
  const truncated = allGroups.length > limit;

  return { ok: true, groups, truncated };
}
