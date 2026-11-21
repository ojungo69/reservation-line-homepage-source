import { mocks } from "@/test-utils/hook-mocks";
import { StrictMode, useState } from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider, notifyManager } from "@tanstack/react-query";
import { MemoryRouter, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestQueryClient } from "@/test-utils/query-client";
import { FRAME_MS, frameAt } from "@/components/calendar-v2/swipe";
import { PX_PER_MINUTE } from "@/components/calendar-v2/geometry";
import { ShellV2Context, type ShellV2 } from "@/components/shell-v2/shell-context";
import { DOCKED_QUERY } from "@/hooks/use-media-query";
import { addDays, formatJstDate } from "@/lib/timeline";
import type { ExternalBlock, Reservation } from "@/types/api";

const auth = vi.hoisted(() => ({ privileged: true }));
const storeState = vi.hoisted(() => ({
  selected: "s1" as string | null,
  stores: [] as Array<{ id: string; name: string }>,
}));
const captured = vi.hoisted(() => ({
  detail: null as null | {
    reservationId: string | null;
    onClose: () => void;
    layout?: string;
    anchor?: { current: { getBoundingClientRect: () => DOMRect } | null };
  },
  create: null as null | Record<string, unknown>,
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    isPrivileged: auth.privileged,
    user: { role: auth.privileged ? "owner" : "staff", email: "owner@example.invalid", storeId: null },
    calendarV2: true,
  }),
}));
vi.mock("@/hooks/use-stores", () => ({
  useStores: () => ({
    stores: storeState.stores,
    selectedStoreId: storeState.selected,
    selectStore: vi.fn(),
    isStoreFixed: false,
    isPending: false,
  }),
}));
vi.mock("@/components/shell-v2/store-switch-v2", () => ({ StoreSwitchV2: () => <span>店舗の切り替え</span> }));
vi.mock("@/components/schedule/sync-attention", () => ({ ScheduleSyncAttention: () => null }));
vi.mock("@/components/schedule/reservation-detail-panel", () => ({
  ReservationDetailPanel: (props: { reservationId: string | null; onClose: () => void }) => {
    captured.detail = props;
    // Holds focus like the real sheet, so closing it drops focus to <body>.
    return props.reservationId ? (
      <div role="dialog" aria-label="予約の詳細">
        <span data-testid="detail-id">{props.reservationId}</span>
        <button type="button">詳細の中のボタン</button>
      </div>
    ) : null;
  },
}));
vi.mock("@/components/schedule/reservation-create-panel", () => ({
  ReservationCreatePanel: (props: Record<string, unknown>) => {
    captured.create = props;
    return <div role="dialog" aria-label="予約を追加" />;
  },
}));
vi.mock("@/components/schedule/pending-approvals-card", () => ({
  PendingApprovalsCard: ({
    onSelect,
    selectedStoreId,
    listCapped,
  }: {
    onSelect: (id: string) => void;
    selectedStoreId: string | null;
    listCapped?: boolean;
  }) => (
    <button type="button" data-list-capped={String(Boolean(listCapped))} onClick={() => onSelect("res-b")}>
      承認待ちの予約（{selectedStoreId ?? "全店舗"}）
    </button>
  ),
}));

import ScheduleV2Page from "./schedule-v2";

// Friday 2026-11-20 10:00 JST. Its Monday-start week runs 11/16 to 11/22.
const NOW = new Date("2026-11-20T01:00:00Z");
const jst = (day: string, time: string) => new Date(`${day}T${time}:00+09:00`).toISOString();

const reservation = (id: string, day: string, start: string, end: string, extra: Partial<Reservation> = {}): Reservation =>
  ({
    id,
    status: "confirmed",
    source: "admin",
    storeId: "s1",
    storeName: "本店",
    serviceId: "svc",
    serviceName: "カット",
    resourceId: "r1",
    resourceName: "席",
    startAt: jst(day, start),
    endAt: jst(day, end),
    customerId: `c-${id}`,
    customerDisplayName: "山田 花子",
    lineFriendStatus: null,
    cancellationFeeUnpaidAt: null,
    ...extra,
  }) as Reservation;

const block = (id: string, extra: Partial<ExternalBlock>): ExternalBlock =>
  ({
    id,
    storeId: "s1",
    storeName: "本店",
    resourceId: "r1",
    resourceName: "席",
    source: "admin_block",
    titleSnapshot: "研修",
    startAt: jst("2026-11-20", "16:00"),
    endAt: jst("2026-11-20", "17:00"),
    status: "active",
    googleEventId: null,
    createdBy: null,
    updatedAt: jst("2026-11-20", "09:00"),
    ...extra,
  }) as ExternalBlock;

const STORES = [
  { id: "s1", name: "本店" },
  { id: "s2", name: "駅前店" },
  { id: "s3", name: "東口店" },
];

let reservationsByDay: Record<string, Reservation[]>;
let blocksByDay: Record<string, ExternalBlock[]>;
let failingDays: Set<string>;
let failingBlockDays: Set<string>;
let truncatedBlockDays: Set<string>;
let pendingRows: Reservation[] | null;
let businessHours: Array<{ id: string; storeId: string; weekday: number; opensAt: string; closesAt: string; active: boolean }>;
let settingsFail: boolean;
let closures: Array<{ id: string; storeId: string; startsAt: string; endsAt: string; reason: string | null; source: string }>;
let narrow: boolean;
// The sidebar is docked (64rem and up). A phone (narrow) never is.
let docked: boolean;
let reduceMotion: boolean;

const settings = () => ({
  stores: STORES,
  resources: [
    { id: "r1", storeId: "s1", name: "席", resourceType: "chair", active: true },
    { id: "r1-off", storeId: "s1", name: "旧席", resourceType: "chair", active: false },
    { id: "r2a", storeId: "s2", name: "席A", resourceType: "chair", active: true },
    { id: "r2b", storeId: "s2", name: "席B", resourceType: "chair", active: true },
    { id: "r3", storeId: "s3", name: "席", resourceType: "chair", active: false },
  ],
  services: [],
  businessHours,
  closures,
});

const weekOfHours = (storeId: string, opensAt: string, closesAt: string) =>
  Array.from({ length: 7 }, (_, weekday) => ({ id: `bh-${storeId}-${weekday}`, storeId, weekday, opensAt, closesAt, active: true }));

function respond(url: string) {
  const parsed = new URL(url, "http://admin.test");
  if (parsed.pathname === "/api/admin/reservations" && parsed.searchParams.get("range") === "date") {
    const day = parsed.searchParams.get("date") ?? "";
    if (failingDays.has(day)) return Promise.reject(new Error("network"));
    return Promise.resolve({ ok: true, range: "date", startAt: "", endAt: "", reservations: reservationsByDay[day] ?? [] });
  }
  if (parsed.pathname === "/api/admin/external-blocks") {
    const day = parsed.searchParams.get("from") ?? "";
    if (failingBlockDays.has(day)) return Promise.reject(new Error("network"));
    return Promise.resolve({ ok: true, externalBlocks: blocksByDay[day] ?? [], truncated: truncatedBlockDays.has(day) });
  }
  if (parsed.pathname === "/api/admin/settings") {
    return settingsFail ? Promise.reject(new Error("network")) : Promise.resolve({ ok: true, settings: settings() });
  }
  if (parsed.pathname === "/api/admin/reservations/pending") {
    return Promise.resolve({
      ok: true,
      reservations: pendingRows ?? [
        reservation("res-b", "2026-11-18", "10:30", "11:30", { status: "pending_approval" }),
        reservation("res-p2", "2026-11-21", "12:00", "13:00", { status: "pending_approval", storeId: "s2" }),
      ],
    });
  }
  return Promise.reject(new Error(`unexpected request ${url}`));
}

function LocationProbe() {
  const location = useLocation();
  return <output aria-label="現在の場所">{`${location.pathname}${location.search}`}</output>;
}

// Renders the page again as a store switch does: the useStores mock is read while rendering.
let refreshPage = () => {};
function PageUnderTest() {
  const [, setTick] = useState(0);
  refreshPage = () => setTick((tick) => tick + 1);
  return <ScheduleV2Page />;
}

function renderPage({
  shell,
  state,
  strict = false,
  client = createTestQueryClient(),
}: { shell?: ShellV2; state?: unknown; strict?: boolean; client?: QueryClient } = {}) {
  const page = (
    <>
      <PageUnderTest />
      <LocationProbe />
    </>
  );
  const tree = (
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[{ pathname: "/", state }]}>
        {shell ? <ShellV2Context.Provider value={shell}>{page}</ShellV2Context.Provider> : page}
      </MemoryRouter>
    </QueryClientProvider>
  );
  // StrictMode as in main.tsx: effects run twice on mount.
  return { client, ...render(strict ? <StrictMode>{tree}</StrictMode> : tree) };
}

// The sidebar's places for the page's parts, outside the page as in AppShellV2.
const slotElements: HTMLElement[] = [];
const sidebarSlot = () => {
  const slot = document.createElement("div");
  document.body.append(slot);
  slotElements.push(slot);
  return slot;
};

const fakeShell = (): ShellV2 & {
  calls: { ownTopBar: boolean[]; blocked: boolean[] };
  sidebarSlots: { top: HTMLElement; end: HTMLElement };
} => {
  const calls = { ownTopBar: [] as boolean[], blocked: [] as boolean[] };
  return {
    calls,
    showMenuButton: true,
    menuButtonRef: { current: null },
    menuOpen: false,
    openMenu: vi.fn(),
    closeMenu: vi.fn(),
    sidebarSlots: { top: sidebarSlot(), end: sidebarSlot() },
    openPalette: vi.fn(),
    setOwnTopBar: (own) => calls.ownTopBar.push(own),
    setPaletteBlocked: (blocked) => calls.blocked.push(blocked),
  };
};

// The shown period's part of the body; the strip's neighbours are previews (PeriodStrip).
const shownBody = () => document.querySelector<HTMLElement>('[data-calendar-scroll] [data-period-side="0"]') as HTMLElement;
const column = (key: string) => shownBody().querySelector<HTMLElement>(`[data-calendar-column="${key}"]`);
const slotsIn = (key: string) => column(key)?.querySelectorAll("[data-slot-minutes]").length ?? 0;
const eventButton = (name: RegExp) => screen.findByRole("button", { name });
// A DOMRect's x, y, width and height are getters, so toEqual would call any two equal.
const xywh = (rect: DOMRect | undefined) => rect && { x: rect.x, y: rect.y, width: rect.width, height: rect.height };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  auth.privileged = true;
  storeState.selected = "s1";
  storeState.stores = STORES.slice(0, 2);
  captured.detail = null;
  captured.create = null;
  reservationsByDay = {
    "2026-11-20": [
      reservation("res-a", "2026-11-20", "10:00", "11:00"),
      reservation("res-b", "2026-11-20", "10:30", "11:30", { status: "pending_approval", customerDisplayName: "佐藤 一郎" }),
      reservation("res-x", "2026-11-20", "12:00", "13:00", { status: "cancelled_by_admin", customerDisplayName: "取消 太郎" }),
      reservation("res-c", "2026-11-20", "13:00", "14:00", { storeId: "s2", storeName: "駅前店", customerDisplayName: "駅前 次郎" }),
    ],
    "2026-11-18": [reservation("res-d", "2026-11-18", "15:00", "16:00", { customerDisplayName: "水曜 三郎" })],
  };
  blocksByDay = {
    "2026-11-20": [
      block("blk-1", {}),
      block("blk-2", { source: "google_calendar", titleSnapshot: null, startAt: jst("2026-11-20", "18:00"), endAt: jst("2026-11-20", "19:00") }),
    ],
  };
  failingDays = new Set();
  failingBlockDays = new Set();
  truncatedBlockDays = new Set();
  pendingRows = null;
  // 駅前店 opens later than 本店, so the earliest opening stays 本店's 10:00.
  businessHours = [...weekOfHours("s1", "10:00", "19:00"), ...weekOfHours("s2", "11:00", "20:00")];
  settingsFail = false;
  closures = [];
  narrow = false;
  docked = true;
  reduceMotion = false;
  localStorage.clear();
  mocks.api.get.mockReset();
  mocks.api.get.mockImplementation(respond);
  vi.stubGlobal("matchMedia", (query: string) => ({
    get matches() {
      if (query.includes("prefers-reduced-motion")) return reduceMotion;
      if (query === DOCKED_QUERY) return docked && !narrow;
      return query.includes("max-width: 639.98px") ? narrow : false;
    },
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  for (const slot of slotElements.splice(0)) slot.remove();
});

describe("ScheduleV2Page の週表示", () => {
  it("1店舗の週を月曜から7列で描き、見出しは年月にする", async () => {
    renderPage();
    expect(await screen.findByRole("button", { name: "11月16日（月）の日表示を開く" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "11月22日（日）の日表示を開く" })).toBeTruthy();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("2026年11月");
    expect(screen.getByRole("button", { name: "11月20日（金）の日表示を開く" }).getAttribute("aria-current")).toBe("date");
    expect(shownBody().querySelectorAll("[data-calendar-column]")).toHaveLength(7);
  });

  it("同じ時間に重なる予約は横に並べ、取消済みは出さない", async () => {
    renderPage();
    // The stored end includes 5 minutes of cleaning; the label gives the treatment's end.
    const first = await eventButton(/^山田 花子、11月20日（金）、10:00から10:55（枠の解放 11:00）、カット、確定$/);
    const second = await eventButton(/^佐藤 一郎、11月20日（金）、10:30から11:25（枠の解放 11:30）、カット、承認待ち$/);
    expect(first.style.left).toBe("calc(0% + 2px)");
    expect(second.style.left).toBe("calc(50% + 2px)");
    expect(first.style.width).toBe("calc(50% - 4px)");
    expect(screen.queryByRole("button", { name: /取消 太郎/ })).toBeNull();
    // 駅前店 is not the chosen store.
    expect(screen.queryByRole("button", { name: /駅前 次郎/ })).toBeNull();
  });

  it("承認待ちは作業面から縁の色で見分け、状態を文字でも示す", async () => {
    renderPage();
    const pending = await eventButton(/^佐藤 一郎、/);
    expect(pending.classList.contains("border-cal-outline")).toBe(true);
    expect(pending.textContent).toContain("承認待ち");
    const confirmed = await eventButton(/^山田 花子、/);
    expect(confirmed.classList.contains("bg-cal-confirmed")).toBe(true);
  });

  it("現在時刻線は今日の列にだけ、作業面の色の縁取りで描く", async () => {
    renderPage();
    await eventButton(/^山田 花子、/);
    const lines = document.querySelectorAll<HTMLElement>("[data-now-line]");
    expect(lines).toHaveLength(1);
    expect(column("2026-11-20:s1")?.contains(lines[0])).toBe(true);
    expect([...lines[0].classList]).toEqual(expect.arrayContaining(["border-y", "border-cal-surface", "bg-cal-alert"]));
    // 10:00 at 48px an hour.
    expect(lines[0].style.top).toBe("480px");
  });

  it("日付の見出しを押すと、その日の日表示を開く", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "11月18日（水）の日表示を開く" }));
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("11月18日（水）");
    expect(shownBody().querySelectorAll("[data-calendar-column]")).toHaveLength(1);
    expect(await eventButton(/^水曜 三郎、/)).toBeTruthy();
  });

  it("前後と今日で週を動かす", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "次の週" }));
    expect(await screen.findByRole("button", { name: "11月23日（月）の日表示を開く" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "今日" }));
    expect(await screen.findByRole("button", { name: "11月16日（月）の日表示を開く" })).toBeTruthy();
  });

  it("スクロール領域とその中にぼかしを置かず、浮かぶバーはスクロール領域の外に置く", async () => {
    renderPage();
    await eventButton(/^山田 花子、/);
    const scroller = document.querySelector<HTMLElement>("[data-calendar-scroll]") as HTMLElement;
    const blurred = [scroller, ...scroller.querySelectorAll("*")].flatMap((el) =>
      [...el.classList].filter((name) => /^!?(backdrop-|blur|glass-)/.test(name.split(":").pop() ?? "")),
    );
    expect(blurred).toEqual([]);
    const bar = document.querySelector(".glass-thick") as HTMLElement;
    expect(scroller.contains(bar)).toBe(false);
    for (let el = bar.parentElement; el; el = el.parentElement) {
      expect([...el.classList].some((name) => /^overflow(-[xy])?-(auto|scroll)$/.test(name)), el.className).toBe(false);
    }
  });
});

