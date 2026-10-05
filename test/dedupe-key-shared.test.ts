import { describe, expect, it } from "vitest";
import { MAX_DEDUPE_KEY_LENGTH, stableHash, compactDedupeKey } from "../src/google/dedupe-key";
import { __testing__ } from "../src/google/import-sync";

describe("dedupe-key shared module", () => {
  it("returns raw key when length <= MAX_DEDUPE_KEY_LENGTH", () => {
    const shortKey = "reservation:abc:google:upsert:restore:evt1";
    expect(compactDedupeKey(shortKey, "calendar-sync:reservation-restore")).toBe(shortKey);
  });

  it("hashes key when length > MAX_DEDUPE_KEY_LENGTH", () => {
    const longKey = "a".repeat(MAX_DEDUPE_KEY_LENGTH + 1);
    const result = compactDedupeKey(longKey, "test-prefix");
    expect(result.startsWith("test-prefix:")).toBe(true);
    expect(result.length).toBeLessThanOrEqual(MAX_DEDUPE_KEY_LENGTH);
  });

  it("returns raw key at exact boundary (length === MAX_DEDUPE_KEY_LENGTH)", () => {
    const exactKey = "b".repeat(MAX_DEDUPE_KEY_LENGTH);
    expect(compactDedupeKey(exactKey, "prefix")).toBe(exactKey);
  });

  it("produces same output as import-sync __testing__ exports", () => {
    const rawKey = "reservation:rid1:google:upsert:restore:event123";
    expect(stableHash(rawKey)).toBe(__testing__.stableHash(rawKey));
    expect(compactDedupeKey(rawKey, "p")).toBe(__testing__.compactDedupeKey(rawKey, "p"));

    const longRaw = "x".repeat(300);
    expect(compactDedupeKey(longRaw, "p")).toBe(__testing__.compactDedupeKey(longRaw, "p"));
  });

  it("stableHash produces a 16-char hex string", () => {
    const result = stableHash("hello");
    expect(result).toMatch(/^[0-9a-f]{16}$/);
  });
});
