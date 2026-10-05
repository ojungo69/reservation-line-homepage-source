import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { captureExceptionSpy, sendOperationsNotificationEmailSpy } = vi.hoisted(() => ({
  captureExceptionSpy: vi.fn(),
  // 戻り値型を明示する: 推論に任せると {sent: boolean} に広がって
  // 送信失敗 ({sent: false, reason}) を mockResolvedValueOnce で差し込めない。
  sendOperationsNotificationEmailSpy: vi.fn(
    async (): Promise<import("../src/notifications/operations-email").OperationsEmailResult> => ({
      sent: true,
      messageId: "test-message"
    })
  )
}));

vi.mock("@sentry/cloudflare", () => ({
  captureException: captureExceptionSpy,
  init: vi.fn(),
  withSentry: (_opts: unknown, handler: unknown) => handler,
  withMonitor: vi.fn((_slug: string, callback: () => unknown) => callback())
}));

vi.mock("../src/notifications/operations-email", () => ({
  sendOperationsNotificationEmail: sendOperationsNotificationEmailSpy
}));

import {
  fetchLineQuotaUsage,
  getLineMonthlySoftCap,
  isTransientQuotaFetchError,
  jstYearMonth,
  notifyLowLineQuota,
  optionalPushHeadroom,
  readLineQuotaStatus,
  refreshLineQuotaSnapshot,
  type LineQuotaStatus
} from "../src/line/quota";
import { createMigratedSqliteD1, type SqliteD1Database } from "./helpers/sqlite-d1";

const TOKEN = { LINE_MESSAGING_CHANNEL_ACCESS_TOKEN: "tok" };

const quotaFetcher = (opts: { used: number; type?: string; value?: number }) =>
  vi.fn(async (url: unknown) => {
    if (String(url).includes("/quota/consumption")) {
      return Response.json({ totalUsage: opts.used });
    }
    return Response.json({ type: opts.type ?? "limited", value: opts.value ?? 200 });
  }) as unknown as typeof fetch;

// The Sentry capture spy is module-scoped (the mock above is hoisted once per
// file), so clear it before every test across all describe blocks — otherwise a
// capture from one block's fetchLineQuotaUsage call would leak into another's count.
beforeEach(() => {
  captureExceptionSpy.mockClear();
  sendOperationsNotificationEmailSpy.mockClear();
});

describe("line quota helpers", () => {
  it("derives the JST calendar month key", () => {
    // 2026-05-31T16:00:00Z = 2026-06-01 01:00 JST → June.
    expect(jstYearMonth(Date.parse("2026-05-31T16:00:00.000Z"))).toBe("2026-06");
    expect(jstYearMonth(Date.parse("2026-05-31T14:00:00.000Z"))).toBe("2026-05");
  });

  it("reads the soft cap from env with a 180 default", () => {
    expect(getLineMonthlySoftCap({})).toBe(180);
    expect(getLineMonthlySoftCap({ LINE_MONTHLY_PUSH_SOFT_CAP: "120" })).toBe(120);
    expect(getLineMonthlySoftCap({ LINE_MONTHLY_PUSH_SOFT_CAP: "0" })).toBe(180);
    expect(getLineMonthlySoftCap({ LINE_MONTHLY_PUSH_SOFT_CAP: "abc" })).toBe(180);
  });

  it("fetches usage + limit, distinguishing limited vs unlimited plans", async () => {
    await expect(fetchLineQuotaUsage(TOKEN, quotaFetcher({ used: 42, value: 200 }))).resolves.toEqual({
      ok: true,
      used: 42,
      limit: 200
    });
    await expect(fetchLineQuotaUsage(TOKEN, quotaFetcher({ used: 7, type: "none" }))).resolves.toEqual({
      ok: true,
      used: 7,
      limit: null
    });
  });

  it("fails closed without a token and on HTTP errors", async () => {
    await expect(fetchLineQuotaUsage({}, quotaFetcher({ used: 1 }))).resolves.toEqual({
      ok: false,
      reason: "missing_access_token"
    });
    const errorFetcher = vi.fn(async () => new Response("nope", { status: 401 })) as unknown as typeof fetch;
    const result = await fetchLineQuotaUsage(TOKEN, errorFetcher);
    expect(result.ok).toBe(false);
    // A timeout/abort (rejected fetch) is caught and reported as a failure, not thrown.
    const abortFetcher = vi.fn(async () => {
      throw new DOMException("The operation was aborted", "TimeoutError");
    }) as unknown as typeof fetch;
    await expect(fetchLineQuotaUsage(TOKEN, abortFetcher)).resolves.toMatchObject({ ok: false });
  });

  it("computes the optional-push headroom below the soft cap", () => {
    const make = (over: Partial<LineQuotaStatus>): LineQuotaStatus => ({
      used: 0,
      limit: 200,
      remaining: 200,
      softCap: 180,
      asOf: "x",
      ...over
    });
    // No data / unlimited plan → infinite headroom (never suppress).
    expect(optionalPushHeadroom(null)).toBe(Number.POSITIVE_INFINITY);
    expect(optionalPushHeadroom(make({ limit: null }))).toBe(Number.POSITIVE_INFINITY);
    // Below the soft cap → exactly the remaining slots.
    expect(optionalPushHeadroom(make({ used: 179 }))).toBe(1);
    expect(optionalPushHeadroom(make({ used: 150 }))).toBe(30);
    // At/over the soft cap → zero (suppress all optional).
    expect(optionalPushHeadroom(make({ used: 180 }))).toBe(0);
    expect(optionalPushHeadroom(make({ used: 250 }))).toBe(0);
    // A mis-set soft cap above the real limit is clamped to the limit, so optional
    // pushes never run past the hard quota.
    expect(optionalPushHeadroom(make({ softCap: 500, limit: 200, used: 195 }))).toBe(5);
    expect(optionalPushHeadroom(make({ softCap: 500, limit: 200, used: 200 }))).toBe(0);
  });
});

