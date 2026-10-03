// Scoring rules (docs/game-design.md section 5). OWNER: Gameplay engineer. Pure.

import { CONFIG } from './config.js';

const SC = CONFIG.scoring;
const STEPS = CONFIG.streak.steps;

/** Streak multiplier 1..4 for a number of consecutive broken targets: x1 (0-2), x2 (3-5), x3 (6-9), x4 (10+). */
export function multiplierFor(streak) {
  let m = 1;
  for (let i = 1; i < STEPS.length; i++) if (streak >= STEPS[i]) m = i + 1;
  return m;
}

/** 0..1 progress towards the next multiplier step (1 at the top step). */
export function multiplierProgress(streak) {
  const m = multiplierFor(streak);
  if (m >= STEPS.length) return 1;
  const lo = STEPS[m - 1];
  const hi = STEPS[m];
  const p = (streak - lo) / (hi - lo);
  return p < 0 ? 0 : p > 1 ? 1 : p;
}

/** Distance bonus: +distancePerM per metre beyond distanceFromM, rounded down (design 5). */
export function distanceBonus(z) {
  return z > SC.distanceFromM ? Math.floor(SC.distancePerM * (z - SC.distanceFromM)) : 0;
}

/**
 * Points of one broken target BEFORE the multiplier. The distance bonus uses the Normal-world depth z / k, so the same
 * shot scores the same at every difficulty (the world scale k only changes how big things look).
 * @param {{kind:string, centre:boolean, firstBarrel:boolean, z:number, k?:number}} hit
 */
export function basePoints({ kind, centre, firstBarrel, z, k = 1 }) {
  return CONFIG.targets[kind].points + (centre ? SC.centre : 0) + (firstBarrel ? SC.firstBarrel : 0) + distanceBonus(z / k);
}
