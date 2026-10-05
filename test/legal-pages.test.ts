import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { resolvePublicConsentVersions } from "../src/reservations/public-options";

// The five published legal documents under public/legal/. These are the pages the
// consent checkboxes (and the page footer) link to — if one goes missing, the
// consent flow silently degrades to checkbox-without-text again.
const PAGES = {
  terms: "public/legal/terms.html",
  notice: "public/legal/notice.html",
  cancellation: "public/legal/cancellation.html",
  privacy: "public/legal/privacy.html",
  tokusho: "public/legal/tokusho.html"
} as const;

const read = (relPath: string) => readFileSync(join(process.cwd(), relPath), "utf8");

describe("legal document pages", () => {
  const html = Object.fromEntries(
    Object.entries(PAGES).map(([key, relPath]) => [key, read(relPath)])
  ) as Record<keyof typeof PAGES, string>;

  it("ships all five documents with their headings", () => {
    expect(html.terms).toContain("<h1>利用規約</h1>");
    expect(html.notice).toContain("<h1>予約前確認事項</h1>");
    expect(html.cancellation).toContain("<h1>キャンセルポリシー</h1>");
    expect(html.privacy).toContain("<h1>プライバシーポリシー</h1>");
    expect(html.tokusho).toContain("<h1>特定商取引法に基づく表記</h1>");
  });

  it("displays the same consent versions the server records (single source of truth)", () => {
    // The submit path records the SERVER-resolved canonical versions (see
    // resolvePublicConsentVersions). The published pages must show the same
    // version strings, or the recorded consent would point at a different
    // document revision than the customer actually read.
    const versions = resolvePublicConsentVersions({});
    expect(html.terms).toContain(versions.notice);
    expect(html.notice).toContain(versions.notice);
    expect(html.cancellation).toContain(versions.cancellationPolicy);
    expect(html.privacy).toContain(versions.privacyPolicy);
    // The minor consent records its own version — the section the checkbox
    // links to (#minor-guardian) must display that exact string.
    expect(html.notice).toContain(versions.minorGuardian);
  });

  it("keeps the documents cross-linked and routed back to the booking page", () => {
    for (const [key, page] of Object.entries(html)) {
      const others = Object.entries(PAGES).filter(([otherKey]) => otherKey !== key);
      for (const [otherKey] of others) {
        // Canonical asset URLs are extension-less: wrangler assets html_handling
        // 307-redirects /legal/terms.html → /legal/terms, so pages link the
        // canonical form directly.
        expect(page, `${key} page missing link to ${otherKey}`).toContain(`href="/legal/${otherKey}"`);
      }
      expect(page, `${key} page missing back-link to booking page`).toContain('href="/"');
    }
  });

  it("anchors the minor-guardian section the consent checkbox links to", () => {
    expect(html.notice).toContain('id="minor-guardian"');
  });

  it("gives cancellation-fee amounts a reachable price reference", () => {
    // The booking system itself shows no prices, so a 100% cancellation fee is
    // meaningless unless the page points at the published price list.
    expect(html.cancellation).toContain("https://example.invalid/menu/");
    expect(html.tokusho).toContain("https://example.invalid/menu/");
  });

  it("routes inquiries (incl. disclosure requests) to the direct contact page", () => {
    for (const [key, page] of Object.entries(html)) {
      expect(page, `${key} page missing direct contact link`).toContain(
        "https://example.invalid/contact/"
      );
    }
  });

  it("opens external links in a new tab (LIFF/webview back-navigation)", () => {
    // In LINE's in-app browser, a same-tab jump to the official site strands the
    // reader with no easy way back to the legal document.
    for (const [key, page] of Object.entries(html)) {
      const externals = page.match(/<a href="https:\/\/[^"]*"[^>]*>/g) ?? [];
      expect(externals.length, `${key} page has no external links`).toBeGreaterThan(0);
      for (const anchor of externals) {
        expect(anchor, `${key} external link missing target=_blank`).toContain('target="_blank"');
        expect(anchor, `${key} external link missing rel=noopener`).toContain('rel="noopener"');
      }
    }
  });

  it("states the operator identity required by the privacy framework", () => {
    for (const page of [html.privacy, html.tokusho]) {
      expect(page).toContain("ExampleStudio（架空のサンプル事業者）");
      expect(page).toContain("［運営者の代表者名を記入］");
      expect(page).toContain("［運営者の所在地を記入］");
    }
    // 2022 APPI amendment: foreign processing must name the countries involved.
    expect(html.privacy).toContain("保存・処理される国");
  });

  it("keeps internal review notes out of the published documents", () => {
    for (const [key, page] of Object.entries(html)) {
      for (const marker of ["弁護士", "ドラフト", "TODO", "FIXME", "ひな形", "法的助言ではありません"]) {
        expect(page, `${key} page leaks internal note: ${marker}`).not.toContain(marker);
      }
    }
  });

  it("keeps the documents script-free and delegates CSP to the worker response header", () => {
    for (const [key, page] of Object.entries(html)) {
      expect(page, `${key} page must not carry a fixed CSP`).not.toContain(
        'http-equiv="Content-Security-Policy"'
      );
      expect(page, `${key} page must not embed scripts`).not.toContain("<script");
      expect(page, `${key} page must not use inline styles (style-src 'self')`).not.toContain("<style");
    }
  });
});
