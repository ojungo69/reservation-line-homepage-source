import { adminWriteGuard, adminWriteWasRevoked, assertAdminWriteCurrent } from "./write-authorization";
import { enforceRateLimit } from "../auth/reservation-gate";
import type { WorkerBindings } from "../bindings";
import { sha256Hex } from "../crypto-utils";
import { sendOperationsNotificationEmail } from "../notifications/operations-email";
import { safeCaptureException } from "../sentry-helpers";
import type { AdminUser } from "./access";

const CODE_TTL_MS = 10 * 60 * 1000;
const GRANT_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_ATTEMPTS = 5;

// Two ceilings, both claimed BEFORE the email is sent so a send that fails cannot
// be used to flood the owner's inbox. The 60s cooldown is FR-006; the hourly cap is
// what actually bounds the inbox, since a cooldown alone still allows 60 mails/hour.
const REQUEST_COOLDOWN_LIMIT = 1;
const REQUEST_COOLDOWN_WINDOW_MS = 60 * 1000;
const REQUEST_HOURLY_LIMIT = 10;
const REQUEST_HOURLY_WINDOW_MS = 60 * 60 * 1000;
const VERIFY_LIMIT = 10;
const VERIFY_WINDOW_MS = 15 * 60 * 1000;

export type CustomerGateEnv = Partial<WorkerBindings>;

export type CustomerGateRequestResult =
  | { ok: true; challengeId: string; expiresAt: string }
  | { ok: false; reason: "forbidden" | "rate_limited" | "owner_email_unset" | "gate_email_failed" };

export type CustomerGateVerifyResult =
  | { ok: true; grantedUntil: string }
  | { ok: false; reason: "forbidden" | "rate_limited" | "invalid_code" };

/**
 * Uniform 6-digit code. Rejection sampling, not `% 1_000_000` on a raw draw: 2^32 is
 * not a multiple of 1e6, so the plain modulo would make the first 294,967 codes
 * marginally more likely. Cheap to do right, and the bias is the kind of thing that
 * never shows up in a test.
 */
const generateSixDigitCode = (): string => {
  const limit = Math.floor(2 ** 32 / 1_000_000) * 1_000_000;
  const buffer = new Uint32Array(1);
  let draw = limit;
  while (draw >= limit) {
    crypto.getRandomValues(buffer);
    draw = buffer[0];
  }
  return String(draw % 1_000_000).padStart(6, "0");
};

/**
 * 検証の監査行。action は「直前の UPDATE がこの試行で verified_at を書けたか」で自分で決める。
 * FROM 無しの SELECT は必ず 1 行返すので、行なし・不一致・一致のどの分岐でも監査行はちょうど 1 本。
 * `verifyCustomerGateCode` が承認の確定と同じ batch に入れて使う。
 * コードもそのハッシュも監査には入れない — 監査ログは全オーナーが読めるので、生きたコードが
 * 載るとゲートの意味が無くなる。
 */
// 「今回の試行が当たったか」は、時刻ではなく**提出されたコードのハッシュ**で判定する。
// 同じミリ秒に 2 本の verify が来ると `verified_at` は両方から同じ値に見えるため、時刻で
// 突き合わせると外れたほうの試行まで `customer_gate_verified` として残る。ハッシュ一致な
// ら「提出したコードはこのチャレンジの正解だった」であり、UPDATE を勝ち取ったのがどちら
// かに依らず真になる。
const gateAuditStatement = (
  db: D1Database,
  adminUserId: string,
  challenge: { challengeId: string; codeHash: string }
): D1PreparedStatement =>
  db
    .prepare(
      `
        INSERT INTO audit_logs (id, actor_type, actor_id, action, target_type, target_id, metadata_json)
        SELECT ?1, 'staff', ?2,
               CASE WHEN EXISTS (
                 SELECT 1
                 FROM admin_customer_gate_challenges
                 WHERE id = ?3 AND admin_user_id = ?2 AND code_hash = ?4 AND verified_at IS NOT NULL
               ) THEN 'customer_gate_verified' ELSE 'customer_gate_verify_failed' END,
               'admin_user', ?2, NULL
      `
    )
    .bind(crypto.randomUUID(), adminUserId, challenge.challengeId, challenge.codeHash);

export const hasActiveCustomerGateGrant = async (db: D1Database, adminUserId: string): Promise<boolean> => {
  const row = await db
    .prepare(
      `
        SELECT 1
        FROM admin_customer_gate_challenges
        WHERE admin_user_id = ?
          AND granted_until IS NOT NULL
          AND granted_until > ?
        LIMIT 1
      `
    )
    .bind(adminUserId, new Date().toISOString())
    .first<{ 1: number }>();
  return row !== null;
};

