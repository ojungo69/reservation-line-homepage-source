import type { PropsWithChildren } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestQueryClient as createClient } from "@/test-utils/query-client";
import { mocks } from "@/test-utils/hook-mocks";
import {
  useAddCustomerVisit,
  useCreateCustomer,
  useCustomerArchiveAction,
  useCustomerBlockAction,
  useCustomerDelete,
  useCustomerDetail,
  useCustomerList,
  useCustomerMemoUpdate,
  useCustomerReferrerUpdate,
  useCustomerReservationsPage,
  useCustomerMerge,
  useCustomerProfileUpdate,
  useCustomerSearch,
  useDeleteCustomerVisit,
  useMergeCandidates,
  useUpdateCustomerVisit,
  useVisitNotesUpdate,
} from "./use-customers";
import {
  AuthContext,
  type AuthContextValue,
} from "@/providers/auth-context";


const ownerAuth: AuthContextValue = {
  user: {
    email: "owner@example.com",
    role: "owner",
    staffMemberId: null,
    storeId: null,
  },
  isPrivileged: true,
  vapidPublicKey: "",
};

const staffAuth: AuthContextValue = {
  user: {
    email: "staff@example.com",
    role: "staff",
    staffMemberId: "staff-1",
    storeId: "store-1",
  },
  isPrivileged: false,
  vapidPublicKey: "",
};

