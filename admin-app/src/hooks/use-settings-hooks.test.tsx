import type { PropsWithChildren } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  useBookingWindows,
  useBookingWindowUpdate,
} from "./use-booking-window";
import {
  useBusinessHours,
  useBusinessHoursUpdate,
} from "./use-business-hours";
import {
  useClosureCreate,
  useClosureDelete,
  useClosureList,
  useClosureUpdate,
} from "./use-closures";
import {
  useCustomerNotices,
  useCustomerNoticeUpdate,
} from "./use-customer-notice";
import { useLineQuota } from "./use-line-quota";
import {
  useRecurringCommit,
  useRecurringPreview,
} from "./use-recurring-blocks";
import {
  useReminderOffsets,
  useReminderUpdate,
} from "./use-reminder";
import {
  useReservationCaps,
  useReservationCapUpdate,
} from "./use-reservation-cap";
import {
  useResourceCreate,
  useResourceDelete,
  useResourceList,
  useResourceUpdate,
} from "./use-resources";
import {
  useServiceCreate,
  useServiceDelete,
  useServiceList,
  useServiceUpdate,
} from "./use-services";
import { useSettings } from "./use-settings";
import {
  useStaffCreate,
  useStaffDelete,
  useStaffList,
  useStaffUpdate,
} from "./use-staff";
import { useStores } from "./use-stores";
import {
  AuthContext,
  type AuthContextValue,
} from "@/providers/auth-context";
import {
  StoreContext,
  type StoreSelectionValue,
} from "@/providers/store-context";
import {
  BOOKING_WINDOW_MUTATION_KEY,
  CUSTOMER_NOTICE_MUTATION_KEY,
  RESERVATION_CAP_MUTATION_KEY,
} from "@/lib/pending-mutation-ids";

const mocks = vi.hoisted(() => ({
  api: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
  toast: {
    success: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
  },
  showErrorToast: vi.fn(),
}));

vi.mock("@/lib/api-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api-client")>();
  return { ...actual, api: mocks.api };
});

vi.mock("sonner", () => ({ toast: mocks.toast }));
vi.mock("@/lib/error-messages", () => ({
  showErrorToast: mocks.showErrorToast,
}));

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

const selection: StoreSelectionValue = {
  selectedStoreId: "store-2",
  selectStore: vi.fn(),
};

const createClient = () =>
  new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

