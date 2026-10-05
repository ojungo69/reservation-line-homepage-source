import { describe, it, expect } from "vitest";
import { ALL_VALUE, toSelectValue, fromSelectValue } from "./store-select";

describe("StoreSelect sentinel", () => {
  it("null（全店舗）とセンチネルを相互変換する", () => {
    expect(toSelectValue(null)).toBe(ALL_VALUE);
    expect(fromSelectValue(ALL_VALUE)).toBeNull();
  });

  it("実店舗 ID はそのまま通す", () => {
    expect(toSelectValue("store-1")).toBe("store-1");
    expect(fromSelectValue("store-1")).toBe("store-1");
  });

  it("ID が偶然 'all' でもセンチネルと衝突しない（codex P2 回帰）", () => {
    // 旧実装のセンチネルは "all" で、id="all" の店舗を選ぶと null に化けて
    // その店舗を絞り込めなかった。__all__ 化で round-trip が保たれる。
    expect(fromSelectValue("all")).toBe("all");
    expect(fromSelectValue(toSelectValue("all"))).toBe("all");
  });
});
