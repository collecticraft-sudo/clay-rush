// Scene fixtures of the render tests and the visual preview: valid GameSnapshots, GameEvents, the HUD strings of architecture 8.5 and a
// translator. OWNER: Render & Audio engineer. Pure (no Node API): imported by test/render/*.test.js and by test-support/render/preview.js.

import { project } from '../../public/js/shared/world.js';

export const STAGE_NAMES = Object.freeze({ meadow: 'MORNING MEADOW', hills: 'GOLDEN HILLS', alpine: 'ALPINE DUSK' });
const STAGE_INDEX = Object.freeze({ meadow: 0, hills: 1, alpine: 2 });

/** The houses of the design table (design 3), per stage. */
const HOUSES = Object.freeze({
  trap: { x: 0, y: 0.4, z: 14, sprite: 'house_trap' },
  skeetL: { x: -22, y: 3.0, z: 32, sprite: 'house_skeet' },
  skeetR: { x: 22, y: 1.2, z: 34, sprite: 'house_skeet' },
  tower: { x: -14, y: 6.0, z: 46, sprite: 'house_tower' },
  rabbitL: { x: -26, y: 0.15, z: 24, sprite: null },
});
const STAGE_HOUSES = Object.freeze({ meadow: ['trap'], hills: ['trap', 'skeetL', 'skeetR'], alpine: ['trap', 'skeetL', 'skeetR', 'tower', 'rabbitL'] });

/** English HUD strings of architecture 8.5 (the UI engineer owns the real table in ui/strings.en.js). */
export const HUD_STRINGS = Object.freeze({
  'hud.score': 'SCORE',
  'hud.best': 'BEST',
  'hud.pull': 'PULL {n}/{total}',
  'hud.pullPrompt': 'PRESS {fire} TO CALL PULL!',
  'hud.reloading': 'RELOADING',
  'hud.wind': '{speed} M/S',
  'hud.time': '{s}',
  'hud.stage': 'STAGE {n}: {name}',
  'hud.stageCard.title': 'STAGE {n}',
  'hud.stageCard.name': '{name}',
  'hud.banner.double': 'DOUBLE!',
  'hud.banner.twoWithOne': 'TWO WITH ONE!',
  'hud.banner.smoked': 'SMOKED!',
  'hud.banner.streak': 'STREAK x{n}',
  'hud.banner.perfect': 'PERFECT STAGE',
  'hud.banner.timeUp': 'TIME!',
  'hud.banner.newBest': 'NEW BEST!',
  'hud.lowBattery': 'Joy-Con battery low',
  'hud.zen.stats': '{hits} HITS, {acc}% OF THE LAST 20',
  'hud.dry': 'EMPTY',
  'hud.multiplier': 'x{n}',
});

/** A translator like the UI's: `{name}` placeholders replaced from params; records every key it was asked for in `calls`. */
export function makeTranslator(table = HUD_STRINGS) {
  const calls = [];
  const t = (key, params = {}) => {
    calls.push(key);
    const s = table[key] ?? key;
    return s.replace(/\{(\w+)\}/g, (_, k) => (params[k] !== undefined ? String(params[k]) : `{${k}}`));
  };
  t.calls = calls;
  return t;
}

export const LABELS = Object.freeze({ fire: 'ZR', confirm: 'A', back: 'B', pause: '+', recenter: 'R' });

/** A Target at world (x, y, z) with velocity (vx, vy, vz); its projection and drawn radius are filled in (0.15 m radius, mini 0.09). */
export function makeTarget(id, kind, frame, x, y, z, vx = 0, vy = 0, vz = 0, rot = 0) {
  const p = project(x, y, z);
  const radiusM = kind === 'mini' ? 0.09 : 0.15;
  return { id, kind, frame, x, y, z, vx, vy, vz, sx: p.sx, sy: p.sy, rPx: radiusM * p.s, rot, ageS: 0.6, pullIndex: 0 };
}

export function makeHouses(stageId, flashS = 1e9) {
  const out = [];
  for (const id of STAGE_HOUSES[stageId] ?? STAGE_HOUSES.hills) {
    const h = HOUSES[id];
    const p = project(h.x, 0, h.z);
    out.push({ id, sprite: h.sprite, x: h.x, y: h.y, z: h.z, sx: p.sx, sy: p.sy, scale: p.s, mirrored: id === 'skeetR', flashS: id === 'trap' ? flashS : 1e9 });
  }
  out.sort((a, b) => b.z - a.z);
  return out;
}