export const requestCustomerGateCode = async (input: {
  db: D1Database;
  env: CustomerGateEnv;
  admin: AdminUser;
}): Promise<CustomerGateRequestResult> => {
  if (input.admin.role !== "staff" || !input.admin.store_id) return { ok: false, reason: "forbidden" };
  const now = Date.now;
  // FR-013 は "" で閉じる。宛先が空だと全スタッフの顧客タブが恒久的に閉じるが、この分岐は
  // 例外を投げずに 500 を返すので app.onError の Sentry capture を通らない。オーナーにも
  // 運用者にも信号が飛ばないまま復旧不能になるため、ここで明示的に上げる。
  const recipient =
    input.env.PENDING_APPROVAL_OWNER_EMAIL?.trim() || input.env.OPERATIONS_NOTIFICATION_EMAIL?.trim() || "";
  // Checked before the rate limit is claimed: a misconfigured address must not burn
  // the staff member's one attempt per minute.
  if (!recipient) {
    safeCaptureException(new Error("customer_gate_owner_email_unset"), {
      tags: { component: "admin-customer-gate", outcome: "owner_email_unset" }
    });
    return { ok: false, reason: "owner_email_unset" };
  }

  const cooldown = await enforceRateLimit(
    input.db,
    "admin_customer_gate_request",
    input.admin.id,
    now,
    REQUEST_COOLDOWN_LIMIT,
    REQUEST_COOLDOWN_WINDOW_MS,
    false
  );
  if (!cooldown.ok) return { ok: false, reason: "rate_limited" };

  const hourly = await enforceRateLimit(
    input.db,
    "admin_customer_gate_request_hourly",
    input.admin.id,
    now,
    REQUEST_HOURLY_LIMIT,
    REQUEST_HOURLY_WINDOW_MS,
    false
  );
  if (!hourly.ok) return { ok: false, reason: "rate_limited" };

  const nowMs = now();
  const nowIso = new Date(nowMs).toISOString();

  const id = crypto.randomUUID();
  const code = generateSixDigitCode();
  const expiresAt = new Date(nowMs + CODE_TTL_MS).toISOString();
  // チャレンジ行と監査行を同じ batch = 同じトランザクションで入れる。監査を送信の後ろに
  // 単独で置くと、送信は成功して監査の INSERT だけ落ちた瞬間に「オーナーには生きたコードが
  // 届いているのに、申請した記録がどこにも無く、スタッフには 500 が出て challengeId も
  // 返らない」状態が残る (verify 側は FR-010 で同じことを避けている)。
  // action が「申請した」で「送信できた」ではないのは、送信の前に確定させるため。送信の
  // 成否で監査行を書き分けようとすると、監査ログから DELETE する (追記専用でなくなる) か、
  // 送っていないのに「送った」と書いた行を残すかのどちらかになる。配送の失敗は
  // sendOperationsNotificationEmail が Sentry に上げる。
  try {
    await input.db.batch([
      adminWriteGuard(input.db, input.admin),
    input.db
      .prepare(
        `
        INSERT INTO admin_customer_gate_challenges (id, admin_user_id, code_hash, expires_at)
        VALUES (?, ?, ?, ?)
      `
      )
      .bind(id, input.admin.id, await sha256Hex(`${id}:${code}`), expiresAt),
    // コードもそのハッシュも監査には入れない — 監査ログは全オーナーが読めるので、
    // 生きたコードが載るとゲートの意味が無くなる。
    input.db
      .prepare(
        `
        INSERT INTO audit_logs (id, actor_type, actor_id, action, target_type, target_id, metadata_json)
        VALUES (?, 'staff', ?, 'customer_gate_code_requested', 'admin_user', ?, NULL)
      `
      )
      .bind(crypto.randomUUID(), input.admin.id, input.admin.id)
  ]);
  } catch (error) {
    if (await adminWriteWasRevoked(input.db, input.admin, error)) return { ok: false, reason: "forbidden" };
    throw error;
  }

  try {
    await assertAdminWriteCurrent(input.db, input.admin);
  } catch (error) {
    // Issuance already committed, but no send has started. Remove this challenge
    // even when the actor was revoked; retain the truthful request audit.
    await input.db.prepare("DELETE FROM admin_customer_gate_challenges WHERE id = ? AND admin_user_id = ?")
      .bind(id, input.admin.id).run();
    if (await adminWriteWasRevoked(input.db, input.admin, error)) return { ok: false, reason: "forbidden" };
    throw error;
  }
  const email = await sendOperationsNotificationEmail(input.env, {
    to: recipient,
    subject: "顧客情報の閲覧許可コード",
    text: [
      `${input.admin.email} さんが管理画面の顧客タブを開こうとしています。`,
      "",
      `確認コード: ${code}`,
      "",
      "このコードは10分間有効です。ご本人からの依頼であることを確認のうえ、お伝えください。",
      "お心当たりがない場合は、コードをお伝えにならないでください。"
    ].join("\n")
  });

  // A timeout means the send MAY still be delivered, so the row stays and the code
  // remains usable; only an outright failure removes it. Either way we never re-send.
  if (!email.sent && !email.timedOut) {
    await input.db.prepare(`DELETE FROM admin_customer_gate_challenges WHERE id = ?`).bind(id).run();
    return { ok: false, reason: "gate_email_failed" };
  }

  // 古い行の掃除はここ — 送信の前ではない。前に置くと、再送の送信が失敗した回に「まだ有効
  // だった前のコード」と「今回のコード」の両方が消える。画面は再送が失敗しても前の
  // challengeId を保持する作りなので、オーナーの手元にあるコードを入力しても該当行が無く
  // 「正しくないか期限切れ」になる。送信が終わってから、今回の行だけ残して落とす。
  // 生きている承認は行として残す (granted_until を持つ行は消さない)。cron は足さない。
  // 送信という取り消せない副作用の後ろにある文なので、落ちても要求は成功で返し切る。
  // ここで 500 にすると、オーナーには生きたコードが届いているのに画面は challengeId を
  // 受け取れず入力欄が出ず、クールダウンだけ消費された状態になる。消し損ねた行は
  // expires_at (10 分) で死ぬので、後始末の失敗は放置してよい。
  try {
    await input.db
      .prepare(
        `
        DELETE FROM admin_customer_gate_challenges
        WHERE admin_user_id = ?
          AND id <> ?
          AND (granted_until IS NULL OR granted_until <= ?)
      `
      )
      .bind(input.admin.id, id, nowIso)
      .run();
  } catch (error) {
    safeCaptureException(error, {
      tags: { component: "admin-customer-gate", outcome: "stale_challenge_cleanup_failed" }
    });
  }

  return { ok: true, challengeId: id, expiresAt };
};

