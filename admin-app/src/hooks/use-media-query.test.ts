import { describe, expect, it } from "vitest";
import { createMediaQueryStore, NARROW_QUERY, type MediaQueryLike } from "./use-media-query";

// node 環境用の fake MediaQueryList。フックが依存する最小面
// (matches / change リスナーの登録・解除) だけを実装する。
function createFakeMql(initialMatches: boolean) {
  const listeners = new Set<() => void>();
  const mql: MediaQueryLike & { setMatches: (next: boolean) => void } = {
    matches: initialMatches,
    addEventListener: (_type, listener) => {
      listeners.add(listener);
    },
    removeEventListener: (_type, listener) => {
      listeners.delete(listener);
    },
    setMatches: (next) => {
      (mql as { matches: boolean }).matches = next;
      for (const listener of listeners) listener();
    },
  };
  return { mql, listeners };
}

describe("createMediaQueryStore", () => {
  it("subscribe が change リスナーを登録し、解除関数が取り除く", () => {
    const { mql, listeners } = createFakeMql(false);
    const store = createMediaQueryStore(mql);

    let notified = 0;
    const unsubscribe = store.subscribe(() => {
      notified += 1;
    });
    expect(listeners.size).toBe(1);

    mql.setMatches(true);
    expect(notified).toBe(1);

    unsubscribe();
    expect(listeners.size).toBe(0);

    // 解除後の変化は通知されない
    mql.setMatches(false);
    expect(notified).toBe(1);
  });

  it("getSnapshot は生成済み MQL の現在値を返す (毎回の再評価なし)", () => {
    const { mql } = createFakeMql(false);
    const store = createMediaQueryStore(mql);

    expect(store.getSnapshot()).toBe(false);
    mql.setMatches(true);
    expect(store.getSnapshot()).toBe(true);
  });

  it("複数購読者が独立に解除できる", () => {
    const { mql, listeners } = createFakeMql(false);
    const store = createMediaQueryStore(mql);

    const calls: string[] = [];
    const unsubA = store.subscribe(() => calls.push("a"));
    store.subscribe(() => calls.push("b"));
    expect(listeners.size).toBe(2);

    unsubA();
    mql.setMatches(true);
    expect(calls).toEqual(["b"]);
  });
});

describe("NARROW_QUERY", () => {
  // Tailwind sm (640px) の補集合であることを守る。639px に「整理」すると
  // 分数ピクセル幅で 0.02px の隙間ができ、range 構文 (width < 640px) は
  // 旧 iOS Safari が解釈できない。どちらの退行もここで止める。
  it("max-width の .98px 補正形式で、640px の補集合になっている", () => {
    const match = /^\(max-width: (\d+\.98)px\)$/.exec(NARROW_QUERY);
    expect(match).not.toBeNull();
    expect(Number(match![1]) + 0.02).toBe(640);
  });

  it("range 構文 (<) を使っていない", () => {
    expect(NARROW_QUERY).not.toContain("<");
  });
});