const createWrapper = (
  client: QueryClient,
  auth: AuthContextValue = ownerAuth,
) =>
  function Wrapper({ children }: PropsWithChildren) {
    return (
      <QueryClientProvider client={client}>
        <AuthContext.Provider value={auth}>{children}</AuthContext.Provider>
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
    name: "顧客メモ更新",
    useHook: useCustomerMemoUpdate,
    method: "put",
    variables: { customerId: "customer-1", memo: null, expectedMemo: "元のメモ" },
    call: ["/api/admin/customers/customer-1/memo", { memo: null, expectedMemo: "元のメモ" }],
    // 顧客メモは予約詳細の「顧客情報」にも出るので reservations も無効化する。
    invalidates: [["customers"], ["reservations"]],
    success: "顧客メモを保存しました",
    error: "顧客メモの保存に失敗しました",
  },
  {
    name: "紹介者更新",
    useHook: useCustomerReferrerUpdate,
    method: "put",
    variables: { customerId: "customer-1", referrerName: "紹介 花子", expectedReferrerName: null },
    call: ["/api/admin/customers/customer-1/referrer", { referrerName: "紹介 花子", expectedReferrerName: null }],
    invalidates: [["customers"]],
    success: "紹介者を保存しました",
    error: "紹介者の保存に失敗しました",
  },
  {
    name: "顧客プロフィール更新",
    useHook: useCustomerProfileUpdate,
    method: "patch",
    variables: {
      customerId: "customer-1",
      displayName: "山田 花子",
      phone: null,
    },
    call: [
      "/api/admin/customers/customer-1/profile",
      { displayName: "山田 花子", phone: null },
    ],
    invalidates: [["customers"], ["reservations"]],
    success: "顧客情報を更新しました",
    error: "顧客情報の更新に失敗しました",
  },
  {
    name: "顧客ブロック",
    useHook: useCustomerBlockAction,
    method: "post",
    variables: { customerId: "customer-1", action: "block" },
    call: [
      "/api/admin/customers/customer-1/block",
      {
        idempotencyKey: "00000000-0000-4000-8000-000000000001",
        reason: "",
      },
    ],
    invalidates: [["customers"]],
    success: "ブロックしました",
    error: "ブロックに失敗しました",
  },
  {
    name: "顧客ブロック解除",
    useHook: useCustomerBlockAction,
    method: "post",
    variables: { customerId: "customer-1", action: "unblock" },
    call: [
      "/api/admin/customers/customer-1/unblock",
      {
        idempotencyKey: "00000000-0000-4000-8000-000000000001",
        reason: "",
      },
    ],
    invalidates: [["customers"]],
    success: "ブロック解除しました",
    error: "ブロック解除に失敗しました",
  },
  {
    name: "顧客統合",
    useHook: useCustomerMerge,
    method: "post",
    variables: { sourceId: "customer-1", targetId: "customer-2" },
    call: [
      "/api/admin/customers/customer-1/merge",
      { targetId: "customer-2" },
    ],
    invalidates: [["customers"]],
    success: "顧客を統合しました",
    error: "顧客の統合に失敗しました",
  },
  {
    name: "施術メモ更新",
    useHook: useVisitNotesUpdate,
    method: "put",
    variables: {
      customerId: "customer-1",
      visitId: "visit-1",
      treatmentNotes: "保湿",
      expectedTreatmentNotes: null,
    },
    call: [
      "/api/admin/customers/customer-1/visits/visit-1/notes",
      { treatmentNotes: "保湿", expectedTreatmentNotes: null },
    ],
    invalidates: [["customers"], ["reservations"]],
    success: "施術メモを保存しました",
    error: "施術メモの保存に失敗しました",
  },
  {
    name: "顧客アーカイブ",
    useHook: useCustomerArchiveAction,
    method: "post",
    variables: { customerId: "customer-1", action: "archive" },
    call: [
      "/api/admin/customers/customer-1/archive",
      { idempotencyKey: "00000000-0000-4000-8000-000000000001" },
    ],
    invalidates: [["customers"]],
    success: "アーカイブしました",
    error: "アーカイブに失敗しました",
  },
  {
    name: "顧客復元",
    useHook: useCustomerArchiveAction,
    method: "post",
    variables: { customerId: "customer-1", action: "unarchive" },
    call: [
      "/api/admin/customers/customer-1/unarchive",
      { idempotencyKey: "00000000-0000-4000-8000-000000000001" },
    ],
    invalidates: [["customers"]],
    success: "復元しました",
    error: "復元に失敗しました",
  },
  {
    name: "顧客完全削除",
    useHook: useCustomerDelete,
    method: "post",
    variables: { customerId: "customer-1" },
    call: ["/api/admin/customers/customer-1/delete", {}],
    invalidates: [["customers"], ["reservations"]],
    success: "顧客を完全に削除しました",
    error: "削除に失敗しました",
  },
  {
    name: "来店履歴追加",
    useHook: useAddCustomerVisit,
    method: "post",
    variables: {
      customerId: "customer-1",
      idempotencyKey: "visit-key",
      visitedAt: "2026-07-20",
      storeId: "store-1",
      treatmentNotes: null,
    },
    call: [
      "/api/admin/customers/customer-1/visits",
      {
        idempotencyKey: "visit-key",
        visitedAt: "2026-07-20",
        storeId: "store-1",
        treatmentNotes: null,
      },
    ],
    invalidates: [["customers"], ["reservations"]],
    success: "来店履歴を追加しました",
    error: "来店履歴の追加に失敗しました",
  },
  {
    name: "来店日更新",
    useHook: useUpdateCustomerVisit,
    method: "patch",
    variables: {
      customerId: "customer-1",
      visitId: "visit-1",
      idempotencyKey: "visit-key",
      visitedAt: "2026-07-21",
    },
    call: [
      "/api/admin/customers/customer-1/visits/visit-1",
      { idempotencyKey: "visit-key", visitedAt: "2026-07-21" },
    ],
    invalidates: [["customers"], ["reservations"]],
    success: "来店日を更新しました",
    error: "来店日の更新に失敗しました",
  },
  {
    name: "来店履歴削除",
    useHook: useDeleteCustomerVisit,
    method: "delete",
    variables: { customerId: "customer-1", visitId: "visit-1" },
    call: ["/api/admin/customers/customer-1/visits/visit-1"],
    invalidates: [["customers"], ["reservations"]],
    success: "来店履歴を削除しました",
    error: "来店履歴の削除に失敗しました",
  },
  {
    name: "顧客手動追加",
    useHook: useCreateCustomer,
    method: "post",
    variables: {
      idempotencyKey: "customer-key",
      displayName: "山田 花子",
      displayNameKana: null,
      phone: null,
    },
    call: [
      "/api/admin/customers",
      {
        idempotencyKey: "customer-key",
        displayName: "山田 花子",
        displayNameKana: null,
        phone: null,
      },
    ],
    invalidates: [["customers"]],
    success: "顧客を追加しました",
    error: "顧客の追加に失敗しました",
  },
] as const;

