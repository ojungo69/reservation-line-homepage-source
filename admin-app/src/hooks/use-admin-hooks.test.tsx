import type { PropsWithChildren } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestQueryClient as createClient } from "@/test-utils/query-client";
import { mocks } from "@/test-utils/hook-mocks";
import { useAuditLogs } from "./use-audit-logs";
import { useAuth } from "./use-auth";
import {
  useExternalBlockCancel,
  useExternalBlockCreate,
  useExternalBlocks,
} from "./use-external-blocks";
import {
  buildCsvExportUrl,
  useReservationSearch,
} from "./use-reservation-search";
import {
  useStoreLoginRevoke,
  useStoreLogins,
  useStoreLoginUpsert,
} from "./use-store-logins";
import {
  AuthContext,
  type AuthContextValue,
} from "@/providers/auth-context";


const auth: AuthContextValue = {
  user: {
    email: "owner@example.com",
    role: "owner",
    staffMemberId: null,
    storeId: null,
  },
  isPrivileged: true,
  vapidPublicKey: "",
};

const createWrapper = (
  client: QueryClient,
  authValue: AuthContextValue | null = auth,
) =>
  function Wrapper({ children }: PropsWithChildren) {
    return (
      <QueryClientProvider client={client}>
        {authValue ? (
          <AuthContext.Provider value={authValue}>
            {children}
          </AuthContext.Provider>
        ) : (
          children
        )}
      </QueryClientProvider>
    );
  };

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

const mutationCases = [
  {
    name: "external block create",
    useHook: useExternalBlockCreate,
    method: "post",
    variables: {
      idempotencyKey: "block-key",
      storeId: "store-1",
      resourceId: "resource-1",
      startAt: "2026-08-01T01:00:00.000Z",
      endAt: "2026-08-01T02:00:00.000Z",
      title: "社内会議",
    },
    call: [
      "/api/admin/external-blocks",
      {
        idempotencyKey: "block-key",
        storeId: "store-1",
        resourceId: "resource-1",
        startAt: "2026-08-01T01:00:00.000Z",
        endAt: "2026-08-01T02:00:00.000Z",
        title: "社内会議",
      },
    ],
    invalidates: [["external-blocks"], ["reservations"]],
    success: "ブロックを作成しました",
    error: "ブロックの作成に失敗しました",
  },
  {
    name: "external block cancel with reason",
    useHook: useExternalBlockCancel,
    method: "post",
    variables: {
      externalBlockId: "block-1",
      reason: "  予定変更  ",
    },
    call: [
      "/api/admin/external-blocks/block-1/cancel",
      {
        idempotencyKey: "00000000-0000-4000-8000-000000000003",
        reason: "予定変更",
      },
    ],
    invalidates: [["external-blocks"], ["reservations"]],
    success: "ブロックを解除しました",
    error: "ブロックの解除に失敗しました",
  },
  {
    name: "external block cancel without reason",
    useHook: useExternalBlockCancel,
    method: "post",
    variables: {
      externalBlockId: "block-1",
      reason: "   ",
    },
    call: [
      "/api/admin/external-blocks/block-1/cancel",
      {
        idempotencyKey: "00000000-0000-4000-8000-000000000003",
      },
    ],
    invalidates: [["external-blocks"], ["reservations"]],
    success: "ブロックを解除しました",
    error: "ブロックの解除に失敗しました",
  },
  {
    name: "store login upsert",
    useHook: useStoreLoginUpsert,
    method: "post",
    variables: {
      storeId: "store-1",
      email: "staff@example.com",
      role: "staff",
      idempotencyKey: "login-key",
    },
    call: [
      "/api/admin/store-logins",
      {
        storeId: "store-1",
        email: "staff@example.com",
        role: "staff",
        idempotencyKey: "login-key",
      },
    ],
    invalidates: [["store-logins"]],
    success: "店舗ログインを設定しました",
    error: "店舗ログインの設定に失敗しました",
  },
  {
    name: "store login revoke",
    useHook: useStoreLoginRevoke,
    method: "delete",
    variables: "store-1",
    call: ["/api/admin/store-logins/store-1"],
    invalidates: [["store-logins"]],
    success: "店舗ログインを無効化しました",
    error: "無効化に失敗しました",
  },
] as const;