describe("ScheduleV2Page の店舗の扱い", () => {
  it("全店舗では日表示で店舗ごとに列を並べ、週を押すと店舗を選ぶよう案内する", async () => {
    storeState.selected = null;
    storeState.stores = STORES;
    const user = userEvent.setup();
    renderPage();
    expect(await eventButton(/^駅前 次郎、/)).toBeTruthy();
    expect(shownBody().querySelectorAll("[data-calendar-column]")).toHaveLength(3);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("11月20日（金）");
    // Not on the first visit: only once the user asks for the week.
    expect(screen.queryByText(/週表示は店舗を1つ選ぶと使えます/)).toBeNull();
    await user.click(screen.getByRole("button", { name: "週" }));
    expect(screen.getByText("週表示は店舗を1つ選ぶと使えます。上部の店舗の切り替えで選んでください。")).toBeTruthy();
    expect(shownBody().querySelectorAll("[data-calendar-column]")).toHaveLength(3);
  });

  it("全店舗の日表示では、外部予定をその店舗の列に出す（店舗の別の枠のものも）", async () => {
    storeState.selected = null;
    storeState.stores = STORES;
    blocksByDay["2026-11-20"] = [
      ...blocksByDay["2026-11-20"],
      block("blk-s2", { storeId: "s2", storeName: "駅前店", resourceId: "r2b", resourceName: "席B", titleSnapshot: "駅前の研修" }),
    ];
    renderPage();
    await eventButton(/^駅前の研修、/);
    expect(column("2026-11-20:s2")?.textContent).toContain("駅前の研修");
    expect(column("2026-11-20:s1")?.textContent).not.toContain("駅前の研修");
  });

  it("見られる店舗が1つだけなら、その店舗を選んだ状態として扱い、案内を出さない", async () => {
    storeState.selected = null;
    storeState.stores = STORES.slice(0, 1);
    renderPage();
    expect(await screen.findByRole("button", { name: "11月16日（月）の日表示を開く" })).toBeTruthy();
    expect(screen.queryByText(/週表示は店舗を1つ選ぶと使えます/)).toBeNull();
  });
});

describe("ScheduleV2Page の空き枠からの予約作成", () => {
  const openSlot = async (name: string) => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name }));
  };

  it("日表示では押した列の店舗と時刻を引き継ぎ、稼働中のリソースが1つならそれを選ぶ", async () => {
    storeState.selected = null;
    storeState.stores = STORES;
    await openSlot("11月20日（金） 15:00 本店に予約を追加");
    expect(captured.create).toMatchObject({ defaultStoreId: "s1", defaultResourceId: "r1", defaultMinutes: 900 });
    expect(formatJstDate(captured.create?.defaultDate as Date)).toBe("2026-11-20");
  });

  it("稼働中のリソースが2つ以上なら、作成画面で選ばせる", async () => {
    storeState.selected = null;
    storeState.stores = STORES;
    await openSlot("11月20日（金） 15:00 駅前店に予約を追加");
    expect(captured.create).toMatchObject({ defaultStoreId: "s2", defaultResourceId: null, defaultMinutes: 900 });
  });

  it("稼働中のリソースが無い店舗には空き枠を出さず、理由を示す", async () => {
    storeState.selected = null;
    storeState.stores = STORES;
    renderPage();
    expect(await screen.findByText(/東口店には予約を受ける枠（リソース）がありません。/)).toBeTruthy();
    await waitFor(() => expect(slotsIn("2026-11-20:s1")).toBeGreaterThan(0));
    expect(slotsIn("2026-11-20:s3")).toBe(0);
  });

  it("週表示では押した日の日付を引き継ぐ", async () => {
    await openSlot("11月18日（水） 13:00 本店に予約を追加");
    expect(captured.create).toMatchObject({ defaultStoreId: "s1", defaultResourceId: "r1", defaultMinutes: 780 });
    expect(formatJstDate(captured.create?.defaultDate as Date)).toBe("2026-11-18");
  });
});

describe("ScheduleV2Page の取得失敗と件数の上限 (UX-21)", () => {
  it("予約の取得に失敗した日は文字で示し、その日に空き枠を出さない", async () => {
    failingDays.add("2026-11-18");
    const user = userEvent.setup();
    renderPage();
    expect(
      await screen.findByText(/11月18日（水）の予約の読み込みに失敗しました。/),
    ).toBeTruthy();
    await waitFor(() => expect(slotsIn("2026-11-19:s1")).toBeGreaterThan(0));
    expect(slotsIn("2026-11-18:s1")).toBe(0);
    const before = mocks.api.get.mock.calls.length;
    failingDays.clear();
    await user.click(screen.getByRole("button", { name: "再読み込み" }));
    await waitFor(() => expect(slotsIn("2026-11-18:s1")).toBeGreaterThan(0));
    expect(mocks.api.get.mock.calls.slice(before).some(([url]) => String(url).includes("date=2026-11-18"))).toBe(true);
  });

  it("200件ちょうど返った日は欠けている恐れとして扱い、空き枠を出さない", async () => {
    reservationsByDay["2026-11-19"] = Array.from({ length: 200 }, (_, index) =>
      reservation(`many-${index}`, "2026-11-19", "09:00", "09:05", { storeId: "s2" }),
    );
    renderPage();
    expect(await screen.findByText(/11月19日（木）の予定が表示できる上限の件数に達しました。/)).toBeTruthy();
    // The week's day header says it too, in words and in its name.
    expect(screen.getByRole("button", { name: "11月19日（木）の日表示を開く（上限到達）" }).textContent).toContain("上限到達");
    // Only the capped day stops offering slots.
    await waitFor(() => expect(slotsIn("2026-11-20:s1")).toBeGreaterThan(0));
    expect(slotsIn("2026-11-19:s1")).toBe(0);
  });

  it("店舗設定が読めないと、どの日にも空き枠を出さない", async () => {
    settingsFail = true;
    renderPage();
    expect(await screen.findByText(/店舗設定の読み込みに失敗しました。空き状況を表示できません。/)).toBeTruthy();
    await eventButton(/^山田 花子、/);
    expect(document.querySelectorAll("[data-slot-minutes]")).toHaveLength(0);
  });
});

describe("ScheduleV2Page の予約と外部予定", () => {
  it("予約を押すと今の詳細を開き、開いている間はページ移動を止める", async () => {
    const shell = fakeShell();
    const user = userEvent.setup();
    renderPage({ shell });
    await user.click(await eventButton(/^山田 花子、/));
    expect(screen.getByTestId("detail-id").textContent).toBe("res-a");
    expect(shell.calls.blocked.at(-1)).toBe(true);
    act(() => captured.detail?.onClose());
    await waitFor(() => expect(shell.calls.blocked.at(-1)).toBe(false));
  });

  it("止めた枠に残る予約も店の列に出し、押すと詳細を開く（UX-16）", async () => {
    reservationsByDay["2026-11-20"] = [
      ...reservationsByDay["2026-11-20"],
      reservation("res-off", "2026-11-20", "15:00", "16:00", { resourceId: "r1-off", resourceName: "旧席", customerDisplayName: "旧席 花子" }),
    ];
    const user = userEvent.setup();
    renderPage();
    const event = await eventButton(/^旧席 花子、/);
    expect(column("2026-11-20:s1")?.contains(event)).toBe(true);
    await user.click(event);
    expect(captured.detail?.reservationId).toBe("res-off");
  });

  it("詳細を開いている間は押した予約に選択の印を付け、閉じると外す", async () => {
    const user = userEvent.setup();
    renderPage();
    const event = await eventButton(/^山田 花子、/);
    expect(event.getAttribute("aria-expanded")).toBe("false");
    await user.click(event);
    expect((await eventButton(/^山田 花子、/)).getAttribute("aria-expanded")).toBe("true");
    act(() => captured.detail?.onClose());
    expect((await eventButton(/^山田 花子、/)).getAttribute("aria-expanded")).toBe("false");
  });

  it("サイドバーを常に出す広い画面では、押した予約の隣に小窓で開く", async () => {
    const user = userEvent.setup();
    renderPage();
    const event = await eventButton(/^山田 花子、/);
    event.getBoundingClientRect = () => new DOMRect(300, 200, 120, 40);
    await user.click(event);
    expect(captured.detail?.layout).toBe("popover");
    expect(xywh(captured.detail?.anchor?.current?.getBoundingClientRect())).toEqual({ x: 300, y: 200, width: 120, height: 40 });
  });

  // Switching the container while open would mount a second modal over an open
  // confirmation (the discard check) and drop focus out of it.
  it("開いている間は幅が 64rem をまたいでも詳細の出し方を変えず、次に開くときに選び直す", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await eventButton(/^山田 花子、/));
    expect(captured.detail?.layout).toBe("popover");
    docked = false;
    act(() => refreshPage());
    expect(captured.detail?.layout).toBe("popover");
    act(() => captured.detail?.onClose());
    await user.click(await eventButton(/^山田 花子、/));
    expect(captured.detail?.layout).toBe("bottom");
  });

  it("サイドバーが引き出しになる幅（iPad の縦など）では、下から開くシートにする", async () => {
    docked = false;
    const user = userEvent.setup();
    renderPage();
    await user.click(await eventButton(/^山田 花子、/));
    expect(captured.detail?.layout).toBe("bottom");
  });

  it("手作業のブロックは権限があれば取消の確認を開き、Google の予定は押せない", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await eventButton(/^研修、11月20日（金）、16:00から17:00、ブロック$/));
    expect(screen.getByRole("alertdialog", { name: "ブロックを取消しますか?" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Googleカレンダー/ })).toBeNull();
    expect(screen.getByText("外部予定、11月20日（金）、18:00から19:00、Googleカレンダー")).toBeTruthy();
  });

  it("スタッフには手作業のブロックも押させない", async () => {
    auth.privileged = false;
    renderPage();
    await eventButton(/^山田 花子、/);
    expect(screen.queryByRole("button", { name: /^研修、/ })).toBeNull();
    expect(screen.getByText("研修、11月20日（金）、16:00から17:00、ブロック")).toBeTruthy();
  });
});

describe("ScheduleV2Page の作成の入口", () => {
  it("サイドバーの「予約を追加」は、表示中の店舗と日で作成画面を開き、閉じたらそのボタンへ戻る", async () => {
    const shell = fakeShell();
    const user = userEvent.setup();
    renderPage({ shell });
    const create = await within(shell.sidebarSlots.top).findByRole("button", { name: "予約を追加" });
    await user.click(create);
    // Opened from the drawer, the drawer shuts first (one modal at a time).
    expect(shell.closeMenu).toHaveBeenCalled();
    expect(captured.create).toMatchObject({ defaultStoreId: "s1", defaultResourceId: null, defaultMinutes: null });
    expect(formatJstDate(captured.create?.defaultDate as Date)).toBe("2026-11-20");
    act(() => (captured.create?.onClose as () => void)());
    await waitFor(() => expect(document.activeElement).toBe(create));
  });

  it("＋ボタンはサイドバーが引き出しのときに出し、同じ作成画面を開く", async () => {
    docked = false;
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "予約を追加" }));
    expect(captured.create).toMatchObject({ defaultStoreId: "s1", defaultResourceId: null, defaultMinutes: null });
  });

  it("サイドバーを常に出す幅では＋ボタンを出さない", async () => {
    renderPage();
    await eventButton(/^山田 花子、/);
    expect(screen.queryByRole("button", { name: "予約を追加" })).toBeNull();
  });
});

