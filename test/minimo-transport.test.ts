import { afterEach, describe, expect, it, vi } from "vitest";

import { parseMinimoConfig } from "../src/minimo/config";
import { parseMinimoSchedule } from "../src/minimo/schedule";
import { openSession, sealSession } from "../src/minimo/session";
import { MinimoClient, MinimoClientError } from "../src/minimo/client";

afterEach(() => { vi.restoreAllMocks(); });

const key = btoa("k".repeat(32));

// Existing transport cases isolate schedule/login behavior; account identity has
// its own HTTP contract tests in minimo-identity.test.ts.
function testClient(options: ConstructorParameters<typeof MinimoClient>[0]): MinimoClient {
  const fetchImpl = options.fetchImpl;
  return new MinimoClient({ ...options, pace: async () => {},
    fetchImpl: fetchImpl ? async (input, init) => {
      if (new URL(String(input)).pathname === "/api/v1/salontool/accounts") {
        return Response.json({ current_account: { salon_id: options.account.salonId } });
      }
      return fetchImpl(input, init);
    } : undefined
  });
}
const account = {
  storeId: "kyoto",
  salonId: "salon-test",
  password: "test-password",
  staff: [{ rimaUserId: "artist-test", resourceId: "resource-test", maxDurationMinutes: 90 }]
};
const enabled = (accounts: unknown = [account]) => ({
  MINIMO_SYNC_MODE: "preview",
  MINIMO_ACCOUNTS_JSON: JSON.stringify(accounts),
  MINIMO_SESSION_KEY: key
});

describe("Minimo configuration", () => {
  it("keeps unused malformed credentials disabled and defaults enabled intervals", () => {
    expect(parseMinimoConfig({ MINIMO_ACCOUNTS_JSON: "invalid", MINIMO_SESSION_KEY: "invalid" }))
      .toEqual({ mode: "off", accounts: [], sessionKey: "" });
    expect(parseMinimoConfig(enabled())).toEqual({
      mode: "preview", accounts: [{ ...account, intervalMinutes: 30, inboundIntervalMinutes: 10 }], sessionKey: key
    });
  });

  it("rejects ambiguous mappings and invalid secrets without disclosing input", () => {
    for (const env of [
      { ...enabled(), MINIMO_SYNC_MODE: "unknown" },
      { ...enabled(), MINIMO_SESSION_KEY: btoa("short") },
      enabled([{ ...account, unexpected: "secret-detail" }]),
      enabled([account, { ...account, storeId: "osaka", salonId: "another-salon" }]),
      enabled([{ ...account, staff: [...account.staff, account.staff[0]] }]),
      enabled([{ ...account, staff: [{ ...account.staff[0], maxDurationMinutes: 91 }] }]),
      enabled([{ ...account, intervalMinutes: 9 }]),
      enabled([{ ...account, intervalMinutes: null }]),
      enabled([{ ...account, inboundIntervalMinutes: 9 }]),
      enabled([{ ...account, inboundIntervalMinutes: 1441 }]),
      enabled([{ ...account, inboundIntervalMinutes: null }])
    ]) {
      expect(() => parseMinimoConfig(env)).toThrow("Invalid Minimo configuration");
    }
  });

  it("validates all four isolated accounts and bounded values", () => {
    const four = ["kyoto", "osaka", "nagoya", "wakayama"].map((storeId) => ({
      ...account, storeId, salonId: `salon-${storeId}`, intervalMinutes: 1440,
      staff: [{ ...account.staff[0], resourceId: `resource-${storeId}` }]
    }));
    expect(parseMinimoConfig({ ...enabled(four), MINIMO_SYNC_MODE: "apply" }).accounts).toHaveLength(4);
    for (const accounts of [[], [...four, four[0]], [{ ...account, storeId: "unknown" }],
      [{ ...account, password: " " }], [{ ...account, salonId: "invalid\nsecret" }],
      [{ ...account, password: "x".repeat(1025) }], [{ ...account, staff: [] }],
      [{ ...account, staff: Array(21).fill(account.staff[0]) }],
      [account, { ...account, storeId: "osaka", staff: [{ ...account.staff[0], resourceId: "another" }] }],
      [account, { ...account, salonId: "another", staff: [{ ...account.staff[0], resourceId: "another" }] }],
      [{ ...account, staff: [{ ...account.staff[0], unrecognized: true }] }]
    ]) expect(() => parseMinimoConfig(enabled(accounts))).toThrow("Invalid Minimo configuration");
  });
});

