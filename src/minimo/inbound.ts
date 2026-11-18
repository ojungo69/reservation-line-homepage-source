import { generateSlotTimesForRange, SLOT_LOCK_INTERVAL_MINUTES } from "../reservations/slot-times";
import { classifyReservationWriteError } from "../reservations/write-error";
import type { MinimoAccount } from "./config";
import type { MinimoReservation, MinimoSchedule } from "./schedule";
import { fencedBatch, recordSyncConflict, type StoreLease } from "./state";

type ImportedBlock = {
  id: string; resource_id: string; minimo_staff_id: string; start_at: string; end_at: string; status: string;
};
export type InboundResult = { imported: number; updated: number; cancelled: number; conflicts: number };
type ImportContext = {
  db: D1Database; account: MinimoAccount; lease: StoreLease;
  mode: "preview" | "apply"; now: () => number;
};

function releaseBlockLocks(db: D1Database, blockId: string): D1PreparedStatement[] {
  return [
    db.prepare(`INSERT INTO slot_lock_history
      (id, slot_lock_id, store_id, resource_id, old_slot_at, old_owner_id, action, actor_type, actor_id, reason)
      SELECT lower(hex(randomblob(16))), id, store_id, resource_id, slot_at, owner_id,
        'released', 'system', 'minimo_sync', 'minimo_sync'
      FROM slot_locks WHERE owner_type = 'external_block' AND owner_id = ?`).bind(blockId),
    db.prepare("DELETE FROM slot_locks WHERE owner_type = 'external_block' AND owner_id = ?").bind(blockId)
  ];
}

function googleJob(db: D1Database, blockId: string, action: "upsert" | "delete", nowIso: string): D1PreparedStatement {
  const id = crypto.randomUUID();
  return db.prepare(`INSERT INTO calendar_sync_jobs
    (id, dedupe_key, owner_type, owner_id, google_action, status, available_at)
    VALUES (?, ?, 'external_block', ?, ?, 'queued', ?)`).bind(id, `minimo:${blockId}:${id}`, blockId, action, nowIso);
}

function createLocks(db: D1Database, storeId: string, resourceId: string, blockId: string, slots: string[]): D1PreparedStatement[] {
  const statements: D1PreparedStatement[] = [];
  // D1 allows 100 bound parameters per statement; fifteen rows use 75.
  for (let offset = 0; offset < slots.length; offset += 15) {
    const chunk = slots.slice(offset, offset + 15);
    statements.push(db.prepare(`INSERT INTO slot_locks
      (id, store_id, resource_id, slot_at, owner_id, owner_type, lock_status)
      VALUES ${chunk.map(() => "(?, ?, ?, ?, ?, 'external_block', 'confirmed')").join(",")}`)
      .bind(...chunk.flatMap((slot) => [crypto.randomUUID(), storeId, resourceId, slot, blockId])));
  }
  statements.push(db.prepare(`INSERT INTO slot_lock_history
    (id, slot_lock_id, store_id, resource_id, new_slot_at, new_owner_id, action, actor_type, actor_id, reason)
    SELECT lower(hex(randomblob(16))), id, store_id, resource_id, slot_at, owner_id,
      'created', 'system', 'minimo_sync', 'minimo_sync'
    FROM slot_locks WHERE owner_type = 'external_block' AND owner_id = ?`).bind(blockId));
  return statements;
}

async function recordConflict(context: ImportContext, reason: string, id: string): Promise<"conflicts"> {
  if (context.mode === "apply") await recordSyncConflict(context.db, context.lease, reason, id, context.now());
  return "conflicts";
}

async function cancelImport(context: ImportContext, existing: ImportedBlock | null, nowIso: string): Promise<"cancelled" | null> {
  if (existing?.status !== "active") return null;
  const { db, account, lease, mode, now } = context;
  if (mode === "apply") await fencedBatch(db, lease, [
    ...releaseBlockLocks(db, existing.id),
    db.prepare("UPDATE external_blocks SET status = 'cancelled', updated_at = ? WHERE id = ? AND store_id = ? AND source = 'minimo'")
      .bind(nowIso, existing.id, account.storeId),
    googleJob(db, existing.id, "delete", nowIso)
  ], now());
  return "cancelled";
}

