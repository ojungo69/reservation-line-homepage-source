import type { WorkerBindings } from "../bindings";
import { sendOperationsNotificationEmail } from "../notifications/operations-email";
import { safeCaptureException } from "../sentry-helpers";

// LINE Messaging API quota endpoints. On the free Communication plan the monthly
// limit is 200 *push-type* messages (reply messages are free and NOT counted).
//   GET /v2/bot/message/quota             → { type: "none"|"limited", value?: number }
//   GET /v2/bot/message/quota/consumption → { totalUsage: number }
// (`/v2/bot/message/sent` does NOT exist — do not use it.)
const LINE_QUOTA_ENDPOINT = "https://api.line.me/v2/bot/message/quota";
const LINE_QUOTA_CONSUMPTION_ENDPOINT = "https://api.line.me/v2/bot/message/quota/consumption";

const DEFAULT_SOFT_CAP = 180;
export const LINE_MONTHLY_QUOTA_EXHAUSTED = "line-monthly-quota-exhausted";

// Non-production environments currently share the PRODUCTION Messaging API
// channel access token (.env.staging and .env.production hold the same value),
// so anything derived from that channel must not act outside production: a push
// issued from staging reaches REAL customers and burns the real monthly quota,
// and a quota alert raised from staging double-mails the owner (both env files
// also share OPERATIONS_NOTIFICATION_EMAIL).
//
// ponytail: a denylist, not `!== "production"`. Fail-open is the correct
// direction here — the catastrophic failures are production going silent and
// production never alerting, not a staging send slipping through.
// `environment.test.ts` pins every ENVIRONMENT value declared in wrangler.jsonc
// against this Set, so adding a fourth environment without listing it fails CI
// rather than leaking a send. Once staging has its own channel, drop "staging"
// from this Set — NOT the whole Set: "local" points at the production channel
// too, and a dev machine must never be able to message a real customer.
export const LINE_SHARED_CHANNEL_ENVIRONMENTS = new Set(["staging", "local"]);

// Bound the quota fetch so a slow/hung LINE quota API cannot stall the maintenance
// cron (refresh runs before dispatch). On timeout the fetch aborts → best-effort
// null → dispatch continues with the previous snapshot.
const QUOTA_FETCH_TIMEOUT_MS = 5_000;
const QUOTA_FORBIDDEN_STALE_MS = 6 * 60 * 60 * 1000;

export type LineQuotaUsage =
  | { ok: true; used: number; limit: number | null }
  | { ok: false; reason: string };

export type LineQuotaStatus = {
  used: number;
  limit: number | null;
  remaining: number | null;
  softCap: number;
  asOf: string;
};

type QuotaEnv = Partial<Pick<WorkerBindings, "LINE_MESSAGING_CHANNEL_ACCESS_TOKEN" | "LINE_MONTHLY_PUSH_SOFT_CAP">>;

/** Calendar month key in JST (Asia/Tokyo), e.g. "2026-05" — the LINE quota resets monthly. */
export const jstYearMonth = (nowMs: number): string => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit"
  }).formatToParts(new Date(nowMs));
  const year = parts.find((p) => p.type === "year")?.value ?? "0000";
  const month = parts.find((p) => p.type === "month")?.value ?? "00";
  return `${year}-${month}`;
};

/** Soft cap below the hard 200 limit at which optional (non-transactional) pushes are suppressed. */
export const getLineMonthlySoftCap = (env: QuotaEnv): number => {
  const raw = typeof env.LINE_MONTHLY_PUSH_SOFT_CAP === "string" ? env.LINE_MONTHLY_PUSH_SOFT_CAP.trim() : "";
  if (raw.length === 0) return DEFAULT_SOFT_CAP;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_SOFT_CAP;
};

const fetchJson = async (url: string, token: string, fetcher: typeof fetch): Promise<unknown> => {
  const response = await fetcher(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(QUOTA_FETCH_TIMEOUT_MS)
  });
  if (!response.ok) {
    throw new Error(`line_quota_http_${response.status}`);
  }
  return response.json();
};

