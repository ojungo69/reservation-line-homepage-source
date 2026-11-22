import { useEffect, useEffectEvent, useLayoutEffect, useRef, type RefObject } from "react";
import { flushSync } from "react-dom";
import { FRAME_MS, frameAt, releaseVelocity, springFrames, swipeAxis, swipeStep, wheelPx, wheelStep, type Sample } from "./swipe";

// INT-04-09: a touch that starts this close to a screen edge belongs to the
// system's back gesture.
const EDGE_PX = 24;
// INT-01-04, INT-08-08: fields keep their own touch and wheel handling.
const FIELDS = "input, textarea, select, [contenteditable]";
// How far the new period's content travels in from the side it came from.
const ENTER_PX = 80;
// The click a swiped touch may still produce comes right after it lifts.
const CLICK_GRACE_MS = 400;
// INT-13-06: wheel input this far apart starts a new gesture.
const WHEEL_GAP_MS = 250;

type Gesture = {
  id: number;
  x: number;
  y: number;
  area: HTMLElement;
  areaWidth: number;
  width: number;
  // Where the strip was when the finger came down: off rest when it caught a glide.
  base: number;
  axis: "x" | "y" | null;
  offset: number;
  track: Sample[];
};
// A released strip gliding to the next or previous period (direction ±1) or
// back to the shown one (0).
type Flight = { animations: Animation[]; frames: number[]; direction: -1 | 0 | 1; width: number };

// The motion tokens of public/glass-tokens.css, read because animate() takes no var().
function motion() {
  const tokens = getComputedStyle(document.documentElement);
  return {
    easing: tokens.getPropertyValue("--mg-ease-out").trim() || "ease-out",
    duration: Number.parseFloat(tokens.getPropertyValue("--mg-motion-base")) || 0,
  };
}

/**
 * One-finger swipes on the date bar and body, and sideways wheel gestures on
 * the body, move by one period (T006, INT-04, INT-05, INT-13). Overflowing store
 * columns keep their native scroll and zoom. While a swipe moves, every [data-swipe-pane] strip
 * under the root follows the finger and brings the neighbouring period in
 * (PeriodStrip); released, it glides on from the finger's speed to that period
 * or back, and the step is made once it lands, so its render never stalls the
 * glide. Reduced motion keeps the strips still (DESIGN.md §8). periodKey names
 * the shown period, view and store: a change from elsewhere ends a glide
 * without its step.
 */