describe("reservation and audit search queries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("gates a null reservation filter without calling the API", () => {
    const client = createClient();
    renderHook(() => useReservationSearch(null), {
      wrapper: createWrapper(client),
    });

    expect(mocks.api.get).not.toHaveBeenCalled();
    expect(
      client.getQueryState(["reservations", "search", null])
        ?.fetchStatus,
    ).toBe("idle");
  });

  it("serializes every reservation search filter and repeated status exactly", async () => {
    const filter = {
      from: "2026-07-01",
      to: "2026-07-31",
      storeId: "store/1",
      serviceId: "service 1",
      statuses: ["confirmed", "pending_approval"],
      keyword: "  山田 花子  ",
    };
    const response = { ok: true, reservations: [], total: 0 };
    mocks.api.get.mockResolvedValue(response);
    const client = createClient();

    const { result } = renderHook(
      () => useReservationSearch(filter),
      { wrapper: createWrapper(client) },
    );

    await waitFor(() => expect(result.current.data).toBe(response));
    const qs =
      "from=2026-07-01&to=2026-07-31&storeId=store%2F1&serviceId=service+1&status=confirmed&status=pending_approval&keyword=%E5%B1%B1%E7%94%B0+%E8%8A%B1%E5%AD%90";
    expect(mocks.api.get).toHaveBeenCalledWith(
      `/api/admin/reservations/search?${qs}`,
    );
    expect(buildCsvExportUrl(filter)).toBe(
      `/api/admin/reservations/export.csv?${qs}`,
    );
    expect(
      client.getQueryCache().find({
        queryKey: ["reservations", "search", filter],
        exact: true,
      }),
    ).toBeDefined();
  });

  it("omits optional reservation filters and keeps previous data while the filter changes", async () => {
    const firstFilter = {
      from: "2026-07-01",
      to: "2026-07-31",
    };
    const nextFilter = {
      from: "2026-08-01",
      to: "2026-08-31",
      statuses: [] as string[],
      keyword: "   ",
    };
    const response = { ok: true, reservations: [], total: 0 };
    const pending = new Promise<never>(() => undefined);
    mocks.api.get
      .mockResolvedValueOnce(response)
      .mockImplementation(() => pending);
    const client = createClient();

    const { result, rerender } = renderHook(
      ({ filter }) => useReservationSearch(filter),
      {
        initialProps: { filter: firstFilter },
        wrapper: createWrapper(client),
      },
    );
    await waitFor(() => expect(result.current.data).toBe(response));

    rerender({ filter: nextFilter });
    await waitFor(() => expect(result.current.isFetching).toBe(true));
    expect(result.current.data).toBe(response);
    expect(mocks.api.get).toHaveBeenLastCalledWith(
      "/api/admin/reservations/search?from=2026-08-01&to=2026-08-31",
    );
  });

  it("serializes audit filters and trims the keyword", async () => {
    const filter = {
      from: "2026-07-01",
      to: "2026-07-31",
      actorType: "staff",
      keyword: "  山田  ",
    };
    const response = { ok: true, logs: [], total: 0 };
    mocks.api.get.mockResolvedValue(response);
    const client = createClient();

    const { result } = renderHook(() => useAuditLogs(filter), {
      wrapper: createWrapper(client),
    });

    await waitFor(() => expect(result.current.data).toBe(response));
    expect(mocks.api.get).toHaveBeenCalledWith(
      "/api/admin/audit-logs?from=2026-07-01&to=2026-07-31&actorType=staff&keyword=%E5%B1%B1%E7%94%B0",
    );
    expect(
      client.getQueryCache().find({
        queryKey: ["audit-logs", filter],
        exact: true,
      }),
    ).toBeDefined();
  });

  it("uses the audit base URL for an empty filter and keeps prior data on filter changes", async () => {
    const response = { ok: true, logs: [], total: 0 };
    const pending = new Promise<never>(() => undefined);
    mocks.api.get
      .mockResolvedValueOnce(response)
      .mockImplementation(() => pending);
    const client = createClient();

    const { result, rerender } = renderHook(
      ({ filter }) => useAuditLogs(filter),
      {
        initialProps: { filter: {} },
        wrapper: createWrapper(client),
      },
    );
    await waitFor(() => expect(result.current.data).toBe(response));
    expect(mocks.api.get).toHaveBeenCalledWith(
      "/api/admin/audit-logs",
    );

    rerender({ filter: { keyword: "記録" } });
    await waitFor(() => expect(result.current.isFetching).toBe(true));
    expect(result.current.data).toBe(response);
  });
});

