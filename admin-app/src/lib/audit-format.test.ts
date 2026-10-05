import { describe, expect, it } from "vitest";
import type { AuditLogItem } from "@/types/api";
import {
  formatAuditSummary,
  formatTargetLabel,
  normalizeTimestamp,
  safeParseJson,
} from "./audit-format";

const log = (
  overrides: Partial<AuditLogItem> = {},
): AuditLogItem => ({
  id: "log-1",
  actorType: "staff",
  actorId: "staff-1",
  action: "approve",
  targetType: "reservation",
  targetId: "reservation-1",
  metadataJson: null,
  rejectionReason: null,
  createdAt: "2026-07-24 10:00:00",
  ...overrides,
});

describe("audit formatting", () => {
  it("formats a mapped staff name and known action", () => {
    expect(
      formatAuditSummary(
        log(),
        new Map([["staff-1", "山田 花子"]]),
      ),
    ).toBe("山田 花子 が 予約を承認");
  });

  it("falls back to the generic staff label for an unknown staff id", () => {
    expect(formatAuditSummary(log(), new Map())).toBe(
      "スタッフ が 予約を承認",
    );
  });

  it("formats known non-staff actors and dotted actions", () => {
    expect(
      formatAuditSummary(
        log({
          actorType: "google_calendar",
          actorId: null,
          action: "settings.services.create",
        }),
        new Map(),
      ),
    ).toBe("Google Calendar が メニューを追加");
  });

  it("preserves unknown actor and action values", () => {
    expect(
      formatAuditSummary(
        log({
          actorType: "future_actor",
          actorId: null,
          action: "future_action",
        }),
        new Map(),
      ),
    ).toBe("future_actor が future_action");
  });

  it.each([
    ["reservation", "予約"],
    ["customer_visit", "来店記録"],
    ["future_target", "future_target"],
  ])("formats target %s", (target, expected) => {
    expect(formatTargetLabel(target)).toBe(expected);
  });

  it("normalizes SQLite timestamps to UTC ISO input", () => {
    expect(normalizeTimestamp("2026-07-24 10:20:30")).toBe(
      "2026-07-24T10:20:30Z",
    );
  });

  it("preserves timestamps that are already in another format", () => {
    expect(normalizeTimestamp("2026-07-24T10:20:30+09:00")).toBe(
      "2026-07-24T10:20:30+09:00",
    );
  });

  it("pretty-prints valid metadata JSON", () => {
    expect(safeParseJson('{"count":2,"ok":true}')).toBe(
      '{\n  "count": 2,\n  "ok": true\n}',
    );
  });

  it("returns invalid metadata unchanged", () => {
    expect(safeParseJson("{not-json")).toBe("{not-json");
  });
});

describe("終端状態の訂正の監査ラベル", () => {
  it("訂正アクションを日本語で表示する (内部コードを出さない)", () => {
    const staff = new Map([["staff-1", "山田 花子"]]);
    expect(
      formatAuditSummary(log({ action: "admin_reservation_correct_no_show" }), staff),
    ).toBe("山田 花子 が 予約を来店なしに訂正");
    expect(
      formatAuditSummary(log({ action: "admin_reservation_restore_completed" }), staff),
    ).toBe("山田 花子 が 予約を完了に戻す");
  });
});

describe("顧客タブの承認ゲートの監査ラベル (spec 008)", () => {
  it("3 つのアクションと admin_user を日本語で表示する (内部コードを出さない)", () => {
    const staff = new Map([["staff-1", "山田 花子"]]);
    expect(formatAuditSummary(log({ action: "customer_gate_code_requested" }), staff)).toBe(
      "山田 花子 が 顧客タブの確認コードを申請",
    );
    expect(formatAuditSummary(log({ action: "customer_gate_verified" }), staff)).toBe(
      "山田 花子 が 顧客タブの確認コードを照合",
    );
    // オーナーが「誰かがコードを何度も間違えている」に気付ける唯一の経路なので、
    // ここが英語のコードのままだと読み飛ばされる。
    expect(formatAuditSummary(log({ action: "customer_gate_verify_failed" }), staff)).toBe(
      "山田 花子 が 顧客タブの確認コードが不一致",
    );
    expect(formatTargetLabel("admin_user")).toBe("管理ユーザー");
  });
});