export function usePeriodSwipe({
  scrollerRef,
  rootRef,
  dateBandRef,
  onStep,
  periodKey,
  columnsOverflow,
}: Readonly<{
  scrollerRef: RefObject<HTMLElement | null>;
  rootRef: RefObject<HTMLElement | null>;
  dateBandRef: RefObject<HTMLElement | null>;
  onStep: (direction: -1 | 1) => void;
  periodKey: string;
  columnsOverflow: () => boolean;
}>) {
  // flushSync: the next period is on screen before the strip is put back.
  const step = useEffectEvent((direction: -1 | 1) => flushSync(() => onStep(direction)));
  const bodyHasOverflow = useEffectEvent(columnsOverflow);
  const endSwipe = useRef(() => {});
  // 前/次, the date picker or a store moved the period under a held swipe or a
  // glide: what they would bring in is no longer next door, so both end without
  // a step. A swipe's own step has ended it before the period changes.
  useLayoutEffect(() => {
    endSwipe.current();
  }, [periodKey]);

  useEffect(() => {
    const scroller = scrollerRef.current;
    const root = rootRef.current;
    const dateBand = dateBandRef.current;
    if (!scroller || !root || !dateBand) return;
    let gesture: Gesture | null = null;
    let flight: Flight | null = null;
    let unblock: (() => void) | null = null;
    // A touch that caught a glide or moved sideways cannot also press a control.
    let swipePressId: number | null = null;
    let wheelOwner: "native" | "period" | null = null;
    let wheelSum = 0;
    let wheelDone = false;
    let wheelTimer = 0;

    const panes = () => [...root.querySelectorAll<HTMLElement>("[data-swipe-pane]")];
    // A scrolled list's neighbours are drawn from their own top, as a step shows
    // them (the page opens a list at its top): their content moves down inside
    // the clipped pane, so the scroll height stays.
    const listContents = () => [...root.querySelectorAll<HTMLElement>("[data-swipe-from-top] > [data-period-side] > *")];
    // A list day in view keeps the scroll it is drawn at: the shift each is drawn
    // with, and the scroll that makes.
    const shifted = new WeakMap<HTMLElement, number>();
    const shift = (content: HTMLElement, by: number) => {
      content.style.transform = by ? `translateY(${by}px)` : "";
      shifted.set(content, by);
    };
    const drawnAt = (content: HTMLElement) => scroller.scrollTop - (shifted.get(content) ?? 0);
    const reduced = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    // The strip never shows past its neighbours; an unmeasured body (0) sets no limit.
    const within = (x: number, width: number) => (width > 0 ? Math.max(-width, Math.min(width, x)) : x);
    // Without Web Animations (jsdom) or with reduced motion, steps are made at once.
    const glides = () => !reduced() && typeof scroller.animate === "function";
    const place = (dx: number) => {
      for (const pane of panes()) pane.style.transform = dx ? `translateX(${dx}px)` : "";
    };
    // The strip at rest; the list day shown keeps the scroll it is drawn at, unless
    // the page moved to it and set its scroll itself (endSwipe).
    const rest = (keepScroll = true) => {
      place(0);
      for (const pane of panes()) pane.style.willChange = "";
      const shown = listContents().find((content) => content.parentElement?.dataset.periodSide === "0");
      // A day drawn from its top under a scroll the step has reset comes out below 0.
      const keep = keepScroll && shown ? Math.max(0, drawnAt(shown)) : null;
      for (const content of listContents()) shift(content, 0);
      if (keep !== null && keep !== scroller.scrollTop) scroller.scrollTop = keep;
    };
    const play = (from: Keyframe, to: Keyframe) => {
      const options = motion();
      for (const pane of panes()) pane.animate?.([from, to], options);
    };
    const enter = (direction: -1 | 1) => {
      const from = reduced() ? { opacity: 0.4 } : { transform: `translateX(${direction * ENTER_PX}px)`, opacity: 0 };
      play(from, { transform: "translateX(0)", opacity: 1 });
    };
    // The glide reached its period: the step shows it in the frame the strip rests,
    // and a list day that came in keeps the scroll it was drawn at (rest).
    const land = () => {
      const done = flight;
      flight = null;
      if (!done) return;
      if (done.direction !== 0) step(done.direction);
      rest();
      for (const animation of done.animations) animation.cancel();
    };
    // Glides the strips from `from` to `to`, starting at the finger's speed. An
    // animation shows its first keyframe on the frame it starts, so it starts a
    // frame on: no frame after the lift stands still.
    const fly = (from: number, to: number, velocity: number, direction: -1 | 0 | 1, width: number) => {
      const frames = springFrames(from, to, velocity)
        .slice(1)
        .map((x) => within(x, width));
      const keyframes = frames.map((x) => ({ transform: `translateX(${x}px)` }));
      const options: KeyframeAnimationOptions = { duration: (frames.length - 1) * FRAME_MS, fill: "forwards" };
      const animations = panes().map((pane) => pane.animate(keyframes, options));
      const current: Flight = { animations, frames, direction, width };
      flight = current;
      if (animations.length === 0) {
        land();
        return;
      }
      animations[0].onfinish = () => {
        if (flight === current) land();
      };
    };
    // A glide in progress (a caught one let go for a vertical scroll) rests when it lands.
    const settle = (from: number, velocity = 0) => {
      if (flight) return;
      if (from === 0 || !glides()) rest();
      else fly(from, 0, velocity, 0, scroller.clientWidth);
    };
    // A touch caught the glide: the finger holds the strip where it was, and the
    // period it was bringing in is shown now if it had come into view; caught
    // earlier, the glide's step is dropped.
    const seize = () => {
      const done = flight;
      flight = null;
      let offset = 0;
      if (done) {
        offset = frameAt(done.frames, Number(done.animations[0]?.currentTime ?? 0));
        for (const animation of done.animations) animation.cancel();
        if (done.direction !== 0 && offset * done.direction < 0) {
          const drawn = new Map(listContents().map((content) => [content, drawnAt(content)]));
          const held = gesture;
          gesture = null;
          step(done.direction);
          gesture = held;
          offset += done.direction * done.width;
          // Each list day stays drawn where it was; a new one shows its top.
          for (const content of listContents()) shift(content, scroller.scrollTop - (drawn.get(content) ?? 0));
        }
        place(offset);
      }
      for (const pane of panes()) for (const animation of pane.getAnimations?.() ?? []) animation.cancel();
      return offset;
    };
    endSwipe.current = () => {
      const done = flight;
      if (!done && !gesture) return;
      flight = null;
      gesture = null;
      for (const animation of done?.animations ?? []) animation.cancel();
      rest(false);
    };
    // A sideways touch is a swipe, not a press of the slot or booking under it.
    // Keyboard and assistive technology clicks carry no click count and pass.
    const blockClick = () => {
      unblock?.();
      const swallow = (event: MouseEvent) => {
        if (event.detail === 0) return;
        event.stopPropagation();
        event.preventDefault();
        unblock?.();
      };
      root.addEventListener("click", swallow, { capture: true });
      const timer = window.setTimeout(() => unblock?.(), CLICK_GRACE_MS);
      unblock = () => {
        root.removeEventListener("click", swallow, { capture: true });
        window.clearTimeout(timer);
        unblock = null;
      };
    };
    // A held swipe goes back to rest; a glide in progress is left to land.
    const stop = () => {
      if (gesture) settle(gesture.offset);
      gesture = null;
    };
    // A rotation or resize lands a glide at once: its distance was the old width.
    const onResize = () => {
      stop();
      land();
    };
    const widthChanged = (active: Gesture) =>
      scroller.clientWidth !== active.width || active.area.clientWidth !== active.areaWidth;
    // A swipe that has turned sideways gets its own layer, and a scrolled list's
    // neighbours show their top.
    const prime = () => {
      for (const pane of panes()) pane.style.willChange = "transform";
      const top = scroller.scrollTop;
      if (top > 0) for (const content of listContents()) if (content.parentElement?.dataset.periodSide !== "0") shift(content, top);
    };

    // The document also sees a second finger outside the body or the date bar.
    const onDown = (event: PointerEvent) => {
      unblock?.();
      // INT-04-07: a second finger ends the swipe and leaves the pinch to the browser.
      if (gesture) {
        stop();
        return;
      }
      const target = event.target;
      if (!(target instanceof Element) || target.closest(FIELDS)) return;
      if (event.pointerType !== "touch" || !event.isPrimary) return;
      if (event.clientX < EDGE_PX || event.clientX > window.innerWidth - EDGE_PX) return;
      const area = dateBand.contains(target) ? dateBand : scroller;
      if (area === scroller && (!scroller.contains(target) || bodyHasOverflow())) return;
      // A date button still works as a tap during a glide. It catches the glide
      // only if the finger moves sideways.
      const waitForSwipe = flight !== null && area === dateBand && target.closest("button") !== null;
      swipePressId = flight && !waitForSwipe ? event.pointerId : null;
      const base = waitForSwipe ? 0 : seize();
      gesture = {
        id: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        area,
        areaWidth: area.clientWidth,
        width: scroller.clientWidth,
        base,
        axis: null,
        offset: base,
        track: [{ x: event.clientX, t: event.timeStamp }],
      };
    };
    const onMove = (event: PointerEvent) => {
      if (event.pointerId !== gesture?.id) return;
      const dx = event.clientX - gesture.x;
      // Every move is kept: the speed at the lift may start from one before a pause (INT-13-03).
      gesture.track.push({ x: event.clientX, t: event.timeStamp });
      const was = gesture.axis;
      // INT-04-02, 03: once decided, a vertical touch stays the browser's scroll.
      gesture.axis ??= swipeAxis(dx, event.clientY - gesture.y);
      if (gesture.axis === "y" && gesture.offset !== 0) {
        // A caught glide let go for a vertical scroll.
        settle(gesture.offset);
        gesture.offset = 0;
      }
      if (gesture.axis !== "x") return;
      swipePressId = gesture.id;
      if (flight) gesture.base = seize();
      if (reduced()) return;
      if (was !== "x") prime();
      gesture.offset = within(gesture.base + dx, gesture.width);
      place(gesture.offset);
    };
    const onUp = (event: PointerEvent) => {
      const alreadyBlocked = event.pointerId === swipePressId;
      if (alreadyBlocked) {
        swipePressId = null;
        blockClick();
      }
      if (event.pointerId !== gesture?.id) return;
      const { x, width, areaWidth, base, offset, axis: was } = gesture;
      const resized = widthChanged(gesture);
      // A fast flick may lift before a move has decided the axis.
      const axis = gesture.axis ?? swipeAxis(event.clientX - x, event.clientY - gesture.y);
      // A lift away from the last move adds the distance it saw.
      const track = gesture.track.at(-1)?.x === event.clientX ? gesture.track : [...gesture.track, { x: event.clientX, t: event.timeStamp }];
      gesture = null;
      if (axis === "x" && !alreadyBlocked) blockClick();
      if (axis !== "x") {
        settle(offset);
        return;
      }
      const travel = event.clientX - x;
      const shown = within((flight ? seize() : base) + travel, width);
      const velocity = releaseVelocity(track, event.timeStamp);
      // INT-04-04: how far and how fast this finger moved decides; a caught
      // glide's offset only sets where the strip glides from. INT-10-04: a size
      // change before the observer reports it also cancels the step.
      const direction = resized ? 0 : swipeStep(travel, areaWidth, velocity);
      if (was !== "x" && glides()) prime();
      if (direction === 0) {
        settle(shown, velocity);
        return;
      }
      if (!glides()) {
        rest();
        step(direction);
        enter(direction);
        return;
      }
      fly(shown, -direction * width, velocity, direction, width);
    };
    // INT-04-08, INT-10-01・02: the browser took the touch over (a scroll, the OS),
    // or its target was redrawn away mid-swipe. A capture released after a
    // normal lift finds no gesture left.
    const onCancel = (event: PointerEvent) => {
      if (event.pointerId === swipePressId) swipePressId = null;
      if (event.pointerId === gesture?.id) stop();
    };
    // INT-10-04・05: a rotation or resize, and leaving the window or the app, end
    // the swipe; a finger lifted afterwards finds no gesture. A glide lands at
    // once, its step made: a hidden page would hold the landing until it shows.
    // Leaving also drops a wheel gesture's uncommitted amount: the rest of it,
    // momentum included, is ignored until a 250ms gap starts the next one.
    const onLeave = () => {
      stop();
      land();
      if (wheelOwner !== null) wheelDone = true;
    };
    const onHidden = () => {
      if (document.hidden) onLeave();
    };
    // INT-05: a gesture is wheel input without a 250ms gap, momentum included.
    // The first input fixes who handles it (INT-03-08). Only sideways input in
    // a fitting body can move a period, once its signed sum reaches 80px.
    const onWheel = (event: WheelEvent) => {
      // INT-05-04: ctrl + wheel is the trackpad's pinch zoom.
      if (event.ctrlKey) return;
      window.clearTimeout(wheelTimer);
      wheelTimer = window.setTimeout(() => {
        wheelOwner = null;
        wheelSum = 0;
        wheelDone = false;
      }, WHEEL_GAP_MS);
      if (event.deltaX === 0 && event.deltaY === 0) return;
      const target = event.target;
      const overField = target instanceof Element && target.closest(FIELDS) !== null;
      wheelOwner ??= !overField && !bodyHasOverflow() && Math.abs(event.deltaX) > Math.abs(event.deltaY) ? "period" : "native";
      if (overField) return;
      // INT-04-06: while the strip is off rest under a finger or gliding, a wheel
      // neither scrolls (each list day is drawn at the scroll it had) nor steps;
      // its gesture keeps going with the axis its first input took, and the
      // amount it brings meanwhile is not counted.
      // shortcut: a wheel the page cannot cancel (some WebKit momentum) still
      // scrolls then, and a scrolled list day may land at its top; keep its drawn
      // scroll through the landing if a trackpad user notices.
      if (flight || gesture?.offset) {
        if (event.cancelable) event.preventDefault();
        return;
      }
      // INT-05-01: a vertical gesture scrolls the hours. INT-05-07: input the
      // page cannot cancel may still become the browser's back or forward.
      if (wheelOwner !== "period" || !event.cancelable) return;
      event.preventDefault();
      if (wheelDone) return;
      wheelSum += wheelPx(event.deltaX, event.deltaMode, scroller.clientWidth);
      const direction = wheelStep(wheelSum);
      if (direction === 0) return;
      wheelDone = true;
      step(direction);
      enter(direction);
    };

    // On the document: a lost capture is reported there when its target is gone.
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
    document.addEventListener("pointercancel", onCancel);
    document.addEventListener("lostpointercapture", onCancel, true);
    window.addEventListener("resize", onResize);
    window.addEventListener("blur", onLeave);
    document.addEventListener("visibilitychange", onHidden);
    // INT-10-04: a width change to the strips or to the area the touch started in
    // ends the swipe even while the finger is held still.
    const sizes =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => {
            const width = scroller.clientWidth;
            if ((gesture && widthChanged(gesture)) || (flight && width !== flight.width)) onResize();
          });
    sizes?.observe(scroller);
    sizes?.observe(dateBand);
    // Not passive: a sideways gesture is kept from the browser's history swipe.
    scroller.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.removeEventListener("pointercancel", onCancel);
      document.removeEventListener("lostpointercapture", onCancel, true);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("blur", onLeave);
      document.removeEventListener("visibilitychange", onHidden);
      sizes?.disconnect();
      scroller.removeEventListener("wheel", onWheel);
      window.clearTimeout(wheelTimer);
      endSwipe.current();
      endSwipe.current = () => {};
      unblock?.();
    };
  }, [scrollerRef, rootRef, dateBandRef]);
}
