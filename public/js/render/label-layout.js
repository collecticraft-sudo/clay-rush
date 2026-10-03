// Where the labels of a break go: the points popup ("+175", drawn by the world renderer) and, on a centre hit, "SMOKED!" right above it
// (drawn by the HUD). OWNER: Render & Audio engineer. Pure and deterministic (QA F5, F13).
//
// Every break with points gets one BLOCK: the popup line at the bottom (its baseline at `y`), the SMOKED! line above it on a centre hit, and
// the room the popup rises into. A new block never overlaps a block that is still alive: it moves up above it, or below when it would leave
// the top of the field; it never enters the banner strip at the top centre (it goes below it) and it stays inside the field horizontally.
// The world renderer and the HUD each own one stack and feed it the SAME hit events with the same clock, so both compute the same
// positions without talking to each other.

import { ART_CONFIG } from './art-config.js';
import { FIELD } from '../shared/playfield.js';

const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

/** The label spec of a hit event, or null when it shows no popup (no points: Zen, practice). */
export function hitLabelSpec(ev) {
  const points = num(ev && ev.points, 0);
  if (!(points > 0)) return null;
  const big = !!ev.centre || ev.kind === 'gold';
  const r = Math.max(6, num(ev.rPx, 30));
  return { x: num(ev.x, FIELD.cx), y: num(ev.y, FIELD.cy) - r - 18, centre: !!ev.centre, big, points };
}

/**
 * @param {object} [config] ART_CONFIG (fx.labels, fx.popupBannerZone, fx.popupRisePx, sizes)
 */
export function createLabelStack(config = ART_CONFIG) {
  const FX = config.fx;
  const L = FX.labels;
  const BZ = FX.popupBannerZone;
  const live = []; // {x, top, bottom, until}
  const out = { x: 0, y: 0 };

  const lineH = (big) => (big ? FX.popupSizeBig : FX.popupSize) * 0.92;

  function overlaps(x, top, bottom, e) {
    return Math.abs(x - e.x) < L.w && top < e.bottom + L.gap && bottom > e.top - L.gap;
  }

  /**
   * Place the block of `spec` at time `nowMs`. Returns {x, y} (shared object): the popup's baseline anchor; SMOKED! sits at
   * y - lineH(big) - L.smokedGap.
   */
  function place(spec, nowMs) {
    for (let i = live.length - 1; i >= 0; i--) if (live[i].until <= nowMs) live.splice(i, 1);
    const h = lineH(spec.big);
    const above = h + FX.popupRisePx + (spec.centre ? L.smokedH : 0); // room above the baseline
    const below = h * 0.3;
    const x = Math.min(FIELD.w - L.w / 2 - L.edge, Math.max(L.w / 2 + L.edge, spec.x));
    let y = Math.min(FIELD.h - below - 10, Math.max(L.top + above, spec.y));
    const inZone = (yy) => Math.abs(x - FIELD.cx) < BZ.halfW + L.w / 2 && yy - above < BZ.bottom && yy + below > BZ.top;
    if (inZone(y)) y = BZ.bottom + above;
    // resolve upwards first, then downwards from the original row
    let dir = -1;
    for (let guard = 0; guard < 24; guard++) {
      let hit = null;
      for (const e of live) if (overlaps(x, y - above, y + below, e)) { hit = e; break; }
      if (!hit) break;
      if (dir < 0) {
        y = hit.top - L.gap - below;
        if (y - above < L.top || inZone(y)) {
          dir = 1;
          y = Math.max(spec.y, L.top + above);
          if (inZone(y)) y = BZ.bottom + above;
        }
      } else {
        y = hit.bottom + L.gap + above;
      }
    }
    y = Math.min(FIELD.h - below - 10, y);
    live.push({ x, top: y - above, bottom: y + below, until: nowMs + L.lifeMs });
    if (live.length > L.max) live.shift();
    out.x = x;
    out.y = y;
    return out;
  }

  return {
    place,
    lineH,
    clear() { live.length = 0; },
    get live() { return live.length; },
  };
}
