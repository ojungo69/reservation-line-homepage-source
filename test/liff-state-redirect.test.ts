import { describe, expect, it } from "vitest";

import { buildLiffStateRedirect } from "../src/index";

const ORIGIN = "https://example.workers.dev";

const url = (path: string, query?: string): URL =>
  new URL(`${ORIGIN}${path}${query ? `?${query}` : ""}`);

const expectRedirect = (response: Response | null, location: string): void => {
  expect(response).not.toBeNull();
  expect(response).toBeInstanceOf(Response);
  const res = response as Response;
  expect(res.status).toBe(302);
  expect(res.headers.get("Location")).toBe(location);
  expect(res.headers.get("Cache-Control")).toBe("no-store");
  expect(res.headers.get("Referrer-Policy")).toBe("no-referrer");
};

describe("buildLiffStateRedirect", () => {
  describe("redirects valid liff.state queries on root path", () => {
    it("returns 302 to the embedded path", () => {
      const u = url("/", "liff.state=%2Fcustomer%2Freservations");
      expectRedirect(buildLiffStateRedirect(u), "/customer/reservations");
    });

    it("preserves query string embedded in liff.state", () => {
      const u = url("/", "liff.state=%2Fcustomer%2Freservations%3Ffrom%3Dline%26r%3D1");
      expectRedirect(
        buildLiffStateRedirect(u),
        "/customer/reservations?from=line&r=1"
      );
    });

    it("preserves URL fragment embedded in liff.state", () => {
      const u = url("/", "liff.state=%2Fcustomer%2Freservations%23section");
      expectRedirect(
        buildLiffStateRedirect(u),
        "/customer/reservations#section"
      );
    });

    it("drops liff.* parameters but does not include them in the target", () => {
      const u = url(
        "/",
        "liff.state=%2Fcustomer%2Freservations&liff.referrer=https%3A%2F%2Fline.me%2F&liff.tracking_id=abc"
      );
      expectRedirect(buildLiffStateRedirect(u), "/customer/reservations");
    });

    it("preserves non-liff endpoint query params on the redirect target", () => {
      const u = url(
        "/",
        "store=kyoto&liff.state=%2Fcustomer%2Freservations"
      );
      expectRedirect(
        buildLiffStateRedirect(u),
        "/customer/reservations?store=kyoto"
      );
    });

    it("merges endpoint params with the path query embedded in liff.state", () => {
      const u = url(
        "/",
        "store=kyoto&liff.state=%2Fcustomer%2Freservations%3Flang%3Dja"
      );
      const res = buildLiffStateRedirect(u);
      expect(res).not.toBeNull();
      const location = (res as Response).headers.get("Location");
      expect(location).toMatch(/^\/customer\/reservations\?/);
      const search = new URLSearchParams(location!.split("?", 2)[1]);
      expect(search.get("lang")).toBe("ja");
      expect(search.get("store")).toBe("kyoto");
    });

    it("lets the path-embedded query win on key conflicts", () => {
      const u = url(
        "/",
        "store=kyoto&liff.state=%2Fcustomer%2Freservations%3Fstore%3Dosaka"
      );
      expectRedirect(
        buildLiffStateRedirect(u),
        "/customer/reservations?store=osaka"
      );
    });
  });

  describe("returns null when redirect must not fire", () => {
    it("returns null when liff.state is absent", () => {
      expect(buildLiffStateRedirect(url("/"))).toBeNull();
    });

    it("returns null when liff.state is empty", () => {
      expect(buildLiffStateRedirect(url("/", "liff.state="))).toBeNull();
    });

    it("returns null when pathname is not /", () => {
      expect(
        buildLiffStateRedirect(url("/customer/reservations", "liff.state=%2Felsewhere"))
      ).toBeNull();
    });

    it("returns null when pathname has any non-root prefix", () => {
      expect(buildLiffStateRedirect(url("/admin", "liff.state=%2F"))).toBeNull();
    });
  });

  describe("rejects unsafe liff.state values", () => {
    it("rejects values missing the leading slash", () => {
      expect(
        buildLiffStateRedirect(url("/", "liff.state=customer%2Freservations"))
      ).toBeNull();
    });

    it("rejects protocol-relative paths (//host)", () => {
      expect(
        buildLiffStateRedirect(url("/", "liff.state=%2F%2Fevil.example.com%2Fphish"))
      ).toBeNull();
    });

    it("rejects backslash-prefixed paths (/\\host)", () => {
      expect(
        buildLiffStateRedirect(url("/", "liff.state=%2F%5Cevil.example.com%2Fphish"))
      ).toBeNull();
    });

    it("rejects javascript: scheme", () => {
      expect(
        buildLiffStateRedirect(url("/", "liff.state=javascript%3Aalert(1)"))
      ).toBeNull();
    });

    it("rejects data: scheme", () => {
      expect(
        buildLiffStateRedirect(url("/", "liff.state=data%3Atext%2Fhtml%2C%3Cscript%3Ealert(1)%3C%2Fscript%3E"))
      ).toBeNull();
    });

    it("rejects http: scheme", () => {
      expect(
        buildLiffStateRedirect(url("/", "liff.state=http%3A%2F%2Fevil.example.com"))
      ).toBeNull();
    });

    it("rejects ASCII control characters", () => {
      expect(
        buildLiffStateRedirect(url("/", "liff.state=%2Fcustomer%0Areservations"))
      ).toBeNull();
    });

    it("rejects CR characters used for header injection", () => {
      expect(
        buildLiffStateRedirect(url("/", "liff.state=%2Fcustomer%0Dreservations"))
      ).toBeNull();
    });

    it("rejects values that resolve to a different origin", () => {
      // Even if validation accepted, origin must equal request origin.
      // Use a value that bypasses surface checks but is constructed cross-origin
      // via percent-encoded slashes; verifies the second-line defence.
      const u = url("/", "liff.state=%2F%09%2Fevil.example.com");
      expect(buildLiffStateRedirect(u)).toBeNull();
    });

    it("rejects values that normalize to a protocol-relative pathname (/..//evil)", () => {
      expect(
        buildLiffStateRedirect(url("/", "liff.state=%2F..%2F%2Fevil.example.com"))
      ).toBeNull();
    });

    it("rejects deeper path-traversal that normalizes to // (/a/..//evil)", () => {
      expect(
        buildLiffStateRedirect(url("/", "liff.state=%2Fa%2F..%2F%2Fevil.example.com"))
      ).toBeNull();
    });

    it("rejects percent-encoded dot-segments that normalize to // (/%2e%2e//evil)", () => {
      expect(
        buildLiffStateRedirect(url("/", "liff.state=%2F%252e%252e%2F%2Fevil.example.com"))
      ).toBeNull();
    });

    it("rejects nested percent-encoded dot-segments (/a/%2e%2e//evil)", () => {
      expect(
        buildLiffStateRedirect(url("/", "liff.state=%2Fa%2F%252e%252e%2F%2Fevil.example.com"))
      ).toBeNull();
    });
  });
});
