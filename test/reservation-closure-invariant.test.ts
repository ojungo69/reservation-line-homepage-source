import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createMigratedSqliteD1, type SqliteD1Database } from "./helpers/sqlite-d1";

const STORE_ID = "kyoto";
const RESOURCE_ID = "resource_kyoto_calendar";
const SERVICE_ID = "service_kyoto_default_60";

describe("reservation and store closure database invariant", () => {
  let db: SqliteD1Database;

  beforeEach(() => {
    db = createMigratedSqliteD1();
    db.sqlite
      .prepare("INSERT INTO customers (id, display_name) VALUES ('customer_write_guard', '競合テスト顧客')")
      .run();
  });

  afterEach(() => {
    db.sqlite.close();
  });

  const insertReservation = (input: {
    id: string;
    startAt: string;
    endAt: string;
    status?: "pending_approval" | "confirmed" | "cancelled_by_admin";
  }) =>
    db.sqlite
      .prepare(
        `INSERT INTO reservations (
           id, store_id, service_id, customer_id, resource_id, source, status,
           start_at, end_at, duration_minutes, idempotency_key
         ) VALUES (?, ?, ?, 'customer_write_guard', ?, 'admin', ?, ?, ?, 60, ?)`
      )
      .run(
        input.id,
        STORE_ID,
        SERVICE_ID,
        RESOURCE_ID,
        input.status ?? "confirmed",
        input.startAt,
        input.endAt,
        `key_${input.id}`
      );

  const insertClosure = (id: string, startsAt: string, endsAt: string) =>
    db.sqlite
      .prepare(
        `INSERT INTO store_closures (id, store_id, starts_at, ends_at, source)
         VALUES (?, ?, ?, ?, 'admin')`
      )
      .run(id, STORE_ID, startsAt, endsAt);

  it("rejects an active reservation inserted into an existing closure", () => {
    insertClosure("closure_first", "2026-12-01T01:00:00.000Z", "2026-12-01T03:00:00.000Z");

    expect(() =>
      insertReservation({
        id: "reservation_second",
        startAt: "2026-12-01T02:00:00.000Z",
        endAt: "2026-12-01T03:00:00.000Z"
      })
    ).toThrow(/store_closed/);
  });

  it("rejects a closure inserted over an existing active reservation", () => {
    insertReservation({
      id: "reservation_first",
      startAt: "2026-12-01T02:00:00.000Z",
      endAt: "2026-12-01T03:00:00.000Z"
    });

    expect(() =>
      insertClosure("closure_second", "2026-12-01T01:00:00.000Z", "2026-12-01T03:00:00.000Z")
    ).toThrow(/overlapping_reservations/);
  });

  it("rejects updates that move either side into an overlap", () => {
    insertClosure("closure_update_guard", "2026-12-01T04:00:00.000Z", "2026-12-01T05:00:00.000Z");
    insertReservation({
      id: "reservation_update_guard",
      startAt: "2026-12-01T01:00:00.000Z",
      endAt: "2026-12-01T02:00:00.000Z"
    });

    expect(() =>
      db.sqlite
        .prepare("UPDATE reservations SET start_at = ?, end_at = ? WHERE id = ?")
        .run(
          "2026-12-01T04:30:00.000Z",
          "2026-12-01T05:00:00.000Z",
          "reservation_update_guard"
        )
    ).toThrow(/store_closed/);

    expect(() =>
      db.sqlite
        .prepare("UPDATE store_closures SET starts_at = ?, ends_at = ? WHERE id = ?")
        .run(
          "2026-12-01T00:30:00.000Z",
          "2026-12-01T01:30:00.000Z",
          "closure_update_guard"
        )
    ).toThrow(/overlapping_reservations/);
  });

  it("allows half-open boundaries and inactive reservation statuses", () => {
    insertClosure("closure_boundary", "2026-12-01T02:00:00.000Z", "2026-12-01T03:00:00.000Z");

    expect(() =>
      insertReservation({
        id: "reservation_boundary",
        startAt: "2026-12-01T01:00:00.000Z",
        endAt: "2026-12-01T02:00:00.000Z"
      })
    ).not.toThrow();
    expect(() =>
      insertReservation({
        id: "reservation_cancelled",
        startAt: "2026-12-01T02:30:00.000Z",
        endAt: "2026-12-01T03:30:00.000Z",
        status: "cancelled_by_admin"
      })
    ).not.toThrow();
  });
});
