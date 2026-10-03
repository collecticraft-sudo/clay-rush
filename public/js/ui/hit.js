// Hit testing for menu targets (pure maths). OWNER: UI engineer.
// Targets are described by their CENTRE: {shape:'rect', x, y, w, h} or {shape:'circle', x, y, r} in playfield px.

/** True when the point lies inside the target. */
export function pointInTarget(t, x, y) {
  if (t.shape === 'circle') return (x - t.x) ** 2 + (y - t.y) ** 2 <= t.r * t.r;
  return Math.abs(x - t.x) <= t.w / 2 && Math.abs(y - t.y) <= t.h / 2;
}

/** The first enabled target under the point, or null. */
export function targetAt(targets, x, y) {
  for (const tg of targets) if (tg.enabled !== false && pointInTarget(tg, x, y)) return tg;
  return null;
}
