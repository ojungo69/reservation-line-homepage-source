import { describe, expect, it } from "vitest";

import { CACHE_KEYS } from "../src/cache/kv-cache";

describe("public catalog cache keys", () => {
  it("exposes only the all-stores key used by the public catalog", () => {
    expect(Object.keys(CACHE_KEYS)).toEqual(["allStores"]);
    expect(CACHE_KEYS.allStores()).toBe("all-stores");
  });
});
