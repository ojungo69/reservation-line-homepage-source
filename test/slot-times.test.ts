import { describe, expect, it } from "vitest";

import {
  applyPhotoComboDuration,
  buildBookingContext,
  collectBookingServices
} from "../src/reservations/slot-times";

// 本番のサービスID接尾辞を用いる（判定は接尾辞照合。ストア接頭辞は任意）。
const UPPER = "service_osaka_hair_removal_upper_focus_45"; // 全身（上半身集中）55分
const LOWER = "service_osaka_hair_removal_lower_focus_45"; // 全身（下半身集中）55分
const GROWTH = "service_osaka_hair_removal_growth_45"; //     全身脱毛（生やし）55分
const FULL = "service_osaka_hair_removal_full_60"; //         全身脱毛（口周り・VIO込み）55分
const PHOTO = "service_osaka_facial_photo_30"; //             フォト光 5分
const PARTIAL = "service_osaka_hair_removal_partial_armpits_5"; // 部分脱毛ワキ 5分（対象外）
const KIDS = "service_osaka_hair_removal_kids_full_60"; //    キッズ全身脱毛 55分（対象外）

const svc = (id: string, durationMinutes: number) => ({ id, durationMinutes });

describe("applyPhotoComboDuration", () => {
  it("全身脱毛系 + サンプル 05 → サンプル 05を0分に吸収する", () => {
    expect(applyPhotoComboDuration([svc(UPPER, 55), svc(PHOTO, 5)])).toEqual([55, 0]);
  });

  it("対象の全身脱毛系4種すべてでサンプル 05を吸収する", () => {
    for (const id of [UPPER, LOWER, GROWTH, FULL]) {
      expect(applyPhotoComboDuration([svc(id, 55), svc(PHOTO, 5)])).toEqual([55, 0]);
    }
  });

  it("サンプル 05が先頭でも順序を保って吸収する", () => {
    expect(applyPhotoComboDuration([svc(PHOTO, 5), svc(FULL, 55)])).toEqual([0, 55]);
  });

  it("部分脱毛 + サンプル 05 → 吸収しない（対象外メニュー）", () => {
    expect(applyPhotoComboDuration([svc(PARTIAL, 5), svc(PHOTO, 5)])).toEqual([5, 5]);
  });

  it("キッズ全身 + サンプル 05 → 吸収しない（_hair_removal_full_60 に部分一致しない）", () => {
    expect(applyPhotoComboDuration([svc(KIDS, 55), svc(PHOTO, 5)])).toEqual([55, 5]);
  });

  it("サンプル 05単体 → 変化なし", () => {
    expect(applyPhotoComboDuration([svc(PHOTO, 5)])).toEqual([5]);
  });

  it("全身脱毛系単体 → 変化なし", () => {
    expect(applyPhotoComboDuration([svc(UPPER, 55)])).toEqual([55]);
  });

  it("全身脱毛系 + サンプル 05 + 別メニュー → サンプル 05のみ0、他は加算", () => {
    expect(applyPhotoComboDuration([svc(UPPER, 55), svc(PHOTO, 5), svc(PARTIAL, 5)])).toEqual([55, 0, 5]);
  });

  it("サンプル 05を含まない全身脱毛系のみ → 変化なし", () => {
    expect(applyPhotoComboDuration([svc(UPPER, 55), svc(LOWER, 55)])).toEqual([55, 55]);
  });

  it("空配列 → 空配列", () => {
    expect(applyPhotoComboDuration([])).toEqual([]);
  });
});

type ServiceRow = { id: string; store_id: string; name: string; duration_minutes: number };

// 公開/管理どちらの fetchBookingContext も同じ検証を通す共有ヘルパー。
// db.prepare(...).bind(...).all() が渡した services 行を返すだけの最小 D1 モック。
const mockDb = (rows: ServiceRow[]) =>
  ({
    prepare: () => ({
      bind: () => ({
        all: async () => ({ results: rows })
      })
    })
  }) as unknown as D1Database;

const row = (id: string, store_id: string, duration_minutes: number): ServiceRow => ({
  id,
  store_id,
  name: id,
  duration_minutes
});