describe("ScheduleV2Page の表示する予定", () => {
  const layer = (shell: ReturnType<typeof fakeShell>, name: string) =>
    within(shell.sidebarSlots.end).getByRole("checkbox", { name });

  it("承認待ちを外すと承認待ちの予約だけを隠し、空き枠の数は変えない", async () => {
    const shell = fakeShell();
    const user = userEvent.setup();
    renderPage({ shell });
    await eventButton(/^佐藤 一郎、/);
    const slots = slotsIn("2026-11-20:s1");
    await user.click(layer(shell, "承認待ち"));
    expect(screen.queryByRole("button", { name: /^佐藤 一郎、/ })).toBeNull();
    expect(screen.getByRole("button", { name: /^山田 花子、/ })).toBeTruthy();
    expect(slotsIn("2026-11-20:s1")).toBe(slots);
    // Its time does not look free: a plain band covers the slots there (10:30-11:30),
    // as the booking did.
    const bands = column("2026-11-20:s1")?.querySelectorAll<HTMLElement>("[data-hidden-item]") ?? [];
    expect([...bands].map((band) => [band.textContent, band.style.top, band.style.height])).toEqual([
      ["非表示の予定", `${630 * PX_PER_MINUTE}px`, `${60 * PX_PER_MINUTE}px`],
    ]);
    // The band itself is a plain box at the event's time, which takes the presses;
    // its look is inside and takes none. The edge is the outline color, which
    // test/admin-calendar-tokens.test.ts keeps 3:1 on the surface.
    expect(bands[0]?.className).toBe("absolute inset-x-0 z-10 overflow-hidden");
    const look = bands[0]?.firstElementChild;
    expect(["pointer-events-none", "border-cal-outline"].map((name) => look?.classList.contains(name))).toEqual([true, true]);
    // The band is not read out: the slots it covers say so, and only those.
    const covered = "11月20日（金） 10:30 本店に予約を追加（この時間には非表示の予定があります）";
    expect(screen.getByRole("button", { name: covered })).toBeTruthy();
    expect(screen.getByRole("button", { name: "11月20日（金） 11:15 本店に予約を追加（この時間には非表示の予定があります）" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "11月20日（金） 10:15 本店に予約を追加" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "11月20日（金） 11:30 本店に予約を追加" })).toBeTruthy();
    await user.click(layer(shell, "承認待ち"));
    expect(screen.getByRole("button", { name: /^佐藤 一郎、/ })).toBeTruthy();
    expect(column("2026-11-20:s1")?.querySelectorAll("[data-hidden-item]")).toHaveLength(0);
    expect(screen.getByRole("button", { name: "11月20日（金） 10:30 本店に予約を追加" })).toBeTruthy();
  });

  it("Googleカレンダーの予定を外すと Google の予定だけを隠し、店のブロックは残す", async () => {
    const shell = fakeShell();
    const user = userEvent.setup();
    renderPage({ shell });
    expect(await screen.findByText("外部予定、11月20日（金）、18:00から19:00、Googleカレンダー")).toBeTruthy();
    const slots = slotsIn("2026-11-20:s1");
    await user.click(layer(shell, "Googleカレンダーの予定"));
    expect(screen.queryByText("外部予定、11月20日（金）、18:00から19:00、Googleカレンダー")).toBeNull();
    expect(screen.getByRole("button", { name: /^研修、/ })).toBeTruthy();
    expect(slotsIn("2026-11-20:s1")).toBe(slots);
    expect(screen.getByRole("button", { name: "11月20日（金） 18:00 本店に予約を追加（この時間には非表示の予定があります）" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "11月20日（金） 17:45 本店に予約を追加" })).toBeTruthy();
  });

  // The band is at the event's own time, not stretched like a short booking: what it
  // takes presses on is what the slots' names say (10:10-10:15 leaves 10:15 free).
  it("短い Google の予定を外すと、帯はその時間だけに描き、直後の空き枠はふさがない", async () => {
    blocksByDay["2026-11-20"] = [
      ...blocksByDay["2026-11-20"],
      block("blk-short", { source: "google_calendar", titleSnapshot: "電話", startAt: jst("2026-11-20", "10:10"), endAt: jst("2026-11-20", "10:15") }),
    ];
    const shell = fakeShell();
    const user = userEvent.setup();
    renderPage({ shell });
    await screen.findByText("電話、11月20日（金）、10:10から10:15、Googleカレンダー");
    await user.click(layer(shell, "Googleカレンダーの予定"));
    const bands = [...(column("2026-11-20:s1")?.querySelectorAll<HTMLElement>("[data-hidden-item]") ?? [])];
    const short = bands.find((band) => band.style.top === `${610 * PX_PER_MINUTE}px`);
    expect([short?.style.height, short?.textContent]).toEqual([`${5 * PX_PER_MINUTE}px`, ""]);
    expect(screen.getByRole("button", { name: "11月20日（金） 10:00 本店に予約を追加（この時間には非表示の予定があります）" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "11月20日（金） 10:15 本店に予約を追加" })).toBeTruthy();
  });

  it("Googleカレンダーの予定を外しても Google 以外の外部のブロックは残し、Google の印も付けない", async () => {
    blocksByDay["2026-11-20"] = [
      ...blocksByDay["2026-11-20"],
      block("blk-sys", { source: "system_revert", titleSnapshot: "戻した枠", startAt: jst("2026-11-20", "08:00"), endAt: jst("2026-11-20", "09:00") }),
    ];
    const shell = fakeShell();
    const user = userEvent.setup();
    renderPage({ shell });
    expect(await screen.findByText("戻した枠、11月20日（金）、08:00から09:00、ブロック")).toBeTruthy();
    await user.click(layer(shell, "Googleカレンダーの予定"));
    expect(screen.getByText("戻した枠、11月20日（金）、08:00から09:00、ブロック")).toBeTruthy();
  });

  it("一覧でも承認待ちを隠し、その日を「予約はありません」とは言わずに隠した件数を伝える", async () => {
    narrow = true;
    reservationsByDay["2026-11-20"] = [
      reservation("res-b", "2026-11-20", "10:30", "11:30", { status: "pending_approval", customerDisplayName: "佐藤 一郎" }),
    ];
    const shell = fakeShell();
    const user = userEvent.setup();
    renderPage({ shell });
    expect(await within(shownBody()).findByText("佐藤 一郎")).toBeTruthy();
    await user.click(layer(shell, "承認待ち"));
    expect(within(shownBody()).queryByText("佐藤 一郎")).toBeNull();
    expect(within(shownBody()).queryByText("この日の予約はありません")).toBeNull();
    expect(within(shownBody()).getByText("承認待ちの予約1件を「表示する予定」で隠しています。")).toBeTruthy();
  });
});

describe("ScheduleV2Page の上部バー", () => {
  it("外枠に自分のバーを知らせ、外枠のメニューのボタンを持つ", async () => {
    const shell = fakeShell();
    const user = userEvent.setup();
    renderPage({ shell });
    expect(shell.calls.ownTopBar).toEqual([true]);
    await user.click(screen.getByRole("button", { name: "メニュー" }));
    expect(shell.openMenu).toHaveBeenCalled();
  });

  it("承認待ちの件数は選んでいる店舗の分を出し、一覧から選ぶとその日へ移って詳細を開く", async () => {
    // Next week's Thursday, so moving there changes the shown columns; the other
    // store's one is not counted for 本店.
    pendingRows = [
      reservation("res-b", "2026-11-26", "10:30", "11:30", { status: "pending_approval" }),
      reservation("res-p2", "2026-11-21", "12:00", "13:00", { status: "pending_approval", storeId: "s2" }),
    ];
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "承認待ち 1件" }));
    await user.click(screen.getByRole("button", { name: "承認待ちの予約（s1）" }));
    expect(screen.getByTestId("detail-id").textContent).toBe("res-b");
    await waitFor(() => expect(column("2026-11-26:s1")).toBeTruthy());
    expect(column("2026-11-20:s1")).toBeFalsy();
    expect(captured.detail?.reservationId).toBe("res-b");
  });

  it("承認待ちの一覧から開いた詳細は、承認待ちのボタンの隣に開く", async () => {
    const user = userEvent.setup();
    renderPage();
    const pending = await screen.findByRole("button", { name: "承認待ち 1件" });
    pending.getBoundingClientRect = () => new DOMRect(900, 10, 80, 40);
    await user.click(pending);
    await user.click(screen.getByRole("button", { name: "承認待ちの予約（s1）" }));
    expect(xywh(captured.detail?.anchor?.current?.getBoundingClientRect())).toEqual({ x: 900, y: 10, width: 80, height: 40 });
  });

  it("カルテの次回予約から来ると、その顧客で作成画面を開く", async () => {
    renderPage({ state: { rebook: { id: "c-9", displayName: "鈴木 次回" } } });
    await waitFor(() => expect(captured.create).not.toBeNull());
    expect(captured.create?.defaultCustomer).toEqual({ id: "c-9", displayName: "鈴木 次回" });
  });
});

describe("ScheduleV2Page の狭い画面", () => {
  it("予定一覧から始め、週のボタンを出さず、予約を時刻順に並べる", async () => {
    narrow = true;
    storeState.selected = null;
    storeState.stores = STORES;
    renderPage();
    const list = await screen.findByRole("region", { name: "選択日の予約" });
    await waitFor(() => expect(within(list).getAllByRole("listitem")).toHaveLength(3));
    expect(within(list).getAllByRole("listitem").map((item) => item.textContent?.match(/山田|佐藤|駅前/)?.[0])).toEqual([
      "山田",
      "佐藤",
      "駅前",
    ]);
    expect(screen.queryByRole("button", { name: "週" })).toBeNull();
    expect(screen.getByRole("button", { name: "一覧" }).getAttribute("aria-pressed")).toBe("true");
  });
});

describe("ScheduleV2Page の描き方の細部", () => {
  it("開く位置は営業開始の30分前にし、9時より遅く開く店舗でも9時で止めない", async () => {
    renderPage();
    await eventButton(/^山田 花子、/);
    // 10:00 opening, at 48px an hour.
    expect((document.querySelector("[data-calendar-scroll]") as HTMLElement).scrollTop).toBe(456);
  });

  it("24時の直前の予定も最小の高さで描き、上へ寄せる", async () => {
    blocksByDay["2026-11-20"].push(
      block("blk-late", { titleSnapshot: "片付け", startAt: jst("2026-11-20", "23:55"), endAt: jst("2026-11-21", "00:00") }),
    );
    renderPage();
    const late = await eventButton(/^片付け、/);
    expect(late.style.height).toBe("18px");
    expect(late.style.top).toBe(`${24 * 48 - 18}px`);
  });

  it("外部の予定は色だけでなく、管理元を文字で示す", async () => {
    renderPage();
    await eventButton(/^山田 花子、/);
    const google = screen.getByText("外部予定、11月20日（金）、18:00から19:00、Googleカレンダー").parentElement as HTMLElement;
    expect(google.textContent).toContain("Google");
    // 16:00-17:00 is 48px: the marker and the title share one line.
    expect((await eventButton(/^研修、/)).textContent).toBe("ブロック・研修16:00–17:00");
  });

  it("選んでいる表示は塗りの色に加えて印で示す", async () => {
    renderPage();
    const chosen = await screen.findByRole("button", { name: "週", pressed: true });
    expect(chosen.querySelector("[data-chosen-mark]")).not.toBeNull();
    expect(screen.getByRole("button", { name: "日", pressed: false }).querySelector("[data-chosen-mark]")).toBeNull();
  });

  it("今日の分は30秒ごと、ほかの日は2分ごとに取り直す", async () => {
    const { client } = renderPage();
    await eventButton(/^山田 花子、/);
    const interval = (day: string) =>
      client.getQueryCache().find({ queryKey: ["reservations", day] })?.observers[0]?.options.refetchInterval;
    expect(interval("2026-11-20")).toBe(30_000);
    expect(interval("2026-11-18")).toBe(120_000);
    const blockInterval = client.getQueryCache().find({ queryKey: ["external-blocks", "2026-11-18"] })?.observers[0]?.options.refetchInterval;
    expect(blockInterval).toBe(120_000);
  });
});

describe("ScheduleV2Page のフォーカス (UX-22)", () => {
  it("詳細を閉じると、開いた予約へフォーカスを戻す", async () => {
    const user = userEvent.setup();
    renderPage();
    const event = await eventButton(/^山田 花子、/);
    await user.click(event);
    screen.getByRole("button", { name: "詳細の中のボタン" }).focus();
    act(() => captured.detail?.onClose());
    await waitFor(() => expect(document.activeElement).toBe(event));
  });

  it("開いた空き枠が消えていたら、予定表へフォーカスを移す", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "11月18日（水） 13:00 本店に予約を追加" }));
    // The mocked form leaves the page usable: moving to the next week removes the slot.
    await user.click(screen.getByRole("button", { name: "次の週" }));
    act(() => (captured.create?.onClose as () => void)());
    await waitFor(() => expect(document.activeElement).toBe(document.querySelector("[data-calendar-scroll]")));
  });

  it("週の日付の見出しで日表示を開くと、その日の見出しへフォーカスを移す", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "11月18日（水）の日表示を開く" }));
    expect(document.activeElement).toBe(screen.getByRole("heading", { level: 1 }));
  });

  it("再読み込みを押すと、消えるボタンの代わりに見出しへフォーカスを移す", async () => {
    failingDays.add("2026-11-18");
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "再読み込み" }));
    expect(document.activeElement).toBe(screen.getByRole("heading", { level: 1 }));
  });

  it("矢印で動いた空き枠が、次に Tab で戻る入口になる", async () => {
    const user = userEvent.setup();
    renderPage();
    const entry = await screen.findByRole("button", { name: "11月19日（木） 10:00 本店に予約を追加" });
    expect(entry.tabIndex).toBe(0);
    entry.focus();
    await user.keyboard("{ArrowDown}");
    const next = screen.getByRole("button", { name: "11月19日（木） 10:15 本店に予約を追加" });
    expect(document.activeElement).toBe(next);
    expect(next.tabIndex).toBe(0);
    expect(entry.tabIndex).toBe(-1);
  });

  it("上部バーのページ移動は外枠に開かせ、押したボタンを渡す", async () => {
    const shell = fakeShell();
    const user = userEvent.setup();
    renderPage({ shell });
    const button = screen.getByRole("button", { name: "ページ移動 (Cmd/Ctrl+K)" });
    await user.click(button);
    expect(shell.openPalette).toHaveBeenCalledWith(button);
  });
});

describe("ScheduleV2Page の日付の追従", () => {
  const wake = (iso: string) => {
    vi.setSystemTime(new Date(iso));
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
  };

  it("今日を開いたままJSTの午前0時を越えると、次の日へ進む", async () => {
    vi.setSystemTime(new Date("2026-11-20T14:59:50Z"));
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "日" }));
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("11月20日（金）");
    wake("2026-11-20T15:00:10Z");
    await waitFor(() => expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("11月21日（土）"));
  });

  it("手で選んだ日は、午前0時を越えても動かさない", async () => {
    vi.setSystemTime(new Date("2026-11-20T14:59:50Z"));
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "日" }));
    await user.click(screen.getByRole("button", { name: "次の日" }));
    await user.click(screen.getByRole("button", { name: "次の日" }));
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("11月22日（日）");
    wake("2026-11-20T15:00:10Z");
    // Give the effect a chance to run before asserting nothing moved.
    await act(async () => Promise.resolve());
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("11月22日（日）");
  });
});

