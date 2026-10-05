import { act, renderHook, waitFor } from "@testing-library/react";
import { focusManager } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createQueryWrapper, createTestQueryClient } from "@/test-utils/query-client";
import { mocks } from "@/test-utils/hook-mocks";
import { useReservations, usePendingReservations } from "./use-reservations";
import { useExternalBlocks } from "./use-external-blocks";
import { useSettings, useSettingsSelect } from "./use-settings";

beforeEach(() => {
  vi.clearAllMocks();
  focusManager.setFocused(true);
  vi.useFakeTimers({ shouldAdvanceTime: true });
});
afterEach(() => {
  vi.useRealTimers();
  focusManager.setFocused(undefined);
});

describe("表示中のスケジュールの鮮度", () => {
  it.each([
    { name: "予約", hook: () => useReservations("2026-09-29"), response: { ok: true, reservations: [] } },
    { name: "ブロック", hook: useExternalBlocks, response: { ok: true, externalBlocks: [] } },
    { name: "承認待ち", hook: usePendingReservations, response: { ok: true, reservations: [] } },
    { name: "スケジュール設定", hook: () => useSettings({ live: true }), response: { ok: true, settings: {} } },
  ])("$nameを30秒で更新し、hiddenでは停止、復帰時は直ちに取得する", async ({ hook, response }) => {
    mocks.api.get.mockResolvedValue(response);
    const client = createTestQueryClient();
    client.setDefaultOptions({ queries: { retry: false, refetchOnWindowFocus: false } });
    const { result, unmount } = renderHook(() => hook(), { wrapper: createQueryWrapper(client) });
    await waitFor(() => expect(result.current.data).toEqual(response));
    expect(mocks.api.get).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(mocks.api.get).toHaveBeenCalledTimes(2);
    await act(async () => {
      focusManager.setFocused(false);
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(mocks.api.get).toHaveBeenCalledTimes(2);
    await act(async () => { focusManager.setFocused(true); });
    await waitFor(() => expect(mocks.api.get).toHaveBeenCalledTimes(3));
    unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(mocks.api.get).toHaveBeenCalledTimes(3);
    client.clear();
  });

  it("通常の設定と派生hookは同じcacheを使い、scheduleだけpollして設定変更を届ける", async () => {
    const response = { ok: true, settings: { resources: [{ id: "resource-1", name: "元の担当者" }], businessHours: [{ opensAt: "09:00" }] } };
    mocks.api.get.mockResolvedValue(response);
    const client = createTestQueryClient();
    client.setDefaultOptions({ queries: { retry: false, refetchOnWindowFocus: false } });
    const wrapper = createQueryWrapper(client);
    const normal = renderHook(() => {
      const settings = useSettings();
      const resources = useSettingsSelect((data) => data.settings.resources);
      return { settings, resources };
    }, { wrapper });
    await waitFor(() => expect(normal.result.current.settings.data).toEqual(response));
    expect(mocks.api.get).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(90_000); });
    expect(mocks.api.get).toHaveBeenCalledTimes(1);

    const live = renderHook(() => useSettings({ live: true }), { wrapper });
    await waitFor(() => expect(live.result.current.data).toEqual(response));
    const updated = { ok: true, settings: { resources: [{ id: "resource-1", name: "新しい担当者" }], businessHours: [{ opensAt: "11:00" }] } };
    mocks.api.get.mockResolvedValue(updated);
    const before = mocks.api.get.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(mocks.api.get).toHaveBeenCalledTimes(before + 1);
    expect(live.result.current.data).toEqual(updated);
    expect(normal.result.current.resources.data?.[0].name).toBe("新しい担当者");
    expect(normal.result.current.settings.data?.settings.businessHours[0].opensAt).toBe("11:00");
    live.unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(mocks.api.get).toHaveBeenCalledTimes(before + 1);
    normal.unmount();
    client.clear();
  });
});