describe("external block and store-login queries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses the external-blocks key and endpoint", async () => {
    const response = { ok: true, externalBlocks: [] };
    mocks.api.get.mockResolvedValue(response);
    const client = createClient();
    const { result } = renderHook(() => useExternalBlocks(), {
      wrapper: createWrapper(client),
    });

    await waitFor(() => expect(result.current.data).toBe(response));
    expect(mocks.api.get).toHaveBeenCalledWith(
      "/api/admin/external-blocks",
    );
    expect(
      client.getQueryCache().find({
        queryKey: ["external-blocks"],
        exact: true,
      }),
    ).toBeDefined();
  });

  it("selects store-logins from the store-logins response", async () => {
    const storeLogin = {
      storeId: "store-1",
      storeName: "銀座店",
      email: "staff@example.com",
      role: "staff",
      status: "active",
      lastSeenAt: "2026-07-24T00:00:00Z",
      attention: null,
      canConfigure: true,
    };
    mocks.api.get.mockResolvedValue({
      ok: true,
      storeLogins: [storeLogin],
    });
    const client = createClient();
    const { result } = renderHook(() => useStoreLogins(), {
      wrapper: createWrapper(client),
    });

    await waitFor(() => expect(result.current.isPending).toBe(false));
    expect(result.current).toEqual({
      storeLogins: [storeLogin],
      isPending: false,
      isError: false,
    });
    expect(mocks.api.get).toHaveBeenCalledWith(
      "/api/admin/store-logins",
    );
    expect(
      client.getQueryCache().find({
        queryKey: ["store-logins"],
        exact: true,
      }),
    ).toBeDefined();
  });
});

describe("useAuth", () => {
  it("returns the exact AuthContext value", () => {
    const client = createClient();
    const { result } = renderHook(() => useAuth(), {
      wrapper: createWrapper(client),
    });
    expect(result.current).toBe(auth);
  });

  it("requires an AuthProvider", () => {
    const client = createClient();
    expect(() =>
      renderHook(() => useAuth(), {
        wrapper: createWrapper(client, null),
      }),
    ).toThrow("useAuth must be inside AuthProvider");
  });
});

describe("admin mutations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue(
      "00000000-0000-4000-8000-000000000003",
    );
  });

  it.each(mutationCases)(
    "$name sends the exact request and invalidates every affected key",
    async (testCase) => {
      mocks.api[testCase.method].mockResolvedValue({ ok: true });
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
      expect(mocks.showErrorToast).not.toHaveBeenCalled();
    },
  );

  it.each(mutationCases)(
    "$name reports its configured error without invalidating success caches",
    async (testCase) => {
      const error = new Error(`${testCase.name} failed`);
      mocks.api[testCase.method].mockRejectedValue(error);
      const client = createClient();
      const invalidate = vi.spyOn(client, "invalidateQueries");
      const { result } = renderMutation(testCase.useHook, client);

      await act(async () => {
        await expect(
          result.current.mutateAsync(testCase.variables),
        ).rejects.toBe(error);
      });

      expect(mocks.showErrorToast).toHaveBeenCalledWith(
        error,
        testCase.error,
      );
      expect(invalidate).not.toHaveBeenCalled();
      expect(mocks.toast.success).not.toHaveBeenCalled();
    },
  );
});
