// The touch thresholds of interactions.md INT-13: starting values for the
// real-device evaluation, kept in one place so they are tuned together.
const LOCK_PX = 12;
const DOMINANCE = 1.5;
const COMMIT_SHARE = 0.2;
const COMMIT_MIN_PX = 64;
const COMMIT_MAX_PX = 120;

/**
 * The axis a touch takes once it has moved 12px: sideways when the horizontal
 * movement is at least 1.5 times the vertical one, otherwise the browser's own
 * vertical scroll. Null until then; the axis never changes afterwards.
 */
export function swipeAxis(dx: number, dy: number): "x" | "y" | null {
  if (Math.hypot(dx, dy) < LOCK_PX) return null;
  return Math.abs(dx) >= DOMINANCE * Math.abs(dy) ? "x" : "y";
}

/**
 * The period a released sideways swipe moves to: 20% of the swiped width,
 * held between 64px and 120px, decides it by distance alone. Content sent to
 * the left goes forward.
 */
export function swipeStep(dx: number, width: number): -1 | 0 | 1 {
  const commitPx = Math.min(COMMIT_MAX_PX, Math.max(COMMIT_MIN_PX, width * COMMIT_SHARE));
  if (Math.abs(dx) < commitPx) return 0;
  return dx < 0 ? 1 : -1;
}
