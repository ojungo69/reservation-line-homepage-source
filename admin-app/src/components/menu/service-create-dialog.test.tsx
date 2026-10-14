import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const createService = vi.fn();
let createPending = false;

vi.mock("@/hooks/use-services", () => ({
  useServiceCreate: () => ({ mutate: createService, isPending: createPending }),
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

const stores = [{ id: "store-1", name: "テスト中央店" }];
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
  createPending = false;
  createService.mockImplementation((_input, options) => options?.onSuccess?.());
});

describe("ServiceCreateDialog 店舗の初期選択", () => {
  const selectionStores = [
    { id: "store-1", name: "テスト中央店" },
    { id: "store-2", name: "テスト北店" },
  ];

  it("閉じている間に変更された店舗を開いた時点で選択し、作成先に使う", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    const { rerender } = render(
      <ServiceCreateDialog open={false} onOpenChange={onOpenChange} stores={selectionStores} defaultStoreId="store-1" services={[]} />,
    );
    rerender(
      <ServiceCreateDialog open={false} onOpenChange={onOpenChange} stores={selectionStores} defaultStoreId="store-2" services={[]} />,
    );
    rerender(
      <ServiceCreateDialog open onOpenChange={onOpenChange} stores={selectionStores} defaultStoreId="store-2" services={[]} />,
    );

    expect(screen.getByLabelText("店舗").textContent).toContain("テスト北店");
    await user.type(screen.getByLabelText("メニュー名"), "テストコース");
    await user.click(screen.getByRole("button", { name: "追加" }));
    expect(createService).toHaveBeenCalledWith(
      expect.objectContaining({ storeId: "store-2", name: "テストコース" }),
      expect.objectContaining({ onSuccess: expect.any(Function) }),
    );
  });

  it("開いた後に店舗が届いたら先頭店舗を選択し、入力中のメニュー名を保持する", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    const { rerender } = render(
      <ServiceCreateDialog open onOpenChange={onOpenChange} stores={[]} defaultStoreId={null} services={[]} />,
    );
    await user.type(screen.getByLabelText("メニュー名"), "テストコース");
    expect((screen.getByRole("button", { name: "追加" }) as HTMLButtonElement).disabled).toBe(true);
    rerender(
      <ServiceCreateDialog open onOpenChange={onOpenChange} stores={selectionStores} defaultStoreId={null} services={[]} />,
    );

    expect(screen.getByLabelText("店舗").textContent).toContain("テスト中央店");
    expect((screen.getByLabelText("メニュー名") as HTMLInputElement).value).toBe("テストコース");
    await user.click(screen.getByRole("button", { name: "追加" }));
    expect(createService).toHaveBeenCalledWith(
      expect.objectContaining({ storeId: "store-1", name: "テストコース" }),
      expect.objectContaining({ onSuccess: expect.any(Function) }),
    );
  });

  it("閉じている間に店舗一覧が届いた場合も開いた時点の先頭店舗を使う", () => {
    const onOpenChange = vi.fn();
    const { rerender } = render(
      <ServiceCreateDialog open={false} onOpenChange={onOpenChange} stores={[]} defaultStoreId={null} services={[]} />,
    );
    rerender(
      <ServiceCreateDialog open={false} onOpenChange={onOpenChange} stores={selectionStores} defaultStoreId={null} services={[]} />,
    );
    rerender(
      <ServiceCreateDialog open onOpenChange={onOpenChange} stores={selectionStores} defaultStoreId={null} services={[]} />,
    );

    expect(screen.getByLabelText("店舗").textContent).toContain("テスト中央店");
  });

  it("手動で選択する前の既定店舗変更をカテゴリ候補と作成先に反映する", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    const selectionServices = [
      { storeId: "store-1", name: "テスト旧分類｜既存コース" },
      { storeId: "store-2", name: "テスト新分類｜既存コース" },
    ];
    const { rerender } = render(
      <ServiceCreateDialog open onOpenChange={onOpenChange} stores={selectionStores} defaultStoreId="store-1" services={selectionServices} />,
    );
    await user.type(screen.getByLabelText("メニュー名"), "テストコース");

    rerender(
      <ServiceCreateDialog open onOpenChange={onOpenChange} stores={selectionStores} defaultStoreId="store-2" services={selectionServices} />,
    );

    expect(screen.getByLabelText("店舗").textContent).toContain("テスト北店");
    expect(screen.queryByRole("option", { name: "テスト旧分類" })).toBeNull();
    await user.selectOptions(screen.getByLabelText("カテゴリ"), "テスト新分類");
    expect(screen.getByLabelText("メニュー名")).toHaveProperty("value", "テストコース");
    await user.click(screen.getByRole("button", { name: "追加" }));
    expect(createService).toHaveBeenCalledWith(
      expect.objectContaining({ storeId: "store-2", name: "テスト新分類｜テストコース" }),
      expect.objectContaining({ onSuccess: expect.any(Function) }),
    );
  });

  it.each([
    { source: "既定店舗", selection: "既存カテゴリ" },
    { source: "既定店舗", selection: "新規カテゴリ" },
    { source: "既定店舗", selection: "割引カテゴリ" },
    { source: "既定店舗", selection: "割引料金" },
    { source: "先頭店舗", selection: "既存カテゴリ" },
    { source: "先頭店舗", selection: "新規カテゴリ" },
    { source: "先頭店舗", selection: "割引カテゴリ" },
    { source: "先頭店舗", selection: "割引料金" },
  ])("$selection の入力後は $source の変更でもドラフトの店舗を保持する", async ({ source, selection }) => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    const selectionServices = [
      { storeId: "store-1", name: "テスト旧分類｜既存コース" },
      { storeId: "store-2", name: "テスト新分類｜既存コース" },
    ];
    createService.mockImplementation(() => {});
    const { rerender } = render(
      <ServiceCreateDialog open onOpenChange={onOpenChange} stores={selectionStores} defaultStoreId={source === "既定店舗" ? "store-1" : null} services={selectionServices} />,
    );
    await user.type(screen.getByLabelText("メニュー名"), "テストコース");
    if (selection === "既存カテゴリ") {
      await user.selectOptions(screen.getByLabelText("カテゴリ"), "テスト旧分類");
    } else if (selection === "新規カテゴリ") {
      await user.selectOptions(screen.getByLabelText("カテゴリ"), "＋ 新しいカテゴリを作る");
      await user.type(screen.getByLabelText("新しいカテゴリ名"), "テスト作成分類");
    } else {
      await user.type(screen.getByLabelText("料金（円・数値・任意）"), "1500");
      if (selection === "割引カテゴリ") {
        screen.getByLabelText("対象カテゴリ").focus();
        await user.keyboard("テスト旧分類");
      } else {
        await user.type(screen.getByLabelText("組み合わせ時料金（円）"), "1000");
      }
    }

    rerender(
      <ServiceCreateDialog open onOpenChange={onOpenChange} stores={[...selectionStores].reverse()} defaultStoreId={source === "既定店舗" ? "store-2" : null} services={selectionServices} />,
    );
    expect(screen.getByLabelText("店舗").textContent).toContain("テスト中央店");
    if (selection === "割引カテゴリ") {
      await user.type(screen.getByLabelText("組み合わせ時料金（円）"), "1000");
    } else if (selection === "割引料金") {
      screen.getByLabelText("対象カテゴリ").focus();
      await user.keyboard("テスト旧分類");
    }
    await user.click(screen.getByRole("button", { name: "追加" }));

    const isCombo = selection === "割引カテゴリ" || selection === "割引料金";
    expect(createService).toHaveBeenCalledWith(
      expect.objectContaining({
        storeId: "store-1",
        name: selection === "既存カテゴリ" ? "テスト旧分類｜テストコース" : selection === "新規カテゴリ" ? "テスト作成分類｜テストコース" : "テストコース",
        comboWithPrefix: isCombo ? "テスト旧分類" : null,
        comboPriceAmount: isCombo ? 1000 : null,
      }),
      expect.objectContaining({ onSuccess: expect.any(Function) }),
    );

    screen.getByLabelText("店舗").focus();
    await user.keyboard("テスト北店");
    expect(screen.getByRole("option", { name: "（カテゴリなし）" })).toHaveProperty("selected", true);
    expect(screen.queryByLabelText("新しいカテゴリ名")).toBeNull();
    if (isCombo) {
      expect(screen.getByLabelText("対象カテゴリ").textContent).toContain("（設定しない）");
      expect(screen.getByLabelText("組み合わせ時料金（円）")).toHaveProperty("value", "");
    }
    await user.click(screen.getByRole("button", { name: "追加" }));
    expect(createService).toHaveBeenLastCalledWith(
      expect.objectContaining({ storeId: "store-2", name: "テストコース", comboWithPrefix: null, comboPriceAmount: null }),
      expect.objectContaining({ onSuccess: expect.any(Function) }),
    );
  });

  it("手動の店舗選択とカテゴリ入りドラフトを再取得・送信待ち・再試行でも保持する", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    const selectionServices = [{ storeId: "store-2", name: "テスト分類｜既存コース" }];
    createService.mockImplementation(() => {});
    const { rerender } = render(
      <ServiceCreateDialog open onOpenChange={onOpenChange} stores={selectionStores} defaultStoreId="store-1" services={selectionServices} />,
    );
    await user.type(screen.getByLabelText("メニュー名"), "テストコース");
    screen.getByLabelText("店舗").focus();
    await user.keyboard("テスト北店");
    await user.selectOptions(screen.getByLabelText("カテゴリ"), "テスト分類");

    rerender(
      <ServiceCreateDialog open onOpenChange={onOpenChange} stores={[...selectionStores]} defaultStoreId={null} services={[...selectionServices]} />,
    );
    expect(screen.getByLabelText("店舗").textContent).toContain("テスト北店");
    expect((screen.getByLabelText("カテゴリ") as HTMLSelectElement).selectedOptions[0].textContent).toBe("テスト分類");
    await user.click(screen.getByRole("button", { name: "追加" }));
    const submitted = createService.mock.calls[0][0];
    expect(submitted).toEqual(expect.objectContaining({ storeId: "store-2", name: "テスト分類｜テストコース" }));

    createPending = true;
    rerender(
      <ServiceCreateDialog open onOpenChange={onOpenChange} stores={[...selectionStores]} defaultStoreId="store-1" services={[...selectionServices]} />,
    );
    expect(screen.getByLabelText("店舗").textContent).toContain("テスト北店");
    expect((screen.getByLabelText("メニュー名") as HTMLInputElement).value).toBe("テストコース");
    await user.keyboard("{Escape}");
    expect(onOpenChange).not.toHaveBeenCalled();

    createPending = false;
    rerender(
      <ServiceCreateDialog open onOpenChange={onOpenChange} stores={[...selectionStores]} defaultStoreId="store-1" services={[...selectionServices]} />,
    );
    await user.click(screen.getByRole("button", { name: "追加" }));
    expect(createService).toHaveBeenLastCalledWith(
      submitted,
      expect.objectContaining({ onSuccess: expect.any(Function) }),
    );

    await user.keyboard("{Escape}");
    expect(onOpenChange).toHaveBeenCalledWith(false);
    rerender(
      <ServiceCreateDialog open={false} onOpenChange={onOpenChange} stores={selectionStores} defaultStoreId="store-1" services={selectionServices} />,
    );
    rerender(
      <ServiceCreateDialog open onOpenChange={onOpenChange} stores={selectionStores} defaultStoreId="store-2" services={selectionServices} />,
    );
    expect(screen.getByLabelText("店舗").textContent).toContain("テスト北店");
    expect(screen.getByLabelText("メニュー名")).toHaveProperty("value", "");
    expect(screen.getByRole("option", { name: "（カテゴリなし）" })).toHaveProperty("selected", true);
  });
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

describe("ServiceCreateDialog 所要時間のラベル", () => {
  it.each([
    { mode: "プリセット", duration: 90 },
    { mode: "カスタム", duration: 75 },
  ])("$mode を所要時間ラベルで操作し、選んだ時間で作成する", async ({ mode, duration }) => {
    const user = userEvent.setup();
    renderDialog();
    if (mode === "カスタム") {
      await user.click(screen.getByRole("button", { name: "カスタム" }));
      const input = screen.getByRole("spinbutton", { name: "所要時間" });
      await user.clear(input);
      await user.type(input, "75");
    } else {
      screen.getByRole("combobox", { name: "所要時間" }).focus();
      await user.keyboard("90");
    }
    await user.type(screen.getByLabelText("メニュー名"), "テストコース");
    await user.click(screen.getByRole("button", { name: "追加" }));

    expect(createService).toHaveBeenCalledWith(
      expect.objectContaining({ durationMinutes: duration }),
      expect.objectContaining({ onSuccess: expect.any(Function) }),
    );
  });
});
