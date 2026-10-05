import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const createService = vi.fn();

vi.mock("@/hooks/use-services", () => ({
  useServiceCreate: () => ({ mutate: createService, isPending: false }),
}));

// Radix Select は JSDOM の pointer API 不足で操作できないため、CategorySelect だけ
// native select に差し替えて「カテゴリ選択 → 合成 payload」の配線を検証する。
// バリデーションや合成ロジック本体は実物 (category-select.ts / service-pricing.ts) を使う。
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

import { ServiceCreateDialog } from "./service-create-dialog";

const LONG_CATEGORY = "リ".repeat(45);

const stores = [{ id: "store-1", name: "和歌山店" }];
const services = [
  { storeId: "store-1", name: "脱毛｜全身" },
  { storeId: "store-1", name: "顔｜光" },
  // 旧UI・API 直経由で作られた40文字超カテゴリ。combo 候補からは除外されるが
  // メニューカテゴリとしては選択できる必要がある。
  { storeId: "store-1", name: `${LONG_CATEGORY}｜特別コース` },
];

const renderDialog = () =>
  render(
    <ServiceCreateDialog
      open
      onOpenChange={() => {}}
      stores={stores}
      defaultStoreId="store-1"
      services={services}
    />,
  );

beforeEach(() => {
  createService.mockReset();
  createService.mockImplementation((_input, options) => options?.onSuccess?.());
});

describe("ServiceCreateDialog カテゴリ選択制", () => {
  it("カテゴリ未選択なら名前だけで作成する (プレフィックスなし)", async () => {
    const user = userEvent.setup();
    renderDialog();

    expect(screen.getByLabelText("カテゴリ").textContent).toContain("カテゴリなし");

    await user.type(screen.getByLabelText("メニュー名"), "カット 30分");
    await user.click(screen.getByRole("button", { name: "追加" }));

    expect(createService).toHaveBeenCalledWith(
      expect.objectContaining({ storeId: "store-1", name: "カット 30分" }),
      expect.objectContaining({ onSuccess: expect.any(Function) }),
    );
  });

  it("既存カテゴリを選ぶと「カテゴリ｜名前」で作成する", async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.selectOptions(screen.getByLabelText("カテゴリ"), "脱毛");
    await user.type(screen.getByLabelText("メニュー名"), "腕");
    await user.click(screen.getByRole("button", { name: "追加" }));

    expect(createService).toHaveBeenCalledWith(
      expect.objectContaining({ storeId: "store-1", name: "脱毛｜腕" }),
      expect.objectContaining({ onSuccess: expect.any(Function) }),
    );
  });

  it("新しいカテゴリを入力すると trim して「カテゴリ｜名前」で作成する", async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.selectOptions(
      screen.getByLabelText("カテゴリ"),
      "＋ 新しいカテゴリを作る",
    );
    await user.type(screen.getByLabelText("新しいカテゴリ名"), " ヘッドスパ ");
    await user.type(screen.getByLabelText("メニュー名"), "炭酸スパ");
    await user.click(screen.getByRole("button", { name: "追加" }));

    expect(createService).toHaveBeenCalledWith(
      expect.objectContaining({ storeId: "store-1", name: "ヘッドスパ｜炭酸スパ" }),
      expect.objectContaining({ onSuccess: expect.any(Function) }),
    );
  });

  it("40文字超の既存カテゴリも候補に出て選択・作成できる (combo 候補とは別導出)", async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.selectOptions(screen.getByLabelText("カテゴリ"), LONG_CATEGORY);
    await user.type(screen.getByLabelText("メニュー名"), "延長");
    await user.click(screen.getByRole("button", { name: "追加" }));

    expect(createService).toHaveBeenCalledWith(
      expect.objectContaining({ name: `${LONG_CATEGORY}｜延長` }),
      expect.objectContaining({ onSuccess: expect.any(Function) }),
    );
  });

  it("カテゴリ込みで合計100文字を超えると追加できない", async () => {
    const user = userEvent.setup();
    renderDialog();

    // 45 + 1 (｜) + 55 = 101 文字
    await user.selectOptions(screen.getByLabelText("カテゴリ"), LONG_CATEGORY);
    await user.type(screen.getByLabelText("メニュー名"), "あ".repeat(55));
    expect(
      (screen.getByRole("button", { name: "追加" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(screen.getByText(/長すぎます/)).toBeTruthy();
    expect(createService).not.toHaveBeenCalled();
  });

  it("メニュー名に「｜」を含めると追加できない", async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.type(screen.getByLabelText("メニュー名"), "脱毛｜全身");
    expect(
      (screen.getByRole("button", { name: "追加" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(screen.getByText(/「｜」は使えません/)).toBeTruthy();
    expect(createService).not.toHaveBeenCalled();
  });
});