describe("ScheduleV2Page の空き枠と予約の描き方 (Codex の指摘)", () => {
  const slotNames = (key: string) =>
    [...(column(key)?.querySelectorAll<HTMLElement>("[data-slot-minutes]") ?? [])].map((slot) => Number(slot.dataset.slotMinutes));

  it("描いた営業時間外には空き枠を出さず、予約のある時間の判断は作成画面に任せる", async () => {
    renderPage();
    await waitFor(() => expect(slotNames("2026-11-20:s1").length).toBeGreaterThan(0));
    const open = slotNames("2026-11-20:s1");
    // Opening hours are 10:00 to 19:00. A booked time is still offered: another
    // resource or a shorter menu may fit, and the form lists the server's times.
    expect(open[0]).toBe(600);
    expect(open).not.toContain(585);
    expect(open).toContain(960);
    expect(open).toContain(1080);
    expect(open.at(-1)).toBe(1125);
  });

  it("休業の時間には空き枠を出さず、休業と示す", async () => {
    closures = [{ id: "cl-1", storeId: "s1", startsAt: jst("2026-11-19", "00:00"), endsAt: jst("2026-11-20", "00:00"), reason: "研修日", source: "admin" }];
    renderPage();
    await waitFor(() => expect(slotNames("2026-11-20:s1").length).toBeGreaterThan(0));
    expect(slotNames("2026-11-19:s1")).toEqual([]);
    expect(within(column("2026-11-19:s1") as HTMLElement).getByText("休業（研修日）")).toBeTruthy();
  });

  it("休業の一覧が上限に届いた店舗は、どの日も空き枠を止めて理由を示す", async () => {
    // All before the shown week: a cut-off older closure could still be long
    // enough to reach it, so the newest starts do not tell which days are safe.
    closures = Array.from({ length: 200 }, (_, index) => ({
      id: `cl-${index}`,
      storeId: "s1",
      startsAt: new Date(Date.parse(jst("2026-01-01", "00:00")) + index * 86_400_000).toISOString(),
      endsAt: new Date(Date.parse(jst("2026-01-01", "01:00")) + index * 86_400_000).toISOString(),
      reason: null,
      source: "google_external_block",
    }));
    renderPage();
    expect(await screen.findByText(/本店の休業が読み込める上限の件数に達しました。/)).toBeTruthy();
    expect(document.querySelectorAll("[data-slot-minutes]")).toHaveLength(0);
  });

  it("来店中と完了は、色だけでなく文字でも示す", async () => {
    reservationsByDay["2026-11-21"] = [
      reservation("res-in", "2026-11-21", "13:00", "14:05", { status: "checked_in", customerDisplayName: "来店 花子" }),
      reservation("res-done", "2026-11-21", "15:00", "16:05", { status: "completed", customerDisplayName: "完了 一郎" }),
    ];
    renderPage();
    expect((await eventButton(/^来店 花子、/)).textContent).toContain("来店中");
    expect((await eventButton(/^完了 一郎、/)).textContent).toContain("完了");
  });

  it("清掃の時間を予約の中で別の帯として描く", async () => {
    renderPage();
    const booking = await eventButton(/^山田 花子、/);
    const band = booking.querySelector<HTMLElement>("[data-cleaning]");
    // 10:00 to 11:00 stored: 55 minutes of treatment, then 5 of cleaning.
    expect(band?.style.top).toBe("44px");
    expect(band?.style.height).toBe("4px");
    // The time shown on the block is the treatment's, not the slot's release.
    expect(booking.textContent).toContain("10:00–10:55");
    expect(booking.textContent).not.toContain("11:00");
  });

  it("短い予約にも清掃の帯を描き、占有5分の旧予約は施術0分として示す", async () => {
    reservationsByDay["2026-11-21"] = [
      reservation("res-short", "2026-11-21", "13:00", "13:20", { customerDisplayName: "短い 花子" }),
      reservation("res-old", "2026-11-21", "15:00", "15:05", { customerDisplayName: "旧 一郎" }),
    ];
    renderPage();
    const short = await eventButton(/^短い 花子、11月21日（土）、13:00から13:15（枠の解放 13:20）/);
    // 15 minutes of treatment, then 5 of cleaning, in a block drawn 18px tall.
    expect(short.querySelector<HTMLElement>("[data-cleaning]")?.style.top).toBe("12px");
    expect(short.querySelector<HTMLElement>("[data-cleaning]")?.style.height).toBe("4px");
    const old = await eventButton(/^旧 一郎、11月21日（土）、15:00から15:00（枠の解放 15:05）/);
    expect(old.querySelector<HTMLElement>("[data-cleaning]")?.style.top).toBe("0px");
  });

  it("DOM ではバーが予定表より先で、フォーカス中の空き枠は前に出ない（重なりの構造。当たり判定はブラウザで確認）", async () => {
    renderPage();
    await eventButton(/^山田 花子、/);
    // The slot under a booking keeps its place under it; only its ring (::after)
    // is raised, on a layer clicks pass through, so the booking takes its clicks.
    const slot = await screen.findByRole("button", { name: "11月20日（金） 10:00 本店に予約を追加" });
    expect(slot.className).not.toMatch(/(^|\s)focus-visible:z-/);
    expect(slot.className).toContain("focus-visible:after:pointer-events-none");
    // Two tones, and an outline that forced colors keep.
    expect(slot.className).toContain("focus-visible:after:outline-cal-surface");
    const bar = document.querySelector(".glass-thick") as HTMLElement;
    const scroller = document.querySelector("[data-calendar-scroll]") as HTMLElement;
    expect(bar.compareDocumentPosition(scroller) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Its own stacking context, so a focused slot (z-40) never draws over the bar
    // (checked in a browser: a slot scrolled under the bar no longer takes its clicks).
    expect(scroller.classList.contains("isolate")).toBe(true);
  });

  it("お知らせが増えても、高さを抑えてその中でスクロールさせる", async () => {
    failingDays.add("2026-11-18");
    renderPage();
    const alert = await screen.findByText(/11月18日（水）の予約の読み込みに失敗しました/);
    const strip = alert.closest(".overflow-y-auto") as HTMLElement;
    expect(strip.classList.contains("max-h-[40dvh]")).toBe(true);
  });
});

describe("ScheduleV2Page の一覧 (CodeRabbit の指摘)", () => {
  it("外部予定だけ取れなかった日でも、予約が0件と分かれば「予約はありません」と、読み上げの領域で示す", async () => {
    narrow = true;
    reservationsByDay["2026-11-20"] = [];
    failingBlockDays.add("2026-11-20");
    renderPage();
    const empty = await within(shownBody()).findByText("この日の予約はありません");
    expect(empty.closest("output")).not.toBeNull();
  });

  it("見られる店舗が無いときは、読み込みが済んだ後に「表示できる店舗がありません」と示す", async () => {
    storeState.selected = null;
    storeState.stores = [];
    const { client } = renderPage();
    // Only after the settings arrive: until then it says it is loading.
    await waitFor(() => expect(client.getQueryState(["settings"])?.status).toBe("success"));
    expect(within(shownBody()).getByText("表示できる店舗がありません。")).toBeTruthy();
    expect(screen.queryByText("予定を読み込み中…")).toBeNull();
  });

  it("上限のお知らせは、前から置いてある読み上げの領域の中身として入る", async () => {
    const { client } = renderPage();
    await eventButton(/^山田 花子、/);
    const region = document.querySelector("[data-calendar-notices] > output") as HTMLElement;
    expect(region.textContent).toBe("");
    truncatedBlockDays.add("2026-11-19");
    await act(() => client.invalidateQueries({ queryKey: ["external-blocks"] }));
    await waitFor(() => expect(region.textContent).toContain("11月19日（木）の予定が表示できる上限の件数に達しました。"));
    expect(region.isConnected).toBe(true);
  });

  it("上限のお知らせは、読み上げに割り込む alert にしない", async () => {
    truncatedBlockDays.add("2026-11-19");
    renderPage();
    const notice = await screen.findByText(/11月19日（木）の予定が表示できる上限の件数に達しました。/);
    expect(notice.closest('[role="alert"]')).toBeNull();
    expect(notice.closest("output")).not.toBeNull();
  });
});

describe("ScheduleV2Page の一覧 (Codex の指摘)", () => {
  it("件数の上限に届いた日は、選んだ店舗の予約が無くても「予約はありません」と言わない", async () => {
    narrow = true;
    reservationsByDay["2026-11-20"] = Array.from({ length: 200 }, (_, index) =>
      reservation(`many-${index}`, "2026-11-20", "09:00", "09:05", { storeId: "s2" }),
    );
    renderPage();
    expect(await screen.findByText(/11月20日（金）の予定が表示できる上限の件数に達しました。/)).toBeTruthy();
    expect(within(shownBody()).queryByText("この日の予約はありません")).toBeNull();
  });

  it("フォーカスが移らない押し方でも、詳細を閉じると押した「詳細」へ戻す", async () => {
    narrow = true;
    renderPage();
    const list = await screen.findByRole("region", { name: "選択日の予約" });
    await waitFor(() => expect(within(list).getAllByRole("button", { name: "詳細" }).length).toBeGreaterThan(0));
    const details = within(list).getAllByRole("button", { name: "詳細" })[0];
    // Safari does not focus a button on click; fireEvent leaves focus where it was.
    fireEvent.click(details);
    screen.getByRole("button", { name: "詳細の中のボタン" }).focus();
    act(() => captured.detail?.onClose());
    await waitFor(() => expect(document.activeElement).toBe(details));
  });
});

describe("ScheduleV2Page の最終レビュー (Codex の指摘)", () => {
  const nightBlock = (id: string, extra: Partial<ExternalBlock>) => {
    const row = block(id, { startAt: jst("2026-11-19", "22:00"), endAt: jst("2026-11-20", "02:00"), ...extra });
    // Listed by overlap, so the block comes with both days.
    blocksByDay["2026-11-19"] = [row];
    blocksByDay["2026-11-20"] = [...blocksByDay["2026-11-20"], row];
  };

  it("日をまたぐ外部予定は、各列で描いた区間を示し、読み上げは本当の日付と時刻で伝える", async () => {
    nightBlock("blk-night", { source: "google_calendar", titleSnapshot: "夜間" });
    renderPage();
    const label = "夜間、11月19日（木）、22:00から11月20日（金）02:00、Googleカレンダー";
    const friday = await waitFor(() => within(column("2026-11-20:s1") as HTMLElement).getByText(label).parentElement as HTMLElement);
    expect(friday.textContent).toContain("00:00–02:00");
    const thursday = within(column("2026-11-19:s1") as HTMLElement).getByText(label).parentElement as HTMLElement;
    expect(thursday.textContent).toContain("22:00–24:00");
  });

  it("日をまたぐブロックの取消の確認は、本当の日付と時刻を示す", async () => {
    nightBlock("blk-late", { titleSnapshot: "棚卸し", endAt: jst("2026-11-20", "01:00") });
    const user = userEvent.setup();
    renderPage();
    const buttons = await waitFor(() => {
      const found = within(column("2026-11-20:s1") as HTMLElement).getAllByRole("button", { name: /^棚卸し、/ });
      expect(found).toHaveLength(1);
      return found;
    });
    await user.click(buttons[0]);
    expect(screen.getByRole("alertdialog", { name: "ブロックを取消しますか?" }).textContent).toContain(
      "棚卸し（11月19日（木）、22:00から11月20日（金）01:00）を取消します。",
    );
  });

  it("承認待ちの一覧が上限に届いたら、店舗の件数を「以上」として示す", async () => {
    pendingRows = Array.from({ length: 200 }, (_, index) =>
      reservation(`p-${index}`, "2026-11-21", "12:00", "13:00", { status: "pending_approval", storeId: "s2" }),
    );
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "承認待ち 0件以上" }));
    // The shared card is told too, so it does not call the store's list empty.
    expect(screen.getByRole("button", { name: /^承認待ちの予約（s1）$/ }).dataset.listCapped).toBe("true");
  });

  it("営業時間が未設定の店舗には空き枠を出さず、設定と同じく予約を受け付けていないと示す", async () => {
    storeState.selected = null;
    storeState.stores = STORES;
    businessHours = weekOfHours("s1", "10:00", "19:00");
    renderPage();
    // 東口店 has no hours in the fixture either.
    expect(await screen.findByText(/駅前店・東口店は営業時間が未設定のため、予約を受け付けていません。/)).toBeTruthy();
    await waitFor(() => expect(slotsIn("2026-11-20:s1")).toBeGreaterThan(0));
    expect(slotsIn("2026-11-20:s2")).toBe(0);
  });

  it("終日休みの日があっても、開く位置は営業する日の開店に合わせる", async () => {
    businessHours = weekOfHours("s1", "13:00", "19:00").map((row) => (row.weekday === 0 ? { ...row, active: false } : row));
    renderPage();
    await eventButton(/^山田 花子、/);
    // 13:00 opening less 30 minutes, at 48px an hour; Sunday's closed day does not pull it to 09:00.
    expect((document.querySelector("[data-calendar-scroll]") as HTMLElement).scrollTop).toBe(600);
  });

  it("カルテの次回予約から開いた作成画面を閉じると、予定表へフォーカスを移す（StrictMode でも）", async () => {
    renderPage({ state: { rebook: { id: "c-9", displayName: "鈴木 次回" } }, strict: true });
    await waitFor(() => expect(captured.create).not.toBeNull());
    // The real form holds focus; leave it on <body> as closing that form would.
    act(() => (document.activeElement as HTMLElement | null)?.blur());
    act(() => (captured.create?.onClose as () => void)());
    await waitFor(() => expect(document.activeElement).toBe(document.querySelector("[data-calendar-scroll]")));
  });

  it("空き枠の高さは位置と同じく px で決め、文字の大きさで隣へはみ出さない", async () => {
    renderPage();
    const slot = await screen.findByRole("button", { name: "11月19日（木） 10:00 本店に予約を追加" });
    expect(slot.style.height).toBe("12px");
  });

  it("日と取得元が違う失敗は、別々の文で示す", async () => {
    failingDays.add("2026-11-16");
    failingBlockDays.add("2026-11-17");
    renderPage();
    expect(await screen.findByText("11月16日（月）の予約の読み込みに失敗しました。")).toBeTruthy();
    expect(await screen.findByText("11月17日（火）のブロックの読み込みに失敗しました。")).toBeTruthy();
  });

  it("同じ日でも、取得元ごとに初回の読み込みと更新を分けて示す", async () => {
    failingBlockDays.add("2026-11-18");
    const user = userEvent.setup();
    renderPage();
    expect(await screen.findByText("11月18日（水）のブロックの読み込みに失敗しました。")).toBeTruthy();
    // The bookings were shown once; now their refresh fails too.
    failingDays.add("2026-11-18");
    await user.click(screen.getByRole("button", { name: "再読み込み" }));
    expect(await screen.findByText("11月18日（水）の予約の更新・ブロックの読み込みに失敗しました。")).toBeTruthy();
  });

  it("外部予定の取得に失敗した日と、件数の上限に届いた日だけ空き枠を止める", async () => {
    failingBlockDays.add("2026-11-18");
    truncatedBlockDays.add("2026-11-19");
    renderPage();
    expect(await screen.findByText(/11月19日（木）の予定が表示できる上限の件数に達しました。/)).toBeTruthy();
    await waitFor(() => expect(slotsIn("2026-11-20:s1")).toBeGreaterThan(0));
    expect(slotsIn("2026-11-18:s1")).toBe(0);
    expect(slotsIn("2026-11-19:s1")).toBe(0);
  });
});

type PointerInit = { id?: number; type?: string; primary?: boolean };
const point = (kind: "pointerDown" | "pointerMove" | "pointerUp", target: Element, x: number, y: number, init: PointerInit = {}) =>
  fireEvent[kind](target, { pointerId: init.id ?? 1, pointerType: init.type ?? "touch", isPrimary: init.primary ?? true, clientX: x, clientY: y });
/** One finger from (x, 400) moved by (dx, dy) in two steps, then lifted. */
const swipe = (target: Element, dx: number, dy = 0, init: PointerInit & { x?: number } = {}) => {
  const x = init.x ?? 300;
  point("pointerDown", target, x, 400, init);
  point("pointerMove", target, x + dx / 2, 400 + dy / 2, init);
  point("pointerMove", target, x + dx, 400 + dy, init);
  point("pointerUp", target, x + dx, 400 + dy, init);
};
const scroller = () => document.querySelector("[data-calendar-scroll]") as HTMLElement;
const heading = () => screen.getByRole("heading", { level: 1 }).textContent;

