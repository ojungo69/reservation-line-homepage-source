/**
 * LIFF-served SSR for the customer "予約の確認" page (view-only since the
 * change-request feature retirement on 2026-08-01).
 *
 * The HTML carries no customer data; the runtime fetches /api/public/my-reservations
 * after the LIFF SDK is initialised (see public/customer/reservations.js).
 *
 * The PUBLIC_LIFF_CSP middleware applies the looser CSP only to this exact path
 * (see src/security-headers.ts + app middleware). Other public paths keep STRICT_CSP.
 */

import { INSTANCE_CONFIG } from "../instance-config";

const stringifyHtmlValue = (value: unknown): string => {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return `${value}`;
  }
  return "";
};

const escapeHtml = (value: unknown): string =>
  // Complete manual HTML-entity escaping (covers & < > " ') is the correct approach
  // for SSR string interpolation in a Cloudflare Worker — there is no DOM/template
  // engine to delegate to. Used here only on the trusted LIFF id.
  // nosemgrep: javascript.audit.detect-replaceall-sanitization.detect-replaceall-sanitization
  stringifyHtmlValue(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

export type CustomerReservationsPageInput = {
  liffId: string;
};

export function renderCustomerReservationsPage(input: CustomerReservationsPageInput): string {
  const liffIdEscaped = escapeHtml(input.liffId);
  return `<!doctype html>
<html lang="ja">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="line-liff-id" content="${liffIdEscaped}" />
    <title>予約の確認 | ${escapeHtml(INSTANCE_CONFIG.displayName)}</title>
    <link rel="modulepreload" href="/customer/reservations.js" />
    <link rel="stylesheet" href="/styles.css?v=20260802-glass-2" />
  </head>
  <body class="customer-reservations-page">
    <main>
      <p class="page-nav"><a href="/">&lsaquo; 新しく予約する</a></p>
      <h1>予約の確認</h1>
      <div class="surface" id="status-banner" aria-live="polite"></div>
      <section id="reservations" aria-busy="true">
        <p class="muted">読み込み中…</p>
      </section>
      <nav class="legal-nav" aria-label="規約・ポリシー">
        <a href="/legal/terms">利用規約</a>
        <a href="/legal/privacy">プライバシーポリシー</a>
        <a href="/legal/cancellation">キャンセルポリシー</a>
        <a href="/legal/tokusho">特定商取引法に基づく表記</a>
      </nav>
    </main>
    <script src="https://static.line-scdn.net/liff/edge/2/sdk.js" defer></script>
    <script type="module" src="/customer/reservations.js"></script>
  </body>
</html>`;
}
