import { describe, expect, it } from "vitest";

import { MinimoClient } from "../src/minimo/client";
import type { MinimoAccount } from "../src/minimo/config";
import { openSession, sealSession } from "../src/minimo/session";

const account: MinimoAccount = {
  storeId: "kyoto", salonId: "salon-worker-test", password: "password-worker-test", intervalMinutes: 30,
  staff: [{ rimaUserId: "artist-worker-test", resourceId: "resource-worker-test", maxDurationMinutes: 90 }]
};

describe("Minimo transport on workerd", () => {
  it("encrypts fresh sessions with native AES-GCM and authenticates store context", async () => {
    const key = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
    const cookie = "minimo_salontool=worker-session";
    const encrypted = await sealSession(cookie, key, "kyoto:worker-connection");
    expect(await sealSession(cookie, key, "kyoto:worker-connection")).not.toBe(encrypted);
    await expect(openSession(encrypted, key, "kyoto:worker-connection")).resolves.toBe(cookie);
    await expect(openSession(encrypted, key, "osaka:worker-connection")).rejects.toThrow("Invalid Minimo session");
  });

  it("constructs manual-redirect Requests and serializes JST slots with native cookie headers", async () => {
    const requests: Request[] = [];
    const loginHeaders = new Headers({ location: "/salontool/home" });
    loginHeaders.append("set-cookie", "minimo=csrf-cookie; Path=/; Secure");
    loginHeaders.append("set-cookie", "minimo_salontool=worker-session; Path=/; HttpOnly; Secure");
    const responses = [
      new Response('<input name="csrf_token" value="csrf-worker-test">'),
      new Response(null, { status: 302, headers: loginHeaders }),
      Response.json({ current_account: { salon_id: account.salonId } }),
      Response.json({ entries: [{ staff: { rima_user_id: "artist-worker-test" },
        schedule: ["2026-10-01 09:00:00"], reservation: [] }] }),
      new Response(null, { status: 204 })
    ];
    const client = new MinimoClient({ account, pace: async () => {}, signal: new AbortController().signal,
      fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
        requests.push(new Request(input, init));
        return responses.shift()!;
      }) as typeof fetch });
    const schedule = await client.getSchedule("2026-10-01");
    await client.postSchedule(schedule);
    expect(requests.every((request) => request.redirect === "manual")).toBe(true);
    expect(requests[2].headers.get("cookie")).toBe("minimo=csrf-cookie; minimo_salontool=worker-session");
    expect(await requests[4].json()).toEqual({ date: "2026-10-01", entries: [{
      rima_user_id: "artist-worker-test", quick_reservation: ["2026-10-01 09:00:00"]
    }] });
  });

  it("aborts and cancels a stalled response body at the native ten-second deadline", async () => {
    let cancelled = false;
    const client = new MinimoClient({ account, pace: async () => {}, cookie: "minimo_salontool=worker-session",
      fetchImpl: (async (input) => String(input).endsWith("/accounts")
        ? Response.json({ current_account: { salon_id: account.salonId } })
        : new Response(new ReadableStream({ cancel() { cancelled = true; } }))) as typeof fetch });
    await expect(client.getSchedule("2026-10-01")).rejects.toMatchObject({ code: "timeout", status: 200 });
    expect(cancelled).toBe(true);
  });

  it("aborts a stalled read-back body at a short lease deadline", async () => {
    let cancelled = false;
    const client = new MinimoClient({ account, pace: async () => {}, cookie: "minimo_salontool=worker-session",
      signal: new AbortController().signal,
      fetchImpl: (async (input) => String(input).endsWith("/accounts")
        ? Response.json({ current_account: { salon_id: account.salonId } })
        : new Response(new ReadableStream({ cancel() { cancelled = true; } }))) as typeof fetch });
    await expect(client.getSchedule("2026-10-01", Date.now() + 100))
      .rejects.toMatchObject({ code: "aborted", status: 200 });
    expect(cancelled).toBe(true);
  }, 1000);
});
