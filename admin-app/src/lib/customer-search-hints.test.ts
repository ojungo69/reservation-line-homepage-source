import { describe, expect, it } from "vitest";
import { needsFullPhoneHint, isShortPhoneQuery } from "./customer-search-hints";

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

describe("isShortPhoneQuery", () => {
  it.each([
    ["0", true], [" 09 ", true], ["(+0) 9", true], ["-", true], ["+8", true],
    ["", false], ["  ", false], ["山", false], ["A1", false], ["１", false], ["１２", false],
    ["0 90", false], ["090-1234", false], ["+81 90-1234-5678", false],
  ])("follows the backend phone-like minimum for %s", (query, expected) => {
    expect(isShortPhoneQuery(query)).toBe(expected);
  });
});
