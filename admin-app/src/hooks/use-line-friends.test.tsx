import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestQueryClient as createClient, createQueryWrapper as createWrapper } from "@/test-utils/query-client";
import { mocks } from "@/test-utils/hook-mocks";
import {
  useCustomerSearch,
  useLineFriendLink,
  useLineFriends,
  useLineFriendSync,
} from "./use-line-friends";


describe("useLineFriends", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses raw filters in the key but trims the search term in the URL", async () => {
    const response = {
      ok: true,
      items: [
        {
          lineUserId: "U1",
          displayName: "山田 花子",
          pictureUrl: null,
          profileStatus: "fetched",
          linked: false,
          linkedCustomerId: null,
        },
      ],
      total: 1,
      page: 2,
      pageSize: 25,
    };
    mocks.api.get.mockResolvedValue(response);
    const client = createClient();

    const { result } = renderHook(
      () =>
        useLineFriends({
          filter: "unlinked",
          q: "  山田 花子  ",
          page: 2,
        }),
      { wrapper: createWrapper(client) },
    );

    await waitFor(() => expect(result.current.isPending).toBe(false));
    expect(result.current).toMatchObject({
      items: response.items,
      total: 1,
      pageSize: 25,
      isError: false,
    });
    expect(mocks.api.get).toHaveBeenCalledWith(
      "/api/admin/line-friends?filter=unlinked&page=2&q=%E5%B1%B1%E7%94%B0+%E8%8A%B1%E5%AD%90",
    );
    expect(
      client.getQueryCache().find({
        queryKey: ["line-friends", "unlinked", "  山田 花子  ", 2],
        exact: true,
      }),
    ).toBeDefined();
  });

  it("defaults enabled to true and omits a whitespace-only q parameter", async () => {
    mocks.api.get.mockResolvedValue({
      ok: true,
      items: [],
      total: 0,
      page: 1,
      pageSize: 50,
    });
    const client = createClient();

    const { result } = renderHook(
      () => useLineFriends({ filter: "all", q: "   ", page: 1 }),
      { wrapper: createWrapper(client) },
    );

    await waitFor(() => expect(result.current.isPending).toBe(false));
    expect(mocks.api.get).toHaveBeenCalledWith(
      "/api/admin/line-friends?filter=all&page=1",
    );
  });

  it("does not fetch when explicitly disabled and returns empty defaults", () => {
    const client = createClient();

    const { result } = renderHook(
      () =>
        useLineFriends({
          filter: "all",
          q: "",
          page: 1,
          enabled: false,
        }),
      { wrapper: createWrapper(client) },
    );

    expect(mocks.api.get).not.toHaveBeenCalled();
    expect(result.current).toMatchObject({
      items: [],
      total: 0,
      pageSize: 50,
      isPending: true,
      isFetching: false,
      isError: false,
    });
    expect(
      client.getQueryState(["line-friends", "all", "", 1])?.fetchStatus,
    ).toBe("idle");
  });

  it("keeps previous rows while the next page is fetching", async () => {
    const first = {
      ok: true,
      items: [
        {
          lineUserId: "U1",
          displayName: "山田 花子",
          pictureUrl: null,
          profileStatus: "fetched",
          linked: false,
          linkedCustomerId: null,
        },
      ],
      total: 2,
      page: 1,
      pageSize: 1,
    };
    const pending = new Promise<never>(() => undefined);
    mocks.api.get
      .mockResolvedValueOnce(first)
      .mockImplementation(() => pending);
    const client = createClient();

    const { result, rerender } = renderHook(
      ({ page }: { page: number }) =>
        useLineFriends({ filter: "all", q: "", page }),
      {
        initialProps: { page: 1 },
        wrapper: createWrapper(client),
      },
    );
    await waitFor(() => expect(result.current.items).toBe(first.items));

    rerender({ page: 2 });
    await waitFor(() => expect(result.current.isFetching).toBe(true));
    expect(result.current.items).toBe(first.items);
    expect(result.current.total).toBe(2);
  });
});

