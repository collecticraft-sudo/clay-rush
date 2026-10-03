// Easing functions of the effects (docs/restyle-direction.md section 2 conventions). OWNER: Effects engineer. Pure, allocation free.
// Kept apart from draw-util.js (owned by the typography engineer) so the two sets of helpers never collide.

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** oC: easeOutCubic. */
export const easeOutCubic = (t) => 1 - (1 - t) ** 3;
/** iC: easeInCubic. */
export const easeInCubic = (t) => t * t * t;
/** sine: easeInOutSine. */
export const easeInOutSine = (t) => -(Math.cos(Math.PI * t) - 1) / 2;
/** oE: easeOutExpo (1 at t >= 1). */
export const easeOutExpo = (t) => (t >= 1 ? 1 : 1 - 2 ** (-10 * t));

/**
 * oB(k): easeOutBack with overshoot k (1.70158 is the classic value, 2.4 is a slam). Starts at 0, overshoots above 1, ends at exactly 1.
 * Input is clamped to 0..1.
 */
export function easeOutBackK(t, k = 1.70158) {
  const u = clamp01(t) - 1;
  return 1 + (k + 1) * u * u * u + k * u * u;
}

/** Linear progress of `age` over `dur`, clamped; a zero or negative duration means done. */
export const prog = (age, dur) => (dur <= 0 ? 1 : clamp01(age / dur));
