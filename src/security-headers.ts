/**
 * Phase 3 — shared Content-Security-Policy constants.
 *
 * Extracted from src/app.ts and src/index.ts so both modules can pick a CSP
 * without taking a circular `src/app.ts` ⇄ `src/index.ts` dependency. The
 * middleware in createApp() chooses one of these per request path; the worker
 * entrypoint in src/index.ts applies PUBLIC_ASSET_CSP to ASSETS responses.
 */

export const STRICT_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

// The admin service worker (served at /admin/sw.js) must be able to re-register
// its push subscription from INSIDE the worker on `pushsubscriptionchange` —
// that event fires when no admin page is open, so the page-level reconcile
// cannot cover it. connect-src 'self' is the only opening over STRICT_CSP;
// everything else stays locked down.
export const ADMIN_SW_CSP =
  "default-src 'none'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

export const CLOUDFLARE_WEB_ANALYTICS_SCRIPT =
  "https://static.cloudflareinsights.com/beacon.min.js";

export const withFreshCspNonce = (policy: string): string => {
  const nonce = crypto.randomUUID().replaceAll("-", "");
  return policy.replace(
    /(^|;\s*)script-src\s+/,
    `$1script-src 'nonce-${nonce}' `
  );
};

export const ADMIN_SPA_CSP = [
  "default-src 'none'",
  `script-src 'self' ${CLOUDFLARE_WEB_ANALYTICS_SCRIPT}`,
  "style-src 'self' 'unsafe-inline'",
  // LINE friend avatars (LINE友だち紐付け page) are served from the LINE profile
  // image CDN; allow it the same way PUBLIC_LIFF_CSP does so the visual matching
  // (display name + icon) works under the admin SPA CSP.
  "img-src 'self' data: https://profile.line-scdn.net https://*.line-scdn.net",
  "font-src 'self'",
  "connect-src 'self'",
  // Web Push (管理画面をホーム画面に追加した PWA 向け). Both directives fall back
  // to default-src 'none' when omitted, which silently blocks the manifest fetch
  // and — depending on the browser's worker-src fallback chain — the service
  // worker registration too. Spell them out rather than relying on a fallback
  // that differs between engines.
  "manifest-src 'self'",
  "worker-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join("; ");

// CSP applied to /customer/reservations SSR HTML. It uses the same LINE
// origins as the public reservation page's response-header CSP so the LIFF SDK
// script and LINE API calls load under the same allow-list.
export const PUBLIC_LIFF_CSP = [
  "default-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  `script-src 'self' https://static.line-scdn.net https://*.line-scdn.net ${CLOUDFLARE_WEB_ANALYTICS_SCRIPT}`,
  // 'unsafe-inline' stays AFTER the 002-monotone-glass inline-CSS removal
  // (decision record: specs/002-monotone-glass/research.md R13). Our own markup
  // no longer carries style attributes/<style> (enforced by
  // test/design-tokens-parity.test.ts), but whether the LIFF SDK injects inline
  // style attributes at runtime cannot be proven outside a real LIFF login, and
  // dropping it blind risks breaking the customer page. Pinned (no further
  // widening) by test/customer-line-csp.test.ts; remove only after a real-device
  // pass on /customer/reservations with style-src 'self' shows zero violations.
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https://profile.line-scdn.net https://*.line-scdn.net",
  "connect-src 'self' https://api.line.me https://liff-api.line.me https://access.line.me https://liff.line.me https://*.line.me https://*.line-scdn.net",
  "frame-src https://access.line.me https://liff.line.me https://line.me https://*.line.me",
  "object-src 'none'"
].join("; ");

// ── HSTS (Strict-Transport-Security) ────────────────────────────────
// Declared here (not edge config) so the header is version-controlled and
// covered by tests. Applied at the outermost fetch boundary in
// src/index.ts so EVERY response — app routes, static assets, redirects,
// and bare 404s — carries it. Custom domains terminate TLS at Cloudflare,
// so the header is only ever emitted over HTTPS.
//
// `includeSubDomains` is safe here: the header is served on
// reserve./admin.example.invalid, so it only constrains *their* nested
// subdomains (none exist). The apex (separate Pages site) is unaffected
// by a subdomain's header. `preload` is intentionally omitted —
// preload-list inclusion requires the header on the apex and is
// effectively irreversible, so it must be an explicit owner decision.
export const HSTS_HEADER_NAME = "Strict-Transport-Security";
export const HSTS_HEADER_VALUE = "max-age=31536000; includeSubDomains";
