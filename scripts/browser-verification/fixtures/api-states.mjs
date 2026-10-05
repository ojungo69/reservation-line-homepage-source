// API state fixtures (quickstart §2 — T022): every deterministic page state the
// matrix walk visits, keyed by state name. preview-server.mjs serves these when
// the page is opened as /?state=<name> (or /customer/reservations?state=<name>);
// a third party reproduces any state by opening that URL in a plain browser.
//
// Route values: { status?, body } for a JSON response, { delayMs } to hold the
// response open (deterministic loading states). `stub` overrides
// window.__stubConfig for liff-turnstile-stub.js (e.g. logged-out LINE).
// Response shapes mirror the real handlers' contracts as consumed by
// public/app.js / public/customer/reservations.js.
import { buildServices130 } from "./services-130.mjs";
import { resolveTotalTreatmentDuration } from "../../../src/reservations/slot-times.ts";

const STORE2_SERVICES = [
  { id: "b-1", storeId: "store-2", name: "フェイシャル｜毛穴ケア", durationMinutes: 60 },
  { id: "b-2", storeId: "store-2", name: "区切りなし整体", durationMinutes: 30 },
  { id: "b-3", storeId: "store-2", name: "新規部門｜モニターコース", durationMinutes: 30 },
  { id: "b-4", storeId: "store-2", name: "フェイシャル｜保湿ケア", durationMinutes: 60 }
];

const CONSENT_VERSIONS = {
  notice: "1",
  cancellationPolicy: "1",
  privacyPolicy: "1",
  minorGuardian: "1",
  duplicateReservationWarning: "1"
};

const optionsBody = (overrides = {}) => ({
  ok: true,
  stores: [
    // Keep the ordinary duplicate-warning fixtures below the cap; "cap" overrides this to one.
    { id: "store-1", name: "本店", timezone: "Asia/Tokyo", bookingWindowDays: 30, customerNotice: null, maxActiveReservationsPerCustomer: 3 },
    { id: "store-2", name: "二号店", timezone: "Asia/Tokyo", bookingWindowDays: 30, customerNotice: null, maxActiveReservationsPerCustomer: 3 }
  ],
  services: [...buildServices130("store-1"), ...STORE2_SERVICES].map((service) => ({
    priceLabel: null, priceAmount: null, comboPriceAmount: null, comboWithPrefix: null, mensMenu: false, ...service
  })),
  resources: [
    { id: "r1", storeId: "store-1", name: "枠1" },
    { id: "r2", storeId: "store-2", name: "枠1" }
  ],
  turnstile: { siteKey: "stub-site-key", action: "reservation-submit" },
  businessHours: [],
  consentVersions: CONSENT_VERSIONS,
  liffId: "preview-liff-id",
  ...overrides
});

const gateBody = (overrides = {}) => ({
  allowed: true,
  lineUserId: "U-stub",
  stage: "form",
  customer: { displayName: "スタブ 花子", displayNameKana: "スタブ ハナコ", phoneMasked: "****5678" },
  upcomingReservations: [],
  ...overrides
});

const upcoming = (now, hoursAhead, status) => ({
  startAt: new Date(now + hoursAhead * 3600_000).toISOString(),
  status,
  // Server-computed hard-warning flag (public/app.js keys the hard level on
  // this field, not on startAt arithmetic).
  isWithinLeadTime: hoursAhead <= 24,
  serviceName: "脱毛｜全身脱毛 1回コース",
  storeName: "本店"
});

const reservation = (now, id, status) => {
  const startAt = now + 72 * 3600_000;
  return {
    id,
    storeName: "本店",
    serviceName: "脱毛｜全身脱毛 1回コース / フェイシャル｜毛穴ケア",
    startAt: new Date(startAt).toISOString(),
    endAt: new Date(startAt + 90 * 60_000).toISOString(),
    status
  };
};