describe("customer queries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses the complete list key and URL, including archived and encoded store filters", async () => {
    const response = { customers: [], total: 0 };
    mocks.api.get.mockResolvedValue(response);
    const client = createClient();
    const storeId = "store/東京";

    const { result } = renderHook(
      () => useCustomerList(20, true, storeId),
      { wrapper: createWrapper(client) },
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toBe(response);
    expect(mocks.api.get).toHaveBeenCalledWith(
      "/api/admin/customers?mode=list&offset=20&view=archived&store=store%2F%E6%9D%B1%E4%BA%AC",
    );
    expect(
      client.getQueryCache().find({
        queryKey: ["customers", "list", 20, true, storeId],
        exact: true,
      }),
    ).toBeDefined();
  });

  it("omits optional list and search filters when they are not selected", async () => {
    mocks.api.get
      .mockResolvedValueOnce({ customers: [], total: 0 })
      .mockResolvedValueOnce({ ok: true, customers: [] });
    const listClient = createClient();
    const searchClient = createClient();

    const list = renderHook(
      () => useCustomerList(0, false, null),
      { wrapper: createWrapper(listClient) },
    );
    const search = renderHook(
      () => useCustomerSearch("ab", null),
      { wrapper: createWrapper(searchClient) },
    );

    await waitFor(() => expect(list.result.current.isSuccess).toBe(true));
    await waitFor(() =>
      expect(search.result.current.isSuccess).toBe(true),
    );
    expect(mocks.api.get.mock.calls).toEqual([
      ["/api/admin/customers?mode=list&offset=0"],
      ["/api/admin/customers?q=ab"],
    ]);
    expect(
      listClient.getQueryCache().find({
        queryKey: ["customers", "list", 0, false, null],
        exact: true,
      }),
    ).toBeDefined();
    expect(
      searchClient.getQueryCache().find({
        queryKey: ["customers", "search", "ab", null],
        exact: true,
      }),
    ).toBeDefined();
  });

  it("keeps a previous page only when store and archived filters stay unchanged", async () => {
    const first = { customers: [], total: 7 };
    const pending = new Promise<never>(() => undefined);
    mocks.api.get
      .mockResolvedValueOnce(first)
      .mockImplementation(() => pending);
    const client = createClient();

    const { result, rerender } = renderHook(
      ({ offset, storeId }: { offset: number; storeId: string }) =>
        useCustomerList(offset, false, storeId),
      {
        initialProps: { offset: 0, storeId: "store-1" },
        wrapper: createWrapper(client),
      },
    );
    await waitFor(() => expect(result.current.data).toBe(first));

    rerender({ offset: 20, storeId: "store-1" });
    await waitFor(() => expect(result.current.isPlaceholderData).toBe(true));
    expect(result.current.data).toBe(first);

    rerender({ offset: 20, storeId: "store-2" });
    await waitFor(() => expect(result.current.data).toBeUndefined());
    expect(result.current.isPlaceholderData).toBe(false);
  });

  it("gates short searches and encodes the active query and store in key and URL", async () => {
    const disabledClient = createClient();
    renderHook(() => useCustomerSearch("a"), {
      wrapper: createWrapper(disabledClient),
    });
    expect(mocks.api.get).not.toHaveBeenCalled();
    expect(
      disabledClient.getQueryState(["customers", "search", "a", null])
        ?.fetchStatus,
    ).toBe("idle");

    const response = { ok: true, customers: [] };
    mocks.api.get.mockResolvedValue(response);
    const client = createClient();
    const { result } = renderHook(
      () => useCustomerSearch("山 田", "store/1"),
      { wrapper: createWrapper(client) },
    );
    await waitFor(() => expect(result.current.data).toBe(response));
    expect(mocks.api.get).toHaveBeenCalledWith(
      "/api/admin/customers?q=%E5%B1%B1%20%E7%94%B0&store=store%2F1",
    );
    expect(
      client.getQueryCache().find({
        queryKey: ["customers", "search", "山 田", "store/1"],
        exact: true,
      }),
    ).toBeDefined();
  });

  it("fetches merge candidates only for privileged users", async () => {
    const staffClient = createClient();
    renderHook(() => useMergeCandidates(), {
      wrapper: createWrapper(staffClient, staffAuth),
    });
    expect(mocks.api.get).not.toHaveBeenCalled();
    expect(
      staffClient.getQueryState(["customers", "merge-candidates"])
        ?.fetchStatus,
    ).toBe("idle");

    const response = { ok: true, groups: [], truncated: false };
    mocks.api.get.mockResolvedValue(response);
    const ownerClient = createClient();
    const { result } = renderHook(() => useMergeCandidates(), {
      wrapper: createWrapper(ownerClient),
    });
    await waitFor(() => expect(result.current.data).toBe(response));
    expect(mocks.api.get).toHaveBeenCalledWith(
      "/api/admin/customers/merge-candidates",
    );
    expect(
      ownerClient.getQueryCache().find({
        queryKey: ["customers", "merge-candidates"],
        exact: true,
      }),
    ).toBeDefined();
  });

  it("gates null customer detail and fetches an identified customer", async () => {
    const disabledClient = createClient();
    renderHook(() => useCustomerDetail(null), {
      wrapper: createWrapper(disabledClient),
    });
    expect(mocks.api.get).not.toHaveBeenCalled();
    expect(
      disabledClient.getQueryState(["customers", "detail", null])
        ?.fetchStatus,
    ).toBe("idle");

    const response = { ok: true, customer: { id: "customer-1" } };
    mocks.api.get.mockResolvedValue(response);
    const client = createClient();
    const { result } = renderHook(
      () => useCustomerDetail("customer-1"),
      { wrapper: createWrapper(client) },
    );
    await waitFor(() => expect(result.current.data).toBe(response));
    expect(mocks.api.get).toHaveBeenCalledWith(
      "/api/admin/customers/customer-1",
    );
    expect(
      client.getQueryCache().find({
        queryKey: ["customers", "detail", "customer-1"],
        exact: true,
      }),
    ).toBeDefined();
  });
});

describe("customer mutations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue(
      "00000000-0000-4000-8000-000000000001",
    );
  });

  it.each(mutationCases)(
    "$name sends the exact request and invalidates the required caches",
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
    "$name reports the configured error without invalidating success caches",
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


it("予約の追加ページは顧客とoffsetを保持して同じ管理APIから取得する", async () => {
  mocks.api.get.mockReset();
  mocks.api.get.mockResolvedValue({ ok: true, reservations: [], nextOffset: null });
  const { result } = renderHook(() => useCustomerReservationsPage(), { wrapper: createWrapper(createClient()) });
  await act(async () => { await result.current.mutateAsync({ customerId: "customer-1", offset: 50 }); });
  expect(mocks.api.get).toHaveBeenCalledWith("/api/admin/customers/customer-1/reservations?offset=50");
  await waitFor(() => expect(result.current.data).toEqual({ ok: true, reservations: [], nextOffset: null }));
});
