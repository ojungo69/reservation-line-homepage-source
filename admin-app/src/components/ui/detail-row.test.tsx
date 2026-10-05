import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Row as ServiceDetailRow } from "@/components/menu/service-detail-panel";
import { Row as StaffDetailRow } from "@/components/staff/staff-detail-panel";
import { DetailRow } from "./detail-row";

describe("DetailRow", () => {
  it("既定レイアウトでラベルと値を描画する", () => {
    const { container } = render(<DetailRow label="店舗" value="本店" />);

    expect(screen.getByText("店舗")).toBeTruthy();
    expect(screen.getByText("本店")).toBeTruthy();
    expect(container.firstElementChild?.className).toBe(
      "flex justify-between text-sm",
    );
  });

  it("指定されたレイアウトを使う", () => {
    const { container } = render(
      <DetailRow label="担当" value="田中" className="custom-layout" />,
    );

    expect(container.firstElementChild?.className).toBe("custom-layout");
  });

  it("メニュー詳細の行から共通表示を利用できる", () => {
    render(<ServiceDetailRow label="所要時間" value="60分" />);

    expect(screen.getByText("所要時間")).toBeTruthy();
    expect(screen.getByText("60分")).toBeTruthy();
  });

  it("スタッフ詳細の行から共通表示を利用できる", () => {
    render(<StaffDetailRow label="権限" value="管理者" />);

    expect(screen.getByText("権限")).toBeTruthy();
    expect(screen.getByText("管理者")).toBeTruthy();
  });
});
