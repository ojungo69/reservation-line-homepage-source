// 設定カード（予約受付期間 / お知らせ / 予約上限）で同一だった「保存に成功した
// 店舗の下書きだけ捨てる」更新関数。setDrafts の updater をモジュール直下に出す
// ことで onClick → then → updater の入れ子が1段浅くなる（Sonar S2004）。
export function dropStoreDraft(storeId: string) {
  return (drafts: Record<string, string>) => {
    const next = { ...drafts };
    delete next[storeId];
    return next;
  };
}
