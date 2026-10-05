import { describe, expect, it } from "vitest";

import { ADMIN_SPA_CSP } from "../src/security-headers";

describe("ADMIN_SPA_CSP — LINE profile images", () => {
  it("img-src allows the LINE profile image CDN (目視照合のアイコン表示)", () => {
    expect(ADMIN_SPA_CSP).toContain("img-src 'self' data: https://profile.line-scdn.net https://*.line-scdn.net");
  });

  // PR-D: 顧客カルテの「LINEと紐付け」ダイアログでも友だちアイコンを LINE CDN から表示する。
  // CSP が LINE CDN ワイルドカードを許可し続けることを固定(将来 img-src を絞った時の検知用)。
  it("img-src keeps the LINE CDN wildcard (顧客カルテのLINE紐付けダイアログのアイコン表示)", () => {
    expect(ADMIN_SPA_CSP).toContain("https://*.line-scdn.net");
  });
});

// Web Push。どちらのディレクティブも省略すると default-src 'none' にフォールバック
// して manifest 取得と Service Worker 登録が無言でブロックされる(エラーは出るが
// 「通知を受け取る」を押しても何も起きないだけに見える)。
describe("ADMIN_SPA_CSP — PWA (Web Push)", () => {
  it("manifest-src allows the web app manifest", () => {
    expect(ADMIN_SPA_CSP).toContain("manifest-src 'self'");
  });

  it("worker-src allows the service worker", () => {
    expect(ADMIN_SPA_CSP).toContain("worker-src 'self'");
  });
});
