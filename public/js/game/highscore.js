// Best scores and result formatting helpers (design 5, architecture 8.4). OWNER: Gameplay engineer.
// Pure: no storage, no clock, no exceptions. ui/storage.js owns localStorage (key CONFIG.storage.key) and stores the table
// returned here under `best`.
//
// Table shape: { [bestKey]: BestRecord }, keys 'classic.<difficulty>' and 'timeattack.<difficulty>.<stage>'.
// BestRecord: { score, rank, broken, presented, accuracy (0..1 or null), bestStreak, assist }. Zen and practice are not scored.

import { CONFIG } from './config.js';
import { DIFFICULTIES } from './modes.js';
import { STAGE_IDS } from './stages.js';

const SEP = CONFIG.storage.bestKeySep;
const RANKS = ['S', 'A', 'B', 'C', 'D'];
const SECONDS_PER_MINUTE = 60;
const PERCENT = 100;

/**
 * Key of a best-score entry, or null for modes that keep no best score (zen, practice) or bad arguments.
 * @param {'classic'|'timeattack'|'zen'|'practice'} mode
 * @param {'easy'|'normal'|'hard'} difficulty
 * @param {'meadow'|'hills'|'alpine'|null} [stageId]   ignored for Classic (all three stages)
 * @returns {string|null}
 */
export function bestKey(mode, difficulty, stageId = null) {
  if (!DIFFICULTIES.includes(difficulty)) return null;
  if (mode === 'classic') return ['classic', difficulty].join(SEP);
  if (mode === 'timeattack' && STAGE_IDS.includes(stageId)) return ['timeattack', difficulty, stageId].join(SEP);
  return null;
}

/** Every valid key (for the best-scores screen). */
export function allBestKeys() {
  const keys = [];
  for (const d of DIFFICULTIES) keys.push(bestKey('classic', d));
  for (const d of DIFFICULTIES) for (const s of STAGE_IDS) keys.push(bestKey('timeattack', d, s));
  return keys;
}

/** An empty best table (a fresh object every call). */
export function emptyBest() {
  return {};
}

const isCount = (v) => Number.isFinite(v) && v >= 0;

function cleanRecord(r) {
  if (r === null || typeof r !== 'object' || !isCount(r.score)) return null;
  return {
    score: Math.floor(r.score),
    rank: RANKS.includes(r.rank) ? r.rank : null,
    broken: isCount(r.broken) ? Math.floor(r.broken) : 0,
    presented: isCount(r.presented) ? Math.floor(r.presented) : 0,
    accuracy: Number.isFinite(r.accuracy) ? Math.min(1, Math.max(0, r.accuracy)) : null,
    bestStreak: isCount(r.bestStreak) ? Math.floor(r.bestStreak) : 0,
    assist: r.assist === true,
  };
}

/**
 * Sanitise a best table read from storage (untrusted JSON): unknown keys and malformed records are dropped, numbers are
 * floored and clamped. Never throws.
 */
export function sanitizeBest(raw) {
  const out = emptyBest();
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const key of allBestKeys()) {
    const rec = cleanRecord(raw[key]);
    if (rec) out[key] = rec;
  }
  return out;
}

function keyOf(result) {
  if (!result || typeof result !== 'object') return null;
  return bestKey(result.mode, result.difficulty, result.stageId);
}

/**
 * True when `result` beats the stored best of its key: a scored mode, a score above 0 and strictly above the record.
 * @param {object} best     table (sanitizeBest / emptyBest)
 * @param {object} result   RoundResult
 */
export function isNewBest(best, result) {
  const key = keyOf(result);
  if (!key || !CONFIG.storage.scoredModes.includes(result.mode)) return false;
  if (!Number.isFinite(result.score) || result.score <= 0) return false;
  const prev = best && typeof best === 'object' ? cleanRecord(best[key]) : null;
  return prev === null || result.score > prev.score;
}

/**
 * Merge a finished round into the table without mutating it. Returns the new table (the same content when the result
 * is not a new best). A result played with aim assist is stored with `assist: true` (design 6.5).
 * @param {object} best
 * @param {object} result   RoundResult
 * @returns {object}        the new table
 */
export function updateBest(best, result) {
  const next = sanitizeBest(best);
  if (!isNewBest(next, result)) return next;
  next[keyOf(result)] = cleanRecord({
    score: result.score, rank: result.rank, broken: result.broken, presented: result.presented,
    accuracy: result.accuracy, bestStreak: result.bestStreak, assist: result.assist === true,
  });
  return next;
}

/**
 * Accuracy as a whole percent, null when no shot was fired ("-" on the results screen).
 * @param {{accuracy:number|null}|number|null} result   a RoundResult, or the accuracy itself (0..1)
 * @returns {number|null}
 */
export function accuracyPercent(result) {
  const acc = typeof result === 'number' ? result : result && typeof result === 'object' ? result.accuracy : null;
  return Number.isFinite(acc) ? Math.round(acc * PERCENT) : null;
}

/** Duration as m:ss. */
export function formatDuration(durationS) {
  const total = Math.max(0, Math.floor(Number.isFinite(durationS) ? durationS : 0));
  const mm = Math.floor(total / SECONDS_PER_MINUTE);
  const ss = total % SECONDS_PER_MINUTE;
  return `${mm}:${String(ss).padStart(2, '0')}`;
}
