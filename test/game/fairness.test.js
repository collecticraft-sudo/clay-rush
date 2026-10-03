import test from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG } from '../../public/js/game/index.js';
import { fairLaunch, safeParams, makeBody, finishBody, streamRng } from '../../public/js/game/launch.js';
import { simulateFlight, inView } from '../../public/js/game/physics.js';
import { createHarness } from '../../test-support/game/helpers.js';

const MIN = CONFIG.fairness.minVisibleS;
const DT = CONFIG.time.dt;
const COMBOS = [];
for (const members of Object.values(CONFIG.pullTypes)) for (const mm of members) {
  if (!COMBOS.some((c) => c.kind === mm.kind && c.house === mm.house)) COMBOS.push({ kind: mm.kind, house: mm.house });
}
COMBOS.push({ kind: 'gold', house: 'trap' }, { kind: 'gold', house: 'skeetL' }, { kind: 'gold', house: 'skeetR' });
// [world scale k, speed multiplier]: zen, easy, normal, hard
const SCALES = [[CONFIG.zen.distanceMul, CONFIG.zen.speedMul], ...['easy', 'normal', 'hard'].map((d) => [CONFIG.difficulty[d].distanceMul, CONFIG.difficulty[d].speedMul])];
const WINDS = [-3.25, 0, 3.25]; // alpine x hard, both sides

test('FAIRNESS: the clamp (safe parameters) of every house passes for every kind, world scale, speed multiplier and wind', () => {
  for (const c of COMBOS) for (const [k, speedMul] of SCALES) for (const base of WINDS) {
    const wind = { base, gustAmp: 1.3, gustPeriodS: 3, phase: 1 };
    const body = finishBody(makeBody(safeParams(c, { speedMul, k })), 0, wind);
    const v = simulateFlight(body, 0, wind).visibleS;
    assert.ok(v >= MIN, `${c.kind}@${c.house} k ${k} x${speedMul} wind ${base}: ${v.toFixed(2)} s`);
  }
});

test('FAIRNESS: over many seeds every launch stays >= 1.2 s in the shootable view; clamps are rare', () => {
  let clamped = 0;
  let total = 0;
  for (const c of COMBOS) for (const [k, speedMul] of SCALES) for (const base of WINDS) {
    const wind = { base, gustAmp: 1, gustPeriodS: 3, phase: 0.3 };
    for (let seed = 0; seed < 25; seed++) {
      const res = fairLaunch(streamRng(seed, 5, total), c, { speedMul, k }, { tWorld: seed * 0.37, wind });
      total += 1;
      if (res.clamped) clamped += 1;
      assert.ok(res.visibleS >= MIN, `${c.kind}@${c.house} k ${k} seed ${seed}: ${res.visibleS}`);
      assert.ok(res.body.z >= 1.5 * 4, 'launched well beyond zNear');
      assert.ok(res.attempts >= 1 && res.attempts <= CONFIG.fairness.retries + 1);
    }
  }
  assert.ok(clamped / total < 0.03, `clamped ${clamped} of ${total}`);
});

/** Watch every target of a round tick by tick (no shots) and measure its time in the shootable view. */
function observedVisibility(mode, seed, opts, seconds) {
  const h = createHarness(mode, seed, opts);
  h.game.debugSetAutoLaunch(true);
  const vis = new Map();
  const frames = Math.round(seconds / DT);
  let lastWorld = -1;
  for (let i = 0; i < frames && !h.game.isOver(); i++) {
    h.step(DT);
    const s = h.snap();
    if (s.tWorld === lastWorld) continue;
    lastWorld = s.tWorld;
    for (const t of s.targets) {
      if (!vis.has(t.id)) vis.set(t.id, 0);
      if (inView({ ...t, k: s.worldScale, rabbit: t.kind === 'rabbit' ? {} : null })) vis.set(t.id, vis.get(t.id) + DT);
    }
  }
  for (const t of h.snap().targets) vis.delete(t.id); // still flying when the observation stops: not complete
  return vis;
}

test('FAIRNESS in the game: every target actually launched (Classic all stages, Time Attack alpine) is visible >= 1.2 s', () => {
  for (const seed of [1, 2, 3]) {
    const difficulty = ['easy', 'normal', 'hard'][seed - 1];
    for (const [mode, opts, secs] of [['classic', { difficulty }, 120], ['timeattack', { stage: 'alpine', difficulty }, 60], ['zen', { stage: 'alpine' }, 40]]) {
      const vis = observedVisibility(mode, seed, opts, secs);
      assert.ok(vis.size >= 10, `${mode}: ${vis.size} targets`);
      for (const [id, v] of vis) assert.ok(v >= MIN - 2 * DT, `${mode} seed ${seed} target ${id}: ${v.toFixed(3)} s`);
    }
  }
});
