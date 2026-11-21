import { describe, expect, it } from "vitest";
import { FRAME_MS, frameAt, releaseVelocity, type Sample, springFrames, swipeAxis, swipeStep, wheelPx, wheelStep } from "./swipe";

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

  it("150ms 止まってから 1 回で 15px 戻して離した指（平均 0.1px/ms）は、確定の距離を越えていても今の期間のまま", () => {
    expect(swipeStep(-135, 375, releaseVelocity([{ x: 300, t: 0 }, { x: 150, t: 60 }, { x: 165, t: 210 }], 215))).toBe(0);
  });
});

describe("releaseVelocity（INT-13-03 の速さの求め方）", () => {
  type Row = [name: string, track: Sample[], liftAt: number, speed: number];
  const rows: Row[] = [
    // (1) 終点は最後に横の位置が変わった記録。(2) そこから 40ms より後に離した指は 0。
    ["終点から 40ms ちょうどで離した指は、動いたままの速さ", [{ x: 300, t: 0 }, { x: 255, t: 83 }], 123, -45 / 83],
    ["終点から 40ms より後に離した指は、止めて離したので 0", [{ x: 300, t: 0 }, { x: 255, t: 83 }], 124, 0],
    ["横に止まってから縦にだけ動いた指は、横に止まった時が終点", [{ x: 300, t: 0 }, { x: 230, t: 20 }, { x: 230, t: 71 }], 72, 0],
    ["横に止まって 40ms 以内に離した指は、止まる前の速さ", [{ x: 300, t: 0 }, { x: 230, t: 20 }, { x: 230, t: 50 }], 55, -3.5],
    // (3) 終点とその 1 つ前の記録の区間は、必ず数える。
    ["止まった後の動きが 1 回だけなら、その区間の平均", [{ x: 300, t: 0 }, { x: 200, t: 80 }, { x: 208, t: 130 }], 135, 0.16],
    ["100ms より長い区間でも、最後の区間なら平均", [{ x: 300, t: 0 }, { x: 270, t: 200 }], 205, -0.15],
    // (4) さらに前へさかのぼり、次の 4 つの手前で止める。
    ["終点から 100ms ちょうど前の記録までは数える", [{ x: 10, t: 0 }, { x: 80, t: 50 }, { x: 100, t: 100 }], 100, 0.9],
    ["終点から 100ms より前の記録は数えない", [{ x: 10, t: -1 }, { x: 80, t: 50 }, { x: 100, t: 100 }], 100, 0.4],
    ["同じ横位置の記録（止めていた）の手前で止める", [{ x: 300, t: 0 }, { x: 300, t: 130 }, { x: 270, t: 150 }], 160, -1.5],
    ["40ms より長い間を 0.3px/ms より遅く動いた所（動きの届かない静止）の手前で止める", [{ x: 300, t: 0 }, { x: 286, t: 50 }, { x: 276, t: 60 }], 60, -1],
    ["40ms より長い間でも 0.3px/ms で動いた所は、遅れて届いた動きとして数える", [{ x: 300, t: 0 }, { x: 285, t: 50 }, { x: 275, t: 60 }], 60, -25 / 60],
    ["静止の後に 2 回以上届いた動きは、静止の後だけ", [{ x: 300, t: 0 }, { x: 200, t: 80 }, { x: 202, t: 150 }, { x: 205, t: 160 }], 160, 0.3],
    ["折り返した所の手前で止める", [{ x: 300, t: 0 }, { x: 180, t: 80 }, { x: 190, t: 100 }], 100, 0.5],
    ["折り返した所で止まってから戻した指は、戻し始めから", [{ x: 300, t: 0 }, { x: 220, t: 70 }, { x: 200, t: 80 }, { x: 200, t: 140 }, { x: 205, t: 150 }], 160, 0.5],
    // (5) 起点から終点までの平均。
    ["100ms の動きの平均", [{ x: 300, t: 0 }, { x: 280, t: 50 }, { x: 250, t: 100 }], 110, -0.5],
    ["時刻の進まない記録は 0", [{ x: 0, t: 5 }, { x: 90, t: 5 }], 5, 0],
    ["空の記録は 0", [], 0, 0],
  ];
  it.each(rows)("%s", (_name, track, liftAt, speed) => {
    expect(releaseVelocity(track, liftAt)).toBeCloseTo(speed);
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
