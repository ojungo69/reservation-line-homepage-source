// The touch thresholds of interactions.md INT-13: starting values for the
// real-device evaluation, kept in one place so they are tuned together.
const LOCK_PX = 12;
const DOMINANCE = 1.5;
const COMMIT_SHARE = 0.2;
const COMMIT_MIN_PX = 64;
const COMMIT_MAX_PX = 120;
const FLICK_MIN_PX = 24;
const FLICK_PX_PER_MS = 0.3;
const BACK_PX_PER_MS = 0.1;
const VELOCITY_WINDOW_MS = 100;
// A finger whose last move came longer ago than this before it lifted had stopped.
const STOPPED_MS = 40;
// A critically damped spring that settles in about this long (DESIGN.md §8).
const SPRING_RESPONSE_MS = 300;
const SPRING_MAX_MS = 1000;
const WHEEL_STEP_PX = 80;
// DOM_DELTA_LINE: a line taken as one 16px line of text.
const LINE_PX = 16;

/** One frame of a 60 Hz display, the step of a glide's keyframes. */
export const FRAME_MS = 1000 / 60;

export type Sample = Readonly<{ x: number; t: number }>;

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
 * The period a released sideways swipe moves to, from how far the content was
 * moved (dx) and the finger's speed as it lifted (px/ms, rightwards positive).
 * Content sent to the left goes forward. It goes once it is 20% of the swiped
 * width away, held between 64px and 120px, or when a flick of at least 24px
 * lifts still moving that way at 0.3px/ms; a finger already moving back at
 * 0.1px/ms keeps the shown period.
 */
export function swipeStep(dx: number, width: number, velocity = 0): -1 | 0 | 1 {
  const along = Math.sign(dx) * velocity;
  if (dx === 0 || along <= -BACK_PX_PER_MS) return 0;
  const commitPx = Math.min(COMMIT_MAX_PX, Math.max(COMMIT_MIN_PX, width * COMMIT_SHARE));
  const flick = Math.abs(dx) >= FLICK_MIN_PX && along >= FLICK_PX_PER_MS;
  if (Math.abs(dx) < commitPx && !flick) return 0;
  return dx < 0 ? 1 : -1;
}

/**
 * The finger's speed (px/ms) as it lifted at liftAt, over the 100ms before it
 * last moved sideways: 0 when that last sideways move was more than 40ms before
 * the lift (it had stopped, even if it drifted up or down since). The lift only
 * ends the track: it often comes a frame or two after the last move, which is
 * no sign of the finger slowing down. A turn or a still hold within those
 * 100ms counts from where the finger set off again. A still finger sends no
 * moves, so a gap of more than 40ms crossed at under 0.1px/ms is a hold too;
 * a faster one is a late frame of a moving finger.
 */
export function releaseVelocity(samples: readonly Sample[], liftAt: number): number {
  let moved = samples.length - 1;
  while (moved > 0 && samples[moved - 1].x === samples[moved].x) moved--;
  const end = samples[moved];
  if (!end || liftAt - end.t > STOPPED_MS) return 0;
  let first = end;
  for (let index = moved - 1; index >= 0; index--) {
    const sample = samples[index];
    const way = Math.sign(end.x - first.x);
    const turned = way !== 0 && Math.sign(first.x - sample.x) === -way;
    const gap = first.t - sample.t;
    const held = sample.x === first.x || (gap > STOPPED_MS && Math.abs(first.x - sample.x) < BACK_PX_PER_MS * gap);
    if (end.t - sample.t > VELOCITY_WINDOW_MS || held || turned) break;
    first = sample;
  }
  return end.t > first.t ? (end.x - first.x) / (end.t - first.t) : 0;
}

/**
 * The positions, one per frame, of a glide from `from` to `to` on a critically
 * damped spring that starts at `velocity` (px/ms), so the motion carries on at
 * the finger's speed. A start toward `to` faster than the spring's own pace is
 * held to it, so the glide never passes `to` into the period beyond.
 */
export function springFrames(from: number, to: number, velocity: number): number[] {
  const omega = (2 * Math.PI) / SPRING_RESPONSE_MS;
  const x0 = from - to;
  // Already there: any speed would only carry it past.
  if (x0 === 0) return [from, to];
  const v0 = Math.sign(velocity) === -Math.sign(x0) ? Math.sign(velocity) * Math.min(Math.abs(velocity), omega * Math.abs(x0)) : velocity;
  const frames = [from];
  for (let t = FRAME_MS; t < SPRING_MAX_MS; t += FRAME_MS) {
    const x = (x0 + (v0 + omega * x0) * t) * Math.exp(-omega * t);
    if (Math.abs(x) < 0.5) break;
    frames.push(to + x);
  }
  frames.push(to);
  return frames;
}

/** Where a glide of `frames` is `ms` after it started. */
export function frameAt(frames: readonly number[], ms: number): number {
  const at = Math.min(Math.max(ms / FRAME_MS, 0), frames.length - 1);
  const before = Math.floor(at);
  const after = Math.min(before + 1, frames.length - 1);
  return frames[before] + (frames[after] - frames[before]) * (at - before);
}

/** A wheel event's horizontal amount in px (deltaMode: pixels, lines or pages). */
export function wheelPx(deltaX: number, deltaMode: number, pagePx: number): number {
  if (deltaMode === 1) return deltaX * LINE_PX;
  if (deltaMode === 2) return deltaX * pagePx;
  return deltaX;
}

/**
 * The period a wheel gesture moves to once its signed horizontal sum reaches
 * 80px (INT-13-05): content moving left (a positive sum) goes forward.
 */
export function wheelStep(sum: number): -1 | 0 | 1 {
  if (Math.abs(sum) < WHEEL_STEP_PX) return 0;
  return sum > 0 ? 1 : -1;
}