// Availability slots for "today in Asia/Tokyo": the walk picks the date field's
// default day, so slots are anchored to the current date at fixed JST times.
const slotsBody = (now, query) => {
  const today = new Date(now + 9 * 3600_000).toISOString().slice(0, 10);
  const date = query.date ?? today;
  const midnight = Date.parse(`${date}T00:00:00.000Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(midnight) || new Date(midnight).toISOString().slice(0, 10) !== date) {
    return { ok: false, reason: "invalid_request" };
  }
  const serviceIds = (query.serviceIds || query.serviceId || "svc-001").split(",");
  const storeId = query.storeId || "store-1";
  const resourceId = query.resourceId || "r1";
  const options = optionsBody();
  const store = options.stores.find((store) => store.id === storeId);
  const services = serviceIds.map((id) => options.services.find((service) => service.id === id && service.storeId === storeId));
  if (!store ||
    !options.resources.some((resource) => resource.id === resourceId && resource.storeId === storeId) ||
    services.some((service) => !service)) {
    return { ok: false, reason: "not_found" };
  }
  const duration = resolveTotalTreatmentDuration(services.map((service) => ({ id: service.id, duration_minutes: service.durationMinutes })));
  if (!duration.ok) return duration;
  // Both synthetic stores use Asia/Tokyo; keep the server's inclusive upper bound.
  const latestDate = new Date(now + 9 * 3600_000 + store.bookingWindowDays * 86_400_000).toISOString().slice(0, 10);
  if (date < today || date > latestDate) return { ok: false, reason: "invalid_request" };
  const { durationMinutes } = duration;
  const slot = (h, durationMin) => ({
    startAt: `${date}T${String(h - 9).padStart(2, "0")}:00:00.000Z`,
    endAt: new Date(Date.parse(`${date}T${String(h - 9).padStart(2, "0")}:00:00.000Z`) + durationMin * 60_000).toISOString()
  });
  return {
    ok: true, availabilityStatus: "ready", storeId, serviceId: serviceIds[0], serviceIds,
    resourceId, date, durationMinutes, timezone: "Asia/Tokyo",
    slots: [10, 13, 15, 17].map((hour) => slot(hour, durationMinutes))
  };
};

const submitBody = (now) => ({
  ok: true,
  reservationId: "r-preview-1",
  status: "pending_approval",
  startAt: new Date(now + 72 * 3600_000).toISOString()
});

const myBody = (reservations) => ({ ok: true, reservations });

/**
 * @returns {Record<string, {
 *   page: "/" | "/customer/reservations",
 *   description: string,
 *   stub?: object,
 *   routes: Partial<Record<"options"|"availability"|"gate"|"submit"|"myReservations",
 *     { status?: number, body?: unknown, delayMs?: number }>>
 * }>}
 */
export const buildApiStates = (now = Date.now(), query = {}) => {
  const availability = slotsBody(now, query);
  const base = {
    options: { body: optionsBody() },
    availability: { body: availability, ...(!availability.ok ? { status: availability.reason === "not_found" ? 404 : 400 } : {}) },
    gate: { body: gateBody() },
    submit: { body: submitBody(now) },
    myReservations: { body: myBody([]) }
  };
  const form = (description, routes = {}, stub) => ({
    page: "/",
    description,
    ...(stub ? { stub } : {}),
    routes: { ...base, ...routes }
  });
  const my = (description, myReservations) => ({
    page: "/customer/reservations",
    description,
    routes: { ...base, myReservations }
  });

  return {
    "form-default": form("正常系: 134件メニュー・空き枠4・LINE認証済み・重複なし"),
    "options-loading": form("options 読込中 (応答保留)", { options: { delayMs: 600_000 } }),
    "options-error": form("options 500", { options: { status: 500, body: { ok: false, reason: "internal_error" } } }),
    "options-empty": form("options 空 (店舗・メニューなし)", {
      options: { body: optionsBody({ stores: [], services: [], resources: [] }) }
    }),
    "availability-loading": form("availability 読込中 (応答保留)", { availability: { delayMs: 600_000 } }),
    "availability-error": form("availability 500", {
      availability: { status: 500, body: { ok: false, reason: "internal_error" } }
    }),
    "availability-empty": form("空き枠ゼロ", {
      availability: availability.ok ? { body: { ...availability, slots: [] } } : base.availability
    }),
    "line-logged-out": form("LINE 未認証 (LIFF loggedIn=false)", {}, { loggedIn: false, inClient: false }),
    "dup-soft": form("重複 soft: 24h より先の既存予約 1 件", {
      gate: { body: gateBody({ upcomingReservations: [upcoming(now, 72, "confirmed")] }) }
    }),
    "dup-hard": form("重複 hard: 24h 以内に確定済み予約", {
      gate: { body: gateBody({ upcomingReservations: [upcoming(now, 12, "confirmed")] }) }
    }),
    "dup-hard-pending": form("重複 hard: 24h 以内に承認待ち申し込み", {
      gate: { body: gateBody({ upcomingReservations: [upcoming(now, 12, "pending_approval")] }) }
    }),
    cap: form("予約上限到達 (cap=1・既存 1 件)", {
      options: {
        body: optionsBody({
          stores: optionsBody().stores.map((store) => ({ ...store, maxActiveReservationsPerCustomer: 1 }))
        })
      },
      gate: { body: gateBody({ upcomingReservations: [upcoming(now, 72, "confirmed")] }) }
    }),
    "submit-success": form("送信成功 (確認パネル → 完了パネルまで到達可能)"),
    "my-loading": my("確認ページ: 読込中 (応答保留)", { delayMs: 600_000 }),
    "my-error": my("確認ページ: エラー", { status: 500, body: { ok: false, reason: "internal_error" } }),
    "my-empty": my("確認ページ: 予約なし", { body: myBody([]) }),
    "my-pending": my("確認ページ: 承認待ち 1 件", { body: myBody([reservation(now, "rsv-1", "pending_approval")]) }),
    "my-confirmed": my("確認ページ: 確定 1 件", { body: myBody([reservation(now, "rsv-2", "confirmed")]) })
  };
};
