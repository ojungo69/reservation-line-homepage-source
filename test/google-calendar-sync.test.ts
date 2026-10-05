import { readFileSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/sentry-helpers", () => ({
  safeCaptureException: vi.fn(),
  captureBatchWriteFailure: vi.fn(),
  dropSdkWorkflowEvent: vi.fn()
}));

import {
  createServiceAccountAccessToken,
  getCachedServiceAccountAccessToken
} from "../src/google/service-account";
import { safeCaptureException } from "../src/sentry-helpers";
import {
  processDueCalendarSyncJobs,
  sanitizeCustomerNameForCalendarSummary,
  sanitizeServiceNamesForCalendarSummary
} from "../src/google/calendar-sync";
import { expirePendingReservations } from "../src/reservations/expiration";
import { createPublicReservation, type PublicReservationRequest } from "../src/reservations/public-submit";
import { createMigratedSqliteD1, type SqliteD1Database } from "./helpers/sqlite-d1";

const SUBMIT_NOW_MS = Date.parse("2026-05-09T23:00:00.000Z");
const ACTIVE_SYNC_NOW_MS = Date.parse("2026-05-09T23:10:00.000Z");
const EXPIRED_SYNC_NOW_MS = Date.parse("2026-05-11T00:00:00.000Z");

describe("Google Calendar outbound sync", () => {
  let d1: SqliteD1Database;

  beforeEach(() => {
    vi.clearAllMocks();
    d1 = createMigratedSqliteD1();
  });

  afterEach(() => {
    d1.sqlite.close();
  });

  const createRequest = (): PublicReservationRequest => ({
    idempotencyKey: "public_submit_google_1",
    storeId: "kyoto",
    serviceId: "service_kyoto_default_60",
    resourceId: "resource_kyoto_calendar",
    startAt: "2026-06-01T01:00:00.000Z",
    customer: {
      displayName: "予約 太郎",
      displayNameKana: "ヨヤク タロウ",
      phone: "075-123-4567"
    },
    consents: {
      noticeVersion: "notice-terms-2026-06",
      cancellationPolicyVersion: "cancel-2026-08-31",
      privacyPolicyVersion: "privacy-2026-06"
    }
  });

  const createReservationWithGoogleJob = async () => {
    const result = await createPublicReservation({
      db: d1 as unknown as D1Database,
      request: createRequest(),
      line: {
        lineUserId: "line_user_1",
        channelId: "line_channel_id"
      },
      now: () => SUBMIT_NOW_MS
    });
    if (!result.ok) {
      throw new Error(result.reason);
    }
    return result.reservationId;
  };

  // Cancels the reservation and queues a single delete job for it. Pass
  // googleEvent to keep an id in D1; omit it for the NULL case that #563's
  // owner-marker lookup covers.
  const queueReservationDeleteJob = (
    reservationId: string,
    jobId: string,
    googleEvent?: { id: string; etag: string }
  ) => {
    d1.sqlite.prepare("DELETE FROM calendar_sync_jobs").run();
    d1.sqlite
      .prepare(
        `
          UPDATE reservations
          SET status = 'cancelled_by_admin',
              google_event_id = ?,
              google_event_etag = ?,
              google_sync_state = 'pending'
          WHERE id = ?
        `
      )
      .run(googleEvent?.id ?? null, googleEvent?.etag ?? null, reservationId);
    d1.sqlite
      .prepare(
        `
          INSERT INTO calendar_sync_jobs (
            id,
            dedupe_key,
            owner_type,
            owner_id,
            google_action,
            status,
            available_at
          ) VALUES (?, ?, 'reservation', ?, 'delete', 'queued', '2026-05-09T00:00:00.000Z')
        `
      )
      .run(jobId, `reservation:delete:${jobId}`, reservationId);
  };

  // Issue #560: when google_event_id is NULL, writeGoogleEvent first GETs events
  // filtered by privateExtendedProperty markers. Success mocks must answer that
  // list with empty items so the subsequent POST still runs.
  const googleUpsertFetchMock = (event: {
    id: string;
    etag?: string;
    updated?: string;
  }) =>
    vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "GET") {
        return Response.json({ items: [] });
      }
      return Response.json(event);
    }) as unknown as typeof fetch;

  const writeCall = (fetchMock: typeof fetch) => {
    const call = vi.mocked(fetchMock).mock.calls.find(([, init]) => {
      const method = init?.method ?? "GET";
      return method === "POST" || method === "PATCH";
    });
    return call ?? [];
  };

  it("inserts a safe Google event for queued reservation sync jobs and persists echo-suppression state", async () => {
    const reservationId = await createReservationWithGoogleJob();
    const fetchMock = googleUpsertFetchMock({
      id: "google_event_1",
      etag: "google_etag_1",
      updated: "2026-06-01T00:00:00.000Z"
    });

    const result = await processDueCalendarSyncJobs({
      db: d1 as unknown as D1Database,
      env: {
        GOOGLE_SERVICE_ACCOUNT_EMAIL: "calendar-sync@example.iam.gserviceaccount.com",
        GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "unused"
      },
      fetcher: fetchMock,
      accessTokenProvider: async () => "google_access_token",
      now: () => ACTIVE_SYNC_NOW_MS
    });

    expect(result).toEqual({
      processed: 1,
      succeeded: 1,
      failed: 0
    });
    // GET owner-marker lookup + POST create
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [url, init] = writeCall(fetchMock);
    expect(url).toBe("https://www.googleapis.com/calendar/v3/calendars/calendar-a%40example.invalid/events");
    expect(init?.method).toBe("POST");
    expect(init?.headers).toEqual({
      Authorization: "Bearer google_access_token",
      "Content-Type": "application/json"
    });

    const payload: {
      summary?: unknown;
      description?: unknown;
      location?: unknown;
      attendees?: unknown;
    } = await new Response(init?.body).json();
    const visiblePayloadText = [
      payload.summary,
      payload.description,
      payload.location,
      JSON.stringify(payload.attendees ?? "")
    ]
      .map((value) => (typeof value === "string" ? value : ""))
      .join("\n");
    // 氏名は意図的に summary へ含める (業務要件: staff が Google Calendar で
    // 予約状況を確認するため)。電話番号・カナ・phone_hash 等の他 PII は引き続き禁止。
    expect(visiblePayloadText).not.toContain("075");
    expect(visiblePayloadText).not.toContain("123-4567");
    expect(visiblePayloadText).not.toContain("ヨヤク タロウ");
    expect(payload).toMatchObject({
      // 初回利用客 (有効来店歴ゼロ) の予約は `新規予約 | ...` プレフィックス。
      // タイトルの先頭セグメントは「新規かどうか」だけで決まり、承認待ち/確定では変わらない。
      // Category prefix stripped (マッサージ｜); duration suffix kept.
      summary: "新規予約 | サンプル 04 | 予約 太郎",
      visibility: "private",
      transparency: "opaque",
      extendedProperties: {
        private: {
          app: "reservation-line-homepage",
          owner_type: "reservation",
          reservation_id: reservationId,
          store_id: "kyoto"
        }
      }
    });

    const reservation = d1.sqlite
      .prepare("SELECT google_event_id, google_event_etag, google_sync_state FROM reservations WHERE id = ?")
      .get(reservationId) as { google_event_id: string; google_event_etag: string; google_sync_state: string };
    expect(reservation).toEqual({
      google_event_id: "google_event_1",
      google_event_etag: "google_etag_1",
      google_sync_state: "synced"
    });
    const eventCount = d1.sqlite
      .prepare("SELECT COUNT(*) AS count FROM google_calendar_events WHERE reservation_id = ?")
      .get(reservationId) as { count: number };
    expect(eventCount.count).toBe(1);
    const outboundCount = d1.sqlite
      .prepare("SELECT COUNT(*) AS count FROM google_calendar_outbound_writes WHERE owner_id = ?")
      .get(reservationId) as { count: number };
    expect(outboundCount.count).toBe(1);
  });

  describe("sanitizeServiceNamesForCalendarSummary", () => {
    it.each([
      ["脱毛｜A 60分", "A 60分"],
      ["メンズ｜A 60分", "メンズ｜A 60分"],
      ["脱毛｜A 60分 / メンズ｜B 30分", "A 60分 / メンズ｜B 30分"],
      ["カテゴリ無しメニュー 45分", "カテゴリ無しメニュー 45分"],
      ["マッサージ｜サンプル 04", "サンプル 04"],
      ["メンズ｜サンプル 02", "メンズ｜サンプル 02"],
      [
        "マッサージ｜サンプル 04 / メンズ｜サンプル 02",
        "サンプル 04 / メンズ｜サンプル 02"
      ]
    ])("strips category prefixes for %s", (input, expected) => {
      expect(sanitizeServiceNamesForCalendarSummary(input)).toBe(expected);
    });

    it("returns メニュー未登録 for empty / null input", () => {
      expect(sanitizeServiceNamesForCalendarSummary(null)).toBe("メニュー未登録");
      expect(sanitizeServiceNamesForCalendarSummary("")).toBe("メニュー未登録");
      expect(sanitizeServiceNamesForCalendarSummary("   ")).toBe("メニュー未登録");
    });

    it("strips control characters before category handling", () => {
      expect(sanitizeServiceNamesForCalendarSummary("脱毛｜A\n 60分")).toBe("A 60分");
    });

    it("matches the shared display contract fixture (drift guard vs admin-app displayServiceName)", () => {
      const fixture = JSON.parse(
        readFileSync(new URL("./fixtures/service-display-cases.json", import.meta.url), "utf8")
      ) as { cases: Array<{ input: string; expected: string }> };
      expect(fixture.cases.length).toBeGreaterThan(0);
      for (const { input, expected } of fixture.cases) {
        expect(sanitizeServiceNamesForCalendarSummary(input)).toBe(expected);
      }
    });

    it("combines with 新規予約 prefix without breaking separators", () => {
      // Mirrors buildReservationCalendarEvent: 新規予約 | ${services} | ${customer}
      const services = sanitizeServiceNamesForCalendarSummary("脱毛｜A 60分");
      expect(`新規予約 | ${services} | 予約 太郎`).toBe("新規予約 | A 60分 | 予約 太郎");
      const mens = sanitizeServiceNamesForCalendarSummary("メンズ｜A 60分");
      expect(`新規予約 | ${mens} | 予約 太郎`).toBe("新規予約 | メンズ｜A 60分 | 予約 太郎");
      const multi = sanitizeServiceNamesForCalendarSummary("脱毛｜A 60分 / メンズ｜B 30分");
      expect(`新規予約 | ${multi} | 予約 太郎`).toBe(
        "新規予約 | A 60分 / メンズ｜B 30分 | 予約 太郎"
      );
    });
  });

  describe("sanitizeCustomerNameForCalendarSummary", () => {
    it.each([
      ["075-123-4567", "ご予約"],
      ["09012345678", "ご予約"],
      ["連絡先 090 1234 5678", "ご予約"],
      ["2026-05-17", "ご予約"],
      ["1990/03/15", "ご予約"],
      ["taro@example.com", "ご予約"],
      ["foo@bar", "ご予約"],
      // 全角数字 / 全角 dash / 全角 @ で迂回されない (NFKC + dash 正規化)。
      ["０９０１２３４５６７８", "ご予約"],
      ["０９０−１２３４−５６７８", "ご予約"],
      ["０７５‐１２３‐４５６７", "ご予約"],
      ["０７５ー１２３ー４５６７", "ご予約"],
      ["２０２６-０５-１７", "ご予約"],
      ["taro＠example.com", "ご予約"],
      // 括弧 / slash / dot / 空白 / 全角括弧 で区切られた phone は連続数字 8 桁以上で検出する。
      ["090(1234)5678", "ご予約"],
      ["０９０（１２３４）５６７８", "ご予約"],
      ["075/123/4567", "ご予約"],
      ["090 1234 5678", "ご予約"],
      ["090.1234.5678", "ご予約"],
      ["+81 90 1234 5678", "ご予約"],
      // 年月日表記 (ASCII / 全角) は date 扱い。
      ["1990年03月15日", "ご予約"],
      ["１９９０年０３月１５日", "ご予約"],
      ["1990年3月15日", "ご予約"],
      // ゼロ幅文字 (U+200B 等) で区切られた phone も検出する。
      ["090​1234​5678", "ご予約"]
    ])("returns ご予約 for PII-like input %s", (input, expected) => {
      expect(sanitizeCustomerNameForCalendarSummary(input)).toBe(expected);
    });

    it.each([
      [null, "氏名未登録"],
      ["", "氏名未登録"],
      ["   ", "氏名未登録"]
    ])("returns 氏名未登録 for empty input %s", (input, expected) => {
      expect(sanitizeCustomerNameForCalendarSummary(input)).toBe(expected);
    });

    it("strips control characters and newlines before returning the display name", () => {
      const polluted = "予約\n太郎\r\nDROP TABLE\x00\x07users";
      const sanitized = sanitizeCustomerNameForCalendarSummary(polluted);
      expect(sanitized).not.toMatch(/[\x00-\x1F\x7F]/);
      expect(sanitized).not.toContain("\n");
      expect(sanitized).not.toContain("\r");
      expect(sanitized).toBe("予約太郎DROP TABLEusers");
    });

    it("preserves benign Japanese names with spaces", () => {
      expect(sanitizeCustomerNameForCalendarSummary("予約 太郎")).toBe("予約 太郎");
      expect(sanitizeCustomerNameForCalendarSummary("山田 花子")).toBe("山田 花子");
    });
  });

  it("keeps the 新規予約 prefix for a first-time customer even once the reservation flips to confirmed", async () => {
    const reservationId = await createReservationWithGoogleJob();
    // Flip status to confirmed and re-enqueue the upsert job, mirroring the admin-approve flow.
    d1.sqlite
      .prepare("UPDATE reservations SET status = 'confirmed' WHERE id = ?")
      .run(reservationId);
    d1.sqlite
      .prepare(
        `INSERT INTO calendar_sync_jobs (id, dedupe_key, owner_type, owner_id, google_action, status, available_at)
         VALUES (?, ?, 'reservation', ?, 'upsert', 'queued', ?)`
      )
      .run(
        "job_confirmed_1",
        `reservation:${reservationId}:google:upsert:revision:confirmed`,
        reservationId,
        "2026-05-09T23:05:00.000Z"
      );
    d1.sqlite
      .prepare("UPDATE calendar_sync_jobs SET status = 'succeeded' WHERE owner_id = ? AND id != 'job_confirmed_1'")
      .run(reservationId);

    const fetchMock = googleUpsertFetchMock({
      id: "google_event_confirmed",
      etag: "google_etag_confirmed",
      updated: "2026-06-01T00:05:00.000Z"
    });

    const result = await processDueCalendarSyncJobs({
      db: d1 as unknown as D1Database,
      env: {
        GOOGLE_SERVICE_ACCOUNT_EMAIL: "calendar-sync@example.iam.gserviceaccount.com",
        GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "unused"
      },
      fetcher: fetchMock,
      accessTokenProvider: async () => "google_access_token",
      now: () => ACTIVE_SYNC_NOW_MS
    });

    expect(result.processed).toBe(1);
    expect(result.succeeded).toBe(1);
    const [, init] = writeCall(fetchMock);
    const payload: { summary?: unknown } = await new Response(init?.body).json();
    expect(payload.summary).toBe(
      "新規予約 | サンプル 04 | 予約 太郎"
    );
  });

  it("caps bulk-backfill jobs at 3 per run so regular sync jobs keep their slots", async () => {
    const reservationId = await createReservationWithGoogleJob();
    d1.sqlite
      .prepare("UPDATE reservations SET status = 'confirmed' WHERE id = ?")
      .run(reservationId);
    // Neutralize the submit-time job; this test seeds its own jobs below.
    d1.sqlite
      .prepare("UPDATE calendar_sync_jobs SET status = 'succeeded' WHERE owner_id = ?")
      .run(reservationId);

    // 4 bulk-backfill jobs all due BEFORE the regular job — the pile-up shape a
    // delayed cron firing or an overlapping backfill run-id produces. Without the
    // consumer-side cap they would fill the whole maxJobs=5 window first.
    const insertJob = d1.sqlite.prepare(
      `INSERT INTO calendar_sync_jobs (id, dedupe_key, owner_type, owner_id, google_action, status, available_at)
       VALUES (?, ?, 'reservation', ?, 'upsert', 'queued', ?)`
    );
    for (let i = 1; i <= 4; i += 1) {
      insertJob.run(
        `job_backfill_${i}`,
        `reservation:${reservationId}:google:upsert:revision:${i}:title-backfill-captest`,
        reservationId,
        `2026-05-09T23:0${i}:00.000Z`
      );
    }
    insertJob.run(
      "job_regular_1",
      `reservation:${reservationId}:google:upsert:revision:regular`,
      reservationId,
      "2026-05-09T23:06:00.000Z"
    );

    const fetchMock = googleUpsertFetchMock({
      id: "google_event_cap",
      etag: "google_etag_cap",
      updated: "2026-06-01T00:05:00.000Z"
    });

    const result = await processDueCalendarSyncJobs({
      db: d1 as unknown as D1Database,
      env: {
        GOOGLE_SERVICE_ACCOUNT_EMAIL: "calendar-sync@example.iam.gserviceaccount.com",
        GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "unused"
      },
      fetcher: fetchMock,
      accessTokenProvider: async () => "google_access_token",
      now: () => ACTIVE_SYNC_NOW_MS
    });

    // 3 backfill jobs + the regular job; the 4th backfill waits for the next run
    // even though a 5th loop slot was available.
    expect(result.processed).toBe(4);
    expect(result.succeeded).toBe(4);
    const jobs = d1.sqlite
      .prepare(
        "SELECT id, status FROM calendar_sync_jobs WHERE id LIKE 'job_%' ORDER BY id"
      )
      .all() as Array<{ id: string; status: string }>;
    expect(jobs).toEqual([
      { id: "job_backfill_1", status: "succeeded" },
      { id: "job_backfill_2", status: "succeeded" },
      { id: "job_backfill_3", status: "succeeded" },
      { id: "job_backfill_4", status: "queued" },
      { id: "job_regular_1", status: "succeeded" }
    ]);
  });

  it.each([
    // maxJobs=1 (smallest queue-kick batch): quota 0 — the regular job runs even
    // though older backfill jobs are due first.
    { maxJobs: 1, backfill: 2, regular: 1, expectBackfillDone: 0, expectRegularDone: 1 },
    // maxJobs=3: quota 1 — one backfill, and BOTH regular jobs keep their slots.
    { maxJobs: 3, backfill: 2, regular: 2, expectBackfillDone: 1, expectRegularDone: 2 }
  ])(
    "reserves regular slots when maxJobs is small (maxJobs=$maxJobs)",
    async ({ maxJobs, backfill, regular, expectBackfillDone, expectRegularDone }) => {
      const reservationId = await createReservationWithGoogleJob();
      d1.sqlite
        .prepare("UPDATE reservations SET status = 'confirmed' WHERE id = ?")
        .run(reservationId);
      d1.sqlite
        .prepare("UPDATE calendar_sync_jobs SET status = 'succeeded' WHERE owner_id = ?")
        .run(reservationId);
      const insertJob = d1.sqlite.prepare(
        `INSERT INTO calendar_sync_jobs (id, dedupe_key, owner_type, owner_id, google_action, status, available_at)
         VALUES (?, ?, 'reservation', ?, 'upsert', 'queued', ?)`
      );
      for (let i = 1; i <= backfill; i += 1) {
        insertJob.run(
          `job_backfill_${i}`,
          `reservation:${reservationId}:google:upsert:revision:${i}:title-backfill-smallrun`,
          reservationId,
          `2026-05-09T23:0${i}:00.000Z`
        );
      }
      for (let i = 1; i <= regular; i += 1) {
        insertJob.run(
          `job_regular_${i}`,
          `reservation:${reservationId}:google:upsert:revision:regular-${i}`,
          reservationId,
          `2026-05-09T23:0${backfill + i}:00.000Z`
        );
      }

      const fetchMock = googleUpsertFetchMock({
        id: "google_event_small",
        etag: "google_etag_small",
        updated: "2026-06-01T00:05:00.000Z"
      });

      const result = await processDueCalendarSyncJobs({
        db: d1 as unknown as D1Database,
        env: {
          GOOGLE_SERVICE_ACCOUNT_EMAIL: "calendar-sync@example.iam.gserviceaccount.com",
          GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "unused"
        },
        fetcher: fetchMock,
        accessTokenProvider: async () => "google_access_token",
        now: () => ACTIVE_SYNC_NOW_MS,
        maxJobs
      });

      expect(result.processed).toBe(expectBackfillDone + expectRegularDone);
      const done = (like: string) =>
        (
          d1.sqlite
            .prepare(
              "SELECT COUNT(*) AS n FROM calendar_sync_jobs WHERE id LIKE ? AND status = 'succeeded'"
            )
            .get(like) as { n: number }
        ).n;
      expect(done("job_backfill_%")).toBe(expectBackfillDone);
      expect(done("job_regular_%")).toBe(expectRegularDone);
    }
  );

  it("omits the 新規予約 prefix for a returning customer with a prior valid visit", async () => {
    const reservationId = await createReservationWithGoogleJob();
    // Seed a prior valid visit for this reservation's customer so the customer is
    // recognised as an existing (non-new) customer at calendar-write time.
    const { customer_id: customerId, store_id: storeId } = d1.sqlite
      .prepare("SELECT customer_id, store_id FROM reservations WHERE id = ?")
      .get(reservationId) as { customer_id: string; store_id: string };
    d1.sqlite
      .prepare(
        `INSERT INTO customer_visits (id, customer_id, reservation_id, store_id, visited_at, visit_source, status, recorded_by)
         VALUES (?, ?, NULL, ?, ?, 'manual_import', 'valid', 'test')`
      )
      .run("visit_prior_1", customerId, storeId, "2026-04-01T00:00:00.000Z");

    const fetchMock = googleUpsertFetchMock({
      id: "google_event_existing",
      etag: "google_etag_existing",
      updated: "2026-06-01T00:05:00.000Z"
    });

    const result = await processDueCalendarSyncJobs({
      db: d1 as unknown as D1Database,
      env: {
        GOOGLE_SERVICE_ACCOUNT_EMAIL: "calendar-sync@example.iam.gserviceaccount.com",
        GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "unused"
      },
      fetcher: fetchMock,
      accessTokenProvider: async () => "google_access_token",
      now: () => ACTIVE_SYNC_NOW_MS
    });

    expect(result.processed).toBe(1);
    expect(result.succeeded).toBe(1);
    const [, init] = writeCall(fetchMock);
    const payload: { summary?: unknown } = await new Response(init?.body).json();
    expect(payload.summary).toBe("サンプル 04 | 予約 太郎");
  });

  it("keeps the 新規予約 prefix when the customer's only prior visit was voided", async () => {
    const reservationId = await createReservationWithGoogleJob();
    const { customer_id: customerId, store_id: storeId } = d1.sqlite
      .prepare("SELECT customer_id, store_id FROM reservations WHERE id = ?")
      .get(reservationId) as { customer_id: string; store_id: string };
    d1.sqlite
      .prepare(
        `INSERT INTO customer_visits (id, customer_id, reservation_id, store_id, visited_at, visit_source, status, recorded_by, voided_by, voided_at, void_reason)
         VALUES (?, ?, NULL, ?, ?, 'manual_import', 'voided', 'test', 'admin_owner_1', '2026-04-02T00:00:00.000Z', 'reservation_corrected_to_no_show')`
      )
      .run("visit_voided_1", customerId, storeId, "2026-04-01T00:00:00.000Z");

    const fetchMock = googleUpsertFetchMock({
      id: "google_event_voided_visit",
      etag: "google_etag_voided_visit",
      updated: "2026-06-01T00:05:00.000Z"
    });

    const result = await processDueCalendarSyncJobs({
      db: d1 as unknown as D1Database,
      env: {
        GOOGLE_SERVICE_ACCOUNT_EMAIL: "calendar-sync@example.iam.gserviceaccount.com",
        GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "unused"
      },
      fetcher: fetchMock,
      accessTokenProvider: async () => "google_access_token",
      now: () => ACTIVE_SYNC_NOW_MS
    });

    expect(result.succeeded).toBe(1);
    const [, init] = writeCall(fetchMock);
    const payload: { summary?: unknown } = await new Response(init?.body).json();
    expect(payload.summary).toBe(
      "新規予約 | サンプル 04 | 予約 太郎"
    );
  });

  it("keeps the 新規予約 prefix when only THIS reservation's own completion visit exists (delayed/retry upsert)", async () => {
    const reservationId = await createReservationWithGoogleJob();
    // Simulate the reservation being completed (its own customer_visits row, with
    // reservation_id = this reservation) BEFORE a delayed/retry upsert job runs.
    // The first-time customer must still get the 新規予約 prefix — a customer's
    // own completion visit must not make their first booking look like a repeat.
    const { customer_id: customerId, store_id: storeId } = d1.sqlite
      .prepare("SELECT customer_id, store_id FROM reservations WHERE id = ?")
      .get(reservationId) as { customer_id: string; store_id: string };
    d1.sqlite
      .prepare(
        `INSERT INTO customer_visits (id, customer_id, reservation_id, store_id, visited_at, visit_source, status, recorded_by)
         VALUES (?, ?, ?, ?, ?, 'reservation_completed', 'valid', 'test')`
      )
      .run("visit_self_1", customerId, reservationId, storeId, "2026-05-31T02:00:00.000Z");

    const fetchMock = googleUpsertFetchMock({
      id: "google_event_self_visit",
      etag: "google_etag_self_visit",
      updated: "2026-06-01T00:05:00.000Z"
    });

    const result = await processDueCalendarSyncJobs({
      db: d1 as unknown as D1Database,
      env: {
        GOOGLE_SERVICE_ACCOUNT_EMAIL: "calendar-sync@example.iam.gserviceaccount.com",
        GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "unused"
      },
      fetcher: fetchMock,
      accessTokenProvider: async () => "google_access_token",
      now: () => ACTIVE_SYNC_NOW_MS
    });

    expect(result.processed).toBe(1);
    expect(result.succeeded).toBe(1);
    const [, init] = writeCall(fetchMock);
    const payload: { summary?: unknown } = await new Response(init?.body).json();
    expect(payload.summary).toBe(
      "新規予約 | サンプル 04 | 予約 太郎"
    );
  });

  it("does not write to Google Calendar when another worker claims the sync job first", async () => {
    const reservationId = await createReservationWithGoogleJob();
    const fetchMock = vi.fn(async () =>
      Response.json({
        id: "google_event_lost_claim",
        etag: "google_etag_lost_claim"
      })
    ) as unknown as typeof fetch;
    const accessTokenProvider = vi.fn(async () => "google_access_token");
    const claimLossDb = {
      prepare(sql: string) {
        const statement = (d1 as unknown as D1Database).prepare(sql);
        if (sql.includes("UPDATE calendar_sync_jobs") && sql.includes("SET status = 'processing'")) {
          return {
            bind(...values: unknown[]) {
              const bound = statement.bind(...values);
              return {
                async run() {
                  d1.sqlite
                    .prepare(
                      `
                        UPDATE calendar_sync_jobs
                        SET status = 'processing',
                            attempts = attempts + 1,
                            locked_until = '2026-05-09T23:20:00.000Z'
                        WHERE id = ?
                      `
                    )
                    .run(String(values[2]));
                  return bound.run();
                }
              } as unknown as D1PreparedStatement;
            }
          } as unknown as D1PreparedStatement;
        }
        return statement;
      },
      batch(statements: D1PreparedStatement[]) {
        return d1.batch(statements);
      }
    } as unknown as D1Database;

    const result = await processDueCalendarSyncJobs({
      db: claimLossDb,
      env: {
        GOOGLE_SERVICE_ACCOUNT_EMAIL: "calendar-sync@example.iam.gserviceaccount.com",
        GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "unused"
      },
      fetcher: fetchMock,
      accessTokenProvider,
      now: () => ACTIVE_SYNC_NOW_MS,
      maxJobs: 1
    });

    expect(result).toEqual({
      processed: 0,
      succeeded: 0,
      failed: 0
    });
    expect(accessTokenProvider).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    const reservation = d1.sqlite
      .prepare("SELECT google_event_id, google_sync_state FROM reservations WHERE id = ?")
      .get(reservationId) as { google_event_id: string | null; google_sync_state: string };
    expect(reservation).toEqual({
      google_event_id: null,
      google_sync_state: "pending"
    });
    const outboundCount = d1.sqlite
      .prepare("SELECT COUNT(*) AS count FROM google_calendar_outbound_writes WHERE owner_id = ?")
      .get(reservationId) as { count: number };
    expect(outboundCount.count).toBe(0);
  });

  it("does not persist Google write results when the processing claim is lost after provider success", async () => {
    const reservationId = await createReservationWithGoogleJob();
    const fetchMock = googleUpsertFetchMock({
      id: "google_event_stale_worker_1",
      etag: "google_etag_stale_worker_1"
    });
    const claimLossDb = {
      prepare: d1.prepare.bind(d1),
      batch: async (statements: D1PreparedStatement[]) => {
        d1.sqlite
          .prepare(
            `
              UPDATE calendar_sync_jobs
              SET status = 'queued',
                  locked_until = NULL,
                  available_at = '2026-05-09T23:10:00.001Z',
                  updated_at = '2026-05-09T23:10:00.001Z'
              WHERE owner_id = ?
                AND google_action = 'upsert'
            `
          )
          .run(reservationId);
        return d1.batch(statements);
      }
    } as unknown as D1Database;

    const result = await processDueCalendarSyncJobs({
      db: claimLossDb,
      env: {
        GOOGLE_SERVICE_ACCOUNT_EMAIL: "calendar-sync@example.iam.gserviceaccount.com",
        GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "unused"
      },
      fetcher: fetchMock,
      accessTokenProvider: async () => "google_access_token",
      now: () => ACTIVE_SYNC_NOW_MS,
      maxJobs: 1
    });

    expect(result).toEqual({
      processed: 1,
      succeeded: 0,
      failed: 0
    });
    // GET owner-marker lookup + POST create (persist is blocked by lost claim)
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const state = d1.sqlite
      .prepare(
        `
          SELECT
            (SELECT google_event_id FROM reservations WHERE id = ?) AS googleEventId,
            (SELECT google_sync_state FROM reservations WHERE id = ?) AS googleSyncState,
            (SELECT status FROM calendar_sync_jobs WHERE owner_id = ? AND google_action = 'upsert') AS jobStatus,
            (SELECT COUNT(*) FROM google_calendar_outbound_writes WHERE owner_id = ?) AS outboundCount,
            (SELECT COUNT(*) FROM audit_logs WHERE target_id = ? AND action = 'google_calendar_event_upserted') AS auditCount
        `
      )
      .get(reservationId, reservationId, reservationId, reservationId, reservationId) as {
      googleEventId: string | null;
      googleSyncState: string;
      jobStatus: string;
      outboundCount: number;
      auditCount: number;
    };
    expect(state).toEqual({
      googleEventId: null,
      googleSyncState: "pending",
      jobStatus: "queued",
      outboundCount: 0,
      auditCount: 0
    });
  });

  it("marks Google writes retryable when a successful response contains malformed JSON", async () => {
    const reservationId = await createReservationWithGoogleJob();
    const fetchMock = vi.fn(async () =>
      new Response("{", {
        status: 200,
        headers: {
          "Content-Type": "application/json"
        }
      })
    ) as unknown as typeof fetch;

    const result = await processDueCalendarSyncJobs({
      db: d1 as unknown as D1Database,
      env: {
        GOOGLE_SERVICE_ACCOUNT_EMAIL: "calendar-sync@example.iam.gserviceaccount.com",
        GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "unused"
      },
      fetcher: fetchMock,
      accessTokenProvider: async () => "google_access_token",
      now: () => ACTIVE_SYNC_NOW_MS,
      maxJobs: 1
    });

    expect(result).toEqual({
      processed: 1,
      succeeded: 0,
      failed: 1
    });
    const job = d1.sqlite
      .prepare("SELECT status, attempts, last_error FROM calendar_sync_jobs WHERE owner_id = ? AND google_action = 'upsert'")
      .get(reservationId) as { status: string; attempts: number; last_error: string };
    expect(job).toEqual({
      status: "retryable",
      attempts: 1,
      last_error: "invalid-google-response"
    });
    const reservation = d1.sqlite
      .prepare("SELECT google_event_id, google_sync_state FROM reservations WHERE id = ?")
      .get(reservationId) as { google_event_id: string | null; google_sync_state: string };
    expect(reservation).toEqual({
      google_event_id: null,
      google_sync_state: "pending"
    });
  });

  it("marks Google writes retryable when the outbound fetch throws (timeout)", async () => {
    // An outbound timeout aborts the fetch with a TimeoutError. writeGoogleEvent
    // must convert that throw into a retryable failure result so the claim is
    // released and attempts is incremented (instead of the throw escaping the
    // batch and leaving the claim hung on its locked_until TTL).
    const reservationId = await createReservationWithGoogleJob();
    const fetchMock = vi.fn(async () => {
      throw new DOMException("outbound_timeout:30000ms", "TimeoutError");
    }) as unknown as typeof fetch;

    const result = await processDueCalendarSyncJobs({
      db: d1 as unknown as D1Database,
      env: {
        GOOGLE_SERVICE_ACCOUNT_EMAIL: "calendar-sync@example.iam.gserviceaccount.com",
        GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "unused"
      },
      fetcher: fetchMock,
      accessTokenProvider: async () => "google_access_token",
      now: () => ACTIVE_SYNC_NOW_MS,
      maxJobs: 1
    });

    expect(result).toEqual({
      processed: 1,
      succeeded: 0,
      failed: 1
    });
    const job = d1.sqlite
      .prepare("SELECT status, attempts, last_error FROM calendar_sync_jobs WHERE owner_id = ? AND google_action = 'upsert'")
      .get(reservationId) as { status: string; attempts: number; last_error: string };
    expect(job).toEqual({
      status: "retryable",
      attempts: 1,
      last_error: "google-fetch-failed"
    });
  });

  it("auto-reclaims stale processing Google upsert jobs whose locked_until has expired (codex #9)", async () => {
    const reservationId = await createReservationWithGoogleJob();
    d1.sqlite
      .prepare(
        `
          UPDATE calendar_sync_jobs
          SET status = 'processing',
              attempts = 1,
              locked_until = '2026-05-09T23:09:00.000Z'
          WHERE owner_id = ?
            AND google_action = 'upsert'
        `
      )
      .run(reservationId);
    const fetchMock = googleUpsertFetchMock({
      id: "google_event_recovered_processing_1",
      etag: "google_etag_recovered_processing_1",
      updated: "2026-06-01T00:00:00.000Z"
    });

    const result = await processDueCalendarSyncJobs({
      db: d1 as unknown as D1Database,
      env: {
        GOOGLE_SERVICE_ACCOUNT_EMAIL: "calendar-sync@example.iam.gserviceaccount.com",
        GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "unused"
      },
      fetcher: fetchMock,
      accessTokenProvider: async () => "google_access_token",
      now: () => ACTIVE_SYNC_NOW_MS,
      maxJobs: 1
    });

    // The dequeue + claim now reclaim stale `status=processing AND locked_until<now`
    // rows (codex #9). attempts increments to 2, the upsert proceeds, and the job
    // finishes as `succeeded` instead of being orphaned for manual recovery.
    expect(result).toEqual({
      processed: 1,
      succeeded: 1,
      failed: 0
    });
    expect(fetchMock).toHaveBeenCalled();
    const job = d1.sqlite
      .prepare("SELECT status, attempts, locked_until, last_error FROM calendar_sync_jobs WHERE owner_id = ? AND google_action = 'upsert'")
      .get(reservationId) as {
      status: string;
      attempts: number;
      locked_until: string | null;
      last_error: string | null;
    };
    expect(job.status).toBe("succeeded");
    expect(job.attempts).toBe(2);
    expect(job.locked_until).toBeNull();
    expect(job.last_error).toBeNull();
    const reservation = d1.sqlite
      .prepare("SELECT google_event_id, google_sync_state FROM reservations WHERE id = ?")
      .get(reservationId) as { google_event_id: string | null; google_sync_state: string };
    expect(reservation.google_event_id).toBe("google_event_recovered_processing_1");
    expect(reservation.google_sync_state).toBe("synced");
  });

  it("reclaims stale processing upserts whose reservation already expired and supersedes the Google write (codex #9)", async () => {
    const reservationId = await createReservationWithGoogleJob();
    d1.sqlite
      .prepare(
        `
          UPDATE reservations
          SET status = 'expired',
              pending_expires_at = NULL,
              updated_at = '2026-05-11T00:00:00.000Z'
          WHERE id = ?
        `
      )
      .run(reservationId);
    d1.sqlite
      .prepare(
        `
          UPDATE calendar_sync_jobs
          SET status = 'processing',
              attempts = 1,
              locked_until = '2026-05-09T23:09:00.000Z'
          WHERE owner_id = ?
            AND google_action = 'upsert'
        `
      )
      .run(reservationId);
    const fetchMock = vi.fn(async () =>
      Response.json({
        id: "google_event_should_not_write_expired_processing",
        etag: "google_etag_should_not_write_expired_processing"
      })
    ) as unknown as typeof fetch;

    const result = await processDueCalendarSyncJobs({
      db: d1 as unknown as D1Database,
      env: {
        GOOGLE_SERVICE_ACCOUNT_EMAIL: "calendar-sync@example.iam.gserviceaccount.com",
        GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "unused"
      },
      fetcher: fetchMock,
      accessTokenProvider: async () => "google_access_token",
      now: () => ACTIVE_SYNC_NOW_MS,
      maxJobs: 1
    });

    // Stale `processing` upsert row is now reclaimed (codex #9). The pre-flight
    // `isReservationStillUpsertable` check in processGoogleWriteJob still detects the
    // expired reservation and supersedes the Google write — the fetch must not happen.
    expect(result).toEqual({
      processed: 1,
      succeeded: 1,
      failed: 0
    });
    expect(fetchMock).not.toHaveBeenCalled();
    const job = d1.sqlite
      .prepare("SELECT status, attempts, locked_until, last_error FROM calendar_sync_jobs WHERE owner_id = ? AND google_action = 'upsert'")
      .get(reservationId) as { status: string; attempts: number; locked_until: string | null; last_error: string | null };
    expect(job.status).toBe("succeeded");
    expect(job.attempts).toBe(2);
    expect(job.locked_until).toBeNull();
    expect(job.last_error).toBe("superseded_by_reservation_expiry");
  });

  it("dead-letters stale processing calendar sync jobs that already hit MAX_ATTEMPTS instead of reclaiming again (codex #9)", async () => {
    const reservationId = await createReservationWithGoogleJob();
    // attempts = 5 = MAX_ATTEMPTS. A worker crashed after markJobProcessing pushed
    // attempts to the cap. We must NOT reclaim and increment further — the row
    // must transition to `dead` with a diagnostic last_error so admins can audit.
    d1.sqlite
      .prepare(
        `
          UPDATE calendar_sync_jobs
          SET status = 'processing',
              attempts = 5,
              locked_until = '2026-05-09T23:09:00.000Z'
          WHERE owner_id = ?
            AND google_action = 'upsert'
        `
      )
      .run(reservationId);
    const fetchMock = vi.fn() as unknown as typeof fetch;

    const result = await processDueCalendarSyncJobs({
      db: d1 as unknown as D1Database,
      env: {
        GOOGLE_SERVICE_ACCOUNT_EMAIL: "calendar-sync@example.iam.gserviceaccount.com",
        GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "unused"
      },
      fetcher: fetchMock,
      accessTokenProvider: async () => "google_access_token",
      now: () => ACTIVE_SYNC_NOW_MS,
      maxJobs: 1
    });

    expect(result).toEqual({
      processed: 0,
      succeeded: 0,
      failed: 0
    });
    expect(fetchMock).not.toHaveBeenCalled();
    const job = d1.sqlite
      .prepare("SELECT status, attempts, locked_until, last_error FROM calendar_sync_jobs WHERE owner_id = ? AND google_action = 'upsert'")
      .get(reservationId) as { status: string; attempts: number; locked_until: string | null; last_error: string | null };
    expect(job.status).toBe("dead");
    expect(job.attempts).toBe(5);
    expect(job.locked_until).toBeNull();
    expect(job.last_error).toBe("exhausted_after_repeated_crash");
    // Crash-loop dead-lettering never reaches a per-job catch, so the sweep is
    // the sole capture point for these silent deaths.
    expect(safeCaptureException).toHaveBeenCalledTimes(1);
    expect(safeCaptureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: "calendar sync jobs dead-lettered after repeated crash: 1" }),
      expect.objectContaining({
        tags: { dispatcher: "google_calendar_sync", reason: "exhausted_after_repeated_crash" }
      })
    );
  });

  it("supersedes overdue pending Google upserts before writing an event", async () => {
    const reservationId = await createReservationWithGoogleJob();
    const fetchMock = vi.fn(async () =>
      Response.json({
        id: "google_event_should_not_write",
        etag: "google_etag_should_not_write",
        updated: "2026-06-01T00:00:00.000Z"
      })
    ) as unknown as typeof fetch;

    const result = await processDueCalendarSyncJobs({
      db: d1 as unknown as D1Database,
      env: {
        GOOGLE_SERVICE_ACCOUNT_EMAIL: "calendar-sync@example.iam.gserviceaccount.com",
        GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "unused"
      },
      fetcher: fetchMock,
      accessTokenProvider: async () => "google_access_token",
      now: () => EXPIRED_SYNC_NOW_MS
    });

    expect(result).toEqual({
      processed: 1,
      succeeded: 1,
      failed: 0
    });
    expect(fetchMock).not.toHaveBeenCalled();
    const job = d1.sqlite
      .prepare("SELECT status, last_error FROM calendar_sync_jobs WHERE owner_id = ?")
      .get(reservationId) as { status: string; last_error: string | null };
    expect(job).toEqual({
      status: "succeeded",
      last_error: "superseded_by_reservation_expiry"
    });
    const reservation = d1.sqlite
      .prepare("SELECT google_event_id, google_sync_state FROM reservations WHERE id = ?")
      .get(reservationId) as { google_event_id: string | null; google_sync_state: string };
    expect(reservation).toEqual({
      google_event_id: null,
      google_sync_state: "pending"
    });
  });

  it("queues a follow-up delete when an in-flight pending upsert expires before Google write persistence", async () => {
    const reservationId = await createReservationWithGoogleJob();
    let expiredDuringWrite = false;
    // Nested delete may run while D1 still has NULL google_event_id, so #563
    // issues an owner-marker GET. Only that GET is allowed — any mutation
    // would mean the nested pass wrote again for an expired reservation.
    const unexpectedNestedFetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "GET") {
        return Response.json({ items: [] });
      }
      throw new Error(`unexpected nested ${init?.method ?? "GET"} — only owner-marker GET is allowed`);
    }) as unknown as typeof fetch;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      // Owner-marker lookup must stay empty and must not fire the race side-effect.
      if ((init?.method ?? "GET") === "GET") {
        return Response.json({ items: [] });
      }
      if (!expiredDuringWrite) {
        expiredDuringWrite = true;
        await expirePendingReservations({
          db: d1 as unknown as D1Database,
          now: () => EXPIRED_SYNC_NOW_MS
        });
        await processDueCalendarSyncJobs({
          db: d1 as unknown as D1Database,
          env: {
            GOOGLE_SERVICE_ACCOUNT_EMAIL: "calendar-sync@example.iam.gserviceaccount.com",
            GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "unused"
          },
          fetcher: unexpectedNestedFetch,
          accessTokenProvider: async () => "google_access_token",
          now: () => EXPIRED_SYNC_NOW_MS,
          maxJobs: 1
        });
      }
      return Response.json({
        id: "google_event_expired_race_1",
        etag: "google_etag_expired_race_1",
        updated: "2026-06-01T00:00:00.000Z"
      });
    }) as unknown as typeof fetch;

    const result = await processDueCalendarSyncJobs({
      db: d1 as unknown as D1Database,
      env: {
        GOOGLE_SERVICE_ACCOUNT_EMAIL: "calendar-sync@example.iam.gserviceaccount.com",
        GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "unused"
      },
      fetcher: fetchMock,
      accessTokenProvider: async () => "google_access_token",
      now: () => ACTIVE_SYNC_NOW_MS,
      maxJobs: 1
    });

    expect(result).toEqual({
      processed: 1,
      succeeded: 1,
      failed: 0
    });
    // GET owner-marker lookup + POST create
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const reservation = d1.sqlite
      .prepare("SELECT status, google_event_id, google_sync_state FROM reservations WHERE id = ?")
      .get(reservationId) as { status: string; google_event_id: string | null; google_sync_state: string };
    expect(reservation).toEqual({
      status: "expired",
      google_event_id: "google_event_expired_race_1",
      google_sync_state: "pending"
    });
    expect(
      (
        d1.sqlite
          .prepare(
            "SELECT COUNT(*) AS count FROM calendar_sync_jobs WHERE owner_id = ? AND google_action = 'upsert' AND status = 'succeeded' AND last_error = 'superseded_by_reservation_expiry_after_google_write'"
          )
          .get(reservationId) as { count: number }
      ).count
    ).toBe(1);
    expect(
      (
        d1.sqlite
          .prepare(
            "SELECT COUNT(*) AS count FROM calendar_sync_jobs WHERE owner_id = ? AND google_action = 'delete' AND status = 'queued'"
          )
          .get(reservationId) as { count: number }
      ).count
    ).toBe(1);

    const deleteFetch = vi.fn(async () => new Response(null, { status: 204 })) as unknown as typeof fetch;
    const cleanup = await processDueCalendarSyncJobs({
      db: d1 as unknown as D1Database,
      env: {
        GOOGLE_SERVICE_ACCOUNT_EMAIL: "calendar-sync@example.iam.gserviceaccount.com",
        GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "unused"
      },
      fetcher: deleteFetch,
      accessTokenProvider: async () => "google_access_token",
      now: () => EXPIRED_SYNC_NOW_MS + 1_000,
      maxJobs: 1
    });

    expect(cleanup).toEqual({
      processed: 1,
      succeeded: 1,
      failed: 0
    });
    expect(deleteFetch).toHaveBeenCalledOnce();
    const [url, init] = vi.mocked(deleteFetch).mock.calls[0] ?? [];
    expect(url).toBe(
      "https://www.googleapis.com/calendar/v3/calendars/calendar-a%40example.invalid/events/google_event_expired_race_1?sendUpdates=none"
    );
    expect(init?.method).toBe("DELETE");
    const syncedReservation = d1.sqlite
      .prepare("SELECT google_event_id, google_sync_state FROM reservations WHERE id = ?")
      .get(reservationId) as { google_event_id: string | null; google_sync_state: string };
    expect(syncedReservation).toEqual({
      google_event_id: null,
      google_sync_state: "synced"
    });
    const event = d1.sqlite
      .prepare("SELECT status FROM google_calendar_events WHERE reservation_id = ? AND google_event_id = ?")
      .get(reservationId, "google_event_expired_race_1") as { status: string };
    expect(event.status).toBe("deleted");
  });

  it("queues stale cleanup when a pending upsert crosses expiry during the Google write", async () => {
    const reservationId = await createReservationWithGoogleJob();
    // processDueCalendarSyncJobs now invokes markStaleCalendarSyncClaimsExhausted
    // once before the loop, which consumes one `now()` call. The original two
    // ACTIVE returns are still required for the loop's nowMs and the
    // beforeWriteMs check; afterWriteMs onward must observe EXPIRED so the
    // post-write cleanup path queues the stale delete.
    const now = vi.fn()
      .mockReturnValueOnce(ACTIVE_SYNC_NOW_MS) // markStaleCalendarSyncClaimsExhausted (reaper sweep)
      .mockReturnValueOnce(ACTIVE_SYNC_NOW_MS) // loop nowMs
      .mockReturnValueOnce(ACTIVE_SYNC_NOW_MS) // beforeWriteMs (pre-flight check)
      .mockReturnValue(EXPIRED_SYNC_NOW_MS);   // afterWriteMs and all subsequent calls
    const fetchMock = googleUpsertFetchMock({
      id: "google_event_expired_after_write_1",
      etag: "google_etag_expired_after_write_1",
      updated: "2026-06-01T00:00:00.000Z"
    });

    const result = await processDueCalendarSyncJobs({
      db: d1 as unknown as D1Database,
      env: {
        GOOGLE_SERVICE_ACCOUNT_EMAIL: "calendar-sync@example.iam.gserviceaccount.com",
        GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "unused"
      },
      fetcher: fetchMock,
      accessTokenProvider: async () => "google_access_token",
      now,
      maxJobs: 1
    });

    expect(result).toEqual({
      processed: 1,
      succeeded: 1,
      failed: 0
    });
    // GET owner-marker lookup + POST create
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const reservation = d1.sqlite
      .prepare("SELECT status, google_event_id, google_sync_state FROM reservations WHERE id = ?")
      .get(reservationId) as { status: string; google_event_id: string | null; google_sync_state: string };
    expect(reservation).toEqual({
      status: "pending_approval",
      google_event_id: "google_event_expired_after_write_1",
      google_sync_state: "pending"
    });
    expect(
      (
        d1.sqlite
          .prepare(
            "SELECT COUNT(*) AS count FROM calendar_sync_jobs WHERE owner_id = ? AND google_action = 'upsert' AND status = 'succeeded' AND last_error = 'superseded_by_reservation_expiry_after_google_write'"
          )
          .get(reservationId) as { count: number }
      ).count
    ).toBe(1);
    expect(
      (
        d1.sqlite
          .prepare("SELECT COUNT(*) AS count FROM calendar_sync_jobs WHERE owner_id = ? AND google_action = 'delete' AND status = 'queued'")
          .get(reservationId) as { count: number }
      ).count
    ).toBe(1);
  });

  it("keeps Google event state when an in-flight confirmed upsert becomes completed before persistence", async () => {
    const reservationId = await createReservationWithGoogleJob();
    d1.sqlite
      .prepare(
        `
          UPDATE reservations
          SET status = 'confirmed',
              pending_expires_at = NULL
          WHERE id = ?
        `
      )
      .run(reservationId);
    let completedDuringWrite = false;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "GET") {
        return Response.json({ items: [] });
      }
      if (!completedDuringWrite) {
        completedDuringWrite = true;
        d1.sqlite
          .prepare(
            `
              UPDATE reservations
              SET status = 'completed',
                  completed_at = '2026-06-01T02:00:00.000Z',
                  updated_at = '2026-06-01T02:00:00.000Z'
              WHERE id = ?
            `
          )
          .run(reservationId);
      }
      return Response.json({
        id: "google_event_completed_race_1",
        etag: "google_etag_completed_race_1",
        updated: "2026-06-01T00:00:00.000Z"
      });
    }) as unknown as typeof fetch;

    const result = await processDueCalendarSyncJobs({
      db: d1 as unknown as D1Database,
      env: {
        GOOGLE_SERVICE_ACCOUNT_EMAIL: "calendar-sync@example.iam.gserviceaccount.com",
        GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "unused"
      },
      fetcher: fetchMock,
      accessTokenProvider: async () => "google_access_token",
      now: () => ACTIVE_SYNC_NOW_MS,
      maxJobs: 1
    });

    expect(result).toEqual({
      processed: 1,
      succeeded: 1,
      failed: 0
    });
    // GET owner-marker lookup + POST create
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const reservation = d1.sqlite
      .prepare("SELECT status, google_event_id, google_event_etag, google_sync_state FROM reservations WHERE id = ?")
      .get(reservationId) as {
      status: string;
      google_event_id: string | null;
      google_event_etag: string | null;
      google_sync_state: string;
    };
    expect(reservation).toEqual({
      status: "completed",
      google_event_id: "google_event_completed_race_1",
      google_event_etag: "google_etag_completed_race_1",
      google_sync_state: "synced"
    });
    const job = d1.sqlite
      .prepare("SELECT status, last_error FROM calendar_sync_jobs WHERE owner_id = ? AND google_action = 'upsert'")
      .get(reservationId) as { status: string; last_error: string | null };
    expect(job).toEqual({
      status: "succeeded",
      last_error: null
    });
    expect(
      (
        d1.sqlite
          .prepare("SELECT COUNT(*) AS count FROM calendar_sync_jobs WHERE owner_id = ? AND google_action = 'delete'")
          .get(reservationId) as { count: number }
      ).count
    ).toBe(0);
  });

  it("supersedes in-flight pending upserts that fail after the reservation expires", async () => {
    const reservationId = await createReservationWithGoogleJob();
    let expiredDuringWrite = false;
    const fetchMock = vi.fn(async () => {
      if (!expiredDuringWrite) {
        expiredDuringWrite = true;
        await expirePendingReservations({
          db: d1 as unknown as D1Database,
          now: () => EXPIRED_SYNC_NOW_MS
        });
      }
      return Response.json({ error: { message: "temporary outage" } }, { status: 500 });
    }) as unknown as typeof fetch;

    const result = await processDueCalendarSyncJobs({
      db: d1 as unknown as D1Database,
      env: {
        GOOGLE_SERVICE_ACCOUNT_EMAIL: "calendar-sync@example.iam.gserviceaccount.com",
        GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "unused"
      },
      fetcher: fetchMock,
      accessTokenProvider: async () => "google_access_token",
      now: () => ACTIVE_SYNC_NOW_MS,
      maxJobs: 1
    });

    expect(result).toEqual({
      processed: 1,
      succeeded: 1,
      failed: 0
    });
    const upsertJob = d1.sqlite
      .prepare("SELECT status, last_error FROM calendar_sync_jobs WHERE owner_id = ? AND google_action = 'upsert'")
      .get(reservationId) as { status: string; last_error: string | null };
    expect(upsertJob).toEqual({
      status: "succeeded",
      last_error: "superseded_by_reservation_expiry"
    });
    expect(
      (
        d1.sqlite
          .prepare("SELECT COUNT(*) AS count FROM calendar_sync_jobs WHERE owner_id = ? AND google_action = 'delete' AND status = 'queued'")
          .get(reservationId) as { count: number }
      ).count
    ).toBe(1);
  });

  it("retries completed reservation upserts after a transient Google failure", async () => {
    const reservationId = await createReservationWithGoogleJob();
    d1.sqlite
      .prepare(
        `
          UPDATE reservations
          SET status = 'confirmed',
              pending_expires_at = NULL
          WHERE id = ?
        `
      )
      .run(reservationId);
    let completedDuringWrite = false;
    // Fail the owner-marker lookup (or the subsequent write) with 500 while
    // flipping the reservation to completed mid-flight — same race shape as
    // before #560, just with the extra GET when google_event_id is NULL.
    const firstFetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (!completedDuringWrite) {
        completedDuringWrite = true;
        d1.sqlite
          .prepare(
            `
              UPDATE reservations
              SET status = 'completed',
                  completed_at = '2026-06-01T02:00:00.000Z',
                  updated_at = '2026-06-01T02:00:00.000Z'
              WHERE id = ?
            `
          )
          .run(reservationId);
      }
      if ((init?.method ?? "GET") === "GET") {
        return Response.json({ items: [] });
      }
      return Response.json({ error: { message: "temporary outage" } }, { status: 500 });
    }) as unknown as typeof fetch;

    const first = await processDueCalendarSyncJobs({
      db: d1 as unknown as D1Database,
      env: {
        GOOGLE_SERVICE_ACCOUNT_EMAIL: "calendar-sync@example.iam.gserviceaccount.com",
        GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "unused"
      },
      fetcher: firstFetch,
      accessTokenProvider: async () => "google_access_token",
      now: () => ACTIVE_SYNC_NOW_MS,
      maxJobs: 1
    });

    expect(first).toEqual({
      processed: 1,
      succeeded: 0,
      failed: 1
    });
    const retryableJob = d1.sqlite
      .prepare("SELECT status, attempts, last_error FROM calendar_sync_jobs WHERE owner_id = ? AND google_action = 'upsert'")
      .get(reservationId) as { status: string; attempts: number; last_error: string | null };
    expect(retryableJob).toEqual({
      status: "retryable",
      attempts: 1,
      last_error: "google-http-500"
    });

    const secondFetch = googleUpsertFetchMock({
      id: "google_event_completed_retry_1",
      etag: "google_etag_completed_retry_1",
      updated: "2026-06-01T00:00:00.000Z"
    });
    const second = await processDueCalendarSyncJobs({
      db: d1 as unknown as D1Database,
      env: {
        GOOGLE_SERVICE_ACCOUNT_EMAIL: "calendar-sync@example.iam.gserviceaccount.com",
        GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "unused"
      },
      fetcher: secondFetch,
      accessTokenProvider: async () => "google_access_token",
      now: () => ACTIVE_SYNC_NOW_MS + 3 * 60_000,
      maxJobs: 1
    });

    expect(second).toEqual({
      processed: 1,
      succeeded: 1,
      failed: 0
    });
    // GET owner-marker lookup + POST create (google_event_id still NULL after first fail)
    expect(secondFetch).toHaveBeenCalledTimes(2);
    const reservation = d1.sqlite
      .prepare("SELECT status, google_event_id, google_sync_state FROM reservations WHERE id = ?")
      .get(reservationId) as { status: string; google_event_id: string | null; google_sync_state: string };
    expect(reservation).toEqual({
      status: "completed",
      google_event_id: "google_event_completed_retry_1",
      google_sync_state: "synced"
    });
  });

  it("recreates active admin external blocks with a safe Google event and persists echo-suppression state", async () => {
    d1.sqlite
      .prepare(
        `
          INSERT INTO external_blocks (
            id,
            store_id,
            resource_id,
            source,
            title_snapshot,
            start_at,
            end_at,
            status,
            created_by
          ) VALUES (
            'external_block_recreate_1',
            'kyoto',
            'resource_kyoto_calendar',
            'admin_block',
            '管理画面ブロック 個人名',
            '2026-06-01T03:00:00.000Z',
            '2026-06-01T04:00:00.000Z',
            'active',
            'admin_owner_1'
          )
        `
      )
      .run();
    d1.sqlite
      .prepare(
        `
          INSERT INTO calendar_sync_jobs (
            id,
            dedupe_key,
            owner_type,
            owner_id,
            google_action,
            status,
            available_at
          ) VALUES (
            'calendar_external_block_recreate_job_1',
            'external_block:external_block_recreate_1:google:upsert:test',
            'external_block',
            'external_block_recreate_1',
            'upsert',
            'queued',
            '2026-05-09T00:00:00.000Z'
          )
        `
      )
      .run();
    const fetchMock = googleUpsertFetchMock({
      id: "google_external_block_recreated_1",
      etag: "google_external_block_etag_1",
      updated: "2026-06-01T00:00:00.000Z"
    });

    const result = await processDueCalendarSyncJobs({
      db: d1 as unknown as D1Database,
      env: {
        GOOGLE_SERVICE_ACCOUNT_EMAIL: "calendar-sync@example.iam.gserviceaccount.com",
        GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "unused"
      },
      fetcher: fetchMock,
      accessTokenProvider: async () => "google_access_token",
      now: () => ACTIVE_SYNC_NOW_MS
    });

    expect(result).toEqual({
      processed: 1,
      succeeded: 1,
      failed: 0
    });
    const [url, init] = writeCall(fetchMock);
    expect(url).toBe("https://www.googleapis.com/calendar/v3/calendars/calendar-a%40example.invalid/events");
    expect(init?.method).toBe("POST");
    const payloadText = String(init?.body);
    expect(payloadText).not.toContain("個人名");
    await expect(new Response(init?.body).json()).resolves.toMatchObject({
      summary: "Example Studio ブロック",
      visibility: "private",
      transparency: "opaque",
      extendedProperties: {
        private: {
          app: "reservation-line-homepage",
          owner_type: "external_block",
          external_block_id: "external_block_recreate_1",
          store_id: "kyoto"
        }
      }
    });

    const block = d1.sqlite
      .prepare("SELECT google_event_id, google_event_etag FROM external_blocks WHERE id = 'external_block_recreate_1'")
      .get() as { google_event_id: string; google_event_etag: string };
    expect(block).toEqual({
      google_event_id: "google_external_block_recreated_1",
      google_event_etag: "google_external_block_etag_1"
    });
    const eventCount = d1.sqlite
      .prepare("SELECT COUNT(*) AS count FROM google_calendar_events WHERE external_block_id = 'external_block_recreate_1' AND source_type = 'external_block'")
      .get() as { count: number };
    const outbound = d1.sqlite
      .prepare("SELECT owner_type, action FROM google_calendar_outbound_writes WHERE owner_id = 'external_block_recreate_1'")
      .get() as { owner_type: string; action: string };
    expect(eventCount.count).toBe(1);
    expect(outbound).toEqual({
      owner_type: "external_block",
      action: "upsert"
    });
  });

  it.each([403, 429])("backs off Google sync HTTP %i failures without storing access tokens", async (status) => {
    await createReservationWithGoogleJob();
    const fetchMock = vi.fn(async () => Response.json({ error: { message: "quota exceeded" } }, { status })) as unknown as typeof fetch;

    const result = await processDueCalendarSyncJobs({
      db: d1 as unknown as D1Database,
      env: {
        GOOGLE_SERVICE_ACCOUNT_EMAIL: "calendar-sync@example.iam.gserviceaccount.com",
        GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "unused"
      },
      fetcher: fetchMock,
      accessTokenProvider: async () => "secret_access_token",
      now: () => ACTIVE_SYNC_NOW_MS
    });

    expect(result).toEqual({
      processed: 1,
      succeeded: 0,
      failed: 1
    });
    const job = d1.sqlite
      .prepare("SELECT status, attempts, available_at, last_error FROM calendar_sync_jobs LIMIT 1")
      .get() as { status: string; attempts: number; available_at: string; last_error: string };
    expect(job.status).toBe("retryable");
    expect(job.attempts).toBe(1);
    expect(Date.parse(job.available_at)).toBeGreaterThanOrEqual(ACTIVE_SYNC_NOW_MS + 60_000);
    expect(Date.parse(job.available_at)).toBeLessThan(ACTIVE_SYNC_NOW_MS + 2 * 60_000);
    expect(job.last_error).toBe(`google-http-${status}`);
    expect(job.last_error).not.toContain("secret_access_token");
  });

  it("keeps dead Google sync jobs and last_error in D1 after final retry failure", async () => {
    await createReservationWithGoogleJob();
    d1.sqlite.prepare("UPDATE calendar_sync_jobs SET attempts = 4").run();
    const fetchMock = vi.fn(async () => Response.json({ error: { message: "quota exceeded" } }, { status: 500 })) as unknown as typeof fetch;

    const result = await processDueCalendarSyncJobs({
      db: d1 as unknown as D1Database,
      env: {
        GOOGLE_SERVICE_ACCOUNT_EMAIL: "calendar-sync@example.iam.gserviceaccount.com",
        GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "unused"
      },
      fetcher: fetchMock,
      accessTokenProvider: async () => "secret_access_token",
      now: () => ACTIVE_SYNC_NOW_MS
    });

    expect(result).toEqual({
      processed: 1,
      succeeded: 0,
      failed: 1
    });
    const job = d1.sqlite
      .prepare("SELECT status, attempts, last_error FROM calendar_sync_jobs LIMIT 1")
      .get() as { status: string; attempts: number; last_error: string };
    expect(job).toEqual({
      status: "dead",
      attempts: 5,
      last_error: "google-http-500"
    });
    expect(job.last_error).not.toContain("secret_access_token");
    // The processor is the sole Sentry owner for calendar job failures (the
    // workflow captures nothing): exactly one capture, on the dead transition.
    expect(safeCaptureException).toHaveBeenCalledTimes(1);
    expect(safeCaptureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: "calendar sync job failed permanently: google-http-500" }),
      expect.objectContaining({
        tags: { dispatcher: "google_calendar_sync", reason: "google-http-500" }
      })
    );
  });

  it("does not capture when a raced claim loses the markJobFailure CAS on the dead attempt", async () => {
    await createReservationWithGoogleJob();
    d1.sqlite.prepare("UPDATE calendar_sync_jobs SET attempts = 4").run();
    // Simulate a rival worker re-claiming the row mid-write: the fetch mock
    // bumps locked_until, so this worker's markJobFailure CAS matches 0 rows.
    // The dead-transition capture must then NOT fire — the rival claim owns
    // the job's outcome (and its capture) now.
    const fetchMock = vi.fn(async () => {
      d1.sqlite
        .prepare("UPDATE calendar_sync_jobs SET locked_until = '2026-05-09T23:59:00.000Z'")
        .run();
      return Response.json({ error: { message: "quota exceeded" } }, { status: 500 });
    }) as unknown as typeof fetch;

    const result = await processDueCalendarSyncJobs({
      db: d1 as unknown as D1Database,
      env: {
        GOOGLE_SERVICE_ACCOUNT_EMAIL: "calendar-sync@example.iam.gserviceaccount.com",
        GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "unused"
      },
      fetcher: fetchMock,
      accessTokenProvider: async () => "google_access_token",
      now: () => ACTIVE_SYNC_NOW_MS
    });

    expect(result.failed).toBe(0);
    const job = d1.sqlite
      .prepare("SELECT status FROM calendar_sync_jobs LIMIT 1")
      .get() as { status: string };
    expect(job.status).toBe("processing");
    expect(safeCaptureException).not.toHaveBeenCalled();
  });

  it("deletes Google reservation events only after D1 has cancelled the reservation", async () => {
    const reservationId = await createReservationWithGoogleJob();
    d1.sqlite
      .prepare(
        `
          UPDATE reservations
          SET status = 'cancelled_by_admin',
              google_event_id = 'google_event_cancelled_1',
              google_event_etag = 'google_etag_cancelled_1',
              google_sync_state = 'pending',
              version = version + 1
          WHERE id = ?
        `
      )
      .run(reservationId);
    d1.sqlite
      .prepare(
        `
          INSERT INTO google_calendar_events (
            id,
            store_id,
            calendar_id,
            google_event_id,
            reservation_id,
            google_etag,
            google_updated_at,
            source_type,
            status,
            google_safe_snapshot_json
          ) VALUES (
            'google_calendar_event_cancelled_1',
            'kyoto',
            'calendar-a@example.invalid',
            'google_event_cancelled_1',
            ?,
            'google_etag_cancelled_1',
            '2026-06-01T00:00:00.000Z',
            'reservation',
            'active',
            '{}'
          )
        `
      )
      .run(reservationId);
    d1.sqlite
      .prepare(
        `
          INSERT INTO calendar_sync_jobs (
            id,
            dedupe_key,
            owner_type,
            owner_id,
            google_action,
            status,
            available_at
          ) VALUES (
            'calendar_delete_job_1',
            'reservation:delete:calendar_delete_job_1',
            'reservation',
            ?,
            'delete',
            'queued',
            '2026-05-09T00:00:00.000Z'
          )
        `
      )
      .run(reservationId);
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 })) as unknown as typeof fetch;

    const result = await processDueCalendarSyncJobs({
      db: d1 as unknown as D1Database,
      env: {
        GOOGLE_SERVICE_ACCOUNT_EMAIL: "calendar-sync@example.iam.gserviceaccount.com",
        GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "unused"
      },
      fetcher: fetchMock,
      accessTokenProvider: async () => "google_access_token",
      now: () => ACTIVE_SYNC_NOW_MS
    });

    expect(result).toEqual({
      processed: 2,
      succeeded: 2,
      failed: 0
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = vi.mocked(fetchMock).mock.calls[0] ?? [];
    expect(url).toBe(
      "https://www.googleapis.com/calendar/v3/calendars/calendar-a%40example.invalid/events/google_event_cancelled_1?sendUpdates=none"
    );
    expect(init?.method).toBe("DELETE");
    expect(init?.headers).toEqual({
      Authorization: "Bearer google_access_token"
    });
    expect(init?.body).toBeUndefined();

    const reservation = d1.sqlite
      .prepare("SELECT google_event_id, google_event_etag, google_sync_state FROM reservations WHERE id = ?")
      .get(reservationId) as { google_event_id: string | null; google_event_etag: string | null; google_sync_state: string };
    expect(reservation).toEqual({
      google_event_id: null,
      google_event_etag: null,
      google_sync_state: "synced"
    });
    const event = d1.sqlite
      .prepare("SELECT status FROM google_calendar_events WHERE reservation_id = ?")
      .get(reservationId) as { status: string };
    expect(event.status).toBe("deleted");
    const outbound = d1.sqlite
      .prepare("SELECT action FROM google_calendar_outbound_writes WHERE owner_id = ?")
      .get(reservationId) as { action: string };
    expect(outbound.action).toBe("delete");
  });

  it("does not delete Google reservation events while the D1 reservation is still active", async () => {
    const reservationId = await createReservationWithGoogleJob();
    d1.sqlite.prepare("DELETE FROM calendar_sync_jobs").run();
    d1.sqlite
      .prepare(
        `
          UPDATE reservations
          SET status = 'confirmed',
              google_event_id = 'google_event_active_1',
              google_event_etag = 'google_etag_active_1'
          WHERE id = ?
        `
      )
      .run(reservationId);
    d1.sqlite
      .prepare(
        `
          INSERT INTO calendar_sync_jobs (
            id,
            dedupe_key,
            owner_type,
            owner_id,
            google_action,
            status,
            available_at
          ) VALUES (
            'calendar_delete_job_active_1',
            'reservation:delete:calendar_delete_job_active_1',
            'reservation',
            ?,
            'delete',
            'queued',
            '2026-05-09T00:00:00.000Z'
          )
        `
      )
      .run(reservationId);
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 })) as unknown as typeof fetch;

    const result = await processDueCalendarSyncJobs({
      db: d1 as unknown as D1Database,
      env: {
        GOOGLE_SERVICE_ACCOUNT_EMAIL: "calendar-sync@example.iam.gserviceaccount.com",
        GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "unused"
      },
      fetcher: fetchMock,
      accessTokenProvider: async () => "google_access_token",
      now: () => ACTIVE_SYNC_NOW_MS
    });

    expect(result).toEqual({
      processed: 0,
      succeeded: 0,
      failed: 0
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("marks delete jobs succeeded without a Google DELETE when owner-marker lookup finds no event", async () => {
    // #563: google_event_id NULL no longer skips Google entirely — we still
    // GET by owner markers. When the list is empty, no DELETE is issued.
    const reservationId = await createReservationWithGoogleJob();
    d1.sqlite.prepare("DELETE FROM calendar_sync_jobs").run();
    d1.sqlite
      .prepare(
        `
          UPDATE reservations
          SET status = 'rejected',
              google_event_id = NULL,
              google_event_etag = NULL,
              google_sync_state = 'pending'
          WHERE id = ?
        `
      )
      .run(reservationId);
    d1.sqlite
      .prepare(
        `
          INSERT INTO calendar_sync_jobs (
            id,
            dedupe_key,
            owner_type,
            owner_id,
            google_action,
            status,
            available_at
          ) VALUES (
            'calendar_delete_job_without_event_1',
            'reservation:delete:calendar_delete_job_without_event_1',
            'reservation',
            ?,
            'delete',
            'queued',
            '2026-05-09T00:00:00.000Z'
          )
        `
      )
      .run(reservationId);
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "GET") {
        return Response.json({ items: [] });
      }
      throw new Error(`unexpected method ${init?.method ?? "GET"}`);
    }) as unknown as typeof fetch;

    const result = await processDueCalendarSyncJobs({
      db: d1 as unknown as D1Database,
      env: {
        GOOGLE_SERVICE_ACCOUNT_EMAIL: "calendar-sync@example.iam.gserviceaccount.com",
        GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "unused"
      },
      fetcher: fetchMock,
      accessTokenProvider: async () => "google_access_token",
      now: () => ACTIVE_SYNC_NOW_MS
    });

    expect(result).toEqual({
      processed: 1,
      succeeded: 1,
      failed: 0
    });
    const methods = vi.mocked(fetchMock).mock.calls.map(([, init]) => init?.method ?? "GET");
    expect(methods.filter((m) => m === "GET")).toHaveLength(1);
    expect(methods.filter((m) => m === "DELETE")).toHaveLength(0);
    const job = d1.sqlite
      .prepare("SELECT status, last_error FROM calendar_sync_jobs WHERE id = 'calendar_delete_job_without_event_1'")
      .get() as { status: string; last_error: string | null };
    expect(job).toEqual({
      status: "succeeded",
      last_error: null
    });
  });

  it("Google delete only NULLs reservation.google_event_id when it still matches the deleted id (codex #10)", async () => {
    const reservationId = await createReservationWithGoogleJob();
    d1.sqlite.prepare("DELETE FROM calendar_sync_jobs").run();
    // Pre-state: reservation has google_event_id='X' (queued for deletion).
    // Worker claims, calls Google DELETE 'X', then BEFORE persistGoogleDeleteSuccess
    // commits the NULL-set, a concurrent upsert replaces the column with 'Y'.
    // The persist predicate (google_event_id = 'X') no longer matches 'Y', so
    // the row must keep 'Y'.
    d1.sqlite
      .prepare(
        `
          UPDATE reservations
          SET status = 'cancelled_by_admin',
              google_event_id = 'google_event_pre_race_x_1',
              google_event_etag = 'google_etag_pre_race_x_1',
              google_sync_state = 'pending'
          WHERE id = ?
        `
      )
      .run(reservationId);
    d1.sqlite
      .prepare(
        `
          INSERT INTO calendar_sync_jobs (
            id,
            dedupe_key,
            owner_type,
            owner_id,
            google_action,
            status,
            available_at
          ) VALUES (
            'calendar_delete_overlap_1',
            'reservation:delete:calendar_delete_overlap_1',
            'reservation',
            ?,
            'delete',
            'queued',
            '2026-05-09T00:00:00.000Z'
          )
        `
      )
      .run(reservationId);
    // Inject the concurrent upsert side-effect inside fetchMock so it fires
    // WHILE the worker is awaiting the Google DELETE response — i.e. after
    // fetchNextCalendarSyncJob has captured row.google_event_id='X' but BEFORE
    // persistGoogleDeleteSuccess builds its UPDATE. This produces the real
    // TOCTOU race window. (Mocking `now()` does not work here because the
    // delete path makes no additional now() calls between fetch and persist.)
    const fetchMock = vi.fn(async () => {
      d1.sqlite
        .prepare(
          `
            UPDATE reservations
            SET google_event_id = 'google_event_post_race_y_1',
                google_event_etag = 'google_etag_post_race_y_1'
            WHERE id = ?
          `
        )
        .run(reservationId);
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;

    const result = await processDueCalendarSyncJobs({
      db: d1 as unknown as D1Database,
      env: {
        GOOGLE_SERVICE_ACCOUNT_EMAIL: "calendar-sync@example.iam.gserviceaccount.com",
        GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "unused"
      },
      fetcher: fetchMock,
      accessTokenProvider: async () => "google_access_token",
      now: () => ACTIVE_SYNC_NOW_MS
    });

    expect(result.processed).toBe(1);
    expect(result.succeeded).toBe(1);
    // Google DELETE was issued for the originally-claimed 'X'
    expect(fetchMock).toHaveBeenCalled();
    const reservation = d1.sqlite
      .prepare("SELECT google_event_id, google_event_etag FROM reservations WHERE id = ?")
      .get(reservationId) as {
      google_event_id: string | null;
      google_event_etag: string | null;
    };
    expect(reservation.google_event_id).toBe("google_event_post_race_y_1");
    expect(reservation.google_event_etag).toBe("google_etag_post_race_y_1");
  });

  // ---------------------------------------------------------------------------
  // Issue #563: owner-marker lookup on delete when google_event_id is NULL
  // ---------------------------------------------------------------------------

  it("DELETEs a Google event found by reservation owner markers when google_event_id is NULL (issue #563)", async () => {
    const reservationId = await createReservationWithGoogleJob();
    const existingEventId = "google_event_delete_marker_hit_1";
    queueReservationDeleteJob(reservationId, "calendar_delete_marker_hit_1");

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "GET") {
        const url = String(input);
        expect(url).toContain("privateExtendedProperty=");
        expect(url).toContain(encodeURIComponent("app=reservation-line-homepage"));
        expect(url).toContain(encodeURIComponent("owner_type=reservation"));
        expect(url).toContain(encodeURIComponent(`reservation_id=${reservationId}`));
        return Response.json({
          items: [{ id: existingEventId, etag: "etag_delete_marker_1" }]
        });
      }
      if (method === "DELETE") {
        expect(String(input)).toContain(`/events/${encodeURIComponent(existingEventId)}`);
        return new Response(null, { status: 204 });
      }
      throw new Error(`unexpected method ${method}`);
    }) as unknown as typeof fetch;

    const result = await processDueCalendarSyncJobs({
      db: d1 as unknown as D1Database,
      env: {
        GOOGLE_SERVICE_ACCOUNT_EMAIL: "calendar-sync@example.iam.gserviceaccount.com",
        GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "unused"
      },
      fetcher: fetchMock,
      accessTokenProvider: async () => "google_access_token",
      now: () => ACTIVE_SYNC_NOW_MS,
      maxJobs: 1
    });

    expect(result).toEqual({ processed: 1, succeeded: 1, failed: 0 });
    const methods = vi.mocked(fetchMock).mock.calls.map(([, init]) => init?.method ?? "GET");
    expect(methods.filter((m) => m === "GET")).toHaveLength(1);
    expect(methods.filter((m) => m === "DELETE")).toHaveLength(1);
    const job = d1.sqlite
      .prepare("SELECT status, last_error FROM calendar_sync_jobs WHERE id = 'calendar_delete_marker_hit_1'")
      .get() as { status: string; last_error: string | null };
    expect(job).toEqual({ status: "succeeded", last_error: null });
    const audit = d1.sqlite
      .prepare(
        "SELECT action, metadata_json FROM audit_logs WHERE target_id = ? AND action = 'google_calendar_event_deleted'"
      )
      .get(reservationId) as { action: string; metadata_json: string };
    expect(audit.action).toBe("google_calendar_event_deleted");
    expect(JSON.parse(audit.metadata_json).google_event_id).toBe(existingEventId);
    // The outbound ledger must record the marker-resolved id: it sits behind the
    // `deletedEventId` gate, so binding row.google_event_id there would drop the
    // row entirely even though Google was called.
    const ledger = d1.sqlite
      .prepare(
        "SELECT google_event_id FROM google_calendar_outbound_writes WHERE calendar_sync_job_id = 'calendar_delete_marker_hit_1'"
      )
      .get() as { google_event_id: string } | undefined;
    expect(ledger?.google_event_id).toBe(existingEventId);
    // The CAS predicate must bind the claim-time D1 value (NULL here), not the
    // marker-resolved id: binding the resolved id makes the predicate fail
    // against D1's NULL, leaving google_sync_state stuck at 'pending' even
    // though Google was deleted and the job succeeded.
    const reservation = d1.sqlite
      .prepare("SELECT google_event_id, google_sync_state FROM reservations WHERE id = ?")
      .get(reservationId) as { google_event_id: string | null; google_sync_state: string };
    expect(reservation).toEqual({ google_event_id: null, google_sync_state: "synced" });
  });

  it("fails closed (retryable) when owner-marker lookup returns 5xx on delete (issue #563)", async () => {
    const reservationId = await createReservationWithGoogleJob();
    queueReservationDeleteJob(reservationId, "calendar_delete_marker_5xx_1");

    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "GET") {
        return Response.json({ error: { message: "backend error" } }, { status: 500 });
      }
      throw new Error(`unexpected method ${init?.method ?? "GET"}`);
    }) as unknown as typeof fetch;

    const result = await processDueCalendarSyncJobs({
      db: d1 as unknown as D1Database,
      env: {
        GOOGLE_SERVICE_ACCOUNT_EMAIL: "calendar-sync@example.iam.gserviceaccount.com",
        GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "unused"
      },
      fetcher: fetchMock,
      accessTokenProvider: async () => "google_access_token",
      now: () => ACTIVE_SYNC_NOW_MS,
      maxJobs: 1
    });

    expect(result).toEqual({ processed: 1, succeeded: 0, failed: 1 });
    const methods = vi.mocked(fetchMock).mock.calls.map(([, init]) => init?.method ?? "GET");
    expect(methods.filter((m) => m === "DELETE")).toHaveLength(0);
    const job = d1.sqlite
      .prepare("SELECT status, last_error FROM calendar_sync_jobs WHERE id = 'calendar_delete_marker_5xx_1'")
      .get() as { status: string; last_error: string | null };
    expect(job).toEqual({ status: "retryable", last_error: "google-http-500" });
  });

  it("DELETEs a Google event found by external_block owner markers when google_event_id is NULL (issue #563)", async () => {
    const blockId = "ext_block_delete_marker_hit_1";
    const existingEventId = "google_ext_delete_marker_hit_1";
    d1.sqlite
      .prepare(
        `
          INSERT INTO external_blocks (
            id,
            store_id,
            resource_id,
            source,
            title_snapshot,
            start_at,
            end_at,
            status,
            created_by
          ) VALUES (
            ?,
            'kyoto',
            'resource_kyoto_calendar',
            'admin_block',
            '管理画面ブロック',
            '2026-06-01T03:00:00.000Z',
            '2026-06-01T04:00:00.000Z',
            'cancelled',
            'admin_owner_1'
          )
        `
      )
      .run(blockId);
    d1.sqlite
      .prepare(
        `
          INSERT INTO calendar_sync_jobs (
            id,
            dedupe_key,
            owner_type,
            owner_id,
            google_action,
            status,
            available_at
          ) VALUES (
            'calendar_ext_delete_marker_hit_1',
            'external_block:delete:calendar_ext_delete_marker_hit_1',
            'external_block',
            ?,
            'delete',
            'queued',
            '2026-05-09T00:00:00.000Z'
          )
        `
      )
      .run(blockId);

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "GET") {
        const url = String(input);
        expect(url).toContain(encodeURIComponent("owner_type=external_block"));
        expect(url).toContain(encodeURIComponent(`external_block_id=${blockId}`));
        return Response.json({ items: [{ id: existingEventId }] });
      }
      if (method === "DELETE") {
        expect(String(input)).toContain(`/events/${encodeURIComponent(existingEventId)}`);
        return new Response(null, { status: 204 });
      }
      throw new Error(`unexpected method ${method}`);
    }) as unknown as typeof fetch;

    const result = await processDueCalendarSyncJobs({
      db: d1 as unknown as D1Database,
      env: {
        GOOGLE_SERVICE_ACCOUNT_EMAIL: "calendar-sync@example.iam.gserviceaccount.com",
        GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "unused"
      },
      fetcher: fetchMock,
      accessTokenProvider: async () => "google_access_token",
      now: () => ACTIVE_SYNC_NOW_MS,
      maxJobs: 1
    });

    expect(result).toEqual({ processed: 1, succeeded: 1, failed: 0 });
    const methods = vi.mocked(fetchMock).mock.calls.map(([, init]) => init?.method ?? "GET");
    expect(methods.filter((m) => m === "DELETE")).toHaveLength(1);
    const job = d1.sqlite
      .prepare("SELECT status, last_error FROM calendar_sync_jobs WHERE id = 'calendar_ext_delete_marker_hit_1'")
      .get() as { status: string; last_error: string | null };
    expect(job).toEqual({ status: "succeeded", last_error: null });
    const ledger = d1.sqlite
      .prepare(
        "SELECT google_event_id FROM google_calendar_outbound_writes WHERE calendar_sync_job_id = 'calendar_ext_delete_marker_hit_1'"
      )
      .get() as { google_event_id: string } | undefined;
    expect(ledger?.google_event_id).toBe(existingEventId);
    // Audit must say "deleted" with the marker-resolved id: falling back to
    // row.google_event_id here records "delete_skipped" with a null id even
    // though Google was actually called.
    const audit = d1.sqlite
      .prepare(
        "SELECT action, metadata_json FROM audit_logs WHERE target_type = 'external_block' AND target_id = ?"
      )
      .get(blockId) as { action: string; metadata_json: string };
    expect(audit.action).toBe("google_calendar_external_block_deleted");
    expect(JSON.parse(audit.metadata_json).google_event_id).toBe(existingEventId);
  });

  it("treats Google DELETE 410 Gone as success (issue #563)", async () => {
    const reservationId = await createReservationWithGoogleJob();
    queueReservationDeleteJob(reservationId, "calendar_delete_410_1", { id: "google_event_already_gone_1", etag: "google_etag_already_gone_1" });

    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "DELETE") {
        return new Response(JSON.stringify({ error: { message: "Resource has been deleted" } }), {
          status: 410,
          headers: { "Content-Type": "application/json" }
        });
      }
      throw new Error(`unexpected method ${init?.method ?? "GET"}`);
    }) as unknown as typeof fetch;

    const result = await processDueCalendarSyncJobs({
      db: d1 as unknown as D1Database,
      env: {
        GOOGLE_SERVICE_ACCOUNT_EMAIL: "calendar-sync@example.iam.gserviceaccount.com",
        GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "unused"
      },
      fetcher: fetchMock,
      accessTokenProvider: async () => "google_access_token",
      now: () => ACTIVE_SYNC_NOW_MS,
      maxJobs: 1
    });

    expect(result).toEqual({ processed: 1, succeeded: 1, failed: 0 });
    const job = d1.sqlite
      .prepare("SELECT status, last_error FROM calendar_sync_jobs WHERE id = 'calendar_delete_410_1'")
      .get() as { status: string; last_error: string | null };
    expect(job).toEqual({ status: "succeeded", last_error: null });
  });

  it("marker-path delete does not NULL a concurrent upsert's google_event_id (issue #563 CAS)", async () => {
    // Symmetric to codex #10 but claim-time google_event_id is NULL and the
    // delete target comes from owner-marker lookup. CAS still keys off the
    // claim-time NULL, so a value written mid-DELETE must survive.
    const reservationId = await createReservationWithGoogleJob();
    const markerEventId = "google_event_marker_cas_x_1";
    queueReservationDeleteJob(reservationId, "calendar_delete_marker_cas_1");

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "GET") {
        return Response.json({ items: [{ id: markerEventId }] });
      }
      if (method === "DELETE") {
        expect(String(input)).toContain(`/events/${encodeURIComponent(markerEventId)}`);
        d1.sqlite
          .prepare(
            `
              UPDATE reservations
              SET google_event_id = 'google_event_post_race_marker_y_1',
                  google_event_etag = 'google_etag_post_race_marker_y_1'
              WHERE id = ?
            `
          )
          .run(reservationId);
        return new Response(null, { status: 204 });
      }
      throw new Error(`unexpected method ${method}`);
    }) as unknown as typeof fetch;

    const result = await processDueCalendarSyncJobs({
      db: d1 as unknown as D1Database,
      env: {
        GOOGLE_SERVICE_ACCOUNT_EMAIL: "calendar-sync@example.iam.gserviceaccount.com",
        GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "unused"
      },
      fetcher: fetchMock,
      accessTokenProvider: async () => "google_access_token",
      now: () => ACTIVE_SYNC_NOW_MS,
      maxJobs: 1
    });

    expect(result).toEqual({ processed: 1, succeeded: 1, failed: 0 });
    const reservation = d1.sqlite
      .prepare("SELECT google_event_id, google_event_etag FROM reservations WHERE id = ?")
      .get(reservationId) as {
      google_event_id: string | null;
      google_event_etag: string | null;
    };
    expect(reservation.google_event_id).toBe("google_event_post_race_marker_y_1");
    expect(reservation.google_event_etag).toBe("google_etag_post_race_marker_y_1");
  });

  // ---------------------------------------------------------------------------
  // Issue #589-1: delete path finds cancelled tombstones (showDeleted=true)
  // ---------------------------------------------------------------------------

  it("delete: tombstone-only marker hit records deleted without DELETE (issue #589-1)", async () => {
    // D1 lost google_event_id after a prior DELETE (or human deleted in UI).
    // Google only has a cancelled tombstone; without showDeleted we would treat
    // that as proven absence, leave google_calendar_events status='active', and
    // import would raise a false reservation_event_deleted conflict.
    const reservationId = await createReservationWithGoogleJob();
    const tombstoneId = "google_event_tombstone_only_1";
    const jobId = "calendar_delete_tombstone_only_1";
    queueReservationDeleteJob(reservationId, jobId);
    seedReservationGoogleEventRows(reservationId, [
      { id: "gce_tombstone_only_1", googleEventId: tombstoneId, status: "active" }
    ]);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "GET") {
        const url = String(input);
        expect(url).toContain("showDeleted=true");
        expect(url).toContain(encodeURIComponent(`reservation_id=${reservationId}`));
        return Response.json({
          items: [{ id: tombstoneId, status: "cancelled" }]
        });
      }
      throw new Error(`unexpected method ${method}`);
    }) as unknown as typeof fetch;

    const result = await processDueCalendarSyncJobs({
      db: d1 as unknown as D1Database,
      env: {
        GOOGLE_SERVICE_ACCOUNT_EMAIL: "calendar-sync@example.iam.gserviceaccount.com",
        GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "unused"
      },
      fetcher: fetchMock,
      accessTokenProvider: async () => "google_access_token",
      now: () => ACTIVE_SYNC_NOW_MS,
      maxJobs: 1
    });

    expect(result).toEqual({ processed: 1, succeeded: 1, failed: 0 });
    const methods = vi.mocked(fetchMock).mock.calls.map(([, init]) => init?.method ?? "GET");
    expect(methods.filter((m) => m === "GET")).toHaveLength(1);
    expect(methods.filter((m) => m === "DELETE")).toHaveLength(0);
    const job = d1.sqlite
      .prepare("SELECT status, last_error FROM calendar_sync_jobs WHERE id = ?")
      .get(jobId) as { status: string; last_error: string | null };
    expect(job).toEqual({ status: "succeeded", last_error: null });
    const event = d1.sqlite
      .prepare("SELECT status FROM google_calendar_events WHERE google_event_id = ?")
      .get(tombstoneId) as { status: string };
    expect(event.status).toBe("deleted");
    // No DELETE was sent, so the audit records a skip — but with the id, which
    // is what separates it from a proven-absence skip (id null).
    const audit = d1.sqlite
      .prepare(
        "SELECT action, metadata_json FROM audit_logs WHERE target_id = ? AND action LIKE 'google_calendar_event_delete%'"
      )
      .get(reservationId) as { action: string; metadata_json: string };
    expect(audit.action).toBe("google_calendar_event_delete_skipped");
    expect(JSON.parse(audit.metadata_json).google_event_id).toBe(tombstoneId);
    // The outbound ledger records mutations we sent; this job sent none.
    const ledger = d1.sqlite
      .prepare(
        "SELECT google_event_id, action FROM google_calendar_outbound_writes WHERE calendar_sync_job_id = ?"
      )
      .get(jobId) as { google_event_id: string; action: string } | undefined;
    expect(ledger).toBeUndefined();
    // outbound_write_success counts DELETE requests. None went out here, so the
    // counter must stay silent; only the event's own state was synced.
    const logged = logSpy.mock.calls.map(([line]) => String(line));
    logSpy.mockRestore();
    expect(logged.some((line) => line.includes("outbound_write_success"))).toBe(false);
  });

  it("delete: page1 tombstone + nextPageToken, page2 live → DELETEs live (issue #589-1)", async () => {
    // Must not early-return the first tombstone: a live duplicate on a later
    // page is the #570 orphan we still have to reclaim.
    const reservationId = await createReservationWithGoogleJob();
    const tombstoneId = "google_event_tomb_page1_1";
    const liveId = "google_event_live_page2_1";
    const jobId = "calendar_delete_tomb_then_live_1";
    queueReservationDeleteJob(reservationId, jobId);

    let getCount = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "GET") {
        getCount += 1;
        const url = String(input);
        expect(url).toContain("showDeleted=true");
        if (getCount === 1) {
          expect(url).not.toContain("pageToken=");
          return Response.json({
            items: [{ id: tombstoneId, status: "cancelled" }],
            nextPageToken: "page-2"
          });
        }
        expect(url).toContain("pageToken=page-2");
        return Response.json({
          items: [{ id: liveId, status: "confirmed" }]
        });
      }
      if (method === "DELETE") {
        expect(String(input)).toContain(`/events/${encodeURIComponent(liveId)}`);
        return new Response(null, { status: 204 });
      }
      throw new Error(`unexpected method ${method}`);
    }) as unknown as typeof fetch;

    const result = await processDueCalendarSyncJobs({
      db: d1 as unknown as D1Database,
      env: {
        GOOGLE_SERVICE_ACCOUNT_EMAIL: "calendar-sync@example.iam.gserviceaccount.com",
        GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "unused"
      },
      fetcher: fetchMock,
      accessTokenProvider: async () => "google_access_token",
      now: () => ACTIVE_SYNC_NOW_MS,
      maxJobs: 1
    });

    expect(result).toEqual({ processed: 1, succeeded: 1, failed: 0 });
    const methods = vi.mocked(fetchMock).mock.calls.map(([, init]) => init?.method ?? "GET");
    expect(methods.filter((m) => m === "GET")).toHaveLength(2);
    expect(methods.filter((m) => m === "DELETE")).toHaveLength(1);
    const job = d1.sqlite
      .prepare("SELECT status, last_error FROM calendar_sync_jobs WHERE id = ?")
      .get(jobId) as { status: string; last_error: string | null };
    expect(job).toEqual({ status: "succeeded", last_error: null });
  });

  it("delete: same page live + tombstone → DELETEs live; moreRemaining from live only (issue #589-1)", async () => {
    const reservationId = await createReservationWithGoogleJob();
    const liveId = "google_event_same_page_live_1";
    const tombstoneId = "google_event_same_page_tomb_1";
    const jobId = "calendar_delete_live_and_tomb_1";
    queueReservationDeleteJob(reservationId, jobId);
    // The tombstone on the winning page holds a stale 'active' ledger row.
    // Live wins the DELETE, but that row still has to be flipped or the import
    // walk keeps raising the false reservation_event_deleted for it.
    seedReservationGoogleEventRows(reservationId, [
      { id: "gce_same_page_tomb_1", googleEventId: tombstoneId, status: "active" }
    ]);

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "GET") {
        expect(String(input)).toContain("showDeleted=true");
        // Tombstone first in the array: live must still win.
        return Response.json({
          items: [
            { id: tombstoneId, status: "cancelled" },
            { id: liveId, status: "confirmed" }
          ]
        });
      }
      if (method === "DELETE") {
        expect(String(input)).toContain(`/events/${encodeURIComponent(liveId)}`);
        return new Response(null, { status: 204 });
      }
      throw new Error(`unexpected method ${method}`);
    }) as unknown as typeof fetch;

    const result = await processDueCalendarSyncJobs({
      db: d1 as unknown as D1Database,
      env: {
        GOOGLE_SERVICE_ACCOUNT_EMAIL: "calendar-sync@example.iam.gserviceaccount.com",
        GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "unused"
      },
      fetcher: fetchMock,
      accessTokenProvider: async () => "google_access_token",
      now: () => ACTIVE_SYNC_NOW_MS,
      maxJobs: 1
    });

    // One live only → moreRemaining false → job succeeds (not retryable).
    expect(result).toEqual({ processed: 1, succeeded: 1, failed: 0 });
    const methods = vi.mocked(fetchMock).mock.calls.map(([, init]) => init?.method ?? "GET");
    expect(methods.filter((m) => m === "DELETE")).toHaveLength(1);
    const job = d1.sqlite
      .prepare("SELECT status, last_error FROM calendar_sync_jobs WHERE id = ?")
      .get(jobId) as { status: string; last_error: string | null };
    expect(job).toEqual({ status: "succeeded", last_error: null });
    const tombstoneRow = d1.sqlite
      .prepare("SELECT status FROM google_calendar_events WHERE google_event_id = ?")
      .get(tombstoneId) as { status: string };
    expect(tombstoneRow.status).toBe("deleted");
  });

  it("delete: tombstones across pages record the first one seen (issue #589-1)", async () => {
    // A duplicate deleted twice leaves a tombstone on more than one page. The
    // scan still has to reach the end to prove no live duplicate remains, and
    // the id it records is the first tombstone — the ledger row that flips to
    // 'deleted' must not depend on how many pages Google returns after it.
    const reservationId = await createReservationWithGoogleJob();
    const firstTombstoneId = "google_event_tomb_first_1";
    const laterTombstoneId = "google_event_tomb_later_1";
    const jobId = "calendar_delete_tomb_pages_1";
    queueReservationDeleteJob(reservationId, jobId);
    // Only the LATER tombstone has a ledger row, and it is still 'active'.
    // Google's events.list order is unspecified, so recording just the first id
    // would leave this row active and the import walk would keep raising the
    // false reservation_event_deleted.
    seedReservationGoogleEventRows(reservationId, [
      { id: "gce_tomb_later_1", googleEventId: laterTombstoneId, status: "active" }
    ]);

    let getCount = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "GET") {
        getCount += 1;
        expect(String(input)).toContain("showDeleted=true");
        return getCount === 1
          ? Response.json({
              items: [{ id: firstTombstoneId, status: "cancelled" }],
              nextPageToken: "page-2"
            })
          : Response.json({ items: [{ id: laterTombstoneId, status: "cancelled" }] });
      }
      throw new Error(`unexpected method ${method}`);
    }) as unknown as typeof fetch;

    const result = await processDueCalendarSyncJobs({
      db: d1 as unknown as D1Database,
      env: {
        GOOGLE_SERVICE_ACCOUNT_EMAIL: "calendar-sync@example.iam.gserviceaccount.com",
        GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "unused"
      },
      fetcher: fetchMock,
      accessTokenProvider: async () => "google_access_token",
      now: () => ACTIVE_SYNC_NOW_MS,
      maxJobs: 1
    });

    expect(result).toEqual({ processed: 1, succeeded: 1, failed: 0 });
    const methods = vi.mocked(fetchMock).mock.calls.map(([, init]) => init?.method ?? "GET");
    expect(methods.filter((m) => m === "GET")).toHaveLength(2);
    expect(methods.filter((m) => m === "DELETE")).toHaveLength(0);
    const audit = d1.sqlite
      .prepare(
        "SELECT action, metadata_json FROM audit_logs WHERE target_id = ? AND action LIKE 'google_calendar_event_delete%'"
      )
      .get(reservationId) as { action: string; metadata_json: string };
    expect(audit.action).toBe("google_calendar_event_delete_skipped");
    expect(JSON.parse(audit.metadata_json).google_event_id).toBe(firstTombstoneId);
    const laterRow = d1.sqlite
      .prepare("SELECT status FROM google_calendar_events WHERE google_event_id = ?")
      .get(laterTombstoneId) as { status: string };
    expect(laterRow.status).toBe("deleted");
  });

  it("delete: more tombstones than the batch limit fails closed (issue #589-1)", async () => {
    // Trimming the list to a prefix would silently drop ids, and the dropped one
    // could be exactly the id holding the 'active' ledger row — the false
    // conflict would survive and every retry would drop the same id again.
    const reservationId = await createReservationWithGoogleJob();
    const jobId = "calendar_delete_tomb_overflow_1";
    queueReservationDeleteJob(reservationId, jobId);
    const tombstones = Array.from({ length: 51 }, (_, index) => ({
      id: `google_event_tomb_overflow_${index}`,
      status: "cancelled"
    }));
    seedReservationGoogleEventRows(reservationId, [
      { id: "gce_tomb_overflow_1", googleEventId: tombstones[50]!.id, status: "active" }
    ]);

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "GET") {
        expect(String(input)).toContain("showDeleted=true");
        return Response.json({ items: tombstones });
      }
      throw new Error(`unexpected method ${method}`);
    }) as unknown as typeof fetch;

    const result = await processDueCalendarSyncJobs({
      db: d1 as unknown as D1Database,
      env: {
        GOOGLE_SERVICE_ACCOUNT_EMAIL: "calendar-sync@example.iam.gserviceaccount.com",
        GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "unused"
      },
      fetcher: fetchMock,
      accessTokenProvider: async () => "google_access_token",
      now: () => ACTIVE_SYNC_NOW_MS,
      maxJobs: 1
    });

    expect(result).toEqual({ processed: 1, succeeded: 0, failed: 1 });
    const methods = vi.mocked(fetchMock).mock.calls.map(([, init]) => init?.method ?? "GET");
    expect(methods.filter((m) => m === "DELETE")).toHaveLength(0);
    const job = d1.sqlite
      .prepare("SELECT status, last_error FROM calendar_sync_jobs WHERE id = ?")
      .get(jobId) as { status: string; last_error: string | null };
    expect(job).toEqual({ status: "retryable", last_error: "google-lookup-incomplete" });
    // Nothing was claimed as reconciled, so the ledger row stays as it was.
    const row = d1.sqlite
      .prepare("SELECT status FROM google_calendar_events WHERE google_event_id = ?")
      .get(tombstones[50]!.id) as { status: string };
    expect(row.status).toBe("active");
  });

  it("delete: retryable attempt then tombstone attempt converges on one job (issue #589-1)", async () => {
    // The convergence claim in findGoogleEventByOwnerMarker's JSDoc, exercised
    // end to end on ONE job: a trailing nextPageToken keeps the job retryable
    // after the DELETE, then the next attempt sees the same event as a
    // tombstone, issues no DELETE, and succeeds. Without the tombstone branch
    // that attempt reads as proven absence and the ledger stays 'active'.
    const reservationId = await createReservationWithGoogleJob();
    const eventId = "google_event_converge_1";
    const jobId = "calendar_delete_converge_1";
    queueReservationDeleteJob(reservationId, jobId);
    seedReservationGoogleEventRows(reservationId, [
      { id: "gce_converge_1", googleEventId: eventId, status: "active" }
    ]);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    let getCount = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "GET") {
        getCount += 1;
        expect(String(input)).toContain("showDeleted=true");
        return getCount === 1
          ? Response.json({
              items: [{ id: eventId, status: "confirmed" }],
              nextPageToken: "page-2"
            })
          : Response.json({ items: [{ id: eventId, status: "cancelled" }] });
      }
      if (method === "DELETE") {
        expect(String(input)).toContain(`/events/${encodeURIComponent(eventId)}`);
        return new Response(null, { status: 204 });
      }
      throw new Error(`unexpected method ${method}`);
    }) as unknown as typeof fetch;

    const runAt = (nowMs: number) =>
      processDueCalendarSyncJobs({
        db: d1 as unknown as D1Database,
        env: {
          GOOGLE_SERVICE_ACCOUNT_EMAIL: "calendar-sync@example.iam.gserviceaccount.com",
          GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "unused"
        },
        fetcher: fetchMock,
        accessTokenProvider: async () => "google_access_token",
        now: () => nowMs,
        maxJobs: 1
      });

    expect(await runAt(ACTIVE_SYNC_NOW_MS)).toEqual({ processed: 1, succeeded: 0, failed: 1 });
    const afterFirst = d1.sqlite
      .prepare("SELECT status, last_error FROM calendar_sync_jobs WHERE id = ?")
      .get(jobId) as { status: string; last_error: string | null };
    expect(afterFirst).toEqual({ status: "retryable", last_error: DUPLICATE_MARKERS_REASON });

    // Past the attempt-1 backoff (60s base + under 60s jitter).
    expect(await runAt(ACTIVE_SYNC_NOW_MS + 5 * 60 * 1000)).toEqual({
      processed: 1,
      succeeded: 1,
      failed: 0
    });

    const methods = vi.mocked(fetchMock).mock.calls.map(([, init]) => init?.method ?? "GET");
    expect(methods.filter((m) => m === "GET")).toHaveLength(2);
    // Second attempt found the tombstone, so no second DELETE.
    expect(methods.filter((m) => m === "DELETE")).toHaveLength(1);
    const job = d1.sqlite
      .prepare("SELECT status, attempts, last_error FROM calendar_sync_jobs WHERE id = ?")
      .get(jobId) as { status: string; attempts: number; last_error: string | null };
    expect(job).toEqual({ status: "succeeded", attempts: 2, last_error: null });
    const event = d1.sqlite
      .prepare("SELECT status FROM google_calendar_events WHERE google_event_id = ?")
      .get(eventId) as { status: string };
    expect(event.status).toBe("deleted");
    // One DELETE request across both attempts, so exactly one success log:
    // attempt 1 counts, attempt 2's tombstone short-circuit does not.
    const logged = logSpy.mock.calls.map(([line]) => String(line));
    logSpy.mockRestore();
    expect(logged.filter((line) => line.includes("outbound_write_success"))).toHaveLength(1);
  });

  it("delete: nothing at all (no tombstone) stays local-only delete_skipped (issue #589-1)", async () => {
    const reservationId = await createReservationWithGoogleJob();
    const jobId = "calendar_delete_truly_absent_1";
    queueReservationDeleteJob(reservationId, jobId);

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "GET") {
        expect(String(input)).toContain("showDeleted=true");
        return Response.json({ items: [] });
      }
      throw new Error(`unexpected method ${method}`);
    }) as unknown as typeof fetch;

    const result = await processDueCalendarSyncJobs({
      db: d1 as unknown as D1Database,
      env: {
        GOOGLE_SERVICE_ACCOUNT_EMAIL: "calendar-sync@example.iam.gserviceaccount.com",
        GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "unused"
      },
      fetcher: fetchMock,
      accessTokenProvider: async () => "google_access_token",
      now: () => ACTIVE_SYNC_NOW_MS,
      maxJobs: 1
    });

    expect(result).toEqual({ processed: 1, succeeded: 1, failed: 0 });
    const methods = vi.mocked(fetchMock).mock.calls.map(([, init]) => init?.method ?? "GET");
    expect(methods.filter((m) => m === "DELETE")).toHaveLength(0);
    const job = d1.sqlite
      .prepare("SELECT status, last_error FROM calendar_sync_jobs WHERE id = ?")
      .get(jobId) as { status: string; last_error: string | null };
    expect(job).toEqual({ status: "succeeded", last_error: null });
    const audit = d1.sqlite
      .prepare(
        "SELECT action FROM audit_logs WHERE target_id = ? AND action LIKE 'google_calendar_event_delete%'"
      )
      .get(reservationId) as { action: string };
    expect(audit.action).toBe("google_calendar_event_delete_skipped");
    const ledger = d1.sqlite
      .prepare(
        "SELECT COUNT(*) AS count FROM google_calendar_outbound_writes WHERE calendar_sync_job_id = ?"
      )
      .get(jobId) as { count: number };
    expect(ledger.count).toBe(0);
  });

  it("write: tombstone-only lookup stays empty without showDeleted (issue #589-1)", async () => {
    // Write must never set showDeleted — matching a cancelled tombstone would
    // PATCH it back into life. Real API omits cancelled items when showDeleted
    // is false, so the list is empty and we POST a new event (unchanged).
    const reservationId = await createReservationWithGoogleJob();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "GET") {
        const url = String(input);
        expect(url).not.toContain("showDeleted");
        // Simulate Google omitting cancelled events when showDeleted is off.
        return Response.json({ items: [] });
      }
      if (method === "POST") {
        return Response.json({
          id: "google_event_write_after_tomb_1",
          etag: "etag_write_after_tomb_1",
          updated: "2026-06-01T00:00:00.000Z"
        });
      }
      throw new Error(`unexpected method ${method}`);
    }) as unknown as typeof fetch;

    const result = await processDueCalendarSyncJobs({
      db: d1 as unknown as D1Database,
      env: {
        GOOGLE_SERVICE_ACCOUNT_EMAIL: "calendar-sync@example.iam.gserviceaccount.com",
        GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "unused"
      },
      fetcher: fetchMock,
      accessTokenProvider: async () => "google_access_token",
      now: () => ACTIVE_SYNC_NOW_MS,
      maxJobs: 1
    });

    expect(result).toEqual({ processed: 1, succeeded: 1, failed: 0 });
    const methods = vi.mocked(fetchMock).mock.calls.map(([, init]) => init?.method ?? "GET");
    expect(methods.filter((m) => m === "GET")).toHaveLength(1);
    expect(methods.filter((m) => m === "POST")).toHaveLength(1);
    expect(methods.filter((m) => m === "PATCH")).toHaveLength(0);
  });

  it("delete: MAX_PAGES with only tombstones still fails closed (issue #589-1)", async () => {
    // Remembering a tombstone must not weaken the incomplete-scan fail-closed.
    const reservationId = await createReservationWithGoogleJob();
    const jobId = "calendar_delete_tomb_max_pages_1";
    queueReservationDeleteJob(reservationId, jobId);

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "GET") {
        expect(String(input)).toContain("showDeleted=true");
        return Response.json({
          items: [{ id: "google_event_endless_tomb_1", status: "cancelled" }],
          nextPageToken: "endless"
        });
      }
      throw new Error(`unexpected method ${method}`);
    }) as unknown as typeof fetch;

    const result = await processDueCalendarSyncJobs({
      db: d1 as unknown as D1Database,
      env: {
        GOOGLE_SERVICE_ACCOUNT_EMAIL: "calendar-sync@example.iam.gserviceaccount.com",
        GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "unused"
      },
      fetcher: fetchMock,
      accessTokenProvider: async () => "google_access_token",
      now: () => ACTIVE_SYNC_NOW_MS,
      maxJobs: 1
    });

    expect(result).toEqual({ processed: 1, succeeded: 0, failed: 1 });
    const methods = vi.mocked(fetchMock).mock.calls.map(([, init]) => init?.method ?? "GET");
    expect(methods.filter((m) => m === "GET")).toHaveLength(10);
    expect(methods.filter((m) => m === "DELETE")).toHaveLength(0);
    const job = d1.sqlite
      .prepare("SELECT status, last_error FROM calendar_sync_jobs WHERE id = ?")
      .get(jobId) as { status: string; last_error: string | null };
    expect(job.status).toBe("retryable");
    expect(job.last_error).toBe("google-lookup-incomplete");
  });

  // ---------------------------------------------------------------------------
  // Issue #570: marker-path delete keeps the job retryable while duplicates remain
  // ---------------------------------------------------------------------------

  const DUPLICATE_MARKERS_REASON = "google-owner-marker-duplicates-remaining";

  it("hasMore: two valid ids on the same page leaves the job retryable after one DELETE (issue #570)", async () => {
    const reservationId = await createReservationWithGoogleJob();
    queueReservationDeleteJob(reservationId, "calendar_delete_dup_same_page_1");
    const firstId = "google_event_dup_a_1";
    const secondId = "google_event_dup_b_1";

    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "GET") {
        return Response.json({
          items: [{ id: firstId }, { id: secondId }]
        });
      }
      if (method === "DELETE") {
        return new Response(null, { status: 204 });
      }
      throw new Error(`unexpected method ${method}`);
    }) as unknown as typeof fetch;

    const result = await processDueCalendarSyncJobs({
      db: d1 as unknown as D1Database,
      env: {
        GOOGLE_SERVICE_ACCOUNT_EMAIL: "calendar-sync@example.iam.gserviceaccount.com",
        GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "unused"
      },
      fetcher: fetchMock,
      accessTokenProvider: async () => "google_access_token",
      now: () => ACTIVE_SYNC_NOW_MS,
      maxJobs: 1
    });

    expect(result).toEqual({ processed: 1, succeeded: 0, failed: 1 });
    const methods = vi.mocked(fetchMock).mock.calls.map(([, init]) => init?.method ?? "GET");
    expect(methods.filter((m) => m === "GET")).toHaveLength(1);
    expect(methods.filter((m) => m === "DELETE")).toHaveLength(1);
    const deletedUrl = String(vi.mocked(fetchMock).mock.calls.find(([, init]) => (init?.method ?? "GET") === "DELETE")?.[0]);
    expect(deletedUrl).toContain(`/events/${encodeURIComponent(firstId)}`);
    const job = d1.sqlite
      .prepare(
        "SELECT status, attempts, last_error FROM calendar_sync_jobs WHERE id = 'calendar_delete_dup_same_page_1'"
      )
      .get() as { status: string; attempts: number; last_error: string | null };
    expect(job).toEqual({
      status: "retryable",
      attempts: 1,
      last_error: DUPLICATE_MARKERS_REASON
    });
  });

  it("hasMore: one valid id plus nextPageToken leaves the job retryable (issue #570)", async () => {
    const reservationId = await createReservationWithGoogleJob();
    queueReservationDeleteJob(reservationId, "calendar_delete_dup_token_1");
    const firstId = "google_event_dup_token_a_1";

    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "GET") {
        return Response.json({
          items: [{ id: firstId }],
          nextPageToken: "page-2-token"
        });
      }
      if (method === "DELETE") {
        return new Response(null, { status: 204 });
      }
      throw new Error(`unexpected method ${method}`);
    }) as unknown as typeof fetch;

    const result = await processDueCalendarSyncJobs({
      db: d1 as unknown as D1Database,
      env: {
        GOOGLE_SERVICE_ACCOUNT_EMAIL: "calendar-sync@example.iam.gserviceaccount.com",
        GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "unused"
      },
      fetcher: fetchMock,
      accessTokenProvider: async () => "google_access_token",
      now: () => ACTIVE_SYNC_NOW_MS,
      maxJobs: 1
    });

    expect(result).toEqual({ processed: 1, succeeded: 0, failed: 1 });
    const methods = vi.mocked(fetchMock).mock.calls.map(([, init]) => init?.method ?? "GET");
    // I4: one lookup + one mutation — must not follow nextPageToken in this job.
    expect(methods.filter((m) => m === "GET")).toHaveLength(1);
    expect(methods.filter((m) => m === "DELETE")).toHaveLength(1);
    const job = d1.sqlite
      .prepare(
        "SELECT status, last_error FROM calendar_sync_jobs WHERE id = 'calendar_delete_dup_token_1'"
      )
      .get() as { status: string; last_error: string | null };
    expect(job).toEqual({ status: "retryable", last_error: DUPLICATE_MARKERS_REASON });
  });

  it("hasMore: one valid id and no nextPageToken succeeds (issue #570)", async () => {
    const reservationId = await createReservationWithGoogleJob();
    queueReservationDeleteJob(reservationId, "calendar_delete_single_marker_1");
    const onlyId = "google_event_single_marker_1";

    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "GET") {
        return Response.json({ items: [{ id: onlyId }] });
      }
      if (method === "DELETE") {
        return new Response(null, { status: 204 });
      }
      throw new Error(`unexpected method ${method}`);
    }) as unknown as typeof fetch;

    const result = await processDueCalendarSyncJobs({
      db: d1 as unknown as D1Database,
      env: {
        GOOGLE_SERVICE_ACCOUNT_EMAIL: "calendar-sync@example.iam.gserviceaccount.com",
        GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "unused"
      },
      fetcher: fetchMock,
      accessTokenProvider: async () => "google_access_token",
      now: () => ACTIVE_SYNC_NOW_MS,
      maxJobs: 1
    });

    expect(result).toEqual({ processed: 1, succeeded: 1, failed: 0 });
    const job = d1.sqlite
      .prepare(
        "SELECT status, last_error FROM calendar_sync_jobs WHERE id = 'calendar_delete_single_marker_1'"
      )
      .get() as { status: string; last_error: string | null };
    expect(job).toEqual({ status: "succeeded", last_error: null });
  });

  it("hasMore: zero matches yields eventId null path — succeeded without DELETE (issue #570)", async () => {
    // Same as #563 empty-list success, re-pinned so hasMore=false on the null path.
    const reservationId = await createReservationWithGoogleJob();
    queueReservationDeleteJob(reservationId, "calendar_delete_zero_marker_1");

    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "GET") {
        return Response.json({ items: [] });
      }
      throw new Error(`unexpected method ${init?.method ?? "GET"}`);
    }) as unknown as typeof fetch;

    const result = await processDueCalendarSyncJobs({
      db: d1 as unknown as D1Database,
      env: {
        GOOGLE_SERVICE_ACCOUNT_EMAIL: "calendar-sync@example.iam.gserviceaccount.com",
        GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "unused"
      },
      fetcher: fetchMock,
      accessTokenProvider: async () => "google_access_token",
      now: () => ACTIVE_SYNC_NOW_MS,
      maxJobs: 1
    });

    expect(result).toEqual({ processed: 1, succeeded: 1, failed: 0 });
    const methods = vi.mocked(fetchMock).mock.calls.map(([, init]) => init?.method ?? "GET");
    expect(methods.filter((m) => m === "DELETE")).toHaveLength(0);
    const job = d1.sqlite
      .prepare(
        "SELECT status, last_error FROM calendar_sync_jobs WHERE id = 'calendar_delete_zero_marker_1'"
      )
      .get() as { status: string; last_error: string | null };
    expect(job).toEqual({ status: "succeeded", last_error: null });
  });

  it("hasMore: broken nextPageToken with a found id biases true (I3, issue #570)", async () => {
    const reservationId = await createReservationWithGoogleJob();
    queueReservationDeleteJob(reservationId, "calendar_delete_broken_token_1");
    const firstId = "google_event_broken_token_1";

    // Empty string and non-string tokens both count as "maybe more" when an id
    // was already found — extra retry is cheap; silent orphans are not.
    for (const [suffix, nextPageToken] of [
      ["empty", ""],
      ["number", 42],
      ["object", { page: 2 }]
    ] as const) {
      d1.sqlite
        .prepare(
          `
            UPDATE calendar_sync_jobs
            SET status = 'queued',
                attempts = 0,
                available_at = '2026-05-09T00:00:00.000Z',
                locked_until = NULL,
                last_error = NULL
            WHERE id = 'calendar_delete_broken_token_1'
          `
        )
        .run();

      const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        const method = init?.method ?? "GET";
        if (method === "GET") {
          return Response.json({
            items: [{ id: `${firstId}_${suffix}` }],
            nextPageToken
          });
        }
        if (method === "DELETE") {
          return new Response(null, { status: 204 });
        }
        throw new Error(`unexpected method ${method}`);
      }) as unknown as typeof fetch;

      const result = await processDueCalendarSyncJobs({
        db: d1 as unknown as D1Database,
        env: {
          GOOGLE_SERVICE_ACCOUNT_EMAIL: "calendar-sync@example.iam.gserviceaccount.com",
          GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "unused"
        },
        fetcher: fetchMock,
        accessTokenProvider: async () => "google_access_token",
        now: () => ACTIVE_SYNC_NOW_MS,
        maxJobs: 1
      });

      expect(result, `token=${suffix}`).toEqual({ processed: 1, succeeded: 0, failed: 1 });
      const job = d1.sqlite
        .prepare(
          "SELECT status, last_error FROM calendar_sync_jobs WHERE id = 'calendar_delete_broken_token_1'"
        )
        .get() as { status: string; last_error: string | null };
      expect(job, `token=${suffix}`).toEqual({
        status: "retryable",
        last_error: DUPLICATE_MARKERS_REASON
      });
    }
  });

  it("D1 google_event_id short-circuit sets hasMore false and skips marker GET (issue #570)", async () => {
    const reservationId = await createReservationWithGoogleJob();
    const d1EventId = "google_event_d1_short_circuit_1";
    queueReservationDeleteJob(reservationId, "calendar_delete_d1_short_1", {
      id: d1EventId,
      etag: "etag_d1_short_1"
    });

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "DELETE") {
        expect(String(input)).toContain(`/events/${encodeURIComponent(d1EventId)}`);
        return new Response(null, { status: 204 });
      }
      throw new Error(`unexpected method ${method} — marker GET must not run on D1 short-circuit`);
    }) as unknown as typeof fetch;

    const result = await processDueCalendarSyncJobs({
      db: d1 as unknown as D1Database,
      env: {
        GOOGLE_SERVICE_ACCOUNT_EMAIL: "calendar-sync@example.iam.gserviceaccount.com",
        GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "unused"
      },
      fetcher: fetchMock,
      accessTokenProvider: async () => "google_access_token",
      now: () => ACTIVE_SYNC_NOW_MS,
      maxJobs: 1
    });

    expect(result).toEqual({ processed: 1, succeeded: 1, failed: 0 });
    expect(vi.mocked(fetchMock).mock.calls).toHaveLength(1);
    expect(vi.mocked(fetchMock).mock.calls[0]?.[1]?.method).toBe("DELETE");
    const job = d1.sqlite
      .prepare(
        "SELECT status, last_error FROM calendar_sync_jobs WHERE id = 'calendar_delete_d1_short_1'"
      )
      .get() as { status: string; last_error: string | null };
    expect(job).toEqual({ status: "succeeded", last_error: null });
  });

  const seedReservationGoogleEventRows = (
    reservationId: string,
    events: Array<{ id: string; googleEventId: string; status?: string }>
  ) => {
    for (const event of events) {
      d1.sqlite
        .prepare(
          `
            INSERT INTO google_calendar_events (
              id,
              store_id,
              calendar_id,
              google_event_id,
              reservation_id,
              google_etag,
              google_updated_at,
              source_type,
              status,
              google_safe_snapshot_json
            ) VALUES (
              ?,
              'kyoto',
              'calendar-a@example.invalid',
              ?,
              ?,
              'etag_seed',
              '2026-06-01T00:00:00.000Z',
              'reservation',
              ?,
              '{}'
            )
          `
        )
        // Only one active row per reservation_id (partial unique). Seed extras as conflict.
        .run(event.id, event.googleEventId, reservationId, event.status ?? "active");
    }
  };

  const countReservationDeleteAudit = (reservationId: string) =>
    (
      d1.sqlite
        .prepare(
          "SELECT COUNT(*) AS count FROM audit_logs WHERE target_id = ? AND action = 'google_calendar_event_deleted'"
        )
        .get(reservationId) as { count: number }
    ).count;

  // History rows do not store job_id; key by google_event_id set instead.
  const historyEventIdsByIds = (eventIds: string[]) =>
    (
      d1.sqlite
        .prepare(
          `
            SELECT google_event_id
            FROM google_calendar_event_history
            WHERE google_event_id IN (${eventIds.map(() => "?").join(", ")})
            ORDER BY google_event_id
          `
        )
        .all(...eventIds) as { google_event_id: string }[]
    ).map((row) => row.google_event_id);

  const deletedEventStatuses = (eventIds: string[]) =>
    (
      d1.sqlite
        .prepare(
          `
            SELECT google_event_id, status
            FROM google_calendar_events
            WHERE google_event_id IN (${eventIds.map(() => "?").join(", ")})
            ORDER BY google_event_id
          `
        )
        .all(...eventIds) as { google_event_id: string; status: string }[]
    );

  const outboundCountForJob = (jobId: string) =>
    (
      d1.sqlite
        .prepare(
          "SELECT COUNT(*) AS count FROM google_calendar_outbound_writes WHERE calendar_sync_job_id = ?"
        )
        .get(jobId) as { count: number }
    ).count;

  it("duplicate marker matches: first attempt DELETEs one and stays retryable; second DELETEs last and succeeds (issue #570)", async () => {
    const reservationId = await createReservationWithGoogleJob();
    const jobId = "calendar_delete_dup_lifecycle_1";
    queueReservationDeleteJob(reservationId, jobId);
    const firstId = "google_event_lifecycle_a_1";
    const secondId = "google_event_lifecycle_b_1";
    // Seed D1 event rows so intermediate moreRemaining persists can flip status=deleted.
    // Partial unique allows only one active per reservation_id — second is conflict.
    seedReservationGoogleEventRows(reservationId, [
      { id: "gce_lifecycle_a_1", googleEventId: firstId, status: "active" },
      { id: "gce_lifecycle_b_1", googleEventId: secondId, status: "conflict" }
    ]);
    // Remaining events the marker still matches after each DELETE.
    let remaining = [firstId, secondId];

    const firstFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "GET") {
        return Response.json({
          items: remaining.map((id) => ({ id }))
        });
      }
      if (method === "DELETE") {
        const deleted = remaining[0];
        expect(String(input)).toContain(`/events/${encodeURIComponent(deleted!)}`);
        remaining = remaining.slice(1);
        return new Response(null, { status: 204 });
      }
      throw new Error(`unexpected method ${method}`);
    }) as unknown as typeof fetch;

    const first = await processDueCalendarSyncJobs({
      db: d1 as unknown as D1Database,
      env: {
        GOOGLE_SERVICE_ACCOUNT_EMAIL: "calendar-sync@example.iam.gserviceaccount.com",
        GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "unused"
      },
      fetcher: firstFetch,
      accessTokenProvider: async () => "google_access_token",
      now: () => ACTIVE_SYNC_NOW_MS,
      maxJobs: 1
    });

    expect(first).toEqual({ processed: 1, succeeded: 0, failed: 1 });
    const firstMethods = vi.mocked(firstFetch).mock.calls.map(([, init]) => init?.method ?? "GET");
    expect(firstMethods.filter((m) => m === "DELETE")).toHaveLength(1);
    expect(firstMethods.filter((m) => m === "GET")).toHaveLength(1);
    const afterFirst = d1.sqlite
      .prepare("SELECT status, attempts, last_error FROM calendar_sync_jobs WHERE id = ?")
      .get(jobId) as { status: string; attempts: number; last_error: string | null };
    expect(afterFirst).toEqual({
      status: "retryable",
      attempts: 1,
      last_error: DUPLICATE_MARKERS_REASON
    });
    expect(remaining).toEqual([secondId]);

    // Intermediate moreRemaining path must write ledger for the DELETE that advanced.
    expect(countReservationDeleteAudit(reservationId)).toBe(1);
    expect(historyEventIdsByIds([firstId, secondId])).toEqual([firstId]);
    expect(deletedEventStatuses([firstId, secondId])).toEqual([
      { google_event_id: firstId, status: "deleted" },
      { google_event_id: secondId, status: "conflict" }
    ]);
    // Fingerprint includes deletedEventId, so this attempt owns one outbound row.
    expect(outboundCountForJob(jobId)).toBe(1);
    // Final owner clear / google_sync_state='synced' is deferred until no orphans remain.
    const afterFirstRes = d1.sqlite
      .prepare("SELECT google_sync_state FROM reservations WHERE id = ?")
      .get(reservationId) as { google_sync_state: string };
    expect(afterFirstRes.google_sync_state).not.toBe("synced");

    const secondFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "GET") {
        return Response.json({
          items: remaining.map((id) => ({ id }))
        });
      }
      if (method === "DELETE") {
        expect(String(input)).toContain(`/events/${encodeURIComponent(secondId)}`);
        remaining = remaining.slice(1);
        return new Response(null, { status: 204 });
      }
      throw new Error(`unexpected method ${method}`);
    }) as unknown as typeof fetch;

    const second = await processDueCalendarSyncJobs({
      db: d1 as unknown as D1Database,
      env: {
        GOOGLE_SERVICE_ACCOUNT_EMAIL: "calendar-sync@example.iam.gserviceaccount.com",
        GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "unused"
      },
      fetcher: secondFetch,
      accessTokenProvider: async () => "google_access_token",
      // Past retry backoff so the retryable job is claimable again.
      now: () => ACTIVE_SYNC_NOW_MS + 3 * 60_000,
      maxJobs: 1
    });

    expect(second).toEqual({ processed: 1, succeeded: 1, failed: 0 });
    const secondMethods = vi.mocked(secondFetch).mock.calls.map(([, init]) => init?.method ?? "GET");
    expect(secondMethods.filter((m) => m === "DELETE")).toHaveLength(1);
    expect(secondMethods.filter((m) => m === "GET")).toHaveLength(1);
    const afterSecond = d1.sqlite
      .prepare("SELECT status, attempts, last_error FROM calendar_sync_jobs WHERE id = ?")
      .get(jobId) as { status: string; attempts: number; last_error: string | null };
    expect(afterSecond).toEqual({
      status: "succeeded",
      attempts: 2,
      last_error: null
    });
    expect(remaining).toEqual([]);

    expect(countReservationDeleteAudit(reservationId)).toBe(2);
    expect(historyEventIdsByIds([firstId, secondId]).sort()).toEqual([firstId, secondId].sort());
    expect(deletedEventStatuses([firstId, secondId])).toEqual([
      { google_event_id: firstId, status: "deleted" },
      { google_event_id: secondId, status: "deleted" }
    ]);
    // Distinct deletedEventIds → distinct fingerprints → one outbound row each.
    // (Same job+fingerprint retry stays one via INSERT OR IGNORE.)
    expect(outboundCountForJob(jobId)).toBe(2);
    const afterSecondRes = d1.sqlite
      .prepare("SELECT google_sync_state FROM reservations WHERE id = ?")
      .get(reservationId) as { google_sync_state: string };
    expect(afterSecondRes.google_sync_state).toBe("synced");
  });

  it("delete (external_block): tombstone-only hit records a skip, not a delete (issue #589-1)", async () => {
    // The external_block persist is a separate function with its own action
    // strings, so the reservation test does not cover it.
    const blockId = "ext_block_tombstone_only_1";
    const jobId = "calendar_ext_delete_tombstone_only_1";
    const tombstoneId = "google_ext_tombstone_only_1";

    d1.sqlite
      .prepare(
        `
          INSERT INTO external_blocks (
            id, store_id, resource_id, source, title_snapshot,
            start_at, end_at, status, created_by
          ) VALUES (
            ?, 'kyoto', 'resource_kyoto_calendar', 'admin_block', '管理画面ブロック',
            '2026-06-01T03:00:00.000Z', '2026-06-01T04:00:00.000Z', 'cancelled', 'admin_owner_1'
          )
        `
      )
      .run(blockId);
    d1.sqlite
      .prepare(
        `
          INSERT INTO calendar_sync_jobs (
            id, dedupe_key, owner_type, owner_id, google_action, status, available_at
          ) VALUES (?, ?, 'external_block', ?, 'delete', 'queued', '2026-05-09T00:00:00.000Z')
        `
      )
      .run(jobId, `external_block:delete:${jobId}`, blockId);
    d1.sqlite
      .prepare(
        `
          INSERT INTO google_calendar_events (
            id, store_id, calendar_id, google_event_id, external_block_id,
            google_etag, google_updated_at, source_type, status, google_safe_snapshot_json
          ) VALUES (
            'gce_ext_tomb_only_1', 'kyoto', 'calendar-a@example.invalid', ?, ?,
            'e', '2026-06-01T00:00:00.000Z', 'external_block', 'active', '{}'
          )
        `
      )
      .run(tombstoneId, blockId);

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "GET") {
        expect(String(input)).toContain("showDeleted=true");
        return Response.json({ items: [{ id: tombstoneId, status: "cancelled" }] });
      }
      throw new Error(`unexpected method ${method}`);
    }) as unknown as typeof fetch;

    const result = await processDueCalendarSyncJobs({
      db: d1 as unknown as D1Database,
      env: {
        GOOGLE_SERVICE_ACCOUNT_EMAIL: "calendar-sync@example.iam.gserviceaccount.com",
        GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "unused"
      },
      fetcher: fetchMock,
      accessTokenProvider: async () => "google_access_token",
      now: () => ACTIVE_SYNC_NOW_MS,
      maxJobs: 1
    });

    expect(result).toEqual({ processed: 1, succeeded: 1, failed: 0 });
    const methods = vi.mocked(fetchMock).mock.calls.map(([, init]) => init?.method ?? "GET");
    expect(methods.filter((m) => m === "DELETE")).toHaveLength(0);
    const audit = d1.sqlite
      .prepare(
        "SELECT action, metadata_json FROM audit_logs WHERE target_id = ? AND action LIKE 'google_calendar_external_block_delete%'"
      )
      .get(blockId) as { action: string; metadata_json: string };
    expect(audit.action).toBe("google_calendar_external_block_delete_skipped");
    expect(JSON.parse(audit.metadata_json).google_event_id).toBe(tombstoneId);
    expect(outboundCountForJob(jobId)).toBe(0);
    expect(deletedEventStatuses([tombstoneId])).toEqual([
      { google_event_id: tombstoneId, status: "deleted" }
    ]);
  });

  it("duplicate marker matches (external_block): intermediate DELETE writes ledger; final attempt succeeds (issue #570)", async () => {
    const blockId = "ext_block_dup_lifecycle_1";
    const jobId = "calendar_ext_delete_dup_lifecycle_1";
    const firstId = "google_ext_lifecycle_a_1";
    const secondId = "google_ext_lifecycle_b_1";

    d1.sqlite
      .prepare(
        `
          INSERT INTO external_blocks (
            id,
            store_id,
            resource_id,
            source,
            title_snapshot,
            start_at,
            end_at,
            status,
            created_by
          ) VALUES (
            ?,
            'kyoto',
            'resource_kyoto_calendar',
            'admin_block',
            '管理画面ブロック',
            '2026-06-01T03:00:00.000Z',
            '2026-06-01T04:00:00.000Z',
            'cancelled',
            'admin_owner_1'
          )
        `
      )
      .run(blockId);
    d1.sqlite
      .prepare(
        `
          INSERT INTO calendar_sync_jobs (
            id,
            dedupe_key,
            owner_type,
            owner_id,
            google_action,
            status,
            available_at
          ) VALUES (?, ?, 'external_block', ?, 'delete', 'queued', '2026-05-09T00:00:00.000Z')
        `
      )
      .run(jobId, `external_block:delete:${jobId}`, blockId);
    // Partial unique: one active per external_block_id.
    d1.sqlite
      .prepare(
        `
          INSERT INTO google_calendar_events (
            id, store_id, calendar_id, google_event_id, external_block_id,
            google_etag, google_updated_at, source_type, status, google_safe_snapshot_json
          ) VALUES
            ('gce_ext_life_a_1', 'kyoto', 'calendar-a@example.invalid', ?, ?, 'e', '2026-06-01T00:00:00.000Z', 'external_block', 'active', '{}'),
            ('gce_ext_life_b_1', 'kyoto', 'calendar-a@example.invalid', ?, ?, 'e', '2026-06-01T00:00:00.000Z', 'external_block', 'conflict', '{}')
        `
      )
      .run(firstId, blockId, secondId, blockId);

    let remaining = [firstId, secondId];
    const makeFetch = () =>
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const method = init?.method ?? "GET";
        if (method === "GET") {
          return Response.json({ items: remaining.map((id) => ({ id })) });
        }
        if (method === "DELETE") {
          const deleted = remaining[0];
          expect(String(input)).toContain(`/events/${encodeURIComponent(deleted!)}`);
          remaining = remaining.slice(1);
          return new Response(null, { status: 204 });
        }
        throw new Error(`unexpected method ${method}`);
      }) as unknown as typeof fetch;

    const first = await processDueCalendarSyncJobs({
      db: d1 as unknown as D1Database,
      env: {
        GOOGLE_SERVICE_ACCOUNT_EMAIL: "calendar-sync@example.iam.gserviceaccount.com",
        GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "unused"
      },
      fetcher: makeFetch(),
      accessTokenProvider: async () => "google_access_token",
      now: () => ACTIVE_SYNC_NOW_MS,
      maxJobs: 1
    });
    expect(first).toEqual({ processed: 1, succeeded: 0, failed: 1 });
    const afterFirst = d1.sqlite
      .prepare("SELECT status, attempts, last_error FROM calendar_sync_jobs WHERE id = ?")
      .get(jobId) as { status: string; attempts: number; last_error: string | null };
    expect(afterFirst).toEqual({
      status: "retryable",
      attempts: 1,
      last_error: DUPLICATE_MARKERS_REASON
    });
    const auditAfterFirst = (
      d1.sqlite
        .prepare(
          "SELECT COUNT(*) AS count FROM audit_logs WHERE target_id = ? AND action = 'google_calendar_external_block_deleted'"
        )
        .get(blockId) as { count: number }
    ).count;
    expect(auditAfterFirst).toBe(1);
    expect(historyEventIdsByIds([firstId, secondId])).toEqual([firstId]);
    expect(deletedEventStatuses([firstId, secondId])).toEqual([
      { google_event_id: firstId, status: "deleted" },
      { google_event_id: secondId, status: "conflict" }
    ]);
    expect(outboundCountForJob(jobId)).toBe(1);

    const second = await processDueCalendarSyncJobs({
      db: d1 as unknown as D1Database,
      env: {
        GOOGLE_SERVICE_ACCOUNT_EMAIL: "calendar-sync@example.iam.gserviceaccount.com",
        GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "unused"
      },
      fetcher: makeFetch(),
      accessTokenProvider: async () => "google_access_token",
      now: () => ACTIVE_SYNC_NOW_MS + 3 * 60_000,
      maxJobs: 1
    });
    expect(second).toEqual({ processed: 1, succeeded: 1, failed: 0 });
    const afterSecond = d1.sqlite
      .prepare("SELECT status, attempts, last_error FROM calendar_sync_jobs WHERE id = ?")
      .get(jobId) as { status: string; attempts: number; last_error: string | null };
    expect(afterSecond).toEqual({ status: "succeeded", attempts: 2, last_error: null });
    expect(
      (
        d1.sqlite
          .prepare(
            "SELECT COUNT(*) AS count FROM audit_logs WHERE target_id = ? AND action = 'google_calendar_external_block_deleted'"
          )
          .get(blockId) as { count: number }
      ).count
    ).toBe(2);
    expect(historyEventIdsByIds([firstId, secondId]).sort()).toEqual([firstId, secondId].sort());
    expect(deletedEventStatuses([firstId, secondId])).toEqual([
      { google_event_id: firstId, status: "deleted" },
      { google_event_id: secondId, status: "deleted" }
    ]);
    expect(outboundCountForJob(jobId)).toBe(2);
  });

  it("duplicate markers remaining at MAX_ATTEMPTS: job goes dead and still writes ledger for that attempt (issue #570)", async () => {
    const reservationId = await createReservationWithGoogleJob();
    const jobId = "calendar_delete_dup_dead_1";
    queueReservationDeleteJob(reservationId, jobId);
    // Start at attempts=4 so this claim becomes attempt 5 (= MAX_ATTEMPTS) and dead-letters.
    d1.sqlite.prepare("UPDATE calendar_sync_jobs SET attempts = 4 WHERE id = ?").run(jobId);
    const firstId = "google_event_dup_dead_a_1";
    const secondId = "google_event_dup_dead_b_1";
    seedReservationGoogleEventRows(reservationId, [
      { id: "gce_dup_dead_a_1", googleEventId: firstId, status: "active" },
      { id: "gce_dup_dead_b_1", googleEventId: secondId, status: "conflict" }
    ]);

    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "GET") {
        return Response.json({ items: [{ id: firstId }, { id: secondId }] });
      }
      if (method === "DELETE") {
        return new Response(null, { status: 204 });
      }
      throw new Error(`unexpected method ${method}`);
    }) as unknown as typeof fetch;

    const result = await processDueCalendarSyncJobs({
      db: d1 as unknown as D1Database,
      env: {
        GOOGLE_SERVICE_ACCOUNT_EMAIL: "calendar-sync@example.iam.gserviceaccount.com",
        GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "unused"
      },
      fetcher: fetchMock,
      accessTokenProvider: async () => "google_access_token",
      now: () => ACTIVE_SYNC_NOW_MS,
      maxJobs: 1
    });

    expect(result).toEqual({ processed: 1, succeeded: 0, failed: 1 });
    const job = d1.sqlite
      .prepare("SELECT status, attempts, last_error FROM calendar_sync_jobs WHERE id = ?")
      .get(jobId) as { status: string; attempts: number; last_error: string | null };
    expect(job).toEqual({
      status: "dead",
      attempts: 5,
      last_error: DUPLICATE_MARKERS_REASON
    });
    // Ledger for the successful DELETE on the dead attempt must still land.
    expect(countReservationDeleteAudit(reservationId)).toBe(1);
    expect(historyEventIdsByIds([firstId])).toEqual([firstId]);
    expect(deletedEventStatuses([firstId])).toEqual([
      { google_event_id: firstId, status: "deleted" }
    ]);
    expect(outboundCountForJob(jobId)).toBe(1);
    // Dead transition still notifies Sentry once.
    expect(safeCaptureException).toHaveBeenCalledWith(
      expect.objectContaining({
        message: `calendar sync job failed permanently: ${DUPLICATE_MARKERS_REASON}`
      }),
      expect.objectContaining({
        tags: { dispatcher: "google_calendar_sync", reason: DUPLICATE_MARKERS_REASON }
      })
    );
    const res = d1.sqlite
      .prepare("SELECT google_sync_state FROM reservations WHERE id = ?")
      .get(reservationId) as { google_sync_state: string };
    expect(res.google_sync_state).not.toBe("synced");
  });

  it("DELETE 5xx wins over hasMore=true (I2, issue #570)", async () => {
    const reservationId = await createReservationWithGoogleJob();
    queueReservationDeleteJob(reservationId, "calendar_delete_dup_5xx_1");

    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "GET") {
        return Response.json({
          items: [{ id: "google_event_dup_5xx_a_1" }, { id: "google_event_dup_5xx_b_1" }]
        });
      }
      if (method === "DELETE") {
        return Response.json({ error: { message: "backend error" } }, { status: 500 });
      }
      throw new Error(`unexpected method ${method}`);
    }) as unknown as typeof fetch;

    const result = await processDueCalendarSyncJobs({
      db: d1 as unknown as D1Database,
      env: {
        GOOGLE_SERVICE_ACCOUNT_EMAIL: "calendar-sync@example.iam.gserviceaccount.com",
        GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "unused"
      },
      fetcher: fetchMock,
      accessTokenProvider: async () => "google_access_token",
      now: () => ACTIVE_SYNC_NOW_MS,
      maxJobs: 1
    });

    expect(result).toEqual({ processed: 1, succeeded: 0, failed: 1 });
    const methods = vi.mocked(fetchMock).mock.calls.map(([, init]) => init?.method ?? "GET");
    // Still advanced to DELETE (I1) — failure is the HTTP reason, not duplicates.
    expect(methods.filter((m) => m === "DELETE")).toHaveLength(1);
    const job = d1.sqlite
      .prepare(
        "SELECT status, last_error FROM calendar_sync_jobs WHERE id = 'calendar_delete_dup_5xx_1'"
      )
      .get() as { status: string; last_error: string | null };
    expect(job).toEqual({ status: "retryable", last_error: "google-http-500" });
    expect(job.last_error).not.toBe(DUPLICATE_MARKERS_REASON);
  });

  it("deletes Google external block events only after the D1 external block is cancelled", async () => {
    d1.sqlite
      .prepare(
        `
          INSERT INTO external_blocks (
            id,
            store_id,
            resource_id,
            source,
            title_snapshot,
            start_at,
            end_at,
            status,
            google_event_id,
            google_event_etag,
            created_by
          ) VALUES (
            'external_block_cancelled_delete_1',
            'kyoto',
            'resource_kyoto_calendar',
            'admin_block',
            '管理画面ブロック',
            '2026-06-01T03:00:00.000Z',
            '2026-06-01T04:00:00.000Z',
            'cancelled',
            'google_external_block_delete_1',
            'google_external_block_delete_etag_1',
            'admin_owner_1'
          )
        `
      )
      .run();
    d1.sqlite
      .prepare(
        `
          INSERT INTO google_calendar_events (
            id,
            store_id,
            calendar_id,
            google_event_id,
            external_block_id,
            google_etag,
            google_updated_at,
            source_type,
            status,
            google_safe_snapshot_json
          ) VALUES (
            'google_calendar_external_block_delete_1',
            'kyoto',
            'calendar-a@example.invalid',
            'google_external_block_delete_1',
            'external_block_cancelled_delete_1',
            'google_external_block_delete_etag_1',
            '2026-06-01T00:00:00.000Z',
            'external_block',
            'active',
            '{}'
          )
        `
      )
      .run();
    d1.sqlite
      .prepare(
        `
          INSERT INTO calendar_sync_jobs (
            id,
            dedupe_key,
            owner_type,
            owner_id,
            google_action,
            status,
            available_at
          ) VALUES (
            'calendar_external_block_delete_job_1',
            'external_block:external_block_cancelled_delete_1:google:delete:test',
            'external_block',
            'external_block_cancelled_delete_1',
            'delete',
            'queued',
            '2026-05-09T00:00:00.000Z'
          )
        `
      )
      .run();
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 })) as unknown as typeof fetch;

    const result = await processDueCalendarSyncJobs({
      db: d1 as unknown as D1Database,
      env: {
        GOOGLE_SERVICE_ACCOUNT_EMAIL: "calendar-sync@example.iam.gserviceaccount.com",
        GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "unused"
      },
      fetcher: fetchMock,
      accessTokenProvider: async () => "google_access_token",
      now: () => 1_800_000_000_000
    });

    expect(result).toEqual({
      processed: 1,
      succeeded: 1,
      failed: 0
    });
    const [url, init] = vi.mocked(fetchMock).mock.calls[0] ?? [];
    expect(url).toBe(
      "https://www.googleapis.com/calendar/v3/calendars/calendar-a%40example.invalid/events/google_external_block_delete_1?sendUpdates=none"
    );
    expect(init?.method).toBe("DELETE");
    const block = d1.sqlite
      .prepare("SELECT google_event_id, google_event_etag FROM external_blocks WHERE id = 'external_block_cancelled_delete_1'")
      .get() as { google_event_id: string | null; google_event_etag: string | null };
    const event = d1.sqlite
      .prepare("SELECT status FROM google_calendar_events WHERE external_block_id = 'external_block_cancelled_delete_1'")
      .get() as { status: string };
    const outbound = d1.sqlite
      .prepare("SELECT owner_type, action FROM google_calendar_outbound_writes WHERE owner_id = 'external_block_cancelled_delete_1'")
      .get() as { owner_type: string; action: string };
    expect(block).toEqual({
      google_event_id: null,
      google_event_etag: null
    });
    expect(event.status).toBe("deleted");
    expect(outbound).toEqual({
      owner_type: "external_block",
      action: "delete"
    });
  });

  it("does not patch Google a second time when the same queued job is redelivered after success", async () => {
    await createReservationWithGoogleJob();
    const fetchMock = googleUpsertFetchMock({
      id: "google_event_redelivery_1",
      etag: "google_etag_redelivery_1",
      updated: "2026-06-01T00:00:00.000Z"
    });

    const first = await processDueCalendarSyncJobs({
      db: d1 as unknown as D1Database,
      env: {
        GOOGLE_SERVICE_ACCOUNT_EMAIL: "calendar-sync@example.iam.gserviceaccount.com",
        GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "unused"
      },
      fetcher: fetchMock,
      accessTokenProvider: async () => "google_access_token",
      now: () => ACTIVE_SYNC_NOW_MS
    });
    const redelivery = await processDueCalendarSyncJobs({
      db: d1 as unknown as D1Database,
      env: {
        GOOGLE_SERVICE_ACCOUNT_EMAIL: "calendar-sync@example.iam.gserviceaccount.com",
        GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "unused"
      },
      fetcher: fetchMock,
      accessTokenProvider: async () => "google_access_token",
      now: () => ACTIVE_SYNC_NOW_MS + 10_000
    });

    expect(first).toEqual({
      processed: 1,
      succeeded: 1,
      failed: 0
    });
    expect(redelivery).toEqual({
      processed: 0,
      succeeded: 0,
      failed: 0
    });
    // GET owner-marker lookup + POST create; redelivery processes 0 jobs
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("deduplicates outbound write fingerprints when repeated upsert jobs produce the same Google payload", async () => {
    const reservationId = await createReservationWithGoogleJob();
    const fetchMock = googleUpsertFetchMock({
      id: "google_event_duplicate_fingerprint_1",
      etag: "google_etag_duplicate_fingerprint_1",
      updated: "2026-06-01T00:00:00.000Z"
    });

    await processDueCalendarSyncJobs({
      db: d1 as unknown as D1Database,
      env: {
        GOOGLE_SERVICE_ACCOUNT_EMAIL: "calendar-sync@example.iam.gserviceaccount.com",
        GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "unused"
      },
      fetcher: fetchMock,
      accessTokenProvider: async () => "google_access_token",
      now: () => ACTIVE_SYNC_NOW_MS
    });
    d1.sqlite
      .prepare(
        `
          INSERT INTO calendar_sync_jobs (
            id,
            dedupe_key,
            owner_type,
            owner_id,
            google_action,
            status,
            available_at
          ) VALUES (
            'calendar_upsert_duplicate_payload_1',
            'reservation:upsert:calendar_upsert_duplicate_payload_1',
            'reservation',
            ?,
            'upsert',
            'queued',
            '2026-05-09T00:00:00.000Z'
          )
        `
      )
      .run(reservationId);

    const second = await processDueCalendarSyncJobs({
      db: d1 as unknown as D1Database,
      env: {
        GOOGLE_SERVICE_ACCOUNT_EMAIL: "calendar-sync@example.iam.gserviceaccount.com",
        GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "unused"
      },
      fetcher: fetchMock,
      accessTokenProvider: async () => "google_access_token",
      now: () => ACTIVE_SYNC_NOW_MS + 10_000
    });

    expect(second).toEqual({
      processed: 1,
      succeeded: 1,
      failed: 0
    });
    // First job: GET + POST. Second job already has google_event_id → PATCH only.
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const outboundWrites = d1.sqlite
      .prepare("SELECT COUNT(*) AS count FROM google_calendar_outbound_writes WHERE owner_id = ?")
      .get(reservationId) as { count: number };
    expect(outboundWrites.count).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // Issue #121: external_block symmetric eligibility + cleanup tests
  // ---------------------------------------------------------------------------

  const createExternalBlockWithUpsertJob = (blockId: string, status: "active" | "cancelled" = "active") => {
    d1.sqlite
      .prepare(
        `
          INSERT INTO external_blocks (
            id,
            store_id,
            resource_id,
            source,
            title_snapshot,
            start_at,
            end_at,
            status,
            created_by
          ) VALUES (
            ?,
            'kyoto',
            'resource_kyoto_calendar',
            'admin_block',
            '管理画面ブロック',
            '2026-06-01T03:00:00.000Z',
            '2026-06-01T04:00:00.000Z',
            ?,
            'admin_owner_1'
          )
        `
      )
      .run(blockId, status);
    d1.sqlite
      .prepare(
        `
          INSERT INTO calendar_sync_jobs (
            id,
            dedupe_key,
            owner_type,
            owner_id,
            google_action,
            status,
            available_at
          ) VALUES (
            ?,
            ?,
            'external_block',
            ?,
            'upsert',
            'queued',
            '2026-05-09T00:00:00.000Z'
          )
        `
      )
      .run(
        `calendar_sync_job_${blockId}`,
        `external_block:${blockId}:google:upsert:test`,
        blockId
      );
  };

  it("supersedes external_block upsert before Google write when block is already cancelled (issue #121 pre-write race)", async () => {
    const blockId = "ext_block_prewrite_race_1";
    createExternalBlockWithUpsertJob(blockId, "cancelled");
    const fetchMock = vi.fn(async () =>
      Response.json({
        id: "google_event_should_not_write_cancelled_block",
        etag: "google_etag_should_not_write_cancelled_block"
      })
    ) as unknown as typeof fetch;

    const result = await processDueCalendarSyncJobs({
      db: d1 as unknown as D1Database,
      env: {
        GOOGLE_SERVICE_ACCOUNT_EMAIL: "calendar-sync@example.iam.gserviceaccount.com",
        GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "unused"
      },
      fetcher: fetchMock,
      accessTokenProvider: async () => "google_access_token",
      now: () => ACTIVE_SYNC_NOW_MS
    });

    // The fetchNextCalendarSyncJob filter now mirrors reservation: cancelled
    // external_block upsert jobs are picked up so the pre-write
    // isExternalBlockStillUpsertable check can explicitly supersede them
    // (status='succeeded', last_error='superseded_by_external_block_cancellation').
    // No Google API call happens — fetchMock should never be invoked.
    expect(result).toEqual({
      processed: 1,
      succeeded: 1,
      failed: 0
    });
    expect(fetchMock).not.toHaveBeenCalled();
    const job = d1.sqlite
      .prepare("SELECT status, last_error FROM calendar_sync_jobs WHERE owner_id = ? AND google_action = 'upsert'")
      .get(blockId) as { status: string; last_error: string | null };
    expect(job).toEqual({
      status: "succeeded",
      last_error: "superseded_by_external_block_cancellation"
    });
  });

  it("supersedes external_block upsert before Google write when block transitions to cancelled between dequeue and write (issue #121 pre-write race)", async () => {
    const blockId = "ext_block_prewrite_race_2";
    createExternalBlockWithUpsertJob(blockId, "active");
    // fetchNextCalendarSyncJob dequeues with status='active', but by the time
    // processGoogleWriteJob runs, the block has been cancelled.
    const fetchMock = vi.fn(async () =>
      Response.json({
        id: "google_event_should_not_write",
        etag: "google_etag_should_not_write"
      })
    ) as unknown as typeof fetch;
    const callCount = { markProcessing: 0 };
    const cancelOnProcessingDb = {
      prepare(sql: string) {
        const statement = (d1 as unknown as D1Database).prepare(sql);
        if (sql.includes("UPDATE calendar_sync_jobs") && sql.includes("SET status = 'processing'")) {
          return {
            bind(...values: unknown[]) {
              const bound = statement.bind(...values);
              return {
                async run() {
                  const result = await bound.run();
                  callCount.markProcessing++;
                  if (callCount.markProcessing === 1) {
                    // Simulate cancellation between dequeue and write
                    d1.sqlite
                      .prepare("UPDATE external_blocks SET status = 'cancelled' WHERE id = ?")
                      .run(blockId);
                  }
                  return result;
                }
              } as unknown as D1PreparedStatement;
            }
          } as unknown as D1PreparedStatement;
        }
        return statement;
      },
      batch(statements: D1PreparedStatement[]) {
        return d1.batch(statements);
      }
    } as unknown as D1Database;

    const result = await processDueCalendarSyncJobs({
      db: cancelOnProcessingDb,
      env: {
        GOOGLE_SERVICE_ACCOUNT_EMAIL: "calendar-sync@example.iam.gserviceaccount.com",
        GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "unused"
      },
      fetcher: fetchMock,
      accessTokenProvider: async () => "google_access_token",
      now: () => ACTIVE_SYNC_NOW_MS
    });

    expect(result).toEqual({
      processed: 1,
      succeeded: 1,
      failed: 0
    });
    expect(fetchMock).not.toHaveBeenCalled();
    const job = d1.sqlite
      .prepare("SELECT status, last_error FROM calendar_sync_jobs WHERE owner_id = ?")
      .get(blockId) as { status: string; last_error: string | null };
    expect(job).toEqual({
      status: "succeeded",
      last_error: "superseded_by_external_block_cancellation"
    });
  });

  it("queues a follow-up delete when an external_block upsert discovers cancellation after Google write (issue #121 post-write race)", async () => {
    const blockId = "ext_block_postwrite_race_1";
    createExternalBlockWithUpsertJob(blockId, "active");
    // The block is cancelled DURING the Google API call (simulated by
    // mutating status inside the fetch mock).
    //
    // All fetches are intercepted by a single mock that branches on the
    // request method: GET = empty owner-marker lookup (#560), POST/PATCH =
    // upsert (returns the synthetic event), DELETE = cleanup (204). The
    // cleanup-enqueued delete job is `available_at = nowIso` so the same
    // processDueCalendarSyncJobs sweep picks it up in a subsequent iteration.
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "GET") {
        return Response.json({ items: [] });
      }
      if (method === "DELETE") {
        return new Response(null, { status: 204 });
      }
      // Upsert: cancel the block mid-write to trigger the post-write race
      // path. shouldDeleteExternalBlockEventAfterWrite() then returns true
      // and persistStaleExternalBlockGoogleEventCleanup() enqueues the delete.
      d1.sqlite
        .prepare("UPDATE external_blocks SET status = 'cancelled' WHERE id = ?")
        .run(blockId);
      return Response.json({
        id: "google_event_ext_stale_1",
        etag: "google_etag_ext_stale_1",
        updated: "2026-06-01T00:00:00.000Z"
      });
    }) as unknown as typeof fetch;

    const result = await processDueCalendarSyncJobs({
      db: d1 as unknown as D1Database,
      env: {
        GOOGLE_SERVICE_ACCOUNT_EMAIL: "calendar-sync@example.iam.gserviceaccount.com",
        GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "unused"
      },
      fetcher: fetchMock,
      accessTokenProvider: async () => "google_access_token",
      now: () => ACTIVE_SYNC_NOW_MS
    });

    // The sweep processes BOTH the original upsert AND the cleanup-enqueued
    // delete (cleanup makes the delete `available_at = now`, so it lands in
    // the same loop iteration).
    expect(result).toEqual({
      processed: 2,
      succeeded: 2,
      failed: 0
    });
    // GET lookup + POST upsert + DELETE cleanup
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const calls = vi.mocked(fetchMock).mock.calls;
    expect((calls[0]?.[1] as RequestInit | undefined)?.method ?? "GET").toBe("GET");
    expect((calls[1]?.[1] as RequestInit | undefined)?.method ?? "POST").toBe("POST");
    expect((calls[2]?.[1] as RequestInit | undefined)?.method).toBe("DELETE");
    expect(String(calls[2]?.[0])).toBe(
      "https://www.googleapis.com/calendar/v3/calendars/calendar-a%40example.invalid/events/google_event_ext_stale_1?sendUpdates=none"
    );

    // The upsert job should be marked succeeded with superseded reason
    const upsertJob = d1.sqlite
      .prepare("SELECT status, last_error FROM calendar_sync_jobs WHERE owner_id = ? AND google_action = 'upsert'")
      .get(blockId) as { status: string; last_error: string | null };
    expect(upsertJob).toEqual({
      status: "succeeded",
      last_error: "superseded_by_external_block_cancellation_after_google_write"
    });

    // The follow-up delete job should also be marked succeeded after the
    // delete call returned 204.
    const deleteJob = d1.sqlite
      .prepare("SELECT status FROM calendar_sync_jobs WHERE owner_id = ? AND google_action = 'delete'")
      .get(blockId) as { status: string };
    expect(deleteJob.status).toBe("succeeded");

    // The audit log should record the supersession
    const auditCount = (
      d1.sqlite
        .prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE target_id = ? AND action = 'google_calendar_external_block_upsert_superseded'")
        .get(blockId) as { count: number }
    ).count;
    expect(auditCount).toBe(1);

    // After both passes, external_blocks.google_event_id should be NULL
    // (the cleanup delete cleared it after the Google delete succeeded).
    const cleanedBlock = d1.sqlite
      .prepare("SELECT google_event_id, google_event_etag FROM external_blocks WHERE id = ?")
      .get(blockId) as { google_event_id: string | null; google_event_etag: string | null };
    expect(cleanedBlock).toEqual({
      google_event_id: null,
      google_event_etag: null
    });
  });

  it("external_block delete: google_event_id overwritten by concurrent upsert does not orphan (issue #121 delete race)", async () => {
    const blockId = "ext_block_delete_race_1";
    d1.sqlite
      .prepare(
        `
          INSERT INTO external_blocks (
            id,
            store_id,
            resource_id,
            source,
            title_snapshot,
            start_at,
            end_at,
            status,
            google_event_id,
            google_event_etag,
            created_by
          ) VALUES (
            ?,
            'kyoto',
            'resource_kyoto_calendar',
            'admin_block',
            '管理画面ブロック',
            '2026-06-01T03:00:00.000Z',
            '2026-06-01T04:00:00.000Z',
            'cancelled',
            'google_ext_event_old_1',
            'google_ext_etag_old_1',
            'admin_owner_1'
          )
        `
      )
      .run(blockId);
    d1.sqlite
      .prepare(
        `
          INSERT INTO google_calendar_events (
            id,
            store_id,
            calendar_id,
            google_event_id,
            external_block_id,
            google_etag,
            google_updated_at,
            source_type,
            status,
            google_safe_snapshot_json
          ) VALUES (
            'google_cal_ext_race_1',
            'kyoto',
            'calendar-a@example.invalid',
            'google_ext_event_old_1',
            ?,
            'google_ext_etag_old_1',
            '2026-06-01T00:00:00.000Z',
            'external_block',
            'active',
            '{}'
          )
        `
      )
      .run(blockId);
    d1.sqlite
      .prepare(
        `
          INSERT INTO calendar_sync_jobs (
            id,
            dedupe_key,
            owner_type,
            owner_id,
            google_action,
            status,
            available_at
          ) VALUES (
            'ext_delete_race_job_1',
            'external_block:ext_block_delete_race_1:google:delete:test',
            'external_block',
            ?,
            'delete',
            'queued',
            '2026-05-09T00:00:00.000Z'
          )
        `
      )
      .run(blockId);

    // Simulate concurrent upsert overwriting google_event_id during the
    // DELETE API call — the same TOCTOU race as the reservation side test
    // "Google delete only NULLs reservation.google_event_id when it still
    // matches the deleted id (codex #10)".
    const fetchMock = vi.fn(async () => {
      d1.sqlite
        .prepare(
          `
            UPDATE external_blocks
            SET google_event_id = 'google_ext_event_new_1',
                google_event_etag = 'google_ext_etag_new_1'
            WHERE id = ?
          `
        )
        .run(blockId);
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;

    const result = await processDueCalendarSyncJobs({
      db: d1 as unknown as D1Database,
      env: {
        GOOGLE_SERVICE_ACCOUNT_EMAIL: "calendar-sync@example.iam.gserviceaccount.com",
        GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "unused"
      },
      fetcher: fetchMock,
      accessTokenProvider: async () => "google_access_token",
      now: () => ACTIVE_SYNC_NOW_MS
    });

    expect(result.processed).toBe(1);
    expect(result.succeeded).toBe(1);
    expect(fetchMock).toHaveBeenCalledOnce();

    // The delete predicate (google_event_id = 'old') should NOT have
    // clobbered the new value written by the concurrent upsert.
    const block = d1.sqlite
      .prepare("SELECT google_event_id, google_event_etag FROM external_blocks WHERE id = ?")
      .get(blockId) as { google_event_id: string | null; google_event_etag: string | null };
    expect(block.google_event_id).toBe("google_ext_event_new_1");
    expect(block.google_event_etag).toBe("google_ext_etag_new_1");
  });

  it("supersedes external_block upsert failures when the block was cancelled during the failed write (issue #121 failure path)", async () => {
    const blockId = "ext_block_fail_supersede_1";
    createExternalBlockWithUpsertJob(blockId, "active");
    // The block is cancelled DURING a failed Google API call.
    const fetchMock = vi.fn(async () => {
      d1.sqlite
        .prepare("UPDATE external_blocks SET status = 'cancelled' WHERE id = ?")
        .run(blockId);
      return Response.json({ error: { message: "temporary outage" } }, { status: 500 });
    }) as unknown as typeof fetch;

    const result = await processDueCalendarSyncJobs({
      db: d1 as unknown as D1Database,
      env: {
        GOOGLE_SERVICE_ACCOUNT_EMAIL: "calendar-sync@example.iam.gserviceaccount.com",
        GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "unused"
      },
      fetcher: fetchMock,
      accessTokenProvider: async () => "google_access_token",
      now: () => ACTIVE_SYNC_NOW_MS,
      maxJobs: 1
    });

    // markCalendarSyncJobFailed should detect the cancelled block and
    // supersede instead of marking retryable.
    expect(result).toEqual({
      processed: 1,
      succeeded: 1,
      failed: 0
    });
    const job = d1.sqlite
      .prepare("SELECT status, last_error FROM calendar_sync_jobs WHERE owner_id = ?")
      .get(blockId) as { status: string; last_error: string | null };
    expect(job).toEqual({
      status: "succeeded",
      last_error: "superseded_by_external_block_cancellation"
    });
  });

  it("existing reservation tests still pass with relocated eligibility helpers (relocation regression guard)", async () => {
    // This test verifies the reservation cleanup path still works after
    // the helpers were moved to calendar-sync-eligibility.ts.
    const reservationId = await createReservationWithGoogleJob();
    const now = vi.fn()
      .mockReturnValueOnce(ACTIVE_SYNC_NOW_MS) // markStaleCalendarSyncClaimsExhausted
      .mockReturnValueOnce(ACTIVE_SYNC_NOW_MS) // loop nowMs
      .mockReturnValueOnce(ACTIVE_SYNC_NOW_MS) // beforeWriteMs
      .mockReturnValue(EXPIRED_SYNC_NOW_MS);   // afterWriteMs
    const fetchMock = googleUpsertFetchMock({
      id: "google_event_relocation_guard_1",
      etag: "google_etag_relocation_guard_1",
      updated: "2026-06-01T00:00:00.000Z"
    });

    const result = await processDueCalendarSyncJobs({
      db: d1 as unknown as D1Database,
      env: {
        GOOGLE_SERVICE_ACCOUNT_EMAIL: "calendar-sync@example.iam.gserviceaccount.com",
        GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "unused"
      },
      fetcher: fetchMock,
      accessTokenProvider: async () => "google_access_token",
      now,
      maxJobs: 1
    });

    expect(result).toEqual({
      processed: 1,
      succeeded: 1,
      failed: 0
    });
    // GET owner-marker lookup + POST create
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // The stale cleanup should still enqueue a follow-up delete
    expect(
      (
        d1.sqlite
          .prepare(
            "SELECT COUNT(*) AS count FROM calendar_sync_jobs WHERE owner_id = ? AND google_action = 'upsert' AND status = 'succeeded' AND last_error = 'superseded_by_reservation_expiry_after_google_write'"
          )
          .get(reservationId) as { count: number }
      ).count
    ).toBe(1);
    expect(
      (
        d1.sqlite
          .prepare("SELECT COUNT(*) AS count FROM calendar_sync_jobs WHERE owner_id = ? AND google_action = 'delete' AND status = 'queued'")
          .get(reservationId) as { count: number }
      ).count
    ).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // Issue #560: owner-marker lookup before POST when google_event_id is NULL
  // ---------------------------------------------------------------------------

  it("PATCHes an existing Google event found by reservation owner markers when google_event_id is NULL (issue #560)", async () => {
    const reservationId = await createReservationWithGoogleJob();
    const existingEventId = "google_event_marker_hit_1";
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "GET") {
        const url = String(input);
        expect(url).toContain("privateExtendedProperty=");
        expect(url).toContain(encodeURIComponent("app=reservation-line-homepage"));
        expect(url).toContain(encodeURIComponent("owner_type=reservation"));
        expect(url).toContain(encodeURIComponent(`reservation_id=${reservationId}`));
        expect(url).not.toContain("showDeleted");
        return Response.json({
          items: [{ id: existingEventId, etag: "etag_marker_1" }]
        });
      }
      if (method === "PATCH") {
        expect(String(input)).toContain(`/events/${encodeURIComponent(existingEventId)}`);
        return Response.json({
          id: existingEventId,
          etag: "etag_marker_1_patched",
          updated: "2026-06-01T00:01:00.000Z"
        });
      }
      throw new Error(`unexpected method ${method}`);
    }) as unknown as typeof fetch;

    const result = await processDueCalendarSyncJobs({
      db: d1 as unknown as D1Database,
      env: {
        GOOGLE_SERVICE_ACCOUNT_EMAIL: "calendar-sync@example.iam.gserviceaccount.com",
        GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "unused"
      },
      fetcher: fetchMock,
      accessTokenProvider: async () => "google_access_token",
      now: () => ACTIVE_SYNC_NOW_MS,
      maxJobs: 1
    });

    expect(result).toEqual({ processed: 1, succeeded: 1, failed: 0 });
    const methods = vi.mocked(fetchMock).mock.calls.map(([, init]) => init?.method ?? "GET");
    expect(methods.filter((m) => m === "PATCH")).toHaveLength(1);
    expect(methods.filter((m) => m === "POST")).toHaveLength(0);
    const reservation = d1.sqlite
      .prepare("SELECT google_event_id FROM reservations WHERE id = ?")
      .get(reservationId) as { google_event_id: string | null };
    expect(reservation.google_event_id).toBe(existingEventId);
  });

  it("POSTs a new Google event when owner-marker lookup returns no items (issue #560)", async () => {
    const reservationId = await createReservationWithGoogleJob();
    const fetchMock = googleUpsertFetchMock({
      id: "google_event_marker_miss_1",
      etag: "etag_marker_miss_1",
      updated: "2026-06-01T00:00:00.000Z"
    });

    const result = await processDueCalendarSyncJobs({
      db: d1 as unknown as D1Database,
      env: {
        GOOGLE_SERVICE_ACCOUNT_EMAIL: "calendar-sync@example.iam.gserviceaccount.com",
        GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "unused"
      },
      fetcher: fetchMock,
      accessTokenProvider: async () => "google_access_token",
      now: () => ACTIVE_SYNC_NOW_MS,
      maxJobs: 1
    });

    expect(result).toEqual({ processed: 1, succeeded: 1, failed: 0 });
    const methods = vi.mocked(fetchMock).mock.calls.map(([, init]) => init?.method ?? "GET");
    expect(methods.filter((m) => m === "GET")).toHaveLength(1);
    expect(methods.filter((m) => m === "POST")).toHaveLength(1);
    expect(methods.filter((m) => m === "PATCH")).toHaveLength(0);
    const reservation = d1.sqlite
      .prepare("SELECT google_event_id FROM reservations WHERE id = ?")
      .get(reservationId) as { google_event_id: string | null };
    expect(reservation.google_event_id).toBe("google_event_marker_miss_1");
  });

  it("does not create a second Google event when post-write D1 persist fails and the job retries (issue #560 regression)", async () => {
    // Reproduces the production path: Google POST succeeds, then D1 batch fails
    // (e.g. weekly D1 export freeze). google_event_id stays NULL; the next tick
    // must PATCH the marker-matched event, never POST again.
    const reservationId = await createReservationWithGoogleJob();
    const createdEventId = "google_event_orphan_dedup_1";
    const googleEvents: Array<{ id: string }> = [];
    let batchFailOnce = true;

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "GET") {
        return Response.json({ items: googleEvents.map((e) => ({ id: e.id })) });
      }
      if (method === "POST") {
        googleEvents.push({ id: createdEventId });
        return Response.json({
          id: createdEventId,
          etag: "etag_orphan_1",
          updated: "2026-06-01T00:00:00.000Z"
        });
      }
      if (method === "PATCH") {
        expect(String(input)).toContain(`/events/${encodeURIComponent(createdEventId)}`);
        return Response.json({
          id: createdEventId,
          etag: "etag_orphan_1_patched",
          updated: "2026-06-01T00:01:00.000Z"
        });
      }
      throw new Error(`unexpected method ${method}`);
    }) as unknown as typeof fetch;

    const batchFailDb = {
      prepare: d1.prepare.bind(d1),
      batch: async (statements: D1PreparedStatement[]) => {
        if (batchFailOnce) {
          batchFailOnce = false;
          throw new Error("D1_ERROR: database is locked during export");
        }
        return d1.batch(statements);
      }
    } as unknown as D1Database;

    await expect(
      processDueCalendarSyncJobs({
        db: batchFailDb,
        env: {
          GOOGLE_SERVICE_ACCOUNT_EMAIL: "calendar-sync@example.iam.gserviceaccount.com",
          GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "unused"
        },
        fetcher: fetchMock,
        accessTokenProvider: async () => "google_access_token",
        now: () => ACTIVE_SYNC_NOW_MS,
        maxJobs: 1
      })
    ).rejects.toThrow(/database is locked during export/);

    const mid = d1.sqlite
      .prepare("SELECT google_event_id, google_sync_state FROM reservations WHERE id = ?")
      .get(reservationId) as { google_event_id: string | null; google_sync_state: string };
    expect(mid).toEqual({
      google_event_id: null,
      google_sync_state: "pending"
    });
    expect(googleEvents).toEqual([{ id: createdEventId }]);

    // Re-queue the claim left in processing after the thrown persist (same shape
    // as locked_until expiry reclaim on the next cron tick).
    d1.sqlite
      .prepare(
        `
          UPDATE calendar_sync_jobs
          SET status = 'queued',
              locked_until = NULL,
              available_at = '2026-05-09T00:00:00.000Z',
              attempts = 1
          WHERE owner_id = ?
            AND google_action = 'upsert'
        `
      )
      .run(reservationId);

    const second = await processDueCalendarSyncJobs({
      db: batchFailDb,
      env: {
        GOOGLE_SERVICE_ACCOUNT_EMAIL: "calendar-sync@example.iam.gserviceaccount.com",
        GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "unused"
      },
      fetcher: fetchMock,
      accessTokenProvider: async () => "google_access_token",
      now: () => ACTIVE_SYNC_NOW_MS + 60_000,
      maxJobs: 1
    });

    expect(second).toEqual({ processed: 1, succeeded: 1, failed: 0 });
    const methods = vi.mocked(fetchMock).mock.calls.map(([, init]) => init?.method ?? "GET");
    // Tick 1: GET (empty) + POST. Tick 2: GET (hit) + PATCH. Never a second POST.
    expect(methods.filter((m) => m === "POST")).toHaveLength(1);
    expect(methods.filter((m) => m === "PATCH")).toHaveLength(1);
    expect(methods.filter((m) => m === "GET")).toHaveLength(2);
    const reservation = d1.sqlite
      .prepare("SELECT google_event_id FROM reservations WHERE id = ?")
      .get(reservationId) as { google_event_id: string | null };
    expect(reservation.google_event_id).toBe(createdEventId);
  });

  // Google documents that an events.list page can come back empty while more
  // results exist, detectable only by a non-empty nextPageToken. Stopping at the
  // first empty page would POST again and recreate the duplicate.
  it("follows nextPageToken before concluding the marker event does not exist (issue #560)", async () => {
    const reservationId = await createReservationWithGoogleJob();
    const existingEventId = "google_event_page_two_1";
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "GET") {
        const url = String(input);
        if (!url.includes("pageToken=")) {
          return Response.json({ items: [], nextPageToken: "page-2" });
        }
        expect(url).toContain("pageToken=page-2");
        expect(url).toContain(encodeURIComponent(`reservation_id=${reservationId}`));
        return Response.json({ items: [{ id: existingEventId }] });
      }
      if (method === "PATCH") {
        expect(String(input)).toContain(`/events/${encodeURIComponent(existingEventId)}`);
        return Response.json({ id: existingEventId, etag: "etag_page_two_1" });
      }
      throw new Error(`unexpected method ${method}`);
    }) as unknown as typeof fetch;

    const result = await processDueCalendarSyncJobs({
      db: d1 as unknown as D1Database,
      env: {
        GOOGLE_SERVICE_ACCOUNT_EMAIL: "calendar-sync@example.iam.gserviceaccount.com",
        GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "unused"
      },
      fetcher: fetchMock,
      accessTokenProvider: async () => "google_access_token",
      now: () => ACTIVE_SYNC_NOW_MS,
      maxJobs: 1
    });

    expect(result).toEqual({ processed: 1, succeeded: 1, failed: 0 });
    const methods = vi.mocked(fetchMock).mock.calls.map(([, init]) => init?.method ?? "GET");
    expect(methods.filter((m) => m === "GET")).toHaveLength(2);
    expect(methods.filter((m) => m === "PATCH")).toHaveLength(1);
    expect(methods.filter((m) => m === "POST")).toHaveLength(0);
  });

  it("fails the job without POST when pagination never proves the event is absent (issue #560)", async () => {
    const reservationId = await createReservationWithGoogleJob();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "GET") {
        // Always another page, never a hit: absence is never proven.
        return Response.json({ items: [], nextPageToken: "endless" });
      }
      throw new Error(`unexpected method ${method}`);
    }) as unknown as typeof fetch;

    const result = await processDueCalendarSyncJobs({
      db: d1 as unknown as D1Database,
      env: {
        GOOGLE_SERVICE_ACCOUNT_EMAIL: "calendar-sync@example.iam.gserviceaccount.com",
        GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "unused"
      },
      fetcher: fetchMock,
      accessTokenProvider: async () => "google_access_token",
      now: () => ACTIVE_SYNC_NOW_MS,
      maxJobs: 1
    });

    expect(result).toEqual({ processed: 1, succeeded: 0, failed: 1 });
    const methods = vi.mocked(fetchMock).mock.calls.map(([, init]) => init?.method ?? "GET");
    expect(methods.filter((m) => m === "POST")).toHaveLength(0);
    expect(methods.filter((m) => m === "PATCH")).toHaveLength(0);
    const reservation = d1.sqlite
      .prepare("SELECT google_event_id FROM reservations WHERE id = ?")
      .get(reservationId) as { google_event_id: string | null };
    expect(reservation.google_event_id).toBeNull();
    const job = d1.sqlite
      .prepare("SELECT last_error FROM calendar_sync_jobs WHERE owner_id = ? AND google_action = 'upsert'")
      .get(reservationId) as { last_error: string | null };
    expect(job.last_error).toBe("google-lookup-incomplete");
  });

  // Google omits empty optional arrays. Rejecting an absent items field would
  // fail EVERY first-time upsert closed — the lookup correctly finds nothing and
  // the job would retry to the dead letter without ever creating the event.
  // import-sync.ts models the same endpoint the same way (`items?: unknown`).
  it("treats an omitted items field as an empty page and POSTs (issue #560)", async () => {
    const reservationId = await createReservationWithGoogleJob();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "GET") {
        return Response.json({});
      }
      return Response.json({
        id: "google_event_items_omitted_1",
        etag: "etag_items_omitted_1",
        updated: "2026-06-01T00:00:00.000Z"
      });
    }) as unknown as typeof fetch;

    const result = await processDueCalendarSyncJobs({
      db: d1 as unknown as D1Database,
      env: {
        GOOGLE_SERVICE_ACCOUNT_EMAIL: "calendar-sync@example.iam.gserviceaccount.com",
        GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "unused"
      },
      fetcher: fetchMock,
      accessTokenProvider: async () => "google_access_token",
      now: () => ACTIVE_SYNC_NOW_MS,
      maxJobs: 1
    });

    expect(result).toEqual({ processed: 1, succeeded: 1, failed: 0 });
    const methods = vi.mocked(fetchMock).mock.calls.map(([, init]) => init?.method ?? "GET");
    expect(methods.filter((m) => m === "POST")).toHaveLength(1);
    expect(methods.filter((m) => m === "PATCH")).toHaveLength(0);
    const reservation = d1.sqlite
      .prepare("SELECT google_event_id FROM reservations WHERE id = ?")
      .get(reservationId) as { google_event_id: string | null };
    expect(reservation.google_event_id).toBe("google_event_items_omitted_1");
  });

  // A malformed token is a broken response, not proof of absence — reading it as
  // "no more pages" is exactly the reading that ends in a duplicate event.
  it("fails the job without POST when nextPageToken is present but malformed (issue #560)", async () => {
    const reservationId = await createReservationWithGoogleJob();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "GET") {
        return Response.json({ items: [], nextPageToken: 42 });
      }
      throw new Error(`unexpected method ${method}`);
    }) as unknown as typeof fetch;

    const result = await processDueCalendarSyncJobs({
      db: d1 as unknown as D1Database,
      env: {
        GOOGLE_SERVICE_ACCOUNT_EMAIL: "calendar-sync@example.iam.gserviceaccount.com",
        GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "unused"
      },
      fetcher: fetchMock,
      accessTokenProvider: async () => "google_access_token",
      now: () => ACTIVE_SYNC_NOW_MS,
      maxJobs: 1
    });

    expect(result).toEqual({ processed: 1, succeeded: 0, failed: 1 });
    const methods = vi.mocked(fetchMock).mock.calls.map(([, init]) => init?.method ?? "GET");
    expect(methods.filter((m) => m === "POST")).toHaveLength(0);
    const reservation = d1.sqlite
      .prepare("SELECT google_event_id FROM reservations WHERE id = ?")
      .get(reservationId) as { google_event_id: string | null };
    expect(reservation.google_event_id).toBeNull();
    const job = d1.sqlite
      .prepare("SELECT last_error FROM calendar_sync_jobs WHERE owner_id = ? AND google_action = 'upsert'")
      .get(reservationId) as { last_error: string | null };
    expect(job.last_error).toBe("invalid-google-response");
  });

  // Order matters: items are scanned BEFORE the token is validated. Once the
  // event is found the lookup has succeeded and the token is irrelevant, so a
  // malformed one on that same page must not fail the job. Extracting the token
  // check into a helper is exactly the refactor that silently inverts this.
  it("PATCHes the found event even when that page's nextPageToken is malformed (issue #560)", async () => {
    const reservationId = await createReservationWithGoogleJob();
    const existingEventId = "google_event_marker_hit_bad_token";
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "GET") {
        return Response.json({
          items: [{ id: existingEventId, etag: "etag_bad_token" }],
          nextPageToken: 42
        });
      }
      if (method === "PATCH") {
        expect(String(input)).toContain(`/events/${encodeURIComponent(existingEventId)}`);
        return Response.json({ id: existingEventId, etag: "etag_bad_token_patched" });
      }
      throw new Error(`unexpected method ${method}`);
    }) as unknown as typeof fetch;

    const result = await processDueCalendarSyncJobs({
      db: d1 as unknown as D1Database,
      env: {
        GOOGLE_SERVICE_ACCOUNT_EMAIL: "calendar-sync@example.iam.gserviceaccount.com",
        GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "unused"
      },
      fetcher: fetchMock,
      accessTokenProvider: async () => "google_access_token",
      now: () => ACTIVE_SYNC_NOW_MS,
      maxJobs: 1
    });

    expect(result).toEqual({ processed: 1, succeeded: 1, failed: 0 });
    const methods = vi.mocked(fetchMock).mock.calls.map(([, init]) => init?.method ?? "GET");
    expect(methods.filter((m) => m === "PATCH")).toHaveLength(1);
    expect(methods.filter((m) => m === "POST")).toHaveLength(0);
    const reservation = d1.sqlite
      .prepare("SELECT google_event_id FROM reservations WHERE id = ?")
      .get(reservationId) as { google_event_id: string | null };
    expect(reservation.google_event_id).toBe(existingEventId);
  });

  // The lookup carries its own deadline so calendar_sync stays inside the 270s
  // CLAIM_TASK_TIMEOUT_MS budget; withOutboundTimeout would otherwise give it
  // the 30s default. See cron-watchdog.ts.
  it("bounds the owner-marker lookup with its own abort signal (issue #560)", async () => {
    await createReservationWithGoogleJob();
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "GET") {
        expect(init?.signal).toBeInstanceOf(AbortSignal);
        return Response.json({ items: [] });
      }
      return Response.json({ id: "google_event_signal_1" });
    }) as unknown as typeof fetch;

    await processDueCalendarSyncJobs({
      db: d1 as unknown as D1Database,
      env: {
        GOOGLE_SERVICE_ACCOUNT_EMAIL: "calendar-sync@example.iam.gserviceaccount.com",
        GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "unused"
      },
      fetcher: fetchMock,
      accessTokenProvider: async () => "google_access_token",
      now: () => ACTIVE_SYNC_NOW_MS,
      maxJobs: 1
    });

    const getCall = vi.mocked(fetchMock).mock.calls.find(([, init]) => (init?.method ?? "GET") === "GET");
    expect(getCall?.[1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it("fails the job without POST or PATCH when owner-marker lookup returns 5xx (issue #560)", async () => {
    const reservationId = await createReservationWithGoogleJob();
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "GET") {
        return Response.json({ error: { message: "backend error" } }, { status: 500 });
      }
      throw new Error(`write must not run after lookup failure (got ${method})`);
    }) as unknown as typeof fetch;

    const result = await processDueCalendarSyncJobs({
      db: d1 as unknown as D1Database,
      env: {
        GOOGLE_SERVICE_ACCOUNT_EMAIL: "calendar-sync@example.iam.gserviceaccount.com",
        GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "unused"
      },
      fetcher: fetchMock,
      accessTokenProvider: async () => "google_access_token",
      now: () => ACTIVE_SYNC_NOW_MS,
      maxJobs: 1
    });

    expect(result).toEqual({ processed: 1, succeeded: 0, failed: 1 });
    const methods = vi.mocked(fetchMock).mock.calls.map(([, init]) => init?.method ?? "GET");
    expect(methods).toEqual(["GET"]);
    const job = d1.sqlite
      .prepare("SELECT status, last_error FROM calendar_sync_jobs WHERE owner_id = ? AND google_action = 'upsert'")
      .get(reservationId) as { status: string; last_error: string | null };
    expect(job).toEqual({
      status: "retryable",
      last_error: "google-http-500"
    });
    const reservation = d1.sqlite
      .prepare("SELECT google_event_id FROM reservations WHERE id = ?")
      .get(reservationId) as { google_event_id: string | null };
    expect(reservation.google_event_id).toBeNull();
  });

  it("PATCHes an existing Google event found by external_block owner markers when google_event_id is NULL (issue #560)", async () => {
    const blockId = "ext_block_marker_hit_1";
    createExternalBlockWithUpsertJob(blockId, "active");
    const existingEventId = "google_ext_marker_hit_1";
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "GET") {
        const url = String(input);
        expect(url).toContain(encodeURIComponent("owner_type=external_block"));
        expect(url).toContain(encodeURIComponent(`external_block_id=${blockId}`));
        return Response.json({
          items: [{ id: existingEventId }]
        });
      }
      if (method === "PATCH") {
        expect(String(input)).toContain(`/events/${encodeURIComponent(existingEventId)}`);
        return Response.json({
          id: existingEventId,
          etag: "etag_ext_marker_1",
          updated: "2026-06-01T00:01:00.000Z"
        });
      }
      throw new Error(`unexpected method ${method}`);
    }) as unknown as typeof fetch;

    const result = await processDueCalendarSyncJobs({
      db: d1 as unknown as D1Database,
      env: {
        GOOGLE_SERVICE_ACCOUNT_EMAIL: "calendar-sync@example.iam.gserviceaccount.com",
        GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "unused"
      },
      fetcher: fetchMock,
      accessTokenProvider: async () => "google_access_token",
      now: () => ACTIVE_SYNC_NOW_MS,
      maxJobs: 1
    });

    expect(result).toEqual({ processed: 1, succeeded: 1, failed: 0 });
    const methods = vi.mocked(fetchMock).mock.calls.map(([, init]) => init?.method ?? "GET");
    expect(methods.filter((m) => m === "PATCH")).toHaveLength(1);
    expect(methods.filter((m) => m === "POST")).toHaveLength(0);
    const block = d1.sqlite
      .prepare("SELECT google_event_id FROM external_blocks WHERE id = ?")
      .get(blockId) as { google_event_id: string | null };
    expect(block.google_event_id).toBe(existingEventId);
  });

  it("exchanges a signed service-account JWT for a Google OAuth access token", async () => {
    const keyPair = await crypto.subtle.generateKey(
      {
        name: "RSASSA-PKCS1-v1_5",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-256"
      },
      true,
      ["sign", "verify"]
    );
    const pkcs8 = await crypto.subtle.exportKey("pkcs8", keyPair.privateKey);
    const privateKey = [
      "-----BEGIN PRIVATE KEY-----",
      Buffer.from(pkcs8).toString("base64").match(/.{1,64}/g)?.join("\n"),
      "-----END PRIVATE KEY-----"
    ].join("\n");
    const fetchMock = vi.fn(async () => Response.json({ access_token: "oauth_token", expires_in: 3600 })) as unknown as typeof fetch;

    const result = await createServiceAccountAccessToken(
      {
        serviceAccountEmail: "calendar-sync@example.iam.gserviceaccount.com",
        privateKey,
        scopes: ["https://www.googleapis.com/auth/calendar.events"]
      },
      fetchMock,
      () => 1_700_000_000_000
    );

    expect(result).toEqual({
      ok: true,
      accessToken: "oauth_token",
      expiresAt: 1_700_003_300_000
    });
    const [url, init] = vi.mocked(fetchMock).mock.calls[0] ?? [];
    expect(url).toBe("https://oauth2.googleapis.com/token");
    expect(init?.method).toBe("POST");
    expect(String(init?.body)).toContain("grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer");
    const assertion = new URLSearchParams(String(init?.body)).get("assertion") ?? "";
    expect(assertion.split(".")).toHaveLength(3);
  });

  it("treats malformed Google service-account token JSON as an invalid token response", async () => {
    const keyPair = await crypto.subtle.generateKey(
      {
        name: "RSASSA-PKCS1-v1_5",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-256"
      },
      true,
      ["sign", "verify"]
    );
    const pkcs8 = await crypto.subtle.exportKey("pkcs8", keyPair.privateKey);
    const privateKey = [
      "-----BEGIN PRIVATE KEY-----",
      Buffer.from(pkcs8).toString("base64").match(/.{1,64}/g)?.join("\n"),
      "-----END PRIVATE KEY-----"
    ].join("\n");
    const fetchMock = vi.fn(async () => new Response("not-json", { status: 200 })) as unknown as typeof fetch;

    const result = await createServiceAccountAccessToken(
      {
        serviceAccountEmail: "calendar-sync@example.iam.gserviceaccount.com",
        privateKey,
        scopes: ["https://www.googleapis.com/auth/calendar.events"]
      },
      fetchMock,
      () => 1_700_000_000_000
    );

    expect(result).toEqual({
      ok: false,
      reason: "invalid_token_response"
    });
  });

  it("reuses cached service-account access tokens until their buffered expiry", async () => {
    const keyPair = await crypto.subtle.generateKey(
      {
        name: "RSASSA-PKCS1-v1_5",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-256"
      },
      true,
      ["sign", "verify"]
    );
    const pkcs8 = await crypto.subtle.exportKey("pkcs8", keyPair.privateKey);
    const privateKey = [
      "-----BEGIN PRIVATE KEY-----",
      Buffer.from(pkcs8).toString("base64").match(/.{1,64}/g)?.join("\n"),
      "-----END PRIVATE KEY-----"
    ].join("\n");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ access_token: "oauth_token_1", expires_in: 3600 }))
      .mockResolvedValueOnce(Response.json({ access_token: "oauth_token_2", expires_in: 3600 }));
    const fetcher = fetchMock as unknown as typeof fetch;
    const input = {
      serviceAccountEmail: "calendar-sync-cache@example.iam.gserviceaccount.com",
      privateKey,
      scopes: ["https://www.googleapis.com/auth/calendar.events"]
    };

    const first = await getCachedServiceAccountAccessToken(input, fetcher, () => 1_700_000_000_000);
    const second = await getCachedServiceAccountAccessToken(input, fetcher, () => 1_700_000_120_000);
    const third = await getCachedServiceAccountAccessToken(input, fetcher, () => 1_700_003_301_000);

    expect(first).toMatchObject({
      ok: true,
      accessToken: "oauth_token_1"
    });
    expect(second).toEqual(first);
    expect(third).toMatchObject({
      ok: true,
      accessToken: "oauth_token_2"
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not reuse cached service-account tokens when the current private key is invalid", async () => {
    const keyPair = await crypto.subtle.generateKey(
      {
        name: "RSASSA-PKCS1-v1_5",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-256"
      },
      true,
      ["sign", "verify"]
    );
    const pkcs8 = await crypto.subtle.exportKey("pkcs8", keyPair.privateKey);
    const privateKey = [
      "-----BEGIN PRIVATE KEY-----",
      Buffer.from(pkcs8).toString("base64").match(/.{1,64}/g)?.join("\n"),
      "-----END PRIVATE KEY-----"
    ].join("\n");
    const fetchMock = vi.fn(async () => Response.json({ access_token: "oauth_token", expires_in: 3600 }));
    const fetcher = fetchMock as unknown as typeof fetch;
    const input = {
      serviceAccountEmail: "calendar-sync-invalid-key@example.iam.gserviceaccount.com",
      privateKey,
      scopes: ["https://www.googleapis.com/auth/calendar.events"]
    };

    const first = await getCachedServiceAccountAccessToken(input, fetcher, () => 1_700_000_000_000);
    const invalidKeyResult = await getCachedServiceAccountAccessToken(
      {
        ...input,
        privateKey: "not-a-valid-private-key"
      },
      fetcher,
      () => 1_700_000_120_000
    );

    expect(first).toMatchObject({
      ok: true,
      accessToken: "oauth_token"
    });
    expect(invalidKeyResult).toEqual({
      ok: false,
      reason: "invalid_service_account"
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