const rawSchedule = (reservation: unknown[] = [{
  reservation_id: "booking-test", status: 1, visit_datetime: "2026-10-01 09:00:00",
  new_menu_entity: { time_required: 90, menu_name: "discard" },
  customer_profile: { new_entity: { phone_number: "discard", first_name: "discard" } }
}]) => ({ entries: [{
  staff: { rima_user_id: "artist-test", name: "discard" },
  schedule: ["2026-10-01 09:00:00", "2026-10-01T01:30:00.000Z"], reservation
}] });

describe("Minimo schedule parsing", () => {
  it("holds conflicting reservation and menu durations instead of shortening a booking", () => {
    const booking = rawSchedule().entries[0].reservation[0] as Record<string, unknown>;
    expect(() => parseMinimoSchedule(rawSchedule([{ ...booking, time_required: 120 }]), "2026-10-01"))
      .toThrow("Minimo reservation duration mismatch");
    expect(parseMinimoSchedule(rawSchedule([{ ...booking, time_required: 90 }]), "2026-10-01")
      .entries[0].reservations[0].endAt).toBe("2026-10-01T01:30:00.000Z");
  });

  it("preserves control and whitespace rejection across configuration, parsing and POST", async () => {
    const characters = Array.from({ length: 160 }, (_, point) => String.fromCodePoint(point)).concat([
      "\u00a0", "\u1680", "\u2000", "\u2001", "\u2002", "\u2003", "\u2004", "\u2005", "\u2006",
      "\u2007", "\u2008", "\u2009", "\u200a", "\u2027", "\u2028", "\u2029", "\u202f",
      "\u205f", "\u3000", "\ufefe", "\ufeff", "\uffff"
    ]);
    for (const character of characters) {
      const id = `artist${character}`;
      const point = character.codePointAt(0)!;
      const rejected = point < 32 || point === 127 || /\s/.test(character);
      const config = enabled([{ ...account, staff: [{ ...account.staff[0], rimaUserId: id }] }]);
      const raw = { entries: [{ staff: { rima_user_id: id }, schedule: [], reservation: [] }] };
      const client = testClient({ account: { ...account, intervalMinutes: 30 }, cookie: "minimo_salontool=test",
        fetchImpl: (async () => new Response(null, { status: 204 })) as typeof fetch });
      const post = { date: "2026-10-01", entries: [{ staffId: id, openSlots: [], reservations: [] }] };
      if (rejected) {
        expect(() => parseMinimoConfig(config)).toThrow("Invalid Minimo configuration");
        expect(() => parseMinimoSchedule(raw, "2026-10-01")).toThrow("Invalid Minimo schedule");
        await expect(client.postSchedule(post)).rejects.toMatchObject({ code: "invalid_response" });
      } else {
        expect(parseMinimoConfig(config).accounts[0].staff[0].rimaUserId).toBe(id);
        expect(parseMinimoSchedule(raw, "2026-10-01").entries[0].staffId).toBe(id);
        await expect(client.postSchedule(post)).resolves.toBeUndefined();
      }
    }
  });

  it("preserves the accepted date, time, fractional-second and timezone forms", () => {
    for (const slot of [
      "2026-10-01 09:00", "2026-10-01T09:00", "2026-10-01 09:00:00",
      "2026-10-01 09:00:00.0", "2026-10-01T09:00:00.00", "2026-10-01T09:00:00.000+09:00",
      "2026-10-01T09:00+0900", "2026-10-01T00:00Z", "2026-10-01T00:00:00.000Z",
      "2026-10-01T00:05:00+00:05"
    ]) {
      const raw = { entries: [{ staff: { rima_user_id: "artist-test" }, schedule: [slot], reservation: [] }] };
      expect(parseMinimoSchedule(raw, "2026-10-01").entries[0].openSlots).toEqual(["2026-10-01T00:00:00.000Z"]);
    }
    for (const slot of [
      "2026-10-01 09:00.0", "2026-10-01 09:00:0", "2026-10-01 09:00:00.0000",
      "2026-10-01 09:00+9:00", "2026-10-01 09:00+090", "2026-10-01 09:00+24:00",
      "2026-10-01 09:00+09:60", "2026-10-01 00:00z", "2026-10-01 09:00:00 +09:00"
    ]) {
      const raw = { entries: [{ staff: { rima_user_id: "artist-test" }, schedule: [slot], reservation: [] }] };
      expect(() => parseMinimoSchedule(raw, "2026-10-01")).toThrow("Invalid Minimo schedule");
    }
  });

  it("normalizes exact appointments and discards customer fields", () => {
    expect(parseMinimoSchedule(rawSchedule(), "2026-10-01")).toEqual({
      date: "2026-10-01", entries: [{
        staffId: "artist-test",
        openSlots: ["2026-10-01T00:00:00.000Z", "2026-10-01T01:30:00.000Z"],
        reservations: [{ id: "booking-test", staffId: "artist-test", status: "confirmed",
          startAt: "2026-10-01T00:00:00.000Z", endAt: "2026-10-01T01:30:00.000Z" }]
      }]
    });
    expect(parseMinimoSchedule(rawSchedule([
      { reservation_id: 7, status: 11 },
      { reservation_id: "unknown", status: "unknown", visit_datetime: "invalid" }
    ]), "2026-10-01").entries[0].reservations).toEqual([
      { id: "7", staffId: "artist-test", status: "cancelled", startAt: null, endAt: null },
      { id: "unknown", staffId: "artist-test", status: "ignored", startAt: null, endAt: null }
    ]);
  });

  it("rejects incomplete schedules and invalid appointments instead of guessing", () => {
    const valid = rawSchedule().entries[0].reservation[0] as Record<string, unknown>;
    for (const reservation of [
      { ...valid, visit_datetime: "2026-02-30 09:00:00" },
      { ...valid, visit_datetime: "2026-10-02 09:00:00" },
      { ...valid, visit_datetime: "2026-10-01 24:00:00" },
      { ...valid, visit_datetime: "2026-10-01 09:01:00" },
      { ...valid, visit_datetime: "2026-10-01 09:00:01" },
      { ...valid, visit_datetime: "2026-10-01T00:00:00.001Z" },
      { ...valid, new_menu_entity: {} },
      { ...valid, new_menu_entity: { time_required: "90" } },
      ...[0, 91, 90.5, 725].map((time_required) => ({ ...valid, new_menu_entity: { time_required } })),
      { ...valid, reservation_id: "secret\r\n" },
      { ...valid, artist_profile: { rima_user_id: "other-staff" } },
      { ...valid, artist_profile: { new_entity: { rima_user_id: "other-staff" } } }
    ]) expect(() => parseMinimoSchedule(rawSchedule([reservation]), "2026-10-01"))
      .toThrow("Invalid Minimo schedule");
    for (const value of [null, {}, { entries: null }, { entries: [{}] },
      { entries: [{ staff: { rima_user_id: "artist-test" }, schedule: [], reservation: null }] },
      { entries: Array(201).fill(rawSchedule().entries[0]) }
    ]) expect(() => parseMinimoSchedule(value, "2026-10-01")).toThrow("Invalid Minimo schedule");
    expect(() => parseMinimoSchedule({ entries: [] }, "2026-02-30")).toThrow("Invalid Minimo schedule");
  });

  it("rejects duplicate identities and equivalent duplicate slots", () => {
    const entry = rawSchedule().entries[0];
    for (const entries of [
      [entry, entry],
      [entry, { ...entry, staff: { rima_user_id: "another" } }],
      [{ ...entry, schedule: ["2026-10-01 09:00:00", "2026-10-01T00:00:00.000Z"] }],
      [{ ...entry, reservation: [...entry.reservation, ...entry.reservation] }]
    ]) expect(() => parseMinimoSchedule({ entries }, "2026-10-01")).toThrow("Invalid Minimo schedule");
  });
});

