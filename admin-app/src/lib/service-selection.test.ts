import { describe, expect, it } from "vitest";
import {
  MAX_ADMIN_TOTAL_SERVICE_DURATION_MINUTES,
  MAX_SERVICE_SELECTIONS,
  buildServiceSelectionPayload,
  canAddService,
  isOverSelectionLimit,
  nextTimeAfterServiceChange,
  splitRebookServiceIds,
  totalServiceDuration,
} from "./service-selection";

const svc = (id: string, durationMinutes: number) => ({ id, durationMinutes });

describe("totalServiceDuration", () => {
  it("選択メニューの施術時間を合算する", () => {
    const services = [svc("a", 30), svc("b", 45)];
    expect(totalServiceDuration(["a", "b"], services)).toBe(75);
  });

  it("一覧に無い ID は 0 扱い", () => {
    expect(totalServiceDuration(["ghost"], [svc("a", 30)])).toBe(0);
  });
});

describe("totalServiceDuration — サンプル 05の全身脱毛系吸収", () => {
  const UPPER = "service_osaka_hair_removal_upper_focus_45";
  const LOWER = "service_osaka_hair_removal_lower_focus_45";
  const GROWTH = "service_osaka_hair_removal_growth_45";
  const FULL = "service_osaka_hair_removal_full_60";
  const PHOTO = "service_osaka_facial_photo_30";
  const PARTIAL = "service_osaka_hair_removal_partial_armpits_5";
  const KIDS = "service_osaka_hair_removal_kids_full_60";
  const services = [
    svc(UPPER, 55), svc(LOWER, 55), svc(GROWTH, 55), svc(FULL, 55),
    svc(PHOTO, 5), svc(PARTIAL, 5), svc(KIDS, 55),
  ];

  it("全身脱毛系 + サンプル 05 → サンプル 05は0分に吸収（55のまま）", () => {
    expect(totalServiceDuration([UPPER, PHOTO], services)).toBe(55);
  });

  it("対象4種すべてでサンプル 05を吸収する", () => {
    for (const id of [UPPER, LOWER, GROWTH, FULL]) {
      expect(totalServiceDuration([id, PHOTO], services)).toBe(55);
    }
  });

  it("部分脱毛 + サンプル 05 → 吸収しない（対象外）", () => {
    expect(totalServiceDuration([PARTIAL, PHOTO], services)).toBe(10);
  });

  it("キッズ全身 + サンプル 05 → 吸収しない（対象外）", () => {
    expect(totalServiceDuration([KIDS, PHOTO], services)).toBe(60);
  });

  it("サンプル 05単体 → 変化なし", () => {
    expect(totalServiceDuration([PHOTO], services)).toBe(5);
  });

  it("全身脱毛系単体 → 変化なし", () => {
    expect(totalServiceDuration([UPPER], services)).toBe(55);
  });

  it("全身脱毛系 + サンプル 05 + 部分脱毛 → サンプル 05のみ0、他は加算", () => {
    expect(totalServiceDuration([UPPER, PHOTO, PARTIAL], services)).toBe(60);
  });

  it("services に無い全身脱毛系 ID では吸収しない（サンプル 05は加算される）", () => {
    // UPPER は suffix 上は全身脱毛系だが services に含まれない（無効化・削除済み想定）。
    const withoutUpper = services.filter((s) => s.id !== UPPER);
    expect(totalServiceDuration([UPPER, PHOTO], withoutUpper)).toBe(5);
  });

  it("canAddService: 上限際の全身脱毛系にサンプル 05を足せる（吸収で合算が増えない）", () => {
    const near = [svc("bulk", MAX_ADMIN_TOTAL_SERVICE_DURATION_MINUTES - 55), svc(UPPER, 55), svc(PHOTO, 5)];
    // bulk + UPPER で 235 ちょうど。フォト光は吸収され合算据え置きなので追加可。
    expect(canAddService(near[2], ["bulk", UPPER], near)).toBe(true);
  });
});

describe("canAddService — 件数上限12件", () => {
  const services = Array.from({ length: 13 }, (_, i) => svc(`s${i}`, 10));

  it("12件選択済みのとき未選択メニューは追加不可", () => {
    const selected = services.slice(0, MAX_SERVICE_SELECTIONS).map((s) => s.id);
    expect(canAddService(services[12], selected, services)).toBe(false);
  });

  it("選択済みメニュー自身は常に true（解除操作を塞がない）", () => {
    const selected = services.slice(0, MAX_SERVICE_SELECTIONS).map((s) => s.id);
    expect(canAddService(services[0], selected, services)).toBe(true);
  });
});

describe("canAddService — 時間上限（235分 = reschedule 占有上限との整合値）", () => {
  it("合算がちょうど上限になる追加は可", () => {
    const services = [svc("a", MAX_ADMIN_TOTAL_SERVICE_DURATION_MINUTES - 60), svc("b", 60)];
    expect(canAddService(services[1], ["a"], services)).toBe(true);
  });

  it("合算が上限を超える追加は不可", () => {
    const services = [svc("a", MAX_ADMIN_TOTAL_SERVICE_DURATION_MINUTES - 60), svc("b", 61)];
    expect(canAddService(services[1], ["a"], services)).toBe(false);
  });
});

describe("isOverSelectionLimit", () => {
  it("上限ちょうどは上限内", () => {
    const services = [svc("a", MAX_ADMIN_TOTAL_SERVICE_DURATION_MINUTES)];
    expect(isOverSelectionLimit(["a"], services)).toBe(false);
  });

  it("上限+1分は超過（rebook 初期値の超過ケース = 空き枠取得・送信を抑止する判定）", () => {
    const services = [svc("a", MAX_ADMIN_TOTAL_SERVICE_DURATION_MINUTES + 1)];
    expect(isOverSelectionLimit(["a"], services)).toBe(true);
  });

  it("13件は件数超過", () => {
    const services = Array.from({ length: 13 }, (_, i) => svc(`s${i}`, 5));
    expect(isOverSelectionLimit(services.map((s) => s.id), services)).toBe(true);
  });
});

describe("splitRebookServiceIds", () => {
  it("現在の一覧に無い ID を unavailable に分離する（state・合算・payload に残さない）", () => {
    const services = [svc("a", 30)];
    const { available, unavailable } = splitRebookServiceIds(["a", "retired"], services);
    expect(available).toEqual(["a"]);
    expect(unavailable).toEqual(["retired"]);
  });
});

describe("buildServiceSelectionPayload", () => {
  it("単一選択は serviceIds + 旧互換 serviceId を併送する", () => {
    expect(buildServiceSelectionPayload(["a"])).toEqual({
      serviceIds: ["a"],
      serviceId: "a",
    });
  });

  it("複数選択は serviceIds のみ（旧 backend では fail-closed）", () => {
    const payload = buildServiceSelectionPayload(["a", "b"]);
    expect(payload).toEqual({ serviceIds: ["a", "b"] });
    expect("serviceId" in payload).toBe(false);
  });
});

describe("nextTimeAfterServiceChange", () => {
  it("空き枠クリック由来の時刻はメニュー変更でリセットする", () => {
    expect(nextTimeAfterServiceChange("10:30", true)).toBe("");
  });

  it("手入力の時刻は維持する", () => {
    expect(nextTimeAfterServiceChange("10:30", false)).toBe("10:30");
  });
});
