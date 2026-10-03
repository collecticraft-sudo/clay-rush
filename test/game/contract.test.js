import test from 'node:test';
import assert from 'node:assert/strict';
import * as G from '../../public/js/game/index.js';
import { assertValid, validateGameSnapshot, validateGameEvent } from '../../public/js/shared/validate.js';
import { GAME_EVENT } from '../../public/js/shared/contracts.js';
import { createHarness, createAimBot, playRound } from '../../test-support/game/helpers.js';

test('index.js exports exactly the public API of architecture 5', () => {
  assert.deepEqual(Object.keys(G).sort(), [
    'CONFIG', 'STAGES', 'accuracyPercent', 'bestKey', 'createGame', 'emptyBest', 'formatDuration', 'isNewBest', 'rankFor',
    'sanitizeBest', 'updateBest',
  ]);
  const g = G.createGame('classic', 1);
  for (const k of ['update', 'snapshot', 'drainEvents', 'isOver', 'getResult', 'end', 'debugSpawn', 'debugSetAutoLaunch']) {
    assert.equal(typeof g[k], 'function', k);
  }
  assert.throws(() => G.createGame('arcade', 1), TypeError);
});

test('every snapshot and every event validates, in every mode, with a bot playing (and the result validates)', () => {
  const seen = new Set();
  for (const [mode, opts, maxS] of [
    ['classic', { difficulty: 'normal' }, 400], ['classic', { difficulty: 'hard', assist: true }, 400],
    ['timeattack', { difficulty: 'easy', stage: 'alpine' }, 60], ['zen', { stage: 'alpine' }, 40], ['practice', {}, 15],
  ]) {
    const h = createHarness(mode, 99, opts, { validate: true });
    h.game.debugSetAutoLaunch(true);
    const bot = createAimBot(h.game, { missEvery: 4, hard: opts.difficulty === 'hard' });
    h.run(maxS, { shots: bot });
    if (mode !== 'classic') {
      assert.equal(h.game.isOver(), false, `${mode} still running`);
      h.game.end('quit');
      assert.equal(h.game.getResult().endReason, 'quit');
    }
    assert.ok(h.game.isOver(), mode);
    const r = assertValid('RoundResult', h.game.getResult());
    assert.equal(r.mode, mode);
    assertValid('GameSnapshot', h.game.snapshot());
    for (const e of h.events) seen.add(e.type);
    // the events ring of the snapshot is bounded and validated
    assert.ok(h.game.snapshot().events.length <= 32);
  }
  // the rare ones on purpose: two with one shot, then a dry fire (Classic, both shells used on a debug pull)
  const h = createHarness('classic', 7, {}, { validate: true });
  h.until((s) => s.phase === 'ready' && s.shells.loaded === 2, 2);
  h.game.debugSpawn([{ still: true, pos: { x: 0, y: 4, z: 20 } }, { still: true, pos: { x: 0.1, y: 4, z: 20 } }, { still: true, pos: { x: 3, y: 4, z: 20 } }]);
  const p = { x: 960 + (1663 * 0.05) / 20, y: 670 - (1663 * 2.4) / 20 };
  h.step(1 / 60, (now) => [{ t: now, x: p.x, y: p.y, source: 'debug', compMs: 0 }]);
  h.step(1 / 60, (now) => [{ t: now, x: 10, y: 10, source: 'debug', compMs: 0 }]);
  h.step(1 / 60, (now) => [{ t: now, x: 10, y: 10, source: 'debug', compMs: 0 }]);
  for (const e of h.events) seen.add(e.type);
  // a Time Attack round nobody shoots at ends on the clock: ticks, timeUp
  const ta = createHarness('timeattack', 8, { stage: 'meadow' }, { validate: true });
  ta.run(95, { frameS: 1 / 30 });
  assert.equal(ta.game.getResult().endReason, 'timer');
  for (const e of ta.events) seen.add(e.type);
  for (const type of Object.values(GAME_EVENT)) assert.ok(seen.has(type), `event type ${type} was produced`);
});