describe("line quota Sentry noise suppression", () => {
  it("classifies transient upstream failures vs genuine ones", () => {
    expect(isTransientQuotaFetchError(new DOMException("aborted", "TimeoutError"))).toBe(true);
    expect(isTransientQuotaFetchError(new DOMException("aborted", "AbortError"))).toBe(true);
    expect(isTransientQuotaFetchError(new Error("line_quota_http_403"))).toBe(true);
    expect(isTransientQuotaFetchError(new Error("line_quota_http_525"))).toBe(true);
    expect(isTransientQuotaFetchError(new Error("line_quota_http_429"))).toBe(true);
    expect(isTransientQuotaFetchError(new Error("line_quota_http_503"))).toBe(true);
    // Genuine / actionable failures must NOT be treated as transient.
    expect(isTransientQuotaFetchError(new Error("line_quota_http_401"))).toBe(false);
    expect(isTransientQuotaFetchError(new Error("line_quota_http_400"))).toBe(false);
    expect(isTransientQuotaFetchError(new SyntaxError("Unexpected token"))).toBe(false);
  });

  it("does NOT capture transient upstream failures (timeout / 403 / 525) to Sentry", async () => {
    const timeoutFetcher = vi.fn(async () => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    }) as unknown as typeof fetch;
    await expect(fetchLineQuotaUsage(TOKEN, timeoutFetcher)).resolves.toMatchObject({ ok: false });
    expect(captureExceptionSpy).not.toHaveBeenCalled();

    const forbiddenFetcher = vi.fn(async () => new Response("", { status: 403 })) as unknown as typeof fetch;
    await expect(fetchLineQuotaUsage(TOKEN, forbiddenFetcher)).resolves.toMatchObject({ ok: false });
    expect(captureExceptionSpy).not.toHaveBeenCalled();

    const edge525Fetcher = vi.fn(async () => new Response("", { status: 525 })) as unknown as typeof fetch;
    await expect(fetchLineQuotaUsage(TOKEN, edge525Fetcher)).resolves.toMatchObject({ ok: false });
    expect(captureExceptionSpy).not.toHaveBeenCalled();
  });

  it("DOES capture genuine failures (401 bad token) to Sentry", async () => {
    const unauthorizedFetcher = vi.fn(async () => new Response("", { status: 401 })) as unknown as typeof fetch;
    const result = await fetchLineQuotaUsage(TOKEN, unauthorizedFetcher);
    expect(result).toMatchObject({ ok: false, reason: "line_quota_http_401" });
    expect(captureExceptionSpy).toHaveBeenCalledTimes(1);
  });
});

