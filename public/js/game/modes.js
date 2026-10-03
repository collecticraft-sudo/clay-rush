// Mode traits: Classic, Time Attack, Zen and the calibration practice round (design 7, architecture C-06).
// OWNER: Gameplay engineer. Pure. modeTraits() collapses the per-mode tables of CONFIG into one flat record so the
// engine never branches on mode names for numbers.

import { CONFIG } from './config.js';
import { stageIndexOf } from './stages.js';

export const MODES = Object.freeze(['classic', 'timeattack', 'zen', 'practice']);
export const DIFFICULTIES = Object.freeze(['easy', 'normal', 'hard']);

/**
 * @param {'classic'|'timeattack'|'zen'|'practice'} mode
 * @param {{difficulty?:string, stage?:string}} [opts]
 */
export function modeTraits(mode, opts = {}) {
  if (!MODES.includes(mode)) throw new TypeError(`createGame: unknown mode "${mode}" (expected ${MODES.join('|')})`);
  const usesDifficulty = mode === 'classic' || mode === 'timeattack';
  const difficulty = usesDifficulty && DIFFICULTIES.includes(opts.difficulty) ? opts.difficulty : CONFIG.defaults.difficulty;
  const D = CONFIG.difficulty[difficulty];
  const defaultStage = mode === 'timeattack' ? CONFIG.timeattack.defaultStage : mode === 'zen' ? CONFIG.zen.defaultStage : CONFIG.practice.defaultStage;
  const stageId = stageIndexOf(opts.stage) >= 0 ? opts.stage : defaultStage;
  const classic = mode === 'classic';
  const ta = mode === 'timeattack';
  const zen = mode === 'zen';
  const practice = mode === 'practice';
  return Object.freeze({
    mode,
    difficulty,
    stageIds: classic ? CONFIG.stages.map((s) => s.id) : [stageId],
    scored: classic || ta,
    pulls: classic, // the player calls each launch
    waves: ta || zen, // automatic waves
    practice,
    timerS: ta ? CONFIG.timeattack.durationS : null,
    maxTimeS: ta ? CONFIG.timeattack.maxS : null,
    roundCapS: ta ? CONFIG.timeattack.roundCapS : null,
    capacity: classic ? CONFIG.classic.shellsPerPull : ta ? CONFIG.timeattack.capacity : CONFIG.classic.shellsPerPull,
    infiniteShells: zen || practice,
    // world scale (owner decision 2026-10-03): the difficulty changes the distance; Zen plays at the Easy distance
    k: zen ? CONFIG.zen.distanceMul : practice ? CONFIG.practice.distanceMul : D.distanceMul,
    speedMul: zen ? CONFIG.zen.speedMul : practice ? 1 : D.speedMul,
    patternMul: zen ? CONFIG.zen.patternMul : practice ? CONFIG.practice.patternMul : D.patternMul,
    travel: usesDifficulty && D.travel,
    windMul: practice ? 0 : usesDifficulty ? D.windMul : 1,
    gold: !zen && !practice,
    endingS: CONFIG.ending[mode],
    ranked: classic || ta,
  });
}
