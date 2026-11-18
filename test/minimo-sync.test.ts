import { describe, expect, it, vi } from "vitest";
import { runMinimoSync } from "../src/minimo/sync";
import { claimStoreLease } from "../src/minimo/state";
import { createMinimoFixture as fixture } from "./helpers/minimo";


function slowDatabase(f: ReturnType<typeof fixture>): D1Database {
  let previousCursor: string | null = null;
  return {
    prepare: f.db.prepare.bind(f.db),
    batch: async (statements: D1PreparedStatement[]) => {
      const result = await f.db.batch(statements);
      const row = f.db.sqlite.prepare("SELECT next_date FROM minimo_sync_state WHERE store_id = 'kyoto'")
        .get() as { next_date: string | null } | undefined;
      if (row?.next_date && row.next_date !== previousCursor) {
        previousCursor = row.next_date;
        f.advance(6000);
      }
      return result;
    }
  } as unknown as D1Database;
}

describe("Minimo four-store synchronization", () => {
  it("imports a change on the ten-minute inbound cadence and confirms missing daily cancellations through detail", async () => {
    const f = fixture("apply");
    const db = f.db as unknown as D1Database;
    await runMinimoSync({ ...f, db });
    f.advance(11 * 60_000);
    f.booking("11:00");
    const changed = await runMinimoSync({ ...f, db });
    expect(changed.stores.every(store => store.updated === 1)).toBe(true);
    f.advance(11 * 60_000);
    f.booking("11:00", 12, false);
    const cancelled = await runMinimoSync({ ...f, db });
    expect(cancelled.stores.every(store => store.cancelled === 1)).toBe(true);
    expect(f.db.sqlite.prepare("SELECT COUNT(*) AS n FROM slot_locks").get()).toEqual({ n: 0 });
    f.db.sqlite.close();
  });

  it.each([403, 429])("stops this run on HTTP %i even if restriction persistence fails", async status => {
    const f = fixture("apply");
    f.db.sqlite.exec(`CREATE TRIGGER reject_minimo_failure BEFORE UPDATE OF consecutive_failures ON minimo_sync_state
      WHEN NEW.consecutive_failures > OLD.consecutive_failures BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END`);
    const apiRequests: string[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      if (String(input).includes("/api/")) {
        apiRequests.push(String(input));
        return new Response(null, { status, headers: { "Retry-After": "3600" } });
      }
      return f.fetchImpl(input, init);
    };
    const result = await runMinimoSync({ ...f, fetchImpl, db: f.db as unknown as D1Database });
    expect(result.stores[0]).toMatchObject({ outcome: "failed", error: status === 403 ? "forbidden" : "rate_limited" });
    expect(apiRequests).toHaveLength(1);
    f.db.sqlite.close();
  });

  it("retains restriction evidence when staff mapping becomes inactive during an HTTP request", async () => {
    const f = fixture("apply");
    f.env.MINIMO_ACCOUNTS_JSON = JSON.stringify([f.accounts[0]]);
    const fetchImpl: typeof fetch = async (input, init) => {
      if (String(input).includes("/api/")) {
        f.db.sqlite.prepare("UPDATE store_resources SET active = 0 WHERE id = ?").run(f.accounts[0].staff[0].resourceId);
        return new Response(null, { status: 403 });
      }
      return f.fetchImpl(input, init);
    };
    await runMinimoSync({ ...f, fetchImpl, db: f.db as unknown as D1Database });
    expect(f.db.sqlite.prepare("SELECT paused_reason FROM minimo_sync_state").get()).toEqual({ paused_reason: "forbidden" });
    f.db.sqlite.exec("UPDATE store_resources SET active = 1");
    f.advance(7 * 60 * 60_000);
    const forbiddenFetch = vi.fn();
    await runMinimoSync({ ...f, fetchImpl: forbiddenFetch, db: f.db as unknown as D1Database });
    expect(forbiddenFetch).not.toHaveBeenCalled();
    f.db.sqlite.close();
  });

  it.each(["forbidden", "challenge", "invalid_response"])("persists %s across runs and mode changes and stops other salons", async (code) => {
    const f = fixture("apply");
    let requests = 0;
    const fetchImpl: typeof fetch = async (input, init) => {
      requests += 1;
      if (String(input).includes("/api/")) {
        if (code === "forbidden") return new Response(null, { status: 403 });
        return new Response(code === "challenge" ? "<html>captcha</html>" : "broken-json");
      }
      return f.fetchImpl(input, init);
    };
    const first = await runMinimoSync({ ...f, fetchImpl, db: f.db as unknown as D1Database });
    expect(first.stores[0]).toMatchObject({ outcome: "failed", error: code });
    expect(requests).toBe(3);
    f.advance(7 * 60 * 60_000);
    const second = await runMinimoSync({ ...f, fetchImpl, db: f.db as unknown as D1Database,
      env: { ...f.env, MINIMO_SYNC_MODE: "preview" } });
    expect(second.stores.every((store) => store.outcome === "attention" && store.error === "provider_paused")).toBe(true);
    expect(requests).toBe(3);
    f.db.sqlite.close();
  });

  it("uses the store interval and increasing backoff as lower bounds for repeated short Retry-After responses", async () => {
    const f = fixture("apply");
    f.throttle("1");
    for (const delayMinutes of [30, 30, 40]) {
      await runMinimoSync({ ...f, db: f.db as unknown as D1Database });
      const row = f.db.sqlite.prepare("SELECT next_attempt_at FROM minimo_sync_state WHERE inbound_error = 'rate_limited' ORDER BY last_inbound_attempt_at DESC LIMIT 1")
        .get() as { next_attempt_at: string };
      expect(Date.parse(row.next_attempt_at) - f.now()).toBe(delayMinutes * 60_000);
      f.advance(delayMinutes * 60_000);
      // Keep the same salon first so failures accumulate for that connection.
      f.env.MINIMO_ACCOUNTS_JSON = JSON.stringify([f.accounts[0]]);
    }
    f.db.sqlite.close();
  });

  it("retains earlier unresolved errors and applied health when a partial sweep resumes", async () => {
    const f = fixture("apply");
    f.env.MINIMO_ACCOUNTS_JSON = JSON.stringify([f.accounts[0]]);
    await runMinimoSync({ ...f, db: f.db as unknown as D1Database });
    const appliedAt = f.db.sqlite.prepare("SELECT last_success_at FROM minimo_sync_state").get();
    f.db.sqlite.exec("UPDATE minimo_schedule_state SET status = 'blocked'; UPDATE store_settings SET booking_window_days = 30");
    f.advance(31 * 60_000);
    const partial = await runMinimoSync({ ...f, db: slowDatabase(f) });
    expect(partial.stores[0]).toMatchObject({ outcome: "partial", error: "minimo_write_review_required" });
    f.advance(5 * 60_000);
    const resumed = await runMinimoSync({ ...f, db: f.db as unknown as D1Database });
    expect(resumed.stores[0]).toMatchObject({ outcome: "attention", error: "minimo_write_review_required" });
    expect(f.db.sqlite.prepare("SELECT last_success_at FROM minimo_sync_state").get()).toEqual(appliedAt);
    expect(f.db.sqlite.prepare("SELECT last_error FROM minimo_sync_state").get())
      .toEqual({ last_error: "minimo_write_review_required" });
    f.db.sqlite.close();
  });

  it("starts apply at today after an interrupted preview without reporting preview as applied success", async () => {
    const f = fixture("preview");
    f.env.MINIMO_ACCOUNTS_JSON = JSON.stringify([f.accounts[0]]);
    f.db.sqlite.exec("UPDATE store_settings SET booking_window_days = 30");
    const db = slowDatabase(f);
    expect((await runMinimoSync({ ...f, db })).stores[0].outcome).toBe("partial");
    f.advance(5 * 60_000);
    const applied = await runMinimoSync({ ...f, db: f.db as unknown as D1Database,
      env: { ...f.env, MINIMO_SYNC_MODE: "apply" } });
    expect(applied.stores[0]).toMatchObject({ outcome: "complete", imported: 1, dates: 31 });
    f.advance(31 * 60_000);
    const appliedAt = f.db.sqlite.prepare("SELECT last_success_at FROM minimo_sync_state").get();
    await runMinimoSync({ ...f, db: f.db as unknown as D1Database });
    expect(f.db.sqlite.prepare("SELECT last_success_at FROM minimo_sync_state").get()).toEqual(appliedAt);
    f.db.sqlite.close();
  });

  it("does nothing when disabled, even with unusable database and credentials", async () => {
    const db = {} as D1Database;
    const fetchImpl = vi.fn();
    expect(await runMinimoSync({ db, env: { MINIMO_ACCOUNTS_JSON: "invalid" }, fetchImpl })).toEqual({ mode: "off", stores: [] });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("previews all four stores without business writes or schedule POSTs", async () => {
    const f = fixture("preview");
    const result = await runMinimoSync({ ...f, db: f.db as unknown as D1Database });
    expect(result.stores).toHaveLength(4);
    for (const store of result.stores) expect(store).toMatchObject({ outcome: "complete", imported: 1, closed: 1 });
    expect(f.requests.filter((request) => request.method === "POST" && request.path.includes("/api/"))).toHaveLength(0);
    for (const table of ["slot_locks", "calendar_sync_jobs", "minimo_schedule_state"]) {
      expect((f.db.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n).toBe(0);
    }
    expect((f.db.sqlite.prepare("SELECT COUNT(*) AS n FROM external_blocks WHERE source = 'minimo'").get() as { n: number }).n).toBe(0);
    f.db.sqlite.close();
  });

  it("imports four isolated salons, reuses sessions and reopens verified owned closures", async () => {
    const f = fixture("apply");
    const first = await runMinimoSync({ ...f, db: f.db as unknown as D1Database });
    for (const store of first.stores) expect(store).toMatchObject({ outcome: "complete", imported: 1, closed: 1 });
    const blocks = f.db.sqlite.prepare("SELECT store_id, title_snapshot FROM external_blocks WHERE source = 'minimo' ORDER BY store_id").all();
    expect(blocks).toHaveLength(4);
    expect(JSON.stringify(blocks)).not.toContain("must-not-be-stored");
    expect(f.requests.filter((request) => request.path === "/salontool/login" && request.method === "POST")).toHaveLength(4);
    const before = f.requests.length;
    await runMinimoSync({ ...f, db: f.db as unknown as D1Database });
    expect(f.requests).toHaveLength(before);
    f.db.sqlite.exec("UPDATE external_blocks SET status = 'cancelled' WHERE source = 'admin_block'");
    f.advance(31 * 60_000);
    const second = await runMinimoSync({ ...f, db: f.db as unknown as D1Database });
    expect(second.stores.every((store) => store.imported === 0 && store.reopened === 1)).toBe(true);
    expect(f.requests.filter((request) => request.path === "/salontool/login" && request.method === "POST")).toHaveLength(4);
    f.db.sqlite.close();
  });

  it("stops other stores after rate limiting and keeps cooldown across runs", async () => {
    const f = fixture("apply");
    f.throttle();
    const first = await runMinimoSync({ ...f, db: f.db as unknown as D1Database });
    expect(first.stores[0].error).toBe("rate_limited");
    expect(f.requests.filter((request) => request.path === "/salontool/login" && request.method === "POST")).toHaveLength(1);
    const count = f.requests.length;
    f.advance(11 * 60_000);
    await runMinimoSync({ ...f, db: f.db as unknown as D1Database });
    expect(f.requests).toHaveLength(count);
    f.db.sqlite.close();
  });

  it("retains uncertain writes and never automatically retries their schedule POST", async () => {
    const f = fixture("apply");
    f.uncertain();
    await runMinimoSync({ ...f, db: f.db as unknown as D1Database });
    const count = f.requests.filter((request) => request.path.includes("/api/") && request.method === "POST").length;
    expect(count).toBeGreaterThan(0);
    expect((f.db.sqlite.prepare("SELECT COUNT(*) AS n FROM minimo_schedule_state WHERE status = 'pending'").get() as { n: number }).n).toBeGreaterThan(0);
    f.advance(61 * 60_000);
    await runMinimoSync({ ...f, db: f.db as unknown as D1Database });
    expect(f.requests.filter((request) => request.path.includes("/api/") && request.method === "POST")).toHaveLength(count);
    f.db.sqlite.close();
  });

  it.each(["missing", "unknown"])("keeps retained Minimo bookings occupied when the remote booking is %s", async (kind) => {
    const f = fixture("apply");
    await runMinimoSync({ ...f, db: f.db as unknown as D1Database });
    f.db.sqlite.exec("UPDATE external_blocks SET status = 'cancelled' WHERE source = 'admin_block'");
    f.booking("13:00");
    f.advance(31 * 60_000);
    const moved = await runMinimoSync({ ...f, db: f.db as unknown as D1Database });
    expect(moved.stores.every((store) => store.updated === 1 && store.reopened === 0)).toBe(true);
    f.booking("13:00", kind === "unknown" ? 999 : 1, kind !== "missing");
    f.advance(31 * 60_000);
    const uncertain = await runMinimoSync({ ...f, db: f.db as unknown as D1Database });
    for (const store of uncertain.stores) expect(store.reopened).toBe(0);
    f.db.sqlite.close();
  });

  it("keeps a challenged 429's Retry-After as a cooldown that resuming the hold cannot shorten", async () => {
    const f = fixture("apply");
    f.throttle("7200", true);
    const first = await runMinimoSync({ ...f, db: f.db as unknown as D1Database });
    expect(first.stores[0]).toMatchObject({ outcome: "failed", error: "challenge" });
    expect(f.db.sqlite.prepare("SELECT paused_reason, rate_limited_until FROM minimo_sync_state WHERE paused_reason IS NOT NULL").all())
      .toEqual([{ paused_reason: "challenge", rate_limited_until: new Date(f.now() + 7_200_000).toISOString() }]);
    // Same column the operator's resume clears in src/admin/minimo-sync.ts; the cooldown must survive it.
    f.db.sqlite.prepare("UPDATE minimo_sync_state SET paused_reason = NULL").run();
    const count = f.requests.length;
    f.advance(60 * 60_000);
    const second = await runMinimoSync({ ...f, db: f.db as unknown as D1Database });
    expect(second.stores.every((store) => store.error === "rate_limited")).toBe(true);
    expect(f.requests).toHaveLength(count);
    f.db.sqlite.close();
  });

  it("records a challenged 429 hold even when Retry-After names the last instant a Date can hold", async () => {
    const f = fixture("apply");
    f.throttle("Sat, 13 Sep 275760 00:00:00 GMT", true);
    // Every clock read moves 1 ms, so the failure is saved after the Retry-After was read.
    const ticking = { ...f, now: () => { f.advance(1); return f.now(); } };
    const first = await runMinimoSync({ ...ticking, db: f.db as unknown as D1Database });
    expect(first.stores[0]).toMatchObject({ outcome: "failed", error: "challenge" });
    const count = f.requests.length;
    const second = await runMinimoSync({ ...ticking, db: f.db as unknown as D1Database });
    expect(second.stores.every((store) => store.outcome === "attention" && store.error === "provider_paused")).toBe(true);
    expect(f.requests).toHaveLength(count);
    f.db.sqlite.close();
  });

  it("honors a long Retry-After even when its ISO timestamp uses an extended year", async () => {
    const f = fixture("apply");
    f.throttle("999999999999");
    await runMinimoSync({ ...f, db: f.db as unknown as D1Database });
    const count = f.requests.length;
    f.advance(60_000);
    await runMinimoSync({ ...f, db: f.db as unknown as D1Database });
    expect(f.requests).toHaveLength(count);
    f.db.sqlite.close();
  });

  it("serializes concurrent complete sweeps so an account cannot bypass another run's restriction", async () => {
    const f = fixture("apply");
    let signalStarted!: () => void;
    let resume!: () => void;
    const started = new Promise<void>((resolve) => { signalStarted = resolve; });
    const paused = new Promise<void>((resolve) => { resume = resolve; });
    let pause = true;
    const fetchImpl: typeof fetch = async (input, init) => {
      if (pause && String(input).includes("/api/") && init?.method === "GET") {
        pause = false;
        signalStarted();
        await paused;
      }
      return f.fetchImpl(input, init);
    };
    const first = runMinimoSync({ ...f, db: f.db as unknown as D1Database, fetchImpl });
    await started;
    try {
      const count = f.requests.length;
      await runMinimoSync({ ...f, db: f.db as unknown as D1Database, fetchImpl });
      expect(f.requests).toHaveLength(count);
    } finally {
      resume();
      await first;
      f.db.sqlite.close();
    }
  });

  it("allows a larger menu duration without changing salon or staff identity", async () => {
    const f = fixture("apply");
    await runMinimoSync({ ...f, db: f.db as unknown as D1Database });
    f.advance(31 * 60_000);
    const env = { ...f.env, MINIMO_ACCOUNTS_JSON: JSON.stringify(f.accounts.map((account) => ({ ...account,
      staff: account.staff.map((staff) => ({ ...staff, maxDurationMinutes: 120 })) }))) };
    const result = await runMinimoSync({ ...f, env, db: f.db as unknown as D1Database });
    for (const store of result.stores) expect(store.outcome).toBe("complete");
    f.db.sqlite.close();
  });

  it("imports long bookings but stops availability writes when the configured menu maximum is too short", async () => {
    const f = fixture("apply");
    const env = { ...f.env, MINIMO_ACCOUNTS_JSON: JSON.stringify(f.accounts.map((account) => ({ ...account,
      staff: account.staff.map((staff) => ({ ...staff, maxDurationMinutes: 60 })) }))) };
    const result = await runMinimoSync({ ...f, env, db: f.db as unknown as D1Database });
    for (const store of result.stores) expect(store).toMatchObject({ outcome: "attention", imported: 1,
      error: "minimo_duration_exceeds_mapping" });
    expect(f.requests.filter((request) => request.path.includes("/api/") && request.method === "POST")).toHaveLength(0);
    f.db.sqlite.close();
  });

  it.each([3, 10])("keeps syncing when a day reservation with status %i has a readable time, without importing it", async (status) => {
    const f = fixture("apply");
    f.booking("13:00", status);
    const result = await runMinimoSync({ ...f, db: f.db as unknown as D1Database });
    // closed: 1 is the same day's closure the default fixture makes, so the write phase ran on the held day.
    for (const store of result.stores) expect(store).toMatchObject({ outcome: "complete", imported: 0, closed: 1 });
    expect((f.db.sqlite.prepare("SELECT COUNT(*) AS n FROM external_blocks WHERE source = 'minimo'").get() as { n: number }).n).toBe(0);
    f.db.sqlite.close();
  });

  it("stops availability writes when a day reservation has a status it does not know", async () => {
    const f = fixture("apply");
    f.booking("13:00", 99);
    const result = await runMinimoSync({ ...f, db: f.db as unknown as D1Database });
    for (const store of result.stores) expect(store).toMatchObject({ outcome: "attention",
      error: "minimo_unknown_reservation_status" });
    expect(f.requests.filter((request) => request.path.includes("/api/") && request.method === "POST")).toHaveLength(0);
    f.db.sqlite.close();
  });

  it("does not dispatch a stale POST after a delayed pending-write database response", async () => {
    const f = fixture("apply");
    let delayed = false;
    const db = {
      prepare: f.db.prepare.bind(f.db),
      batch: async (statements: D1PreparedStatement[]) => {
        const result = await f.db.batch(statements);
        const pending = f.db.sqlite.prepare("SELECT 1 AS found FROM minimo_schedule_state WHERE store_id = 'kyoto' AND status = 'pending'").get();
        if (pending && !delayed) {
          delayed = true;
          f.advance(91_000);
          await claimStoreLease(f.db as unknown as D1Database, "kyoto", [f.accounts[0].staff[0].resourceId], f.now());
        }
        return result;
      }
    } as unknown as D1Database;
    const result = await runMinimoSync({ ...f, db });
    expect(result.stores[0].error).toBe("minimo_lease_lost");
    expect(f.requests.filter((request) => request.salon === "salon-kyoto" && request.path.includes("/api/") && request.method === "POST")).toHaveLength(0);
    expect(f.db.sqlite.prepare("SELECT status FROM minimo_schedule_state WHERE store_id = 'kyoto'").get()).toEqual({ status: "pending" });
    f.db.sqlite.close();
  });
});
