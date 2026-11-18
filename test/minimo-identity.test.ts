import { describe, expect, it, vi } from "vitest";
import { MinimoClient } from "../src/minimo/client";

const account = { storeId: "kyoto", salonId: "expected-salon", password: "synthetic-password", intervalMinutes: 30,
  staff: [{ rimaUserId: "artist", resourceId: "resource", maxDurationMinutes: 90 }] };

describe("Minimo account identity", () => {
  it("stops when the identity response removes authentication instead of trusting a later login", async () => {
    const responses = [Response.json({ current_account: { salon_id: account.salonId } }, {
      headers: { "set-cookie": "minimo_salontool=; Max-Age=0; Path=/" }
    }), new Response('<input name="csrf_token" value="synthetic-csrf">'),
    new Response(null, { status: 302, headers: { location: "/salontool/home", "set-cookie": "minimo_salontool=another-account" } }),
    Response.json({ entries: [{ staff: { rima_user_id: "another-artist" }, schedule: [], reservation: [] }] })];
    const fetchImpl = vi.fn(async () => responses.shift()!);
    const client = new MinimoClient({ account, cookie: "minimo_salontool=old", pace: async () => {}, fetchImpl });
    await expect(client.getSchedule("2026-10-01")).rejects.toMatchObject({ code: "invalid_session" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("reads paginated active reservations and exact cancellations, preserving a missing detail", async () => {
    const paths: string[] = [];
    const client = new MinimoClient({ account, cookie: "minimo_salontool=synthetic", pace: async () => {},
      fetchImpl: async (input) => {
        const url = new URL(String(input)); paths.push(url.pathname);
        if (url.pathname.endsWith("accounts")) return Response.json({ current_account: { salon_id: account.salonId } });
        if (url.pathname.endsWith("/42")) return Response.json({ reservation: { reservation_id: 42, staff_id: "artist", status: 12 } });
        if (url.pathname.endsWith("/43")) return new Response(null, { status: 404 });
        expect(url.searchParams.get("exclude_statuses")).toBe("0,3,10,11,12");
        return Response.json({ _page: { current_page: 1, entities: 0, entities_by_page: 100, max_page: 0 }, reservations: [] });
      } });
    expect((await client.getReservationPage(1)).reservations).toEqual([]);
    expect(await client.getReservation("42")).toMatchObject({ id: "42", status: "cancelled" });
    expect(await client.getReservation("43")).toBeNull();
    expect((await client.getReservationPage(1)).total).toBe(0);
    expect(paths.filter(path => path.endsWith("accounts"))).toHaveLength(1);
  });

  it("accepts the observed empty login badge while stopping an active CAPTCHA in the same container", async () => {
    for (const active of [false, true]) {
      const responses = [new Response('<input name="csrf_token" value="synthetic-csrf"><div id="JS_inline_recaptcha" class="recaptcha-badge">'
        + (active ? '<iframe src="https://captcha.example.test/widget"></iframe>' : '') + '</div>'),
      new Response(null, { status: 302, headers: { location: "/salontool/home", "set-cookie": "minimo_salontool=synthetic" } }),
      Response.json({ current_account: { salon_id: account.salonId } })];
      const fetchImpl = vi.fn(async () => responses.shift()!);
      const client = new MinimoClient({ account, pace: async () => {}, fetchImpl });
      if (active) {
        await expect(client.getAccount()).rejects.toMatchObject({ code: "challenge" });
        expect(fetchImpl).toHaveBeenCalledTimes(1);
      } else {
        await expect(client.getAccount()).resolves.toEqual({ salonId: account.salonId, name: null });
        expect(fetchImpl).toHaveBeenCalledTimes(3);
      }
    }
  });

  it("refuses a valid cookie belonging to a different salon before reading or posting schedules", async () => {
    const paths: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      paths.push(new URL(String(input)).pathname);
      return Response.json({ current_account: { salon_id: "different-salon", name: "another store" } });
    });
    const client = new MinimoClient({ account, pace: async () => {}, cookie: "minimo_salontool=synthetic", fetchImpl });
    await expect(client.getSchedule("2026-10-01")).rejects.toMatchObject({ code: "account_mismatch" });
    await expect(client.postSchedule({ date: "2026-10-01", entries: [] })).rejects.toMatchObject({ code: "account_mismatch" });
    expect(paths).toEqual(["/api/v1/salontool/accounts"]);
  });

  it("checks identity again after 401 reauthentication before a schedule retry", async () => {
    const paths: string[] = [];
    let identities = 0;
    const fetchImpl: typeof fetch = async (input, init) => {
      const path = new URL(String(input)).pathname;
      paths.push(`${init?.method ?? "GET"} ${path}`);
      if (path.endsWith("/accounts")) return Response.json({ current_account: { salon_id: ++identities === 1 ? account.salonId : "wrong-after-login" } });
      if (path.endsWith("/schedule")) return new Response(null, { status: 401 });
      if (init?.method === "POST") return new Response(null, { status: 302, headers: { location: "/salontool/home", "set-cookie": "minimo_salontool=renewed" } });
      return new Response('<input name="csrf_token" value="synthetic-csrf">');
    };
    const client = new MinimoClient({ account, pace: async () => {}, cookie: "minimo_salontool=old", fetchImpl });
    await expect(client.getSchedule("2026-10-01")).rejects.toMatchObject({ code: "account_mismatch" });
    expect(paths).toEqual(["GET /api/v1/salontool/accounts", "GET /api/v1/salontool/schedule",
      "GET /salontool/login", "POST /salontool/login", "GET /api/v1/salontool/accounts"]);
  });
});
