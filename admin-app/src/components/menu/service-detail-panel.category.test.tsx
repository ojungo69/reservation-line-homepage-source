import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Service } from "@/types/api";

const updateService = vi.fn();
const deleteService = vi.fn();

vi.mock("@/hooks/use-services", () => ({
  useServiceUpdate: () => ({ mutate: updateService, isPending: false }),
  useServiceDelete: () => ({ mutate: deleteService, isPending: false }),
}));

// Radix Select は JSDOM で操作できないため、CategorySelect だけ native select に
// 差し替えて「カテゴリ変更 → 再合成保存」の配線を検証する (service-create-dialog.test.tsx と同じ手法)。
vi.mock("@/components/menu/category-select", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./category-select")>();
  return {
    ...actual,
    CategorySelect: ({
      value,
      newCategory,
      options,
      onValueChange,
      onNewCategoryChange,
    }: {
      value: string;
      newCategory: string;
      options: string[];
      onValueChange: (v: string) => void;
      onNewCategoryChange: (v: string) => void;
    }) => (
      <div>
        <select aria-label="カテゴリ" value={value} onChange={(e) => onValueChange(e.target.value)}>
          <option value={actual.NO_CATEGORY}>（カテゴリなし）</option>
          {options.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
          <option value={actual.NEW_CATEGORY}>＋ 新しいカテゴリを作る</option>
        </select>
        {value === actual.NEW_CATEGORY && (
          <input
            aria-label="新しいカテゴリ名"
            value={newCategory}
            onChange={(e) => onNewCategoryChange(e.target.value)}
          />
        )}
      </div>
    ),
  };
});

import { ServiceDetailPanel } from "./service-detail-panel";

const service: Service = {
  id: "service-1",
  storeId: "store-1",
  name: "脱毛｜全身",
  durationMinutes: 55,
  priceLabel: "¥1,500",
  priceAmount: 1500,
  comboPriceAmount: null,
  comboWithPrefix: null,
  active: true,
  mensMenu: false,
};

const renderPanel = () =>
  render(
    <ServiceDetailPanel
      service={service}
      stores={[{ id: "store-1", name: "新宿店" }]}
      services={[service, { id: "service-2", storeId: "store-1", name: "顔｜光", active: true }]}
      canEdit
      onClose={() => {}}
    />,
  );

beforeEach(() => {
  updateService.mockReset();
  deleteService.mockReset();
  updateService.mockImplementation((_input, options) => options?.onSuccess?.());
});

describe("ServiceDetailPanel カテゴリ変更の配線", () => {
  it("別の既存カテゴリへ変更すると再合成した名前で保存する", async () => {
    const user = userEvent.setup();
    renderPanel();

    await user.click(screen.getByRole("button", { name: "編集" }));
    await user.selectOptions(screen.getByLabelText("カテゴリ"), "顔");
    await user.click(screen.getByRole("button", { name: "保存" }));

    expect(updateService).toHaveBeenCalledWith(
      expect.objectContaining({ id: "service-1", name: "顔｜全身" }),
      expect.objectContaining({ onSuccess: expect.any(Function) }),
    );
  });

  it("「カテゴリなし」へ変更するとプレフィックスを外して保存する", async () => {
    const user = userEvent.setup();
    renderPanel();

    await user.click(screen.getByRole("button", { name: "編集" }));
    await user.selectOptions(screen.getByLabelText("カテゴリ"), "（カテゴリなし）");
    await user.click(screen.getByRole("button", { name: "保存" }));

    expect(updateService).toHaveBeenCalledWith(
      expect.objectContaining({ id: "service-1", name: "全身" }),
      expect.objectContaining({ onSuccess: expect.any(Function) }),
    );
  });

  it("新しいカテゴリを入力すると trim して再合成保存する", async () => {
    const user = userEvent.setup();
    renderPanel();

    await user.click(screen.getByRole("button", { name: "編集" }));
    await user.selectOptions(
      screen.getByLabelText("カテゴリ"),
      "＋ 新しいカテゴリを作る",
    );
    await user.type(screen.getByLabelText("新しいカテゴリ名"), " ヘッドスパ ");
    await user.click(screen.getByRole("button", { name: "保存" }));

    expect(updateService).toHaveBeenCalledWith(
      expect.objectContaining({ id: "service-1", name: "ヘッドスパ｜全身" }),
      expect.objectContaining({ onSuccess: expect.any(Function) }),
    );
  });
});
