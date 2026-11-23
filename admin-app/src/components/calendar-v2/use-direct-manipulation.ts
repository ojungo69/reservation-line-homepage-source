import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import type { CalendarRescheduleIntent, Reservation } from "@/types/api";
import { canChangeReservationTime } from "@/hooks/use-calendar-reschedule";
import type { ColumnState } from "./body";
import type { CalendarColumn } from "./columns";
import { CLEANING_MINUTES, DAY_MINUTES, PX_PER_MINUTE, spansOverlap, type Span } from "./geometry";

const STEP_MINUTES = 5;
const MINUTE_MS = 60_000;
const TOUCH_THRESHOLD_PX = 12;
const MOUSE_THRESHOLD_PX = 4;
const HOLD_MS = 400;
const CLICK_GRACE_MS = 400;
const SCROLL_EDGE_PX = 48;
const MAX_SCROLL_PX_PER_MS = 0.6;

type Source =
  | { kind: "range"; column: CalendarColumn }
  | { kind: "move" | "resize" | "select"; column: CalendarColumn; reservation: Reservation };

type Gesture = {
  source: Source;
  target: HTMLButtonElement;
  column: HTMLElement;
  id: number;
  x: number;
  y: number;
  origin: number;
  touch: boolean;
  started: boolean;
  hold: ReturnType<typeof setTimeout> | undefined;
};

type Candidate = { column: CalendarColumn; span: Span; treatmentEnd?: number; reservation?: Reservation };
type Drop =
  | { candidate: Candidate; kind: "range" }
  | { candidate: Candidate; kind: "change"; reservation: Reservation; intent: CalendarRescheduleIntent; unchanged: boolean };

const snap = (minute: number) => Math.round(minute / STEP_MINUTES) * STEP_MINUTES;
const minuteAt = (y: number, column: HTMLElement) => (y - column.getBoundingClientRect().top) / PX_PER_MINUTE;
const midnight = (dateKey: string) => Date.parse(`${dateKey}T00:00:00+09:00`);

function dropAt(gesture: Gesture, column: CalendarColumn, pointerMinute: number): Drop | null {
  const { source, origin } = gesture;
  if (source.kind === "select" || column.storeId !== source.column.storeId) return null;
  if (source.kind === "range") {
    if (column.key !== source.column.key) return null;
    const end = snap(pointerMinute);
    const span = { start: Math.min(origin, end), end: Math.max(origin, end) };
    return { kind: "range", candidate: { column, span } };
  }

  const { reservation } = source;
  const startMs = Date.parse(reservation.startAt);
  const duration = (Date.parse(reservation.endAt) - startMs) / MINUTE_MS;
  const start = (startMs - midnight(source.column.dateKey)) / MINUTE_MS;
  const delta = pointerMinute - origin;
  const returned = column.key === source.column.key && Math.abs(delta) < 0.001;
  if (source.kind === "move") {
    const moved = returned ? start : snap(start + delta);
    if (moved < 0 || moved >= DAY_MINUTES) return null;
    const movedMs = midnight(column.dateKey) + moved * MINUTE_MS;
    return {
      kind: "change", reservation, unchanged: returned || movedMs === startMs,
      intent: { kind: "move", startAt: new Date(movedMs).toISOString() },
      candidate: { column, span: { start: moved, end: moved + duration }, treatmentEnd: moved + duration - CLEANING_MINUTES, reservation },
    };
  }
  if (column.key !== source.column.key) return null;
  const treatmentMinutes = returned ? duration - CLEANING_MINUTES : snap(duration - CLEANING_MINUTES + delta);
  return {
    kind: "change", reservation, unchanged: treatmentMinutes === duration - CLEANING_MINUTES,
    intent: { kind: "resize", treatmentMinutes },
    candidate: {
      column, span: { start, end: start + Math.max(0, treatmentMinutes) + CLEANING_MINUTES },
      treatmentEnd: start + Math.max(0, treatmentMinutes), reservation,
    },
  };
}

export type CalendarDirectManipulation = ReturnType<typeof useDirectManipulation>;

