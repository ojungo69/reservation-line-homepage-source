import { QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { AuthProvider } from "@/providers/auth-provider";
import { createTestQueryClient } from "@/test-utils/query-client";
import type { ReservationDetail } from "@/types/api";
import { AppRoutes } from "../routes";

vi.mock("@/components/app-shell", async () => {
  const { Outlet } = await import("react-router");
  const { StoreProvider } = await import("@/providers/store-provider");
  return { AppShell: () => <StoreProvider><Outlet /></StoreProvider> };
});

vi.mock("@/components/shell-v2/app-shell-v2", async () => {
  const { AppShell } = await import("@/components/app-shell");
  return { default: AppShell };
});

const DETAIL = "/api/admin/reservations/res-1";
const LEGACY = `${DETAIL}/reschedule`;
const PREVIEW = `${LEGACY}/preview`;
const COMMIT = `${LEGACY}/commit`;
const FINGERPRINT = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const CUSTOMER = "山田 花子";
const START = "2026-11-23T02:00:00.000Z";
const END = "2026-11-23T03:00:00.000Z";
const MOVED_START = "2026-11-23T02:35:00.000Z";
const MOVED_END = "2026-11-23T03:35:00.000Z";

const initialReservation: ReservationDetail = {
  id: "res-1", version: 7, status: "confirmed", source: "admin", storeId: "s1", storeName: "本店",
  serviceId: "svc", serviceName: "カット", resourceId: "r1", resourceName: "席", startAt: START, endAt: END,
  customerId: "c1", customerDisplayName: CUSTOMER, lineFriendStatus: null, cancellationFeeUnpaidAt: null,
  customerDisplayNameKana: null, phoneNormalized: null, googleSyncState: null, googleEventId: null,
  reservationOrigin: null, customerMemo: null, customerAllergyNotes: null, visits: [], audit: [],
  notifications: [], calendarSync: [], duplicateConsent: null,
};
const movedReservation = { ...initialReservation, version: 8, startAt: MOVED_START, endAt: MOVED_END };
const before = { startAt: START, endAt: END, treatmentEndAt: "2026-11-23T02:55:00.000Z", occupancyMinutes: 60, treatmentMinutes: 55 };
const afterMove = { startAt: MOVED_START, endAt: MOVED_END, treatmentEndAt: "2026-11-23T03:30:00.000Z", occupancyMinutes: 60, treatmentMinutes: 55 };
const previewMove = {
  ok: true, contractVersion: "calendar-interactions-v1", reservationId: "res-1", version: 7,
  intent: { kind: "move", startAt: MOVED_START }, before, after: afterMove, storeId: "s1", resourceId: "r1",
  status: "confirmed", notificationPlan: { kind: "none", reason: "no_line_identity" },
  calendarPlan: "enqueue_upsert", previewFingerprint: FINGERPRINT,
};
const commitMove = {
  ok: true, contractVersion: "calendar-interactions-v1", replayed: false, operationId: "operation-1",
  change: { beforeVersion: 7, appliedVersion: 8, before, after: afterMove },
  reservation: {
    id: "res-1", version: 8, status: "confirmed", storeId: "s1", resourceId: "r1",
    startAt: MOVED_START, endAt: MOVED_END, occupancyMinutes: 60,
  },
  effects: { notification: { kind: "none", reason: "no_line_identity" }, calendar: { jobId: "calendar-job" } },
};

const settings = {
  stores: [{ id: "s1", name: "本店" }],
  resources: [{ id: "r1", storeId: "s1", name: "席", resourceType: "chair", active: true }],
  services: [], staff: [], closures: [], reminderOffsets: [],
  businessHours: [{ id: "bh1", storeId: "s1", weekday: 1, opensAt: "09:00", closesAt: "20:00", active: true }],
};

let reservation: ReservationDetail;
let calendarV2: boolean;
let adminEmail: string;
let previewResponse: () => Response;
let commitResponse: (check: boolean, init?: RequestInit) => Response | Promise<Response>;
const fetchMock = vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
  const path = new URL(url, "http://admin.test");
  switch (path.pathname) {
    case "/api/admin/me":
      return Response.json({ ok: true, calendarV2, admin: { email: adminEmail, role: "system_admin", storeId: "s1", staffMemberId: null } });
    case "/api/admin/reservations":
      return Response.json({ ok: true, reservations: path.searchParams.get("date") === "2026-11-23" ? [{ ...reservation, version: 4 }] : [] });
    case "/api/admin/reservations/pending":
      return Response.json({ ok: true, reservations: [] });
    case DETAIL:
      return Response.json({ ok: true, reservation });
    case "/api/admin/settings":
      return Response.json({ ok: true, settings });
    case "/api/admin/external-blocks":
      return Response.json({ ok: true, externalBlocks: [], truncated: false });
    case "/api/admin/available-slots":
      return Response.json({ ok: true, slots: [] });
    case PREVIEW:
      return previewResponse();
    case COMMIT:
      return commitResponse(path.searchParams.get("mode") === "check", init);
    case LEGACY:
      return Response.json({ ok: true });
    default:
      throw new Error(`Unexpected request ${init?.method ?? "GET"} ${url}`);
  }
});

