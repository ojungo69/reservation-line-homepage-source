import { act, renderHook, waitFor } from "@testing-library/react";
import type { QueryClient } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestQueryClient as createClient, createQueryWrapper as createWrapper } from "@/test-utils/query-client";
import { mocks } from "@/test-utils/hook-mocks";
import {
  useAvailableSlots,
  useCreateReservation,
  usePendingReservations,
  useReservationAction,
  useReservationCancellationFee,
  useReservationDetail,
  useReservations,
  useRescheduleReservation,
  useUpdateTreatmentNotes,
} from "./use-reservations";
import { ApiError } from "@/lib/api-client";
import {
  endBulkApprove,
  tryBeginBulkApprove,
} from "@/lib/reservation-action-lock";
import { RESERVATION_ACTION_MUTATION_KEY } from "@/lib/pending-mutation-ids";


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

const baseCreatePayload = {
  idempotencyKey: "create-key",
  storeId: "store-1",
  serviceIds: ["service-1"],
  serviceId: "service-1",
  resourceId: "resource-1",
  startAt: "2026-07-30T01:00:00.000Z",
  origin: "walk_in" as const,
  customerId: "customer-1",
};

const mutationCases = [
  {
    name: "キャンセル料を未納にする",
    useHook: useReservationCancellationFee,
    method: "put",
    variables: { reservationId: "reservation-1", unpaid: true },
    call: [
      "/api/admin/reservations/reservation-1/cancellation-fee",
      { unpaid: true },
    ],
    invalidates: [["reservations"]],
    success: "キャンセル料未納にしました",
    error: "キャンセル料の更新に失敗しました",
  },
  {
    name: "キャンセル料を入金済みにする",
    useHook: useReservationCancellationFee,
    method: "put",
    variables: { reservationId: "reservation-1", unpaid: false },
    call: [
      "/api/admin/reservations/reservation-1/cancellation-fee",
      { unpaid: false },
    ],
    invalidates: [["reservations"]],
    success: "入金済みにしました",
    error: "キャンセル料の更新に失敗しました",
  },
  {
    name: "施術メモを更新する",
    useHook: useUpdateTreatmentNotes,
    method: "put",
    variables: {
      customerId: "customer-1",
      visitId: "visit-1",
      treatmentNotes: null,
      expectedTreatmentNotes: " 以前の施術メモ ",
    },
    call: [
      "/api/admin/customers/customer-1/visits/visit-1/notes",
      { treatmentNotes: null, expectedTreatmentNotes: " 以前の施術メモ " },
    ],
    invalidates: [["reservations"], ["customers"]],
    success: "施術メモを保存しました",
    error: "施術メモの保存に失敗しました",
  },
  {
    name: "予約を作成する",
    useHook: useCreateReservation,
    method: "post",
    variables: baseCreatePayload,
    call: [
      "/api/admin/reservations",
      { source: "phone_admin", ...baseCreatePayload },
    ],
    invalidates: [["reservations"]],
    success: "予約を作成しました",
    error: "予約作成に失敗しました",
  },
  {
    name: "予約時間を変更する",
    useHook: useRescheduleReservation,
    method: "post",
    variables: {
      reservationId: "reservation-1",
      startAt: "2026-07-30T02:00:00.000Z",
      idempotencyKey: "reschedule-key",
    },
    call: [
      "/api/admin/reservations/reservation-1/reschedule",
      {
        idempotencyKey: "reschedule-key",
        startAt: "2026-07-30T02:00:00.000Z",
      },
    ],
    invalidates: [["reservations"]],
    success: "予約時間を変更しました",
    error: "変更に失敗しました",
  },
  {
    name: "施術時間を変更する",
    useHook: useRescheduleReservation,
    method: "post",
    variables: {
      reservationId: "reservation-1",
      startAt: "2026-07-30T02:00:00.000Z",
      idempotencyKey: "reschedule-key",
      treatmentMinutes: 45,
    },
    call: [
      "/api/admin/reservations/reservation-1/reschedule",
      {
        idempotencyKey: "reschedule-key",
        startAt: "2026-07-30T02:00:00.000Z",
        treatmentMinutes: 45,
      },
    ],
    invalidates: [["reservations"]],
    success: "施術時間を変更しました",
    error: "変更に失敗しました",
  },
] as const;