export const verifyCustomerGateCode = async (input: {
  db: D1Database;
  admin: AdminUser;
  challengeId: string;
  code: string;
}): Promise<CustomerGateVerifyResult> => {
  if (input.admin.role !== "staff" || !input.admin.store_id) return { ok: false, reason: "forbidden" };
  const now = Date.now;
  const limit = await enforceRateLimit(
    input.db,
    "admin_customer_gate_verify",
    input.admin.id,
    now,
    VERIFY_LIMIT,
    VERIFY_WINDOW_MS,
    false
  );
  if (!limit.ok) return { ok: false, reason: "rate_limited" };

  const nowMs = now();
  const nowIso = new Date(nowMs).toISOString();
  const grantedUntil = new Date(nowMs + GRANT_TTL_MS).toISOString();
  const codeHash = await sha256Hex(`${input.challengeId}:${input.code}`);

  // One statement: consuming the attempt, comparing the hash and granting all happen
  // together, so two concurrent requests cannot both spend the same attempt budget.
  // A returned row means the attempt was spent on a live challenge; verified_at tells
  // whether the code matched. No row means expired, exhausted, already used, or not ours.
  // 承認の確定と監査行の書き込みは同じ batch = 同じトランザクションに入れる。別々の文に
  // すると、承認だけコミットされて監査行の INSERT が失敗した瞬間に「誰も申請していない
  // のに顧客タブが開く」状態が残る (FR-010)。
  try {
    await input.db.batch([
      adminWriteGuard(input.db, input.admin),
    input.db
      .prepare(
        `
        UPDATE admin_customer_gate_challenges
        SET attempts = attempts + 1,
            verified_at = CASE WHEN code_hash = ?1 THEN ?2 ELSE verified_at END,
            granted_until = CASE WHEN code_hash = ?1 THEN ?3 ELSE granted_until END
        WHERE id = ?4
          AND admin_user_id = ?5
          AND verified_at IS NULL
          AND attempts < ?6
          AND expires_at > ?2
      `
      )
      .bind(codeHash, nowIso, grantedUntil, input.challengeId, input.admin.id, MAX_ATTEMPTS),
    gateAuditStatement(input.db, input.admin.id, { challengeId: input.challengeId, codeHash })
  ]);
  } catch (error) {
    if (await adminWriteWasRevoked(input.db, input.admin, error)) return { ok: false, reason: "forbidden" };
    throw error;
  }

  // 結果は batch の後に読み直す。RETURNING を batch の中で使うと戻り値の形が D1 の実装
  // 依存になるため、素の SELECT で確かめる。突き合わせに code_hash を使う理由は
  // gateAuditStatement の直前のコメントと同じ。
  const granted = await input.db
    .prepare(
      `
        SELECT granted_until
        FROM admin_customer_gate_challenges
        WHERE id = ?1 AND admin_user_id = ?2 AND code_hash = ?3
          AND verified_at IS NOT NULL
          AND granted_until > ?4
      `
    )
    .bind(input.challengeId, input.admin.id, codeHash, nowIso)
    .first<{ granted_until: string | null }>();

  if (granted?.granted_until) return { ok: true, grantedUntil: granted.granted_until };
  return { ok: false, reason: "invalid_code" };
};