function renderSchedule(client = createTestQueryClient()) {
  const view = render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <AuthProvider><AppRoutes /></AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { ...view, client };
}

async function openStartTimeForm() {
  fireEvent.click(await screen.findByRole("button", { name: "詳細" }));
  fireEvent.click(await screen.findByRole("button", { name: "開始時刻を変更" }));
  fireEvent.change(screen.getByLabelText("時間"), { target: { value: "11:35" } });
}

function saveStartTime() {
  fireEvent.click(screen.getByRole("button", { name: "この開始時刻に変更" }));
}

async function changeStartTime() {
  await openStartTimeForm();
  saveStartTime();
}

function posts() {
  return fetchMock.mock.calls.filter(([, init]) => init?.method === "POST");
}

beforeAll(async () => {
  // Load both lazy modules before starting DOM waits under the full suite's parallel load.
  await Promise.all([import("./schedule-v2"), import("./schedule")]);
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-23T01:00:00.000Z"));
  localStorage.clear();
  reservation = initialReservation;
  calendarV2 = true;
  adminEmail = "owner@example.invalid";
  previewResponse = () => Response.json(previewMove);
  commitResponse = () => {
    reservation = movedReservation;
    return Response.json(commitMove);
  };
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("matchMedia", vi.fn((query: string) => ({
    matches: query === "(max-width: 639.98px)", addEventListener: vi.fn(), removeEventListener: vi.fn(),
  })));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it("新しい予定表の開始時刻変更は、詳細で取得した版で preview してから commit する", async () => {
  renderSchedule();
  await changeStartTime();

  const detail = await screen.findByRole("dialog", { name: "予約詳細" });
  expect(await within(detail).findByText(/11:35–12:35/)).toBeTruthy();
  expect(posts().map(([url]) => url)).toEqual([PREVIEW, COMMIT]);
  expect(JSON.parse(String(posts()[0][1]?.body))).toEqual({
    contractVersion: "calendar-interactions-v1", expectedVersion: 7,
    intent: { kind: "move", startAt: "2026-11-23T11:35:00+09:00" },
  });
  expect(JSON.parse(String(posts()[1][1]?.body))).toEqual({
    contractVersion: "calendar-interactions-v1", expectedVersion: 7,
    intent: { kind: "move", startAt: "2026-11-23T02:35:00.000Z" },
    previewFingerprint: FINGERPRINT,
    idempotencyKey: expect.stringMatching(/^calendar-v1:[0-9a-f-]{36}:a{64}$/),
  });
});

it("旧予定表の開始時刻変更は、旧 reschedule にだけ送る", async () => {
  calendarV2 = false;
  renderSchedule();
  await changeStartTime();

  expect(await screen.findByRole("dialog", { name: "予約詳細" })).toBeTruthy();
  expect(posts().map(([url]) => url)).toEqual([LEGACY]);
  expect(JSON.parse(String(posts()[0][1]?.body))).toEqual({
    idempotencyKey: expect.any(String), startAt: "2026-11-23T11:35:00+09:00",
  });
});

it("新しい予定表では、占有5分の旧予約も開始を動かさず施術時間を5分に変更できる", async () => {
  reservation = { ...initialReservation, endAt: "2026-11-23T02:05:00.000Z" };
  const beforeResize = { startAt: START, endAt: "2026-11-23T02:05:00.000Z", treatmentEndAt: START, occupancyMinutes: 5, treatmentMinutes: 0 };
  const afterResize = { startAt: START, endAt: "2026-11-23T02:10:00.000Z", treatmentEndAt: "2026-11-23T02:05:00.000Z", occupancyMinutes: 10, treatmentMinutes: 5 };
  previewResponse = () => Response.json({ ...previewMove, intent: { kind: "resize", treatmentMinutes: 5 }, before: beforeResize, after: afterResize });
  commitResponse = () => {
    reservation = { ...initialReservation, version: 8, endAt: "2026-11-23T02:10:00.000Z" };
    return Response.json({
      ...commitMove, change: { ...commitMove.change, before: beforeResize, after: afterResize },
      reservation: { ...commitMove.reservation, startAt: START, endAt: "2026-11-23T02:10:00.000Z", occupancyMinutes: 10 },
    });
  };
  renderSchedule();
  fireEvent.click(await screen.findByRole("button", { name: "詳細" }));
  fireEvent.click(await screen.findByRole("button", { name: "長さを変更" }));
  fireEvent.change(screen.getByRole("spinbutton", { name: "新しい施術時間（分）" }), { target: { value: "5" } });
  fireEvent.click(screen.getByRole("button", { name: "この長さに変更" }));

  const detail = await screen.findByRole("dialog", { name: "予約詳細" });
  expect(await within(detail).findByText(/11:00–11:10/)).toBeTruthy();
  expect(posts().map(([url]) => url)).toEqual([PREVIEW, COMMIT]);
  const request = { contractVersion: "calendar-interactions-v1", expectedVersion: 7, intent: { kind: "resize", treatmentMinutes: 5 } };
  expect(JSON.parse(String(posts()[0][1]?.body))).toEqual(request);
  expect(JSON.parse(String(posts()[1][1]?.body))).toEqual({
    ...request, previewFingerprint: FINGERPRINT,
    idempotencyKey: expect.stringMatching(/^calendar-v1:[0-9a-f-]{36}:a{64}$/),
  });
});

it("commit の応答を失ったら手動照合を待ち、同じ本体で保存済みと現在の予約を取得する", async () => {
  const latestStart = "2026-11-23T03:00:00.000Z";
  const latestEnd = "2026-11-23T04:00:00.000Z";
  commitResponse = (check) => {
    if (!check) throw new TypeError("connection lost");
    reservation = { ...movedReservation, version: 9, startAt: latestStart, endAt: latestEnd };
    return Response.json({
      ...commitMove, replayed: true,
      reservation: { ...commitMove.reservation, version: 9, startAt: latestStart, endAt: latestEnd },
    });
  };
  renderSchedule();
  await changeStartTime();

  expect(await screen.findByText("保存できたか確認できていません")).toBeTruthy();
  const detail = screen.getByRole("dialog", { name: "予約詳細" });
  expect(within(detail).getByText(/11:00–12:00/)).toBeTruthy();
  expect(within(detail).getByRole<HTMLButtonElement>("button", { name: "長さを変更" }).disabled).toBe(true);
  expect(posts().map(([url]) => url)).toEqual([PREVIEW, COMMIT]);

  fireEvent.click(within(detail).getByRole("button", { name: "確認する" }));
  expect(await within(detail).findByText("保存済みです")).toBeTruthy();
  expect(within(detail).getByText(/12:00–13:00/)).toBeTruthy();
  expect(within(detail).queryByText(/11:35–12:35/)).toBeNull();
  expect(posts().map(([url]) => url)).toEqual([PREVIEW, COMMIT, `${COMMIT}?mode=check`]);
  expect(posts()[2][1]?.body).toBe(posts()[1][1]?.body);
});

it("照合で未適用が確定したら、未保存の案内を出して最新の予約を取り直す", async () => {
  commitResponse = (check) => {
    if (!check) return new Response("<html>Gateway timeout</html>", { status: 504 });
    reservation = { ...initialReservation, version: 8, endAt: "2026-11-23T03:15:00.000Z" };
    return Response.json({ ok: false, reason: "operation_not_applied" }, { status: 409 });
  };
  renderSchedule();
  await changeStartTime();
  fireEvent.click(await screen.findByRole("button", { name: "確認する" }));

  expect(await screen.findByText("保存されていません。この変更はこの後も保存されません。")).toBeTruthy();
  const detail = screen.getByRole("dialog", { name: "予約詳細" });
  expect(await within(detail).findByText(/11:00–12:15/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "確認する" })).toBeNull();
  expect(posts().map(([url]) => url)).toEqual([PREVIEW, COMMIT, `${COMMIT}?mode=check`]);
  expect(posts()[2][1]?.body).toBe(posts()[1][1]?.body);
});

it("成功の形を満たさない応答では保存済みと表示しない", async () => {
  commitResponse = () => Response.json({ ok: true, contractVersion: "calendar-interactions-v1" });
  renderSchedule();
  await changeStartTime();

  expect(await screen.findByText("保存できたか確認できていません")).toBeTruthy();
  expect(screen.getByRole("button", { name: "確認する" })).toBeTruthy();
  expect(screen.queryByText("保存済みです")).toBeNull();
  expect(posts().map(([url]) => url)).toEqual([PREVIEW, COMMIT]);
});

it("commit が時間切れになっても、自動で再送・照合をせず手動照合を案内する", async () => {
  let timeoutReason: unknown;
  commitResponse = (_, init) => new Promise<Response>((_, reject) => {
    const signal = init?.signal;
    signal?.addEventListener("abort", () => {
      timeoutReason = signal.reason;
      reject(timeoutReason);
    }, { once: true });
  });
  renderSchedule();
  await openStartTimeForm();

  const now = new Date();
  vi.useRealTimers();
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  vi.setSystemTime(now);
  await act(async () => {
    saveStartTime();
    await vi.advanceTimersByTimeAsync(60_000);
  });

  expect(timeoutReason).toMatchObject({ name: "TimeoutError" });
  expect(screen.getByText("保存できたか確認できていません")).toBeTruthy();
  expect(screen.getByRole("button", { name: "確認する" })).toBeTruthy();
  expect(posts().map(([url]) => url)).toEqual([PREVIEW, COMMIT]);
});

it("最初の commit 送信から24時間に達したら、照合を終えて最新の予約を取り直す", async () => {
  const clock = vi.spyOn(performance, "now").mockReturnValue(100);
  previewResponse = () => {
    clock.mockReturnValue(10_100);
    return Response.json(previewMove);
  };
  commitResponse = (check) => {
    if (!check) throw new TypeError("connection lost");
    return Response.json({ ok: false, reason: "idempotency_in_progress" }, { status: 409 });
  };
  renderSchedule();
  await changeStartTime();
  const check = await screen.findByRole<HTMLButtonElement>("button", { name: "確認する" });

  clock.mockReturnValue(86_410_099);
  fireEvent.click(check);
  await waitFor(() => expect(check.disabled).toBe(false));
  expect(posts().map(([url]) => url)).toEqual([PREVIEW, COMMIT, `${COMMIT}?mode=check`]);

  reservation = movedReservation;
  clock.mockReturnValue(86_410_100);
  fireEvent(document, new Event("visibilitychange"));
  expect(screen.queryByRole("button", { name: "確認する" })).toBeNull();
  const detail = screen.getByRole("dialog", { name: "予約詳細" });
  expect(await within(detail).findByText(/11:35–12:35/)).toBeTruthy();
  expect(screen.queryByText("保存済みです")).toBeNull();
  expect(posts()).toHaveLength(3);
});

it("詳細を閉じて開き直すと、照合を引き継がず最新の予約を表示する", async () => {
  commitResponse = () => { throw new TypeError("connection lost"); };
  renderSchedule();
  await changeStartTime();
  expect(await screen.findByRole("button", { name: "確認する" })).toBeTruthy();
  const detail = screen.getByRole("dialog", { name: "予約詳細" });
  reservation = movedReservation;
  fireEvent.click(within(detail).getByRole("button", { name: "Close" }));

  const reopen = await screen.findByRole("button", { name: "詳細" });
  expect(await screen.findByText("11:35–12:35")).toBeTruthy();
  fireEvent.click(reopen);
  const reopened = await screen.findByRole("dialog", { name: "予約詳細" });
  expect(await within(reopened).findByText(/11:35–12:35/)).toBeTruthy();
  expect(within(reopened).queryByRole("button", { name: "確認する" })).toBeNull();
  expect(posts().map(([url]) => url)).toEqual([PREVIEW, COMMIT]);
});

it("認証主体が変わると照合を破棄し、前の主体宛ての応答が届いても現在の予約を表示する", async () => {
  let respondToCheck: ((response: Response) => void) | undefined;
  commitResponse = (check) => {
    if (!check) throw new TypeError("connection lost");
    return new Promise<Response>((resolve) => { respondToCheck = resolve; });
  };
  const { client } = renderSchedule();
  await changeStartTime();
  fireEvent.click(await screen.findByRole("button", { name: "確認する" }));
  expect(respondToCheck).toBeTypeOf("function");

  adminEmail = "other-owner@example.invalid";
  reservation = { ...initialReservation, version: 10, endAt: "2026-11-23T03:30:00.000Z" };
  await act(async () => { await client.invalidateQueries({ queryKey: ["auth", "me"] }); });
  await waitFor(() => {
    const currentDetail = screen.getByRole("dialog", { name: "予約詳細" });
    expect(within(currentDetail).getByText(/11:00–12:30/)).toBeTruthy();
  });
  const detail = await screen.findByRole("dialog", { name: "予約詳細" });

  await act(async () => { respondToCheck?.(Response.json({ ...commitMove, replayed: true })); });
  expect(within(detail).queryByRole("button", { name: "確認する" })).toBeNull();
  expect(within(detail).queryByText("保存済みです")).toBeNull();
  expect(within(detail).getByText(/11:00–12:30/)).toBeTruthy();
  expect(posts().map(([url]) => url)).toEqual([PREVIEW, COMMIT, `${COMMIT}?mode=check`]);
});

it("画面を読み込み直した場合は、元の端末でも照合を引き継がない", async () => {
  commitResponse = () => { throw new TypeError("connection lost"); };
  const previous = renderSchedule();
  await changeStartTime();
  expect(await screen.findByRole("button", { name: "確認する" })).toBeTruthy();
  previous.unmount();

  reservation = movedReservation;
  renderSchedule();
  fireEvent.click(await screen.findByRole("button", { name: "詳細" }));
  const detail = await screen.findByRole("dialog", { name: "予約詳細" });
  expect(await within(detail).findByText(/11:35–12:35/)).toBeTruthy();
  expect(within(detail).queryByRole("button", { name: "確認する" })).toBeNull();
  expect(posts()).toHaveLength(2);
});

it("commit が version_conflict を返したら、競合を知らせて最新の予約を表示する", async () => {
  commitResponse = () => {
    reservation = { ...initialReservation, version: 8, endAt: "2026-11-23T03:20:00.000Z" };
    return Response.json({ ok: false, reason: "version_conflict", version: 8, status: "confirmed" }, { status: 409 });
  };
  renderSchedule();
  await changeStartTime();

  expect(await screen.findByText(/他の操作で予約が更新されました/)).toBeTruthy();
  const detail = screen.getByRole("dialog", { name: "予約詳細" });
  expect(await within(detail).findByText(/11:00–12:20/)).toBeTruthy();
  expect(within(detail).queryByRole("button", { name: "確認する" })).toBeNull();
  expect(posts().map(([url]) => url)).toEqual([PREVIEW, COMMIT]);
});

it("commit が feature_disabled を返すと、保存できないことを知らせ、日時変更を止める", async () => {
  commitResponse = () => Response.json({ ok: false, reason: "feature_disabled" }, { status: 404 });
  renderSchedule();
  await changeStartTime();

  expect(await screen.findByText("現在、予約の日時を変更できません。")).toBeTruthy();
  const detail = screen.getByRole("dialog", { name: "予約詳細" });
  expect(within(detail).getByRole<HTMLButtonElement>("button", { name: "開始時刻を変更" }).disabled).toBe(true);
  expect(within(detail).getByRole<HTMLButtonElement>("button", { name: "長さを変更" }).disabled).toBe(true);
  expect(within(detail).queryByRole("button", { name: "確認する" })).toBeNull();
  expect(posts().map(([url]) => url)).toEqual([PREVIEW, COMMIT]);
});

it("送信後に切り替えがオフになっても、同じ詳細と手動照合を保持する", async () => {
  let loseCommit: (() => void) | undefined;
  commitResponse = (check) => {
    if (!check) return new Promise<Response>((_, reject) => { loseCommit = () => reject(new TypeError("connection lost")); });
    reservation = movedReservation;
    return calendarV2
      ? Response.json({ ...commitMove, replayed: true })
      : Response.json({ ok: false, reason: "feature_disabled" }, { status: 404 });
  };
  const { client } = renderSchedule();
  await changeStartTime();
  await waitFor(() => expect(loseCommit).toBeTypeOf("function"));

  calendarV2 = false;
  await act(async () => { await client.invalidateQueries({ queryKey: ["auth", "me"] }); });
  expect(await screen.findByText("現在、予約の日時を変更できません。")).toBeTruthy();
  await act(async () => { loseCommit?.(); });
  fireEvent.click(await screen.findByRole("button", { name: "確認する" }));

  const detail = screen.getByRole("dialog", { name: "予約詳細" });
  expect(await within(detail).findByText(/11:35–12:35/)).toBeTruthy();
  expect(within(detail).getByText("保存できたか確認できていません")).toBeTruthy();
  expect(within(detail).getByRole<HTMLButtonElement>("button", { name: "長さを変更" }).disabled).toBe(true);
  expect(posts().map(([url]) => url)).toEqual([PREVIEW, COMMIT, `${COMMIT}?mode=check`]);

  calendarV2 = true;
  await act(async () => { await client.invalidateQueries({ queryKey: ["auth", "me"] }); });
  await waitFor(() => expect(within(detail).queryByText("現在、予約の日時を変更できません。")).toBeNull());
  expect(posts()).toHaveLength(3);
  fireEvent.click(within(detail).getByRole("button", { name: "確認する" }));

  expect(await within(detail).findByText("保存済みです")).toBeTruthy();
  expect(posts().map(([url]) => url)).toEqual([PREVIEW, COMMIT, `${COMMIT}?mode=check`, `${COMMIT}?mode=check`]);
  expect(posts().slice(2).map(([, init]) => init?.body)).toEqual([posts()[1][1]?.body, posts()[1][1]?.body]);
});

it("新しい preview の経路がない場合は、日時変更を止めて予約の閲覧を続ける", async () => {
  previewResponse = () => new Response("Not Found", { status: 404 });
  renderSchedule();
  await changeStartTime();

  expect(await screen.findByText("現在、予約の日時を変更できません。")).toBeTruthy();
  const detail = screen.getByRole("dialog", { name: "予約詳細" });
  expect(within(detail).getByText(/11:00–12:00/)).toBeTruthy();
  expect(within(detail).getByRole<HTMLButtonElement>("button", { name: "開始時刻を変更" }).disabled).toBe(true);
  expect(within(detail).queryByRole("button", { name: "確認する" })).toBeNull();
  expect(posts().map(([url]) => url)).toEqual([PREVIEW]);
});

it("続けて別の変更を保存すると、取得した版と新しい冪等キーを使う", async () => {
  const longerEnd = "2026-11-23T03:45:00.000Z";
  const afterResize = { ...afterMove, endAt: longerEnd, treatmentEndAt: "2026-11-23T03:40:00.000Z", occupancyMinutes: 70, treatmentMinutes: 65 };
  const nextFingerprint = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  previewResponse = () => Response.json(reservation.version === 7 ? previewMove : {
    ...previewMove, version: 8, intent: { kind: "resize", treatmentMinutes: 65 },
    before: afterMove, after: afterResize, previewFingerprint: nextFingerprint,
  });
  const commitFirst = commitResponse;
  commitResponse = (check) => {
    if (reservation.version === 7) return commitFirst(check);
    reservation = { ...movedReservation, version: 9, endAt: longerEnd };
    return Response.json({
      ...commitMove, operationId: "operation-2",
      change: { beforeVersion: 8, appliedVersion: 9, before: afterMove, after: afterResize },
      reservation: { ...commitMove.reservation, version: 9, endAt: longerEnd, occupancyMinutes: 70 },
    });
  };
  renderSchedule();
  await changeStartTime();
  const lengthButton = await screen.findByRole<HTMLButtonElement>("button", { name: "長さを変更" });
  await waitFor(() => expect(lengthButton.disabled).toBe(false));
  fireEvent.click(lengthButton);
  fireEvent.change(screen.getByRole("spinbutton", { name: "新しい施術時間（分）" }), { target: { value: "65" } });
  fireEvent.click(screen.getByRole("button", { name: "この長さに変更" }));

  const detail = await screen.findByRole("dialog", { name: "予約詳細" });
  expect(await within(detail).findByText(/11:35–12:45/)).toBeTruthy();
  expect(posts().map(([url]) => url)).toEqual([PREVIEW, COMMIT, PREVIEW, COMMIT]);
  const first = JSON.parse(String(posts()[1][1]?.body));
  const second = JSON.parse(String(posts()[3][1]?.body));
  expect(second).toEqual({
    contractVersion: "calendar-interactions-v1", expectedVersion: 8, intent: { kind: "resize", treatmentMinutes: 65 },
    previewFingerprint: nextFingerprint, idempotencyKey: expect.stringMatching(/^calendar-v1:[0-9a-f-]{36}:b{64}$/),
  });
  expect(second.idempotencyKey.split(":")[1]).not.toBe(first.idempotencyKey.split(":")[1]);
});
