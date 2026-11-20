import { describe, expect, it } from "vitest";
import type { StoreResources } from "@/lib/store-resources";
import { derivePreviewInvalid } from "./recurring-blocks-tab";

// 元はネスト三項 8 段だった検証チェーン。分解しても「最初に該当した理由だけを返す」
// 順序が変わっていないことを、後段の理由も同時に成立する入力で確かめる。
type Args = {
  storeId: string | null;
  days: number[];
  duration: number;
  startDate: string;
  endDate: string;
  resourceId: string;
  kind: StoreResources["kind"];
};

const valid: Args = {
  storeId: "store-1",
  days: [1, 3],
  duration: 60,
  startDate: "2026-08-01",
  endDate: "2026-08-31",
  resourceId: "resource-1",
  kind: "multiple",
};

const call = (o: Partial<Args> = {}) => {
  const a = { ...valid, ...o };
  return derivePreviewInvalid(
    a.storeId,
    a.days,
    a.duration,
    a.startDate,
    a.endDate,
    a.resourceId,
    a.kind,
  );
};

describe("derivePreviewInvalid", () => {
  it("全て揃っていれば null", () => {
    expect(call()).toBeNull();
  });

  it("枠が 1 つなら選択済みとして扱い、null", () => {
    expect(call({ kind: "single" })).toBeNull();
  });

  it("枠が未設定のときは、ほかが全部有効でも案内の理由を返す", () => {
    expect(call({ kind: "none", resourceId: "" })).toEqual({
      field: null,
      message: "この店舗は予約枠が未設定です。店舗設定の「リソース」タブで追加してください。",
    });
  });

  it("枠が未設定の理由は、曜日が未選択でも先に返す", () => {
    expect(call({ kind: "none", resourceId: "", days: [] })).toEqual({
      field: null,
      message: "この店舗は予約枠が未設定です。店舗設定の「リソース」タブで追加してください。",
    });
  });

  it("枠が未判定（設定の読み込み中）のときは、リソースを選ばせず読み込み中を返す", () => {
    const loading = { field: null, message: "店舗の設定を読み込み中です" };
    expect(call({ kind: "unknown", resourceId: "" })).toEqual(loading);
    expect(call({ kind: "unknown", resourceId: "", days: [] })).toEqual(loading);
    expect(call({ kind: "unknown", resourceId: "", storeId: null })).toEqual({
      field: null,
      message: "店舗を選択してください",
    });
  });

  it.each([
    ["店舗未選択", { storeId: null }, null, "店舗を選択してください"],
    ["曜日未選択", { days: [] }, null, "曜日を選択してください"],
    ["終了 <= 開始", { duration: 0 }, "endTime", "終了時刻は開始時刻より後にしてください"],
    ["4時間超", { duration: 241 }, "endTime", "1件あたり4時間（240分）以内にしてください"],
    ["開始日未入力", { startDate: "" }, "startDate", "開始日を入力してください"],
    ["終了日未入力", { endDate: "" }, "endDate", "終了日を入力してください"],
    ["終了日 < 開始日", { endDate: "2026-07-31" }, "endDate", "終了日は開始日以降にしてください"],
    ["リソース未選択", { resourceId: "" }, "resourceId", "リソースを選択してください"],
  ])("%s", (_name, patch, field, message) => {
    expect(call(patch as Partial<typeof valid>)).toEqual({ field, message });
  });

  it("複数該当時は先に定義された理由を返す（順序保持）", () => {
    // 店舗未選択 + 曜日未選択 + 終了<=開始 + リソース未選択 が同時成立。
    expect(call({ storeId: null, days: [], duration: 0, resourceId: "" })).toEqual({
      field: null,
      message: "店舗を選択してください",
    });
    // 店舗だけ埋めると次の理由へ繰り上がる。
    expect(call({ days: [], duration: 0, resourceId: "" })).toEqual({
      field: null,
      message: "曜日を選択してください",
    });
    // 240分超と終了日逆転が同時成立しても endTime が先。
    expect(call({ duration: 241, endDate: "2026-07-31" })).toEqual({
      field: "endTime",
      message: "1件あたり4時間（240分）以内にしてください",
    });
  });
});