test('the snapshot is a fresh plain object per call (callers may keep or mutate it)', () => {
  const h = playRound('timeattack', 3, {}, { maxS: 5 });
  const a = h.game.snapshot();
  const b = h.game.snapshot();
  assert.notEqual(a, b);
  assert.deepEqual(a, b);
  a.targets.length = 0;
  a.stats.broken = 999;
  if (a.events[0]) a.events[0].type = 'x';
  assert.deepEqual(h.game.snapshot(), b);
  assert.deepEqual(validateGameSnapshot(JSON.parse(JSON.stringify(b))), []);
});

test('drainEvents returns each event exactly once, with increasing seq and t in real seconds', () => {
  const h = createHarness('timeattack', 5);
  h.run(8);
  const seqs = h.events.map((e) => e.seq);
  assert.deepEqual(seqs, seqs.slice().sort((x, y) => x - y));
  assert.equal(new Set(seqs).size, seqs.length);
  assert.deepEqual(h.game.drainEvents(), []);
  for (const e of h.events) assert.deepEqual(validateGameEvent(e), []);
});

test('houses: the current stage, far first, projected ground point, sprites and mirroring as the contract says', () => {
  const g = G.createGame('zen', 1, { stage: 'alpine' });
  const hs = g.snapshot().houses;
  assert.deepEqual(hs.map((h) => h.id), ['tower', 'skeetR', 'skeetL', 'rabbitL', 'trap']);
  const by = Object.fromEntries(hs.map((h) => [h.id, h]));
  assert.equal(by.trap.sprite, 'house_trap');
  assert.equal(by.skeetL.sprite, 'house_skeet');
  assert.equal(by.skeetR.sprite, 'house_skeet');
  assert.equal(by.skeetR.mirrored, true);
  assert.equal(by.skeetL.mirrored, false);
  assert.equal(by.tower.sprite, 'house_tower');
  assert.equal(by.rabbitL.sprite, null);
  // Zen plays at the Easy distance (k 0.55): the trap house stands at z = 14 * 0.55 = 7.7
  assert.ok(Math.abs(by.trap.z - 7.7) < 1e-9);
  // the world is scaled about the camera: the ground point projects exactly where it does at k = 1
  assert.ok(Math.abs(by.trap.sy - (670 + (1663 * 1.6) / 14)) < 1e-9);
  assert.ok(Math.abs(by.trap.scale - 1663 / 7.7) < 1e-9);
  assert.equal(g.snapshot().worldScale, 0.55);
  for (const [diff, k] of [['normal', 1], ['hard', 1.45], ['easy', 0.55]]) {
    const trap = G.createGame('classic', 1, { difficulty: diff }).snapshot().houses[0];
    assert.ok(Math.abs(trap.z - 14 * k) < 1e-9, diff);
    assert.ok(Math.abs(trap.sx - 960) < 1e-9);
    assert.ok(Math.abs(trap.sy - (670 + (1663 * 1.6) / 14)) < 1e-9, `${diff}: same ground point on screen`);
  }
  assert.ok(by.trap.flashS >= 1e5, 'never launched: a huge number');
  const meadow = G.createGame('classic', 1).snapshot().houses;
  assert.deepEqual(meadow.map((h) => h.id), ['trap']);
});

test('targets: rPx = worldSize/2 * F / z and sx/sy interpolated with alpha between the last two ticks', () => {
  const h = createHarness('zen', 1);
  h.game.debugSetAutoLaunch(false);
  const [id] = h.game.debugSpawn({ kind: 'standard', house: 'trap', speed: 20, azimuthDeg: 0, elevationDeg: 30 });
  h.step(0.1);
  h.step(0.004); // half a tick into the next one
  const s = h.snap();
  const t = s.targets.find((o) => o.id === id);
  assert.ok(s.alpha > 0 && s.alpha < 1);
  assert.ok(Math.abs(t.rPx - (0.30 * 1663) / t.z) < 0.5, 'rPx at the interpolated depth');
  // sx/sy lie between the projections of the previous and the current tick
  const cur = { sx: 960 + (1663 * t.x) / t.z, sy: 670 - (1663 * (t.y - 1.6)) / t.z };
  assert.ok(Math.abs(t.sy - cur.sy) > 0.01, 'interpolated, not the raw current tick');
  assert.ok(Math.abs(t.sy - cur.sy) < 40);
});
