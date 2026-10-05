import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SettingsTabStatus } from "./settings-tab-status";

describe("SettingsTabStatus", () => {
  it("店舗未選択時だけ案内を表示する", () => {
    const { rerender } = render(<SettingsTabStatus selectedStoreId={null} />);
    expect(screen.getByText("店舗を選択してください")).toBeTruthy();

    rerender(<SettingsTabStatus selectedStoreId="store-1" />);
    expect(screen.queryByText("店舗を選択してください")).toBeNull();
    expect(document.querySelectorAll(".animate-pulse")).toHaveLength(4);
  });
});
