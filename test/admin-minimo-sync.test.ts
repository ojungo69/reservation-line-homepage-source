import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app";
import type { AdminUser } from "../src/admin/access";
import { getAdminMinimoStatus, recoverAdminMinimoSync } from "../src/admin/minimo-sync";
import { runMinimoSync } from "../src/minimo/sync";
import { claimStoreLease } from "../src/minimo/state";
import { createMinimoFixture } from "./helpers/minimo";
import { createAccessJwksFetchMock, createAccessJwtFixture, insertAdminUser } from "./helpers/admin-access";

const admin: AdminUser = { id: "minimo-operator", email: "operator@example.test", role: "system_admin",
  staff_member_id: null, store_id: null };

async function fixture() {
  const f = createMinimoFixture("apply");
  f.env.MINIMO_ACCOUNTS_JSON = JSON.stringify([f.accounts[0]]);
  insertAdminUser(f.db, { id: admin.id, email: admin.email, accessSubject: "minimo-operator", role: admin.role });
  const input = { ...f, db: f.db as unknown as D1Database, admin };
  await runMinimoSync(input);
  return { f, input };
}

async function status(input: Parameters<typeof getAdminMinimoStatus>[0]) {
  const result = await getAdminMinimoStatus(input);
  if (!result.ok) throw new Error(result.reason);
  return result;
}

