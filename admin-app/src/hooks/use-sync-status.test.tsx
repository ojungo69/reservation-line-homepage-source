import { act, renderHook, waitFor } from "@testing-library/react";
import type { QueryClient } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestQueryClient as createClient, createQueryWrapper as createWrapper } from "@/test-utils/query-client";
import { mocks } from "@/test-utils/hook-mocks";
import {
  useConflictAction,
  useGoogleEditMode,
  useSyncJobAcknowledge,
  useSyncJobRetry,
  useSyncStatus,
} from "./use-sync-status";


type MutationResult = {
  mutateAsync: (variables: unknown) => Promise<unknown>;
};

const renderMutation = (
  useHook: () => unknown,
  client: QueryClient,
) =>
  renderHook(() => useHook() as MutationResult, {
    wrapper: createWrapper(client),
  });

describe("useSyncStatus", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each(["staff", "system_admin"])("polls the enabled %s status endpoint every 30 seconds", async (role) => {
    const response = { ok: true, role, warnings: [] };
    mocks.api.get.mockResolvedValue(response);
    const client = createClient();

    // ポーリング間隔は内部 options を覗かず、実際に再取得が走ることで確認する。
    // refetchInterval のタイマーは mount 時に張られるので、renderHook より前に
    // fake timer へ切り替える必要がある。shouldAdvanceTime で waitFor も進む。
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { result } = renderHook(() => useSyncStatus(), {
        wrapper: createWrapper(client),
      });

      expect(result.current.syncStatus).toBeNull();
      await waitFor(() => expect(result.current.isPending).toBe(false));
      expect(result.current).toEqual({
        syncStatus: response,
        isPending: false,
        isError: false,
        error: null,
        refetch: expect.any(Function),
      });
      expect(mocks.api.get).toHaveBeenCalledWith(
        "/api/admin/sync/status",
        { signal: expect.any(AbortSignal) },
      );
      expect(
        client.getQueryCache().find({
          queryKey: ["sync-status"],
          exact: true,
        }),
      ).toBeDefined();

      const callsBeforeInterval = mocks.api.get.mock.calls.length;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(29_000);
      });
      expect(mocks.api.get).toHaveBeenCalledTimes(callsBeforeInterval);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000);
      });
      expect(mocks.api.get).toHaveBeenCalledTimes(
        callsBeforeInterval + 1,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns a null status and error state when polling fails", async () => {
    const error = new Error("network");
    mocks.api.get.mockRejectedValue(error);
    const client = createClient();

    const { result } = renderHook(() => useSyncStatus(), {
      wrapper: createWrapper(client),
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.syncStatus).toBeNull();
    expect(result.current.isPending).toBe(false);
    expect(result.current.error).toBe(error);
  });
});