describe("ScheduleV2Page のフリック（T006）", () => {
  it("日表示で内容を左へ送ると次の日、右へ送ると前の日へ動く", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "日" }));
    swipe(scroller(), -80);
    expect(heading()).toBe("11月21日（土）");
    swipe(scroller(), 80);
    swipe(scroller(), 80);
    expect(heading()).toBe("11月19日（木）");
  });

  it("週表示では 1 週ずつ動く", async () => {
    renderPage();
    await screen.findByRole("button", { name: "11月16日（月）の日表示を開く" });
    swipe(scroller(), -80);
    expect(screen.getByRole("button", { name: /^11月23日（月）の日表示を開く/ })).toBeTruthy();
    swipe(scroller(), 80);
    swipe(scroller(), 80);
    expect(screen.getByRole("button", { name: /^11月9日（月）の日表示を開く/ })).toBeTruthy();
  });

  it("年をまたいでも JST の日付で 1 日ずつ動く", async () => {
    // 00:30 on 1 January in JST, still 31 December in UTC.
    vi.setSystemTime(new Date("2026-12-31T15:30:00Z"));
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "日" }));
    expect(heading()).toBe("1月1日（金）");
    swipe(scroller(), 80);
    expect(heading()).toBe("12月31日（木）");
    expect(screen.getByText("2026年12月31日 (木)").getAttribute("aria-live")).toBe("polite");
    swipe(scroller(), -80);
    swipe(scroller(), -80);
    expect(heading()).toBe("1月2日（土）");
  });

  it("短い横の動き、縦や斜めの動きでは日付を変えない", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "日" }));
    swipe(scroller(), -50);
    swipe(scroller(), 30, 80);
    swipe(scroller(), 0, -120);
    expect(heading()).toBe("11月20日（金）");
  });

  it("マウスのドラッグ、画面の端から始めた操作、2本目の指が触れた操作では日付を変えない", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "日" }));
    swipe(scroller(), -120, 0, { type: "mouse" });
    swipe(scroller(), 120, 0, { x: 10 });
    point("pointerDown", scroller(), 300, 400);
    point("pointerMove", scroller(), 260, 400);
    point("pointerDown", scroller(), 500, 400, { id: 2, primary: false });
    point("pointerMove", scroller(), 200, 400);
    point("pointerUp", scroller(), 200, 400);
    expect(heading()).toBe("11月20日（金）");
  });

  it("予約の上で横に動かして離したあとは、その予約を開かない。次に触れたときは開く", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "日" }));
    const card = await eventButton(/^山田 花子、/);
    swipe(card, -30);
    // The click a touch produces carries its click count.
    fireEvent.click(card, { detail: 1 });
    expect(screen.queryByRole("dialog", { name: "予約の詳細" })).toBeNull();
    // A swipe whose touch produced no click: the next touch clears the guard.
    swipe(card, -30);
    point("pointerDown", card, 300, 400);
    point("pointerUp", card, 300, 400);
    fireEvent.click(card, { detail: 1 });
    expect(screen.getByRole("dialog", { name: "予約の詳細" })).toBeTruthy();
  });

  it("横に動かした直後でも、キーボードでのクリック（Enter）は予約を開く", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "日" }));
    const card = await eventButton(/^山田 花子、/);
    swipe(card, -30);
    fireEvent.click(card, { detail: 0 });
    expect(screen.getByRole("dialog", { name: "予約の詳細" })).toBeTruthy();
  });

  it("本文の外に2本目の指が触れても、そのフリックは止める", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "日" }));
    const title = screen.getByRole("heading", { level: 1 });
    point("pointerDown", scroller(), 300, 400);
    point("pointerMove", scroller(), 200, 400);
    point("pointerDown", title, 100, 40, { id: 2, primary: false });
    point("pointerUp", title, 100, 40, { id: 2, primary: false });
    point("pointerUp", scroller(), 200, 400);
    expect(heading()).toBe("11月20日（金）");
  });

  it("確定は指を離した位置の距離で決める", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "日" }));
    point("pointerDown", scroller(), 300, 400);
    point("pointerMove", scroller(), 215, 400);
    point("pointerUp", scroller(), 240, 400);
    expect(heading()).toBe("11月20日（金）");
    point("pointerDown", scroller(), 300, 400);
    point("pointerMove", scroller(), 240, 400);
    point("pointerUp", scroller(), 215, 400);
    expect(heading()).toBe("11月21日（土）");
  });

  it("向きが決まる前に指を離しても、離した位置で向きと距離を決める", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "日" }));
    point("pointerDown", scroller(), 300, 400);
    point("pointerMove", scroller(), 294, 400);
    point("pointerUp", scroller(), 215, 400);
    expect(heading()).toBe("11月21日（土）");
  });

  it("横の動きが止まってから縦にだけ動いて離した指は、止めたものとする", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "日" }));
    wide();
    point("pointerDown", scroller(), 300, 400);
    vi.setSystemTime(Date.now() + 20);
    point("pointerMove", scroller(), 230, 400);
    vi.setSystemTime(Date.now() + 51);
    point("pointerMove", scroller(), 230, 420);
    vi.setSystemTime(Date.now() + 1);
    // 70px, under 20% of 375px, and still sideways for 52ms: no flick.
    point("pointerUp", scroller(), 230, 420);
    expect(heading()).toBe("11月20日（金）");
  });

  it("止めてから短く速く払った指は、払った速さで決める", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "日" }));
    wide();
    point("pointerDown", scroller(), 300, 400);
    vi.setSystemTime(Date.now() + 130);
    point("pointerMove", scroller(), 300, 404);
    vi.setSystemTime(Date.now() + 20);
    point("pointerMove", scroller(), 270, 404);
    vi.setSystemTime(Date.now() + 10);
    // 30px in 20ms after holding still: a flick.
    point("pointerUp", scroller(), 270, 404);
    expect(heading()).toBe("11月21日（土）");
  });

  it("最後の動きから離れた位置で指を離したときは、その分も速さに入れる", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "日" }));
    point("pointerDown", scroller(), 300, 400);
    vi.setSystemTime(Date.now() + 50);
    point("pointerMove", scroller(), 295, 400);
    vi.setSystemTime(Date.now() + 10);
    // 45px in 60ms: a flick, though the last move alone was slow.
    point("pointerUp", scroller(), 255, 400);
    expect(heading()).toBe("11月21日（土）");
  });

  it("掴んでいた予約が描き直しで消えて捕捉を失ったら中止し、元の日のまま戻す（INT-10-02）", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "日" }));
    const lost = () => fireEvent(document, new PointerEvent("lostpointercapture", { pointerId: 1, bubbles: true }));
    const card = await eventButton(/^山田 花子、/);
    const title = screen.getByRole("heading", { level: 1 });
    point("pointerDown", card, 300, 400);
    point("pointerMove", card, 215, 400);
    card.remove();
    lost();
    point("pointerUp", title, 215, 400);
    expect(heading()).toBe("11月20日（金）");
    expect([...document.querySelectorAll<HTMLElement>("[data-swipe-pane]")].map((pane) => pane.style.transform)).toEqual(["", ""]);
    // After a normal lift the browser also releases the capture: nothing more happens.
    swipe(scroller(), -80);
    lost();
    expect(heading()).toBe("11月21日（土）");
  });

  it("画面の大きさが変わる・ウィンドウを離れる・画面が隠れると中止し、遅れて指を離しても動かさない（INT-10-04・05）", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "日" }));
    const panes = () => [...document.querySelectorAll<HTMLElement>("[data-swipe-pane]")].map((pane) => pane.style.transform);
    const interruptions: Array<[string, () => void]> = [
      ["resize", () => fireEvent(window, new Event("resize"))],
      ["blur", () => fireEvent(window, new Event("blur"))],
      [
        "hidden",
        () => {
          vi.spyOn(document, "hidden", "get").mockReturnValue(true);
          fireEvent(document, new Event("visibilitychange"));
        },
      ],
    ];
    for (const [name, interrupt] of interruptions) {
      point("pointerDown", scroller(), 300, 400);
      point("pointerMove", scroller(), 200, 400);
      interrupt();
      expect(panes(), name).toEqual(["", ""]);
      point("pointerUp", scroller(), 200, 400);
      expect(heading(), name).toBe("11月20日（金）");
      vi.restoreAllMocks();
    }
  });

  it("フリックの途中で本文の大きさが変わったら中止し、指を離しても動かさない（INT-10-04）", async () => {
    const resized: ResizeObserverCallback[] = [];
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: ResizeObserverCallback) {
          resized.push(callback);
        }
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "日" }));
    const panes = () => [...document.querySelectorAll<HTMLElement>("[data-swipe-pane]")].map((pane) => pane.style.transform);
    const report = () =>
      act(() => {
        for (const callback of resized) callback([], {} as ResizeObserver);
      });
    let width = 375;
    Object.defineProperty(scroller(), "clientWidth", { configurable: true, get: () => width });
    // A report with the same width (the first report, a change of height only) keeps the swipe.
    point("pointerDown", scroller(), 300, 400);
    point("pointerMove", scroller(), 200, 400);
    report();
    expect(panes()).toEqual(["translateX(-100px)", "translateX(-100px)"]);
    point("pointerUp", scroller(), 200, 400);
    expect(heading()).toBe("11月21日（土）");
    // A changed width seen while the finger is held still ends the swipe at once.
    point("pointerDown", scroller(), 300, 400);
    point("pointerMove", scroller(), 200, 400);
    width = 360;
    report();
    expect(panes()).toEqual(["", ""]);
    width = 375;
    point("pointerUp", scroller(), 200, 400);
    expect(heading()).toBe("11月21日（土）");
    // A width that differs where the finger lifts, before any observer has run.
    point("pointerDown", scroller(), 300, 400);
    point("pointerMove", scroller(), 200, 400);
    width = 360;
    point("pointerUp", scroller(), 200, 400);
    expect(heading()).toBe("11月21日（土）");
  });

  it("狭い画面の一覧でもフリックで日を送る", async () => {
    narrow = true;
    renderPage();
    await screen.findByRole("region", { name: "選択日の予約" });
    expect(heading()).toBe("11/20（金）");
    swipe(scroller(), -80);
    expect(heading()).toBe("11/21（土）");
  });

  it("指に合わせて中身と日付の行が動き、離すと戻る。動きを減らす設定では動かさない", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "日" }));
    const panes = () => [...document.querySelectorAll<HTMLElement>("[data-swipe-pane]")];
    point("pointerDown", scroller(), 300, 400);
    point("pointerMove", scroller(), 260, 400);
    expect(panes().map((pane) => pane.style.transform)).toEqual(["translateX(-40px)", "translateX(-40px)"]);
    point("pointerUp", scroller(), 260, 400);
    expect(panes().map((pane) => pane.style.transform)).toEqual(["", ""]);

    reduceMotion = true;
    point("pointerDown", scroller(), 300, 400, { id: 3 });
    point("pointerMove", scroller(), 200, 400, { id: 3 });
    expect(panes().map((pane) => pane.style.transform)).toEqual(["", ""]);
    point("pointerUp", scroller(), 200, 400, { id: 3 });
    expect(heading()).toBe("11月21日（土）");
  });

  it("設定が届くのと同じ描画で週を送っても、営業開始の位置で開く", async () => {
    // The settings never arrive by fetch here; they land in the cache in the
    // same render as the step, which is the order that once skipped the opening.
    mocks.api.get.mockImplementation((url: string) => (url.startsWith("/api/admin/settings") ? new Promise(() => {}) : respond(url)));
    const { client } = renderPage();
    await screen.findByRole("button", { name: "次の週" });
    notifyManager.setScheduler((callback) => callback());
    try {
      act(() => {
        client.setQueryData(["settings"], { ok: true, settings: settings() });
        fireEvent.click(screen.getByRole("button", { name: "次の週" }));
      });
    } finally {
      notifyManager.setScheduler((callback) => setTimeout(callback, 0));
    }
    await screen.findByRole("button", { name: /^11月23日（月）の日表示を開く/ });
    // 10:00 opening less 30 minutes, at 48px an hour.
    expect(scroller().scrollTop).toBe(456);
  });

  it("前後のボタンやフリックで期間を移っても、見ていた時間帯の位置を保つ（INT-01-05）", async () => {
    const user = userEvent.setup();
    renderPage();
    await eventButton(/^山田 花子、/);
    scroller().scrollTop = 700;
    await user.click(screen.getByRole("button", { name: "次の週" }));
    expect(scroller().scrollTop).toBe(700);
    swipe(scroller(), -80);
    expect(scroller().scrollTop).toBe(700);
  });
});

// jsdom has no Web Animations: a stand-in keeps each animation, so a test reads
// its keyframes, moves its clock and lets it finish.
type Glide = {
  keyframes: Keyframe[];
  options: KeyframeAnimationOptions;
  currentTime: number;
  onfinish: (() => void) | null;
  cancelled: boolean;
  cancel: () => void;
  finish: () => void;
};
let glides: Glide[] = [];
const flights = () => glides.filter((glide) => glide.options.fill === "forwards" && !glide.cancelled);
const xOf = (keyframe: Keyframe | undefined) => Number(/translateX\((-?[\d.e-]+)px\)/.exec(String(keyframe?.transform))?.[1]);
const paneTransforms = () => [...document.querySelectorAll<HTMLElement>("[data-swipe-pane]")].map((pane) => pane.style.transform);
const wide = () => Object.defineProperty(scroller(), "clientWidth", { configurable: true, get: () => 375 });
/** One finger moved by dx over ms in two steps, then lifted where it stopped. */
const flick = (dx: number, ms: number) => {
  point("pointerDown", scroller(), 300, 400);
  vi.setSystemTime(Date.now() + ms / 2);
  point("pointerMove", scroller(), 300 + dx / 2, 400);
  vi.setSystemTime(Date.now() + ms / 2);
  point("pointerMove", scroller(), 300 + dx, 400);
  point("pointerUp", scroller(), 300 + dx, 400);
};
const reservationReads = (date: string) =>
  mocks.api.get.mock.calls.filter(([url]) => url === `/api/admin/reservations?range=date&date=${date}`).length;
const blocksUrl = (date: string) => `/api/admin/external-blocks?from=${date}&to=${date}&status=active`;
const blockReads = (date: string) => mocks.api.get.mock.calls.filter(([url]) => url === blocksUrl(date)).length;
// The production client tries a failed read once more (lib/query-client.ts); here at once.
const retryOnce = () => new QueryClient({ defaultOptions: { queries: { retry: 1, retryDelay: 0 }, mutations: { retry: false } } });

