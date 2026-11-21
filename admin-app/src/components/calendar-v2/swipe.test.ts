import { describe, expect, it } from "vitest";
import { FRAME_MS, frameAt, releaseVelocity, springFrames, swipeAxis, swipeStep, wheelPx, wheelStep } from "./swipe";

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

  it("確定の距離に届かなくても、24px 以上を 0.3px/ms 以上の速さで払ったまま離せば動かす", () => {
    expect(swipeStep(-24, 375, -0.3)).toBe(1);
    expect(swipeStep(30, 375, 0.5)).toBe(-1);
    expect(swipeStep(-23, 375, -2)).toBe(0);
    expect(swipeStep(-40, 375, -0.29)).toBe(0);
  });

  it("確定の距離を越えていても、戻す向きに 0.1px/ms 以上で動きながら離せば今の期間のまま", () => {
    expect(swipeStep(-100, 375, 0.1)).toBe(0);
    expect(swipeStep(100, 375, -0.1)).toBe(0);
    expect(swipeStep(-100, 375, 0.09)).toBe(1);
  });
});

describe("releaseVelocity", () => {
  it("離すまでの 100ms の動きから速さ（px/ms）を出す", () => {
    expect(releaseVelocity([{ x: 300, t: 0 }, { x: 280, t: 50 }, { x: 250, t: 100 }], 110)).toBe(-0.5);
    expect(releaseVelocity([{ x: 0, t: 0 }, { x: 100, t: 150 }, { x: 120, t: 200 }], 200)).toBe(0.4);
  });

  it("100ms の中で折り返した指は、折り返した所からの速さとする", () => {
    expect(releaseVelocity([{ x: 300, t: 0 }, { x: 180, t: 80 }, { x: 190, t: 100 }], 100)).toBe(0.5);
  });

  it("止めてから払った指は、動き出す直前からの速さとする", () => {
    expect(releaseVelocity([{ x: 300, t: 0 }, { x: 300, t: 130 }, { x: 270, t: 150 }], 160)).toBe(-1.5);
    expect(releaseVelocity([{ x: 300, t: 0 }, { x: 300, t: 50 }, { x: 276, t: 70 }], 75)).toBe(-1.2);
  });

  it("止まって動きの届かない間を挟んで戻した指は、戻し始めてからの速さとし、遅れて届いた速い動きは止まりと見ない", () => {
    expect(releaseVelocity([{ x: 300, t: 0 }, { x: 200, t: 80 }, { x: 202, t: 150 }, { x: 205, t: 160 }], 160)).toBe(0.3);
    expect(releaseVelocity([{ x: 300, t: 0 }, { x: 290, t: 16 }, { x: 250, t: 66 }], 70)).toBe(-50 / 66);
  });

  it("止まった後の動きが 1 回しか届かなくても、その区間の平均を速さとする", () => {
    expect(releaseVelocity([{ x: 300, t: 0 }, { x: 200, t: 80 }, { x: 208, t: 130 }], 135)).toBeCloseTo(0.16);
    expect(releaseVelocity([{ x: 300, t: 0 }, { x: 270, t: 200 }], 205)).toBeCloseTo(-0.15);
  });

  it("ゆっくり動かしてから払った指は、払い始めてからの速さとする", () => {
    expect(releaseVelocity([{ x: 300, t: 0 }, { x: 295, t: 45 }, { x: 282, t: 120 }, { x: 273, t: 135 }], 145)).toBeCloseTo(-0.6);
  });

  it("折り返した所で止まってから戻した指は、戻し始めてからの速さとする", () => {
    const track = [{ x: 300, t: 0 }, { x: 220, t: 70 }, { x: 200, t: 80 }, { x: 200, t: 140 }, { x: 205, t: 150 }];
    expect(releaseVelocity(track, 160)).toBe(0.5);
  });

  it("横に止まってから縦にだけ動いた指は、横に止まった時から数える", () => {
    expect(releaseVelocity([{ x: 300, t: 0 }, { x: 230, t: 20 }, { x: 230, t: 71 }], 72)).toBe(0);
  });

  it("最後の動きから 40ms 以内に離した指は、動いたままの速さとする", () => {
    expect(releaseVelocity([{ x: 300, t: 0 }, { x: 255, t: 83 }], 123)).toBeCloseTo(-45 / 83);
  });

  it("最後の動きから 40ms より後に離した指、時刻の進まない記録、空の記録は 0", () => {
    expect(releaseVelocity([{ x: 0, t: 0 }, { x: 100, t: 50 }], 91)).toBe(0);
    expect(releaseVelocity([{ x: 0, t: 5 }, { x: 90, t: 5 }], 5)).toBe(0);
    expect(releaseVelocity([], 0)).toBe(0);
  });
});

describe("springFrames（DESIGN.md §8）", () => {
  it("今の位置から始まり、行き先でぴったり終わる", () => {
    const frames = springFrames(-100, -375, -1.5);
    expect(frames[0]).toBe(-100);
    expect(frames.at(-1)).toBe(-375);
    expect(frames.length).toBeLessThanOrEqual(61);
  });

  it("指の速さのまま動き出し、行き先を越えずに近づく", () => {
    const frames = springFrames(-100, -375, -1.5);
    expect(frames[0] - frames[1]).toBeGreaterThanOrEqual(1.5 * FRAME_MS);
    for (let index = 1; index < frames.length; index++) {
      expect(frames[index]).toBeLessThanOrEqual(frames[index - 1]);
      expect(frames[index]).toBeGreaterThanOrEqual(-375);
    }
  });

  it("行き先のすぐ手前で速く離しても、行き先ちょうどで離しても、その先の期間へはみ出さない", () => {
    expect(Math.min(...springFrames(-370, -375, -4))).toBe(-375);
    expect(springFrames(-375, -375, -1)).toEqual([-375, -375]);
  });

  it("行き先と逆へ動いていた指は、その向きに少し進んでから戻る", () => {
    const frames = springFrames(-60, 0, -0.4);
    expect(frames[1]).toBeLessThan(-60);
    expect(frames.at(-1)).toBe(0);
  });
});

describe("frameAt", () => {
  it("経った時間のコマの間を補い、始まりの前と終わりの後は端にとどめる", () => {
    expect(frameAt([0, 10, 20], 0)).toBe(0);
    expect(frameAt([0, 10, 20], FRAME_MS / 2)).toBe(5);
    expect(frameAt([0, 10, 20], FRAME_MS * 5)).toBe(20);
    expect(frameAt([0, 10, 20], -1)).toBe(0);
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
