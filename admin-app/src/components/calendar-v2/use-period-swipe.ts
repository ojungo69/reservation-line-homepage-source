import { useEffect, useEffectEvent, type RefObject } from "react";
import { flushSync } from "react-dom";
import { swipeAxis, swipeStep } from "./swipe";

// INT-04-09: a touch that starts this close to a screen edge belongs to the
// system's back gesture.
const EDGE_PX = 24;
// INT-01-04, INT-08-08: fields keep their own touch handling.
const FIELDS = "input, textarea, select, [contenteditable]";
// How far the new period's content travels in from the side it came from.
const ENTER_PX = 80;
// The click a swiped touch may still produce comes right after it lifts.
const CLICK_GRACE_MS = 400;

type Gesture = { id: number; x: number; y: number; axis: "x" | "y" | null; dx: number };

// The motion tokens of public/glass-tokens.css, read because animate() takes no var().
function motion() {
  const tokens = getComputedStyle(document.documentElement);
  return {
    easing: tokens.getPropertyValue("--mg-ease-out").trim() || "ease-out",
    duration: Number.parseFloat(tokens.getPropertyValue("--mg-motion-base")) || 0,
  };
}

/**
 * One-finger swipes on the calendar body move by one period (spec 008 T006,
 * interactions.md INT-04, INT-13). The body scrolls vertically with
 * touch-action: pan-y pinch-zoom, so the browser keeps vertical scrolling and
 * zoom and hands over sideways touches; mouse and pen are left for dragging
 * bookings (INT-03, T011). While a swipe moves, every [data-swipe-pane] under
 * the root follows the finger; reduced motion keeps them still (DESIGN.md §8).
 */
export function usePeriodSwipe(
  scrollerRef: RefObject<HTMLElement | null>,
  rootRef: RefObject<HTMLElement | null>,
  onStep: (direction: -1 | 1) => void,
) {
  // flushSync: the next period is on screen before its entrance is played.
  const step = useEffectEvent((direction: -1 | 1) => flushSync(() => onStep(direction)));

  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    let gesture: Gesture | null = null;
    let unblock: (() => void) | null = null;

    const panes = () => [...(rootRef.current?.querySelectorAll<HTMLElement>("[data-swipe-pane]") ?? [])];
    const reduced = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const place = (dx: number) => {
      for (const pane of panes()) pane.style.transform = dx ? `translateX(${dx}px)` : "";
    };
    const play = (from: Keyframe, to: Keyframe) => {
      const options = motion();
      for (const pane of panes()) pane.animate?.([from, to], options);
    };
    const settle = (dx: number) => {
      place(0);
      if (!reduced()) play({ transform: `translateX(${dx}px)` }, { transform: "translateX(0)" });
    };
    const enter = (direction: -1 | 1) => {
      const from = reduced() ? { opacity: 0.4 } : { transform: `translateX(${direction * ENTER_PX}px)`, opacity: 0 };
      play(from, { transform: "translateX(0)", opacity: 1 });
    };
    // A sideways touch is a swipe, not a press of the slot or booking under it.
    // Keyboard and assistive technology clicks carry no click count and pass.
    const blockClick = () => {
      const swallow = (event: MouseEvent) => {
        if (event.detail === 0) return;
        event.stopPropagation();
        event.preventDefault();
        unblock?.();
      };
      scroller.addEventListener("click", swallow, { capture: true });
      const timer = window.setTimeout(() => unblock?.(), CLICK_GRACE_MS);
      unblock = () => {
        scroller.removeEventListener("click", swallow, { capture: true });
        window.clearTimeout(timer);
        unblock = null;
      };
    };
    const stop = () => {
      if (gesture?.axis === "x") settle(gesture.dx);
      gesture = null;
    };

    // A second finger outside the body is seen too: the listener is on the document.
    const onDown = (event: PointerEvent) => {
      unblock?.();
      // INT-04-07: a second finger ends the swipe and leaves the pinch to the browser.
      if (gesture) {
        stop();
        return;
      }
      const target = event.target;
      if (!(target instanceof Element) || !scroller.contains(target) || target.closest(FIELDS)) return;
      if (event.pointerType !== "touch" || !event.isPrimary) return;
      if (event.clientX < EDGE_PX || event.clientX > window.innerWidth - EDGE_PX) return;
      for (const pane of panes()) for (const animation of pane.getAnimations?.() ?? []) animation.cancel();
      gesture = { id: event.pointerId, x: event.clientX, y: event.clientY, axis: null, dx: 0 };
    };
    const onMove = (event: PointerEvent) => {
      if (event.pointerId !== gesture?.id) return;
      const dx = event.clientX - gesture.x;
      // INT-04-02, 03: once decided, a vertical touch stays the browser's scroll.
      gesture.axis ??= swipeAxis(dx, event.clientY - gesture.y);
      if (gesture.axis !== "x") return;
      gesture.dx = dx;
      if (!reduced()) place(dx);
    };
    const onUp = (event: PointerEvent) => {
      if (event.pointerId !== gesture?.id) return;
      const { x, dx: shown } = gesture;
      // A fast flick may lift before a move has decided the axis.
      const axis = gesture.axis ?? swipeAxis(event.clientX - x, event.clientY - gesture.y);
      gesture = null;
      if (axis !== "x") return;
      blockClick();
      // INT-04-04: the distance where the finger lifts decides.
      const direction = swipeStep(event.clientX - x, scroller.clientWidth);
      if (direction === 0) {
        settle(shown);
        return;
      }
      place(0);
      step(direction);
      enter(direction);
    };
    // INT-04-08, INT-10-01・02: the browser took the touch over (a scroll, the OS),
    // or its target was redrawn away mid-swipe. A capture released after a
    // normal lift finds no gesture left.
    const onCancel = (event: PointerEvent) => {
      if (event.pointerId === gesture?.id) stop();
    };
    // INT-10-04・05: a rotation or resize, and leaving the window or the app, end
    // the swipe; a finger lifted afterwards finds no gesture.
    const onHidden = () => {
      if (document.hidden) stop();
    };

    // On the document: a lost capture is reported there when its target is gone.
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
    document.addEventListener("pointercancel", onCancel);
    document.addEventListener("lostpointercapture", onCancel, true);
    window.addEventListener("resize", stop);
    window.addEventListener("blur", stop);
    document.addEventListener("visibilitychange", onHidden);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.removeEventListener("pointercancel", onCancel);
      document.removeEventListener("lostpointercapture", onCancel, true);
      window.removeEventListener("resize", stop);
      window.removeEventListener("blur", stop);
      document.removeEventListener("visibilitychange", onHidden);
      unblock?.();
      place(0);
    };
  }, [scrollerRef, rootRef]);
}
