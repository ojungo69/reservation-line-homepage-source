import { describe, expect, it } from "vitest";
import { putBusinessHours } from "../src/admin/settings-business-hours";
import { listPublicAvailability } from "../src/reservations/public-options";
import { createPublicReservation } from "../src/reservations/public-submit";
import { createMigratedSqliteD1 } from "./helpers/sqlite-d1";

const now = () => Date.parse("2026-05-09T23:00:00.000Z");
const selection = {
  storeId: "kyoto", resourceId: "resource_kyoto_calendar", serviceId: "service_kyoto_default_60"
};

const prepareStore = async (opensAt: string, closesAt: string) => {
  const db = createMigratedSqliteD1();
  db.sqlite.prepare("INSERT INTO admin_users(id,email,access_subject,role) VALUES('hours_owner','hours@example.invalid','hours_subject','owner')").run();
  const result = await putBusinessHours({
    db: db as unknown as D1Database, storeId: selection.storeId,
    actor: { id: "hours_owner", email: "hours@example.invalid", role: "owner", staff_member_id: null, store_id: null },
    hours: Array.from({ length: 7 }, (_, weekday) => ({ weekday, opensAt, closesAt, closed: false }))
  });
  expect(result).toEqual({ ok: true });
  return db;
};

describe("public availability opening grid", () => {
  it.each([
    { opensAt: "09:00", closesAt: "10:05", starts: ["2026-06-01T00:00:00.000Z"] },
    { opensAt: "09:10", closesAt: "10:19", starts: [] },
    { opensAt: "09:10", closesAt: "10:20", starts: ["2026-06-01T00:15:00.000Z"] }
  ])("keeps the occupied window inside $opensAt–$closesAt", async ({ opensAt, closesAt, starts }) => {
    const db = await prepareStore(opensAt, closesAt);
    try {
      const availability = await listPublicAvailability({
        db: db as unknown as D1Database, ...selection, date: "2026-06-01", now
      });
      if (!availability.ok) throw new Error(availability.reason);
      expect(availability.slots.map(slot => slot.startAt)).toEqual(starts);
    } finally {
      db.sqlite.close();
    }
  });

  it("offers only bookable starts when the store opens between public grid boundaries", async () => {
    const db = await prepareStore("09:10", "11:00");
    try {
      const availability = await listPublicAvailability({
        db: db as unknown as D1Database, ...selection, date: "2026-06-01", now
      });
      if (!availability.ok) throw new Error(availability.reason);
      expect(availability.slots.map(slot => slot.startAt)).toEqual([
        "2026-06-01T00:15:00.000Z", "2026-06-01T00:30:00.000Z", "2026-06-01T00:45:00.000Z"
      ]);
      for (const slot of availability.slots) {
        const bookingDb = await prepareStore("09:10", "11:00");
        try {
          const result = await createPublicReservation({
            db: bookingDb as unknown as D1Database, now,
            line: { channelId: "hours_channel", lineUserId: "hours_user" },
            request: {
              ...selection, idempotencyKey: "hours_booking", startAt: slot.startAt,
              customer: { displayName: "営業時間確認", phone: "09012345678" },
              consents: {
                noticeVersion: "notice-terms-2026-06", cancellationPolicyVersion: "cancel-2026-08-31",
                privacyPolicyVersion: "privacy-2026-06"
              }
            }
          });
          expect(result).toMatchObject({ ok: true, startAt: slot.startAt, endAt: slot.endAt });
        } finally {
          bookingDb.sqlite.close();
        }
      }
    } finally {
      db.sqlite.close();
    }
  });
});
