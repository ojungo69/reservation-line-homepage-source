import { describe, expect, it } from "vitest";
import { lineFriendStatusLabel } from "@/lib/line-friend-label";

describe("lineFriendStatusLabel", () => {
  it("relabels blocked as LINE未友だち (not ブロック/ブロック中)", () => {
    expect(lineFriendStatusLabel("blocked")).toBe("LINE未友だち");
  });

  it("maps the other known statuses", () => {
    expect(lineFriendStatusLabel("friend")).toBe("友だち");
    expect(lineFriendStatusLabel("not_friend")).toBe("未友だち");
    expect(lineFriendStatusLabel("unknown")).toBe("不明");
  });

  it("returns 不明 for null/undefined/empty", () => {
    expect(lineFriendStatusLabel(null)).toBe("不明");
    expect(lineFriendStatusLabel(undefined)).toBe("不明");
    expect(lineFriendStatusLabel("")).toBe("不明");
  });

  it("passes through an unrecognized status string unchanged", () => {
    expect(lineFriendStatusLabel("future_value")).toBe("future_value");
  });
});
