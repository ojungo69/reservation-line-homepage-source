const STATUS_LABEL: Record<string, string> = {
  pending_approval: "承認待ち",
  confirmed: "確定",
  rejected: "却下",
  expired: "期限切れ",
  cancelled_by_customer: "顧客キャンセル",
  cancelled_by_admin: "管理キャンセル",
  completed: "来店完了",
  no_show: "来店なし",
  checked_in: "来店中"
};

const LINE_FRIEND_LABEL: Record<string, string> = {
  friend: "友だち",
  not_friend: "未友だち",
  blocked: "ブロック中",
  unknown: "不明"
};

const stringifyHtmlValue = (value: unknown) => {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "object") {
    try {
      return JSON.stringify(value) ?? "";
    } catch {
      return "";
    }
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return `${value}`;
  }
  return "";
};

export const escapeHtml = (value: unknown): string => {
  // Complete manual HTML-entity escaping (covers & < > " ') is the correct approach
  // for SSR string interpolation in a Cloudflare Worker — there is no DOM/template
  // engine to delegate to, and this is the single canonical escaper for admin HTML.
  // nosemgrep: javascript.audit.detect-replaceall-sanitization.detect-replaceall-sanitization
  return stringifyHtmlValue(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
};

export const labelForStatus = (status: string): string => STATUS_LABEL[status] ?? status;

export const labelForLineFriend = (value: string | null | undefined): string => {
  if (value === null || value === undefined) {
    return LINE_FRIEND_LABEL.unknown;
  }
  return LINE_FRIEND_LABEL[value] ?? value;
};
