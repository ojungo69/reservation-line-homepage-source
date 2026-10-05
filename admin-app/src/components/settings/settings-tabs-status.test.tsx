import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Closure, Resource } from "@/types/api";

const mutation = { mutate: vi.fn(), isPending: false };
let closures: Closure[] = [];
let resources: Resource[] = [];

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
  useResourceDelete: () => mutation,
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

  it("両タブの削除確認をキャンセルできる", async () => {
    const user = userEvent.setup();
    closures = [{
      id: "closure-1",
      storeId: "store-1",
      startsAt: "2026-07-24T00:00:00Z",
      endsAt: "2026-07-24T23:59:59Z",
      reason: null,
      source: "admin",
    }];
    const { unmount } = render(<ClosuresTab selectedStoreId="store-1" />);
    await user.click(screen.getByRole("button", { name: "削除" }));
    await user.click(screen.getByRole("button", { name: "キャンセル" }));
    unmount();

    resources = [{
      id: "resource-1",
      storeId: "store-1",
      name: "担当A",
      resourceType: "staff_calendar",
      active: true,
    }];
    render(<ResourcesTab selectedStoreId="store-1" />);
    await user.click(screen.getByRole("button", { name: "削除" }));
    await user.click(screen.getByRole("button", { name: "キャンセル" }));
    expect(mutation.mutate).not.toHaveBeenCalled();
  });
});
