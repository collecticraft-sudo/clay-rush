// The shot: screen-space hit test at the shot instant (docs/game-design.md section 4) and aim assist (6.5).
// OWNER: Gameplay engineer. Pure.
//
// For every candidate target (its centre already evaluated at the shot instant, in world metres) we project the centre and
// the radii with shared/world.js:
//   patternPx = (r0 + spread * z) * patternMul * F / z     targetPx = sizeM / 2 * F / z
//   hit    if distance(aim, centre) <= patternPx + targetPx
//   centre if distance(aim, centre) <= centreFrac * patternPx   ("SMOKED!")
// Targets closer than zNear (or beyond zFar x world scale k) can neither be drawn nor hit. The pattern radius stays in metres
// whatever the world scale: closer (Easy) means a bigger pattern on screen, farther (Hard) a smaller one.

import { CONFIG } from './config.js';
import { WORLD, project } from '../shared/world.js';

const S = CONFIG.shot;

/** Pattern radius in metres at depth z (design 4), times the difficulty / mode / assist multiplier. */
export function patternRadiusM(z, patternMul = 1) {
  return (S.r0 + S.spread * z) * patternMul;
}

/** Pattern radius in playfield px at depth z. */
export function patternRadiusPx(z, patternMul = 1) {
  return (patternRadiusM(z, patternMul) * WORLD.F) / z;
}

/** Drawn radius of a target in px at depth z (Target.rPx). */
export function targetRadiusPx(sizeM, z) {
  return ((sizeM / 2) * WORLD.F) / z;
}

/** True when a depth can be hit at all. */
export function hittableDepth(z, k = 1) {
  return z >= WORLD.zNear && z <= WORLD.zFar * k;
}

/**
 * Project candidates: {id, x, y, z, sizeM, ...} in world metres -> adds sx, sy, patternPx, targetPx. Drops unhittable depths.
 * @param {Array<{id:number, x:number, y:number, z:number, sizeM:number}>} cands
 * @param {number} patternMul
 * @param {number} [k]   world scale (zFar x k)
 */
export function projectCandidates(cands, patternMul, k = 1) {
  const out = [];
  for (const c of cands) {
    if (!hittableDepth(c.z, k)) continue;
    const p = project(c.x, c.y, c.z);
    out.push({ ...c, sx: p.sx, sy: p.sy, patternPx: patternRadiusPx(c.z, patternMul), targetPx: targetRadiusPx(c.sizeM, c.z) });
  }
  return out;
}

/**
 * Aim assist Light (design 6.5): pull the aim 25 percent of the way towards the nearest target whose centre is within
 * rangePatterns pattern radii. `cands` come from projectCandidates (their patternPx already includes the assist enlargement).
 * @returns {{x:number, y:number, targetId:number|null}}
 */
export function assistAim(aim, cands) {
  const A = CONFIG.assist;
  let best = null;
  let bestRatio = Infinity;
  for (const c of cands) {
    const d = Math.hypot(c.sx - aim.x, c.sy - aim.y);
    const ratio = d / c.patternPx;
    if (ratio <= A.rangePatterns && ratio < bestRatio) {
      bestRatio = ratio;
      best = c;
    }
  }
  if (!best) return { x: aim.x, y: aim.y, targetId: null };
  return { x: aim.x + (best.sx - aim.x) * A.pull, y: aim.y + (best.sy - aim.y) * A.pull, targetId: best.id };
}

/**
 * Hit test of one projected candidate.
 * @returns {{hit:boolean, centre:boolean, dist:number}}
 */
export function testHit(aim, c) {
  const dist = Math.hypot(c.sx - aim.x, c.sy - aim.y);
  const hit = dist <= c.patternPx + c.targetPx;
  return { hit, centre: hit && dist <= S.centreFrac * c.patternPx, dist };
}

/** Pellet travel time in seconds to depth z (Hard). */
export function travelTimeS(z) {
  return z / S.pelletSpeed;
}
