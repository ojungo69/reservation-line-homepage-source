// 管理画面の手動予約: 複数メニュー選択の純ロジック。
// 上限値は worker 側 src/reservations/slot-times.ts の
// MAX_SERVICE_SELECTIONS / MAX_ADMIN_TOTAL_SERVICE_DURATION_MINUTES と
// keep-in-sync（admin-app は worker src を import しない構成のため複製）。
export const MAX_SERVICE_SELECTIONS = 12;
// 235 = 48スロット×5分（reschedule 側の 4h 占有上限）− 清掃バッファ5分。
export const MAX_ADMIN_TOTAL_SERVICE_DURATION_MINUTES = 235;

// worker src/reservations/slot-times.ts の applyPhotoComboDuration と keep-in-sync。
// admin-app は worker src を import しない構成のため複製する（MAX_* 定数と同様）。
// 全身脱毛系メニューと同時予約されたフォト光は同一セッション内で行うため占有時間に
// 加算しない（=全身脱毛系の55分のまま）。フォト光の料金コンボ・「全身脱毛（フォト付き）」
// 55分バンドルと挙動を揃える。メニュー identity は ID 接尾辞で固定（ID は不変、
// 名称/料金/施術時間は管理画面で可変）。先頭アンダースコアで別メニューへの部分一致を防ぐ
// （例: service_<store>_hair_removal_kids_full_60 は _hair_removal_full_60 に一致しない）。
const PHOTO_ADDON_ID_SUFFIX = "_facial_photo_30";
const FULL_BODY_ABSORB_ID_SUFFIXES = [
  "_hair_removal_full_60",
  "_hair_removal_growth_45",
  "_hair_removal_upper_focus_45",
  "_hair_removal_lower_focus_45",
];

const isFullBodyAbsorbId = (id: string) =>
  FULL_BODY_ABSORB_ID_SUFFIXES.some((suffix) => id.endsWith(suffix));

export type SelectableService = {
  id: string;
  durationMinutes: number;
};

/**
 * 選択中メニューの施術時間合算（バッファ除く）。一覧に無い ID は 0 扱い。
 * 全身脱毛系メニューを含む場合、同時選択のフォト光は 0 分として扱う。
 */
export function totalServiceDuration(
  selectedIds: string[],
  services: SelectableService[],
): number {
  const byId = new Map(services.map((s) => [s.id, s.durationMinutes]));
  // 吸収判定は services に実在する全身脱毛系メニューだけを見る。無効・削除済み ID が
  // selectedIds に紛れても（duration 0 扱い）フォト光を誤って吸収しないようにする。
  const hasFullBody = selectedIds.some((id) => byId.has(id) && isFullBodyAbsorbId(id));
  return selectedIds.reduce((sum, id) => {
    if (hasFullBody && id.endsWith(PHOTO_ADDON_ID_SUFFIX)) return sum;
    return sum + (byId.get(id) ?? 0);
  }, 0);
}

/**
 * 未選択メニューを追加できるか。件数上限・時間上限のどちらかを超える追加は不可。
 * 選択済みメニューの解除は常に可能（この関数は未選択項目にのみ適用する）。
 */
export function canAddService(
  service: SelectableService,
  selectedIds: string[],
  services: SelectableService[],
): boolean {
  if (selectedIds.includes(service.id)) return true;
  if (selectedIds.length >= MAX_SERVICE_SELECTIONS) return false;
  // 追加後の集合で判定する（フォト光の吸収を反映）。全身脱毛系選択中にフォト光を
  // 足しても合算は増えないため、上限際でも正しく追加を許可できる。
  return (
    totalServiceDuration([...selectedIds, service.id], services) <=
    MAX_ADMIN_TOTAL_SERVICE_DURATION_MINUTES
  );
}

/** 現在の選択が上限超過か（rebook 初期値が上限超過で開くケースを含む）。 */
export function isOverSelectionLimit(
  selectedIds: string[],
  services: SelectableService[],
): boolean {
  return (
    selectedIds.length > MAX_SERVICE_SELECTIONS ||
    totalServiceDuration(selectedIds, services) >
      MAX_ADMIN_TOTAL_SERVICE_DURATION_MINUTES
  );
}

/**
 * rebook 初期値を「現在選択可能な ID」と「利用不能 ID（inactive・削除・別店舗）」に
 * 分離する。利用不能 ID は state に保持せず、警告表示のためだけに返す。
 */
export function splitRebookServiceIds(
  defaultIds: string[],
  services: SelectableService[],
): { available: string[]; unavailable: string[] } {
  const known = new Set(services.map((s) => s.id));
  const available: string[] = [];
  const unavailable: string[] = [];
  for (const id of defaultIds) {
    (known.has(id) ? available : unavailable).push(id);
  }
  return { available, unavailable };
}

/**
 * 送信 payload のメニュー部分。単一選択時は旧 backend 互換のため serviceId を併送し、
 * 複数選択時は serviceIds のみ（旧 backend では 400 = fail-closed）。
 */
export function buildServiceSelectionPayload(selectedIds: string[]): {
  serviceIds: string[];
  serviceId?: string;
} {
  if (selectedIds.length === 1) {
    return { serviceIds: selectedIds, serviceId: selectedIds[0] };
  }
  return { serviceIds: selectedIds };
}

/**
 * メニュー選択変更後の開始時刻。空き枠クリックで選んだ時刻は合算時間が変わると
 * 無効になり得るためリセットし、手入力の時刻は維持する。
 */
export function nextTimeAfterServiceChange(
  currentTime: string,
  timeWasPickedFromSlot: boolean,
): string {
  return timeWasPickedFromSlot ? "" : currentTime;
}