describe("encrypted Minimo sessions", () => {
  it("uses fresh authenticated ciphertext bound to the account context", async () => {
    const cookie = "minimo_salontool=test-session";
    const first = await sealSession(cookie, key, "kyoto:connection-test");
    const second = await sealSession(cookie, key, "kyoto:connection-test");
    expect(first).not.toEqual(second);
    expect(first).not.toContain("test-session");
    await expect(openSession(first, key, "kyoto:connection-test")).resolves.toBe(cookie);
    await expect(openSession(first, key, "osaka:connection-test")).rejects.toThrow("Invalid Minimo session");
    await expect(openSession(first.replace(/^v1/, "v2"), key, "kyoto:connection-test"))
      .rejects.toThrow("Invalid Minimo session");
    const parts = first.split(".");
    parts[2] = `${parts[2][0] === "A" ? "B" : "A"}${parts[2].slice(1)}`;
    await expect(openSession(parts.join("."), key, "kyoto:connection-test"))
      .rejects.toThrow("Invalid Minimo session");
    await expect(openSession(first, btoa("x".repeat(32)), "kyoto:connection-test"))
      .rejects.toThrow("Invalid Minimo session");
    await expect(sealSession("minimo_salontool=test\r\nInjected: secret", key, "test"))
      .rejects.toThrow("Invalid Minimo session");
    await expect(sealSession("minimo=csrf-only", key, "test")).rejects.toThrow("Invalid Minimo session");
    await expect(sealSession(cookie, "invalid-secret", "test")).rejects.toThrow("Invalid Minimo session");
    await expect(openSession("v1.".repeat(3000), key, "test")).rejects.toThrow("Invalid Minimo session");
  });
});

