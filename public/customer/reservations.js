// LIFF client bundle for /customer/reservations (view-only).
//
// Flow: liff.init -> fetch /api/public/my-reservations (header tokens) ->
// render list. The change-request feature (cancel/reschedule requests) was
// retired on 2026-08-01 — changes and cancellations go through the store's
// official LINE talk (the customer-facing guidance stopped naming phone on
// 2026-08-31), so this page only displays upcoming reservations.

const LIFF_SCRIPT_GLOBAL = "liff";
const STATUS_LABEL = {
  pending_approval: "承認待ち",
  confirmed: "確定"
};

const FAILURE_LABEL = {
  origin_blocked: "アクセス元を確認できません",
  rate_limited: "アクセスが集中しています。少し待ってから、もう一度お試しください",
  // 本人確認まわりの文言は public/app.js の lineGateReasonMessage と揃える
  // （2画面で同じ失敗が別の言い回しにならないように。変更時は両方を更新）。
  line_id_token_failed: "本人確認の有効期限が切れました。LINEでこのページを開き直してください",
  line_user_mismatch: "LINEログイン情報が一致しません。LINEでこのページを開き直してください",
  line_friendship_failed: "公式アカウントの友だち情報を確認できませんでした。時間をおいてもう一度お試しください",
  line_not_friend: "公式アカウントの友だち追加が必要です",
  customer_blocked: "ご利用を停止されています",
  customer_lookup_failed: "顧客情報を取得できません。時間をおいてもう一度お試しください",
  line_identity_not_found: "予約済みの本人確認が必要です",
  missing_tokens: "LINEでこのページを開き直してください",
  missing_database: "システムエラーが発生しました。時間をおいてもう一度お試しください",
  // ブロック済み顧客の偽装 (invalid_request へのカムフラージュ) は予約フォーム側と共通
  // なので、入力修正で必ず解決するとは約束しない文言にする (app.js と同文)。
  invalid_request:
    "お手続きを受け付けできませんでした。入力内容をご確認のうえ、もう一度お試しください。解決しない場合は、お手数ですが店舗まで直接お問い合わせください",
  missing_liff_id: "ページを開けませんでした。お手数ですが、LINEのトーク画面から開き直してください。解決しない場合は店舗までお問い合わせください",
  liff_sdk_unavailable: "LINEミニアプリの読み込みに失敗しました。アプリを再起動してください"
};

// Named statusBanner (not `status`) so it never shadows the deprecated global
// `window.status`, which static analysis flags as a deprecated-API use.
const statusBanner = document.getElementById("status-banner");
const list = document.getElementById("reservations");

const setStatus = (text, tone) => {
  if (!statusBanner) return;
  statusBanner.textContent = text ?? "";
  if (tone) {
    statusBanner.dataset.tone = tone;
  } else {
    delete statusBanner.dataset.tone;
  }
};

const showError = (reason) => {
  const label = FAILURE_LABEL[reason] ?? "通信に失敗しました";
  setStatus(label, "error");
};

const waitForLiff = () =>
  new Promise((resolve, reject) => {
    if (globalThis[LIFF_SCRIPT_GLOBAL]) {
      resolve(globalThis[LIFF_SCRIPT_GLOBAL]);
      return;
    }
    let attempts = 0;
    const id = setInterval(() => {
      attempts += 1;
      if (globalThis[LIFF_SCRIPT_GLOBAL]) {
        clearInterval(id);
        resolve(globalThis[LIFF_SCRIPT_GLOBAL]);
      } else if (attempts > 100) {
        clearInterval(id);
        reject(new Error("liff_sdk_unavailable"));
      }
    }, 100);
  });

