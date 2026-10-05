import type { LineRateLimiter } from "./line/rate-limiter-do";

export interface WorkerBindings {
  DB: D1Database;
  CACHE?: KVNamespace;
  STORAGE?: R2Bucket;
  METRICS?: AnalyticsEngineDataset;
  EMAIL?: SendEmail;
  ASSETS: Fetcher;
  GOOGLE_SYNC_QUEUE: Queue<unknown>;
  LINE_NOTIFICATION_QUEUE: Queue<unknown>;
  LINE_RATE_LIMITER?: DurableObjectNamespace<LineRateLimiter>;
  ENVIRONMENT: string;
  SPEC_VERSION: string;
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;
  LINE_CHANNEL_ID: string;
  LINE_LIFF_ID: string;
  LINE_CHANNEL_SECRET: string;
  LINE_OFFICIAL_ACCOUNT_ID: string;
  LINE_MESSAGING_CHANNEL_ACCESS_TOKEN: string;
  GOOGLE_CALENDAR_WEBHOOK_URL: string;
  GOOGLE_IMPORT_ENABLED: string;
  GOOGLE_LIVE_AVAILABILITY_ENABLED: string;
  GOOGLE_SERVICE_ACCOUNT_EMAIL: string;
  GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: string;
  TURNSTILE_SECRET_KEY: string;
  TURNSTILE_SITE_KEY: string;
  TURNSTILE_EXPECTED_HOSTNAME: string;
  TURNSTILE_EXPECTED_ACTION: string;
  RESERVATION_NOTICE_VERSION: string;
  RESERVATION_CANCELLATION_POLICY_VERSION: string;
  RESERVATION_PRIVACY_POLICY_VERSION: string;
  RESERVATION_MINOR_GUARDIAN_VERSION: string;
  RESERVATION_DUPLICATE_WARNING_VERSION: string;
  LINE_OPERATIONS_USER_IDS: string;
  OPERATIONS_NOTIFICATION_EMAIL: string;
  // 既存顧客の予約申込 (pending_approval_created) の primary 宛先。
  // 空のときは OPERATIONS_NOTIFICATION_EMAIL を primary として使う。
  // OPERATIONS_NOTIFICATION_EMAIL が primary と異なる場合は初回試行のみ常時ミラー
  // (best-effort・成否は primary 基準)。同一アドレスなら二重送信しない。
  PENDING_APPROVAL_OWNER_EMAIL: string;
  /**
   * 管理画面 Web Push の VAPID 公開鍵 (base64url)。SPA が購読するときに使うため
   * `GET /api/admin/me` でそのまま配る。空 = Push 機能 OFF。
   */
  VAPID_PUBLIC_KEY?: string;
  /**
   * VAPID 秘密鍵 (PKCS#8 を base64url にしたもの)。secret。staging / production で
   * 別の鍵ペアを使う。値をログ・レスポンス・Sentry へ出してはならない。
   */
  VAPID_PRIVATE_KEY?: string;
  /** Soft cap (default 180) below the free-plan 200/month at which optional pushes pause. */
  LINE_MONTHLY_PUSH_SOFT_CAP?: string;
  GOOGLE_DRIFT_ALERT_LIVE: string;
  GOOGLE_CONFLICT_BURST_ALERT_LIVE: string;
  RESERVATION_REMINDER_DISPATCH_ENABLED: string;
  SENTRY_DSN: string;
  SENTRY_TRACES_SAMPLE_RATE_OVERRIDE?: string;
  MAINTENANCE_MODE?: string;
  /** Secret kill switch managed only by the emergency runtime override workflow. */
  EMERGENCY_D1_FREEZE?: string;
  DAILY_OPS_SUMMARY_DISPATCH_ENABLED?: string;
  STAGING_SERVICE_TOKEN_AUTH?: string;
  CF_VERSION_METADATA?: WorkerVersionMetadata;
  D1_SESSION_ENABLED?: string;
  CSV_ARCHIVE_ENABLED?: string;
  RESERVATION_WORKFLOW?: Workflow;
  WORKFLOW_ENABLED?: string;
}
