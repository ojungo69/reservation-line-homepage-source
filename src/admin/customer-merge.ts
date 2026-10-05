import type { AdminUser } from "./access";
import { adminWriteSnapshot, adminWriteWasRevoked } from "./write-authorization";

// Tier C.2 — merge two customer records that share the same phone_hash
// (the strong-signal duplicate detector surfaced by listCustomerMergeCandidates
// in src/admin/customers.ts). The action is irreversible by design: the
// source row stays as a tombstone (block_status='blocked' + merged_into_id
// pointing to the target) so audit_logs retain provenance, and every
// reservation previously linked to the source is re-pointed at the target.
//
// Schema invariant: existing CHECK on customers.block_status only allows
// 'active' / 'blocked'. Migration 0014 added the merged_into_id column
// instead of widening the CHECK because rewriting the column constraint
// on D1 requires a full table rebuild that interlocks with concurrent
// admin operations.

export type AdminCustomerMergeRequest = {
  targetId: string;
};

export type AdminCustomerMergeError =
  | "invalid_request"
  | "same_customer"
  | "not_found"
  | "already_merged"
  | "target_already_merged"
  | "source_blocked"
  | "phone_hash_mismatch"
  | "forbidden"
  | "missing_database";

export type AdminCustomerMergeResult =
  | {
      ok: true;
      sourceId: string;
      targetId: string;
      reservationsMoved: number;
    }
  | {
      ok: false;
      error: AdminCustomerMergeError;
    };

const MAX_CUSTOMER_ID_LENGTH = 128;

export const parseAdminCustomerMergeRequest = (body: unknown): AdminCustomerMergeRequest | null => {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return null;
  }
  const targetId = (body as Record<string, unknown>).targetId;
  if (typeof targetId !== "string") return null;
  const trimmed = targetId.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_CUSTOMER_ID_LENGTH) return null;
  return { targetId: trimmed };
};

type CustomerMergeRow = {
  id: string;
  phone_hash: string | null;
  merged_into_id: string | null;
  block_status: string;
};

const fetchCustomerForMerge = async (
  db: D1Database,
  id: string
): Promise<CustomerMergeRow | null> => {
  return db
    .prepare(
      `
        SELECT id, phone_hash, merged_into_id, block_status
        FROM customers
        WHERE id = ?
      `
    )
    .bind(id)
    .first<CustomerMergeRow>();
};

// 空白だけの値は「未入力」と同じ扱いにする。全角スペース (U+3000 = 12288) まで落とすのは
// 日本語の手入力で一番出やすい形だから (operations.ts の施術メモ判定と同じ文字集合)。
const BLANK_TRIM_CHARS = "char(32, 9, 10, 13, 12288)";

/**
 * 統合先 (?2) の該当列が NULL か空白だけのときに限り、統合元 (?1) の値で埋める CASE 式。
 * COALESCE 1 発では書けない: 空文字列は COALESCE にとって「値あり」なので、空欄の統合先が
 * 埋まらないまま素通りする。
 */
const carryForwardBlankColumn = (column: string): string => `${column} = CASE
                WHEN ${column} IS NULL OR trim(${column}, ${BLANK_TRIM_CHARS}) = ''
                THEN COALESCE(
                       (SELECT NULLIF(trim(source.${column}, ${BLANK_TRIM_CHARS}), '')
                          FROM customers AS source WHERE source.id = ?1),
                       ${column}
                     )
                ELSE ${column}
              END`;

