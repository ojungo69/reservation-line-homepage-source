import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Closure, Resource } from "@/types/api";

const mutation = { mutate: vi.fn(), isPending: false };
let closures: Closure[] = [];
let resources: Resource[] = [];

vi.mock("@/hooks/use-settings", () => ({
  useSettings: () => ({ isError: false, refetch: vi.fn() }),
}));

vi.mock("@/hooks/use-closures", () => ({
  useClosureList: () => ({ closureList: closures, isPending: false }),
  useClosureCreate: () => mutation,
  useClosureUpdate: () => mutation,
  useClosureDelete: () => mutation,
}));

vi.mock("@/hooks/use-resources", () => ({
  useResourceList: () => ({ resourceList: resources, isPending: false }),
  useResourceCreate: () => mutation,
  useResourceUpdate: () => mutation,
}));

import { ClosuresTab } from "./closures-tab";
import { ResourcesTab } from "./resources-tab";

beforeEach(() => {
  closures = [];
  resources = [];
  mutation.mutate.mockReset();
});

describe("settings tab loading state", () => {
  it("店舗未選択時は両タブで共通案内を表示する", () => {
    const { unmount } = render(<ClosuresTab selectedStoreId={null} />);
    expect(screen.getByText("店舗を選択してください")).toBeTruthy();
    unmount();

    render(<ResourcesTab selectedStoreId={null} />);
    expect(screen.getByText("店舗を選択してください")).toBeTruthy();
  });

  it("休業日の削除確認をキャンセルできる", async () => {
    const user = userEvent.setup();
    closures = [{
      id: "closure-1",
      storeId: "store-1",
      startsAt: "2026-07-24T00:00:00Z",
      endsAt: "2026-07-24T23:59:59Z",
      reason: null,
      source: "admin",
    }];
    render(<ClosuresTab selectedStoreId="store-1" />);
    await user.click(screen.getByRole("button", { name: "削除" }));
    await user.click(screen.getByRole("button", { name: "キャンセル" }));
    expect(mutation.mutate).not.toHaveBeenCalled();
  });

  it("リソース一覧には削除が無く、無効化と有効化がある", () => {
    resources = [
      { id: "resource-1", storeId: "store-1", name: "担当A", resourceType: "staff_calendar", active: true },
      { id: "resource-2", storeId: "store-1", name: "担当B", resourceType: "staff_calendar", active: false },
    ];
    render(<ResourcesTab selectedStoreId="store-1" />);

    expect(screen.queryByRole("button", { name: "削除" })).toBeNull();
    expect(screen.getByRole("button", { name: "無効化" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "有効化" })).toBeTruthy();
  });

  it("無効化と有効化は、押した行のリソースの id で active を反転して更新する", async () => {
    const user = userEvent.setup();
    resources = [
      { id: "resource-1", storeId: "store-1", name: "担当A", resourceType: "staff_calendar", active: true },
      { id: "resource-2", storeId: "store-1", name: "担当B", resourceType: "staff_calendar", active: false },
    ];
    render(<ResourcesTab selectedStoreId="store-1" />);

    await user.click(screen.getByRole("button", { name: "無効化" }));
    expect(mutation.mutate).toHaveBeenLastCalledWith(
      { id: "resource-1", storeId: "store-1", name: "担当A", resourceType: "staff_calendar", active: false },
    );

    await user.click(screen.getByRole("button", { name: "有効化" }));
    expect(mutation.mutate).toHaveBeenLastCalledWith(
      { id: "resource-2", storeId: "store-1", name: "担当B", resourceType: "staff_calendar", active: true },
    );
    expect(mutation.mutate).toHaveBeenCalledTimes(2);
  });
});
