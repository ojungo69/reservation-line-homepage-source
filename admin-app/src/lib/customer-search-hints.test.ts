import { describe, expect, it } from "vitest";
import { needsFullPhoneHint } from "./customer-search-hints";

describe("needsFullPhoneHint", () => {
  it.each([
    { query: "1234", isStaff: false, expected: false },
    { query: "09012345678", isStaff: true, expected: false },
    { query: "架空 花子", isStaff: true, expected: false },
    { query: "1234", isStaff: true, expected: true },
    { query: " 1234 ", isStaff: true, expected: true },
    { query: "123", isStaff: true, expected: true },
    { query: "1234567890", isStaff: true, expected: true },
    { query: "12", isStaff: true, expected: false },
    { query: "", isStaff: true, expected: false },
    { query: "090-1234", isStaff: true, expected: false },
  ])("$query / staff=$isStaff の全桁案内は $expected", ({ query, isStaff, expected }) => {
    expect(needsFullPhoneHint(query, isStaff)).toBe(expected);
  });
});
