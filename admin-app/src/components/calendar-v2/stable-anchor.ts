// What the detail popover keeps around itself: the 8px gap to the booking and
// the 16px to the screen's edge. Kept in step with the popover's props and its
// width class in reservation-detail-panel.tsx.
const GAP = 8;
const EDGE = 16;

// The popover's width (28rem, or the screen less 2rem) with the gap and the edge.
function roomBeside(): number {
  const rem = Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
  return Math.min(28 * rem, window.innerWidth - 2 * rem) + GAP + EDGE;
}

// Where the popover opens: beside the booking where one side has room for it;
// otherwise beside its first part, over the rest of it (one store's day), or at
// the nearest point where it fits. The place is first cut to the screen as it is
// now: a kept one can lie off it (a booking gone before the window narrowed).
// shortcut: the layout viewport only; under pinch zoom the popover is placed as
// at 100%, like the app's other popovers.
function besideOrOver(rect: DOMRect): DOMRect {
  const room = roomBeside();
  const cut = (x: number) => Math.min(Math.max(x, EDGE - GAP), window.innerWidth - EDGE + GAP);
  const left = cut(rect.left);
  const right = cut(rect.right);
  if (window.innerWidth - right >= room || left >= room) return new DOMRect(left, rect.top, right - left, rect.height);
  const start = Math.min(left, window.innerWidth - room);
  return new DOMRect(start, rect.top, Math.max(0, window.innerWidth - room - start), rect.height);
}

/**
 * Where the detail's popover points (PopoverAnchor's virtualRef). It measures the
 * pressed element while that is on the page and keeps its last place once it is
 * gone: a booking corrected to 来店なし leaves the grid while its detail stays
 * open, and a removed element measures as a zero box in the top-left corner. The
 * place is taken when the detail opens, in case the element goes before the
 * first measure, and fitted to the screen as it is at each measure. With nothing
 * pressed (<body>, or an element already gone), the screen's middle.
 * contextElement lets the positioning watch the element, so the popover follows
 * a booking that a refresh moves.
 */
export function stableAnchor(element: HTMLElement | null) {
  const pressed = element === document.body ? null : element;
  let last = pressed?.isConnected ? pressed.getBoundingClientRect() : null;
  return {
    contextElement: pressed ?? undefined,
    getBoundingClientRect(): DOMRect {
      if (pressed?.isConnected) last = pressed.getBoundingClientRect();
      return besideOrOver(last ?? new DOMRect(window.innerWidth / 2, window.innerHeight / 2, 0, 0));
    },
  };
}
