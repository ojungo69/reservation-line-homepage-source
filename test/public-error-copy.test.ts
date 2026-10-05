import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

// Contract: the customer-facing failure copy that exists on BOTH public screens
// (booking form public/app.js and reservation list public/customer/reservations.js)
// must be word-for-word identical, so the same failure never reads differently
// depending on which screen surfaced it. The two files are plain scripts with no
// shared runtime, so the contract is pinned here instead: for each reason below,
// the copy is extracted from the ACTUAL map entry in each file (not a file-wide
// substring search) and compared against the single expected wording.
// idempotency_conflict / write_failed は書き込み経路専用の copy で、キャンセル申請
// 廃止 (2026-08-01) 後の閲覧専用 reservations.js には存在しない — app.js のみ。
const SHARED_COPY: Record<string, string> = {
  missing_liff_id:
    "ページを開けませんでした。お手数ですが、LINEのトーク画面から開き直してください。解決しない場合は店舗までお問い合わせください",
  line_id_token_failed: "本人確認の有効期限が切れました。LINEでこのページを開き直してください",
  line_user_mismatch: "LINEログイン情報が一致しません。LINEでこのページを開き直してください",
  line_friendship_failed: "公式アカウントの友だち情報を確認できませんでした。時間をおいてもう一度お試しください",
  line_not_friend: "公式アカウントの友だち追加が必要です",
  rate_limited: "アクセスが集中しています。少し待ってから、もう一度お試しください",
  customer_lookup_failed: "顧客情報を取得できません。時間をおいてもう一度お試しください",
  invalid_request:
    "お手続きを受け付けできませんでした。入力内容をご確認のうえ、もう一度お試しください。解決しない場合は、お手数ですが店舗まで直接お問い合わせください"
};

const appJs = readFileSync("public/app.js", "utf8");
const reservationsJs = readFileSync("public/customer/reservations.js", "utf8");

// Pull the copy assigned to `key` inside the map literal that follows `mapMarker`.
// Anchoring at the marker (instead of searching the whole file) ensures we read the
// entry actually used for that reason, not an identical string somewhere else.
const extractMapCopy = (source: string, mapMarker: string, key: string): string => {
  const start = source.indexOf(mapMarker);
  expect(start, `map marker not found: ${mapMarker}`).toBeGreaterThan(-1);
  const scope = source.slice(start, start + 6000);
  const match = new RegExp(`${key}:\\s*"([^"]+)"`).exec(scope);
  expect(match, `${key} not found in map after ${mapMarker}`).toBeTruthy();
  return (match as RegExpExecArray)[1];
};

// app.js throws missing_liff_id via createLineError(reason, copy) instead of a map.
const extractCreateLineErrorCopy = (source: string, reason: string): string => {
  const match = new RegExp(`createLineError\\(\\s*"${reason}",\\s*"([^"]+)"`).exec(source);
  expect(match, `createLineError("${reason}", …) not found`).toBeTruthy();
  return (match as RegExpExecArray)[1];
};

const appCopyFor = (reason: string): string => {
  if (reason === "missing_liff_id") {
    return extractCreateLineErrorCopy(appJs, reason);
  }
  // 予約送信フローの reasonMessage 側に属する reason。それ以外は本人確認ゲートの
  // lineGateReasonMessage 側から抽出する。
  if (["idempotency_conflict", "invalid_request", "write_failed"].includes(reason)) {
    return extractMapCopy(appJs, "const reasonMessage", reason);
  }
  return extractMapCopy(appJs, "const lineGateReasonMessage", reason);
};

describe("public error copy contract (app.js ⇔ customer/reservations.js)", () => {
  for (const [reason, copy] of Object.entries(SHARED_COPY)) {
    it(`${reason}: both screens assign the identical wording to this reason`, () => {
      expect(appCopyFor(reason)).toBe(copy);
      expect(extractMapCopy(reservationsJs, "const FAILURE_LABEL", reason)).toBe(copy);
    });
  }

  it("developer jargon never reaches customers (both files)", () => {
    // Phrases that previously leaked internal terms into customer-visible copy.
    // (Bare identifiers like "openid"/"liff" legitimately appear in code, so the
    // ban targets the exact Japanese copy phrasings instead. 認可/認証情報 are
    // fully absent from both files — code and copy — so those ban file-wide.)
    const banned = [
      "送信キー",
      "LIFF設定",
      "LIFF IDが設定",
      "LIFF URLから開いて",
      "openidを有効",
      "profileを有効",
      "認可",
      "認証情報",
      "サーバーで失敗"
    ];
    for (const phrase of banned) {
      expect(appJs, `app.js contains banned phrase: ${phrase}`).not.toContain(phrase);
      expect(reservationsJs, `reservations.js contains banned phrase: ${phrase}`).not.toContain(phrase);
    }
  });
});

describe("lineTokenFailureMessage branch copy (app.js)", () => {
  // The function is a browser-script local (not importable), so the contract is
  // pinned structurally: each condition is matched together with the copy it
  // returns, which fails if a branch's wording changes or a branch is reordered
  // away from its copy.
  const fnMatch = /const lineTokenFailureMessage = \(\{[\s\S]*?\n\};/.exec(appJs);
  const fnSrc = fnMatch ? fnMatch[0] : "";

  it("function block found", () => {
    expect(fnSrc.length).toBeGreaterThan(0);
  });

  it("each branch returns customer-actionable copy", () => {
    expect(fnSrc).toMatch(
      /if \(!inClient\) \{\s*return "LINEアプリからこのページを開き直してください";/
    );
    expect(fnSrc).toMatch(
      /profileState === "unavailable"\)\) \{[\s\S]{0,200}?return "ページを開けませんでした。お手数ですが、LINEのトーク画面から開き直してください。解決しない場合は店舗までお問い合わせください";/
    );
    expect(fnSrc).toMatch(
      /openidState === "prompt" \|\| profileState === "prompt"\) \{\s*return "LINEの許可が完了していません。画面が開き直ったら、許可を選択してください";/
    );
    expect(fnSrc).toMatch(
      /return "本人確認を完了できませんでした。LINEアプリを完全に閉じて、もう一度開き直してください";\s*\n\};/
    );
  });

  it("no internal terms in any string literal of the function", () => {
    const literals = [...fnSrc.matchAll(/"([^"\n]*)"/g)].map((m) => m[1]);
    expect(literals.length).toBeGreaterThan(0);
    for (const literal of literals) {
      for (const term of ["LIFF", "認可", "認証情報"]) {
        expect(literal, `literal "${literal}" contains ${term}`).not.toContain(term);
      }
    }
  });
});
