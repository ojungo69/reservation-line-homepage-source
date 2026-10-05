import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExternalBlock } from "@/types/api";

const mocks = vi.hoisted(() => ({
  cancel: { mutate: vi.fn(), isPending: false },
  privileged: true,
}));

vi.mock("@/hooks/use-external-blocks", () => ({
  useExternalBlockCancel: () => mocks.cancel,
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ isPrivileged: mocks.privileged }),
}));

import { ExternalBlockCard } from "./external-block-card";

const block = (source: ExternalBlock["source"]): ExternalBlock =>
  ({
    id: "block-1",
    storeId: "store-1",
    source,
    titleSnapshot: "研修",
    startAt: "2026-07-24T10:00:00+09:00",
    endAt: "2026-07-24T11:00:00+09:00",
    status: "active",
  }) as ExternalBlock;

// minutes/slotPx から実高を導出する (60分 × 48px/15分 = 192px) — 2 行とも
// 収まる高さなので、既存アサーションは時刻行が出ている前提のまま通る。
const style = { top: "10px", height: "40px", minutes: 60 };
const SLOT_PX = 48;

beforeEach(() => {
  mocks.cancel.mutate.mockReset();
  mocks.cancel.isPending = false;
  mocks.privileged = true;
});

describe("ExternalBlockCard", () => {
  it("Google 由来ブロックは解除ボタンなしで表示し、時間帯を弱調行に出す", () => {
    render(<ExternalBlockCard block={block("google_event")} style={style} slotPx={SLOT_PX} />);
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText("研修")).toBeTruthy();
    const time = screen.getByText("10:00–11:00");
    // 高さ=時間長のジオメトリ面マーカー (44px 最小化ゲートの除外対象)。
    expect(time.closest("[data-duration-geometry]")).not.toBeNull();
  });

  it("staff には admin_block でも解除アクションを出さない", () => {
    mocks.privileged = false;
    render(<ExternalBlockCard block={block("admin_block")} style={style} slotPx={SLOT_PX} />);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("onBlockClick 指定時はクリックを親へ委譲する", async () => {
    const user = userEvent.setup();
    const onBlockClick = vi.fn();
    render(
      <ExternalBlockCard block={block("admin_block")} style={style} slotPx={SLOT_PX} onBlockClick={onBlockClick} />,
    );
    await user.click(screen.getByRole("button", { name: "ブロック 研修 10:00–11:00 を解除" }));
    expect(onBlockClick).toHaveBeenCalledWith("block-1");
  });

  it("onBlockClick なしでは自前ダイアログを開き、理由付きで解除を実行する", async () => {
    const user = userEvent.setup();
    render(<ExternalBlockCard block={block("admin_block")} style={style} slotPx={SLOT_PX} />);

    await user.click(screen.getByRole("button", { name: "ブロック 研修 10:00–11:00 を解除" }));
    expect(screen.getByText("ブロックを解除しますか?")).toBeTruthy();

    await user.type(screen.getByLabelText("理由（任意）"), "予定変更のため");
    await user.click(screen.getByRole("button", { name: "解除する" }));
    expect(mocks.cancel.mutate).toHaveBeenCalledWith(
      { externalBlockId: "block-1", reason: "予定変更のため" },
      expect.objectContaining({ onSuccess: expect.any(Function) }),
    );
  });

  // compact 密度の 15 分ブロックは実高 24px。text-xs 2 行 (32px) + py 4px +
  // border 2px = 38px 必要なので、時刻行を出すと overflow-hidden で途中まで
  // 見える切れ方をする (codex P2)。閾値 38px の両側を固定する。
  it("収まらない高さでは時刻行を視覚的に隠し、閾値ちょうどでは出す", () => {
    const short = { top: "0px", height: "24px", minutes: 15 };
    const { unmount } = render(
      <ExternalBlockCard block={block("admin_block")} style={short} slotPx={24} />,
    );
    expect(screen.getByText("研修")).toBeTruthy();
    // DOM からは外さない (sr-only)。外すと title だけが残り、PR#350 で撤廃した
    // 「title= 依存でタッチだと読めない」状態に戻る。
    expect(screen.getByText("10:00–11:00").className).toContain("sr-only");
    // 行を隠しても解除ボタンの aria-label には時間帯が残る。
    const card = screen.getByRole("button", { name: "ブロック 研修 10:00–11:00 を解除" });
    expect(card).toBeTruthy();
    // 5 分ブロックのようにスロット未満でもラベル行が clip されない下限。
    // 16px (text-xs) + py 4px + border 2px = 22px (実ブラウザ実測で確認)。
    expect(card.style.minHeight).toBe("22px");
    unmount();

    render(<ExternalBlockCard block={block("admin_block")} style={short} slotPx={38} />);
    expect(screen.getByText("10:00–11:00").className).not.toContain("sr-only");
  });

  it("解除不可ブロックは時刻行を隠しても読み上げ経路と title を残す", () => {
    render(
      <ExternalBlockCard
        block={block("google_event")}
        style={{ top: "0px", height: "24px", minutes: 15 }}
        slotPx={24}
      />,
    );
    // 解除不可ブロックは button ではないので aria-label の経路が無い。
    // title だけに頼らず、読み上げ可能なテキストとして残す。
    expect(screen.getByText("10:00–11:00").className).toContain("sr-only");
    expect(screen.getByTitle("研修 10:00–11:00")).toBeTruthy();
  });
});
