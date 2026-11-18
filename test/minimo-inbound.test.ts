import { describe, expect, it } from "vitest";
import { createMigratedSqliteD1 } from "./helpers/sqlite-d1";
import { applyInboundDay } from "../src/minimo/inbound";
import { claimStoreLease } from "../src/minimo/state";

const now = Date.parse("2026-09-29T00:00:00Z");
const booking = { id: "shared-id", staffId: "artist", status: "confirmed" as const,
  startAt: "2026-09-29T01:00:00.000Z", endAt: "2026-09-29T02:30:00.000Z" };

describe("Minimo imported bookings", () => {
  it("isolates repeated external IDs across stores and atomically replays, moves and cancels", async () => {
    const db = createMigratedSqliteD1();
    for (const storeId of ["kyoto", "osaka", "nagoya", "wakayama"]) {
      const { id: resourceId } = db.sqlite.prepare("SELECT id FROM store_resources WHERE store_id = ? AND active = 1 LIMIT 1")
        .get(storeId) as { id: string };
      const account = { storeId, salonId: `salon-${storeId}`, password: "synthetic", intervalMinutes: 30,
        staff: [{ rimaUserId: "artist", resourceId, maxDurationMinutes: 90 }] };
      const lease = (await claimStoreLease(db as unknown as D1Database, storeId, [resourceId], now))!;
      const day = { date: "2026-09-29", entries: [{ staffId: "artist", openSlots: [], reservations: [booking] }] };
      const first = await applyInboundDay(db as unknown as D1Database, account, day, lease, "apply", () => now);
      expect(first.imported).toBe(1);
      expect((await applyInboundDay(db as unknown as D1Database, account, day, lease, "apply", () => now)).imported).toBe(0);
      const moved = { ...day, entries: [{ ...day.entries[0], reservations: [{ ...booking,
        startAt: "2026-09-29T03:00:00.000Z", endAt: "2026-09-29T04:30:00.000Z" }] }] };
      expect((await applyInboundDay(db as unknown as D1Database, account, moved, lease, "apply", () => now)).updated).toBe(1);
      const count = db.sqlite.prepare("SELECT COUNT(*) AS n FROM slot_locks WHERE store_id = ? AND slot_at < '2026-09-29T03:00:00.000Z'")
        .get(storeId) as { n: number };
      expect(count.n).toBe(0);
      expect((db.sqlite.prepare("SELECT COUNT(*) AS n FROM slot_locks WHERE store_id = ?").get(storeId) as { n: number }).n).toBe(18);
      const cancelled = { ...day, entries: [{ ...day.entries[0], reservations: [{ ...booking,
        status: "cancelled" as const, startAt: null, endAt: null }] }] };
      expect((await applyInboundDay(db as unknown as D1Database, account, cancelled, lease, "apply", () => now)).cancelled).toBe(1);
    }
    expect((db.sqlite.prepare("SELECT COUNT(*) AS n FROM external_blocks WHERE source = 'minimo' AND status = 'cancelled'").get() as { n: number }).n).toBe(4);
    expect((db.sqlite.prepare("SELECT COUNT(*) AS n FROM slot_locks").get() as { n: number }).n).toBe(0);
    db.sqlite.close();
  });

  it("never imports a negotiating or treated reservation even when its time is readable", async () => {
    const db = createMigratedSqliteD1();
    const { id: resourceId } = db.sqlite.prepare("SELECT id FROM store_resources WHERE store_id = 'osaka' AND active = 1 LIMIT 1")
      .get() as { id: string };
    const account = { storeId: "osaka", salonId: "salon-osaka", password: "synthetic", intervalMinutes: 30,
      staff: [{ rimaUserId: "artist", resourceId, maxDurationMinutes: 90 }] };
    const lease = (await claimStoreLease(db as unknown as D1Database, "osaka", [resourceId], now))!;
    const day = { date: "2026-09-29", entries: [{ staffId: "artist", openSlots: [], reservations: [{ ...booking, status: "held" as const }] }] };
    expect(await applyInboundDay(db as unknown as D1Database, account, day, lease, "apply", () => now))
      .toEqual({ imported: 0, updated: 0, cancelled: 0, conflicts: 0 });
    expect((db.sqlite.prepare("SELECT COUNT(*) AS n FROM external_blocks WHERE source = 'minimo'").get() as { n: number }).n).toBe(0);
    db.sqlite.close();
  });
});
