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

  it("uses the middle of the screen for an element that was gone before it was measured", () => {
    const button = document.createElement("button");
    button.getBoundingClientRect = () => rect(10, 20);
    expect(xywh(stableAnchor(button).getBoundingClientRect())).toEqual(xywh(new DOMRect(window.innerWidth / 2, window.innerHeight / 2, 0, 0)));
  });
});
