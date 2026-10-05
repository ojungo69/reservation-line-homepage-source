import { afterEach, describe, it, expect, vi } from "vitest";

const { captureExceptionSpy } = vi.hoisted(() => ({ captureExceptionSpy: vi.fn() }));
vi.mock("@sentry/cloudflare", () => ({
  captureException: captureExceptionSpy,
  init: vi.fn(),
  withSentry: (_opts: unknown, handler: unknown) => handler,
  withMonitor: vi.fn((_slug: string, callback: () => unknown) => callback())
}));

import { sendOperationsNotificationEmail } from "../src/notifications/operations-email";

function createMockSendEmail(result?: { messageId: string }) {
  return {
    send: vi.fn().mockResolvedValue(result ?? { messageId: "msg-123" })
  } as unknown as SendEmail;
}

afterEach(() => {
  captureExceptionSpy.mockClear();
});

// オーナー宛の通知メール。顧客向けのメール予備連絡先は 2026-08-31 に撤去したので、
// この経路 (ワンタイムコード・日次サマリー・LINE 枠アラート) だけが残っている。
describe("sendOperationsNotificationEmail", () => {
  it("escapes the body it embeds in the HTML part", async () => {
    const email = createMockSendEmail();
    const result = await sendOperationsNotificationEmail(
      { EMAIL: email },
      { to: "owner@example.com", subject: "確認コード", text: '<script>alert("xss")</script> & more' }
    );

    expect(result.sent).toBe(true);
    if (result.sent) expect(result.messageId).toBe("msg-123");
    const call = (email.send as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.from).toBe("noreply@example.invalid");
    expect(call.to).toBe("owner@example.com");
    expect(call.html).not.toContain("<script>");
    expect(call.html).toContain("&lt;script&gt;");
    expect(call.html).toContain("&amp; more");
    // テキスト部は素のまま (メールクライアントが解釈しない)。
    expect(call.text).toContain('<script>alert("xss")</script>');
  });

  it("reports a missing EMAIL binding instead of throwing", async () => {
    const result = await sendOperationsNotificationEmail({}, { to: "owner@example.com", subject: "s", text: "t" });

    expect(result).toEqual({ sent: false, reason: "binding_unavailable" });
    // 送れないことに気付けるよう Sentry には上げる。
    expect(captureExceptionSpy).toHaveBeenCalledTimes(1);
  });

  it("returns the failure reason without a timedOut flag when the send rejects", async () => {
    const email = { send: vi.fn().mockRejectedValue(new Error("SMTP refused")) } as unknown as SendEmail;

    const result = await sendOperationsNotificationEmail(
      { EMAIL: email },
      { to: "owner@example.com", subject: "s", text: "t" }
    );

    expect(result).toEqual({ sent: false, reason: "SMTP refused" });
  });

  // 送信バインディングに AbortSignal が無いので、止まった送信は待つのをやめるしかない。
  // 結果は「届いたかどうか不明」なので、呼び出し側が再送しないよう timedOut を立てる。
  it("flags timedOut when env.EMAIL.send stalls past the 15s bound", async () => {
    vi.useFakeTimers();
    try {
      const email = { send: vi.fn(() => new Promise(() => {})) } as unknown as SendEmail;
      const pending = sendOperationsNotificationEmail(
        { EMAIL: email },
        { to: "owner@example.com", subject: "s", text: "t" }
      );
      await vi.advanceTimersByTimeAsync(15_000);

      expect(await pending).toEqual({
        sent: false,
        reason: "email_send_timeout:15000ms",
        timedOut: true
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