const initLiff = async () => {
  const meta = document.querySelector('meta[name="line-liff-id"]');
  const liffId = meta?.getAttribute("content");
  if (!liffId) {
    throw new Error("missing_liff_id");
  }
  const liff = await waitForLiff();
  await liff.init({ liffId });
  if (!liff.isLoggedIn()) {
    liff.login({ redirectUri: globalThis.location.href });
    return null;
  }
  const idToken = liff.getIDToken();
  const accessToken = liff.getAccessToken();
  const decoded = liff.getDecodedIDToken?.();
  const nonce = typeof decoded?.nonce === "string" ? decoded.nonce : undefined;
  if (!idToken || !accessToken) {
    throw new Error("missing_tokens");
  }
  return { idToken, accessToken, nonce };
};

const fetchMyReservations = async (tokens) => {
  const headers = new Headers();
  headers.set("X-LINE-IdToken", tokens.idToken);
  headers.set("X-LINE-AccessToken", tokens.accessToken);
  if (tokens.nonce) headers.set("X-LINE-Nonce", tokens.nonce);
  const response = await fetch("/api/public/my-reservations", { method: "GET", headers });
  let body = null;
  try {
    body = await response.json();
  } catch {
    /* ignore */
  }
  return { status: response.status, body };
};

const formatJst = (iso) => {
  if (typeof iso !== "string") return "";
  try {
    return new Intl.DateTimeFormat("ja-JP", {
      timeZone: "Asia/Tokyo",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit"
    }).format(new Date(iso));
  } catch {
    return iso;
  }
};

const renderReservations = (reservations) => {
  if (!list) return;
  list.removeAttribute("aria-busy");
  list.replaceChildren();
  if (!Array.isArray(reservations) || reservations.length === 0) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = "現在ご利用可能な予約はありません。";
    list.append(empty);
    return;
  }
  const guidance = document.createElement("p");
  guidance.className = "muted change-guidance";
  guidance.textContent =
    "ご予約の変更・キャンセルをご希望の場合は、お手数ですが当店公式LINEのトークからご連絡くださいませ。";
  list.append(guidance);
  for (const reservation of reservations) {
    list.append(renderReservation(reservation));
  }
};

// メニュー名スナップショットの表示用変換。public/app.js の displayServiceSnapshot
// と同一契約: カテゴリ prefix を除去、「メンズ｜」のみ保持、末尾時間は不変、
// " / " 連結は分割して各要素に適用。
const displayServiceSnapshot = (name) =>
  String(name ?? "")
    .split(" / ")
    .map((segment) => {
      if (segment.startsWith("メンズ｜")) return segment;
      const separator = segment.indexOf("｜");
      return separator === -1 ? segment : segment.slice(separator + 1);
    })
    .join(" / ");

const renderReservation = (reservation) => {
  const panel = document.createElement("article");
  panel.className = "panel surface";
  panel.dataset.reservationId = String(reservation.id ?? "");

  const title = document.createElement("h2");
  title.textContent = `${reservation.storeName ?? ""} / ${displayServiceSnapshot(reservation.serviceName ?? "")}`;
  panel.append(title);

  const startEl = document.createElement("p");
  startEl.className = "meta";
  startEl.textContent = `開始: ${formatJst(reservation.startAt)} 〜 ${formatJst(reservation.endAt)}`;
  panel.append(startEl);

  const statusEl = document.createElement("p");
  statusEl.className = "meta";
  const badge = document.createElement("span");
  badge.className = "badge";
  if (reservation.status === "pending_approval") badge.classList.add("pending");
  badge.textContent = STATUS_LABEL[reservation.status] ?? reservation.status ?? "";
  statusEl.append(badge);
  panel.append(statusEl);

  return panel;
};

const bootstrap = async (tokensInput) => {
  setStatus("読み込み中…");
  try {
    const tokens = tokensInput ?? (await initLiff());
    if (!tokens) return;
    const { status: code, body } = await fetchMyReservations(tokens);
    if (code !== 200 || !body?.ok) {
      showError(body?.reason ?? "invalid_request");
      return;
    }
    setStatus("", null);
    renderReservations(body.reservations);
  } catch (error) {
    const reason = error instanceof Error ? error.message : "invalid_request";
    showError(reason);
  }
};

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => void bootstrap());
} else {
  void bootstrap();
}
