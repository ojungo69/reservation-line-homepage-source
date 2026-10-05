import { describe, expect, it, vi, afterEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useDebouncedValue } from "./use-debounced-value";

afterEach(() => {
  vi.useRealTimers();
});

describe("useDebouncedValue", () => {
  it("遅延後に trim した値を返し、遅延中は前の値のまま", () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(({ value }) => useDebouncedValue(value), {
      initialProps: { value: "" },
    });

    rerender({ value: "  yamada  " });
    expect(result.current[0]).toBe("");

    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(result.current[0]).toBe("yamada");
  });

  it("遅延内に入力が続くとタイマーが張り直され、途中の値は出ない", () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(({ value }) => useDebouncedValue(value), {
      initialProps: { value: "" },
    });

    rerender({ value: "ya" });
    act(() => {
      vi.advanceTimersByTime(200);
    });
    rerender({ value: "yamada" });
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(result.current[0]).toBe("");

    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(result.current[0]).toBe("yamada");
  });

  // 顧客一覧のアーカイブ切替と LINE 連携ダイアログが依存している経路。setter で
  // 同期的に空にできないと、もう一致しない検索結果が最大 300ms 残る。
  it("setter で遅延窓を待たずに同期クリアできる", () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(({ value }) => useDebouncedValue(value), {
      initialProps: { value: "yamada" },
    });

    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(result.current[0]).toBe("yamada");

    act(() => {
      result.current[1]("");
    });
    expect(result.current[0]).toBe("");

    // クリア後に再入力なしで遅延が満了しても、元の値は戻ってこない
    rerender({ value: "" });
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(result.current[0]).toBe("");
  });

  it("遅延はミリ秒で上書きできる (予約作成パネルは 250ms)", () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(({ value }) => useDebouncedValue(value, 250), {
      initialProps: { value: "" },
    });

    rerender({ value: "tanaka" });
    act(() => {
      vi.advanceTimersByTime(249);
    });
    expect(result.current[0]).toBe("");

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current[0]).toBe("tanaka");
  });
});