describe("line friend helper queries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("gates blank customer searches and preserves the raw query in key and URL", async () => {
    const disabledClient = createClient();
    const { result: disabled } = renderHook(
      () => useCustomerSearch("   "),
      { wrapper: createWrapper(disabledClient) },
    );
    expect(mocks.api.get).not.toHaveBeenCalled();
    expect(disabled.current).toEqual({ results: [], isPending: false });
    expect(
      disabledClient.getQueryState(["customer-search", "   "])
        ?.fetchStatus,
    ).toBe("idle");

    const response = { ok: true, customers: [] };
    mocks.api.get.mockResolvedValue(response);
    const client = createClient();
    const { result } = renderHook(
      () => useCustomerSearch(" 山田 "),
      { wrapper: createWrapper(client) },
    );

    await waitFor(() => expect(result.current.isPending).toBe(false));
    expect(result.current.results).toBe(response.customers);
    expect(mocks.api.get).toHaveBeenCalledWith(
      "/api/admin/customers?q=%20%E5%B1%B1%E7%94%B0%20",
    );
    expect(
      client.getQueryCache().find({
        queryKey: ["customer-search", " 山田 "],
        exact: true,
      }),
    ).toBeDefined();
  });
});

describe("line friend mutations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reports pending and failed profile counts after a partial sync", async () => {
    mocks.api.post.mockResolvedValue({
      ok: true,
      totalFriends: 10,
      fetched: 6,
      pending: 4,
      unavailable: 0,
      failed: 2,
    });
    const client = createClient();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    const { result } = renderHook(() => useLineFriendSync(), {
      wrapper: createWrapper(client),
    });

    await act(async () => {
      await result.current.mutateAsync();
    });

    expect(mocks.api.post).toHaveBeenCalledWith(
      "/api/admin/line-friends/sync",
    );
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: ["line-friends"],
    });
    expect(mocks.toast.success).toHaveBeenCalledWith(
      "同期しました（取得済み 6 / 残り 4 件）。残りはもう一度「同期」を押してください。",
    );
    expect(mocks.toast.warning).toHaveBeenCalledWith(
      "2 件のプロフィール取得に失敗しました。LINEの連携設定（トークン等）をご確認のうえ、もう一度お試しください。",
    );
  });

  it("reports a complete sync without a warning", async () => {
    mocks.api.post.mockResolvedValue({
      ok: true,
      totalFriends: 10,
      fetched: 10,
      pending: 0,
      unavailable: 0,
      failed: 0,
    });
    const client = createClient();
    const { result } = renderHook(() => useLineFriendSync(), {
      wrapper: createWrapper(client),
    });

    await act(async () => {
      await result.current.mutateAsync();
    });

    expect(mocks.toast.success).toHaveBeenCalledWith(
      "同期しました（友だち 10 名・取得済み 10 名）。",
    );
    expect(mocks.toast.warning).not.toHaveBeenCalled();
  });

  it("invalidates every affected cache after linking a LINE friend", async () => {
    const body = {
      mode: "existing" as const,
      storeId: "store-1",
      customerId: "customer-1",
    };
    mocks.api.post.mockResolvedValue({
      ok: true,
      customerId: "customer-1",
    });
    const client = createClient();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    const { result } = renderHook(() => useLineFriendLink(), {
      wrapper: createWrapper(client),
    });

    await act(async () => {
      await result.current.mutateAsync({
        lineUserId: "U/1",
        body,
      });
    });

    expect(mocks.api.post).toHaveBeenCalledWith(
      "/api/admin/line-friends/U%2F1/link",
      body,
    );
    expect(
      invalidate.mock.calls.map(
        ([filters]) =>
          (filters as { queryKey?: readonly unknown[] }).queryKey,
      ),
    ).toEqual([
      ["line-friends"],
      ["customers"],
      ["customer-search"],
    ]);
    expect(mocks.toast.success).toHaveBeenCalledWith("紐付けました");
  });

  it.each([
    {
      name: "同期",
      useHook: useLineFriendSync,
      method: "post" as const,
      variables: undefined,
      fallback: "LINE友だちの同期に失敗しました",
    },
    {
      name: "紐付け",
      useHook: useLineFriendLink,
      method: "post" as const,
      variables: {
        lineUserId: "U1",
        body: {
          mode: "existing" as const,
          storeId: "store-1",
          customerId: "customer-1",
        },
      },
      fallback: "紐付けに失敗しました",
    },
  ])("$name error uses its configured fallback", async (testCase) => {
    const error = new Error("network");
    mocks.api[testCase.method].mockRejectedValue(error);
    const client = createClient();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    const { result } = renderHook(
      () => testCase.useHook() as unknown as {
        mutateAsync: (variables?: unknown) => Promise<unknown>;
      },
      { wrapper: createWrapper(client) },
    );

    await act(async () => {
      await expect(
        result.current.mutateAsync(testCase.variables),
      ).rejects.toBe(error);
    });

    expect(mocks.showErrorToast).toHaveBeenCalledWith(
      error,
      testCase.fallback,
    );
    expect(invalidate).not.toHaveBeenCalled();
    expect(mocks.toast.success).not.toHaveBeenCalled();
  });
});