describe("Minimo operator recovery", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it("exposes status and confirmed recovery through the authenticated admin API", async () => {
    const { f } = await fixture();
    vi.spyOn(Date, "now").mockImplementation(f.now);
    const issuer = "https://minimo-test.cloudflareaccess.com";
    const auth = createAccessJwtFixture({ issuer, audience: "minimo-admin", keyId: "minimo-admin-key",
      claims: { email: admin.email, sub: "minimo-operator" } });
    vi.stubGlobal("fetch", createAccessJwksFetchMock(issuer, auth.jwk));
    f.db.sqlite.exec("UPDATE minimo_sync_state SET paused_reason = 'forbidden'");
    const app = createApp();
    const env = { ...f.env, DB: f.db, ACCESS_TEAM_DOMAIN: issuer, ACCESS_AUD: "minimo-admin" };
    const headers = { "Cf-Access-Jwt-Assertion": auth.token, "Content-Type": "application/json" };
    const response = await app.request("/api/admin/sync/minimo", { headers }, env);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    const body = await response.json() as { stores: { token: string }[] };
    const request = { action: "resume", storeId: "kyoto", expectedToken: body.stores[0].token, confirm: true };
    const recovered = await app.request("/api/admin/sync/minimo/recover", { method: "POST", headers, body: JSON.stringify(request) }, env);
    expect(recovered.status).toBe(200);
    for (const role of ["staff", "owner"]) {
      f.db.sqlite.prepare("UPDATE admin_users SET role = ? WHERE id = ?").run(role, admin.id);
      expect((await app.request("/api/admin/sync/minimo", { headers }, env)).status).toBe(403);
      expect((await app.request("/api/admin/sync/minimo/recover", { method: "POST", headers, body: JSON.stringify(request) }, env)).status).toBe(403);
    }
    f.db.sqlite.close();
  });

  it("reconciles an uncertain write only after cooldown and a matching read-back, without posting availability", async () => {
    const { f, input } = await fixture();
    f.db.sqlite.exec("UPDATE minimo_schedule_state SET status = 'pending'");
    const day = (await status(input)).stores[0].days[0];
    const request = { action: "reconcile", storeId: "kyoto", date: day.date, expectedToken: day.token, confirm: true };
    const count = f.requests.length;
    expect(await recoverAdminMinimoSync({ ...input, request })).toMatchObject({ ok: false, reason: "minimo_cooldown" });
    expect(f.requests).toHaveLength(count);
    f.advance(31 * 60_000);
    expect(await recoverAdminMinimoSync({ ...input, request })).toMatchObject({ ok: true });
    expect(f.requests.slice(count)).toEqual([
      { salon: "salon-kyoto", path: "/api/v1/salontool/accounts", method: "GET" },
      { salon: "salon-kyoto", path: "/api/v1/salontool/schedule", method: "GET" }
    ]);
    expect((await status(input)).stores[0].days).toEqual([]);
    expect(f.db.sqlite.prepare("SELECT COUNT(*) AS n FROM external_blocks WHERE source = 'minimo'").get()).toEqual({ n: 1 });
    f.db.sqlite.close();
  });

  it("requires explicit ownership relinquishment for divergence and retains every remote closure", async () => {
    const { f, input } = await fixture();
    f.db.sqlite.exec("UPDATE minimo_schedule_state SET status = 'blocked'");
    const day = (await status(input)).stores[0].days[0];
    f.remote.set(`salon-kyoto:${day.date}`, []);
    f.db.sqlite.exec("UPDATE minimo_sync_state SET session_expires_at = '2000-01-01'");
    f.advance(31 * 60_000);
    const request = { action: "reconcile", storeId: "kyoto", date: day.date, expectedToken: day.token, confirm: true };
    expect(await recoverAdminMinimoSync({ ...input, request })).toMatchObject({ ok: false, reason: "minimo_remote_changed" });
    expect(await recoverAdminMinimoSync({ ...input, request: { ...request, discardOwnership: true } }))
      .toMatchObject({ ok: false, reason: "minimo_cooldown" });
    f.advance(31 * 60_000);
    expect(await recoverAdminMinimoSync({ ...input, request: { ...request, discardOwnership: true } })).toMatchObject({ ok: true });
    expect(f.db.sqlite.prepare("SELECT owned_json FROM minimo_schedule_state WHERE date = ?").get(day.date)).toEqual({ owned_json: "{}" });
    f.db.sqlite.exec("UPDATE external_blocks SET status = 'cancelled' WHERE source = 'admin_block'");
    const count = f.requests.length;
    f.advance(31 * 60_000);
    await runMinimoSync(input);
    expect(f.requests.slice(count).every((request) => request.method === "GET")).toBe(true);
    expect(f.remote.get(`salon-kyoto:${day.date}`)).toEqual([]);
    expect(f.requests.filter((request) => request.path === "/salontool/login" && request.method === "POST")).toHaveLength(2);
    f.db.sqlite.close();
  });

  it("shows safe state and explicitly resumes a provider hold without HTTP or shortening cooldown", async () => {
    const { f, input } = await fixture();
    f.db.sqlite.exec(`UPDATE minimo_sync_state SET paused_reason = 'forbidden', last_error = 'forbidden',
      rate_limited_until = '2030-01-01T00:00:00.000Z'`);
    const before = await status(input);
    expect(JSON.stringify(before)).not.toMatch(/synthetic-|password|session_ciphertext|salon-kyoto/);
    expect(before.stores[0]).toMatchObject({ storeId: "kyoto", pausedReason: "forbidden" });
    const fetchImpl = vi.fn();
    const request = { action: "resume", storeId: "kyoto", expectedToken: before.stores[0].token, confirm: true };
    expect(await recoverAdminMinimoSync({ ...input, fetchImpl, request })).toMatchObject({ ok: true });
    expect(fetchImpl).not.toHaveBeenCalled();
    const after = await status(input);
    expect(after.stores[0]).toMatchObject({ pausedReason: null, nextAttemptAt: before.stores[0].nextAttemptAt,
      rateLimitedUntil: "2030-01-01T00:00:00.000Z" });
    expect(await recoverAdminMinimoSync({ ...input, fetchImpl, request })).toMatchObject({ ok: false });
    expect(f.db.sqlite.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'minimo_sync_resume'").get()).toEqual({ n: 1 });
    f.db.sqlite.close();
  });

  it.each(["staff", "owner"] as const)("rejects %s at the service boundary before reading state or making requests", async (role) => {
    const db = {} as D1Database;
    const env = { MINIMO_SYNC_MODE: "off" };
    const fetchImpl = vi.fn();
    expect(await getAdminMinimoStatus({ db, env, admin: { ...admin, role } })).toEqual({ ok: false, reason: "forbidden" });
    expect(await recoverAdminMinimoSync({ db, env, admin: { ...admin, role }, request: {}, fetchImpl }))
      .toEqual({ ok: false, reason: "forbidden" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([{}, { action: "resume", storeId: "kyoto", expectedToken: "a".repeat(64), confirm: false },
    { action: "reconcile", storeId: "other", expectedToken: "a".repeat(64), confirm: true, date: "2026-09-29" },
    { action: "resume", storeId: "kyoto", expectedToken: "a".repeat(64), confirm: true, extra: true }])
  ("rejects invalid or unconfirmed recovery before database access: %j", async (request) => {
    expect(await recoverAdminMinimoSync({ db: {} as D1Database, admin, env: {}, request }))
      .toEqual({ ok: false, reason: "invalid_request" });
  });

  it.each(["revoked", "changed", "runner_lost", "inbound_changed", "rate_limit_changed", "cursor_changed"])("rolls back recovery and audit when %s before the write batch", async (race) => {
    const { f, input } = await fixture();
    f.db.sqlite.exec("UPDATE minimo_sync_state SET paused_reason = 'forbidden'");
    const before = (await status(input)).stores[0];
    const db = { prepare: f.db.prepare.bind(f.db), batch: async (statements: D1PreparedStatement[]) => {
      if (race === "revoked") f.db.sqlite.prepare("UPDATE admin_users SET active = 0 WHERE id = ?").run(admin.id);
      if (race === "changed") f.db.sqlite.exec("UPDATE minimo_sync_state SET paused_reason = 'challenge'");
      if (race === "runner_lost") f.db.sqlite.exec("UPDATE job_leases SET locked_by = 'replacement' WHERE lease_key = 'minimo:runner'");
      if (race === "inbound_changed") f.db.sqlite.exec("UPDATE minimo_sync_state SET last_inbound_success_at = '2030-01-01'");
      if (race === "rate_limit_changed") f.db.sqlite.exec("UPDATE minimo_sync_state SET rate_limited_until = '2030-01-01'");
      if (race === "cursor_changed") f.db.sqlite.exec("UPDATE minimo_sync_state SET next_inbound_id = 'changed'");
      return f.db.batch(statements);
    } } as unknown as D1Database;
    expect(await recoverAdminMinimoSync({ ...input, db, request: {
      action: "resume", storeId: "kyoto", expectedToken: before.token, confirm: true
    } })).toMatchObject({ ok: false, reason: race === "revoked" ? "forbidden" : "write_failed" });
    expect((await status(input)).stores[0].pausedReason).toBe(race === "changed" ? "challenge" : "forbidden");
    expect(f.db.sqlite.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'minimo_sync_resume'").get()).toEqual({ n: 0 });
    f.db.sqlite.close();
  });

  it("refuses a competing recovery while the runner owns its lease", async () => {
    const { f, input } = await fixture();
    f.db.sqlite.exec("UPDATE minimo_sync_state SET paused_reason = 'challenge'");
    const before = (await status(input)).stores[0];
    await claimStoreLease(input.db, "runner", [], f.now());
    expect(await recoverAdminMinimoSync({ ...input, request: {
      action: "resume", storeId: "kyoto", expectedToken: before.token, confirm: true
    } })).toMatchObject({ ok: false, reason: "minimo_busy" });
    f.db.sqlite.close();
  });

  it("rejects a changed day at commit and an inactive staff mapping before HTTP", async () => {
    const { f, input } = await fixture();
    f.db.sqlite.exec("UPDATE minimo_schedule_state SET status = 'pending'");
    const day = (await status(input)).stores[0].days[0];
    f.advance(31 * 60_000);
    const request = { action: "reconcile", storeId: "kyoto", date: day.date, expectedToken: day.token, confirm: true };
    const fetchImpl: typeof fetch = async (url, init) => {
      const response = await f.fetchImpl(url, init);
      f.db.sqlite.exec("UPDATE minimo_schedule_state SET status = 'blocked'");
      return response;
    };
    expect(await recoverAdminMinimoSync({ ...input, fetchImpl, request })).toMatchObject({ ok: false, reason: "write_failed" });
    expect((await status(input)).stores[0].days[0].status).toBe("blocked");
    expect(f.db.sqlite.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'minimo_sync_reconcile'").get()).toEqual({ n: 0 });
    f.advance(31 * 60_000);
    f.db.sqlite.prepare("UPDATE store_resources SET active = 0 WHERE id = ?").run(f.accounts[0].staff[0].resourceId);
    const blockedFetch = vi.fn();
    const token = (await status(input)).stores[0].days[0].token;
    expect(await recoverAdminMinimoSync({ ...input, fetchImpl: blockedFetch, request: { ...request, expectedToken: token } }))
      .toMatchObject({ ok: false, reason: "write_failed" });
    expect(blockedFetch).not.toHaveBeenCalled();
    f.db.sqlite.close();
  });

  it.each(["forbidden", "rate_limited"])("persists a %s response during read-back and stops later runs", async (code) => {
    const { f, input } = await fixture();
    f.db.sqlite.exec("UPDATE minimo_schedule_state SET status = 'pending'");
    const day = (await status(input)).stores[0].days[0];
    f.advance(31 * 60_000);
    const fetchImpl = vi.fn(async () => new Response(null, {
      status: code === "forbidden" ? 403 : 429, headers: { "Retry-After": "7200" }
    }));
    expect(await recoverAdminMinimoSync({ ...input, fetchImpl, request: {
      action: "reconcile", storeId: "kyoto", date: day.date, expectedToken: day.token, confirm: true
    } })).toMatchObject({ ok: false, reason: code === "rate_limited" ? "rate_limited" : "minimo_provider_error", providerReason: code });
    f.advance(31 * 60_000);
    await runMinimoSync({ ...input, fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect((await status(input)).stores[0].days[0].status).toBe("pending");
    f.db.sqlite.close();
  });

  it.each(["off", "preview"])("does not contact Minimo to reconcile when mode is %s", async (mode) => {
    const { f, input } = await fixture();
    f.db.sqlite.exec("UPDATE minimo_schedule_state SET status = 'pending'");
    const day = (await status(input)).stores[0].days[0];
    f.advance(31 * 60_000);
    const fetchImpl = vi.fn();
    expect(await recoverAdminMinimoSync({ ...input, fetchImpl, env: { ...f.env, MINIMO_SYNC_MODE: mode }, request: {
      action: "reconcile", storeId: "kyoto", date: day.date, expectedToken: day.token, confirm: true
    } })).toMatchObject({ ok: false, reason: "minimo_disabled" });
    expect(fetchImpl).not.toHaveBeenCalled();
    f.db.sqlite.close();
  });
});
