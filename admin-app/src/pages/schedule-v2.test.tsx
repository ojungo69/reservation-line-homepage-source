import { mocks } from "@/test-utils/hook-mocks";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestQueryClient } from "@/test-utils/query-client";
import { ShellV2Context, type ShellV2 } from "@/components/shell-v2/shell-context";
import { formatJstDate } from "@/lib/timeline";
import type { ExternalBlock, Reservation } from "@/types/api";

const auth = vi.hoisted(() => ({ privileged: true }));
const storeState = vi.hoisted(() => ({
  selected: "s1" as string | null,
  stores: [] as Array<{ id: string; name: string }>,
}));
const captured = vi.hoisted(() => ({
  detail: null as null | { reservationId: string | null; onClose: () => void },
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
    return props.reservationId ? <div role="dialog" aria-label="予約の詳細">{props.reservationId}</div> : null;
  },
}));
vi.mock("@/components/schedule/reservation-create-panel", () => ({
  ReservationCreatePanel: (props: Record<string, unknown>) => {
    captured.create = props;
    return <div role="dialog" aria-label="予約を追加" />;
  },
}));
vi.mock("@/components/schedule/pending-approvals-card", () => ({
  PendingApprovalsCard: ({ onSelect, selectedStoreId }: { onSelect: (id: string) => void; selectedStoreId: string | null }) => (
    <button type="button" onClick={() => onSelect("res-b")}>
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
let settingsFail: boolean;
let narrow: boolean;

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
  businessHours: Array.from({ length: 7 }, (_, weekday) => ({
    id: `bh-${weekday}`,
    storeId: "s1",
    weekday,
    opensAt: "10:00",
    closesAt: "19:00",
    active: true,
  })),
  closures: [],
});

function respond(url: string) {
  const parsed = new URL(url, "http://admin.test");
  if (parsed.pathname === "/api/admin/reservations" && parsed.searchParams.get("range") === "date") {
    const day = parsed.searchParams.get("date") ?? "";
    if (failingDays.has(day)) return Promise.reject(new Error("network"));
    return Promise.resolve({ ok: true, range: "date", startAt: "", endAt: "", reservations: reservationsByDay[day] ?? [] });
  }
  if (parsed.pathname === "/api/admin/external-blocks") {
    return Promise.resolve({ ok: true, externalBlocks: blocksByDay[parsed.searchParams.get("from") ?? ""] ?? [], truncated: false });
  }
  if (parsed.pathname === "/api/admin/settings") {
    return settingsFail ? Promise.reject(new Error("network")) : Promise.resolve({ ok: true, settings: settings() });
  }
  if (parsed.pathname === "/api/admin/reservations/pending") {
    return Promise.resolve({
      ok: true,
      reservations: [
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

function renderPage({ shell, state }: { shell?: ShellV2; state?: unknown } = {}) {
  const page = (
    <>
      <ScheduleV2Page />
      <LocationProbe />
    </>
  );
  return render(
    <QueryClientProvider client={createTestQueryClient()}>
      <MemoryRouter initialEntries={[{ pathname: "/", state }]}>
        {shell ? <ShellV2Context.Provider value={shell}>{page}</ShellV2Context.Provider> : page}
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const fakeShell = (): ShellV2 & { calls: { ownTopBar: boolean[]; blocked: boolean[] } } => {
  const calls = { ownTopBar: [] as boolean[], blocked: [] as boolean[] };
  return {
    calls,
    showMenuButton: true,
    menuButtonRef: { current: null },
    menuOpen: false,
    openMenu: vi.fn(),
    setOwnTopBar: (own) => calls.ownTopBar.push(own),
    setPaletteBlocked: (blocked) => calls.blocked.push(blocked),
  };
};

const column = (key: string) => document.querySelector<HTMLElement>(`[data-calendar-column="${key}"]`);
const slotsIn = (key: string) => column(key)?.querySelectorAll("[data-slot-minutes]").length ?? 0;
const eventButton = (name: RegExp) => screen.findByRole("button", { name });

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
  settingsFail = false;
  narrow = false;
  mocks.api.get.mockReset();
  mocks.api.get.mockImplementation(respond);
  mocks.toast.info.mockReset();
  vi.stubGlobal("matchMedia", (query: string) => ({
    get matches() {
      return query.includes("max-width: 639.98px") ? narrow : false;
    },
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("ScheduleV2Page の週表示", () => {
  it("1店舗の週を月曜から7列で描き、見出しは年月にする", async () => {
    renderPage();
    expect(await screen.findByRole("button", { name: "11月16日（月）の日表示を開く" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "11月22日（日）の日表示を開く" })).toBeTruthy();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("2026年11月");
    expect(screen.getByRole("button", { name: "11月20日（金）の日表示を開く" }).getAttribute("aria-current")).toBe("date");
    expect(document.querySelectorAll("[data-calendar-column]")).toHaveLength(7);
  });

  it("同じ時間に重なる予約は横に並べ、取消済みは出さない", async () => {
    renderPage();
    const first = await eventButton(/^山田 花子、11月20日（金）、10:00から11:00、カット、確定$/);
    const second = await eventButton(/^佐藤 一郎、11月20日（金）、10:30から11:30、カット、承認待ち$/);
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
    expect(document.querySelectorAll("[data-calendar-column]")).toHaveLength(1);
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
  it("全店舗では日表示で店舗ごとに列を並べ、週を選ぶと店舗を選ぶよう案内する", async () => {
    storeState.selected = null;
    storeState.stores = STORES;
    renderPage();
    expect(await screen.findByText("週表示は店舗を1つ選ぶと使えます。上部の店舗の切り替えで選んでください。")).toBeTruthy();
    expect(document.querySelectorAll("[data-calendar-column]")).toHaveLength(3);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("11月20日（金）");
    expect(await eventButton(/^駅前 次郎、/)).toBeTruthy();
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
    await openSlot("11月20日（金） 10:00 本店に予約を追加");
    expect(captured.create).toMatchObject({ defaultStoreId: "s1", defaultResourceId: "r1", defaultMinutes: 600 });
    expect(formatJstDate(captured.create?.defaultDate as Date)).toBe("2026-11-20");
  });

  it("稼働中のリソースが2つ以上なら、作成画面で選ばせる", async () => {
    storeState.selected = null;
    storeState.stores = STORES;
    await openSlot("11月20日（金） 15:00 駅前店に予約を追加");
    expect(captured.create).toMatchObject({ defaultStoreId: "s2", defaultResourceId: null, defaultMinutes: 900 });
  });

  it("稼働中のリソースが無い店舗では、作成画面を開かずに案内する", async () => {
    storeState.selected = null;
    storeState.stores = STORES;
    await openSlot("11月20日（金） 15:00 東口店に予約を追加");
    expect(captured.create).toBeNull();
    expect(mocks.toast.info).toHaveBeenCalledWith(expect.stringContaining("東口店"));
  });

  it("週表示では押した日の日付を引き継ぐ", async () => {
    await openSlot("11月18日（水） 15:00 本店に予約を追加");
    expect(captured.create).toMatchObject({ defaultStoreId: "s1", defaultResourceId: "r1", defaultMinutes: 900 });
    expect(formatJstDate(captured.create?.defaultDate as Date)).toBe("2026-11-18");
  });
});

describe("ScheduleV2Page の取得失敗と件数の上限 (UX-21)", () => {
  it("予約の取得に失敗した日は文字で示し、その日に空き枠を出さない", async () => {
    failingDays.add("2026-11-18");
    const user = userEvent.setup();
    renderPage();
    expect(
      await screen.findByText(/11月18日（水）の予約の読み込みに失敗しました。空き状況を表示できません。/),
    ).toBeTruthy();
    await waitFor(() => expect(slotsIn("2026-11-19:s1")).toBe(96));
    expect(slotsIn("2026-11-18:s1")).toBe(0);
    const before = mocks.api.get.mock.calls.length;
    failingDays.clear();
    await user.click(screen.getByRole("button", { name: "再読み込み" }));
    await waitFor(() => expect(slotsIn("2026-11-18:s1")).toBe(96));
    expect(mocks.api.get.mock.calls.slice(before).some(([url]) => String(url).includes("date=2026-11-18"))).toBe(true);
  });

  it("200件ちょうど返った日は欠けている恐れとして扱い、空き枠を出さない", async () => {
    reservationsByDay["2026-11-19"] = Array.from({ length: 200 }, (_, index) =>
      reservation(`many-${index}`, "2026-11-19", "09:00", "09:05", { storeId: "s2" }),
    );
    renderPage();
    expect(await screen.findByText(/11月19日（木）の予定が表示できる件数を超えています。/)).toBeTruthy();
    await waitFor(() => expect(slotsIn("2026-11-20:s1")).toBe(96));
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
    expect(screen.getByRole("dialog", { name: "予約の詳細" }).textContent).toBe("res-a");
    expect(shell.calls.blocked.at(-1)).toBe(true);
    act(() => captured.detail?.onClose());
    await waitFor(() => expect(shell.calls.blocked.at(-1)).toBe(false));
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
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "承認待ち 1件" }));
    await user.click(screen.getByRole("button", { name: "承認待ちの予約（s1）" }));
    expect(screen.getByRole("dialog", { name: "予約の詳細" }).textContent).toBe("res-b");
    // res-b starts on Wednesday 11/18, inside the shown week.
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("2026年11月");
    expect(captured.detail?.reservationId).toBe("res-b");
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