describe("line quota snapshot persistence", () => {
  let d1: SqliteD1Database;
  const now = () => Date.parse("2026-05-15T03:00:00.000Z");

  beforeEach(() => {
    d1 = createMigratedSqliteD1();
  });
  afterEach(() => d1.sqlite.close());

  it("upserts the monthly snapshot and reads it back with remaining computed", async () => {
    const status = await refreshLineQuotaSnapshot({
      db: d1 as unknown as D1Database,
      env: TOKEN,
      fetcher: quotaFetcher({ used: 150, value: 200 }),
      now
    });
    expect(status).toMatchObject({ used: 150, limit: 200, remaining: 50, softCap: 180 });

    const read = await readLineQuotaStatus({ db: d1 as unknown as D1Database, env: TOKEN, now });
    expect(read).toMatchObject({ used: 150, limit: 200, remaining: 50 });

    // A second refresh updates the same month row in place (no duplicate).
    await refreshLineQuotaSnapshot({
      db: d1 as unknown as D1Database,
      env: TOKEN,
      fetcher: quotaFetcher({ used: 175, value: 200 }),
      now
    });
    const rows = (d1.sqlite.prepare("SELECT COUNT(*) AS c FROM line_quota_snapshots").get() as { c: number }).c;
    expect(rows).toBe(1);
    const read2 = await readLineQuotaStatus({ db: d1 as unknown as D1Database, env: TOKEN, now });
    expect(read2?.used).toBe(175);
  });

  it("leaves the prior snapshot intact when the LINE API call fails", async () => {
    await refreshLineQuotaSnapshot({
      db: d1 as unknown as D1Database,
      env: TOKEN,
      fetcher: quotaFetcher({ used: 100, value: 200 }),
      now
    });
    const failed = await refreshLineQuotaSnapshot({
      db: d1 as unknown as D1Database,
      env: {},
      fetcher: quotaFetcher({ used: 999 }),
      now
    });
    expect(failed).toBeNull();
    const read = await readLineQuotaStatus({ db: d1 as unknown as D1Database, env: TOKEN, now });
    expect(read?.used).toBe(100);
  });

  it("keeps fresh quota 403 noise out of Sentry but captures it when the snapshot goes stale", async () => {
    const baseNowMs = Date.parse("2026-05-15T03:00:00.000Z");
    await refreshLineQuotaSnapshot({
      db: d1 as unknown as D1Database,
      env: TOKEN,
      fetcher: quotaFetcher({ used: 100, value: 200 }),
      now: () => baseNowMs
    });

    const forbiddenFetcher = vi.fn(async () => new Response("", { status: 403 })) as unknown as typeof fetch;
    captureExceptionSpy.mockClear();
    const freshFailure = await refreshLineQuotaSnapshot({
      db: d1 as unknown as D1Database,
      env: TOKEN,
      fetcher: forbiddenFetcher,
      now: () => baseNowMs + 10 * 60 * 1000
    });
    expect(freshFailure).toBeNull();
    expect(captureExceptionSpy).not.toHaveBeenCalled();

    const staleFailure = await refreshLineQuotaSnapshot({
      db: d1 as unknown as D1Database,
      env: TOKEN,
      fetcher: forbiddenFetcher,
      now: () => baseNowMs + 7 * 60 * 60 * 1000
    });
    expect(staleFailure).toBeNull();
    expect(captureExceptionSpy).toHaveBeenCalledTimes(1);
  });

  it("keeps month-boundary quota 403 noise out of Sentry when the previous snapshot is fresh", async () => {
    const beforeMonthRollMs = Date.parse("2026-05-31T14:50:00.000Z"); // 2026-05-31 23:50 JST.
    await refreshLineQuotaSnapshot({
      db: d1 as unknown as D1Database,
      env: TOKEN,
      fetcher: quotaFetcher({ used: 100, value: 200 }),
      now: () => beforeMonthRollMs
    });

    const forbiddenFetcher = vi.fn(async () => new Response("", { status: 403 })) as unknown as typeof fetch;
    captureExceptionSpy.mockClear();
    const afterMonthRollFailure = await refreshLineQuotaSnapshot({
      db: d1 as unknown as D1Database,
      env: TOKEN,
      fetcher: forbiddenFetcher,
      now: () => Date.parse("2026-05-31T15:10:00.000Z") // 2026-06-01 00:10 JST.
    });
    expect(afterMonthRollFailure).toBeNull();
    expect(captureExceptionSpy).not.toHaveBeenCalled();
  });

  it("returns null when no snapshot exists for the month", async () => {
    const read = await readLineQuotaStatus({ db: d1 as unknown as D1Database, env: TOKEN, now });
    expect(read).toBeNull();
  });

  it("degrades to null (does not throw) when the snapshot table is missing", async () => {
    // Simulate a worker rolled forward before migration 0023 is applied.
    d1.sqlite.exec("DROP TABLE line_quota_snapshots");
    await expect(
      readLineQuotaStatus({ db: d1 as unknown as D1Database, env: TOKEN, now })
    ).resolves.toBeNull();
  });
});

