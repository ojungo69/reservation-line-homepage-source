import { describe, expect, it } from "vitest";
import type { Resource, SettingsResponse, Store } from "@/types/api";
import { resolveCreateTarget, resolveStoreResources } from "@/lib/store-resources";

const resource = (id: string, storeId: string, active = true): Resource => ({
  id,
  storeId,
  name: `枠 ${id}`,
  resourceType: "staff_calendar",
  active,
});

// s1: 稼働中 1（停止中 1）/ s2: 稼働中 2（停止中 1）/ s3: 停止中だけ / s4: 枠なし
const S1_ACTIVE = resource("s1-a", "s1");
const S2_A = resource("s2-a", "s2");
const S2_B = resource("s2-b", "s2");
const RESOURCES: Resource[] = [
  S1_ACTIVE,
  resource("s1-off", "s1", false),
  S2_A,
  S2_B,
  resource("s2-off", "s2", false),
  resource("s3-off", "s3", false),
];

const store = (id: string, name: string): Store => ({
  id,
  name,
  timezone: "Asia/Tokyo",
  googleCalendarId: null,
  googleControlledEditMode: false,
  maxActiveReservationsPerCustomer: 2,
  bookingWindowDays: 60,
  customerNotice: null,
});

const settingsWith = (stores: Store[]): SettingsResponse["settings"] => ({
  stores,
  resources: RESOURCES,
  services: [],
  businessHours: [],
  closures: [],
});

describe("resolveStoreResources", () => {
  it("設定のデータが無い（読み込み中・取得失敗）ときは unknown", () => {
    expect(resolveStoreResources(undefined, "s1")).toEqual({ kind: "unknown", resourceId: "" });
  });

  it.each(["", null, undefined])("店舗が未決定（%s）なら、ほかの店舗の枠があっても unknown", (storeId) => {
    expect(resolveStoreResources(RESOURCES, storeId)).toEqual({ kind: "unknown", resourceId: "" });
  });

  it.each(["s3", "s4"])("稼働中の枠が無い店舗（%s）は none。停止中の枠は数えない", (storeId) => {
    expect(resolveStoreResources(RESOURCES, storeId)).toEqual({ kind: "none", resourceId: "" });
  });

  it("空の配列は、取得できたうえで本当に 0 件なので none", () => {
    expect(resolveStoreResources([], "s1")).toEqual({ kind: "none", resourceId: "" });
  });

  it("稼働中がちょうど 1 つなら single で、その枠を送る", () => {
    expect(resolveStoreResources(RESOURCES, "s1")).toEqual({
      kind: "single",
      resource: S1_ACTIVE,
      resourceId: "s1-a",
    });
  });

  it.each(["s1-off", "s2-a", "missing"])(
    "single では、選んだ値（%s）が停止中やほかの店舗の枠でも、その店舗の稼働中の枠を送る",
    (selectedId) => {
      expect(resolveStoreResources(RESOURCES, "s1", selectedId).resourceId).toBe("s1-a");
    },
  );

  it("稼働中が 2 つ以上なら multiple で、候補は稼働中の枠だけ", () => {
    expect(resolveStoreResources(RESOURCES, "s2")).toEqual({
      kind: "multiple",
      resources: [S2_A, S2_B],
      resourceId: "",
    });
  });

  it("multiple で候補の枠を選んでいれば、その値を送る", () => {
    expect(resolveStoreResources(RESOURCES, "s2", "s2-b").resourceId).toBe("s2-b");
  });

  it.each(["", "s2-off", "s1-a", "missing"])(
    "multiple で候補に無い値（%s）は送らない",
    (selectedId) => {
      expect(resolveStoreResources(RESOURCES, "s2", selectedId).resourceId).toBe("");
    },
  );
});

describe("resolveCreateTarget", () => {
  const ONE_STORE = settingsWith([store("s1", "本店")]);
  const TWO_STORES = settingsWith([store("s1", "本店"), store("s2", "二号店")]);

  it("設定の店舗が 1 件なら、選んでいなくてもその店舗に決まり、欄を出さない", () => {
    const target = resolveCreateTarget(ONE_STORE, "", "");
    expect(target.storeId).toBe("s1");
    expect(target.storeName).toBe("本店");
    expect(target.soleStore).toBe(true);
    expect(target.resources.resourceId).toBe("s1-a");
    expect(target.saveBlocked).toBe(false);
  });

  it("設定の店舗が 1 件なら、初期値に別の店舗が渡されてもその店舗に決まる", () => {
    expect(resolveCreateTarget(ONE_STORE, "s2", "").storeId).toBe("s1");
  });

  it("店舗が 2 件なら、選んだ店舗のまま欄を出す", () => {
    const target = resolveCreateTarget(TWO_STORES, "s2", "");
    expect(target.storeId).toBe("s2");
    expect(target.storeName).toBe("二号店");
    expect(target.soleStore).toBe(false);
    expect(target.resources.kind).toBe("multiple");
  });

  it("店舗が 2 件で未選択なら unknown。保存は止めず、必須の検査に任せる", () => {
    const target = resolveCreateTarget(TWO_STORES, "", "");
    expect(target.storeId).toBe("");
    expect(target.storeName).toBeNull();
    expect(target.resources.kind).toBe("unknown");
    expect(target.saveBlocked).toBe(false);
  });

  it.each(["", "s1"])("設定がまだ無い（選んだ店舗: %s）なら保存を止める", (chosenStoreId) => {
    const target = resolveCreateTarget(null, chosenStoreId, "s1-a");
    expect(target.soleStore).toBe(false);
    expect(target.resources).toEqual({ kind: "unknown", resourceId: "" });
    expect(target.saveBlocked).toBe(true);
  });

  it("選んだ店舗の稼働中の枠が 0 なら保存を止める", () => {
    const target = resolveCreateTarget(settingsWith([store("s1", "本店"), store("s3", "三号店")]), "s3", "");
    expect(target.resources.kind).toBe("none");
    expect(target.saveBlocked).toBe(true);
  });

  it("店舗を変えると、前の店舗の枠は送らない", () => {
    expect(resolveCreateTarget(TWO_STORES, "s2", "s1-a").resources.resourceId).toBe("");
    expect(resolveCreateTarget(TWO_STORES, "s1", "s2-b").resources.resourceId).toBe("s1-a");
  });
});
