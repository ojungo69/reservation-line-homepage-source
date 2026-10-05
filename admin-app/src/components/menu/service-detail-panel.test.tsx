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

import { ServiceDetailPanel } from "./service-detail-panel";

const service: Service = {
  id: "service-1",
  storeId: "store-1",
  name: "脱毛｜全身",
  durationMinutes: 55,
  priceLabel: "¥1,500",
  priceAmount: 1500,
  comboPriceAmount: 1000,
  comboWithPrefix: "顔",
  active: true,
  mensMenu: false,
};

beforeEach(() => {
  updateService.mockReset();
  deleteService.mockReset();
  updateService.mockImplementation((_input, options) => options?.onSuccess?.());
});

describe("ServiceDetailPanel", () => {
  it("詳細を編集し、有効状態を切り替えられる", async () => {
    const user = userEvent.setup();
    render(
      <ServiceDetailPanel
        service={service}
        stores={[{ id: "store-1", name: "新宿店" }]}
        services={[
          service,
          { id: "service-2", storeId: "store-1", name: "顔｜光", active: true },
        ]}
        canEdit
        onClose={() => {}}
      />,
    );

    expect(screen.getByText("組み合わせ割引")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "編集" }));
    expect(screen.getByLabelText("組み合わせ時料金（円）")).toBeTruthy();

    const priceLabel = screen.getByLabelText("料金表示（自由記入・任意）");
    await user.clear(priceLabel);
    await user.type(priceLabel, "¥2,000");
    const comboPrice = screen.getByLabelText("組み合わせ時料金（円）");
    await user.clear(comboPrice);
    await user.type(comboPrice, "1200");
    const duration = screen.getByDisplayValue("55");
    await user.clear(duration);
    await user.type(duration, "65");
    await user.click(screen.getByRole("button", { name: "プリセット" }));
    await user.click(screen.getByRole("button", { name: "カスタム" }));
    const priceAmount = screen.getByLabelText("料金（円・数値・任意）");
    await user.clear(priceAmount);
    await user.type(priceAmount, "1500");
    await user.click(screen.getByRole("button", { name: "キャンセル" }));

    await user.click(screen.getByRole("button", { name: "編集" }));
    // 保存名「脱毛｜全身」はカテゴリ「脱毛」+ 名前「全身」に分解されて表示される。
    expect(screen.getByLabelText("カテゴリ").textContent).toContain("脱毛");
    const name = screen.getByLabelText("メニュー名");
    expect((name as HTMLInputElement).value).toBe("全身");
    await user.clear(name);
    await user.type(name, "全身 プレミアム");
    await user.click(screen.getByRole("button", { name: "保存" }));

    // 保存時はカテゴリと名前が「カテゴリ｜名前」に再合成される (round-trip)。
    expect(updateService).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "service-1",
        name: "脱毛｜全身 プレミアム",
        durationMinutes: 55,
      }),
      expect.objectContaining({ onSuccess: expect.any(Function) }),
    );

    await user.click(screen.getByRole("button", { name: "無効化" }));
    expect(updateService).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: "service-1", active: false }),
    );
    // 有効/無効トグルは mensMenu を送らない (サーバが現在値を維持する)。送ってしまうと
    // 一覧の古い service スナップショットでフラグを踏み潰せるので、ここで固定しておく。
    expect(updateService).toHaveBeenLastCalledWith(
      expect.not.objectContaining({ mensMenu: expect.anything() }),
    );
  });

  it("確認後にメニューを削除する", async () => {
    const user = userEvent.setup();
    render(
      <ServiceDetailPanel
        service={service}
        stores={[]}
        services={[service]}
        canEdit
        onClose={() => {}}
      />,
    );

    await user.click(screen.getByRole("button", { name: "削除" }));
    await user.click(screen.getByRole("button", { name: "削除する" }));
    expect(deleteService).toHaveBeenCalledWith(
      "service-1",
      expect.objectContaining({ onSuccess: expect.any(Function) }),
    );
  });

  it("カテゴリ・名前を触らない編集では保存名を一字も変えない (trim 正規化を起こさない)", async () => {
    const user = userEvent.setup();
    // 区切りの後ろに空白を持つ既存名 (本番には現存しないが、正規化での書き換えは
    // コンボ割引・公開画面の文字列一致を壊し得るため完全可逆を保証する)。
    const spacedService = { ...service, name: "脱毛｜ 全身" };
    render(
      <ServiceDetailPanel
        service={spacedService}
        stores={[]}
        services={[spacedService]}
        canEdit
        onClose={() => {}}
      />,
    );

    await user.click(screen.getByRole("button", { name: "編集" }));
    const priceLabel = screen.getByLabelText("料金表示（自由記入・任意）");
    await user.clear(priceLabel);
    await user.type(priceLabel, "¥3,000");
    await user.click(screen.getByRole("button", { name: "保存" }));

    expect(updateService).toHaveBeenCalledWith(
      expect.objectContaining({ id: "service-1", name: "脱毛｜ 全身", priceLabel: "¥3,000" }),
      expect.objectContaining({ onSuccess: expect.any(Function) }),
    );
  });

  it("「__none__｜」で始まる既存名は実カテゴリとして扱われ、名前変更でも保持される", async () => {
    const user = userEvent.setup();
    // 旧センチネルに似た文字列が実カテゴリだった場合の回帰テスト。制御値と
    // 誤解釈されるとプレフィックスが消えたり編集不能になる。
    const oddService = { ...service, name: "__none__｜全身" };
    render(
      <ServiceDetailPanel
        service={oddService}
        stores={[]}
        services={[oddService]}
        canEdit
        onClose={() => {}}
      />,
    );

    await user.click(screen.getByRole("button", { name: "編集" }));
    expect(screen.getByLabelText("カテゴリ").textContent).toContain("__none__");
    const name = screen.getByLabelText("メニュー名");
    await user.clear(name);
    await user.type(name, "全身V2");
    await user.click(screen.getByRole("button", { name: "保存" }));

    expect(updateService).toHaveBeenCalledWith(
      expect.objectContaining({ id: "service-1", name: "__none__｜全身V2" }),
      expect.objectContaining({ onSuccess: expect.any(Function) }),
    );
  });

  it("旧形式の変則名 (複数｜・空本文) でも料金だけの編集を保存できる (name 検証の免除)", async () => {
    const user = userEvent.setup();
    // 新UIでは作れないがサーバは受理する名前。分解結果は新規則 (｜禁止・空不可) に
    // 通らないが、未変更保存は service.name をそのまま送るため編集を塞がない。
    for (const legacyName of ["脱毛｜全身｜V2", "脱毛｜"]) {
      updateService.mockClear();
      const legacyService = { ...service, name: legacyName };
      const { unmount } = render(
        <ServiceDetailPanel
          service={legacyService}
          stores={[]}
          services={[legacyService]}
          canEdit
          onClose={() => {}}
        />,
      );

      await user.click(screen.getByRole("button", { name: "編集" }));
      const priceLabel = screen.getByLabelText("料金表示（自由記入・任意）");
      await user.clear(priceLabel);
      await user.type(priceLabel, "¥5,000");
      await user.click(screen.getByRole("button", { name: "保存" }));

      expect(updateService).toHaveBeenCalledWith(
        expect.objectContaining({ id: "service-1", name: legacyName, priceLabel: "¥5,000" }),
        expect.objectContaining({ onSuccess: expect.any(Function) }),
      );
      unmount();
    }
  });

  it("「__new__｜」で始まる既存名でも料金だけの編集を保存できる", async () => {
    const user = userEvent.setup();
    const oddService = { ...service, name: "__new__｜光" };
    render(
      <ServiceDetailPanel
        service={oddService}
        stores={[]}
        services={[oddService]}
        canEdit
        onClose={() => {}}
      />,
    );

    await user.click(screen.getByRole("button", { name: "編集" }));
    const priceLabel = screen.getByLabelText("料金表示（自由記入・任意）");
    await user.clear(priceLabel);
    await user.type(priceLabel, "¥4,000");
    await user.click(screen.getByRole("button", { name: "保存" }));

    expect(updateService).toHaveBeenCalledWith(
      expect.objectContaining({ id: "service-1", name: "__new__｜光", priceLabel: "¥4,000" }),
      expect.objectContaining({ onSuccess: expect.any(Function) }),
    );
  });

  it("メニュー名に「｜」を含めると保存できない (分解の round-trip を守る)", async () => {
    const user = userEvent.setup();
    render(
      <ServiceDetailPanel
        service={service}
        stores={[]}
        services={[service]}
        canEdit
        onClose={() => {}}
      />,
    );

    await user.click(screen.getByRole("button", { name: "編集" }));
    const name = screen.getByLabelText("メニュー名");
    await user.clear(name);
    await user.type(name, "全身｜プレミアム");
    expect(
      (screen.getByRole("button", { name: "保存" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(screen.getByText(/「｜」は使えません/)).toBeTruthy();
    expect(updateService).not.toHaveBeenCalled();
  });

  it("canEdit が false のとき編集・有効化・削除ボタンを出さない", () => {
    render(
      <ServiceDetailPanel
        service={service}
        stores={[{ id: "store-1", name: "新宿店" }]}
        services={[service]}
        canEdit={false}
        onClose={() => {}}
      />,
    );

    expect(screen.queryByRole("button", { name: "編集" })).toBeNull();
    expect(screen.queryByRole("button", { name: "無効化" })).toBeNull();
    expect(screen.queryByRole("button", { name: "削除" })).toBeNull();
    // 詳細の閲覧自体はできる
    expect(screen.getByText("組み合わせ割引")).toBeTruthy();
  });

  it("未設定料金と無効状態を表示し、有効化する", async () => {
    const user = userEvent.setup();
    const inactiveService = {
      ...service,
      active: false,
      durationMinutes: 60,
      priceLabel: null,
      priceAmount: null,
      comboPriceAmount: null,
      comboWithPrefix: null,
    };
    render(
      <ServiceDetailPanel
        service={inactiveService}
        stores={[]}
        services={[inactiveService]}
        canEdit
        onClose={() => {}}
      />,
    );

    expect(screen.getAllByText("未設定")).toHaveLength(2);
    await user.click(screen.getByRole("button", { name: "有効化" }));
    expect(updateService).toHaveBeenCalledWith(
      expect.objectContaining({ id: "service-1", active: true }),
    );
  });
});
