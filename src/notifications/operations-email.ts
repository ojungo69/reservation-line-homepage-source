import { escapeHtml } from "../admin/format";
import { safeCaptureException } from "../sentry-helpers";
import { INSTANCE_CONFIG } from "../instance-config";

// オーナー宛の通知メールだけを送る。顧客向けのメール予備連絡先は 2026-08-31 に撤去した
// (本番の顧客 199 人が全員未登録で、一度も送られていない)。ここに顧客宛の送信を
// 足し戻すときは、`customers.email` の入力経路と同意の扱いから作り直すこと。

const SENDER = INSTANCE_CONFIG.operationsEmailSender;

/**
 * `notification_jobs.recipient_id` for owner email jobs. Each logical owner
 * notification is enqueued once, while the NOT NULL column stores this sentinel
 * instead of an email address or LINE user ID.
 */
export const OWNER_EMAIL_RECIPIENT_ID = "email:owner";

export type OperationsEmailResult =
  | { sent: true; messageId: string }
  // `timedOut` is set only when the send raced past EMAIL_SEND_TIMEOUT_MS. The
  // outcome is then UNKNOWN (the provider may yet deliver), so the caller MUST
  // treat it as terminal-non-retryable to avoid a duplicate owner email.
  | { sent: false; reason: string; timedOut?: boolean };

// Upper bound for a single env.EMAIL.send() RPC. The Cloudflare send_email
// binding exposes no AbortSignal, so a stalled send would otherwise block the
// maintenance cron's whole Promise.all for the full 7-minute watchdog (one of
// the two unbounded non-fetch awaits behind the chronic */10 cron hang). A
// healthy send returns in well under a second; 15s is consistent with the
// codebase's other bounded awaits (withOutboundTimeout 30s, DO acquire 10s).
const EMAIL_SEND_TIMEOUT_MS = 15_000;

/**
 * Race a single EMAIL.send() against a timeout. Modeled on `acquireWithTimeout`
 * (line/notifications.ts): the timer is always cleared in `finally` so a fast
 * send leaves no timer tail. A fired timeout does NOT cancel the in-flight send
 * (the binding has no AbortSignal) — it only stops the caller from waiting, so
 * the outcome is treated as UNKNOWN by the caller.
 */
const sendWithTimeout = async (
  email: SendEmail,
  message: { from: string; to: string; subject: string; html: string; text: string },
  timeoutMs: number = EMAIL_SEND_TIMEOUT_MS
): Promise<{ messageId: string }> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`email_send_timeout:${timeoutMs}ms`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([email.send(message), timeout]);
  } finally {
    clearTimeout(timer);
  }
};

export async function sendOperationsNotificationEmail(
  env: { EMAIL?: SendEmail },
  params: { to: string; subject: string; text: string }
): Promise<OperationsEmailResult> {
  if (!env.EMAIL) {
    safeCaptureException(new Error("operations_email_binding_unavailable"), {
      tags: { component: "ops-email-mirror", outcome: "binding_unavailable" }
    });
    return { sent: false, reason: "binding_unavailable" };
  }

  try {
    const result = await sendWithTimeout(env.EMAIL, {
      from: SENDER,
      to: params.to,
      subject: params.subject,
      html: `<!doctype html><html><body><pre style="white-space:pre-wrap;font-family:sans-serif">${escapeHtml(params.text)}</pre></body></html>`,
      text: params.text
    });
    return { sent: true, messageId: result?.messageId ?? "" };
  } catch (err: unknown) {
    const reason = err instanceof Error ? err.message : String(err);
    const timedOut = reason.startsWith("email_send_timeout:");
    safeCaptureException(err instanceof Error ? err : new Error(reason), {
      tags: {
        component: "ops-email-mirror",
        outcome: timedOut ? "send_timeout" : "send_failed"
      }
    });
    return timedOut
      ? { sent: false, reason, timedOut: true }
      : { sent: false, reason };
  }
}
