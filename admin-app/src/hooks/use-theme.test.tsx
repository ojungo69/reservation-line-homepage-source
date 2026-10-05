import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useTheme } from "./use-theme";

describe("useTheme", () => {
  let prefersDark = false;
  let changeHandler: (() => void) | undefined;
  let mediaQuery: MediaQueryList;

  beforeEach(() => {
    localStorage.clear();
    document.documentElement.classList.remove("dark");
    prefersDark = false;
    changeHandler = undefined;

    mediaQuery = {
      get matches() {
        return prefersDark;
      },
      media: "(prefers-color-scheme: dark)",
      onchange: null,
      addEventListener: vi.fn((_type, listener) => {
        changeHandler = listener as () => void;
      }),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    };
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => mediaQuery),
    );
  });

  it("defaults invalid storage to system and follows system changes", () => {
    localStorage.setItem("admin-theme", "sepia");
    const { result } = renderHook(() => useTheme());

    expect(result.current).toMatchObject({
      theme: "system",
      resolved: "light",
    });
    expect(document.documentElement.classList.contains("dark")).toBe(
      false,
    );
    expect(mediaQuery.addEventListener).toHaveBeenCalledWith(
      "change",
      expect.any(Function),
    );

    prefersDark = true;
    act(() => {
      changeHandler?.();
    });
    expect(document.documentElement.classList.contains("dark")).toBe(
      true,
    );
  });

  it("restores a stored explicit theme without subscribing to system changes", () => {
    localStorage.setItem("admin-theme", "dark");
    const { result } = renderHook(() => useTheme());

    expect(result.current).toMatchObject({
      theme: "dark",
      resolved: "dark",
    });
    expect(document.documentElement.classList.contains("dark")).toBe(
      true,
    );
    expect(mediaQuery.addEventListener).not.toHaveBeenCalled();
  });

  it("persists explicit changes, applies them, and cleans up the system listener", () => {
    const { result, unmount } = renderHook(() => useTheme());
    const subscribedHandler = changeHandler;

    act(() => {
      result.current.setTheme("light");
    });

    expect(result.current).toMatchObject({
      theme: "light",
      resolved: "light",
    });
    expect(localStorage.getItem("admin-theme")).toBe("light");
    expect(document.documentElement.classList.contains("dark")).toBe(
      false,
    );
    expect(mediaQuery.removeEventListener).toHaveBeenCalledWith(
      "change",
      subscribedHandler,
    );

    act(() => {
      result.current.setTheme("system");
    });
    expect(result.current.theme).toBe("system");
    expect(localStorage.getItem("admin-theme")).toBe("system");
    expect(mediaQuery.addEventListener).toHaveBeenCalledTimes(2);

    unmount();
    expect(mediaQuery.removeEventListener).toHaveBeenLastCalledWith(
      "change",
      changeHandler,
    );
  });
});