export function useDirectManipulation({
  scrollerRef, overlayRef, enabled, layoutKey, states, selectedId, onSelect, onRange, onChange, onInvalid,
}: Readonly<{
  scrollerRef: RefObject<HTMLElement | null>;
  overlayRef: RefObject<HTMLElement | null>;
  enabled: boolean;
  layoutKey: string;
  states: readonly ColumnState[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onRange: (column: CalendarColumn, span: Span, from: HTMLElement) => void;
  onChange: (reservation: Reservation, intent: CalendarRescheduleIntent, from: HTMLElement) => void;
  onInvalid: (message: string) => void;
}>) {
  const active = useRef<Gesture | null>(null);
  const ignoreDown = useRef<PointerEvent | null>(null);
  const cancelActive = useRef(() => {});
  const [candidate, setCandidate] = useState<Candidate | null>(null);

  const selectReservation = useEffectEvent(onSelect);
  const reportInvalid = useEffectEvent(onInvalid);
  const isSelected = useEffectEvent(() => enabled && selectedId !== null);
  const stateFor = useEffectEvent((key: string | undefined) => states.find(({ column }) => column.key === key));
  const sourceReady = useEffectEvent((source: Source) => {
    const state = states.find(({ column }) => column.key === source.column.key);
    if (source.kind === "range") return Boolean(state?.rangeResources.length);
    return state?.reservationsReady && state.items.some((item) =>
      item.kind === "reservation" && item.reservation.id === source.reservation.id && canChangeReservationTime(item.reservation.status),
    );
  });
  const finish = useEffectEvent((drop: Drop, from: HTMLElement) => {
    if (drop.kind === "change") {
      if (!drop.unchanged) onChange(drop.reservation, drop.intent, from);
      return;
    }
    const { column, span } = drop.candidate;
    if (span.start === span.end) return;
    const state = states.find((entry) => entry.column.key === column.key);
    if (!state?.rangeResources.length ||
        [...state.closed, ...state.closures.map((closure) => closure.span)].some((band) => spansOverlap(span, band)) ||
        !state.rangeResources.some((id) => state.items.every((item) =>
          id !== (item.kind === "block" ? item.block.resourceId : item.reservation.resourceId) || !spansOverlap(item.span, span)))) {
      onInvalid("選択した範囲を予約できません。空いている時間帯をお選びください。");
      return;
    }
    onRange(column, span, from);
  });

  useLayoutEffect(() => { cancelActive.current(); }, [enabled, layoutKey]);

  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    let scrollFrame = 0;
    let frameTime = 0;
    let point: { x: number; y: number } | null = null;
    let canceledId: number | null = null;
    let suppressClick = false;
    let clickTimer: ReturnType<typeof setTimeout> | undefined;

    const stopScroll = () => {
      cancelAnimationFrame(scrollFrame);
      scrollFrame = 0;
      frameTime = 0;
    };
    const stop = () => {
      const gesture = active.current;
      if (!gesture) return;
      active.current = null;
      point = null;
      clearTimeout(gesture.hold);
      stopScroll();
      setCandidate(null);
      if (gesture.started && gesture.source.kind !== "select" && gesture.target.hasPointerCapture?.(gesture.id)) {
        gesture.target.releasePointerCapture(gesture.id);
      }
    };
    const blockClick = () => {
      suppressClick = true;
      clearTimeout(clickTimer);
      clickTimer = setTimeout(() => { suppressClick = false; }, CLICK_GRACE_MS);
    };
    const cancel = () => {
      if (!active.current) return;
      canceledId = active.current.id;
      blockClick();
      stop();
    };
    cancelActive.current = cancel;
    const visibleBounds = () => {
      const { left, right, top, bottom } = scroller.getBoundingClientRect();
      return { left, right, top: Math.max(top, overlayRef.current?.getBoundingClientRect().bottom ?? top), bottom };
    };
    const proposalAt = (gesture: Gesture, x: number, y: number) => {
      if (!gesture.target.isConnected || !gesture.column.closest('[data-period-side="0"]') || !sourceReady(gesture.source)) return null;
      const { left, right, top, bottom } = visibleBounds();
      if (x < left || x >= right || y < top || y >= bottom) return null;
      const viewport = gesture.column.closest("[data-calendar-columns-scroll]")?.getBoundingClientRect();
      if (viewport && (x < viewport.left || x >= viewport.right)) return null;
      const columns = gesture.column.parentElement?.querySelectorAll<HTMLElement>("[data-calendar-column]") ?? [];
      const over = [...columns].find((element) => {
        const rect = element.getBoundingClientRect();
        return x >= rect.left && x < rect.right && y >= rect.top && y < rect.bottom;
      });
      if (!over) return null;
      const state = stateFor(over.dataset.calendarColumn);
      return state?.reservationsReady ? dropAt(gesture, state.column, minuteAt(y, over)) : null;
    };
    const draw = () => {
      const gesture = active.current;
      if (!gesture?.started || gesture.source.kind === "select" || !point) return null;
      const drop = proposalAt(gesture, point.x, point.y);
      const next = drop && drop.candidate.span.start < drop.candidate.span.end ? drop.candidate : null;
      setCandidate((prev) =>
        prev?.column.key === next?.column.key && prev?.span.start === next?.span.start && prev?.span.end === next?.span.end ? prev : next,
      );
      return drop;
    };
    const scrollSpeed = (y: number) => {
      const { top, bottom } = visibleBounds();
      const distance = Math.min(SCROLL_EDGE_PX, (bottom - top) / 2);
      if (distance <= 0 || y < top || y >= bottom) return 0;
      if (y < top + distance) return -MAX_SCROLL_PX_PER_MS * (1 - (y - top) / distance);
      if (y > bottom - distance) return MAX_SCROLL_PX_PER_MS * (1 - (bottom - y) / distance);
      return 0;
    };
    const autoscroll = (time: number) => {
      scrollFrame = 0;
      if (!point || !active.current?.started) return;
      const speed = scrollSpeed(point.y);
      if (!speed) return;
      const elapsed = frameTime ? Math.min(32, time - frameTime) : 16;
      frameTime = time;
      const top = scroller.scrollTop;
      scroller.scrollTop = Math.max(0, Math.min(scroller.scrollHeight - scroller.clientHeight, top + speed * elapsed));
      if (scroller.scrollTop !== top && draw()) scrollFrame = requestAnimationFrame(autoscroll);
      else frameTime = 0;
    };
    const onDown = (event: PointerEvent) => {
      suppressClick = false;
      if (event.pointerId === canceledId) canceledId = null;
      ignoreDown.current = null;
      if (!active.current || event.pointerId === active.current.id) return;
      ignoreDown.current = event;
      cancel();
    };
    const startDrag = (gesture: Gesture, distance: number, ending: boolean) => {
      const threshold = gesture.touch ? TOUCH_THRESHOLD_PX : MOUSE_THRESHOLD_PX;
      if (distance < threshold) return false;
      gesture.started = true;
      if (!ending) gesture.target.setPointerCapture?.(gesture.id);
      return true;
    };
    const onMove = (event: PointerEvent, ending = false) => {
      const gesture = active.current;
      if (event.pointerId !== gesture?.id) return;
      const { clientX: x, clientY: y } = event;
      if (x < 0 || y < 0 || x >= window.innerWidth || y >= window.innerHeight) {
        cancel();
        return;
      }
      const distance = Math.hypot(x - gesture.x, y - gesture.y);
      if (gesture.source.kind === "select") {
        if (!gesture.started && distance >= TOUCH_THRESHOLD_PX) cancel();
        return;
      }
      if (!gesture.started && !startDrag(gesture, distance, ending)) return;
      point = { x, y };
      const drop = draw();
      if (!ending && drop?.kind === "change" && scrollSpeed(y)) {
        if (!scrollFrame) scrollFrame = requestAnimationFrame(autoscroll);
      } else {
        stopScroll();
      }
      return drop;
    };
    const onPointerMove = (event: PointerEvent) => onMove(event);
    const onUp = (event: PointerEvent) => {
      const drop = onMove(event, true);
      if (event.pointerId === canceledId) {
        canceledId = null;
        blockClick();
        return;
      }
      const gesture = active.current;
      if (event.pointerId !== gesture?.id) return;
      if (gesture.started) blockClick();
      stop();
      if (drop) finish(drop, gesture.target);
      else if (gesture.started && gesture.source.kind !== "select") {
        reportInvalid("表示中の同じ店舗の時間帯で操作してください。");
      }
    };
    const onCancel = (event: PointerEvent) => {
      if (event.pointerId === active.current?.id) cancel();
    };
    // A touch is first captured to the pressed element, often the icon inside a handle.
    // Capturing it to the handle releases that capture, which is not a cancel.
    const onLostCapture = (event: PointerEvent) => {
      const gesture = active.current;
      if (gesture && (event.target === gesture.target || !gesture.target.isConnected)) onCancel(event);
    };
    const onLeave = (event: PointerEvent) => {
      if (event.relatedTarget === null) onCancel(event);
    };
    const onClick = (event: MouseEvent) => {
      if (!suppressClick || event.detail === 0) return;
      suppressClick = false;
      event.preventDefault();
      event.stopPropagation();
    };
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing || event.keyCode === 229 ||
          (event.target instanceof Element && event.target.closest("input, textarea, select, [contenteditable], [role=dialog], [role=alertdialog]"))) return;
      if (active.current) {
        cancel();
      } else if (isSelected()) {
        const target = document.activeElement?.closest("[data-calendar-selection]")?.previousElementSibling;
        if (target instanceof HTMLElement) target.focus();
        selectReservation(null);
      } else {
        return;
      }
      event.preventDefault();
    };
    const onHidden = () => { if (document.hidden) cancel(); };
    const onContextMenu = (event: MouseEvent) => {
      if (active.current?.touch && event.target instanceof Node && active.current.target.contains(event.target)) event.preventDefault();
    };

    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("pointermove", onPointerMove, true);
    document.addEventListener("pointerup", onUp, true);
    document.addEventListener("pointercancel", onCancel, true);
    document.addEventListener("lostpointercapture", onLostCapture, true);
    document.addEventListener("pointerout", onLeave, true);
    document.addEventListener("click", onClick, true);
    document.addEventListener("keydown", onEscape);
    document.addEventListener("visibilitychange", onHidden);
    scroller.addEventListener("contextmenu", onContextMenu);
    scroller.addEventListener("scroll", draw, { capture: true, passive: true });
    window.addEventListener("blur", cancel);
    window.addEventListener("resize", cancel);
    return () => {
      cancel();
      cancelActive.current = () => {};
      clearTimeout(clickTimer);
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("pointermove", onPointerMove, true);
      document.removeEventListener("pointerup", onUp, true);
      document.removeEventListener("pointercancel", onCancel, true);
      document.removeEventListener("lostpointercapture", onLostCapture, true);
      document.removeEventListener("pointerout", onLeave, true);
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("keydown", onEscape);
      document.removeEventListener("visibilitychange", onHidden);
      scroller.removeEventListener("contextmenu", onContextMenu);
      scroller.removeEventListener("scroll", draw, true);
      window.removeEventListener("blur", cancel);
      window.removeEventListener("resize", cancel);
    };
  }, [overlayRef, scrollerRef]);

  const start = (event: ReactPointerEvent<HTMLButtonElement>, source: Source) => {
    const touch = event.pointerType === "touch";
    if (!enabled || active.current || event.nativeEvent === ignoreDown.current || !event.isPrimary || event.button !== 0 ||
        (touch && source.kind === "range")) return;
    const target = event.currentTarget;
    const column = target.closest<HTMLElement>("[data-calendar-column]");
    if (!column) return;
    const minute = minuteAt(event.clientY, column);
    const gesture: Gesture = {
      source, target, column, id: event.pointerId, x: event.clientX, y: event.clientY,
      origin: source.kind === "range" ? snap(minute) : minute,
      touch, started: false, hold: undefined,
    };
    active.current = gesture;
    if (source.kind === "select") {
      gesture.hold = setTimeout(() => {
        if (active.current !== gesture || !target.isConnected) return;
        gesture.started = true;
        onSelect(source.reservation.id);
      }, HOLD_MS);
    }
  };

  return {
    candidate,
    start,
    clearSelection: () => onSelect(null),
    ownsPointer: (event?: PointerEvent) =>
      (active.current !== null && active.current.source.kind !== "select") ||
      (event !== undefined && ignoreDown.current === event),
  };
}
