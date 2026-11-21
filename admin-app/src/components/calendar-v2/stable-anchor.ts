// What the detail popover needs beside a booking: its width (28rem, or the screen
// less 2rem), the 8px gap and the 16px it keeps from the screen's edge. Kept in
// step with the popover's classes in reservation-detail-panel.tsx.
function roomBeside(): number {
  const rem = Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
  return Math.min(28 * rem, window.innerWidth - 2 * rem) + 8 + 16;
}

// With no room on either side of a wide booking (one store's day), the popover
// opens beside its first part, over the rest of it, instead of off the screen.
// On a screen too narrow even for that (one kept open while the window narrows),
// it starts at the furthest point where it still fits.
function besideOrOver(rect: DOMRect): DOMRect {
  const room = roomBeside();
  if (rect.left >= room || window.innerWidth - rect.right >= room) return rect;
  const left = Math.min(rect.left, window.innerWidth - room);
  return new DOMRect(left, rect.top, Math.max(0, window.innerWidth - room - left), rect.height);
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