describe("low LINE quota alert", () => {
  let d1: SqliteD1Database;
  const now = () => Date.parse("2026-05-15T03:00:00.000Z");
  const alertEnv = {
    OPERATIONS_NOTIFICATION_EMAIL: "owner@example.com",
    ENVIRONMENT: "production"
  };

  beforeEach(() => {
    d1 = createMigratedSqliteD1();
  });
  afterEach(() => d1.sqlite.close());

  const insertSnapshot = (used: number) => {
    d1.sqlite
      .prepare(
        `INSERT INTO line_quota_snapshots (year_month, total_usage, quota_value, fetched_at)
         VALUES (?, ?, ?, ?)`
      )
      .run("2026-05", used, 200, new Date(now()).toISOString());
  };

  it("残枠が閾値以下ならオペレーションメールを1通送る", async () => {
    insertSnapshot(170);

    await notifyLowLineQuota({
      db: d1 as unknown as D1Database,
      env: alertEnv,
      now
    });

    expect(sendOperationsNotificationEmailSpy).toHaveBeenCalledTimes(1);
    expect(sendOperationsNotificationEmailSpy).toHaveBeenCalledWith(
      alertEnv,
      expect.objectContaining({
        to: "owner@example.com",
        subject: "LINE配信の残りが 30 通になりました"
      })
    );
  });

  // 本文には2つの締切がある: 任意通知(リマインド等)はソフトキャップで止まり、
  // 必須通知(予約確認)は 0 通まで届く。ここを混ぜて「0 通で全部止まる」と書くと
  // オーナーに嘘をつくことになるので、両方が本文に出ることを固定する。
  it("任意通知と必須通知で止まる残枠を分けて書く", async () => {
    insertSnapshot(170); // 上限200・ソフトキャップ既定180 → 抑止開始は残枠20

    await notifyLowLineQuota({ db: d1 as unknown as D1Database, env: alertEnv, now });

    expect(sendOperationsNotificationEmailSpy).toHaveBeenCalledWith(
      alertEnv,
      expect.objectContaining({
        text: expect.stringContaining("残りが 20 通になると")
      })
    );
    expect(sendOperationsNotificationEmailSpy).toHaveBeenCalledWith(
      alertEnv,
      expect.objectContaining({ text: expect.stringContaining("残りが 0 になると") })
    );
  });

  // ソフトキャップが上限以上だと任意通知は最後まで止まらない。その状態で
  // 「残りが 0 通になると任意通知を止めます」と書くと矛盾するので行ごと出さない。
  it("ソフトキャップが上限以上なら任意通知の行を出さない", async () => {
    insertSnapshot(195); // 残枠5。ソフトキャップ250 → 抑止開始は残枠0

    // ソフトキャップは上限「超」にする。上限ちょうど(200)だと Math.min が恒等式に
    // なり、クランプを外しても素通りしてしまう。250 なら未クランプ時の抑止開始は
    // -50、閾値は -40 となり、残枠5でもアラートが鳴らなくなって落ちる。
    await notifyLowLineQuota({
      db: d1 as unknown as D1Database,
      env: { ...alertEnv, LINE_MONTHLY_PUSH_SOFT_CAP: "250" },
      now
    });

    expect(sendOperationsNotificationEmailSpy).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        text: expect.not.stringContaining("などのお知らせを自動的に止めて")
      })
    );
    expect(sendOperationsNotificationEmailSpy).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ text: expect.stringContaining("残りが 0 になると") })
    );
  });

  // 閾値は固定値ではなく「任意 push の抑止が始まる残枠」から導出している。
  // ソフトキャップを下げると抑止が早く始まるので、アラートも早く鳴らないと
  // 「通知が止まる前に知らせる」という目的を外す。境界が動くことを固定する。
  it("ソフトキャップを下げるとアラートの発火点も早くなる", async () => {
    insertSnapshot(100); // 上限200・使用100 = 残枠100。既定のソフトキャップなら鳴らない残枠。
    const lowSoftCapEnv = { ...alertEnv, LINE_MONTHLY_PUSH_SOFT_CAP: "110" };

    await notifyLowLineQuota({ db: d1 as unknown as D1Database, env: alertEnv, now });
    expect(sendOperationsNotificationEmailSpy).not.toHaveBeenCalled();

    await notifyLowLineQuota({ db: d1 as unknown as D1Database, env: lowSoftCapEnv, now });
    expect(sendOperationsNotificationEmailSpy).toHaveBeenCalledTimes(1);
  });

  it("残枠が閾値超のときは送らない", async () => {
    insertSnapshot(169);

    await notifyLowLineQuota({
      db: d1 as unknown as D1Database,
      env: alertEnv,
      now
    });

    expect(sendOperationsNotificationEmailSpy).not.toHaveBeenCalled();
  });

  // スナップショット不在 = 残枠が分からない状態。20:00 JST 時点で10分毎の更新が
  // 約120回走っているはずなので、行が無いのは LINE トークンか更新経路の故障。
  // 黙って return すると「アラートが二度と鳴らない」のに cron は緑になる。
  it("スナップショットが無いときは例外を投げる", async () => {
    await expect(
      notifyLowLineQuota({ db: d1 as unknown as D1Database, env: alertEnv, now })
    ).rejects.toThrow("line_quota_alert_no_snapshot");

    expect(sendOperationsNotificationEmailSpy).not.toHaveBeenCalled();
  });

  // 古いスナップショットは不在より悪い (古い残数を今日の値として書いてしまう)。
  it("スナップショットが古すぎるときは例外を投げる", async () => {
    d1.sqlite
      .prepare(
        `INSERT INTO line_quota_snapshots (year_month, total_usage, quota_value, fetched_at)
         VALUES (?, ?, ?, ?)`
      )
      .run("2026-05", 170, 200, new Date(now() - 2 * 60 * 60 * 1000).toISOString());

    await expect(
      notifyLowLineQuota({ db: d1 as unknown as D1Database, env: alertEnv, now })
    ).rejects.toThrow("line_quota_alert_stale_snapshot");

    expect(sendOperationsNotificationEmailSpy).not.toHaveBeenCalled();
  });

  // staging は本番と同じ LINE トークンと同じ OPERATIONS_NOTIFICATION_EMAIL を持つので、
  // 抑止しないとオーナーに毎日まったく同じ内容のメールが2通届く。
  it.each(["staging", "local"])("%s からはアラートを送らない", async (environment) => {
    insertSnapshot(170);

    await notifyLowLineQuota({
      db: d1 as unknown as D1Database,
      env: { ...alertEnv, ENVIRONMENT: environment },
      now
    });

    expect(sendOperationsNotificationEmailSpy).not.toHaveBeenCalled();
  });

  // fail-open: ENVIRONMENT が読めない状況でアラートまで黙らせると、本番が枯れても
  // 誰も気付けなくなる。denylist に無い値はすべて送る側に倒す。
  it("ENVIRONMENT が未設定でもアラートは送る", async () => {
    insertSnapshot(170);

    await notifyLowLineQuota({
      db: d1 as unknown as D1Database,
      env: { OPERATIONS_NOTIFICATION_EMAIL: "owner@example.com" },
      now
    });

    expect(sendOperationsNotificationEmailSpy).toHaveBeenCalledTimes(1);
  });

  // 宛先が空 = 本番の runtime env / GH secret が飛んだ状態。黙って return すると
  // 「アラートが二度と鳴らない」のに cron は緑のままで、この実装が潰したかった
  // サイレント障害そのものになる。残枠に関係なく毎日 cron を赤にして気づかせる。
  it("OPERATIONS_NOTIFICATION_EMAIL 未設定なら送らずに例外を投げる", async () => {
    insertSnapshot(170);

    await expect(
      notifyLowLineQuota({
        db: d1 as unknown as D1Database,
        env: { ENVIRONMENT: "production" },
        now
      })
    ).rejects.toThrow("line_quota_alert_no_recipient");

    expect(sendOperationsNotificationEmailSpy).not.toHaveBeenCalled();
  });

  // 送信自体が失敗した場合も同じ。結果を捨てると「送ったつもり」で緑になる。
  it("メール送信が失敗したら例外を投げる", async () => {
    insertSnapshot(170);
    sendOperationsNotificationEmailSpy.mockResolvedValueOnce({
      sent: false,
      reason: "binding_unavailable"
    });

    await expect(
      notifyLowLineQuota({ db: d1 as unknown as D1Database, env: alertEnv, now })
    ).rejects.toThrow("binding_unavailable");
  });

  // スナップショットは10分毎にしか更新されないので、その後の送信は total_usage に
  // 入っていない。dispatcher は notification_logs でこの差を補正してから抑止を
  // 判断するため、アラート側が補正しないと「dispatcher はもう止めているのに
  // アラートは余裕があると判断して黙る」ズレが出る。境界そのものを固定する。
  const insertSentLog = (id: string, sentAtMs: number) => {
    // notification_logs.notification_job_id は NOT NULL の FK なので親行が要る。
    d1.sqlite
      .prepare(
        `INSERT INTO notification_jobs (
           id, dedupe_key, template_key, recipient_type, recipient_id,
           status, attempts, available_at, updated_at
         ) VALUES (?, ?, 'reservation_reminder', 'customer', 'U1', 'succeeded', 1, ?, ?)`
      )
      .run(id, `dedupe:${id}`, new Date(sentAtMs).toISOString(), new Date(sentAtMs).toISOString());
    d1.sqlite
      .prepare(
        `INSERT INTO notification_logs (
           id, notification_job_id, template_key, recipient_type, recipient_id,
           attempt, status, sent_count, created_at
         ) VALUES (?, ?, 'reservation_reminder', 'customer', 'U1', 1, 'succeeded', 1, ?)`
      )
      .run(id, id, new Date(sentAtMs).toISOString());
  };

  it("スナップショット取得後の送信を足して閾値をまたぐ", async () => {
    insertSnapshot(169); // 補正前は残枠31 = 閾値30超なので鳴らない
    insertSentLog("log_after_snapshot", now() + 1000);

    await notifyLowLineQuota({ db: d1 as unknown as D1Database, env: alertEnv, now });

    expect(sendOperationsNotificationEmailSpy).toHaveBeenCalledWith(
      alertEnv,
      expect.objectContaining({ subject: "LINE配信の残りが 30 通になりました" })
    );
  });

  // 補正できない = 閾値をまたいだか判断できない。ここで黙って snapshot 値に
  // フォールバックすると、上のケースがそのまま「送らずに cron 緑」になる。
  it("送信数の補正クエリが失敗したら例外を投げる", async () => {
    insertSnapshot(169);
    d1.sqlite.prepare(`DROP TABLE notification_logs`).run();

    await expect(
      notifyLowLineQuota({ db: d1 as unknown as D1Database, env: alertEnv, now })
    ).rejects.toThrow();

    expect(sendOperationsNotificationEmailSpy).not.toHaveBeenCalled();
  });

  // 無制限プランでは limit / remaining が null になる。残枠の概念が無いので
  // 鳴らさずに抜ける (文面に "null" を出さない) 経路を固定する。
  it("無制限プラン (quota_value NULL) では送らない", async () => {
    // fetched_at はわざと2時間前。無制限プランには枯渇する残枠が無いので、
    // 古さを理由に cron を赤くしても意味がない = staleness 判定より前に抜ける、
    // という順序をここで固定する (順序を戻すと stale で reject して落ちる)。
    d1.sqlite
      .prepare(
        `INSERT INTO line_quota_snapshots (year_month, total_usage, quota_value, fetched_at)
         VALUES (?, ?, NULL, ?)`
      )
      .run("2026-05", 170, new Date(now() - 2 * 60 * 60 * 1000).toISOString());

    await notifyLowLineQuota({ db: d1 as unknown as D1Database, env: alertEnv, now });

    expect(sendOperationsNotificationEmailSpy).not.toHaveBeenCalled();
  });
});