/** A complete, valid GameSnapshot; `over` patches top-level fields. */
export function makeSnapshot(over = {}) {
  const stageId = over.stageId ?? 'hills';
  const snap = {
    v: 1,
    mode: 'classic',
    difficulty: 'normal',
    seed: 7,
    phase: 'flight',
    t: 12.5,
    tWorld: 12.4,
    alpha: 0.5,
    timeScale: 1,
    stage: { index: STAGE_INDEX[stageId], id: stageId, count: 3, name: STAGE_NAMES[stageId] },
    pull: { index: 3, count: 8, targetsLeft: 1 },
    wind: { x: stageId === 'meadow' ? 0 : stageId === 'hills' ? 1.5 : -2.5, gust: stageId === 'alpine' ? -0.4 : 0 },
    shells: { loaded: 1, capacity: 2, reloadingS: 0, infinite: false },
    score: 12450,
    streak: 7,
    multiplier: 3,
    multiplierProgress: 0.25,
    timeLeft: null,
    timeTotal: null,
    targets: [],
    houses: makeHouses(stageId, over.houseFlashS ?? 1e9),
    killCam: null,
    practice: null,
    stats: { presented: 14, broken: 12, lost: 2, shots: 17, hits: 12, centre: 3, doubles: 2, bestStreak: 7 },
    assist: false,
    endReason: null,
    events: [],
  };
  for (const [k, v] of Object.entries(over)) if (k !== 'stageId' && k !== 'houseFlashS') snap[k] = v;
  return snap;
}

let seq = 0;
/** A GameEvent with a fresh seq. */
export function ev(type, fields = {}) {
  seq++;
  return { seq, t: 12 + seq * 0.01, type, ...fields };
}

/** Every GameEvent type with valid fields (one each). */
export function allEvents() {
  return [
    ev('stageStart', { index: 1, id: 'hills', name: 'GOLDEN HILLS', windX: 1.5 }),
    ev('ready', { stageIndex: 1, pullIndex: 3 }),
    ev('pull', { delayMs: 300 }),
    ev('launch', { ids: [41, 42], house: 'trap', double: true }),
    ev('shot', { x: 900, y: 400, shell: 0, hitIds: [41], source: 'mouse', compMs: 0 }),
    ev('dryFire', { x: 900, y: 400 }),
    ev('hit', { id: 41, kind: 'standard', x: 900, y: 400, z: 26, rPx: 9.6, vx: 220, vy: -80, points: 175, centre: true, firstBarrel: true, multiplier: 2, streak: 4, shardSeed: 12345 }),
    ev('lost', { id: 42, kind: 'standard', x: 1300, y: 820, reason: 'ground' }),
    ev('double', { points: 100, x: 960, y: 420 }),
    ev('twoWithOne', { points: 200, x: 960, y: 420 }),
    ev('streak', { level: 3, streak: 6 }),
    ev('stageClear', { index: 1, perfect: true, bonus: 500 }),
    ev('reload', { phase: 'start', ms: 600 }),
    ev('reload', { phase: 'done', ms: 600 }),
    ev('killCam', { x: 900, y: 400, durationMs: 450, scale: 1.12 }),
    ev('hitStop', { ms: 40 }),
    ev('timeBonus', { deltaS: 1.5, timeLeft: 42 }),
    ev('tick', { secondsLeft: 5 }),
    ev('timeUp', { score: 9000 }),
    ev('phase', { phase: 'settle' }),
    ev('practice', { phase: 'thrown' }),
  ];
}

/** The flying clays of the busy scene of a stage (far first is NOT guaranteed: the renderer sorts). */
export function busyTargets(stageId = 'hills') {
  const list = [
    makeTarget(1, 'standard', 'tilt', 3.2, 7.4, 27, 4, 3, 16, -0.25),
    makeTarget(2, 'battue', 'edge', -9, 5.5, 33, 14, 1, 2, 0.2),
    makeTarget(3, 'standard', 'below', 7.5, 9.8, 30, -10, -2, 3, 0.4),
    makeTarget(4, stageId === 'meadow' ? 'mini' : 'gold', stageId === 'meadow' ? 'tilt' : 'gold', -3.5, 11.5, 36, 3, 2, 14, -0.1),
  ];
  if (stageId === 'alpine') list.push(makeTarget(5, 'rabbit', 'rabbit', -5, 0.15, 16, 13, 0, -1, 0.9));
  return list;
}

/** The events of the busy scene: launches for the tally, a centre hit with a big burst, a lost clay, a streak. */
export function busyEvents() {
  return [
    ev('launch', { ids: [10, 11], house: 'trap', double: true }),
    ev('launch', { ids: [12], house: 'skeetL', double: false }),
    ev('launch', { ids: [1, 2, 3, 4], house: 'trap', double: false }),
    ev('shot', { x: 1210, y: 330, shell: 0, hitIds: [10], source: 'mouse', compMs: 0 }),
    ev('hit', { id: 10, kind: 'standard', x: 1210, y: 330, z: 24, rPx: 10.4, vx: 260, vy: -60, points: 175, centre: true, firstBarrel: true, multiplier: 3, streak: 7, shardSeed: 987654 }),
    ev('hit', { id: 11, kind: 'standard', x: 700, y: 520, z: 30, rPx: 8.3, vx: -120, vy: 40, points: 125, centre: false, firstBarrel: false, multiplier: 3, streak: 8, shardSeed: 4242 }),
    ev('lost', { id: 12, kind: 'standard', x: 420, y: 760, reason: 'ground' }),
    ev('streak', { level: 3, streak: 6 }),
  ];
}
