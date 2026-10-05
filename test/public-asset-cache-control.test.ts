import { describe, expect, it } from "vitest";

import {
  isHashedAdminAssetPath,
  isImmutableAdminAssetResponse
} from "../src/index";

const makeResponse = (status: number, contentType: string) =>
  new Response("", {
    status,
    headers: contentType ? { "Content-Type": contentType } : {}
  });

describe("isHashedAdminAssetPath", () => {
  it("accepts vite hash-named JS bundle", () => {
    expect(isHashedAdminAssetPath("/admin-app/assets/index-CzRmV1d8.js")).toBe(true);
  });

  it("accepts vite hash-named CSS bundle", () => {
    expect(isHashedAdminAssetPath("/admin-app/assets/index-CyBtvm9Y.css")).toBe(true);
  });

  it("accepts chunk bundles with multi-segment base name", () => {
    expect(isHashedAdminAssetPath("/admin-app/assets/alert-dialog-RrgFWxUM.js")).toBe(true);
  });

  it("accepts hash segments that contain '-' (real vite output)", () => {
    expect(isHashedAdminAssetPath("/admin-app/assets/label-BJTLg-6Y.js")).toBe(true);
  });

  it("accepts hash segments that contain '_' (real vite output)", () => {
    expect(isHashedAdminAssetPath("/admin-app/assets/shared-ChJ_j-JJ.css")).toBe(true);
  });

  it("rejects index.html under /admin-app/", () => {
    expect(isHashedAdminAssetPath("/admin-app/index.html")).toBe(false);
  });

  it("rejects SPA fallback root", () => {
    expect(isHashedAdminAssetPath("/admin-app/")).toBe(false);
  });

  it("rejects an unhashed root asset", () => {
    expect(isHashedAdminAssetPath("/styles.css")).toBe(false);
  });

  it("rejects hash-like names outside /admin-app/assets/", () => {
    expect(isHashedAdminAssetPath("/admin/foo-abcd1234.js")).toBe(false);
  });

  it("rejects short hash segments (< 8 chars)", () => {
    expect(isHashedAdminAssetPath("/admin-app/assets/index-AbCd123.js")).toBe(false);
  });

  it("rejects unhashed bundle names (no '-' separator)", () => {
    expect(isHashedAdminAssetPath("/admin-app/assets/app.js")).toBe(false);
  });

  it("rejects bundles whose dash sits at the very start", () => {
    expect(isHashedAdminAssetPath("/admin-app/assets/-AbCd1234.js")).toBe(false);
  });

  it("rejects non-js/css extensions even under /admin-app/assets/", () => {
    expect(isHashedAdminAssetPath("/admin-app/assets/index-AbCd1234.html")).toBe(false);
    expect(isHashedAdminAssetPath("/admin-app/assets/index-AbCd1234.json")).toBe(false);
  });
});

describe("isImmutableAdminAssetResponse", () => {
  it("immutable for hashed JS path + 200 + application/javascript", () => {
    expect(
      isImmutableAdminAssetResponse(
        "/admin-app/assets/index-CzRmV1d8.js",
        makeResponse(200, "application/javascript; charset=utf-8")
      )
    ).toBe(true);
  });

  it("immutable for hashed CSS path + 200 + text/css", () => {
    expect(
      isImmutableAdminAssetResponse(
        "/admin-app/assets/index-CyBtvm9Y.css",
        makeResponse(200, "text/css; charset=utf-8")
      )
    ).toBe(true);
  });

  it("immutable accepts text/javascript as JS", () => {
    expect(
      isImmutableAdminAssetResponse(
        "/admin-app/assets/index-CzRmV1d8.js",
        makeResponse(200, "text/javascript")
      )
    ).toBe(true);
  });

  it("immutable normalizes Content-Type case (mixed-case header)", () => {
    expect(
      isImmutableAdminAssetResponse(
        "/admin-app/assets/index-CzRmV1d8.js",
        makeResponse(200, "Application/JavaScript")
      )
    ).toBe(true);
  });

  it("not immutable when path matches but status is 404 (SPA miss)", () => {
    expect(
      isImmutableAdminAssetResponse(
        "/admin-app/assets/missing-AbCd1234.js",
        makeResponse(404, "text/html")
      )
    ).toBe(false);
  });

  it("not immutable when SPA fallback returns HTML on hash-like path", () => {
    expect(
      isImmutableAdminAssetResponse(
        "/admin-app/assets/missing-AbCd1234.js",
        makeResponse(200, "text/html; charset=utf-8")
      )
    ).toBe(false);
  });

  it("not immutable for /admin-app/index.html", () => {
    expect(
      isImmutableAdminAssetResponse(
        "/admin-app/index.html",
        makeResponse(200, "text/html; charset=utf-8")
      )
    ).toBe(false);
  });

  it("not immutable when Content-Type missing", () => {
    expect(
      isImmutableAdminAssetResponse(
        "/admin-app/assets/index-CzRmV1d8.js",
        makeResponse(200, "")
      )
    ).toBe(false);
  });
});
