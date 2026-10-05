import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useTimelineDensity, DENSITY_SLOT_PX } from "./use-timeline-density";

describe("useTimelineDensity", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("defaults to standard (40px) when nothing is stored", () => {
    const { result } = renderHook(() => useTimelineDensity());
    expect(result.current.density).toBe("standard");
    expect(result.current.slotPx).toBe(40);
  });

  it("falls back to standard on an invalid stored value", () => {
    localStorage.setItem("admin-schedule-density", "tiny");
    const { result } = renderHook(() => useTimelineDensity());
    expect(result.current.density).toBe("standard");
  });

  it("restores a stored compact density", () => {
    localStorage.setItem("admin-schedule-density", "compact");
    const { result } = renderHook(() => useTimelineDensity());
    expect(result.current.density).toBe("compact");
    expect(result.current.slotPx).toBe(DENSITY_SLOT_PX.compact);
  });

  it("survives a blocked storage environment (getItem/setItem throw)", () => {
    // Safari プライベートモード等: localStorage アクセスが例外を投げても
    // 画面を壊さず standard で動き、切替もその場限りで効くこと。
    const throwing = {
      getItem: () => {
        throw new Error("storage disabled");
      },
      setItem: () => {
        throw new Error("storage disabled");
      }
    } as unknown as Storage;
    vi.stubGlobal("localStorage", throwing);
    try {
      const { result } = renderHook(() => useTimelineDensity());
      expect(result.current.density).toBe("standard");
      act(() => {
        result.current.setDensity("compact");
      });
      expect(result.current.density).toBe("compact");
      expect(result.current.slotPx).toBe(24);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("persists switches to localStorage", () => {
    const { result } = renderHook(() => useTimelineDensity());

    act(() => {
      result.current.setDensity("compact");
    });
    expect(result.current.density).toBe("compact");
    expect(result.current.slotPx).toBe(24);
    expect(localStorage.getItem("admin-schedule-density")).toBe("compact");

    act(() => {
      result.current.setDensity("standard");
    });
    expect(result.current.density).toBe("standard");
    expect(localStorage.getItem("admin-schedule-density")).toBe("standard");
  });
});
