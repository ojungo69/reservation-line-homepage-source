import type { SQLInputValue } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMigratedSqliteD1, type SqliteD1Database } from "./helpers/sqlite-d1";

const operation = {
  operationId: "op-1",
  reservationId: "reservation-1",
  actorId: "actor-1",
  key: "operation-key-1",
  hash: "0123456789abcdef".repeat(4),
  kind: "move",
  inverseOfOperationId: null,
  status: "started",
  createdAt: "2027-01-01T00:00:00Z",
  updatedAt: "2027-01-01T00:00:00Z",
  beforeVersion: null,
  appliedVersion: null,
  beforeSnapshot: null,
  afterSnapshot: null,
  effects: null
};

const result = {
  beforeVersion: 3,
  appliedVersion: 4,
  beforeSnapshot: '{"startAt":"2027-01-02T01:00:00Z"}',
  afterSnapshot: '{"startAt":"2027-01-02T02:00:00Z"}',
  effects: '{"lineJobCreated":false}'
};

describe("0061 reservation change operations", () => {
  let db: SqliteD1Database;

  beforeEach(() => {
    db = createMigratedSqliteD1();
    db.sqlite.exec(`
      INSERT INTO customers (id, display_name) VALUES ('customer-1', 'Test customer');
      INSERT INTO reservations
        (id, store_id, service_id, customer_id, resource_id, source, status,
         start_at, end_at, duration_minutes, idempotency_key)
      VALUES ('reservation-1', 'kyoto', 'service_kyoto_default_60', 'customer-1',
        'resource_kyoto_calendar', 'admin', 'confirmed',
        '2027-01-02T01:00:00Z', '2027-01-02T02:00:00Z', 60, 'reservation-key-1');
    `);
  });

  afterEach(() => db.sqlite.close());

  const insertOperation = (overrides: Partial<Record<keyof typeof operation, SQLInputValue>> = {}) =>
    db.sqlite.prepare(`
      INSERT INTO reservation_change_operations
        (operation_id, reservation_id, actor_id, idempotency_key, request_hash,
         kind, inverse_of_operation_id, status, created_at, updated_at,
         before_version, applied_version, before_snapshot_json, after_snapshot_json, effects_json)
      VALUES ($operationId, $reservationId, $actorId, $key, $hash,
        $kind, $inverseOfOperationId, $status, $createdAt, $updatedAt,
        $beforeVersion, $appliedVersion, $beforeSnapshot, $afterSnapshot, $effects)
    `).run({ ...operation, ...overrides });

  it("inserts started, succeeded and not_applied operations", () => {
    insertOperation();
    insertOperation({ operationId: "op-2", key: "operation-key-2", kind: "resize", status: "succeeded", ...result });
    insertOperation({
      operationId: "op-3", key: "operation-key-3", kind: "undo", inverseOfOperationId: "op-2", status: "not_applied"
    });

    expect(db.sqlite.prepare(`
      SELECT status, before_version, applied_version FROM reservation_change_operations ORDER BY operation_id
    `).all()).toEqual([
      { status: "started", before_version: null, applied_version: null },
      { status: "succeeded", before_version: 3, applied_version: 4 },
      { status: "not_applied", before_version: null, applied_version: null }
    ]);
  });

  it("accepts only a 64-character lowercase hexadecimal request hash", () => {
    expect(() => insertOperation({ hash: "a".repeat(63) })).toThrow(/CHECK constraint failed/);
    expect(() => insertOperation({ hash: "a".repeat(65) })).toThrow(/CHECK constraint failed/);
    expect(() => insertOperation({ hash: "a".repeat(63) + "A" })).toThrow(/CHECK constraint failed/);
    expect(() => insertOperation({ hash: "a".repeat(63) + "g" })).toThrow(/CHECK constraint failed/);
    expect(() => insertOperation({ hash: operation.hash + "\0" })).toThrow(/CHECK constraint failed/);
  });

  it("checks the operation kind, status and undo reference", () => {
    expect(() => insertOperation({ kind: "cancel" })).toThrow(/CHECK constraint failed/);
    expect(() => insertOperation({ status: "failed" })).toThrow(/CHECK constraint failed/);
    expect(() => insertOperation({ kind: "undo" })).toThrow(/CHECK constraint failed/);
    expect(() => insertOperation({ inverseOfOperationId: "op-2" })).toThrow(/CHECK constraint failed/);
  });

  it("requires a complete result for success and empty results for other statuses", () => {
    for (const column of ["beforeVersion", "appliedVersion", "beforeSnapshot", "afterSnapshot", "effects"] as const) {
      expect(() => insertOperation({ status: "succeeded", ...result, [column]: null }), column)
        .toThrow(/CHECK constraint failed/);
      for (const status of ["started", "not_applied"]) {
        expect(() => insertOperation({ status, [column]: result[column] }), `${status} ${column}`)
          .toThrow(/CHECK constraint failed/);
      }
    }
  });

  it("requires success versions to be consecutive positive safe integers", () => {
    for (const [beforeVersion, appliedVersion] of [
      [0, 1], [3, 5], [1.5, 2.5], [9007199254740991, 9007199254740992]
    ]) {
      expect(() => insertOperation({ status: "succeeded", ...result, beforeVersion, appliedVersion }))
        .toThrow(/CHECK constraint failed/);
    }
  });

  it("requires valid JSON objects in all three result fields", () => {
    for (const column of ["beforeSnapshot", "afterSnapshot", "effects"] as const) {
      for (const json of ["{", "[]", "null", "1", '"text"']) {
        expect(() => insertOperation({ status: "succeeded", ...result, [column]: json }), `${column} = ${json}`)
          .toThrow(/CHECK constraint failed/);
      }
    }
  });

  it("scopes unique idempotency keys to the actor", () => {
    insertOperation();
    expect(() => insertOperation({ operationId: "op-2" })).toThrow(/UNIQUE constraint failed/);
    insertOperation({ operationId: "op-2", actorId: "actor-2" });

    expect(db.sqlite.prepare("SELECT actor_id FROM reservation_change_operations ORDER BY actor_id").all())
      .toEqual([{ actor_id: "actor-1" }, { actor_id: "actor-2" }]);
  });

  it("rejects changes to both terminal states", () => {
    insertOperation({ status: "succeeded", ...result });
    insertOperation({ operationId: "op-2", key: "operation-key-2", status: "not_applied" });

    expect(() => db.sqlite.exec(`
      UPDATE reservation_change_operations SET effects_json = '{}' WHERE operation_id = 'op-1'
    `)).toThrow("reservation_change_operation_finalized");
    expect(() => db.sqlite.exec(`
      UPDATE reservation_change_operations SET status = 'not_applied', before_version = NULL,
        applied_version = NULL, before_snapshot_json = NULL, after_snapshot_json = NULL, effects_json = NULL
      WHERE operation_id = 'op-1'
    `)).toThrow("reservation_change_operation_finalized");
    expect(() => db.sqlite.exec(`
      UPDATE reservation_change_operations SET status = 'started' WHERE operation_id = 'op-2'
    `)).toThrow("reservation_change_operation_finalized");
    expect(() => db.sqlite.exec(`
      UPDATE reservation_change_operations SET updated_at = '2027-01-01T00:01:00Z' WHERE operation_id = 'op-2'
    `)).toThrow("reservation_change_operation_finalized");
  });

  it("rejects changes to every identity column on a started operation", () => {
    insertOperation();
    const changes = {
      operation_id: "op-2",
      reservation_id: "another-reservation",
      actor_id: "actor-2",
      idempotency_key: "operation-key-2",
      request_hash: "a".repeat(64),
      kind: "resize",
      inverse_of_operation_id: "op-2",
      created_at: "2027-01-01T00:01:00Z"
    };
    for (const [column, value] of Object.entries(changes)) {
      expect(() => db.sqlite.prepare(`
        UPDATE reservation_change_operations SET ${column} = ? WHERE operation_id = 'op-1'
      `).run(value), column).toThrow("reservation_change_operation_identity_immutable");
    }
  });

  it("allows updating a started timestamp and finalizing as succeeded or not_applied", () => {
    insertOperation();
    insertOperation({ operationId: "op-2", key: "operation-key-2" });

    expect(() => db.sqlite.exec(`
      UPDATE reservation_change_operations SET effects_json = '{}' WHERE operation_id = 'op-1'
    `)).toThrow(/CHECK constraint failed/);
    db.sqlite.exec(`
      UPDATE reservation_change_operations SET updated_at = '2027-01-01T00:01:00Z' WHERE operation_id = 'op-1';
      UPDATE reservation_change_operations SET status = 'not_applied', updated_at = '2027-01-01T00:02:00Z'
      WHERE operation_id = 'op-2';
    `);
    expect(db.sqlite.prepare(`
      SELECT status, updated_at FROM reservation_change_operations WHERE operation_id = 'op-1'
    `).get()).toEqual({ status: "started", updated_at: "2027-01-01T00:01:00Z" });

    db.sqlite.prepare(`
      UPDATE reservation_change_operations SET status = 'succeeded', updated_at = '2027-01-01T00:02:00Z',
        before_version = $beforeVersion, applied_version = $appliedVersion, before_snapshot_json = $beforeSnapshot,
        after_snapshot_json = $afterSnapshot, effects_json = $effects
      WHERE operation_id = 'op-1'
    `).run(result);
    expect(db.sqlite.prepare(`
      SELECT status, updated_at, before_version, applied_version, before_snapshot_json, after_snapshot_json, effects_json
      FROM reservation_change_operations ORDER BY operation_id
    `).all()).toEqual([
      {
        status: "succeeded", updated_at: "2027-01-01T00:02:00Z", before_version: 3, applied_version: 4,
        before_snapshot_json: result.beforeSnapshot, after_snapshot_json: result.afterSnapshot, effects_json: result.effects
      },
      {
        status: "not_applied", updated_at: "2027-01-01T00:02:00Z", before_version: null, applied_version: null,
        before_snapshot_json: null, after_snapshot_json: null, effects_json: null
      }
    ]);
  });

  it("rejects an operation for a missing reservation", () => {
    expect(() => insertOperation({ reservationId: "missing-reservation" }))
      .toThrow(/FOREIGN KEY constraint failed/);
  });

  it("cascades deletion only to the deleted reservation's operations", () => {
    db.sqlite.exec(`
      INSERT INTO reservations
        (id, store_id, service_id, customer_id, resource_id, source, status,
         start_at, end_at, duration_minutes, idempotency_key)
      VALUES ('reservation-2', 'kyoto', 'service_kyoto_default_60', 'customer-1',
        'resource_kyoto_calendar', 'admin', 'confirmed',
        '2027-01-02T03:00:00Z', '2027-01-02T04:00:00Z', 60, 'reservation-key-2');
    `);
    insertOperation();
    insertOperation({ operationId: "op-2", key: "operation-key-2", status: "succeeded", ...result });
    insertOperation({ operationId: "op-3", key: "operation-key-3", reservationId: "reservation-2" });

    db.sqlite.exec("DELETE FROM reservations WHERE id = 'reservation-1'");

    expect(db.sqlite.prepare("SELECT operation_id, reservation_id FROM reservation_change_operations").all())
      .toEqual([{ operation_id: "op-3", reservation_id: "reservation-2" }]);
  });
});
