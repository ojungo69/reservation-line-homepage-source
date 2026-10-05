import { describe, expect, it } from "vitest";
import { dropStoreDraft } from "./store-drafts";

describe("dropStoreDraft", () => {
  it("removes only the saved store without mutating prior drafts", () => {
    const drafts = {
      "store-1": "下書き1",
      "store-2": "下書き2",
    };

    expect(dropStoreDraft("store-1")(drafts)).toEqual({
      "store-2": "下書き2",
    });
    expect(drafts).toEqual({
      "store-1": "下書き1",
      "store-2": "下書き2",
    });
  });

  it("returns an equal copy when the store has no draft", () => {
    const drafts = { "store-1": "下書き1" };
    const next = dropStoreDraft("store-2")(drafts);

    expect(next).toEqual(drafts);
    expect(next).not.toBe(drafts);
  });
});