/**
 * A quota-fetch failure that is transient and outside our control, so it is NOT
 * worth a Sentry exception (the refresh degrades to the previous snapshot either
 * way — availability over accuracy). Covers:
 *   - the 5s `AbortSignal.timeout` firing (DOMException name "TimeoutError"),
 *   - HTTP 403 from quota-only endpoints that can be intermittently denied
 *     even while the Messaging API token is valid,
 *   - HTTP 429 (LINE rate limiting), and
 *   - any 5xx, including Cloudflare's 52x edge errors such as 525 (SSL handshake
 *     failed between Cloudflare and the LINE API origin).
 * NON-transient failures (401 bad/expired token, 400, JSON parse) stay captured
 * so genuine misconfiguration still surfaces.
 */
export const isTransientQuotaFetchError = (err: unknown): boolean => {
  const name =
    typeof err === "object" && err !== null && "name" in err
      ? String(err.name)
      : "";
  if (name === "TimeoutError" || name === "AbortError") return true;
  const message = err instanceof Error ? err.message : String(err);
  return /^line_quota_http_(?:403|429|5\d\d)$/.test(message);
};

/** Query LINE for the current month's quota limit and push-type consumption. */
export const fetchLineQuotaUsage = async (env: QuotaEnv, fetcher: typeof fetch = fetch): Promise<LineQuotaUsage> => {
  const token = env.LINE_MESSAGING_CHANNEL_ACCESS_TOKEN;
  if (!token) {
    return { ok: false, reason: "missing_access_token" };
  }
  try {
    const [quota, consumption] = await Promise.all([
      fetchJson(LINE_QUOTA_ENDPOINT, token, fetcher) as Promise<{ type?: string; value?: number }>,
      fetchJson(LINE_QUOTA_CONSUMPTION_ENDPOINT, token, fetcher) as Promise<{ totalUsage?: number }>
    ]);
    const limit = quota?.type === "limited" && typeof quota.value === "number" ? quota.value : null;
    const used = typeof consumption?.totalUsage === "number" ? consumption.totalUsage : 0;
    return { ok: true, used, limit };
  } catch (err: unknown) {
    // Classify on the ORIGINAL throw (isTransientQuotaFetchError accepts unknown):
    // wrapping a non-Error throw in new Error(String(err)) would overwrite its
    // `name` with "Error" and mask a transient { name: "TimeoutError" }-style value.
    const transient = isTransientQuotaFetchError(err);
    const error = err instanceof Error ? err : new Error(String(err));
    // Don't report expected transient upstream failures (timeout / 403 / 429 / 5xx
    // incl. Cloudflare 525) here. 403 is re-escalated by refreshLineQuotaSnapshot
    // if the persisted snapshot becomes stale. Genuine failures (e.g. 401) are still captured.
    if (!transient) {
      safeCaptureException(error, { tags: { component: "line-quota" } });
    }
    return { ok: false, reason: error.message };
  }
};

const readLatestQuotaSnapshotFetchedAtMs = async (
  db: D1Database
): Promise<{ ok: true; fetchedAtMs: number | null } | { ok: false }> => {
  try {
    const row = await db
      .prepare(`SELECT fetched_at FROM line_quota_snapshots ORDER BY fetched_at DESC LIMIT 1`)
      .first<{ fetched_at: string }>();
    if (!row) return { ok: true, fetchedAtMs: null };
    const fetchedAtMs = Date.parse(row.fetched_at);
    return { ok: true, fetchedAtMs: Number.isFinite(fetchedAtMs) ? fetchedAtMs : null };
  } catch (err: unknown) {
    safeCaptureException(err instanceof Error ? err : new Error(String(err)), {
      tags: { component: "line-quota", op: "snapshot_freshness_read" }
    });
    return { ok: false };
  }
};

/**
 * Refresh the persisted monthly snapshot from the LINE API. Best-effort: on any
 * failure it leaves the previous snapshot intact and returns null (callers must
 * NOT block notification dispatch on quota refresh — availability over accuracy).
 */
