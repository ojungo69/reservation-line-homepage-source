import { afterEach, describe, expect, it } from "vitest";
import {
  endBulkApprove,
  endReservationAction,
  isBulkApproveRunning,
  tryBeginBulkApprove,
  tryBeginReservationAction,
} from "./reservation-action-lock";

// module スコープの共有状態なので、各テスト後に必ず初期状態へ戻す。
afterEach(() => {
  endBulkApprove();
  endReservationAction("r1");
  endReservationAction("r2");
});

describe("reservation-action-lock", () => {
  it("同一予約 id の単件操作は二重取得できない (別 hook インスタンスの ABA 防止)", () => {
    expect(tryBeginReservationAction("r1")).toBeNull();
    // 2画面目 (詳細パネルなど) からの同一予約は拒否される
    expect(tryBeginReservationAction("r1")).toBe("idempotency_in_progress");
    // 先行が解放して初めて再取得できる
    endReservationAction("r1");
    expect(tryBeginReservationAction("r1")).toBeNull();
  });

  it("一部の単件が解放されても、別の in-flight が残る限り一括承認は開始できない", () => {
    expect(tryBeginReservationAction("r1")).toBeNull();
    expect(tryBeginReservationAction("r2")).toBeNull();
    endReservationAction("r1");
    // r2 がまだ通信中: bulk は開始不可
    expect(tryBeginBulkApprove()).toBe(false);
    endReservationAction("r2");
    expect(tryBeginBulkApprove()).toBe(true);
  });

  it("一括承認中は単件操作を拒否し、終了後に再開できる", () => {
    expect(tryBeginBulkApprove()).toBe(true);
    expect(isBulkApproveRunning()).toBe(true);
    expect(tryBeginReservationAction("r1")).toBe("bulk_in_progress");
    endBulkApprove();
    expect(isBulkApproveRunning()).toBe(false);
    expect(tryBeginReservationAction("r1")).toBeNull();
  });

  it("一括承認は二重開始できず、単件 in-flight 中も開始できない", () => {
    expect(tryBeginBulkApprove()).toBe(true);
    expect(tryBeginBulkApprove()).toBe(false);
    endBulkApprove();

    expect(tryBeginReservationAction("r1")).toBeNull();
    expect(tryBeginBulkApprove()).toBe(false);
    endReservationAction("r1");
    expect(tryBeginBulkApprove()).toBe(true);
  });
});