describe("Minimo HTTP boundary", () => {
  it("logs in at the fixed origin and serializes only canonical JST availability", async () => {
    const requests: Request[] = [];
    const responses = [
      new Response('<input name="csrf_token" value="csrf-test">', {
        headers: { "set-cookie": "minimo=csrf-cookie; Path=/" }
      }),
      new Response(null, { status: 302, headers: {
        location: "/salontool/home", "set-cookie": "minimo_salontool=test-session; Path=/"
      } }),
      Response.json(rawSchedule()),
      new Response(null, { status: 204 })
    ];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(new Request(input, init));
      return responses.shift()!;
    }) as typeof fetch;
    const client = testClient({ account: parseMinimoConfig(enabled()).accounts[0], fetchImpl });
    const schedule = await client.getSchedule("2026-10-01");
    await client.postSchedule(schedule);
    expect(requests.map((request) => request.url)).toEqual([
      "https://minimodel.jp/salontool/login", "https://minimodel.jp/salontool/login",
      "https://minimodel.jp/api/v1/salontool/schedule?date=2026-10-01",
      "https://minimodel.jp/api/v1/salontool/schedule"
    ]);
    expect(requests.every((request) => request.redirect === "manual")).toBe(true);
    expect(await requests[1].text()).toBe("salon_id=salon-test&password=test-password&csrf_token=csrf-test");
    expect(await requests[3].json()).toEqual({ date: "2026-10-01", entries: [{
      rima_user_id: "artist-test", quick_reservation: ["2026-10-01 09:00:00", "2026-10-01 10:30:00"]
    }] });
    expect(client.sessionCookie).toBe("minimo=csrf-cookie; minimo_salontool=test-session");
  });

  it("reuses an encrypted-session cookie and permits only one 401 reauthentication", async () => {
    const requests: Request[] = [];
    const responses = [
      new Response("expired", { status: 401 }),
      new Response('<input value="csrf-test" type="hidden" name="csrf_token">'),
      new Response(null, { status: 303, headers: {
        location: "https://minimodel.jp/salontool/home", "set-cookie": "minimo_salontool=renewed; Path=/"
      } }),
      Response.json(rawSchedule()),
      new Response("expired again", { status: 401 })
    ];
    const client = testClient({ account: { ...account, intervalMinutes: 30 },
      cookie: "minimo_salontool=old", fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
        requests.push(new Request(input, init));
        return responses.shift()!;
      }) as typeof fetch });
    await client.getSchedule("2026-10-01");
    await expect(client.getSchedule("2026-10-02")).rejects.toMatchObject({ code: "auth_failed", status: 401 });
    await expect(client.getSchedule("2026-10-03")).rejects.toMatchObject({ code: "auth_failed", status: 401 });
    expect(requests).toHaveLength(5);
    expect(requests[0].headers.get("cookie")).toBe("minimo_salontool=old");
    expect(client.sessionCookie).toBe("minimo_salontool=renewed");
  });

  it("stops on a challenge 401 instead of logging in again", async () => {
    const requests: Request[] = [];
    const client = testClient({ account: { ...account, intervalMinutes: 30 },
      cookie: "minimo_salontool=old", fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
        requests.push(new Request(input, init));
        return new Response("challenge", { status: 401, headers: { "cf-mitigated": "challenge" } });
      }) as typeof fetch });
    await expect(client.getSchedule("2026-10-01")).rejects.toMatchObject({ code: "challenge", status: 401 });
    expect(requests).toHaveLength(1);
  });

  it.each([1, 2])("never retries a schedule POST when reauthentication step %i expires the lease", async (expiredStep) => {
    let clock = 1000;
    const requests: Request[] = [];
    const responses = [
      new Response("expired session", { status: 401 }),
      new Response('<input name="csrf_token" value="csrf-test">'),
      new Response(null, { status: 302, headers: {
        location: "/salontool/home", "set-cookie": "minimo_salontool=renewed"
      } }),
      new Response(null, { status: 204 })
    ];
    const client = testClient({ account: { ...account, intervalMinutes: 30 },
      cookie: "minimo_salontool=old", now: () => clock,
      fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
        requests.push(new Request(input, init));
        if (requests.length - 1 === expiredStep) clock = 6000;
        else clock += 1000;
        return responses.shift()!;
      }) as typeof fetch });
    await expect(client.postSchedule(parseMinimoSchedule(rawSchedule(), "2026-10-01"), 6000))
      .rejects.toMatchObject({ code: "aborted", message: "aborted" });
    expect(requests.map((request) => [new URL(request.url).pathname, request.method])).toEqual([
      ["/api/v1/salontool/schedule", "POST"], ["/salontool/login", "GET"],
      ...(expiredStep === 2 ? [["/salontool/login", "POST"]] : [])
    ]);
  });

  it("rejects expired write and read-back deadlines before any login or HTTP dispatch", async () => {
    let calls = 0;
    for (const cookie of [undefined, "minimo_salontool=cached"]) {
      for (const deadline of [1000, 999, NaN]) {
        const options = { account: { ...account, intervalMinutes: 30 }, cookie, now: () => 1000,
          fetchImpl: (async () => { calls++; return new Response(null, { status: 204 }); }) as typeof fetch };
        await expect(testClient(options).postSchedule(parseMinimoSchedule(rawSchedule(), "2026-10-01"), deadline))
          .rejects.toMatchObject({ code: "aborted" });
        await expect(testClient(options).getSchedule("2026-10-01", deadline))
          .rejects.toMatchObject({ code: "aborted" });
      }
    }
    expect(calls).toBe(0);
  });

  it("rejects credential redirects without following or sending another request", async () => {
    const requests: Request[] = [];
    const responses = [new Response('<input name="csrf_token" value="csrf-test">'),
      new Response(null, { status: 302, headers: {
        location: "https://other.invalid/salontool/home", "set-cookie": "minimo_salontool=untrusted"
      } })];
    const client = testClient({ account: { ...account, intervalMinutes: 30 },
      fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
        requests.push(new Request(input, init));
        return responses.shift()!;
      }) as typeof fetch });
    await expect(client.getSchedule("2026-10-01")).rejects.toMatchObject({ code: "redirect", status: 302 });
    await expect(client.getSchedule("2026-10-01")).rejects.toBeInstanceOf(MinimoClientError);
    expect(requests).toHaveLength(2);
    expect(requests.every((request) => new URL(request.url).origin === "https://minimodel.jp" && request.redirect === "manual"))
      .toBe(true);
    expect(client.sessionCookie).toBeNull();
  });

  it.each([
    [403, {}, "forbidden"],
    [302, { location: "/salontool/login" }, "redirect"],
    [200, { "cf-mitigated": "challenge" }, "challenge"]
  ])("stops a cached session on restriction %i", async (status, headers, code) => {
    let calls = 0;
    let cancelled = false;
    const body = new ReadableStream({ cancel() { cancelled = true; } });
    const client = testClient({ account: { ...account, intervalMinutes: 30 }, cookie: "minimo_salontool=test",
      fetchImpl: (async () => { calls++; return new Response(body, { status, headers }); }) as typeof fetch });
    await expect(client.getSchedule("2026-10-01")).rejects.toMatchObject({ code, status });
    await expect(client.getSchedule("2026-10-02")).rejects.toMatchObject({ code, status });
    expect(calls).toBe(1);
    expect(cancelled).toBe(true);
  });

  it.each([
    ["120", 600_000], ["172800", 172_800_000],
    ["Thu, 01 Oct 2026 03:00:00 GMT", 10_800_000], ["invalid", 600_000]
  ])("preserves Retry-After %s and stops subsequent requests", async (header, delay) => {
    let calls = 0;
    const client = testClient({ account: { ...account, intervalMinutes: 30 }, cookie: "minimo_salontool=test",
      now: () => Date.parse("2026-10-01T00:00:00Z"),
      fetchImpl: (async () => { calls++; return new Response("secret-response", {
        status: 429, headers: { "retry-after": header }
      }); }) as typeof fetch });
    await expect(client.getSchedule("2026-10-01")).rejects.toMatchObject({
      name: "MinimoClientError", message: "rate_limited", code: "rate_limited", status: 429, retryAfterMs: delay
    });
    await expect(client.getSchedule("2026-10-02")).rejects.toMatchObject({ code: "rate_limited" });
    expect(calls).toBe(1);
  });

  it("requires a real session cookie after login and never treats CSRF as authentication", async () => {
    const responses = [new Response("normal login", { headers: {
      "set-cookie": `minimo=${btoa(JSON.stringify({ csrf_token: "cookie-csrf" }))}.signature; Path=/`
    } }), new Response(null, { status: 302, headers: { location: "/salontool/home" } })];
    const client = testClient({ account: { ...account, intervalMinutes: 30 },
      fetchImpl: (async () => responses.shift()!) as typeof fetch });
    await expect(client.getSchedule("2026-10-01")).rejects.toMatchObject({ code: "auth_failed" });
    expect(client.sessionCookie).toBeNull();
  });

  it("respects cookie deletion but lets Max-Age override Expires", async () => {
    const responses = [
      Response.json(rawSchedule(), { headers: {
        "set-cookie": "minimo_salontool=renewed; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=600"
      } }),
      Response.json(rawSchedule(), { headers: { "set-cookie": "minimo_salontool=deleted; Max-Age=0" } })
    ];
    const client = testClient({ account: { ...account, intervalMinutes: 30 }, cookie: "minimo_salontool=test",
      fetchImpl: (async () => responses.shift()!) as typeof fetch });
    await client.getSchedule("2026-10-01");
    expect(client.sessionCookie).toBe("minimo_salontool=renewed");
    await client.getSchedule("2026-10-01");
    expect(client.sessionCookie).toBeNull();
  });

  it("refuses malformed schedules, challenge pages and unexpected POST success", async () => {
    for (const response of [
      Response.json({ entries: null }),
      new Response('<html><div class="g-recaptcha">secret</div></html>', { headers: { "content-type": "text/html" } })
    ]) {
      const client = testClient({ account: { ...account, intervalMinutes: 30 }, cookie: "minimo_salontool=test",
        fetchImpl: (async () => response) as typeof fetch });
      await expect(client.getSchedule("2026-10-01")).rejects.toBeInstanceOf(MinimoClientError);
    }
    const client = testClient({ account: { ...account, intervalMinutes: 30 }, cookie: "minimo_salontool=test",
      fetchImpl: (async () => new Response("unexpected", { status: 200 })) as typeof fetch });
    await expect(client.postSchedule(parseMinimoSchedule(rawSchedule(), "2026-10-01")))
      .rejects.toMatchObject({ code: "invalid_response", status: 200 });
  });

  it("bounds streamed and declared response sizes and cancels rejected bodies", async () => {
    for (const declared of [true, false]) {
      let cancelled = false;
      const body = new ReadableStream({
        start(controller) { if (!declared) controller.enqueue(new Uint8Array(1_048_577)); },
        cancel() { cancelled = true; }
      });
      const client = testClient({ account: { ...account, intervalMinutes: 30 }, cookie: "minimo_salontool=test",
        fetchImpl: (async () => new Response(body, { headers: declared ? { "content-length": "1048577" } : {} })) as typeof fetch });
      await expect(client.getSchedule("2026-10-01")).rejects.toMatchObject({ code: "body_too_large" });
      expect(cancelled).toBe(true);
    }
    const login = testClient({ account: { ...account, intervalMinutes: 30 },
      fetchImpl: (async () => new Response("x".repeat(262_145))) as typeof fetch });
    await expect(login.getSchedule("2026-10-01")).rejects.toMatchObject({ code: "body_too_large" });
  });

  it("retains the request deadline through a stalled body and combines the run abort", async () => {
    const nativeTimeout = AbortSignal.timeout.bind(AbortSignal);
    vi.spyOn(AbortSignal, "timeout").mockImplementation(() => nativeTimeout(20));
    let cancelled = false;
    const client = testClient({ account: { ...account, intervalMinutes: 30 }, cookie: "minimo_salontool=test",
      fetchImpl: (async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }))) as typeof fetch });
    await expect(client.getSchedule("2026-10-01")).rejects.toMatchObject({ code: "timeout", status: 200 });
    expect(cancelled).toBe(true);
    const controller = new AbortController();
    const aborted = testClient({ account: { ...account, intervalMinutes: 30 }, cookie: "minimo_salontool=test",
      signal: controller.signal, fetchImpl: (async () => {
        controller.abort("secret-abort-reason");
        return new Response(new ReadableStream());
      }) as typeof fetch });
    await expect(aborted.getSchedule("2026-10-01")).rejects.toMatchObject({ code: "aborted", message: "aborted" });
  });

  it("rejects invalid session headers and sanitizes fetch exceptions", async () => {
    for (const cookie of ["minimo=csrf-only", "minimo_salontool=\r\nInjected: secret", "minimo_salontool=a; minimo_salontool=b"]) {
      expect(() => testClient({ account: { ...account, intervalMinutes: 30 }, cookie }))
        .toThrow("invalid_session");
    }
    const client = testClient({ account: { ...account, intervalMinutes: 30 }, cookie: "minimo_salontool=test",
      fetchImpl: (async () => { throw new Error("password=secret cookie=secret"); }) as typeof fetch });
    await expect(client.getSchedule("2026-10-01")).rejects.toMatchObject({ message: "network_error", status: 0 });
  });
});