export const refreshLineQuotaSnapshot = async (input: {
  db: D1Database;
  env: QuotaEnv;
  fetcher?: typeof fetch;
  now?: () => number;
}): Promise<LineQuotaStatus | null> => {
  const now = input.now ?? Date.now;
  const nowMs = now();
  const usage = await fetchLineQuotaUsage(input.env, input.fetcher ?? fetch);
  if (!usage.ok) {
    if (usage.reason === "line_quota_http_403") {
      const latestSnapshot = await readLatestQuotaSnapshotFetchedAtMs(input.db);
      const snapshotStale =
        latestSnapshot.ok &&
        (latestSnapshot.fetchedAtMs === null || nowMs - latestSnapshot.fetchedAtMs >= QUOTA_FORBIDDEN_STALE_MS);
      if (snapshotStale) {
        safeCaptureException(new Error(usage.reason), {
          tags: { component: "line-quota", op: "quota_fetch_forbidden_stale" }
        });
      }
    }
    return null;
  }

  const yearMonth = jstYearMonth(nowMs);
  const fetchedAt = new Date(nowMs).toISOString();
  try {
    await input.db
      .prepare(
        `INSERT INTO line_quota_snapshots (year_month, total_usage, quota_value, fetched_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(year_month) DO UPDATE SET
           total_usage = excluded.total_usage,
           quota_value = excluded.quota_value,
           fetched_at = excluded.fetched_at`
      )
      .bind(yearMonth, usage.used, usage.limit, fetchedAt)
      .run();
  } catch (err: unknown) {
    safeCaptureException(err instanceof Error ? err : new Error(String(err)), {
      tags: { component: "line-quota", op: "snapshot_write" }
    });
    return null;
  }

  return toStatus({ used: usage.used, limit: usage.limit, fetchedAt }, input.env);
};

const toStatus = (
  snapshot: { used: number; limit: number | null; fetchedAt: string },
  env: QuotaEnv
): LineQuotaStatus => {
  const remaining = snapshot.limit === null ? null : Math.max(0, snapshot.limit - snapshot.used);
  return {
    used: snapshot.used,
    limit: snapshot.limit,
    remaining,
    softCap: getLineMonthlySoftCap(env),
    asOf: snapshot.fetchedAt
  };
};

/** Read the current month's persisted quota snapshot (no LINE API call). */
export const readLineQuotaStatus = async (input: {
  db: D1Database;
  env: QuotaEnv;
  now?: () => number;
}): Promise<LineQuotaStatus | null> => {
  const now = input.now ?? Date.now;
  const yearMonth = jstYearMonth(now());
  // Degrade safely if the 0023 table is missing (worker rolled forward before the
  // migration is applied, or an env lags) — returning null keeps every LINE
  // dispatch and the admin endpoint working with no suppression, rather than
  // crashing the whole notification pipeline on a missing table.
  let row: { total_usage: number; quota_value: number | null; fetched_at: string } | null = null;
  try {
    row = await input.db
      .prepare(
        `SELECT total_usage, quota_value, fetched_at FROM line_quota_snapshots WHERE year_month = ? LIMIT 1`
      )
      .bind(yearMonth)
      .first<{ total_usage: number; quota_value: number | null; fetched_at: string }>();
  } catch (err: unknown) {
    safeCaptureException(err instanceof Error ? err : new Error(String(err)), {
      tags: { component: "line-quota", op: "snapshot_read" }
    });
    return null;
  }
  if (!row) return null;
  return toStatus({ used: row.total_usage, limit: row.quota_value, fetchedAt: row.fetched_at }, input.env);
};

/**
 * How many optional (non-transactional) pushes may still be sent this month
 * before the soft cap, reserving the remaining headroom for transactional pushes.
 * `Infinity` when there is no known limit / no snapshot (never suppress on missing
 * data). Used per-sweep so a single large batch (e.g. the reminder cron) cannot
 * blow past the soft cap in one go — the dispatcher counts each optional send
 * against this budget and suppresses the rest.
 */
export const optionalPushHeadroom = (status: LineQuotaStatus | null): number => {
  // Split into two guards (instead of `status?.limit == null`): the optional-chain
  // form would not narrow `status` to non-null for the `status.softCap`/`status.used`
  // reads below, so it cannot satisfy both S6582 and the type checker at once.
  if (!status) return Number.POSITIVE_INFINITY;
  if (status.limit === null) return Number.POSITIVE_INFINITY;
  // Clamp the soft cap to the actual LINE limit so a mis-set soft cap (or a lower
  // limited-plan value than expected) can never let optional pushes run past the
  // hard monthly quota.
  const effectiveCap = Math.min(status.softCap, status.limit);
  return Math.max(0, effectiveCap - status.used);
};

