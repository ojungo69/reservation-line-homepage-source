// 紐付けの操作に使う店舗。お客様は店舗に属さないため、画面で選んでいる店舗（無ければ先頭）を存在確認のために送る。
export function pickLinkStoreId(stores: ReadonlyArray<{ id: string }>, selectedStoreId: string | null | undefined): string {
  return stores.find((store) => store.id === selectedStoreId)?.id ?? stores[0]?.id ?? "";
}
