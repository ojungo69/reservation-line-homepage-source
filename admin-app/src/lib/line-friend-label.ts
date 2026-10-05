// Display-only label for a customer's LINE official-account friend status.
// "blocked" means the customer un-friended/blocked the official account; we
// label it "LINE未友だち" so it is not confused with the manual block_status
// ("ブロック中") badge. Behavior (友だち解除=Web予約不可) is enforced by the
// backend live check, NOT by this label.
const LINE_FRIEND_STATUS_LABELS: Record<string, string> = {
  friend: "友だち",
  not_friend: "未友だち",
  blocked: "LINE未友だち",
  unknown: "不明",
};

export function lineFriendStatusLabel(
  status: string | null | undefined,
): string {
  if (!status) return "不明";
  return LINE_FRIEND_STATUS_LABELS[status] ?? status;
}