const createWrapper = (
  client: QueryClient,
  auth: AuthContextValue = ownerAuth,
  storeSelection: StoreSelectionValue | null = selection,
) =>
  function Wrapper({ children }: PropsWithChildren) {
    const content = storeSelection ? (
      <StoreContext.Provider value={storeSelection}>
        {children}
      </StoreContext.Provider>
    ) : (
      children
    );
    return (
      <QueryClientProvider client={client}>
        <AuthContext.Provider value={auth}>{content}</AuthContext.Provider>
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

const store1 = {
  id: "store-1",
  name: "銀座店",
  timezone: "Asia/Tokyo",
  googleCalendarId: null,
  googleControlledEditMode: false,
  maxActiveReservationsPerCustomer: 3,
  bookingWindowDays: 30,
  customerNotice: "ご来店をお待ちしています",
};

const store2 = {
  ...store1,
  id: "store-2",
  name: "新宿店",
  maxActiveReservationsPerCustomer: 2,
  bookingWindowDays: 14,
  customerNotice: null,
};

const service1 = {
  id: "service-1",
  storeId: "store-1",
  name: "全身",
  durationMinutes: 50,
  priceLabel: "¥10,000",
  priceAmount: 10_000,
  comboPriceAmount: null,
  comboWithPrefix: null,
  active: true,
};

const service2 = {
  ...service1,
  id: "service-2",
  storeId: "store-2",
  name: "顔",
};

const resource1 = {
  id: "resource-1",
  storeId: "store-1",
  name: "施術室1",
  resourceType: "staff_calendar",
  active: true,
};

const resource2 = {
  ...resource1,
  id: "resource-2",
  storeId: "store-2",
  name: "施術室2",
};

const closure1 = {
  id: "closure-1",
  storeId: "store-1",
  startsAt: "2026-08-01T00:00:00+09:00",
  endsAt: "2026-08-02T00:00:00+09:00",
  reason: "夏季休業",
  source: "admin" as const,
};

const closure2 = {
  ...closure1,
  id: "closure-2",
  storeId: "store-2",
  reason: null,
};

const staff1 = {
  id: "staff-1",
  storeId: "store-1",
  displayName: "山田",
  role: "staff",
  active: true,
  version: 1,
};

const staff2 = {
  ...staff1,
  id: "staff-2",
  storeId: "store-2",
  displayName: "佐藤",
};

const settingsResponse = {
  ok: true as const,
  settings: {
    stores: [store1, store2],
    resources: [resource1, resource2],
    services: [service1, service2],
    businessHours: [],
    closures: [closure1, closure2],
    staff: [staff1, staff2],
    reminderOffsets: [
      { storeId: "store-1", offsetMinutes: 60 },
      { storeId: "store-2", offsetMinutes: null },
    ],
  },
};

const mutationCases = [
  {
    name: "service create",
    useHook: useServiceCreate,
    method: "post",
    variables: {
      storeId: "store-1",
      name: "新メニュー",
      durationMinutes: 45,
      bufferBeforeMinutes: 0,
      bufferAfterMinutes: 5,
      priceLabel: null,
      priceAmount: null,
      comboPriceAmount: null,
      comboWithPrefix: null,
      active: true,
      idempotencyKey: "service-key",
    },
    call: [
      "/api/admin/settings/services",
      {
        storeId: "store-1",
        name: "新メニュー",
        durationMinutes: 45,
        bufferBeforeMinutes: 0,
        bufferAfterMinutes: 5,
        priceLabel: null,
        priceAmount: null,
        comboPriceAmount: null,
        comboWithPrefix: null,
        active: true,
        idempotencyKey: "service-key",
      },
    ],
    invalidates: [["settings"]],
    success: "メニューを追加しました",
    error: "メニューの追加に失敗しました",
  },
  {
    name: "service update",
    useHook: useServiceUpdate,
    method: "put",
    variables: {
      id: "service-1",
      storeId: "store-1",
      name: "更新メニュー",
      durationMinutes: 50,
      bufferBeforeMinutes: 0,
      bufferAfterMinutes: 0,
      priceLabel: "¥12,000",
      priceAmount: 12_000,
      comboPriceAmount: null,
      comboWithPrefix: null,
      active: true,
    },
    call: [
      "/api/admin/settings/services/service-1",
      {
        storeId: "store-1",
        name: "更新メニュー",
        durationMinutes: 50,
        bufferBeforeMinutes: 0,
        bufferAfterMinutes: 0,
        priceLabel: "¥12,000",
        priceAmount: 12_000,
        comboPriceAmount: null,
        comboWithPrefix: null,
        active: true,
      },
    ],
    invalidates: [["settings"]],
    success: "メニューを更新しました",
    error: "メニューの更新に失敗しました",
  },
  {
    name: "service delete",
    useHook: useServiceDelete,
    method: "delete",
    variables: "service-1",
    call: ["/api/admin/settings/services/service-1"],
    invalidates: [["settings"]],
    success: "メニューを削除しました",
    error: "メニューの削除に失敗しました",
  },
  {
    name: "closure create",
    useHook: useClosureCreate,
    method: "post",
    variables: {
      storeId: "store-1",
      startsAt: "2026-08-01T00:00:00+09:00",
      endsAt: "2026-08-02T00:00:00+09:00",
      reason: null,
      idempotencyKey: "closure-key",
    },
    call: [
      "/api/admin/settings/closures",
      {
        storeId: "store-1",
        startsAt: "2026-08-01T00:00:00+09:00",
        endsAt: "2026-08-02T00:00:00+09:00",
        reason: null,
        idempotencyKey: "closure-key",
      },
    ],
    invalidates: [["settings"]],
    success: "休業日を追加しました",
    error: "休業日の追加に失敗しました",
  },
  {
    name: "closure update",
    useHook: useClosureUpdate,
    method: "put",
    variables: {
      id: "closure-1",
      storeId: "store-1",
      startsAt: "2026-08-03T00:00:00+09:00",
      endsAt: "2026-08-04T00:00:00+09:00",
      reason: "臨時休業",
    },
    call: [
      "/api/admin/settings/closures/closure-1",
      {
        storeId: "store-1",
        startsAt: "2026-08-03T00:00:00+09:00",
        endsAt: "2026-08-04T00:00:00+09:00",
        reason: "臨時休業",
      },
    ],
    invalidates: [["settings"]],
    success: "休業日を更新しました",
    error: "休業日の更新に失敗しました",
  },
  {
    name: "closure delete",
    useHook: useClosureDelete,
    method: "delete",
    variables: "closure-1",
    call: ["/api/admin/settings/closures/closure-1"],
    invalidates: [["settings"]],
    success: "休業日を削除しました",
    error: "休業日の削除に失敗しました",
    // 削除失敗時もサーバの現状を取り直す (削除は成立したが応答が失われた
    // 404 再試行や、別端末で先に消えていた stale 表示を解消するため)。
    invalidatesOnError: true,
  },
  {
    name: "resource create",
    useHook: useResourceCreate,
    method: "post",
    variables: {
      storeId: "store-1",
      name: "施術室3",
      resourceType: "staff_calendar",
      active: true,
      idempotencyKey: "resource-key",
    },
    call: [
      "/api/admin/settings/resources",
      {
        storeId: "store-1",
        name: "施術室3",
        resourceType: "staff_calendar",
        active: true,
        idempotencyKey: "resource-key",
      },
    ],
    invalidates: [["settings"]],
    success: "リソースを追加しました",
    error: "リソースの追加に失敗しました",
  },
  {
    name: "resource update",
    useHook: useResourceUpdate,
    method: "put",
    variables: {
      id: "resource-1",
      storeId: "store-1",
      name: "施術室A",
      resourceType: "staff_calendar",
      active: false,
    },
    call: [
      "/api/admin/settings/resources/resource-1",
      {
        storeId: "store-1",
        name: "施術室A",
        resourceType: "staff_calendar",
        active: false,
      },
    ],
    invalidates: [["settings"]],
    success: "リソースを更新しました",
    error: "リソースの更新に失敗しました",
  },
  {
    name: "resource delete",
    useHook: useResourceDelete,
    method: "delete",
    variables: "resource-1",
    call: ["/api/admin/settings/resources/resource-1"],
    invalidates: [["settings"]],
    success: "リソースを削除しました",
    error: "リソースの削除に失敗しました",
  },
  {
    name: "staff create",
    useHook: useStaffCreate,
    method: "post",
    variables: {
      storeId: "store-1",
      displayName: "田中",
      role: "staff",
      active: true,
      idempotencyKey: "staff-key",
    },
    call: [
      "/api/admin/settings/staff",
      {
        storeId: "store-1",
        displayName: "田中",
        role: "staff",
        active: true,
        idempotencyKey: "staff-key",
      },
    ],
    invalidates: [["settings"]],
    success: "スタッフを追加しました",
    error: "スタッフの追加に失敗しました",
  },
  {
    name: "staff update",
    useHook: useStaffUpdate,
    method: "put",
    variables: {
      id: "staff-1",
      storeId: "store-1",
      displayName: "山田 更新",
      role: "staff",
      active: true,
      expectedVersion: 2,
    },
    call: [
      "/api/admin/settings/staff/staff-1",
      {
        storeId: "store-1",
        displayName: "山田 更新",
        role: "staff",
        active: true,
        expectedVersion: 2,
      },
    ],
    invalidates: [["settings"]],
    success: "スタッフを更新しました",
    error: "スタッフの更新に失敗しました",
  },
  {
    name: "staff delete",
    useHook: useStaffDelete,
    method: "delete",
    variables: "staff-1",
    call: ["/api/admin/settings/staff/staff-1"],
    invalidates: [["settings"]],
    success: "スタッフを無効化しました",
    error: "スタッフの無効化に失敗しました",
  },
  {
    name: "booking window update",
    useHook: useBookingWindowUpdate,
    method: "put",
    variables: { storeId: "store-1", bookingWindowDays: 45 },
    call: [
      "/api/admin/settings/booking-window",
      { storeId: "store-1", bookingWindowDays: 45 },
    ],
    invalidates: [["settings"]],
    mutationKey: BOOKING_WINDOW_MUTATION_KEY,
    success: "予約受付期間を更新しました",
    error: "予約受付期間の更新に失敗しました",
  },
  {
    name: "customer notice update",
    useHook: useCustomerNoticeUpdate,
    method: "put",
    variables: { storeId: "store-1", customerNotice: null },
    call: [
      "/api/admin/settings/customer-notice",
      { storeId: "store-1", customerNotice: null },
    ],
    invalidates: [["settings"]],
    mutationKey: CUSTOMER_NOTICE_MUTATION_KEY,
    success: "お知らせを更新しました",
    error: "お知らせの更新に失敗しました",
  },
  {
    name: "reminder update",
    useHook: useReminderUpdate,
    method: "put",
    variables: { storeId: "store-1", offsetMinutes: 120 },
    call: [
      "/api/admin/settings/reminder",
      { storeId: "store-1", offsetMinutes: 120 },
    ],
    invalidates: [["settings"]],
    success: "リマインダー設定を更新しました",
    error: "リマインダー設定の更新に失敗しました",
  },
  {
    name: "reservation cap update",
    useHook: useReservationCapUpdate,
    method: "put",
    variables: {
      storeId: "store-1",
      maxActiveReservationsPerCustomer: 4,
    },
    call: [
      "/api/admin/settings/reservation-cap",
      {
        storeId: "store-1",
        maxActiveReservationsPerCustomer: 4,
      },
    ],
    invalidates: [["settings"]],
    mutationKey: RESERVATION_CAP_MUTATION_KEY,
    success: "1人あたりの予約上限を更新しました",
    error: "予約上限の更新に失敗しました",
  },
  {
    name: "business hours update",
    useHook: useBusinessHoursUpdate,
    method: "put",
    variables: {
      storeId: "store-1",
      hours: [
        {
          weekday: 1,
          opensAt: "10:00",
          closesAt: "19:00",
          closed: false,
        },
      ],
    },
    call: [
      "/api/admin/settings/business-hours/store-1",
      {
        hours: [
          {
            weekday: 1,
            opensAt: "10:00",
            closesAt: "19:00",
            closed: false,
          },
        ],
      },
    ],
    invalidates: [
      ["business-hours", "store-1"],
      ["settings"],
    ],
    success: "営業時間を更新しました",
    error: "営業時間の更新に失敗しました",
  },
  {
    name: "recurring preview",
    useHook: useRecurringPreview,
    method: "post",
    variables: {
      storeId: "store-1",
      resourceId: "resource-1",
      rrule: "FREQ=WEEKLY;BYDAY=MO",
      dtstart: "2026-08-03T10:00:00+09:00",
      windowEnd: "2026-08-31",
      durationMinutes: 60,
    },
    call: [
      "/api/admin/recurring/preview",
      {
        storeId: "store-1",
        resourceId: "resource-1",
        rrule: "FREQ=WEEKLY;BYDAY=MO",
        dtstart: "2026-08-03T10:00:00+09:00",
        windowEnd: "2026-08-31",
        durationMinutes: 60,
      },
    ],
    invalidates: [],
    response: {
      ok: true,
      occurrences: ["2026-08-03T10:00:00+09:00"],
      truncatedByWindow: false,
      truncatedByCap: false,
      windowCapped: false,
    },
    error: "プレビューの取得に失敗しました",
  },
  {
    name: "recurring commit",
    useHook: useRecurringCommit,
    method: "post",
    variables: {
      idempotencyKey: "recurring-key",
      storeId: "store-1",
      resourceId: "resource-1",
      rrule: "FREQ=WEEKLY;BYDAY=MO",
      dtstart: "2026-08-03T10:00:00+09:00",
      windowEnd: "2026-08-31",
      durationMinutes: 60,
      title: "定休日",
    },
    call: [
      "/api/admin/recurring/commit",
      {
        idempotencyKey: "recurring-key",
        storeId: "store-1",
        resourceId: "resource-1",
        rrule: "FREQ=WEEKLY;BYDAY=MO",
        dtstart: "2026-08-03T10:00:00+09:00",
        windowEnd: "2026-08-31",
        durationMinutes: 60,
        title: "定休日",
      },
    ],
    invalidates: [["external-blocks"], ["reservations"]],
    response: {
      ok: true,
      createdCount: 4,
      replayedCount: 0,
      skippedPastCount: 0,
      failedCount: 0,
    },
    success: "4件のブロックを作成しました",
    error: "ブロックの作成に失敗しました",
  },
] as const;

describe("shared settings queries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shares one settings request and derives each settings view through select", async () => {
    mocks.api.get.mockResolvedValue(settingsResponse);
    const client = createClient();
    const wrapper = createWrapper(client);

    const settings = renderHook(() => useSettings(), { wrapper });
    const services = renderHook(() => useServiceList("store-1"), {
      wrapper,
    });
    const closures = renderHook(() => useClosureList("store-1"), {
      wrapper,
    });
    const resources = renderHook(() => useResourceList("store-1"), {
      wrapper,
    });
    const staff = renderHook(() => useStaffList("store-1"), {
      wrapper,
    });
    const booking = renderHook(() => useBookingWindows(), { wrapper });
    const notice = renderHook(() => useCustomerNotices(), { wrapper });
    const caps = renderHook(() => useReservationCaps(), { wrapper });
    const reminders = renderHook(() => useReminderOffsets(), {
      wrapper,
    });

    await waitFor(() =>
      expect(settings.result.current.data).toBe(settingsResponse),
    );
    await waitFor(() =>
      expect(services.result.current.isPending).toBe(false),
    );

    expect(mocks.api.get).toHaveBeenCalledTimes(1);
    expect(mocks.api.get).toHaveBeenCalledWith("/api/admin/settings");
    expect(
      client.getQueryCache().getAll().map((query) => query.queryKey),
    ).toEqual([["settings"]]);
    expect(services.result.current.serviceList).toEqual([service1]);
    expect(
      Array.from(services.result.current.storeNames.entries()),
    ).toEqual([
      ["store-1", "銀座店"],
      ["store-2", "新宿店"],
    ]);
    expect(closures.result.current.closureList).toEqual([closure1]);
    expect(resources.result.current.resourceList).toEqual([resource1]);
    expect(staff.result.current).toMatchObject({
      staffList: [staff1],
      isPending: false,
      isError: false,
    });
    expect(booking.result.current.stores).toEqual([store1, store2]);
    expect(notice.result.current.stores).toEqual([store1, store2]);
    expect(caps.result.current.stores).toEqual([store1, store2]);
    expect(reminders.result.current.offsets).toEqual(
      settingsResponse.settings.reminderOffsets,
    );
  });

  it("returns all rows when a settings list has no store filter", async () => {
    mocks.api.get.mockResolvedValue(settingsResponse);
    const client = createClient();
    const wrapper = createWrapper(client);

    const services = renderHook(() => useServiceList(null), { wrapper });
    const closures = renderHook(() => useClosureList(null), { wrapper });
    const resources = renderHook(() => useResourceList(null), { wrapper });
    const staff = renderHook(() => useStaffList(null), { wrapper });

    await waitFor(() =>
      expect(services.result.current.isPending).toBe(false),
    );
    expect(services.result.current.serviceList).toEqual([
      service1,
      service2,
    ]);
    expect(closures.result.current.closureList).toEqual([
      closure1,
      closure2,
    ]);
    expect(resources.result.current.resourceList).toEqual([
      resource1,
      resource2,
    ]);
    expect(staff.result.current.staffList).toEqual([staff1, staff2]);
  });

  it("returns empty settings-derived defaults when the shared request fails", async () => {
    mocks.api.get.mockRejectedValue(new Error("network"));
    const client = createClient();
    const wrapper = createWrapper(client);

    const services = renderHook(() => useServiceList("store-1"), {
      wrapper,
    });
    const closures = renderHook(() => useClosureList("store-1"), {
      wrapper,
    });
    const resources = renderHook(() => useResourceList("store-1"), {
      wrapper,
    });
    const staff = renderHook(() => useStaffList("store-1"), {
      wrapper,
    });

    await waitFor(() =>
      expect(staff.result.current.isError).toBe(true),
    );
    expect(services.result.current.serviceList).toEqual([]);
    expect(services.result.current.storeNames).toEqual(new Map());
    expect(closures.result.current.closureList).toEqual([]);
    expect(resources.result.current.resourceList).toEqual([]);
    expect(staff.result.current.staffList).toEqual([]);
  });

  it("defaults optional reminder offsets to an empty list", async () => {
    const response = {
      ...settingsResponse,
      settings: {
        ...settingsResponse.settings,
        reminderOffsets: undefined,
      },
    };
    mocks.api.get.mockResolvedValue(response);
    const client = createClient();
    const { result } = renderHook(() => useReminderOffsets(), {
      wrapper: createWrapper(client),
    });

    await waitFor(() => expect(result.current.isPending).toBe(false));
    expect(result.current.offsets).toEqual([]);
    expect(mocks.api.get).toHaveBeenCalledWith("/api/admin/settings");
  });

  it.each([
    ["booking windows", () => useBookingWindows()],
    ["closures", () => useClosureList("store-1")],
    ["customer notices", () => useCustomerNotices()],
    ["reminder offsets", () => useReminderOffsets()],
    ["reservation caps", () => useReservationCaps()],
    ["resources", () => useResourceList("store-1")],
    ["staff", () => useStaffList("store-1")],
  ])(
    "%s independently uses the shared settings key and endpoint",
    async (_name, useHook) => {
      mocks.api.get.mockResolvedValue(settingsResponse);
      const client = createClient();

      renderHook(() => useHook(), {
        wrapper: createWrapper(client),
      });

      await waitFor(() =>
        expect(client.getQueryState(["settings"])?.status).toBe(
          "success",
        ),
      );
      expect(mocks.api.get).toHaveBeenCalledWith(
        "/api/admin/settings",
      );
      expect(
        client.getQueryCache().getAll().map((query) => query.queryKey),
      ).toEqual([["settings"]]);
    },
  );
});

