import { describe, expect, it } from "vitest";

import { resolveRescheduleKey } from "./reschedule-idempotency";

describe("resolveRescheduleKey", () => {
  const R = "res-1";
  const R2 = "res-2";
  const startA = "2026-06-01T01:00:00+09:00";
  const startB = "2026-06-01T02:00:00+09:00";

  it("初回はキーを新規発行する", () => {
    let n = 0;
    const state = resolveRescheduleKey(null, R, startA, () => `k${++n}`);
    expect(state).toEqual({ reservationId: R, startAt: startA, key: "k1" });
    expect(n).toBe(1);
  });

  it("同じ予約・同じ startAt への再送はキーを保つ（replay 保証）", () => {
    const prev = { reservationId: R, startAt: startA, key: "k1" };
    const mint = () => {
      throw new Error("同一 (予約, startAt) で再発行してはいけない");
    };
    expect(resolveRescheduleKey(prev, R, startA, mint)).toBe(prev);
  });

  it("startAt が変わったら新しいキーを発行する", () => {
    const prev = { reservationId: R, startAt: startA, key: "k1" };
    const next = resolveRescheduleKey(prev, R, startB, () => "k2");
    expect(next).toEqual({ reservationId: R, startAt: startB, key: "k2" });
  });

  it("予約が変わったら（同じ startAt でも）新しいキーを発行する", () => {
    const prev = { reservationId: R, startAt: startA, key: "k1" };
    const next = resolveRescheduleKey(prev, R2, startA, () => "k2");
    expect(next).toEqual({ reservationId: R2, startAt: startA, key: "k2" });
  });

  it("同一予約内で A→B→A と戻すと A のキーも新しくなる（同予約は直前1件のみ保持）", () => {
    let n = 1;
    const mint = () => `k${++n}`;
    const a1 = { reservationId: R, startAt: startA, key: "k1" };
    const b = resolveRescheduleKey(a1, R, startB, mint); // k2
    const a2 = resolveRescheduleKey(b, R, startA, mint); // k3（k1 ではない）
    expect(a2.key).toBe("k3");
    expect(a2.startAt).toBe(startA);
  });

  it("予約IDごとの Map 保持: R1 応答喪失 → R2 送信 → R1 同一時刻再送で R1 のキーが維持される", () => {
    // ダイアログ本体の keyStatesRef と同じ使い方（予約IDで引く Map）をシミュレートする。
    let n = 0;
    const mint = () => `k${++n}`;
    const map = new Map<string, ReturnType<typeof resolveRescheduleKey>>();
    const submit = (reservationId: string, startAt: string) => {
      const next = resolveRescheduleKey(map.get(reservationId) ?? null, reservationId, startAt, mint);
      map.set(reservationId, next);
      return next.key;
    };
    const r1First = submit(R, startA); // k1（応答喪失・サーバは成功済みと仮定）
    submit(R2, startB); // R2 の送信（別予約）— R1 の状態を潰さない
    const r1Retry = submit(R, startA); // R1 を同一時刻で再送
    expect(r1Retry).toBe(r1First); // 同じキー = サーバ側で replay され重複通知を防ぐ
  });
});