describe("ScheduleV2Page のすべるフリック（T006 の 3 つ目）", () => {
  beforeEach(() => {
    glides = [];
    Object.defineProperty(HTMLElement.prototype, "animate", {
      configurable: true,
      value(keyframes: Keyframe[], options: KeyframeAnimationOptions) {
        const glide: Glide = {
          keyframes,
          options,
          currentTime: 0,
          onfinish: null,
          cancelled: false,
          cancel: () => {
            glide.cancelled = true;
          },
          finish: () => {
            glide.currentTime = Number(options.duration);
            glide.onfinish?.();
          },
        };
        glides.push(glide);
        return glide;
      },
    });
  });
  afterEach(() => {
    Reflect.deleteProperty(HTMLElement.prototype, "animate");
  });

  it("前後の日は左右に並べて見せるだけにし、読み上げ・フォーカス・押下の対象から外す", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "日" }));
    const side = (at: string) => document.querySelector<HTMLElement>(`[data-calendar-scroll] [data-period-side="${at}"]`) as HTMLElement;
    expect(side("-1").querySelector('[data-calendar-column="2026-11-19:s1"]')).not.toBeNull();
    expect(side("1").querySelector('[data-calendar-column="2026-11-21:s1"]')).not.toBeNull();
    for (const at of ["-1", "1"]) {
      expect(side(at).getAttribute("aria-hidden")).toBe("true");
      expect(side(at).hasAttribute("inert")).toBe(true);
    }
    expect(side("0").hasAttribute("inert")).toBe(false);
    // The bar's names come in with them: a strip of three there too.
    expect(document.querySelectorAll("[data-swipe-pane] > [data-period-side]")).toHaveLength(6);
    expect(screen.queryAllByRole("button", { name: /11月21日/ })).toHaveLength(0);
  });

  it("離すと指の速さのまま隣の日まですべり、着いたところで日付を変える", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "日" }));
    wide();
    const incoming = document.querySelector('[data-calendar-scroll] [data-period-side="1"]');
    flick(-100, 80);
    // The step waits for the landing, so its render never stalls the glide.
    expect(heading()).toBe("11月20日（金）");
    expect(flights()).toHaveLength(2);
    const [glide] = flights();
    // Its first frame is already a frame on from the lift, at the finger's 1.25px/ms or faster, short of the day.
    expect(-100 - xOf(glide.keyframes[0])).toBeGreaterThanOrEqual(1.25 * FRAME_MS);
    expect(xOf(glide.keyframes[0])).toBeGreaterThan(-200);
    expect(xOf(glide.keyframes.at(-1))).toBe(-375);
    act(() => glide.finish());
    expect(heading()).toBe("11月21日（土）");
    // The day that came in is the same element, now the shown one.
    expect(shownBody()).toBe(incoming);
    expect(paneTransforms()).toEqual(["", ""]);
    expect(flights()).toHaveLength(0);
  });

  it("短くても速く払えば隣の日へ、ゆっくり短く動かして止めてから離せば元の日へすべる", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "日" }));
    wide();
    flick(-40, 50);
    expect(xOf(flights()[0].keyframes.at(-1))).toBe(-375);
    act(() => flights()[0].finish());
    expect(heading()).toBe("11月21日（土）");
    flick(-40, 400);
    expect(xOf(flights()[0].keyframes.at(-1))).toBe(0);
    act(() => flights()[0].finish());
    expect(heading()).toBe("11月21日（土）");
    // Quick, then held still for more than 40ms before the lift.
    point("pointerDown", scroller(), 300, 400);
    vi.setSystemTime(Date.now() + 25);
    point("pointerMove", scroller(), 280, 400);
    vi.setSystemTime(Date.now() + 25);
    point("pointerMove", scroller(), 260, 400);
    vi.setSystemTime(Date.now() + 50);
    point("pointerUp", scroller(), 260, 400);
    expect(xOf(flights()[0].keyframes.at(-1))).toBe(0);
    act(() => flights()[0].finish());
    expect(heading()).toBe("11月21日（土）");
  });

  it("確定の距離を越えても、戻す向きに動かしながら離すと元の日へすべる", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "日" }));
    wide();
    point("pointerDown", scroller(), 300, 400);
    // A move a frame: out to 200, then back 2.5px a frame (about 0.15px/ms).
    for (const x of [280, 260, 240, 220, 200, 202.5, 205, 207.5, 210, 212.5, 215]) {
      vi.setSystemTime(Date.now() + 16);
      point("pointerMove", scroller(), x, 400);
    }
    point("pointerUp", scroller(), 215, 400);
    expect(xOf(flights()[0].keyframes.at(-1))).toBe(0);
    act(() => flights()[0].finish());
    expect(heading()).toBe("11月20日（金）");
  });

  it("指を止めて 160ms 後に戻して離しても、止める前の記録から戻す速さを求め、元の日へすべる", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "日" }));
    wide();
    point("pointerDown", scroller(), 300, 400);
    vi.setSystemTime(Date.now() + 60);
    point("pointerMove", scroller(), 150, 400);
    vi.setSystemTime(Date.now() + 160);
    point("pointerMove", scroller(), 168, 400);
    vi.setSystemTime(Date.now() + 5);
    point("pointerUp", scroller(), 168, 400);
    expect(xOf(flights()[0].keyframes.at(-1))).toBe(0);
  });

  it("止めて戻したあと、同じ横の位置のまま縦にだけ動いてから離しても、元の日へすべる", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "日" }));
    wide();
    point("pointerDown", scroller(), 300, 400);
    vi.setSystemTime(Date.now() + 60);
    point("pointerMove", scroller(), 150, 400);
    vi.setSystemTime(Date.now() + 160);
    point("pointerMove", scroller(), 168, 400);
    for (const y of [410, 420]) {
      vi.setSystemTime(Date.now() + 10);
      point("pointerMove", scroller(), 168, y);
    }
    vi.setSystemTime(Date.now() + 5);
    point("pointerUp", scroller(), 168, 420);
    expect(xOf(flights()[0].keyframes.at(-1))).toBe(0);
  });

  it("すべっている途中で触れると、その日に変わって指がその位置で掴み、触れただけでは何も押さない", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "日" }));
    wide();
    flick(-100, 80);
    const [glide] = flights();
    glide.currentTime = FRAME_MS * 3;
    const held = frameAt(glide.keyframes.map(xOf), FRAME_MS * 3) + 375;
    point("pointerDown", scroller(), 200, 400);
    expect(heading()).toBe("11月21日（土）");
    expect(paneTransforms()).toEqual([`translateX(${held}px)`, `translateX(${held}px)`]);
    point("pointerUp", scroller(), 200, 400);
    // Let go without moving: the strip goes back to the day now shown.
    expect(xOf(flights()[0].keyframes[0])).toBeLessThan(held);
    expect(xOf(flights()[0].keyframes.at(-1))).toBe(0);
    const slot = within(shownBody()).getAllByRole("button", { name: /に予約を追加$/ })[0];
    fireEvent.click(slot, { detail: 1 });
    expect(captured.create).toBeNull();
    act(() => flights()[0].finish());
    expect(heading()).toBe("11月21日（土）");
  });

  it("すべっている途中で掴んだ指が縦に動くか、ブラウザに引き取られたら、掴んだ日のまま帯を戻す", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "日" }));
    wide();
    const interruptions: Array<[string, () => void]> = [
      ["vertical", () => point("pointerMove", scroller(), 200, 440)],
      ["cancel", () => fireEvent.pointerCancel(scroller(), { pointerId: 1 })],
    ];
    for (const [index, [name, interrupt]] of interruptions.entries()) {
      flick(-100, 80);
      flights()[0].currentTime = FRAME_MS * 3;
      point("pointerDown", scroller(), 200, 400);
      interrupt();
      expect(xOf(flights()[0]?.keyframes.at(-1)), name).toBe(0);
      act(() => flights()[0].finish());
      point("pointerUp", scroller(), 200, 440);
      expect(paneTransforms(), name).toEqual(["", ""]);
      expect(heading(), name).toBe(index === 0 ? "11月21日（土）" : "11月22日（日）");
    }
  });

  it("掴んだ後は、掴んだ指の動いた量と速さで決め、引き継いだずれは出だしの位置にだけ使う", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "日" }));
    wide();
    flick(-100, 80);
    flights()[0].currentTime = FRAME_MS * 3;
    const held = frameAt(flights()[0].keyframes.map(xOf), FRAME_MS * 3) + 375;
    point("pointerDown", scroller(), 200, 400);
    point("pointerMove", scroller(), 187, 400);
    point("pointerUp", scroller(), 187, 400);
    // 13px is no swipe: the caught day stays, from where the strip was.
    expect(xOf(flights()[0].keyframes.at(-1))).toBe(0);
    expect(xOf(flights()[0].keyframes[0])).toBeLessThan(held - 13);
    act(() => flights()[0].finish());
    expect(heading()).toBe("11月21日（土）");
  });

  it("指を置いたまま前後のボタンで期間が変わったら、その指を離しても動かさない", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "日" }));
    wide();
    point("pointerDown", scroller(), 300, 400);
    point("pointerMove", scroller(), 200, 400);
    fireEvent.click(screen.getByRole("button", { name: "次の日" }));
    expect(heading()).toBe("11月21日（土）");
    expect(paneTransforms()).toEqual(["", ""]);
    point("pointerUp", scroller(), 200, 400);
    expect(flights()).toHaveLength(0);
    expect(heading()).toBe("11月21日（土）");
  });

  it("すべっている途中で画面の大きさが変わったら、すぐに着地させる", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "日" }));
    wide();
    flick(-100, 80);
    fireEvent(window, new Event("resize"));
    expect(heading()).toBe("11月21日（土）");
    expect(flights()).toHaveLength(0);
    expect(paneTransforms()).toEqual(["", ""]);
  });

  it("指で帯を動かしたまま本文の幅だけが変わったら、すべらせずにすぐ元へ戻す（INT-10-04）", async () => {
    const resized: ResizeObserverCallback[] = [];
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: ResizeObserverCallback) {
          resized.push(callback);
        }
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "日" }));
    let width = 375;
    Object.defineProperty(scroller(), "clientWidth", { configurable: true, get: () => width });
    point("pointerDown", scroller(), 300, 400);
    point("pointerMove", scroller(), 200, 400);
    width = 345;
    act(() => {
      for (const callback of resized) callback([], {} as ResizeObserver);
    });
    expect(flights()).toHaveLength(0);
    expect(paneTransforms()).toEqual(["", ""]);
    point("pointerUp", scroller(), 200, 400);
    expect(heading()).toBe("11月20日（金）");
  });

  it("横 wheel の 1 回の操作は、慣性がすべりをまたいでも 1 期間しか動かさない（INT-13-06）", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "日" }));
    wide();
    fireEvent.wheel(scroller(), { deltaX: 100 });
    expect(heading()).toBe("11月21日（土）");
    // Its momentum goes on, never 250ms apart, while a touch glides to the next day.
    flick(-100, 80);
    for (let i = 0; i < 4; i++) {
      await act(() => new Promise((resolve) => setTimeout(resolve, 100)));
      fireEvent.wheel(scroller(), { deltaX: 100 });
    }
    act(() => flights()[0].finish());
    expect(heading()).toBe("11月22日（日）");
    fireEvent.wheel(scroller(), { deltaX: 100 });
    expect(heading()).toBe("11月22日（日）");
  });

  it("すべりの間に始まった縦の wheel は、その操作の向きを縦に決め、着いたあとの横の入力でも期間を動かさない（INT-03-08）", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "日" }));
    wide();
    flick(-100, 80);
    expect(fireEvent.wheel(scroller(), { deltaY: 120 })).toBe(false);
    act(() => flights()[0].finish());
    expect(heading()).toBe("11月21日（土）");
    // The same gesture, with no 250ms gap, turns sideways after the landing.
    fireEvent.wheel(scroller(), { deltaX: 200 });
    expect(heading()).toBe("11月21日（土）");
  });

  it("すべっている間と、指で帯を動かしている間は、wheel を受け付けず、元の位置にあるときは受け付ける", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "日" }));
    wide();
    flick(-100, 80);
    expect(fireEvent.wheel(scroller(), { deltaY: 120 })).toBe(false);
    expect(fireEvent.wheel(scroller(), { deltaX: 200 })).toBe(false);
    // INT-05-04: ctrl + wheel is the browser's zoom, also while it glides.
    expect(fireEvent.wheel(scroller(), { deltaY: 120, ctrlKey: true })).toBe(true);
    act(() => flights()[0].finish());
    expect(heading()).toBe("11月21日（土）");
    point("pointerDown", scroller(), 300, 400);
    point("pointerMove", scroller(), 250, 400);
    expect(fireEvent.wheel(scroller(), { deltaY: 120 })).toBe(false);
    expect(fireEvent.wheel(scroller(), { deltaY: 120, ctrlKey: true })).toBe(true);
    point("pointerUp", scroller(), 250, 400);
    act(() => flights()[0]?.finish());
    expect(fireEvent.wheel(scroller(), { deltaY: 120 })).toBe(true);
    // A finger only resting on the body leaves the wheel to scroll.
    point("pointerDown", scroller(), 300, 400);
    expect(fireEvent.wheel(scroller(), { deltaY: 120 })).toBe(true);
    point("pointerUp", scroller(), 300, 400);
  });

  it("すべっている途中に本文の幅だけが変わっても、すぐに着地させる", async () => {
    const resized: ResizeObserverCallback[] = [];
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: ResizeObserverCallback) {
          resized.push(callback);
        }
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "日" }));
    let width = 375;
    Object.defineProperty(scroller(), "clientWidth", { configurable: true, get: () => width });
    flick(-100, 80);
    width = 345;
    act(() => {
      for (const callback of resized) callback([], {} as ResizeObserver);
    });
    expect(heading()).toBe("11月21日（土）");
    expect(flights()).toHaveLength(0);
  });

  it("掴み直して大きく引いても、帯は隣の期間より外へは出さない", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "日" }));
    wide();
    flick(-100, 80);
    flights()[0].currentTime = FRAME_MS * 3;
    point("pointerDown", scroller(), 50, 400);
    point("pointerMove", scroller(), 450, 400);
    expect(paneTransforms()).toEqual(["translateX(375px)", "translateX(375px)"]);
    point("pointerUp", scroller(), 450, 400);
    expect(Math.max(...flights()[0].keyframes.map(xOf))).toBeLessThanOrEqual(375);
  });

  it("向きが決まる前に離した速いフリックでも、スクロールした一覧の隣の日は上から見せてすべる", async () => {
    narrow = true;
    renderPage();
    await screen.findByRole("region", { name: "選択日の予約" });
    Object.defineProperty(scroller(), "clientWidth", { configurable: true, get: () => 375 });
    scroller().scrollTop = 300;
    point("pointerDown", scroller(), 300, 400);
    vi.setSystemTime(Date.now() + 40);
    point("pointerUp", scroller(), 250, 400);
    const contents = [...document.querySelectorAll<HTMLElement>("[data-swipe-from-top] > [data-period-side] > *")];
    expect(xOf(flights()[0].keyframes.at(-1))).toBe(-375);
    expect(contents.map((content) => content.style.transform)).toEqual(["translateY(300px)", "", "translateY(300px)"]);
    act(() => flights()[0].finish());
    const now = [...document.querySelectorAll<HTMLElement>("[data-swipe-from-top] > [data-period-side] > *")];
    expect(now.map((content) => content.style.transform)).toEqual(["", "", ""]);
    // The next day, drawn from its top, lands at the top.
    expect(scroller().scrollTop).toBe(0);
  });

  it("隣のまま残る日は、変更の後に期間を移っても読み直さない", async () => {
    const user = userEvent.setup();
    const { client } = renderPage();
    await user.click(await screen.findByRole("button", { name: "日" }));
    await waitFor(() => expect(reservationReads("2026-11-21")).toBe(1));
    await act(() => client.invalidateQueries({ queryKey: ["reservations"] }));
    await user.click(screen.getByRole("button", { name: "11月20日（金）" }));
    const calendar = await screen.findByRole("group", { name: "日付選択カレンダー" });
    await user.click(within(calendar).getByRole("button", { name: "2026年11月22日 (日)" }));
    expect(heading()).toBe("11月22日（日）");
    await waitFor(() => expect(reservationReads("2026-11-22")).toBe(2));
    expect(reservationReads("2026-11-21")).toBe(1);
  });

  it("戻る向きと逆に速く折り返して離しても、すべりは隣の期間より外へ出ない", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "日" }));
    wide();
    flick(-100, 80);
    point("pointerDown", scroller(), 220, 400);
    vi.setSystemTime(Date.now() + 50);
    point("pointerMove", scroller(), 115, 400);
    vi.setSystemTime(Date.now() + 8);
    point("pointerMove", scroller(), 215, 400);
    point("pointerUp", scroller(), 215, 400);
    const [glide] = flights();
    expect(xOf(glide.keyframes.at(-1))).toBe(0);
    expect(Math.max(...glide.keyframes.map(xOf))).toBeLessThanOrEqual(375);
  });

  it("行き先の期間が見える前に掴んだすべりは、その期間に切り替えずに掴む", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "日" }));
    wide();
    flick(-100, 80);
    // Caught at once: the next day is in view, so it is shown; the old day sits to the left.
    point("pointerDown", scroller(), 300, 400);
    expect(heading()).toBe("11月21日（土）");
    vi.setSystemTime(Date.now() + 10);
    point("pointerMove", scroller(), 277, 400);
    vi.setSystemTime(Date.now() + 10);
    point("pointerMove", scroller(), 254, 400);
    point("pointerUp", scroller(), 254, 400);
    // Flicked on toward the day after: caught again before that day comes into view.
    const [glide] = flights();
    expect(xOf(glide.keyframes.at(-1))).toBe(-375);
    const held = xOf(glide.keyframes[0]);
    expect(held).toBeGreaterThan(0);
    point("pointerDown", scroller(), 300, 400);
    expect(heading()).toBe("11月21日（土）");
    expect(paneTransforms()).toEqual([`translateX(${held}px)`, `translateX(${held}px)`]);
  });

  it("スクロールした一覧で離したときに初めて横と決まり、戻るときも、隣の日は上から見せる", async () => {
    narrow = true;
    renderPage();
    await screen.findByRole("region", { name: "選択日の予約" });
    Object.defineProperty(scroller(), "clientWidth", { configurable: true, get: () => 375 });
    scroller().scrollTop = 300;
    point("pointerDown", scroller(), 300, 400);
    point("pointerUp", scroller(), 280, 400);
    expect(xOf(flights()[0].keyframes.at(-1))).toBe(0);
    const contents = [...document.querySelectorAll<HTMLElement>("[data-swipe-from-top] > [data-period-side] > *")];
    expect(contents.map((content) => content.style.transform)).toEqual(["translateY(300px)", "", "translateY(300px)"]);
    act(() => flights()[0].finish());
    expect(contents.map((content) => content.style.transform)).toEqual(["", "", ""]);
  });

  it("すべりを掴んだ押下は、その間に画面の大きさが変わって操作が終わっても、離したあと何も押さない", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "日" }));
    wide();
    swipe(scroller(), -40);
    expect(xOf(flights()[0].keyframes.at(-1))).toBe(0);
    const slot = within(shownBody()).getAllByRole("button", { name: /に予約を追加$/ })[0];
    point("pointerDown", slot, 300, 400);
    fireEvent(window, new Event("resize"));
    point("pointerUp", slot, 300, 400);
    fireEvent.click(slot, { detail: 1 });
    expect(captured.create).toBeNull();
  });

  it("すべっている途中でウィンドウを離れるか画面が隠れたら、すぐに着地させる", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "日" }));
    wide();
    const leaves: Array<[string, () => void]> = [
      ["blur", () => fireEvent(window, new Event("blur"))],
      [
        "hidden",
        () => {
          vi.spyOn(document, "hidden", "get").mockReturnValue(true);
          fireEvent(document, new Event("visibilitychange"));
        },
      ],
    ];
    for (const [index, [name, leave]] of leaves.entries()) {
      flick(-100, 80);
      leave();
      vi.restoreAllMocks();
      expect(flights(), name).toHaveLength(0);
      expect(paneTransforms(), name).toEqual(["", ""]);
      expect(heading(), name).toBe(index === 0 ? "11月21日（土）" : "11月22日（日）");
    }
  });

  it("すべっている途中に前後のボタンや今日で期間が変わると、そのすべりの分は動かさない", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "日" }));
    wide();
    flick(-100, 80);
    // Enter on 次の日 clicks it with no pointer.
    fireEvent.click(screen.getByRole("button", { name: "次の日" }));
    expect(heading()).toBe("11月21日（土）");
    expect(flights()).toHaveLength(0);
    expect(paneTransforms()).toEqual(["", ""]);
    flick(100, 80);
    fireEvent.click(screen.getByRole("button", { name: "今日" }));
    expect(heading()).toBe("11月20日（金）");
    // A dropped glide that still reports its end changes nothing.
    act(() => {
      for (const each of glides) each.onfinish?.();
    });
    expect(heading()).toBe("11月20日（金）");
  });

  it("すべっている途中で画面を離れると、すべりを止める", async () => {
    const user = userEvent.setup();
    const { unmount } = renderPage();
    await user.click(await screen.findByRole("button", { name: "日" }));
    wide();
    flick(-100, 80);
    expect(flights()).toHaveLength(2);
    unmount();
    expect(flights()).toHaveLength(0);
  });

  it("動きを減らす設定では、すべらせずにすぐ切り替える", async () => {
    reduceMotion = true;
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "日" }));
    wide();
    flick(-100, 80);
    expect(heading()).toBe("11月21日（土）");
    expect(glides.filter((glide) => glide.options.fill === "forwards")).toHaveLength(0);
  });

  it("一覧を下へスクロールしていても、隣の日は上から見せ、離すと戻す", async () => {
    narrow = true;
    renderPage();
    await screen.findByRole("region", { name: "選択日の予約" });
    scroller().scrollTop = 300;
    point("pointerDown", scroller(), 300, 400);
    point("pointerMove", scroller(), 260, 400);
    // The content moves inside its clipped pane, so the scroll height stays.
    const contents = [...document.querySelectorAll<HTMLElement>("[data-swipe-from-top] > [data-period-side] > *")];
    expect(contents.map((content) => content.style.transform)).toEqual(["translateY(300px)", "", "translateY(300px)"]);
    expect(contents.map((content) => content.parentElement?.style.transform)).toEqual(["", "", ""]);
    point("pointerUp", scroller(), 260, 400);
    act(() => flights()[0]?.finish());
    expect(contents.map((content) => content.style.transform)).toEqual(["", "", ""]);
    // Brought back to where it started and taken over by the browser: still put back.
    point("pointerDown", scroller(), 300, 400);
    point("pointerMove", scroller(), 260, 400);
    point("pointerMove", scroller(), 300, 400);
    fireEvent.pointerCancel(scroller(), { pointerId: 1 });
    expect(contents.map((content) => content.style.transform)).toEqual(["", "", ""]);
  });

  it("スクロールした一覧で戻り途中の帯を掴んでも、隣の日は上から見せたままにする", async () => {
    narrow = true;
    renderPage();
    await screen.findByRole("region", { name: "選択日の予約" });
    Object.defineProperty(scroller(), "clientWidth", { configurable: true, get: () => 375 });
    scroller().scrollTop = 300;
    swipe(scroller(), -40);
    expect(xOf(flights()[0].keyframes.at(-1))).toBe(0);
    point("pointerDown", scroller(), 300, 400);
    expect(heading()).toBe("11/20（金）");
    const contents = [...document.querySelectorAll<HTMLElement>("[data-swipe-from-top] > [data-period-side] > *")];
    expect(contents.map((content) => content.style.transform)).toEqual(["translateY(300px)", "", "translateY(300px)"]);
    point("pointerUp", scroller(), 300, 400);
    act(() => flights()[0].finish());
    expect(contents.map((content) => content.style.transform)).toEqual(["", "", ""]);
  });

  it("スクロールした一覧ですべりを掴むと、まだ見えている元の日はそのスクロールのまま描き、戻して着いたらそのスクロールに戻す", async () => {
    narrow = true;
    renderPage();
    await screen.findByRole("region", { name: "選択日の予約" });
    Object.defineProperty(scroller(), "clientWidth", { configurable: true, get: () => 375 });
    scroller().scrollTop = 300;
    flick(-100, 80);
    flights()[0].currentTime = FRAME_MS * 3;
    point("pointerDown", scroller(), 100, 400);
    // The next day is shown from its top; the day leaving is drawn where it was.
    expect(heading()).toBe("11/21（土）");
    expect(scroller().scrollTop).toBe(0);
    const contents = () => [...document.querySelectorAll<HTMLElement>("[data-swipe-from-top] > [data-period-side] > *")];
    expect(contents().map((content) => content.style.transform)).toEqual(["translateY(-300px)", "", ""]);
    // Dragged back and let go: the day it lands on is at the scroll it was drawn at.
    point("pointerMove", scroller(), 300, 400);
    point("pointerUp", scroller(), 300, 400);
    expect(xOf(flights()[0].keyframes.at(-1))).toBe(375);
    act(() => flights()[0].finish());
    expect(heading()).toBe("11/20（金）");
    expect(scroller().scrollTop).toBe(300);
    expect(contents().map((content) => content.style.transform)).toEqual(["", "", ""]);
  });

  it("隣として先に読んだ日も、表示に入ったら 1 回読み直す（変更の前に読んだ古い中身を見せたままにしない）", async () => {
    narrow = true;
    renderPage();
    await screen.findByRole("region", { name: "選択日の予約" });
    await waitFor(() => expect(reservationReads("2026-11-21")).toBe(1));
    swipe(scroller(), -80);
    act(() => flights()[0]?.finish());
    expect(heading()).toBe("11/21（土）");
    await waitFor(() => expect(reservationReads("2026-11-21")).toBe(2));
  });

  it("スクロールした一覧で、進むすべりと戻るすべりを続けて掴んでから離すと、元の日はそのスクロールで止まる", async () => {
    narrow = true;
    renderPage();
    await screen.findByRole("region", { name: "選択日の予約" });
    Object.defineProperty(scroller(), "clientWidth", { configurable: true, get: () => 375 });
    scroller().scrollTop = 300;
    flick(-100, 80);
    flights()[0].currentTime = FRAME_MS * 3;
    point("pointerDown", scroller(), 100, 400);
    expect(heading()).toBe("11/21（土）");
    point("pointerMove", scroller(), 300, 400);
    point("pointerUp", scroller(), 300, 400);
    // Gliding back to the day before: caught again once it is in view, then let go.
    flights()[0].currentTime = FRAME_MS * 3;
    point("pointerDown", scroller(), 300, 400);
    expect(heading()).toBe("11/20（金）");
    point("pointerUp", scroller(), 300, 400);
    act(() => flights()[0]?.finish());
    expect(scroller().scrollTop).toBe(300);
    const contents = [...document.querySelectorAll<HTMLElement>("[data-swipe-from-top] > [data-period-side] > *")];
    expect(contents.map((content) => content.style.transform)).toEqual(["", "", ""]);
  });

  it("スクロールした一覧ですべりを掴んで縦に動かし、戻るすべりの途中で取り消されても、元の日は着地までそのスクロールで描く", async () => {
    narrow = true;
    renderPage();
    await screen.findByRole("region", { name: "選択日の予約" });
    Object.defineProperty(scroller(), "clientWidth", { configurable: true, get: () => 375 });
    scroller().scrollTop = 300;
    flick(-100, 80);
    flights()[0].currentTime = FRAME_MS * 3;
    point("pointerDown", scroller(), 100, 400);
    point("pointerMove", scroller(), 100, 440);
    fireEvent.pointerCancel(scroller(), { pointerId: 1 });
    const contents = () => [...document.querySelectorAll<HTMLElement>("[data-swipe-from-top] > [data-period-side] > *")];
    expect(contents()[0].style.transform).toBe("translateY(-300px)");
    act(() => flights()[0].finish());
    expect(contents().map((content) => content.style.transform)).toEqual(["", "", ""]);
    expect(scroller().scrollTop).toBe(0);
  });

  it("先読みの応答が変更の後に届いても、表示に入った日は予約もブロックも新しく読み、変更を見せる", async () => {
    narrow = true;
    // The next day's reads ahead are sent before the change and answer after it.
    const held = new Set(["/api/admin/reservations?range=date&date=2026-11-21", blocksUrl("2026-11-21")]);
    const answers: Array<() => void> = [];
    mocks.api.get.mockImplementation((url: string) => {
      if (!held.delete(url)) return respond(url);
      const old = respond(url);
      return new Promise((resolve) => answers.push(() => resolve(old)));
    });
    const { client } = renderPage();
    await screen.findByRole("region", { name: "選択日の予約" });
    await waitFor(() => expect(answers).toHaveLength(2));
    reservationsByDay["2026-11-21"] = [reservation("res-m", "2026-11-21", "10:00", "11:00", { customerDisplayName: "移動 四郎" })];
    blocksByDay["2026-11-21"] = [block("blk-m", { startAt: jst("2026-11-21", "15:00"), endAt: jst("2026-11-21", "16:00") })];
    await act(() => client.invalidateQueries({ queryKey: ["reservations"] }));
    swipe(scroller(), -80);
    act(() => flights()[0]?.finish());
    expect(heading()).toBe("11/21（土）");
    await waitFor(() => expect([reservationReads("2026-11-21"), blockReads("2026-11-21")]).toEqual([2, 2]));
    expect(await within(shownBody()).findByText(/移動 四郎/)).toBeTruthy();
    const blocksShown = () => client.getQueryData<{ externalBlocks: { id: string }[] }>(["external-blocks", "2026-11-21"])?.externalBlocks.map((row) => row.id);
    await waitFor(() => expect(blocksShown()).toEqual(["blk-m"]));
    // The old answers arrive last and change nothing.
    await act(async () => {
      for (const answer of answers) answer();
    });
    expect(within(shownBody()).getByText(/移動 四郎/)).toBeTruthy();
    expect(blocksShown()).toEqual(["blk-m"]);
  });

  it("本番と同じ再試行 1 回では、隣のままの日の先読みは失敗しても 1 回だけ読み直し、表示に入ったら表示として読んで失敗を知らせる", async () => {
    narrow = true;
    failingDays.add("2026-11-21");
    renderPage({ client: retryOnce() });
    await screen.findByRole("region", { name: "選択日の予約" });
    await waitFor(() => expect(reservationReads("2026-11-21")).toBe(2));
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
    expect(reservationReads("2026-11-21")).toBe(2);
    swipe(scroller(), -80);
    act(() => flights()[0]?.finish());
    expect(heading()).toBe("11/21（土）");
    expect(await screen.findByText(/11月21日（土）の予約の読み込みに失敗しました/)).toBeTruthy();
    expect(reservationReads("2026-11-21")).toBe(4);
  });

  it("本番と同じ再試行 1 回で、先読みが届く前に移った日は、表示の読み込みが 1 回失敗しても再試行で中身を見せる", async () => {
    narrow = true;
    reservationsByDay["2026-11-21"] = [reservation("res-n", "2026-11-21", "10:00", "11:00", { customerDisplayName: "土曜 五郎" })];
    let answerAhead: (() => void) | null = null;
    let shownFails = 1;
    mocks.api.get.mockImplementation((url: string) => {
      if (url !== "/api/admin/reservations?range=date&date=2026-11-21") return respond(url);
      if (!answerAhead) {
        const ahead = respond(url);
        return new Promise((resolve) => {
          answerAhead = () => resolve(ahead);
        });
      }
      if (shownFails-- > 0) return Promise.reject(new Error("network"));
      return respond(url);
    });
    renderPage({ client: retryOnce() });
    await screen.findByRole("region", { name: "選択日の予約" });
    await waitFor(() => expect(reservationReads("2026-11-21")).toBe(1));
    swipe(scroller(), -80);
    act(() => flights()[0]?.finish());
    expect(heading()).toBe("11/21（土）");
    expect(await within(shownBody()).findByText(/土曜 五郎/)).toBeTruthy();
    expect(reservationReads("2026-11-21")).toBe(3);
    await act(async () => answerAhead?.());
  });

  it("スクロールした一覧ですべりを掴んで離し、着く前に前の日を押すと、その日はページの決めた先頭から開く", async () => {
    narrow = true;
    renderPage();
    await screen.findByRole("region", { name: "選択日の予約" });
    Object.defineProperty(scroller(), "clientWidth", { configurable: true, get: () => 375 });
    scroller().scrollTop = 300;
    flick(-100, 80);
    flights()[0].currentTime = FRAME_MS * 3;
    point("pointerDown", scroller(), 100, 400);
    expect(heading()).toBe("11/21（土）");
    point("pointerUp", scroller(), 100, 400);
    expect(flights()).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "前の日" }));
    expect(heading()).toBe("11/20（金）");
    expect(scroller().scrollTop).toBe(0);
    const contents = [...document.querySelectorAll<HTMLElement>("[data-swipe-from-top] > [data-period-side] > *")];
    expect(contents.map((content) => content.style.transform)).toEqual(["", "", ""]);
  });

  it("前後の日は先に 1 回だけ読み、繰り返し取りに行かない（INT-11-06）", async () => {
    narrow = true;
    const { client } = renderPage();
    await screen.findByRole("region", { name: "選択日の予約" });
    await waitFor(() => expect(reservationReads("2026-11-21")).toBe(1));
    expect(["2026-11-19", "2026-11-20"].map(reservationReads)).toEqual([1, 1]);
    const options = (key: unknown[]) => client.getQueryCache().find({ queryKey: key })?.observers[0]?.options;
    // Watched only: nothing of theirs polls, refetches on focus or on an invalidation.
    for (const key of [["reservations", "2026-11-21"], ["external-blocks", "2026-11-19"]]) {
      expect(options(key)?.enabled, key.join()).toBe(false);
    }
    // The shown day keeps its own polling.
    expect(options(["reservations", "2026-11-20"])?.refetchInterval).toBe(30_000);
    await act(() => client.invalidateQueries({ queryKey: ["reservations"] }));
    await waitFor(() => expect(reservationReads("2026-11-20")).toBe(2));
    expect(["2026-11-19", "2026-11-21"].map(reservationReads)).toEqual([1, 1]);
    // A step reads the one new neighbour; the day it shows was invalidated, so it is read again.
    swipe(scroller(), -80);
    act(() => flights()[0]?.finish());
    await waitFor(() => expect(reservationReads("2026-11-22")).toBe(1));
    await waitFor(() => expect(reservationReads("2026-11-21")).toBe(2));
    expect(["2026-11-19", "2026-11-20"].map(reservationReads)).toEqual([1, 2]);
  });

  it("週表示では今の週と前後の週を 1 日 1 回ずつ読み、1 週送ると、新しく隣になった週を先に読み、表示に入った週を 1 回読み直す", async () => {
    renderPage();
    await screen.findByRole("button", { name: "11月16日（月）の日表示を開く" });
    const days = (from: string, count: number) => Array.from({ length: count }, (_, index) => formatJstDate(addDays(new Date(`${from}T00:00:00+09:00`), index)));
    await waitFor(() => expect(days("2026-11-09", 21).map(reservationReads)).toEqual(Array(21).fill(1)));
    swipe(scroller(), -80);
    act(() => flights()[0]?.finish());
    // The new neighbour week is read ahead; the week now shown is read again once.
    await waitFor(() => expect(days("2026-11-30", 7).map(reservationReads)).toEqual(Array(7).fill(1)));
    await waitFor(() => expect(days("2026-11-23", 7).map(reservationReads)).toEqual(Array(7).fill(2)));
    expect(days("2026-11-09", 14).map(reservationReads)).toEqual(Array(14).fill(1));
  });

  it("前後の日の読み込みに失敗しても、今の日の注意には出さず、その日へ移ると出す（INT-11-06）", async () => {
    narrow = true;
    failingDays.add("2026-11-21");
    const { client } = renderPage();
    await screen.findByRole("region", { name: "選択日の予約" });
    await waitFor(() => expect(client.getQueryState(["reservations", "2026-11-21"])?.status).toBe("error"));
    const notices = () => document.querySelector("[data-calendar-notices]")?.textContent ?? "";
    expect(notices()).not.toContain("11/21");
    expect(notices()).not.toContain("11月21日");
    swipe(scroller(), -80);
    act(() => flights()[0]?.finish());
    await waitFor(() => expect(notices()).toContain("11月21日"));
  });
});