describe("standalone settings queries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("gates business hours without a store and keys an active request by store", async () => {
    const disabledClient = createClient();
    renderHook(() => useBusinessHours(null), {
      wrapper: createWrapper(disabledClient),
    });
    expect(mocks.api.get).not.toHaveBeenCalled();
    expect(
      disabledClient.getQueryState(["business-hours", null])
        ?.fetchStatus,
    ).toBe("idle");

    const response = {
      ok: true,
      businessHours: [
        {
          weekday: 1,
          opensAt: "10:00",
          closesAt: "19:00",
          closed: false,
        },
      ],
    };
    mocks.api.get.mockResolvedValue(response);
    const client = createClient();
    const { result } = renderHook(
      () => useBusinessHours("store/1"),
      { wrapper: createWrapper(client) },
    );
    await waitFor(() => expect(result.current.data).toBe(response));
    expect(mocks.api.get).toHaveBeenCalledWith(
      "/api/admin/settings/business-hours/store/1",
    );
    expect(
      client.getQueryCache().find({
        queryKey: ["business-hours", "store/1"],
        exact: true,
      }),
    ).toBeDefined();
  });

  it("selects quota data and preserves the line-quota key", async () => {
    const quota = {
      used: 42,
      limit: 200,
      remaining: 158,
      softCap: 180,
      asOf: "2026-07-24T00:00:00Z",
    };
    mocks.api.get.mockResolvedValue({ ok: true, quota });
    const client = createClient();
    const { result } = renderHook(() => useLineQuota(), {
      wrapper: createWrapper(client),
    });

    await waitFor(() => expect(result.current.isPending).toBe(false));
    expect(result.current).toEqual({
      quota,
      isPending: false,
      isError: false,
    });
    expect(mocks.api.get).toHaveBeenCalledWith(
      "/api/admin/line-quota",
    );
    expect(
      client.getQueryCache().find({
        queryKey: ["line-quota"],
        exact: true,
      }),
    ).toBeDefined();
  });

  it("returns null quota when the server has not fetched it yet", async () => {
    mocks.api.get.mockResolvedValue({ ok: true, quota: null });
    const client = createClient();
    const { result } = renderHook(() => useLineQuota(), {
      wrapper: createWrapper(client),
    });

    await waitFor(() => expect(result.current.isPending).toBe(false));
    expect(result.current.quota).toBeNull();
  });
});

