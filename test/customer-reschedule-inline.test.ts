import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { renderCustomerReservationsPage } from "../src/customer/reservations-page";

// キャンセル申請機能の全廃 (2026-08-01。reschedule は 2026-07-24) 後の
// 予約確認ページ契約: 閲覧専用で、申請系 UI・API 呼び出しが一切残らないこと。

describe("customer reservations client (public/customer/reservations.js)", () => {
  const js = readFileSync(join(process.cwd(), "public/customer/reservations.js"), "utf8");
  // 電話対応はしていない (2026-08-30 オーナー確認) ので、案内は LINE 一本。
  // 電話を案内すると、誰も出ない番号にかけさせることになる。
  const guidance =
    "ご予約の変更・キャンセルをご希望の場合は、お手数ですが当店公式LINEのトークからご連絡くださいませ。";

  it("removes every change-request flow (reschedule AND cancel)", () => {
    expect(js).not.toContain("日時変更申請");
    expect(js).not.toContain("キャンセル申請");
    expect(js).not.toContain("openFeeWarning");
    expect(js).not.toContain("withdrawChangeRequest");
    expect(js).not.toContain("submitChangeRequest");
    expect(js).not.toContain("/api/public/change-requests");
    expect(js).not.toContain("/api/public/reschedule-availability");
  });

  it("keeps the read-only list wired to my-reservations with LIFF header tokens", () => {
    expect(js).toContain("/api/public/my-reservations");
    expect(js).toContain("X-LINE-IdToken");
    expect(js).toContain("X-LINE-AccessToken");
    expect(js).toContain("X-LINE-Nonce");
  });

  it("shows the contact-the-store guidance whenever reservations are present", () => {
    expect(js).toContain(guidance);
    expect(js).toContain("change-guidance");
    // 電話番号を案内する経路が残っていないこと。
    expect(js).not.toContain("お電話");
  });

  it("does not use blocking native dialogs suppressed by the LINE WebView", () => {
    for (const nativeDialog of [
      "globalThis.confirm",
      "window.confirm",
      "globalThis.alert",
      "window.alert",
      "globalThis.prompt",
      "window.prompt"
    ]) {
      expect(js).not.toContain(nativeDialog);
    }
  });
});

describe("customer reservations SSR page styling", () => {
  it("is titled as view-only and drops the request-flow styles", () => {
    const html = renderCustomerReservationsPage({ liffId: "1234567890-AbcdEfGh" });
    expect(html).toContain("<h1>予約の確認</h1>");
    expect(html).toContain("<title>予約の確認 | Example Studio</title>");
    expect(html).not.toContain("fee-warning");
    expect(html).not.toContain(".reschedule-date");
    expect(html).not.toContain(".reschedule-slot");
    expect(html).not.toContain(".reschedule-form");
    // Monotone glass migration: styling comes from the shared stylesheet
    // (glass-tokens.css via its @import), never from an inline <style> block.
    // Regex, not substring: `<style media="…">` must fail this too.
    expect(html).toContain('<link rel="stylesheet" href="/styles.css?v=');
    expect(html).not.toMatch(/<style[\s>]/i);
  });
});