const wheel = (dx: number, dy = 0, init: { deltaMode?: number; ctrlKey?: boolean; cancelable?: boolean } = {}) =>
  fireEvent.wheel(scroller(), { deltaX: dx, deltaY: dy, deltaMode: init.deltaMode ?? 0, ctrlKey: init.ctrlKey ?? false, cancelable: init.cancelable ?? true });
const quiet = () => new Promise((resolve) => setTimeout(resolve, 300));

describe("ScheduleV2Page の横スクロール（T006）", () => {
  it("横の wheel は 80px たまると 1 日動き、入力が途切れるまで次へは進まない", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "日" }));
    wheel(50);
    expect(heading()).toBe("11月20日（金）");
    wheel(40);
    expect(heading()).toBe("11月21日（土）");
    wheel(200);
    wheel(200);
    expect(heading()).toBe("11月21日（土）");
    await quiet();
    wheel(-100);
    expect(heading()).toBe("11月20日（金）");
  });

  it("逆向きの入力は打ち消し合い、行の単位の入力は px に直して数える", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "日" }));
    wheel(60);
    wheel(-30);
    wheel(40);
    expect(heading()).toBe("11月20日（金）");
    wheel(10);
    expect(heading()).toBe("11月21日（土）");
    await quiet();
    wheel(6, 0, { deltaMode: 1 });
    expect(heading()).toBe("11月22日（日）");
  });

  it("縦で始まった操作は途中で横に変わっても動かさず、横の操作は逆向きの量も足す", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "日" }));
    wheel(0, 100);
    wheel(45, 5);
    wheel(45, 5);
    expect(heading()).toBe("11月20日（金）");
    await quiet();
    wheel(70, 0);
    wheel(-60, 70);
    wheel(20, 0);
    expect(heading()).toBe("11月20日（金）");
    wheel(50, 0);
    expect(heading()).toBe("11月21日（土）");
  });

  it("縦が主の入力・拡大の入力・取り消せない入力では動かさず、縦と拡大はブラウザに任せる", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "日" }));
    expect(wheel(100, 120)).toBe(true);
    // Each starts a gesture of its own, so no axis fixed before it hides its guard.
    await quiet();
    expect(wheel(120, 0, { ctrlKey: true })).toBe(true);
    expect(heading()).toBe("11月20日（金）");
    await quiet();
    wheel(120, 0, { cancelable: false });
    expect(heading()).toBe("11月20日（金）");
  });

  it("ウィンドウを離れる・画面が隠れると、wheel の操作の残りを捨て、間を空けた次の操作から受け付ける（INT-10-05）", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "日" }));
    const leaves: Array<[string, () => void]> = [
      ["blur", () => fireEvent(window, new Event("blur"))],
      [
        "hidden",
        () => {
          vi.spyOn(document, "hidden", "get").mockReturnValue(true);
          fireEvent(document, new Event("visibilitychange"));
        },
      ],
    ];
    for (const [name, leave] of leaves) {
      wheel(50);
      leave();
      vi.restoreAllMocks();
      wheel(40);
      wheel(200);
      expect(heading(), name).toBe("11月20日（金）");
      await quiet();
    }
    wheel(100);
    expect(heading()).toBe("11月21日（土）");
  });

  it("日付を動かす横の入力は、ブラウザの戻る・進むに渡さない", async () => {
    renderPage();
    await screen.findByRole("button", { name: /^11月16日（月）の日表示を開く/ });
    expect(wheel(100)).toBe(false);
    expect(screen.getByRole("button", { name: /^11月23日（月）の日表示を開く/ })).toBeTruthy();
  });
});

