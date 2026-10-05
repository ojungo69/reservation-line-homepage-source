import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StaffMember } from "@/types/api";

const updateStaff = vi.fn();
const deleteStaff = vi.fn();
let currentStaffMemberId = "admin-1";
let updatePending = false;

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    user: {
      role: "system_admin",
      staffMemberId: currentStaffMemberId,
    },
  }),
}));

vi.mock("@/hooks/use-staff", () => ({
  useStaffUpdate: () => ({ mutate: updateStaff, isPending: updatePending }),
  useStaffDelete: () => ({ mutate: deleteStaff, isPending: false }),
}));

import { StaffDetailPanel } from "./staff-detail-panel";

const activeStaff: StaffMember = {
  id: "staff-1",
  storeId: "store-1",
  displayName: "担当 花子",
  role: "staff",
  active: true,
  version: 3,
};

beforeEach(() => {
  currentStaffMemberId = "admin-1";
  updatePending = false;
  updateStaff.mockReset();
  deleteStaff.mockReset();
  updateStaff.mockImplementation((_input, options) => options?.onSuccess?.());
});

describe("StaffDetailPanel", () => {
  it("表示名を編集し、確認後に無効化する", async () => {
    const user = userEvent.setup();
    render(
      <StaffDetailPanel
        staff={activeStaff}
        stores={[{ id: "store-1", name: "新宿店" }]}
        onClose={() => {}}
      />,
    );

    await user.click(screen.getByRole("button", { name: "編集" }));
    const name = screen.getByLabelText("表示名");
    await user.clear(name);
    await user.type(name, "担当 太郎");
    await user.click(screen.getByRole("button", { name: "保存" }));
    expect(updateStaff).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "staff-1",
        displayName: "担当 太郎",
        expectedVersion: 3,
      }),
      expect.objectContaining({ onSuccess: expect.any(Function) }),
    );

    await user.click(screen.getByRole("button", { name: "無効化" }));
    await user.click(screen.getByRole("button", { name: "無効化する" }));
    expect(deleteStaff).toHaveBeenCalledWith(
      "staff-1",
      expect.objectContaining({ onSuccess: expect.any(Function) }),
    );
  });

  it("無効なスタッフを有効化する", async () => {
    const user = userEvent.setup();
    render(
      <StaffDetailPanel
        staff={{ ...activeStaff, active: false }}
        stores={[]}
        onClose={() => {}}
      />,
    );

    await user.click(screen.getByRole("button", { name: "有効化" }));
    expect(updateStaff).toHaveBeenCalledWith(
      expect.objectContaining({ id: "staff-1", active: true, expectedVersion: 3 }),
    );
  });

  it("自分自身の無効化を隠し、処理中表示を出す", () => {
    currentStaffMemberId = "staff-1";
    const { rerender } = render(
      <StaffDetailPanel staff={activeStaff} stores={[]} onClose={() => {}} />,
    );
    expect(screen.queryByRole("button", { name: "無効化" })).toBeNull();

    updatePending = true;
    rerender(
      <StaffDetailPanel staff={{ ...activeStaff, active: false }} stores={[]} onClose={() => {}} />,
    );
    expect(screen.getByRole("button", { name: "処理中..." })).toBeTruthy();
  });
});
