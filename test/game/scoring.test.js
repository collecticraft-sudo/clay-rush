import test from 'node:test';
import assert from 'node:assert/strict';
import { multiplierFor, multiplierProgress, distanceBonus, basePoints } from '../../public/js/game/scoring.js';
import { project } from '../../public/js/shared/world.js';
import { createHarness, shotAt } from '../../test-support/game/helpers.js';

test('streak multiplier x1 (0-2), x2 (3-5), x3 (6-9), x4 (10+) and the progress ring', () => {
  const table = [[0, 1], [2, 1], [3, 2], [5, 2], [6, 3], [9, 3], [10, 4], [55, 4]];
  for (const [s, m] of table) assert.equal(multiplierFor(s), m, `streak ${s}`);
  assert.equal(multiplierProgress(0), 0);
  assert.ok(Math.abs(multiplierProgress(1) - 1 / 3) < 1e-12);
  assert.equal(multiplierProgress(3), 0);
  assert.ok(Math.abs(multiplierProgress(8) - 0.5) < 1e-12);
  assert.equal(multiplierProgress(10), 1);
  assert.equal(multiplierProgress(40), 1);
});

test('points: base by kind, centre +50, first barrel +25, +4 per metre beyond 25 m rounded down', () => {
  assert.equal(distanceBonus(25), 0);
  assert.equal(distanceBonus(12), 0);
  assert.equal(distanceBonus(30), 20);
  assert.equal(distanceBonus(30.4), 21);
  assert.equal(basePoints({ kind: 'standard', centre: false, firstBarrel: false, z: 20 }), 100);
  assert.equal(basePoints({ kind: 'mini', centre: false, firstBarrel: false, z: 20 }), 150);
  assert.equal(basePoints({ kind: 'battue', centre: false, firstBarrel: false, z: 20 }), 150);
  assert.equal(basePoints({ kind: 'rabbit', centre: false, firstBarrel: false, z: 20 }), 150);
  assert.equal(basePoints({ kind: 'gold', centre: true, firstBarrel: true, z: 35 }), 300 + 50 + 25 + 40);
  // the distance bonus uses the Normal-world depth z / k: the same shot scores the same at every difficulty
  assert.equal(basePoints({ kind: 'standard', centre: false, firstBarrel: false, z: 35 * 0.55, k: 0.55 }), 140);
  assert.equal(basePoints({ kind: 'standard', centre: false, firstBarrel: false, z: 35 * 1.45, k: 1.45 }), 140);
});

/** Zen-free scored harness: Time Attack (2 shells + reload) with still debug targets. */
function breakOne(h, x = 0) {
  const [id] = h.game.debugSpawn({ still: true, pos: { x, y: 5, z: 20 } });
  const p = project(x, 5, 20);
  h.until((s) => s.shells.loaded > 0 && s.shells.reloadingS === 0, 2);
  h.step(1 / 60, (now) => [shotAt(p.sx, p.sy, now)]);
  return id;
}

test('the streak grows with consecutive breaks, streak events at x2/x3/x4, the multiplier applies to the points', () => {
  const h = createHarness('timeattack', 3, {}, { validate: true });
  h.game.debugSetAutoLaunch(false);
  for (let i = 0; i < 11; i++) breakOne(h, (i % 5) - 2);
  const hits = h.ofType('hit');
  assert.equal(hits.length, 11);
  assert.deepEqual(hits.map((e) => e.streak), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  assert.deepEqual(hits.map((e) => e.multiplier), [1, 1, 2, 2, 2, 3, 3, 3, 3, 4, 4]);
  for (const e of hits) assert.equal(e.points % e.multiplier, 0);
  assert.deepEqual(h.ofType('streak').map((e) => [e.level, e.streak]), [[2, 3], [3, 6], [4, 10]]);
  const s = h.snap();
  assert.equal(s.streak, 11);
  assert.equal(s.multiplier, 4);
  assert.equal(s.multiplierProgress, 1);
  assert.equal(s.stats.bestStreak, 11);
  assert.equal(s.score, hits.reduce((n, e) => n + e.points, 0));
});

test('a missed shot alone keeps the streak; a LOST target resets it to 0', () => {
  const h = createHarness('timeattack', 4, {}, { validate: true });
  h.game.debugSetAutoLaunch(false);
  breakOne(h);
  breakOne(h);
  h.until((s) => s.shells.loaded > 0 && s.shells.reloadingS === 0, 2);
  h.step(1 / 60, (now) => [shotAt(5, 5, now)]); // a miss
  assert.equal(h.snap().streak, 2);
  h.game.debugSpawn({ kind: 'standard', house: 'trap' }); // flies away untouched
  assert.ok(h.until((s) => s.stats.lost === 1, 8));
  assert.equal(h.snap().streak, 0);
  assert.equal(h.snap().multiplier, 1);
  assert.equal(h.snap().stats.bestStreak, 2);
});

test('hit event: screen position, depth, radius, screen velocity, shard seed', () => {
  const h = createHarness('zen', 5, {}, { validate: true });
  h.game.debugSetAutoLaunch(false);
  h.step(0.05);
  h.game.debugSpawn({ pos: { x: 0, y: 6, z: 20 }, vel: { x: 10, y: 0, z: 0 } });
  const t = h.snap().targets[0];
  const p = project(t.x, t.y, t.z);
  h.step(1 / 120, (now) => [shotAt(p.sx, p.sy, now)]);
  const hit = h.ofType('hit')[0];
  assert.ok(hit, 'hit');
  assert.ok(Math.abs(hit.z - 20) < 0.1);
  assert.ok(Math.abs(hit.rPx - (0.30 * 1663) / hit.z) < 1e-6);
  assert.ok(Math.abs(hit.vx - (10 * 1663) / 20) < 20, `screen vx ${hit.vx}`);
  assert.ok(Number.isInteger(hit.shardSeed) && hit.shardSeed >= 0);
  assert.equal(hit.points, 0, 'Zen keeps no score');
});