describe("useStores shared selection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reuses settings, derives stores, and exposes the shared StoreContext selection", async () => {
    mocks.api.get.mockResolvedValue(settingsResponse);
    const client = createClient();
    const { result } = renderHook(() => useStores(), {
      wrapper: createWrapper(client),
    });

    await waitFor(() => expect(result.current.stores).toHaveLength(2));
    expect(mocks.api.get).toHaveBeenCalledWith("/api/admin/settings");
    expect(
      client.getQueryCache().find({
        queryKey: ["settings"],
        exact: true,
      }),
    ).toBeDefined();
    expect(result.current).toEqual({
      stores: [store1, store2],
      isPending: false,
      selectedStoreId: "store-2",
      selectStore: selection.selectStore,
      isStoreFixed: false,
    });

    result.current.selectStore("store-1");
    expect(selection.selectStore).toHaveBeenCalledWith("store-1");
  });

  it("fetches settings for staff too (server returns own-store allowlist) and fixes selection", async () => {
    // GET /api/admin/settings は staff には自店舗スコープの allowlist を返すので、
    // staff も取得してよい (店名解決に必要)。以前は staff が 403 だったため
    // enabled ガードで止めていた。
    mocks.api.get.mockResolvedValue({
      ok: true,
      settings: { ...settingsResponse.settings, stores: [store1] },
    });
    const client = createClient();
    const staffSelection = {
      selectedStoreId: "store-1",
      selectStore: vi.fn(),
    };
    const { result } = renderHook(() => useStores(), {
      wrapper: createWrapper(client, staffAuth, staffSelection),
    });

    await waitFor(() => expect(result.current.stores).toHaveLength(1));
    expect(mocks.api.get).toHaveBeenCalledWith("/api/admin/settings");
    expect(result.current).toEqual({
      stores: [store1],
      isPending: false,
      selectedStoreId: "store-1",
      selectStore: staffSelection.selectStore,
      isStoreFixed: true,
    });
  });

  it("requires StoreContext instead of creating an isolated selection", () => {
    const client = createClient();
    expect(() =>
      renderHook(() => useStores(), {
        wrapper: createWrapper(client, ownerAuth, null),
      }),
    ).toThrow("useStores must be used within a StoreProvider");
  });
});

describe("settings mutations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each(mutationCases)(
    "$name sends the exact request and runs success effects",
    async (testCase) => {
      mocks.api[testCase.method].mockResolvedValue(
        "response" in testCase ? testCase.response : { ok: true },
      );
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
      if ("mutationKey" in testCase) {
        expect(
          client.getMutationCache().getAll()[0]?.options.mutationKey,
        ).toEqual(testCase.mutationKey);
      }
      if ("success" in testCase) {
        expect(mocks.toast.success).toHaveBeenCalledWith(
          testCase.success,
        );
      } else {
        expect(mocks.toast.success).not.toHaveBeenCalled();
      }
      expect(mocks.showErrorToast).not.toHaveBeenCalled();
    },
  );

  it.each(mutationCases)(
    "$name reports the configured error without success effects",
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
      if ("invalidatesOnError" in testCase && testCase.invalidatesOnError) {
        expect(invalidate).toHaveBeenCalledWith({ queryKey: ["settings"] });
      } else {
        expect(invalidate).not.toHaveBeenCalled();
      }
      expect(mocks.toast.success).not.toHaveBeenCalled();
    },
  );
});