/**
 * LINE sends already recorded since the snapshot was taken. The snapshot is only
 * refreshed on the ten-minute cron, so anything sent inside the current tick is
 * missing from `status.used`.
 *
 * Shared deliberately: the dispatcher subtracts this from its optional-push
 * headroom, so the low-quota alert has to subtract the same figure or it reads a
 * larger budget than the dispatcher acts on — staying quiet through the exact
 * window where reminders have already started being suppressed.
 *
 * Rejects on query failure; each caller decides how to degrade.
 */
export const countLineSendsSince = async (db: D1Database, asOf: string): Promise<number> => {
  const row = await db
    .prepare(`SELECT COALESCE(SUM(sent_count), 0) AS sent FROM notification_logs WHERE datetime(created_at) >= datetime(?)`)
    .bind(asOf)
    .first<{ sent: number }>();
  return row?.sent ?? 0;
};

// Warning margin ABOVE the point where optional (non-transactional) pushes start
// being suppressed, so the alert lands before reminders begin going missing.
// Derived rather than fixed: suppression begins once `used` reaches the soft cap,
// i.e. while `remaining` is still `limit - softCap`, and the soft cap is
// env-tunable (LINE_MONTHLY_PUSH_SOFT_CAP). A hard-coded threshold would silently
// start firing too late the moment that cap is lowered. With the defaults
// (limit 200, soft cap 180) this resolves to the expected "alert at 30 left".
//
// Email, not LINE: alerting over the channel that is running dry cannot work.
const LOW_QUOTA_ALERT_LEAD = 10;

// 6× the ten-minute snapshot refresh. Long enough to ride out a few transient
// LINE 429/5xx refreshes (refreshLineQuotaSnapshot swallows those and returns
// null), short enough that a stuck refresh is caught the same day.
//
// This depends on the */10 refresh actually running: it sits in that branch's
// sequential prelude AFTER the reminder dispatch, so before the B8 fix in
// src/index.ts a reminder failure skipped it entirely. Reverting B8 without
// revisiting this would turn the daily cron red on stale data instead.
const LOW_QUOTA_SNAPSHOT_MAX_AGE_MS = 60 * 60 * 1000;

/**
 * Low-quota alert, called once a day from the `5 16 * * *` daily-cleanup cron
 * (01:05 JST). Reads the snapshot the ten-minute refreshLineQuotaSnapshot already
 * persisted, so it makes no LINE API call. Re-sends every day while the quota
 * stays below the threshold (it keeps ringing until resolved).
 *
 * That cron rather than the `0 11 * * *` summary one specifically because this
 * branch sends no LINE messages: a sibling that pushes while this reads would
 * hide a threshold crossing until the next day (see the callsite in index.ts).
 *
 * Rejects when the alert itself could not be delivered (no recipient, or the
 * Email binding refused the send). This alert exists to break a silent failure,
 * so swallowing its own failure would recreate one: the cron would stay green
 * while the owner heard nothing. The fan-out is allSettled-based, so rejecting
 * here marks the cron red without costing the sibling tasks.
 */
