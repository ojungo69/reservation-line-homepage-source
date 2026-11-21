import { afterEach, describe, expect, it } from "vitest";
import { stableAnchor } from "./stable-anchor";

const rect = (x: number, y: number) => new DOMRect(x, y, 40, 20);
// A DOMRect's x, y, width and height are getters, so toEqual would call any two equal.
const xywh = ({ x, y, width, height }: DOMRect) => ({ x, y, width, height });

afterEach(() => {
  document.body.replaceChildren();
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

  it("uses the middle of the screen for an element that was gone before it was measured", () => {
    const button = document.createElement("button");
    button.getBoundingClientRect = () => rect(10, 20);
    expect(xywh(stableAnchor(button).getBoundingClientRect())).toEqual(xywh(new DOMRect(window.innerWidth / 2, window.innerHeight / 2, 0, 0)));
  });
});
