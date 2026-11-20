import { describe, expect, it } from "vitest";
import { swipeAxis, swipeStep, wheelPx, wheelStep } from "./swipe";

describe("swipeAxis（INT-13-01・02、INT-04-03）", () => {
  it("動いた量が 12px に届くまでは向きを決めない", () => {
    expect(swipeAxis(11, 0)).toBeNull();
    expect(swipeAxis(-8, 8)).toBeNull();
  });

  it("横の動きが縦の 1.5 倍以上なら横にする", () => {
    expect(swipeAxis(-12, 0)).toBe("x");
    expect(swipeAxis(15, -10)).toBe("x");
  });

  it("それ以外は縦にして、ブラウザのスクロールに任せる", () => {
    expect(swipeAxis(14, 10)).toBe("y");
    expect(swipeAxis(0, -12)).toBe("y");
  });
});

describe("swipeStep（INT-13-03、INT-04-01・04）", () => {
  it("操作する幅の 20% を超えて離したら動かし、内容を左へ送ると次、右へ送ると前", () => {
    expect(swipeStep(-75, 375)).toBe(1);
    expect(swipeStep(75, 375)).toBe(-1);
    expect(swipeStep(-74, 375)).toBe(0);
  });

  it("確定の距離は狭い幅でも 64px、広い幅でも 120px にとどめる", () => {
    expect(swipeStep(-63, 200)).toBe(0);
    expect(swipeStep(-64, 200)).toBe(1);
    expect(swipeStep(119, 1024)).toBe(0);
    expect(swipeStep(120, 1024)).toBe(-1);
  });

  it("幅が分からないときは 64px で確定する", () => {
    expect(swipeStep(-64, 0)).toBe(1);
  });
});

describe("wheelPx（INT-13-05）", () => {
  it("行や画面の単位の量を px に直す", () => {
    expect(wheelPx(30, 0, 800)).toBe(30);
    expect(wheelPx(3, 1, 800)).toBe(48);
    expect(wheelPx(-1, 2, 800)).toBe(-800);
  });
});

describe("wheelStep（INT-13-05、INT-05-05）", () => {
  it("横の量の合計が 80px に届いたら動かし、内容が左へ移る向き（正）は次", () => {
    expect(wheelStep(79)).toBe(0);
    expect(wheelStep(80)).toBe(1);
    expect(wheelStep(-80)).toBe(-1);
  });
});
