import { afterEach, describe, expect, it, vi } from "vitest";
import { stableAnchor } from "./stable-anchor";

const rect = (x: number, y: number) => new DOMRect(x, y, 40, 20);
// A DOMRect's x, y, width and height are getters, so toEqual would call any two equal.
const xywh = ({ x, y, width, height }: DOMRect) => ({ x, y, width, height });

afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe("stableAnchor", () => {
  it("measures the pressed element while it is on the page", () => {
    const button = document.createElement("button");
    document.body.append(button);
    let at = rect(10, 20);
    button.getBoundingClientRect = () => at;
    const anchor = stableAnchor(button);
    expect(xywh(anchor.getBoundingClientRect())).toEqual(xywh(rect(10, 20)));
    at = rect(30, 60);
    expect(xywh(anchor.getBoundingClientRect())).toEqual(xywh(rect(30, 60)));
  });

  it("keeps the last place once the element leaves the page", () => {
    // A booking corrected to 来店なし leaves the grid while its detail stays open.
    const button = document.createElement("button");
    document.body.append(button);
    button.getBoundingClientRect = () => rect(10, 20);
    const anchor = stableAnchor(button);
    anchor.getBoundingClientRect();
    button.remove();
    button.getBoundingClientRect = () => rect(0, 0);
    expect(xywh(anchor.getBoundingClientRect())).toEqual(xywh(rect(10, 20)));
  });

  it("uses the middle of the screen when nothing on the page was pressed", () => {
    const middle = new DOMRect(window.innerWidth / 2, window.innerHeight / 2, 0, 0);
    expect(xywh(stableAnchor(null).getBoundingClientRect())).toEqual(xywh(middle));
    expect(xywh(stableAnchor(document.body).getBoundingClientRect())).toEqual(xywh(middle));
  });

  it("keeps the latest place, not the first, once a booking that moved is gone", () => {
    const button = document.createElement("button");
    document.body.append(button);
    let at = rect(10, 20);
    button.getBoundingClientRect = () => at;
    const anchor = stableAnchor(button);
    at = rect(30, 60);
    anchor.getBoundingClientRect();
    button.remove();
    expect(xywh(anchor.getBoundingClientRect())).toEqual(xywh(rect(30, 60)));
  });

  it("keeps the place it had when the detail opened, if the element goes before the first measure", () => {
    const button = document.createElement("button");
    document.body.append(button);
    button.getBoundingClientRect = () => rect(10, 20);
    const anchor = stableAnchor(button);
    button.remove();
    expect(xywh(anchor.getBoundingClientRect())).toEqual(xywh(rect(10, 20)));
  });

  it("hands the element to the positioning, so the popover follows a booking that moves", () => {
    const button = document.createElement("button");
    document.body.append(button);
    expect(stableAnchor(button).contextElement).toBe(button);
    expect(stableAnchor(document.body).contextElement).toBeUndefined();
    expect(stableAnchor(null).contextElement).toBeUndefined();
  });

  // jsdom: a 1024px window and a 16px rem, so the popover needs 448 + 8 + 16 = 472px beside it.
  it("with no room on either side of a wide booking, points at its first part", () => {
    const button = document.createElement("button");
    document.body.append(button);
    button.getBoundingClientRect = () => new DOMRect(320, 100, 654, 60);
    expect(xywh(stableAnchor(button).getBoundingClientRect())).toEqual({ x: 320, y: 100, width: 1024 - 472 - 320, height: 60 });
  });

  it("leaves a booking with room on one side as it is", () => {
    const button = document.createElement("button");
    document.body.append(button);
    button.getBoundingClientRect = () => new DOMRect(520, 100, 120, 60);
    expect(xywh(stableAnchor(button).getBoundingClientRect())).toEqual({ x: 520, y: 100, width: 120, height: 60 });
  });

  // A popover kept open while the window narrows (the page keeps its container).
  it("on a screen too narrow to start at the booking, opens at the furthest point the popover still fits", () => {
    vi.stubGlobal("innerWidth", 768);
    const button = document.createElement("button");
    document.body.append(button);
    button.getBoundingClientRect = () => new DOMRect(363, 100, 300, 60);
    // 768px: the popover needs 448 + 24 = 472px, so it can start no further right than 296.
    expect(xywh(stableAnchor(button).getBoundingClientRect())).toEqual({ x: 296, y: 100, width: 0, height: 60 });
  });

  it("fits a gone booking's last place to the screen as it is now", () => {
    const button = document.createElement("button");
    document.body.append(button);
    // Room on the right at 1024px (474px), on neither side at 768px.
    button.getBoundingClientRect = () => new DOMRect(430, 100, 120, 60);
    const anchor = stableAnchor(button);
    expect(xywh(anchor.getBoundingClientRect())).toEqual({ x: 430, y: 100, width: 120, height: 60 });
    button.remove();
    vi.stubGlobal("innerWidth", 768);
    expect(xywh(anchor.getBoundingClientRect())).toEqual({ x: 296, y: 100, width: 0, height: 60 });
  });

  it("fits a booking gone from the right edge to a window that then narrows", () => {
    const button = document.createElement("button");
    document.body.append(button);
    // At 1024px the popover opens on its left; at 768px that place is off the screen.
    button.getBoundingClientRect = () => new DOMRect(900, 100, 100, 60);
    const anchor = stableAnchor(button);
    expect(xywh(anchor.getBoundingClientRect())).toEqual({ x: 900, y: 100, width: 100, height: 60 });
    button.remove();
    vi.stubGlobal("innerWidth", 768);
    // On its left with the gap, ending 16px from the edge: 760 - 8 = 752.
    expect(xywh(anchor.getBoundingClientRect())).toEqual({ x: 760, y: 100, width: 0, height: 60 });
  });

  // Whatever the screen and wherever the booking (off the screen too), the 28rem
  // popover with its 8px gap fits on one side of what the anchor returns, 16px
  // inside the screen's edges.
  it.each([320, 375, 768, 1024, 1366])("leaves room for the popover on one side at %ipx", (width) => {
    vi.stubGlobal("innerWidth", width);
    const popover = Math.min(448, width - 32);
    const misses: string[] = [];
    for (const x of [-600, -100, 0, 8, 100, 300, 472, 600, 900, 1300, 2000]) {
      for (const w of [0, 40, 120, 654, 1500]) {
        const button = document.createElement("button");
        document.body.append(button);
        button.getBoundingClientRect = () => new DOMRect(x, 100, w, 60);
        const at = stableAnchor(button).getBoundingClientRect();
        const onRight = at.right + 8 >= 16 && at.right + 8 + popover <= width - 16;
        const onLeft = at.left - 8 - popover >= 16 && at.left - 8 <= width - 16;
        if (!onRight && !onLeft) misses.push(`x=${x} w=${w} -> ${at.left}..${at.right}`);
        button.remove();
      }
    }
    expect(misses).toEqual([]);
  });

  it("uses the middle of the screen for an element that was gone before it was measured", () => {
    const button = document.createElement("button");
    button.getBoundingClientRect = () => rect(10, 20);
    expect(xywh(stableAnchor(button).getBoundingClientRect())).toEqual(xywh(new DOMRect(window.innerWidth / 2, window.innerHeight / 2, 0, 0)));
  });
});
