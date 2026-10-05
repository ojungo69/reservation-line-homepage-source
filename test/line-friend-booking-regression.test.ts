import { describe, expect, it } from "vitest";
import { createMigratedSqliteD1 } from "./helpers/sqlite-d1";
import { linkLineFriend } from "../src/admin/line-friends";
import { OWNER_EMAIL_RECIPIENT_ID } from "../src/notifications/operations-email";
import { createPublicReservation, type PublicReservationRequest } from "../src/reservations/public-submit";

const U = (c: string) => "U" + c.repeat(32);
const CHANNEL = "login-channel-1";
const owner = { id: "admin_1", email: "owner@example.test", role: "owner" as const, staff_member_id: null, store_id: null };

describe("regression: linked paper customer recognized on next LINE booking", () => {
  it("reuses linked customer and enqueues the existing-customer approval notification", async () => {
    const d1 = createMigratedSqliteD1();
    d1.sqlite.exec("INSERT INTO admin_users(id,email,access_subject,role) VALUES ('admin_1','owner@example.test','owner-sub','owner')");
    const db = d1 as unknown as D1Database;
    try {
      // kyoto store の承認モードを existing_customer_auto に固定（行が無くても UPSERT）。
      d1.sqlite
        .prepare(
          `INSERT INTO store_settings (store_id, reservation_approval_mode)
           VALUES ('kyoto', 'existing_customer_auto')
           ON CONFLICT(store_id) DO UPDATE SET reservation_approval_mode = 'existing_customer_auto'`
        )
        .run();

      // 名簿に1人（link は directory 在籍を要求）。
      d1.sqlite
        .prepare(
          `INSERT INTO line_friend_directory (channel_id, line_user_id, display_name, profile_status, first_seen_at)
           VALUES (?, ?, '田中花子', 'fetched', '2026-05-09T00:00:00.000Z')`
        )
        .run(CHANNEL, U("a"));

      // 紐付け（new 顧客 + line_identities.linked_by_admin=1。偽の来店記録は作らない）。
      const link = await linkLineFriend({
        db,
        admin: owner,
        channelId: CHANNEL,
        lineUserId: U("a"),
        request: { mode: "new", storeId: "kyoto", newCustomer: { displayName: "田中花子" } },
        now: () => Date.parse("2026-05-09T00:00:00.000Z")
      });
      expect(link.ok).toBe(true);
      if (!link.ok) return;

      // 紐付けでは来店履歴を seed しない（登録日付の偽 visit を作らない）。
      expect(
        (d1.sqlite.prepare("SELECT COUNT(*) AS n FROM customer_visits WHERE customer_id = ?").get(link.customerId) as {
          n: number;
        }).n
      ).toBe(0);

      // 次回 LINE 予約（同じ channelId + lineUserId）。startAt/now は成立保証の既知値。
      const request: PublicReservationRequest = {
        idempotencyKey: "regression_1",
        storeId: "kyoto",
        serviceId: "service_kyoto_default_60",
        resourceId: "resource_kyoto_calendar",
        startAt: "2026-05-10T01:00:00.000Z",
        customer: { displayName: "別名でもよい", displayNameKana: "ベツメイ", phone: "075-123-4567" },
        consents: {
          noticeVersion: "notice-terms-2026-06",
          cancellationPolicyVersion: "cancel-2026-08-31",
          privacyPolicyVersion: "privacy-2026-06"
        }
      };
      const res = await createPublicReservation({
        db,
        request,
        line: { lineUserId: U("a"), channelId: CHANNEL },
        env: { LINE_OPERATIONS_USER_IDS: U("b") },
        now: () => Date.parse("2026-05-09T23:00:00.000Z")
      });
      expect(res.ok).toBe(true);
      if (!res.ok) return;

      const row = d1.sqlite
        .prepare("SELECT customer_id, status FROM reservations WHERE id = ?")
        .get(res.reservationId) as { customer_id: string; status: string };
      expect(row.customer_id).toBe(link.customerId); // 既存顧客を再利用（新規作成しない）
      // 全予約承認制: linked_by_admin=1 でも自動確定はしない (常に承認待ち)。
      // 紐付けの効果は「新規客扱いしない」= owner 通知は既存客用templateを使うこと。
      expect(row.status).toBe("pending_approval");
      const notification = d1.sqlite
        .prepare(
          `SELECT template_key, recipient_type, recipient_id
           FROM notification_jobs
           WHERE reservation_id = ?`
        )
        .get(res.reservationId) as {
          template_key: string;
          recipient_type: string;
          recipient_id: string;
        };
      expect(notification).toEqual({
        template_key: "pending_approval_created",
        recipient_type: "owner",
        // Email delivery, so the job is queued once per reservation rather than
        // once per reservation as an owner email job.
        recipient_id: OWNER_EMAIL_RECIPIENT_ID
      });
    } finally {
      d1.sqlite.close();
    }
  });
});
