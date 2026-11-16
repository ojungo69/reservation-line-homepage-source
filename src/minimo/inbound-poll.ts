import { MinimoClient } from "./client";
import type { MinimoAccount } from "./config";
import { applyInboundDay, type InboundResult } from "./inbound";
import type { MinimoReservationIndex } from "./reservations";
import type { MinimoReservation, MinimoSchedule } from "./schedule";
import { fencedBatch, type StoreLease } from "./state";

type PollContext = {
  db: D1Database; account: MinimoAccount; client: MinimoClient; lease: StoreLease;
  mode: "preview" | "apply"; now: () => number; deadline: number;
  cursor: string | null; sweepError: string | null;
};

/** Absence is usable only after a complete, stable, bounded catalogue read. */
async function readCatalogue(context: PollContext): Promise<Map<string, MinimoReservationIndex>> {
  const first = await context.client.getReservationPage(1, context.deadline);
  const indexed = new Map(first.reservations.map(row => [row.id, row]));
  for (let page = 2; page <= first.maxPage; page += 1) {
    const next = await context.client.getReservationPage(page, context.deadline);
    if (next.maxPage !== first.maxPage || next.total !== first.total) throw new Error("minimo_catalogue_changed");
    for (const row of next.reservations) {
      if (indexed.has(row.id)) throw new Error("minimo_catalogue_changed");
      indexed.set(row.id, row);
    }
  }
  if (indexed.size !== first.total) throw new Error("minimo_catalogue_changed");
  // The active filter is advisory; only retained-ID detail can authorize cancellation.
  for (const [id, row] of indexed) if (row.status === "cancelled") indexed.delete(id);
  return indexed;
}

type Retained = { id: string; staffId: string; status: string };
type PollResult = InboundResult & { error?: string; partial: boolean };

async function reservationSnapshot(context: PollContext, row: MinimoReservationIndex,
  days: Map<string, MinimoSchedule>): Promise<MinimoReservation | null> {
  if (row.status === "cancelled") return { ...row, startAt: null, endAt: null };
  if (row.status !== "confirmed" || !row.date) return null;
  let day = days.get(row.date);
  if (!day) {
    day = await context.client.getSchedule(row.date, context.deadline);
    days.set(row.date, day);
  }
  const observed = day.entries.flatMap(entry => entry.reservations).find(item => item.id === row.id);
  if (observed?.status !== "confirmed" || observed.staffId !== row.staffId || observed.startAt !== row.startAt) {
    return null;
  }
  return observed;
}

async function applyIndexed(context: PollContext, row: MinimoReservationIndex | undefined,
  retained: Retained | undefined, days: Map<string, MinimoSchedule>): Promise<InboundResult & { error?: string }> {
  const result: InboundResult & { error?: string } = { imported: 0, updated: 0, cancelled: 0, conflicts: 0 };
  if (!retained && row) {
    retained = await context.db.prepare(`SELECT minimo_reservation_id AS id, minimo_staff_id AS staffId, status
      FROM external_blocks WHERE store_id = ? AND source = 'minimo' AND minimo_reservation_id = ? AND status = 'cancelled'`)
      .bind(context.account.storeId, row.id).first<Retained>() ?? undefined;
  }
  // A cancelled tombstone also needs current detail before any reactivation.
  if (retained && (row?.status !== "confirmed" || retained.status === "cancelled")) {
    row = await context.client.getReservation(retained.id, context.deadline) ?? undefined;
  }
  if (!row || (retained && row.staffId !== retained.staffId) || row.status === "ignored") {
    return { ...result, error: "minimo_reservation_unresolved" };
  }
  const observed = await reservationSnapshot(context, row, days);
  if (!observed) return { ...result, error: "minimo_catalogue_changed" };
  if (observed.endAt && Date.parse(observed.endAt) <= context.now()) return result;
  const schedule: MinimoSchedule = { date: row.date ?? new Date(context.now() + 9 * 3_600_000).toISOString().slice(0, 10),
    entries: [{ staffId: row.staffId, openSlots: [], reservations: [observed] }] };
  Object.assign(result, await applyInboundDay(context.db, context.account, schedule, context.lease, context.mode, context.now));
  if (result.conflicts) result.error = "minimo_inbound_conflict";
  return result;
}

async function saveCursor(context: PollContext, cursor: string | null, error: string | undefined): Promise<void> {
  await fencedBatch(context.db, context.lease, [context.db.prepare(`UPDATE minimo_sync_state
    SET next_inbound_id = ?, inbound_sweep_error = ? WHERE store_id = ?`)
    .bind(cursor, error ?? null, context.account.storeId)], context.now());
}

export async function pollMinimoInbound(context: PollContext): Promise<PollResult> {
  const { account, client, db, now, deadline } = context;
  const staffIds = await client.getStaffIds(deadline);
  if (account.staff.some(staff => !staffIds.includes(staff.rimaUserId))) throw new Error("minimo_staff_missing");
  const indexed = await readCatalogue(context);
  const retainedRows = await db.prepare(`SELECT minimo_reservation_id AS id, minimo_staff_id AS staffId, status
    FROM external_blocks WHERE store_id = ? AND source = 'minimo' AND end_at > ?`)
    .bind(account.storeId, new Date(now()).toISOString()).all<Retained>();
  const retained = new Map(retainedRows.results.map(row => [row.id, row]));
  const mapped = new Set(account.staff.map(staff => staff.rimaUserId));
  const ids = [...new Set([...indexed.values()].filter(row => mapped.has(row.staffId)).map(row => row.id)
    .concat(retainedRows.results.filter(row => row.status === "active").map(row => row.id)))].sort((a, b) => a.localeCompare(b));
  const result: PollResult = { imported: 0, updated: 0, cancelled: 0, conflicts: 0, partial: false,
    error: context.cursor ? context.sweepError ?? undefined : undefined };
  const days = new Map<string, MinimoSchedule>();
  for (const [index, id] of ids.entries()) {
    // Resume with the same comparison used to order opaque reservation IDs.
    if (context.cursor && id.localeCompare(context.cursor) < 0) continue;
    if (now() + 5000 >= deadline) {
      await saveCursor(context, id, result.error);
      return { ...result, partial: true };
    }
    await saveCursor(context, id, result.error);
    const applied = await applyIndexed(context, indexed.get(id), retained.get(id), days);
    for (const key of ["imported", "updated", "cancelled", "conflicts"] as const) result[key] += applied[key];
    result.error = applied.error ?? result.error;
    await saveCursor(context, ids[index + 1] ?? null, result.error);
  }
  return result;
}
