/**
 * Where the detail's popover points (PopoverAnchor's virtualRef). It measures the
 * pressed element while that is on the page and keeps its last place once it is
 * gone: a booking corrected to 来店なし leaves the grid while its detail stays
 * open, and a removed element measures as a zero box in the top-left corner.
 * With nothing pressed (<body>, or an element already gone), the screen's middle.
 */
export function stableAnchor(element: HTMLElement | null) {
  const pressed = element === document.body ? null : element;
  let last: DOMRect | null = null;
  return {
    getBoundingClientRect(): DOMRect {
      if (pressed?.isConnected) last = pressed.getBoundingClientRect();
      return last ?? new DOMRect(window.innerWidth / 2, window.innerHeight / 2, 0, 0);
    },
  };
}
