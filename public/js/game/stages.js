// Stages, Classic pull plans and the automatic waves of Time Attack and Zen (docs/game-design.md 7). OWNER: Gameplay engineer.
// Pure: every random choice comes from the rng passed in.

import { CONFIG } from './config.js';

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

/**
 * The stage table used by the UI menus and the HUD (architecture 5).
 * @type {ReadonlyArray<{index:number, id:'meadow'|'hills'|'alpine', name:string, backdrop:string, pulls:number, targets:number,
 *   wind:{speed:number, gustAmp:number, gustPeriodS:number}, houses:string[]}>}
 */
export const STAGES = deepFreeze(
  CONFIG.stages.map((s, index) => ({
    index, id: s.id, name: s.name, backdrop: s.backdrop, pulls: s.pulls, targets: s.targets,
    wind: { speed: s.wind.speed, gustAmp: s.wind.gustAmp, gustPeriodS: s.wind.gustPeriodS }, houses: s.houses.slice(),
  })),
);

export const STAGE_IDS = Object.freeze(CONFIG.stages.map((s) => s.id));

/** 0-based index of a stage id, or -1. */
export function stageIndexOf(id) {
  return STAGE_IDS.indexOf(id);
}

/** A fresh, mutable pull built from a pull type of CONFIG.pullTypes. */
export function pullFromType(type) {
  const members = CONFIG.pullTypes[type];
  if (!members) throw new RangeError(`unknown pull type "${type}"`);
  return { type, members: members.map((mm) => ({ kind: mm.kind, house: mm.house, offsetS: mm.offsetS })), double: members.length > 1 };
}

function shuffle(arr, rng) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = rng.int(0, i);
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }
  return arr;
}

function moveTo(pulls, pred, index) {
  const i = pulls.findIndex(pred);
  if (i < 0) return;
  const [p] = pulls.splice(i, 1);
  pulls.splice(index < 0 ? pulls.length : index, 0, p);
}

/**
 * The seeded pull plan of a Classic stage (design 7.1).
 * @param {number} stageIndex
 * @param {ReturnType<import('../shared/rng.js').createRng>} rng
 * @returns {Array<{type:string, members:Array<{kind:string, house:string, offsetS:number}>, double:boolean}>}
 */
export function buildStagePlan(stageIndex, rng) {
  const cfg = CONFIG.stages[stageIndex];
  const plan = cfg.plan;
  const pulls = [];
  for (const g of plan.groups) {
    const types = shuffle(g.types.slice(), rng);
    for (let i = 0; i < g.count; i++) pulls.push(pullFromType(types[i % types.length]));
  }
  shuffle(pulls, rng);
  if (plan.last) moveTo(pulls, (p) => p.type === plan.last, -1);
  if (plan.first === 'single') moveTo(pulls, (p) => !p.double, 0);
  else if (plan.first) moveTo(pulls, (p) => p.type === plan.first, 0);
  if (plan.miniInLast > 0) {
    const n = pulls.length;
    const idx = rng.int(n - plan.miniInLast, n - 1);
    const first = pulls[idx].members[0];
    if (first.kind === 'standard') first.kind = 'mini';
  }
  for (let k = 0; k < plan.gold; k++) {
    const singles = pulls.filter((p) => !p.double && p.members[0].kind === 'standard');
    if (singles.length === 0) break;
    rng.pick(singles).members[0].kind = 'gold';
  }
  return pulls;
}

/**
 * One automatic wave (Time Attack, Zen): a double with probability `doubleChance`, else a single, each drawn from the
 * stage's weighted pool. Always two draws from the rng, whatever the outcome.
 * @param {string} stageId
 * @param {ReturnType<import('../shared/rng.js').createRng>} rng
 * @param {number} doubleChance   0..1
 */
export function drawWave(stageId, rng, doubleChance) {
  const pools = CONFIG.waves[stageId];
  const double = rng.next() < doubleChance;
  const pool = double ? pools.doubles : pools.singles;
  const idx = rng.weightedIndex(pool.map((e) => e.w));
  return pullFromType(pool[idx].type);
}
