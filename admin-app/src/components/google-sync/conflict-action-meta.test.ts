import { describe, expect, it } from "vitest";
import {
  ACTION_LABELS,
  ACTION_HELP,
  actionHasSideEffect,
  confirmCopyForAction,
  type ActionType,
} from "./conflict-action-meta";

describe("ACTION_LABELS", () => {
  it("keeps the existing button labels unchanged", () => {
    expect(ACTION_LABELS["manual-resolve"]).toBe("手動解決");
    expect(ACTION_LABELS.ignore).toBe("無視");
    expect(ACTION_LABELS["manual-resolve-cancel-block"]).toBe("解決（ブロック取消）");
    expect(ACTION_LABELS["approve-cancel"]).toBe("キャンセル承認");
  });
});

describe("ACTION_HELP", () => {
  it("explains the no-op nature of 手動解決 and 無視", () => {
    expect(ACTION_HELP["manual-resolve"]).toContain("データは変更しません");
    expect(ACTION_HELP.ignore).toContain("データは変更しません");
  });

  it("provides help text for every action type", () => {
    const actions: ActionType[] = [
      "ignore",
      "manual-resolve",
      "manual-resolve-cancel-block",
      "approve-cancel",
      "reject-delete",
      "all-day-approve",
      "all-day-reject",
    ];
    for (const a of actions) {
      expect(ACTION_HELP[a].length).toBeGreaterThan(0);
    }
  });
});

describe("actionHasSideEffect", () => {
  it("flags actions that move slots / mutate data as side-effectful", () => {
    expect(actionHasSideEffect("manual-resolve-cancel-block")).toBe(true);
    expect(actionHasSideEffect("approve-cancel")).toBe(true);
    expect(actionHasSideEffect("reject-delete")).toBe(true);
    expect(actionHasSideEffect("all-day-approve")).toBe(true);
    expect(actionHasSideEffect("all-day-reject")).toBe(true);
  });

  it("flags 手動解決 and 無視 as no-ops (no slot movement)", () => {
    expect(actionHasSideEffect("manual-resolve")).toBe(false);
    expect(actionHasSideEffect("ignore")).toBe(false);
  });
});

describe("confirmCopyForAction", () => {
  it("uses the existing slot-moving copy for cancel-block and approve-cancel", () => {
    expect(confirmCopyForAction("manual-resolve-cancel-block")).toContain(
      "枠ロックも解放します",
    );
    expect(confirmCopyForAction("approve-cancel")).toContain("枠を解放します");
  });

  it("uses no-op copy for 手動解決 and 無視 instead of a generic prompt", () => {
    expect(confirmCopyForAction("manual-resolve")).toContain("データは変更しません");
    expect(confirmCopyForAction("ignore")).toContain("データは変更しません");
    expect(confirmCopyForAction("manual-resolve")).not.toBe("この操作を実行しますか？");
  });

  it("returns a non-empty string for the remaining actions", () => {
    expect(confirmCopyForAction("reject-delete").length).toBeGreaterThan(0);
    expect(confirmCopyForAction("all-day-approve").length).toBeGreaterThan(0);
    expect(confirmCopyForAction("all-day-reject").length).toBeGreaterThan(0);
  });
});