export const notifyLowLineQuota = async (input: {
  db: D1Database;
  env: QuotaEnv & { EMAIL?: SendEmail; OPERATIONS_NOTIFICATION_EMAIL?: string; ENVIRONMENT?: string };
  now?: () => number;
}): Promise<void> => {
  // Only the environment that owns the channel alerts on it — staging shares
  // both the LINE token and OPERATIONS_NOTIFICATION_EMAIL with production and
  // would otherwise send the owner a duplicate of this mail every day.
  if (LINE_SHARED_CHANNEL_ENVIRONMENTS.has(input.env.ENVIRONMENT ?? "")) return;
  const to = input.env.OPERATIONS_NOTIFICATION_EMAIL?.trim();
  if (!to) {
    // Not an opt-out. Production sets this address and the whole owner ops-mail
    // path depends on it, so an empty value means a runtime-env / GH-secret
    // drift wiped it — a failure this repo has already hit three times. Checked
    // BEFORE the threshold so the drift surfaces on the next daily cron rather
    // than months later, at the one moment the alert was finally needed.
    throw new Error("line_quota_alert_no_recipient");
  }
  const status = await readLineQuotaStatus({ db: input.db, env: input.env, now: input.now });
  if (!status) {
    // readLineQuotaStatus degrades to null for BOTH "no snapshot yet" and "the
    // read failed". Either way the remaining budget is unknown, and by 01:05 JST
    // the ten-minute refresh has had ~140 chances to write this month's row — an
    // absent one means the LINE token or the refresh itself is broken. Returning
    // quietly here is the failure this alert exists to prevent, one level up.
    //
    // Triage note: this is a once-a-day read with no same-day retry, so a single
    // transient D1 read error (the kind outbound-timeout.ts documents as observed
    // here) also lands as this reason and reddens the cron until tomorrow. One
    // occurrence that clears on the next run is that; a repeat is a real fault.
    throw new Error("line_quota_alert_no_snapshot");
  }
  const { limit, softCap, asOf } = status;
  // Unlimited plan: both values are null and there is no budget to run out of, so
  // leave before the checks below rather than printing "null" — and before the
  // staleness check too, since a stale figure cannot matter without a limit.
  // Destructuring also narrows `limit` to number for the arithmetic that follows.
  if (limit === null || status.remaining === null) return;
  // A stale snapshot is worse than none: the mail would state a stale figure as
  // today's. Bound at 6× the ten-minute refresh interval so a couple of transient
  // 429/5xx refresh failures stay quiet while a persistently stuck one goes red.
  const ageMs = (input.now?.() ?? Date.now()) - Date.parse(asOf);
  if (!Number.isFinite(ageMs) || ageMs > LOW_QUOTA_SNAPSHOT_MAX_AGE_MS) {
    throw new Error(`line_quota_alert_stale_snapshot: ${asOf}`);
  }
  // Fold in sends the snapshot is too old to know about, matching what the
  // dispatcher does before it suppresses. Without this the alert can report a
  // healthy 31 remaining while optional pushes have already stopped.
  //
  // Deliberately NOT caught. Falling back to the raw snapshot figure looks like a
  // safe degradation but is the false green this whole change exists to remove:
  // at used=169 with one send logged since, the corrected remaining is 30 (send
  // the alert) and the uncorrected one is 31 (return silently, cron green). The
  // dispatcher keeps its best-effort catch because failing closed THERE would
  // stop customer notifications; failing closed here only reddens a cron.
  const used = status.used + (await countLineSendsSince(input.db, asOf));
  const remaining = Math.max(0, limit - used);
  // `Math.min` mirrors optionalPushHeadroom: a soft cap set above the real limit
  // never suppresses anything, so the floor is 0 rather than negative.
  const suppressionFloor = limit - Math.min(softCap, limit);
  if (remaining > suppressionFloor + LOW_QUOTA_ALERT_LEAD) return;
  // Two different cut-offs, so say so: optional pushes stop at the soft cap while
  // transactional ones run to zero. "0 通で全部止まる" would be wrong — reminders
  // go quiet well before that, which is the surprise worth warning about.
  const body = [
    `今月のLINE配信の残りが ${remaining} 通になりました（今月の送信 ${used} 通 / 上限 ${limit} 通）。`,
    ""
  ];
  // Present tense once a cut-off is already crossed. The alert repeats daily from
  // the threshold down to 0, so a fixed "…になると" would still describe an active
  // outage as a future risk on the day delivery actually stops — the one day the
  // mail has to read as more urgent than the first.
  if (suppressionFloor > 0) {
    body.push(
      remaining <= suppressionFloor
        ? "現在、前日のリマインドなどのお知らせは自動的に停止しています。ご予約の確認メッセージのために枠を残しています。"
        : `残りが ${suppressionFloor} 通になると、前日のリマインドなどのお知らせを自動的に止めて、ご予約の確認メッセージのために枠を残します。`
    );
  }
  body.push(
    remaining === 0
      ? "残りが 0 通のため、ご予約の確認メッセージもお客様に届かない状態です。"
      : "残りが 0 になると、ご予約の確認メッセージもお客様に届かなくなります。",
    // Not "追加購入": the free Communication plan has no message add-on, so the
    // only recovery is a paid plan or waiting for the month to roll over.
    "LINE Official Account Manager で有料プランへ変更いただくか、月が変わるまで配信をお控えください。",
    "",
    // LINE's totalUsage is documented as an approximate figure.
    "※ 通数はLINEの集計値のため目安です。正確な残数は LINE Official Account Manager でご確認ください。"
  );
  const result = await sendOperationsNotificationEmail(input.env, {
    to,
    subject: `LINE配信の残りが ${remaining} 通になりました`,
    text: body.join("\n")
  });
  if (!result.sent) {
    throw new Error(`line_quota_alert_email_failed: ${result.reason}`);
  }
};
