import { describe, expect, it } from "vitest";
import { NAV_ITEMS, navItemsBySection } from "./nav-items";

describe("admin navigation", () => {
  it("keeps every route unique and marks only the index route as exact", () => {
    const paths = NAV_ITEMS.map((item) => item.path);
    expect(new Set(paths).size).toBe(paths.length);
    expect(
      NAV_ITEMS.filter((item) => item.end).map((item) => item.path),
    ).toEqual(["/"]);
  });

  it("keeps customer access visible to staff and sensitive pages privileged", () => {
    expect(
      NAV_ITEMS.find((item) => item.path === "/customers")
        ?.privileged,
    ).not.toBe(true);
    // 店舗設定は staff もアクセス可 (営業時間・休業日を自店舗スコープで編集。
    // owner 限定タブは settings.tsx 側で isPrivileged ゲート)。
    expect(
      NAV_ITEMS.find((item) => item.path === "/settings")
        ?.privileged,
    ).not.toBe(true);
    expect(
      NAV_ITEMS.filter((item) => item.privileged).map(
        (item) => item.path,
      ),
    ).toEqual([
      "/staff",
      "/line-friends",
      "/store-logins",
      "/google-sync",
      "/activity",
    ]);
  });

  it.each([
    [
      "daily",
      ["/", "/reservations", "/customers", "/cancellation-fees"],
    ],
    ["admin", ["/staff", "/line-friends", "/menu"]],
    [
      "settings",
      ["/notifications", "/settings", "/store-logins", "/google-sync", "/activity"],
    ],
  ] as const)("filters the %s section without reordering it", (section, paths) => {
    expect(
      navItemsBySection(section).map((item) => item.path),
    ).toEqual(paths);
  });
});
