import { describe, expect, it } from "vitest";
import { pickLinkStoreId } from "./link-store-id";

const stores = [{ id: "store-a" }, { id: "store-b" }];

describe("pickLinkStoreId", () => {
  it("選んでいる店舗が一覧にあれば、その店舗を返す", () => {
    expect(pickLinkStoreId(stores, "store-b")).toBe("store-b");
  });

  it.each([null, undefined, "store-unknown"])("選んでいる店舗が %s なら、先頭の店舗を返す", (selected) => {
    expect(pickLinkStoreId(stores, selected)).toBe("store-a");
  });

  it("店舗が 0 件なら、空の文字列を返す", () => {
    expect(pickLinkStoreId([], "store-a")).toBe("");
    expect(pickLinkStoreId([], null)).toBe("");
  });
});
