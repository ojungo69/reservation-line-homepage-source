// 店舗の稼働中の予約枠（リソース）から、画面が枠の欄を出すか・どの枠を送るかを決める。
// resources は設定のデータがあるときだけ渡す（取り直しに失敗しても前のデータがあれば渡す）。
// undefined（読み込み中・最初の取得の失敗）を空の配列（本当に 0 件）と分け、「枠が未設定」と取り違えないため。
import type { Resource, SettingsResponse } from "@/types/api";

export type StoreResources =
  | { kind: "unknown"; resourceId: "" }
  | { kind: "none"; resourceId: "" }
  | { kind: "single"; resource: Resource; resourceId: string }
  | { kind: "multiple"; resources: Resource[]; resourceId: string };

export const NO_RESOURCE_CREATE_NOTICE = "この店舗は予約枠が未設定のため、予約を作成できません。";
// ブロックと繰り返しブロックはオーナーだけが使うので、設定の画面を案内してよい。
export const NO_RESOURCE_SETTINGS_NOTICE =
  "この店舗は予約枠が未設定です。店舗設定の「リソース」タブで追加してください。";

export function resolveStoreResources(
  resources: readonly Resource[] | undefined,
  storeId: string | null | undefined,
  selectedId = "",
): StoreResources {
  if (!resources || !storeId) return { kind: "unknown", resourceId: "" };
  const active = resources.filter((r) => r.active && r.storeId === storeId);
  const [only, ...rest] = active;
  if (!only) return { kind: "none", resourceId: "" };
  if (rest.length === 0) return { kind: "single", resource: only, resourceId: only.id };
  const resourceId = active.some((r) => r.id === selectedId) ? selectedId : "";
  return { kind: "multiple", resources: active, resourceId };
}

type CreateTarget = {
  storeId: string;
  storeName: string | null;
  soleStore: boolean;
  resources: StoreResources;
  saveBlocked: boolean;
};

// 手動予約の作成で使う有効な店舗と枠。利用者が選んだ値（state）は書き換えず、描画のたびに導く。
// 店舗スタッフに返る設定は自分の店舗だけなので、店舗が 1 件なら役割を見ずにその店舗に決まる。
// 店舗が未決定のときは保存を止めない（今どおり、保存のときの必須の検査で知らせる）。
export function resolveCreateTarget(
  settings: SettingsResponse["settings"] | null,
  chosenStoreId: string,
  chosenResourceId: string,
): CreateTarget {
  const stores = settings?.stores ?? [];
  const soleStore = stores.length === 1 ? stores[0] : undefined;
  const storeId = soleStore ? soleStore.id : chosenStoreId;
  const resources = resolveStoreResources(settings?.resources, storeId, chosenResourceId);
  return {
    storeId,
    storeName: stores.find((s) => s.id === storeId)?.name ?? null,
    soleStore: soleStore !== undefined,
    resources,
    saveBlocked: settings === null || resources.kind === "none",
  };
}
