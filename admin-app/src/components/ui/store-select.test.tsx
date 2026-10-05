import type { ReactNode } from "react";
import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { StoreSelect } from "./store-select";
import type { Store } from "@/types/api";

vi.mock("@/components/ui/select", () => ({
  Select: ({
    value,
    onValueChange,
    children,
  }: {
    value: string;
    onValueChange: (value: string) => void;
    children: ReactNode;
  }) => (
    <select
      aria-label="店舗"
      value={value}
      onChange={(event) => onValueChange(event.target.value)}
    >
      {children}
    </select>
  ),
  SelectContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  SelectItem: ({ value, children }: { value: string; children: ReactNode }) => (
    <option value={value}>{children}</option>
  ),
  SelectTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  SelectValue: () => null,
}));

const store = (id: string, name: string): Store =>
  ({ id, name }) as Store;

describe("StoreSelect render", () => {
  it("店舗が1件以下なら何も描画しない", () => {
    const { container } = render(
      <StoreSelect stores={[store("s1", "本店")]} value={null} onChange={() => {}} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("店舗が複数あればトリガーを描画する", () => {
    render(
      <StoreSelect
        stores={[store("s1", "本店"), store("s2", "支店")]}
        value={null}
        onChange={() => {}}
      />,
    );
    // ドロップダウンは開かず、トリガーの placeholder だけ確認する（Radix の
    // ポインタ操作は jsdom で不安定なため、分岐ロジックは *.test.ts で担保）。
    expect(screen.getByText("全店舗")).toBeTruthy();
  });

  it("選択値を呼び出し側の店舗 ID / null に変換して通知する", () => {
    const onChange = vi.fn();
    render(
      <StoreSelect
        stores={[store("s1", "本店"), store("s2", "支店")]}
        value={null}
        onChange={onChange}
      />,
    );

    const select = screen.getByRole("combobox", { name: "店舗" });
    fireEvent.change(select, { target: { value: "s2" } });
    fireEvent.change(select, { target: { value: "__all__" } });

    expect(onChange).toHaveBeenNthCalledWith(1, "s2");
    expect(onChange).toHaveBeenNthCalledWith(2, null);
  });
});
