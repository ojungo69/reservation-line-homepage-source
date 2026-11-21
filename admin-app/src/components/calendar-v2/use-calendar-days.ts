import { useCallback, useEffect, useRef, useState } from "react";
import { useQueries, useQueryClient } from "@tanstack/react-query";
import { externalBlocksQuery } from "@/hooks/use-external-blocks";
import { reservationsQuery } from "@/hooks/use-reservations";
import { formatJstDate } from "@/lib/timeline";
import type { ExternalBlock, Reservation } from "@/types/api";

// The day list returns at most 200 rows and says nothing when it cut some off, so
// a full page may be missing bookings and is treated as capped (UX-21).
const RESERVATION_ROW_CAP = 200;
// Today changes while staff work; other days rarely do. Polling a week's other six
// days every 2 minutes instead of every 30 seconds cuts its background requests
// from 14 to about 5 per 30 seconds (battery, and the Worker's daily requests).
const OTHER_DAY_POLL_MS = 120_000;
// The periods beside the shown one, which a swipe brings into view (INT-11-06):
// read once ahead and kept for 2 minutes. Their observers only watch the cache,
// so nothing polls them or reads them again on focus or an invalidation; a step
// makes them the shown period, whose own queries read them once 30 seconds old.
const PREVIEW = { enabled: false } as const;

export type DayData = Readonly<{
  dateKey: string;
  reservations: readonly Reservation[];
  blocks: readonly ExternalBlock[];
  loading: boolean;
  // The sources whose last fetch failed, each as a first load (読み込み) or a
  // refresh of data already shown (更新), e.g. 予約の更新.
  failed: readonly string[];
  capped: boolean;
  // The bookings' own fetch, for the list, which shows no blocks.
  reservationsStatus: "pending" | "failed" | "capped" | "ready";
  // The older of the two fetch times; 0 before both have one.
  updatedAt: number;
  refetch: () => void;
}>;

function reservationsStatusOf(pending: boolean, failed: boolean, rows: number): DayData["reservationsStatus"] {
  if (pending) return "pending";
  if (failed) return "failed";
  return rows >= RESERVATION_ROW_CAP ? "capped" : "ready";
}

/**
 * Bookings and external blocks for each shown day, one day per request as today
 * (the same queries and cache as the current day view, no server change). With
 * preview, the days of a neighbouring period: see PREVIEW.
 */
export function useCalendarDays(dayKeys: readonly string[], { preview = false } = {}): DayData[] {
  const client = useQueryClient();
  const todayKey = formatJstDate(new Date());
  const poll = (dateKey: string) => {
    if (preview) return PREVIEW;
    return dateKey === todayKey ? {} : { refetchInterval: OTHER_DAY_POLL_MS };
  };
  const reservations = useQueries({ queries: dayKeys.map((dateKey) => ({ ...reservationsQuery(dateKey), ...poll(dateKey) })) });
  const blocks = useQueries({ queries: dayKeys.map((dateKey) => ({ ...externalBlocksQuery(dateKey), ...poll(dateKey) })) });
  const keys = dayKeys.join(" ");
  useEffect(() => {
    if (!preview || !keys) return;
    for (const dateKey of keys.split(" ")) {
      void client.prefetchQuery({ ...reservationsQuery(dateKey), staleTime: OTHER_DAY_POLL_MS });
      void client.prefetchQuery({ ...externalBlocksQuery(dateKey), staleTime: OTHER_DAY_POLL_MS });
    }
  }, [client, keys, preview]);
  return dayKeys.map((dateKey, index) => {
    const bookings = reservations[index];
    const others = blocks[index];
    const rows = bookings.data?.ok ? bookings.data.reservations : [];
    const blockRows = others.data?.ok ? others.data.externalBlocks : [];
    return {
      dateKey,
      reservations: rows,
      blocks: blockRows,
      loading: bookings.isPending || others.isPending,
      failed: [
        bookings.isError && `予約の${bookings.data ? "更新" : "読み込み"}`,
        others.isError && `ブロックの${others.data ? "更新" : "読み込み"}`,
      ].filter((name): name is string => Boolean(name)),
      capped: rows.length >= RESERVATION_ROW_CAP || Boolean(others.data?.ok && others.data.truncated),
      reservationsStatus: reservationsStatusOf(bookings.isPending, bookings.isError, rows.length),
      updatedAt: bookings.dataUpdatedAt > 0 && others.dataUpdatedAt > 0 ? Math.min(bookings.dataUpdatedAt, others.dataUpdatedAt) : 0,
      refetch: () => {
        void bookings.refetch();
        void others.refetch();
      },
    };
  });
}

/**
 * The shown date and the current time. A device left open on today moves on to
 * the next day after JST midnight (also after waking up); a day picked by hand
 * stays until today is picked again, as in the current calendar.
 */
export function useCalendarDate() {
  const [shownDate, setShownDate] = useState(() => new Date());
  const [now, setNow] = useState(() => new Date());
  const followToday = useRef(true);
  const setDate = useCallback((next: Date) => {
    followToday.current = formatJstDate(next) === formatJstDate(new Date());
    setShownDate(next);
  }, []);

  useEffect(() => {
    const tick = () => setNow(new Date());
    const onVisibility = () => {
      if (document.visibilityState === "visible") tick();
    };
    const timer = window.setInterval(tick, 30_000);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  const todayKey = formatJstDate(now);
  const seenToday = useRef(todayKey);
  useEffect(() => {
    if (seenToday.current === todayKey) return;
    seenToday.current = todayKey;
    if (followToday.current) setShownDate(now);
  }, [todayKey, now]);

  return { date: shownDate, setDate, now };
}