describe("sync mutations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    {
      name: "retry",
      useHook: useSyncJobRetry,
      method: "post" as const,
      variables: {
        jobId: "job-1",
        source: "calendar",
        idempotencyKey: "retry-key",
      },
      call: [
        "/api/admin/sync/jobs/retry",
        {
          jobId: "job-1",
          source: "calendar",
          idempotencyKey: "retry-key",
        },
      ],
      invalidates: [["sync-status"]],
      success: "リトライを開始しました",
      error: "リトライに失敗しました",
      response: { ok: true },
    },
    {
      name: "acknowledge",
      useHook: useSyncJobAcknowledge,
      method: "post" as const,
      variables: {
        jobId: "job-1",
        source: "calendar",
        idempotencyKey: "ack-key",
        note: "確認済み",
      },
      call: [
        "/api/admin/sync/jobs/acknowledge",
        {
          jobId: "job-1",
          source: "calendar",
          idempotencyKey: "ack-key",
          note: "確認済み",
        },
      ],
      invalidates: [["sync-status"]],
      success: "確認済みにしました",
      error: "確認済みにできませんでした",
      response: { ok: true },
    },
    {
      name: "conflict",
      useHook: useConflictAction,
      method: "post" as const,
      variables: {
        path: "conflicts/conflict-1/ignore",
        body: { idempotencyKey: "conflict-key" },
      },
      call: [
        "/api/admin/sync/conflicts/conflict-1/ignore",
        { idempotencyKey: "conflict-key" },
      ],
      invalidates: [["sync-status"]],
      success: "競合を処理しました",
      error: "競合の処理に失敗しました",
      response: { ok: true },
    },
    {
      name: "google edit mode",
      useHook: useGoogleEditMode,
      method: "put" as const,
      variables: { storeId: "store-1", enabled: true },
      call: [
        "/api/admin/settings/google-edit-mode",
        { storeId: "store-1", enabled: true },
      ],
      invalidates: [["sync-status"], ["settings"]],
      success: "Google編集モードを有効にしました",
      error: "Google編集モードの変更に失敗しました",
      response: { ok: true, storeId: "store-1", enabled: true },
    },
  ])(
    "$name sends the exact request and runs success/error effects",
    async (testCase) => {
      mocks.api[testCase.method].mockResolvedValue(testCase.response);
      const client = createClient();
      const invalidate = vi.spyOn(client, "invalidateQueries");
      const { result } = renderMutation(testCase.useHook, client);

      await act(async () => {
        await result.current.mutateAsync(testCase.variables);
      });

      expect(mocks.api[testCase.method]).toHaveBeenCalledWith(
        ...testCase.call,
      );
      expect(
        invalidate.mock.calls.map(
          ([filters]) =>
            (filters as { queryKey?: readonly unknown[] }).queryKey,
        ),
      ).toEqual(testCase.invalidates);
      expect(mocks.toast.success).toHaveBeenCalledWith(testCase.success);

      vi.clearAllMocks();
      const error = new Error(`${testCase.name} failed`);
      mocks.api[testCase.method].mockRejectedValue(error);
      const errorClient = createClient();
      const errorInvalidate = vi.spyOn(
        errorClient,
        "invalidateQueries",
      );
      const errorHook = renderMutation(testCase.useHook, errorClient);

      await act(async () => {
        await expect(
          errorHook.result.current.mutateAsync(testCase.variables),
        ).rejects.toBe(error);
      });

      expect(mocks.showErrorToast).toHaveBeenCalledWith(
        error,
        testCase.error,
      );
      expect(errorInvalidate).not.toHaveBeenCalled();
      expect(mocks.toast.success).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      path: "conflicts/conflict-1/approve-cancel" as const,
      expected: [["sync-status"], ["reservations"]],
    },
    {
      path: "conflicts/conflict-1/reject-delete" as const,
      expected: [["sync-status"], ["reservations"]],
    },
    {
      path: "all-day-candidates/candidate-1/approve" as const,
      expected: [["sync-status"], ["settings"]],
    },
    {
      path: "all-day-candidates/candidate-1/reject" as const,
      expected: [["sync-status"], ["settings"]],
    },
  ])(
    "invalidates the caches affected by $path",
    async ({ path, expected }) => {
      mocks.api.post.mockResolvedValue({ ok: true });
      const client = createClient();
      const invalidate = vi.spyOn(client, "invalidateQueries");
      const { result } = renderMutation(useConflictAction, client);

      await act(async () => {
        await result.current.mutateAsync({
          path,
          body: { idempotencyKey: "conflict-key" },
        });
      });

      expect(mocks.api.post).toHaveBeenCalledWith(
        `/api/admin/sync/${path}`,
        { idempotencyKey: "conflict-key" },
      );
      expect(
        invalidate.mock.calls.map(
          ([filters]) =>
            (filters as { queryKey?: readonly unknown[] }).queryKey,
        ),
      ).toEqual(expected);
    },
  );

  it("uses the disabled wording returned by the Google edit-mode response", async () => {
    mocks.api.put.mockResolvedValue({
      ok: true,
      storeId: "store-1",
      enabled: false,
    });
    const client = createClient();
    const { result } = renderMutation(useGoogleEditMode, client);

    await act(async () => {
      await result.current.mutateAsync({
        storeId: "store-1",
        enabled: false,
      });
    });

    expect(mocks.toast.success).toHaveBeenCalledWith(
      "Google編集モードを無効にしました",
    );
  });
});
