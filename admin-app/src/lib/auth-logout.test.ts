import { describe, it, expect } from "vitest";
import * as authLogout from "./auth-logout";

describe("auth-logout", () => {
  it("targets the Cloudflare Access logout endpoint", () => {
    // Guards against accidental path drift; a wrong path would silently no-op logout.
    expect(authLogout.ACCESS_LOGOUT_PATH).toBe("/cdn-cgi/access/logout");
  });

  it("does not export an unused imperative logout action", () => {
    expect(authLogout).not.toHaveProperty("logout");
  });
});
