import { describe, expect, it } from "vitest";
import { runMinimoSync } from "../src/minimo/sync";
import { claimStoreLease } from "../src/minimo/state";
import { createMinimoFixture } from "./helpers/minimo";

function fixture() {
  const f = createMinimoFixture("apply");
  f.env.MINIMO_ACCOUNTS_JSON = JSON.stringify([f.accounts[0]]);
  return { ...f, db: f.db as unknown as D1Database, sqlite: f.db.sqlite };
}

const index = (id: string, date = "2026-09-29", status = 1) => ({ reservation_id: id,
  staff_id: "artist-kyoto", status, visit_datetime: `${date} 10:00:00` });
const page = (current: number, reservations: unknown[], total = 2) => Response.json({ reservations,
  _page: { current_page: current, entities: total, entities_by_page: 1, max_page: 2 } });

describe("Minimo catalogue reconciliation", () => {
  it("discovers every page and imports a future appointment beyond the outbound window", async () => {
    const f = fixture();
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/reservations")) return url.searchParams.get("page") === "1"
        ? page(1, [index("shared-booking")]) : page(2, [index("future", "2026-12-30")]);
      if (url.pathname.endsWith("/schedule") && url.searchParams.get("date") === "2026-12-30") {
        return Response.json({ entries: [{ staff: { rima_user_id: "artist-kyoto" }, schedule: [],
          reservation: [{ ...index("future", "2026-12-30"), new_menu_entity: { time_required: 60 } }] }] });
      }
      return f.fetchImpl(input, init);
    };
    const result = await runMinimoSync({ ...f, fetchImpl });
    expect(result.stores[0]).toMatchObject({ outcome: "complete", imported: 2 });
    expect(f.sqlite.prepare("SELECT COUNT(*) AS n FROM slot_locks WHERE slot_at >= '2026-12-30'").get()).toEqual({ n: 12 });
    f.sqlite.close();
  });

  it.each(["duplicate", "count_change", "truncated"])("keeps existing locks when pagination is %s", async kind => {
    const f = fixture();
    await runMinimoSync(f);
    const before = f.sqlite.prepare("SELECT * FROM slot_locks ORDER BY id").all();
    f.advance(11 * 60_000);
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/reservations")) {
        if (url.searchParams.get("page") === "1") return page(1, [index("other")]);
        if (kind === "duplicate") return page(2, [index("other")]);
        return page(2, [], kind === "count_change" ? 1 : 2);
      }
      return f.fetchImpl(input, init);
    };
    expect((await runMinimoSync({ ...f, fetchImpl })).stores[0]).toMatchObject({ error: "minimo_catalogue_changed" });
    expect(f.sqlite.prepare("SELECT * FROM slot_locks ORDER BY id").all()).toEqual(before);
    f.sqlite.close();
  });

  it.each([11, 12])("does not resurrect detail cancellation %i from a stale daily schedule", async status => {
    const f = fixture();
    await runMinimoSync(f);
    f.advance(31 * 60_000);
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/reservations")) return Response.json({ reservations: [],
        _page: { current_page: 1, entities: 0, entities_by_page: 100, max_page: 0 } });
      if (url.pathname.endsWith("/reservations/shared-booking")) return Response.json({ reservation: {
        reservation_id: "shared-booking", staff_id: "artist-kyoto", status } });
      return f.fetchImpl(input, init);
    };
    expect((await runMinimoSync({ ...f, fetchImpl })).stores[0]).toMatchObject({ cancelled: 1 });
    expect(f.sqlite.prepare("SELECT status FROM external_blocks WHERE source='minimo'").get()).toEqual({ status: "cancelled" });
    expect(f.sqlite.prepare("SELECT COUNT(*) AS n FROM slot_locks").get()).toEqual({ n: 0 });
    f.sqlite.close();
  });

  it("requires detail cancellation even if the active-list filter returns a cancelled row", async () => {
    const f = fixture();
    await runMinimoSync(f);
    const before = f.sqlite.prepare("SELECT * FROM slot_locks ORDER BY id").all();
    f.advance(11 * 60_000);
    const fetchImpl: typeof fetch = async (input, init) => {
      if (new URL(String(input)).pathname.endsWith("/reservations")) return Response.json({
        reservations: [index("shared-booking", "2026-09-29", 12)],
        _page: { current_page: 1, entities: 1, entities_by_page: 100, max_page: 1 } });
      return f.fetchImpl(input, init);
    };
    expect((await runMinimoSync({ ...f, fetchImpl })).stores[0].cancelled).toBe(0);
    expect(f.sqlite.prepare("SELECT * FROM slot_locks ORDER BY id").all()).toEqual(before);
    f.sqlite.close();
  });

  it("checks detail before a stale future view can reactivate an expired cancellation tombstone", async () => {
    const f = fixture();
    await runMinimoSync(f);
    f.advance(11 * 60_000);
    f.booking("10:00", 12, false);
    await runMinimoSync(f);
    f.advance(2 * 86_400_000);
    let details = 0;
    const future = index("shared-booking", "2026-10-02");
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/reservations")) return Response.json({ reservations: [future],
        _page: { current_page: 1, entities: 1, entities_by_page: 100, max_page: 1 } });
      if (url.pathname.endsWith("/reservations/shared-booking")) details += 1;
      if (url.pathname.endsWith("/schedule") && url.searchParams.get("date") === "2026-10-02") {
        return Response.json({ entries: [{ staff: { rima_user_id: "artist-kyoto" }, schedule: [],
          reservation: [{ ...future, new_menu_entity: { time_required: 60 } }] }] });
      }
      return f.fetchImpl(input, init);
    };
    await runMinimoSync({ ...f, fetchImpl });
    expect(details).toBe(1);
    expect(f.sqlite.prepare("SELECT status FROM external_blocks WHERE source='minimo'").get()).toEqual({ status: "cancelled" });
    expect(f.sqlite.prepare("SELECT count(*) AS n FROM slot_locks").get()).toEqual({ n: 0 });
    f.sqlite.close();
  });

  it.each([404, 999])("retains locks and reports attention for unresolved detail %i", async status => {
    const f = fixture();
    await runMinimoSync(f);
    const before = f.sqlite.prepare("SELECT * FROM slot_locks ORDER BY id").all();
    f.advance(11 * 60_000);
    f.booking("10:00", status, false);
    expect((await runMinimoSync(f)).stores[0]).toMatchObject({ outcome: "attention", error: "minimo_reservation_unresolved" });
    expect(f.sqlite.prepare("SELECT * FROM slot_locks ORDER BY id").all()).toEqual(before);
    f.sqlite.close();
  });

  it("holds moved appointments when catalogue and daily snapshots disagree", async () => {
    const f = fixture();
    await runMinimoSync(f);
    const before = f.sqlite.prepare("SELECT * FROM slot_locks ORDER BY id").all();
    f.advance(11 * 60_000);
    const fetchImpl: typeof fetch = async (input, init) => {
      if (new URL(String(input)).pathname.endsWith("/reservations")) return Response.json({
        reservations: [{ ...index("shared-booking"), visit_datetime: "2026-09-29 11:00:00" }],
        _page: { current_page: 1, entities: 1, entities_by_page: 100, max_page: 1 } });
      return f.fetchImpl(input, init);
    };
    expect((await runMinimoSync({ ...f, fetchImpl })).stores[0].error).toBe("minimo_catalogue_changed");
    expect(f.sqlite.prepare("SELECT * FROM slot_locks ORDER BY id").all()).toEqual(before);
    f.sqlite.close();
  });

  it("resumes a bounded inbound sweep instead of losing every appointment beyond its deadline", async () => {
    const f = fixture();
    const rows = Array.from({ length: 40 }, (_, n) => index(`${n % 2 === 0 ? "a" : "B"}-${String(n).padStart(2, "0")}`,
      new Date(Date.parse("2026-10-01T00:00:00Z") + n * 86_400_000).toISOString().slice(0, 10)));
    const fetchImpl: typeof fetch = async (input, init) => {
      f.advance(1000);
      const url = new URL(String(input));
      if (url.pathname.endsWith("/reservations")) return Response.json({ reservations: rows,
        _page: { current_page: 1, entities: rows.length, entities_by_page: 100, max_page: 1 } });
      if (url.pathname.endsWith("/schedule") && init?.method === "GET") {
        const row = rows.find(row => row.visit_datetime.startsWith(url.searchParams.get("date")!));
        return Response.json({ entries: [{ staff: { rima_user_id: "artist-kyoto" }, schedule: [],
          reservation: row ? [{ ...row, new_menu_entity: { time_required: 60 } }] : [] }] });
      }
      return f.fetchImpl(input, init);
    };
    const first = (await runMinimoSync({ ...f, fetchImpl })).stores[0];
    expect(first).toMatchObject({ outcome: "partial" });
    expect(first.imported).toBeGreaterThan(0);
    expect(first.imported).toBeLessThan(40);
    expect(f.sqlite.prepare("SELECT next_inbound_id,last_inbound_success_at FROM minimo_sync_state").get())
      .toMatchObject({ next_inbound_id: expect.any(String), last_inbound_success_at: null });
    f.advance(10 * 60_000);
    const second = (await runMinimoSync({ ...f, fetchImpl })).stores[0];
    expect(second.error).toBeUndefined();
    expect(first.imported + second.imported).toBe(40);
    expect(f.sqlite.prepare("SELECT next_inbound_id,last_inbound_success_at FROM minimo_sync_state").get())
      .toMatchObject({ next_inbound_id: null, last_inbound_success_at: expect.any(String) });
    expect(f.sqlite.prepare("SELECT COUNT(*) AS n FROM external_blocks WHERE source='minimo'").get()).toEqual({ n: 40 });
    f.sqlite.close();
  });

  it("ignores ended appointments but imports one still running across midnight", async () => {
    const f = fixture();
    const rows = [index("ended", "2026-09-28"),
      { ...index("ongoing", "2026-09-28"), visit_datetime: "2026-09-28 23:00:00" }];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/reservations")) return Response.json({ reservations: rows,
        _page: { current_page: 1, entities: 2, entities_by_page: 100, max_page: 1 } });
      if (url.pathname.endsWith("/schedule") && url.searchParams.get("date") === "2026-09-28") {
        return Response.json({ entries: [{ staff: { rima_user_id: "artist-kyoto" }, schedule: [],
          reservation: rows.map(row => ({ ...row, new_menu_entity: { time_required: row.reservation_id === "ended" ? 60 : 720 } })) }] });
      }
      return f.fetchImpl(input, init);
    };
    expect((await runMinimoSync({ ...f, fetchImpl })).stores[0].imported).toBe(1);
    expect(f.sqlite.prepare("SELECT minimo_reservation_id FROM external_blocks WHERE source='minimo'").all())
      .toEqual([{ minimo_reservation_id: "ongoing" }]);
    f.sqlite.close();
  });

  it("does not run apply outbound when a mode switch could not complete apply inbound", async () => {
    const f = fixture();
    await runMinimoSync({ ...f, env: { ...f.env, MINIMO_SYNC_MODE: "preview" } });
    f.advance(11 * 60_000);
    await claimStoreLease(f.db, "kyoto", [f.accounts[0].staff[0].resourceId], f.now());
    let released = false;
    const db = { batch: f.db.batch.bind(f.db), prepare: (sql: string) => {
      if (!released && sql.includes("INSERT INTO job_leases") && sql.includes("ON CONFLICT")) {
        const statement = f.db.prepare(sql);
        const bind = statement.bind.bind(statement);
        statement.bind = (...args: unknown[]) => {
          const bound = bind(...args);
          if (args[1] === "minimo:kyoto") {
            const run = bound.run.bind(bound);
            bound.run = async <T>() => {
              const result = await run<T>();
              f.sqlite.exec("UPDATE job_leases SET locked_until='1970-01-01' WHERE lease_key='minimo:kyoto'");
              released = true;
              return result;
            };
          }
          return bound;
        };
        return statement;
      }
      return f.db.prepare(sql);
    } } as D1Database;
    const requestsBefore = f.requests.length;
    await runMinimoSync({ ...f, db });
    expect(released).toBe(true);
    expect(f.requests).toHaveLength(requestsBefore);
    expect(f.sqlite.prepare("SELECT last_inbound_success_at,last_success_at FROM minimo_sync_state").get())
      .toEqual({ last_inbound_success_at: null, last_success_at: null });
    f.sqlite.close();
  });

  it("keeps outbound errors and pending writes when a later inbound poll succeeds", async () => {
    const f = fixture();
    await runMinimoSync(f);
    f.sqlite.exec("UPDATE minimo_sync_state SET last_error = 'minimo_write_review_required', sweep_error = 'minimo_write_review_required'; UPDATE minimo_schedule_state SET status = 'pending'");
    const outbound = f.sqlite.prepare("SELECT last_success_at,last_error,sweep_error,next_outbound_at FROM minimo_sync_state").get();
    f.advance(11 * 60_000);
    f.booking("11:00");
    expect((await runMinimoSync(f)).stores[0]).toMatchObject({ updated: 1, outcome: "attention", error: "minimo_write_review_required" });
    expect(f.sqlite.prepare("SELECT last_success_at,last_error,sweep_error,next_outbound_at FROM minimo_sync_state").get()).toEqual(outbound);
    expect(f.sqlite.prepare("SELECT status FROM minimo_schedule_state").get()).toEqual({ status: "pending" });
    expect(f.sqlite.prepare("SELECT inbound_error FROM minimo_sync_state").get()).toEqual({ inbound_error: null });
    f.sqlite.close();
  });
});
