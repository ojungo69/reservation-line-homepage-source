import { expect, vi } from "vitest";
import { createMigratedSqliteD1 } from "./sqlite-d1";

const storeIds = ["kyoto", "osaka", "nagoya", "wakayama"];
const start = Date.parse("2026-09-29T00:00:00Z");
const key = btoa(String.fromCharCode(...new Array<number>(32).fill(17)));

export function createMinimoFixture(mode: "preview" | "apply") {
  const db = createMigratedSqliteD1();
  db.sqlite.exec("UPDATE store_settings SET booking_window_days = 1");
  const accounts = storeIds.map((storeId) => {
    const resource = db.sqlite.prepare("SELECT id FROM store_resources WHERE store_id = ? AND active = 1 LIMIT 1")
      .get(storeId) as { id: string };
    return { storeId, salonId: `salon-${storeId}`, password: "synthetic-password", intervalMinutes: 30,
      staff: [{ rimaUserId: `artist-${storeId}`, resourceId: resource.id, maxDurationMinutes: 90 }] };
  });
  for (const account of accounts) {
    db.sqlite.prepare(`INSERT INTO external_blocks (id, store_id, resource_id, source, start_at, end_at, status)
      VALUES (?, ?, ?, 'admin_block', '2026-09-29T05:00:00.000Z', '2026-09-29T06:00:00.000Z', 'active')`)
      .run(`local-${account.storeId}`, account.storeId, account.staff[0].resourceId);
  }
  const remote = new Map<string, string[]>();
  const requests: { salon: string; path: string; method: string }[] = [];
  let throttle = false;
  let uncertainPost = false;
  let retryAfter = "3600";
  let bookingTime = "10:00";
  let bookingStatus = 1;
  let bookingPresent = true;
  let clock = start;
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    expect(url.origin).toBe("https://minimodel.jp");
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    let salon = headers.get("Cookie")?.match(/minimo_salontool=synthetic-(salon-[a-z]+)/)?.[1] ?? "";
    if (url.pathname === "/salontool/login") {
      if (method === "GET") {
        requests.push({ salon, path: url.pathname, method });
        return new Response('<input name="csrf_token" value="synthetic-csrf">', { headers: { "content-type": "text/html" } });
      }
      salon = new URLSearchParams(String(init?.body)).get("salon_id")!;
      requests.push({ salon, path: url.pathname, method });
      return new Response(null, { status: 302, headers: { Location: "/salontool/home",
        "Set-Cookie": `minimo_salontool=synthetic-${salon}; Path=/; HttpOnly; Secure` } });
    }
    requests.push({ salon, path: url.pathname, method });
    const account = accounts.find((value) => value.salonId === salon);
    if (!account) return new Response(null, { status: 401 });
    if (throttle) return new Response(null, { status: 429, headers: { "Retry-After": retryAfter } });
    if (url.pathname === "/api/v1/salontool/accounts") return Response.json({ current_account: { salon_id: account.salonId } });
    if (url.pathname === "/api/v1/salontool/staffs") return Response.json({ staffs: [{ staff_id: account.staff[0].rimaUserId }] });
    if (url.pathname.endsWith("/recruitment/menus")) return Response.json({ menus: [{ is_open: true, is_enable: true, time_required: 90 }] });
    const indexedBooking = { reservation_id: "shared-booking", staff_id: account.staff[0].rimaUserId, status: bookingStatus,
      visit_datetime: `2026-09-29 ${bookingTime}:00` };
    if (url.pathname === "/api/v1/salontool/reservations") {
      const reservations = bookingPresent && [1, 2].includes(bookingStatus) ? [indexedBooking] : [];
      return Response.json({ reservations, _page: { current_page: 1, entities: reservations.length,
        entities_by_page: 100, max_page: reservations.length ? 1 : 0 } });
    }
    if (url.pathname === "/api/v1/salontool/reservations/shared-booking") {
      return bookingStatus === 404 ? new Response(null, { status: 404 }) : Response.json({ reservation: indexedBooking });
    }
    if (method === "POST") {
      const body = JSON.parse(String(init?.body)) as { date: string; entries: { rima_user_id: string; quick_reservation: string[] }[] };
      expect(body.entries[0].rima_user_id).toBe(account.staff[0].rimaUserId);
      remote.set(`${salon}:${body.date}`, body.entries[0].quick_reservation);
      return new Response(null, { status: uncertainPost ? 500 : 204 });
    }
    const date = url.searchParams.get("date")!;
    return Response.json({ entries: [{ staff: { rima_user_id: account.staff[0].rimaUserId },
      schedule: remote.get(`${salon}:${date}`) ?? [`${date} 13:00:00`, `${date} 16:00:00`],
      reservation: date === "2026-09-29" && bookingPresent ? [{ reservation_id: "shared-booking", status: bookingStatus,
        visit_datetime: `${date} ${bookingTime}:00`, new_menu_entity: { time_required: 90 },
        customer_profile: { new_entity: { first_name: "must-not-be-stored" } } }] : [] }] });
  }) as unknown as typeof fetch;
  const env = { MINIMO_SYNC_MODE: mode, MINIMO_ACCOUNTS_JSON: JSON.stringify(accounts), MINIMO_SESSION_KEY: key };
  return { db, accounts, remote, requests, fetchImpl, env, pace: async () => {},
    now: () => clock, advance: (ms: number) => { clock += ms; },
    throttle: (delay = "3600") => { throttle = true; retryAfter = delay; }, uncertain: () => { uncertainPost = true; },
    booking: (time: string, status = 1, present = true) => { bookingTime = time; bookingStatus = status; bookingPresent = present; } };
}