export const executeAdminCustomerMerge = async (input: {
  db: D1Database;
  admin: AdminUser;
  sourceId: string;
  targetId: string;
  now?: () => number;
}): Promise<AdminCustomerMergeResult> => {
  if (input.admin.role === "staff") {
    return { ok: false, error: "forbidden" };
  }
  if (input.sourceId === input.targetId) {
    return { ok: false, error: "same_customer" };
  }

  const [source, target] = await Promise.all([
    fetchCustomerForMerge(input.db, input.sourceId),
    fetchCustomerForMerge(input.db, input.targetId)
  ]);
  if (!source || !target) {
    return { ok: false, error: "not_found" };
  }
  // Order matters: tombstone-check first so an operator who picks the same
  // already-merged row twice gets a clear signal instead of a phone_hash
  // mismatch (a merged tombstone may still match phone_hash but is no
  // longer a meaningful merge candidate).
  if (source.merged_into_id !== null) {
    return { ok: false, error: "already_merged" };
  }
  // Target tombstone guard: a customer that is already merged into a third
  // customer is no longer canonical — pointing more reservations at it
  // would chain merges instead of consolidating to the canonical record.
  if (target.merged_into_id !== null) {
    return { ok: false, error: "target_already_merged" };
  }
  // Manual-block preservation: if source carries a real admin block
  // (block_status='blocked' but merged_into_id is still NULL — i.e. an
  // un-merged blocked customer), the merge would overwrite that block
  // signal with the tombstone state and the tombstone-aware booking
  // lookups added in this PR would then accept bookings for the phone
  // because the canonical target is 'active'. Refuse the merge so the
  // admin must explicitly block the target first (or unblock the source)
  // before consolidating.
  if (source.block_status === "blocked") {
    return { ok: false, error: "source_blocked" };
  }
  if (source.phone_hash === null || target.phone_hash === null || source.phone_hash !== target.phone_hash) {
    return { ok: false, error: "phone_hash_mismatch" };
  }

  const nowIso = new Date((input.now ?? Date.now)()).toISOString();
  const phoneHashPrefix = source.phone_hash.slice(0, 8);
  // Statement order is load-bearing: the guarded customers UPDATE runs
  // first so its changes() row count gates the audit INSERT and the
  // reservations UPDATE. If a concurrent merge already tombstoned the
  // source between our SELECT and this batch, customers.changes()=0
  // → audit and reservations updates both no-op (changes() chain), the
  // batch commits cleanly, and the caller sees an "already_merged"
  // error path via batchResult[0].meta.changes inspection below.
  //
  // PII note: audit metadata records only the first 8 hex chars of the
  // phone_hash (a privacy-vs-forensics balance). Full hashes never enter
  // audit_logs to avoid amplifying the blast radius if audit log dumps
  // leak — full hashes already live in customers.phone_hash where access
  // is gated.
  const auditMetadata = JSON.stringify({
    sourceId: input.sourceId,
    targetId: input.targetId,
    phone_hash_prefix: phoneHashPrefix,
    adminRole: input.admin.role
  });

  // The pre-check above is a UX fast-path so the admin sees a precise
  // error code, but every invariant is re-validated inside the guarded
  // UPDATE so a concurrent merge cannot squeeze through the SELECT→batch
  // gap. Specifically the EXISTS subquery confirms the target is still
  // canonical (merged_into_id IS NULL) AND still shares phone_hash with
  // the source at write time — without it a parallel merge of the target
  // (between our SELECT and this batch) could land reservations on a
  // non-canonical row, breaking the tombstone invariant codex iter 2
  // flagged.
  //
  // Gating chain: step 0 (customers UPDATE) decides the winner, step 1
  // INSERT audit_logs gates on `changes()=1` so audit row only lands
  // when customers changed. Steps 2..N gate on `EXISTS (audit_logs
  // WHERE id=?)` — a STABLE pointer to the winning audit row, not the
  // per-step `changes()` count. The previous chain on `(SELECT changes())
  // = 1` broke when reservations matched 0 or 2+ rows: changes() then
  // reported that row count to the next statement and line_identities /
  // customer_visits / customer_time_locks silently no-op'd (codex iter 4
  // blocking finding). Anchoring on the audit row keeps every side-effect
  // UPDATE tied directly to the customers UPDATE outcome.
  const auditId = crypto.randomUUID();
  const actorSnapshot = adminWriteSnapshot(input.admin);
  const batchResult = await input.db.batch([
    input.db
      .prepare(
        `
          UPDATE customers
          SET block_status = 'blocked',
              merged_into_id = ?,
              updated_at = ?
          WHERE id = ?
            AND ${actorSnapshot.sql}
            AND merged_into_id IS NULL
            AND block_status = 'active'
            AND phone_hash IS NOT NULL
            AND EXISTS (
              SELECT 1
              FROM customers AS target
              WHERE target.id = ?
                AND target.merged_into_id IS NULL
                AND target.phone_hash = customers.phone_hash
            )
        `
      )
      .bind(input.targetId, nowIso, input.sourceId, ...actorSnapshot.bindings, input.targetId),
    input.db
      .prepare(
        `
          INSERT INTO audit_logs (
            id, actor_type, actor_id, action, target_type, target_id, metadata_json
          )
          SELECT ?, 'staff', ?, 'customer.merge', 'customer', ?, ?
          WHERE changes() = 1
        `
      )
      .bind(auditId, input.admin.id, input.sourceId, auditMetadata),
    // Enqueue one calendar_sync_jobs row per **source** reservation so
    // Google Calendar event titles (which embed the customer name via PII
    // sanitizer) get refreshed after the merge re-points them.
    //
    // Statement order is load-bearing: this INSERT runs BEFORE the
    // reservations UPDATE below so it can SELECT from reservations WHERE
    // customer_id = sourceId. If placed after the UPDATE, the SELECT
    // would match targetId and inadvertently pick up reservations that
    // were already on the target before the merge (codex iter 1 blocking).
    //
    // dedupe_key format: cm:<auditId>:r:<reservationId>
    //   auditId is a UUID (36 chars) that uniquely identifies this merge
    //   attempt, so the key is deterministic per merge + reservation.
    //   Total length: 3 + 36 + 2 + len(reservationId). In practice,
    //   reservation IDs are UUIDs (36 chars) → 77 chars, well under the
    //   256-char CHECK constraint. The substr(..., 1, 256) cap prevents
    //   CHECK violations if a non-UUID reservation ID were ever created.
    //   Note: truncation could cause two distinct long IDs to collide,
    //   losing a sync job — this is acceptable only because reservation
    //   IDs are UUIDs in practice (invariant).
    //
    // google_action = 'upsert': the calendar event already exists, we
    //   only need to refresh the title/description, not create or delete.
    input.db
      .prepare(
        `
          INSERT OR IGNORE INTO calendar_sync_jobs (
            id,
            dedupe_key,
            owner_type,
            owner_id,
            google_action,
            status,
            available_at
          )
          SELECT
            lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' ||
                  substr(hex(randomblob(2)),2) || '-' ||
                  substr('89ab', abs(random()) % 4 + 1, 1) ||
                  substr(hex(randomblob(2)),2) || '-' || hex(randomblob(6))),
            substr('cm:' || ? || ':r:' || id, 1, 256),
            'reservation',
            id,
            'upsert',
            'queued',
            ?
          FROM reservations
          WHERE customer_id = ?
            AND EXISTS (SELECT 1 FROM audit_logs WHERE id = ?)
        `
      )
      .bind(auditId, nowIso, input.sourceId, auditId),
    input.db
      .prepare(
        `
          UPDATE reservations
          SET customer_id = ?,
              version = version + 1,
              updated_at = ?
          WHERE customer_id = ?
            AND EXISTS (SELECT 1 FROM audit_logs WHERE id = ?)
        `
      )
      .bind(input.targetId, nowIso, input.sourceId, auditId),
    input.db
      .prepare(
        `
          UPDATE line_identities
          SET customer_id = ?,
              updated_at = ?
          WHERE customer_id = ?
            AND EXISTS (SELECT 1 FROM audit_logs WHERE id = ?)
        `
      )
      .bind(input.targetId, nowIso, input.sourceId, auditId),
    input.db
      .prepare(
        `
          UPDATE customer_visits
          SET customer_id = ?
          WHERE customer_id = ?
            AND EXISTS (SELECT 1 FROM audit_logs WHERE id = ?)
        `
      )
      .bind(input.targetId, input.sourceId, auditId),
    // customer_time_locks has UNIQUE(customer_id, slot_at). When source
    // and target both hold locks at the same slot (legitimate when
    // duplicate customer records each booked the same time before
    // merging), a naive UPDATE customer_id=target collides and aborts
    // the whole batch. Resolution: first DELETE the source locks whose
    // slot already exists on the target side (target's lock for its own
    // reservation is the canonical owner), then UPDATE the remaining
    // source locks to target. Both statements gate on the audit row so
    // a race-lost batch leaves customer_time_locks untouched.
    input.db
      .prepare(
        `
          DELETE FROM customer_time_locks
          WHERE customer_id = ?
            AND slot_at IN (
              SELECT slot_at FROM customer_time_locks WHERE customer_id = ?
            )
            AND EXISTS (SELECT 1 FROM audit_logs WHERE id = ?)
        `
      )
      .bind(input.sourceId, input.targetId, auditId),
    input.db
      .prepare(
        `
          UPDATE customer_time_locks
          SET customer_id = ?
          WHERE customer_id = ?
            AND EXISTS (SELECT 1 FROM audit_logs WHERE id = ?)
        `
      )
      .bind(input.targetId, input.sourceId, auditId),
    // 統合先が空の項目だけ統合元から埋める。統合された側は merged_into_id IS NULL の
    // 条件で一覧・検索から消えるので、ここで拾わないとアレルギー情報が無言で読めなくなる。
    // 監査行は増やさない: この引き継ぎは上の customer.merge の一部として起きている。
    //
    // 対象は「顧客カードのプロフィール欄に出る nullable な項目」。同じ欄に並ぶ birth_date /
    // gender も同じ経路で消えるので一緒に拾う (gender のような固定値でも trim は無害)。
    // display_name / display_name_kana は統合先が自分の氏名を保つ設計なので対象外。
    // email も対象外: 2026-08-31 に管理画面から撤去済みで、列も後続の migration で落とす。
    input.db
      .prepare(
        `
          UPDATE customers
          SET ${["allergy_notes", "memo", "birth_date", "gender", "referrer_name"].map(carryForwardBlankColumn).join(",\n              ")}
          WHERE id = ?2
            AND EXISTS (SELECT 1 FROM audit_logs WHERE id = ?3)
        `
      )
      .bind(input.sourceId, input.targetId, auditId)
  ]);

  const customersChanged = Number(batchResult[0]?.meta?.changes ?? 0);
  if (customersChanged === 0) {
    if (await adminWriteWasRevoked(input.db, input.admin)) {
      return { ok: false, error: "forbidden" };
    }
    // Lost race to a concurrent merge of the same source. The batch's
    // audit INSERT and reservations UPDATE both no-op via the changes()
    // gate, so nothing leaked. Surface the same signal as a stale-input
    // retry.
    return { ok: false, error: "already_merged" };
  }
  // Index [3] is the reservations UPDATE (after [0] customers, [1] audit,
  // [2] calendar_sync_jobs INSERT).
  const reservationsMoved = Number(batchResult[3]?.meta?.changes ?? 0);

  return {
    ok: true,
    sourceId: input.sourceId,
    targetId: input.targetId,
    reservationsMoved
  };
};