describe("collectBookingServices", () => {
  it("有効なサービス → services と durationMinutes(合計+5分間隔)を返す", async () => {
    const result = await collectBookingServices(mockDb([row(UPPER, "osaka", 55)]), "osaka", [UPPER]);
    expect(result).toEqual({
      ok: true,
      services: [{ id: UPPER, name: UPPER, durationMinutes: 55 }],
      durationMinutes: 60
    });
  });

  it("要求 id が active な行に無い → service_not_available", async () => {
    const result = await collectBookingServices(mockDb([]), "osaka", [UPPER]);
    expect(result).toEqual({ ok: false, reason: "service_not_available" });
  });

  it("空 serviceIds → service_not_available(IN () 不正SQL/無サービス予約を fail-closed)", async () => {
    const result = await collectBookingServices(mockDb([]), "osaka", []);
    expect(result).toEqual({ ok: false, reason: "service_not_available" });
  });

  it("別店舗のサービス → service_not_available", async () => {
    const result = await collectBookingServices(mockDb([row(UPPER, "kyoto", 55)]), "osaka", [UPPER]);
    expect(result).toEqual({ ok: false, reason: "service_not_available" });
  });

  it("スロット間隔(5分)に整列しない施術時間 → service_not_available", async () => {
    const result = await collectBookingServices(mockDb([row(UPPER, "osaka", 52)]), "osaka", [UPPER]);
    expect(result).toEqual({ ok: false, reason: "service_not_available" });
  });

  it("全身脱毛系 + サンプル 05 → サンプル 05を吸収して合計 durationMinutes に反映", async () => {
    const result = await collectBookingServices(
      mockDb([row(FULL, "osaka", 55), row(PHOTO, "osaka", 5)]),
      "osaka",
      [FULL, PHOTO]
    );
    // フォト光は占有時間0に吸収 → 55 + 5(間隔) = 60。services は実施術時間のまま。
    expect(result).toEqual({
      ok: true,
      services: [
        { id: FULL, name: FULL, durationMinutes: 55 },
        { id: PHOTO, name: PHOTO, durationMinutes: 5 }
      ],
      durationMinutes: 60
    });
  });

  it("予約可能上限(235分)を超える合計 → invalid_request", async () => {
    const ids = [UPPER, LOWER, GROWTH, FULL, "service_osaka_hair_removal_growth_45_dup"];
    const rows = ids.map((id) => row(id, "osaka", 55)); // 5 × 55 = 275 > 235
    const result = await collectBookingServices(mockDb(rows), "osaka", ids);
    expect(result).toEqual({ ok: false, reason: "invalid_request" });
  });
});

// 公開/管理の fetchBookingContext 共有末尾。store/resource 行の検証 + services 付与。
const contextRow = (resourceStoreId: string, extra: Record<string, unknown> = {}) => ({
  storeId: "osaka",
  timezone: "Asia/Tokyo",
  resourceId: "res_osaka_1",
  resourceStoreId,
  ...extra
});

describe("buildBookingContext", () => {
  it("店舗/リソース行が null → store_not_found", async () => {
    const result = await buildBookingContext(mockDb([]), "osaka", [UPPER], null);
    expect(result).toEqual({ ok: false, reason: "store_not_found" });
  });

  it("resourceStoreId が storeId と不一致 → resource_not_available", async () => {
    const result = await buildBookingContext(
      mockDb([row(UPPER, "osaka", 55)]),
      "osaka",
      [UPPER],
      contextRow("kyoto")
    );
    expect(result).toEqual({ ok: false, reason: "resource_not_available" });
  });

  it("サービス検証失敗を伝播 → service_not_available", async () => {
    const result = await buildBookingContext(mockDb([]), "osaka", [UPPER], contextRow("osaka"));
    expect(result).toEqual({ ok: false, reason: "service_not_available" });
  });

  it("有効 → 元行に serviceId/serviceIds/services/durationMinutes を付与(呼び出し元固有列は温存)", async () => {
    const result = await buildBookingContext(
      mockDb([row(UPPER, "osaka", 55)]),
      "osaka",
      [UPPER],
      contextRow("osaka", { bookingWindowDays: 30 }) // public 固有列がそのまま残ることを確認
    );
    expect(result).toEqual({
      ok: true,
      context: {
        storeId: "osaka",
        timezone: "Asia/Tokyo",
        resourceId: "res_osaka_1",
        resourceStoreId: "osaka",
        bookingWindowDays: 30,
        serviceId: UPPER,
        serviceIds: [UPPER],
        services: [{ id: UPPER, name: UPPER, durationMinutes: 55 }],
        durationMinutes: 60
      }
    });
  });
});
