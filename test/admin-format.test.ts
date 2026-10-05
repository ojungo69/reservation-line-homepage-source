import { describe, expect, it } from "vitest";

import { escapeHtml, labelForLineFriend, labelForStatus } from "../src/admin/format";

describe("escapeHtml", () => {
  it("escapes core HTML entities", () => {
    expect(escapeHtml('<img src=x onerror="alert(1)">'))
      .toBe("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    expect(escapeHtml("a & b")).toBe("a &amp; b");
    expect(escapeHtml("it's")).toBe("it&#39;s");
  });

  it("returns empty string for null/undefined/unsupported types", () => {
    expect(escapeHtml(null)).toBe("");
    expect(escapeHtml(undefined)).toBe("");
    expect(escapeHtml(Symbol("x"))).toBe("");
  });
});

describe("label helpers", () => {
  it("maps known status / line-friend values", () => {
    expect(labelForStatus("pending_approval")).toBe("承認待ち");
    expect(labelForStatus("unknown_status")).toBe("unknown_status");
    expect(labelForLineFriend("friend")).toBe("友だち");
    expect(labelForLineFriend(null)).toBe("不明");
  });
});