async function writeImport(
  context: ImportContext, reservation: MinimoReservation, existing: ImportedBlock | null,
  resourceId: string, slots: string[], nowIso: string
): Promise<keyof InboundResult> {
  const { db, account, lease, now } = context;
  const blockId = existing?.id ?? crypto.randomUUID();
  const write = existing
    ? db.prepare(`UPDATE external_blocks SET start_at = ?, end_at = ?, status = 'active', updated_at = ?
        WHERE id = ? AND store_id = ? AND source = 'minimo'`)
      .bind(reservation.startAt, reservation.endAt, nowIso, blockId, account.storeId)
    : db.prepare(`INSERT INTO external_blocks
        (id, store_id, resource_id, source, title_snapshot, start_at, end_at, status,
         minimo_reservation_id, minimo_staff_id, created_by, updated_at)
        VALUES (?, ?, ?, 'minimo', 'minimo予約', ?, ?, 'active', ?, ?, 'minimo_sync', ?)`)
      .bind(blockId, account.storeId, resourceId, reservation.startAt, reservation.endAt,
        reservation.id, reservation.staffId, nowIso);
  try {
    await fencedBatch(db, lease, [
      ...(existing ? releaseBlockLocks(db, blockId) : []), write,
      ...createLocks(db, account.storeId, resourceId, blockId, slots),
      googleJob(db, blockId, "upsert", nowIso)
    ], now());
  } catch (error) {
    if (classifyReservationWriteError(error) !== "slot_unavailable") throw error;
    return recordConflict(context, "slot_conflict", reservation.id);
  }
  return existing ? "updated" : "imported";
}

async function applyReservation(context: ImportContext, reservation: MinimoReservation): Promise<keyof InboundResult | null> {
  const { db, account, mode, now } = context;
  // Only confirmed and cancelled rows import or release; held and unknown rows never change imports.
  if (reservation.status !== "confirmed" && reservation.status !== "cancelled") return null;
  const mapping = account.staff.find((staff) => staff.rimaUserId === reservation.staffId);
  if (!mapping) return null;
  const existing = await db.prepare(`SELECT id, resource_id, minimo_staff_id, start_at, end_at, status
    FROM external_blocks WHERE store_id = ? AND source = 'minimo' AND minimo_reservation_id = ?`)
    .bind(account.storeId, reservation.id).first<ImportedBlock>();
  if (existing && (existing.resource_id !== mapping.resourceId || existing.minimo_staff_id !== reservation.staffId)) {
    return recordConflict(context, "mapping_changed", reservation.id);
  }
  const nowIso = new Date(now()).toISOString();
  if (reservation.status === "cancelled") return cancelImport(context, existing, nowIso);
  const slots = reservation.startAt && reservation.endAt ? generateSlotTimesForRange(
    new Date(reservation.startAt), new Date(reservation.endAt), SLOT_LOCK_INTERVAL_MINUTES,
    { maxDurationMs: 720 * 60_000 }
  ) : undefined;
  if (!slots?.length) throw new Error("minimo_invalid_reservation");
  if (existing?.status === "active" && existing.start_at === reservation.startAt && existing.end_at === reservation.endAt) return null;
  const conflict = await db.prepare(`SELECT id FROM slot_locks
    WHERE store_id = ? AND resource_id = ? AND slot_at >= ? AND slot_at < ?
      AND NOT (owner_type = 'external_block' AND owner_id = ?) LIMIT 1`)
    .bind(account.storeId, mapping.resourceId, reservation.startAt, reservation.endAt, existing?.id ?? "")
    .first<{ id: string }>();
  if (conflict) return recordConflict(context, "slot_conflict", reservation.id);
  if (mode === "preview") return existing ? "updated" : "imported";
  return writeImport(context, reservation, existing, mapping.resourceId, slots, nowIso);
}

export async function applyInboundDay(
  db: D1Database, account: MinimoAccount, schedule: MinimoSchedule,
  lease: StoreLease, mode: "preview" | "apply", now: () => number
): Promise<InboundResult> {
  const result: InboundResult = { imported: 0, updated: 0, cancelled: 0, conflicts: 0 };
  const context = { db, account, lease, mode, now };
  for (const entry of schedule.entries) {
    for (const reservation of entry.reservations) {
      const action = await applyReservation(context, reservation);
      if (action) result[action] += 1;
    }
  }
  return result;
}
