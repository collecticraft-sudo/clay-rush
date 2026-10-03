// Ranks (design 5 and 7.2). OWNER: Gameplay engineer. Pure.
// Classic: by the percentage of targets broken (S >= 95, A >= 85, B >= 70, C >= 50, else D).
// Time Attack: by score (CONFIG.ranks.timeattack: S 175000, A 85000, B 33000, C 17000, else D). Zen and practice: null.

import { CONFIG } from './config.js';

const PERCENT = 100;

/**
 * @param {{mode:string, score?:number, broken?:number, presented?:number}|null} result   a RoundResult (or the same fields)
 * @returns {'S'|'A'|'B'|'C'|'D'|null}
 */
export function rankFor(result) {
  if (!result || typeof result !== 'object') return null;
  const table = CONFIG.ranks[result.mode];
  if (!Array.isArray(table)) return null;
  let value;
  if (result.mode === 'classic') {
    const presented = Number.isFinite(result.presented) ? result.presented : 0;
    const broken = Number.isFinite(result.broken) ? result.broken : 0;
    value = presented > 0 ? (PERCENT * broken) / presented : 0;
  } else {
    value = Number.isFinite(result.score) ? result.score : 0;
  }
  for (const row of table) if (value >= row.min) return row.rank;
  return CONFIG.ranks.lowest;
}