describe("ScheduleV2Page の日付選択（T006）", () => {
  it("見出しを押すと月曜始まりの月のカレンダーが開き、選んだ日へ移って閉じる", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "日" }));
    const trigger = screen.getByRole("button", { name: "11月20日（金）" });
    await user.click(trigger);
    const calendar = await screen.findByRole("group", { name: "日付選択カレンダー" });
    expect(within(calendar).getAllByText(/^[月火水木金土日]$/).map((cell) => cell.textContent)).toEqual(["月", "火", "水", "木", "金", "土", "日"]);
    // 1 November 2026 is a Sunday, so a Monday-start grid begins on 26 October.
    expect(within(calendar).getAllByRole("button", { name: /^2026年\d+月\d+日/ })[0].getAttribute("aria-label")).toBe("2026年10月26日 (月)");
    await user.click(within(calendar).getByRole("button", { name: "2026年11月25日 (水)" }));
    expect(heading()).toBe("11月25日（水）");
    expect(screen.queryByRole("group", { name: "日付選択カレンダー" })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "11月25日（水）" }));
  });
});

describe("ScheduleV2Page の日付選択（T006）の細部", () => {
  it("キーボードで開くと名前のあるダイアログになり、Escape で見出しに戻る。面はぼかしの無い不透明な面", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "日" }));
    const trigger = screen.getByRole("button", { name: "11月20日（金）" });
    trigger.focus();
    await user.keyboard("{Enter}");
    const dialog = await screen.findByRole("dialog", { name: "日付選択" });
    expect(dialog.classList.contains("surface")).toBe(true);
    expect(dialog.classList.contains("glass-mid")).toBe(false);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "日付選択" })).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("同じ週の日を選んだあとで日表示に切り替えると、営業開始の位置で開く", async () => {
    const user = userEvent.setup();
    renderPage();
    await eventButton(/^山田 花子、/);
    scroller().scrollTop = 700;
    await user.click(screen.getByRole("button", { name: "2026年11月" }));
    const calendar = await screen.findByRole("group", { name: "日付選択カレンダー" });
    await user.click(within(calendar).getByRole("button", { name: "2026年11月18日 (水)" }));
    await user.click(screen.getByRole("button", { name: "日" }));
    expect(heading()).toBe("11月18日（水）");
    // 10:00 opening less 30 minutes, at 48px an hour.
    expect(scroller().scrollTop).toBe(456);
  });

  it("表示中の期間が変わると、見出しが同じ年月のままでも期間を読み上げる", async () => {
    renderPage();
    await screen.findByRole("button", { name: /^11月16日（月）の日表示を開く/ });
    swipe(scroller(), -80);
    expect(heading()).toBe("2026年11月");
    // With the year: the same month and day in another year is another period.
    const spoken = screen.getByText("2026年11月23日 (月)から2026年11月29日 (日)");
    expect(spoken.getAttribute("aria-live")).toBe("polite");
  });
});

describe("ScheduleV2Page の表示の保存（T006）", () => {
  it("選んだ表示を端末に覚え、開き直すと同じ表示で開く", async () => {
    const user = userEvent.setup();
    const first = renderPage();
    await user.click(await screen.findByRole("button", { name: "日" }));
    first.unmount();
    renderPage();
    expect((await screen.findByRole("button", { name: "日" })).getAttribute("aria-pressed")).toBe("true");
  });

  it("保存が使えない端末でも、既定の表示で開いて切り替えられる", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    try {
      const user = userEvent.setup();
      renderPage();
      expect((await screen.findByRole("button", { name: "週" })).getAttribute("aria-pressed")).toBe("true");
      await user.click(screen.getByRole("button", { name: "日" }));
      expect(screen.getByRole("button", { name: "日" }).getAttribute("aria-pressed")).toBe("true");
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("全店舗や狭い画面で一時的に日表示にしても、保存した週は上書きしない", async () => {
    localStorage.setItem("admin-calendar-view", "week");
    storeState.selected = null;
    storeState.stores = STORES;
    const wide = renderPage();
    expect((await screen.findByRole("button", { name: "日" })).getAttribute("aria-pressed")).toBe("true");
    wide.unmount();
    storeState.selected = "s1";
    narrow = true;
    const phone = renderPage();
    expect((await screen.findByRole("button", { name: "日" })).getAttribute("aria-pressed")).toBe("true");
    phone.unmount();
    expect(localStorage.getItem("admin-calendar-view")).toBe("week");
    narrow = false;
    renderPage();
    expect((await screen.findByRole("button", { name: "週" })).getAttribute("aria-pressed")).toBe("true");
  });

  it("週の見出しから開いた日は、店舗を選び直すと保存した週に戻る（INT-02-03）", async () => {
    storeState.stores = STORES;
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "週" }));
    await user.click(screen.getByRole("button", { name: /^11月18日（水）の日表示を開く/ }));
    expect(screen.getByRole("button", { name: "日" }).getAttribute("aria-pressed")).toBe("true");
    const pick = (store: string | null) => {
      storeState.selected = store;
      act(() => refreshPage());
    };
    pick(null);
    expect(screen.getByRole("button", { name: "日" }).getAttribute("aria-pressed")).toBe("true");
    pick("s2");
    expect(screen.getByRole("button", { name: "週" }).getAttribute("aria-pressed")).toBe("true");
    pick("s1");
    expect(screen.getByRole("button", { name: "週" }).getAttribute("aria-pressed")).toBe("true");
    expect(localStorage.getItem("admin-calendar-view")).toBe("week");
  });

  it("週の見出しから日を開いても、保存した表示は変えない", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "週" }));
    await user.click(screen.getByRole("button", { name: /^11月18日（水）の日表示を開く/ }));
    expect(heading()).toBe("11月18日（水）");
    expect(localStorage.getItem("admin-calendar-view")).toBe("week");
    // Choosing the week again ends the day opened from it.
    await user.click(screen.getByRole("button", { name: "週" }));
    expect(screen.getByRole("button", { name: "週" }).getAttribute("aria-pressed")).toBe("true");
  });
});