describe("reservation queries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("keys the daily reservation request only by date and requests the all-store range", async () => {
    const response = {
      ok: true,
      range: "date",
      startAt: "2026-07-24T00:00:00+09:00",
      endAt: "2026-07-25T00:00:00+09:00",
      reservations: [],
    };
    mocks.api.get.mockResolvedValue(response);
    const client = createClient();

    const { result } = renderHook(
      () => useReservations("2026-07-24"),
      { wrapper: createWrapper(client) },
    );

    await waitFor(() => expect(result.current.data).toBe(response));
    expect(mocks.api.get).toHaveBeenCalledWith(
      "/api/admin/reservations?range=date&date=2026-07-24",
    );
    expect(
      client.getQueryCache().find({
        queryKey: ["reservations", "2026-07-24"],
        exact: true,
      }),
    ).toBeDefined();
  });

  it("polls the pending reservation inbox every 30 seconds", async () => {
    const response = { ok: true, reservations: [] };
    mocks.api.get.mockResolvedValue(response);
    const client = createClient();

    // ポーリング間隔は内部 options を覗かず、実際に再取得が走ることで確認する。
    // refetchInterval のタイマーは mount 時に張られるので、renderHook より前に
    // fake timer へ切り替える必要がある。shouldAdvanceTime で waitFor も進む。
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { result } = renderHook(() => usePendingReservations(), {
        wrapper: createWrapper(client),
      });

      await waitFor(() => expect(result.current.data).toBe(response));
      expect(mocks.api.get).toHaveBeenCalledWith(
        "/api/admin/reservations/pending",
      );
      expect(
        client.getQueryCache().find({
          queryKey: ["reservations", "pending"],
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

  it("does not request reservation detail without an id", async () => {
    const client = createClient();
    renderHook(() => useReservationDetail(null), {
      wrapper: createWrapper(client),
    });

    expect(mocks.api.get).not.toHaveBeenCalled();
    expect(
      client.getQueryState(["reservations", "detail", null])?.fetchStatus,
    ).toBe("idle");
  });

  it("uses the reservation id in the detail key and URL", async () => {
    const response = { ok: true, reservation: { id: "reservation-1" } };
    mocks.api.get.mockResolvedValue(response);
    const client = createClient();

    const { result } = renderHook(
      () => useReservationDetail("reservation-1"),
      { wrapper: createWrapper(client) },
    );

    await waitFor(() => expect(result.current.data).toBe(response));
    expect(mocks.api.get).toHaveBeenCalledWith(
      "/api/admin/reservations/reservation-1",
    );
    expect(
      client.getQueryCache().find({
        queryKey: ["reservations", "detail", "reservation-1"],
        exact: true,
      }),
    ).toBeDefined();
  });

  it("gates available slots until both store and date are present", () => {
    const client = createClient();
    renderHook(() => useAvailableSlots(null, "2026-07-30"), {
      wrapper: createWrapper(client),
    });

    expect(mocks.api.get).not.toHaveBeenCalled();
    expect(
      client.getQueryState([
        "reservations",
        "available-slots",
        null,
        "2026-07-30",
        null,
        null,
        null,
        null,
      ])?.fetchStatus,
    ).toBe("idle");

    const missingDateClient = createClient();
    renderHook(() => useAvailableSlots("store-1", null), {
      wrapper: createWrapper(missingDateClient),
    });
    expect(mocks.api.get).not.toHaveBeenCalled();
    expect(
      missingDateClient.getQueryState([
        "reservations",
        "available-slots",
        "store-1",
        null,
        null,
        null,
        null,
        null,
      ])?.fetchStatus,
    ).toBe("idle");
  });

  it("builds the available-slot key and URL from the same normalized create options", async () => {
    const response = { ok: true, slots: [] };
    mocks.api.get.mockResolvedValue(response);
    const client = createClient();

    const { result } = renderHook(
      () =>
        useAvailableSlots("store/1", "2026-07-30", {
          durationMinutes: 50,
          resourceId: "resource/1",
          customerId: "customer 1",
        }),
      { wrapper: createWrapper(client) },
    );

    await waitFor(() => expect(result.current.data).toBe(response));
    expect(mocks.api.get).toHaveBeenCalledWith(
      "/api/admin/reservations/available-slots?storeId=store%2F1&date=2026-07-30&durationMinutes=50&resourceId=resource%2F1&customerId=customer+1",
    );
    expect(
      client.getQueryCache().find({
        queryKey: [
          "reservations",
          "available-slots",
          "store/1",
          "2026-07-30",
          50,
          "resource/1",
          null,
          "customer 1",
        ],
        exact: true,
      }),
    ).toBeDefined();
  });

  it("uses only the reservation exclusion in reschedule slot mode", async () => {
    mocks.api.get.mockResolvedValue({ ok: true, slots: [] });
    const client = createClient();

    const { result } = renderHook(
      () =>
        useAvailableSlots("store-1", "2026-07-30", {
          excludeReservationId: "reservation/1",
        }),
      { wrapper: createWrapper(client) },
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mocks.api.get).toHaveBeenCalledWith(
      "/api/admin/reservations/available-slots?storeId=store-1&date=2026-07-30&excludeReservationId=reservation%2F1",
    );
    expect(
      client.getQueryCache().find({
        queryKey: [
          "reservations",
          "available-slots",
          "store-1",
          "2026-07-30",
          null,
          null,
          "reservation/1",
          null,
        ],
        exact: true,
      }),
    ).toBeDefined();
  });
});

describe("reservation action mutation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue(
      "00000000-0000-4000-8000-000000000002",
    );
    endBulkApprove();
  });

  it("uses the action mutation key, sends the exact request, and invalidates reservations", async () => {
    mocks.api.post.mockResolvedValue({ ok: true });
    const client = createClient();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    const { result } = renderMutation(useReservationAction, client);

    await act(async () => {
      await result.current.mutateAsync({
        reservationId: "reservation-1",
        action: "reject",
      });
    });

    expect(mocks.api.post).toHaveBeenCalledWith(
      "/api/admin/reservations/reservation-1/reject",
      {
        idempotencyKey: "00000000-0000-4000-8000-000000000002",
        reason: "",
      },
    );
    expect(
      client.getMutationCache().getAll()[0]?.options.mutationKey,
    ).toEqual(RESERVATION_ACTION_MUTATION_KEY);
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: ["reservations"],
    });
    expect(mocks.toast.success).toHaveBeenCalledWith(
      "操作を実行しました",
    );
  });

  it("sends expectedVersion when the caller supplies it (corrections require it)", async () => {
    mocks.api.post.mockResolvedValueOnce({ ok: true });
    const client = createClient();
    const { result } = renderMutation(useReservationAction, client);

    await act(async () => {
      await result.current.mutateAsync({
        reservationId: "reservation-1",
        action: "correct-no-show",
        expectedVersion: 7,
      });
    });

    expect(mocks.api.post).toHaveBeenCalledWith(
      "/api/admin/reservations/reservation-1/correct-no-show",
      expect.objectContaining({ expectedVersion: 7 }),
    );
  });

  it("omits expectedVersion entirely when not supplied", async () => {
    mocks.api.post.mockResolvedValueOnce({ ok: true });
    const client = createClient();
    const { result } = renderMutation(useReservationAction, client);

    await act(async () => {
      await result.current.mutateAsync({
        reservationId: "reservation-1",
        action: "approve",
      });
    });

    const [, body] = mocks.api.post.mock.calls.at(-1) as [string, Record<string, unknown>];
    expect("expectedVersion" in body).toBe(false);
  });

  it("refetches reservations and customers even when the request fails (409 lands in onError)", async () => {
    const conflict = new ApiError(409, { reason: "stale_snapshot" });
    mocks.api.post.mockRejectedValueOnce(conflict);
    const client = createClient();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    const { result } = renderMutation(useReservationAction, client);

    await act(async () => {
      await expect(
        result.current.mutateAsync({
          reservationId: "reservation-1",
          action: "correct-no-show",
          expectedVersion: 1,
        }),
      ).rejects.toBe(conflict);
    });

    // 競合しても最新の version を取り直せないと、再操作もまた 409 になる。
    await waitFor(() => {
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ["reservations"] });
    });
    // 訂正は customer_visits を動かすので顧客側のキャッシュも落とす。
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["customers"] });
  });

  it("releases the per-reservation lock after a request error", async () => {
    const error = new Error("network");
    mocks.api.post
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce({ ok: true });
    const client = createClient();
    const { result } = renderMutation(useReservationAction, client);

    await act(async () => {
      await expect(
        result.current.mutateAsync({
          reservationId: "reservation-1",
          action: "approve",
          reason: "確認済み",
        }),
      ).rejects.toBe(error);
    });
    expect(mocks.showErrorToast).toHaveBeenCalledWith(error);

    await act(async () => {
      await result.current.mutateAsync({
        reservationId: "reservation-1",
        action: "approve",
        reason: "再試行",
      });
    });
    expect(mocks.api.post).toHaveBeenCalledTimes(2);
  });

  it("rejects a single action locally while bulk approval is running", async () => {
    expect(tryBeginBulkApprove()).toBe(true);
    const client = createClient();
    const { result } = renderMutation(useReservationAction, client);

    let received: unknown;
    try {
      await act(async () => {
        await result.current
          .mutateAsync({
            reservationId: "reservation-1",
            action: "approve",
          })
          .catch((error: unknown) => {
            received = error;
          });
      });
    } finally {
      endBulkApprove();
    }

    expect(received).toBeInstanceOf(ApiError);
    expect(received).toMatchObject({
      status: 409,
      body: { reason: "bulk_in_progress" },
    });
    expect(mocks.api.post).not.toHaveBeenCalled();
    expect(mocks.showErrorToast).toHaveBeenCalledWith(received);
  });
});

describe("other reservation mutations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each(mutationCases)(
    "$name sends the exact request and runs its success effects",
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
    "$name reports its configured error and skips success effects",
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
