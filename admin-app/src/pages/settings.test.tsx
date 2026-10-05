import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

let isPrivileged = true;

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    user: { role: isPrivileged ? "owner" : "staff", storeId: isPrivileged ? null : "store-1" },
    isPrivileged,
  }),
}));

vi.mock("@/hooks/use-stores", () => ({
  useStores: () => ({
    stores: [{ id: "store-1", name: "和歌山店" }],
    selectedStoreId: "store-1",
    selectStore: () => {},
    isStoreFixed: !isPrivileged,
  }),
}));

// タブ単位の権限ゲート (isPrivileged) の検証が目的なので、各タブは stub にする。
vi.mock("@/components/settings/business-hours-tab", () => ({
  BusinessHoursTab: () => <div>hours-tab</div>,
}));
vi.mock("@/components/settings/closures-tab", () => ({
  ClosuresTab: () => <div>closures-tab</div>,
}));
vi.mock("@/components/settings/resources-tab", () => ({
  ResourcesTab: () => <div>resources-tab</div>,
}));
vi.mock("@/components/settings/reminder-tab", () => ({
  ReminderTab: () => <div>reminder-tab</div>,
}));
vi.mock("@/components/settings/recurring-blocks-tab", () => ({
  RecurringBlocksTab: () => <div>recurring-tab</div>,
}));

import SettingsPage from "./settings";

describe("SettingsPage タブ権限", () => {
  it("owner は5タブすべて見える", () => {
    isPrivileged = true;
    render(<SettingsPage />);

    expect(screen.getByRole("tab", { name: "営業時間" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "休業日" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "リソース" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "リマインダー" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "繰り返しブロック" })).toBeTruthy();
  });

  it("staff は営業時間と休業日のタブだけ見える", () => {
    isPrivileged = false;
    render(<SettingsPage />);

    expect(screen.getByRole("tab", { name: "営業時間" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "休業日" })).toBeTruthy();
    expect(screen.queryByRole("tab", { name: "リソース" })).toBeNull();
    expect(screen.queryByRole("tab", { name: "リマインダー" })).toBeNull();
    expect(screen.queryByRole("tab", { name: "繰り返しブロック" })).toBeNull();
  });
});
