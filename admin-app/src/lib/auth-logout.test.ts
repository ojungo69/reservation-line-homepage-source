import { describe, it, expect, vi, afterEach } from "vitest";
import { ACCESS_LOGOUT_PATH, logout } from "./auth-logout";

describe("auth-logout", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("targets the Cloudflare Access logout endpoint", () => {
    // Guards against accidental path drift; a wrong path would silently no-op logout.
    expect(ACCESS_LOGOUT_PATH).toBe("/cdn-cgi/access/logout");
  });

  it("navigates the window to the Access logout endpoint", () => {
    const location = { href: "" } as { href: string };
    vi.stubGlobal("window", { location });
    logout();
    expect(location.href).toBe("/cdn-cgi/access/logout");
  });
});
