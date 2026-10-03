import test from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG } from '../../public/js/game/index.js';
import { project } from '../../public/js/shared/world.js';
import { createHarness, shotAt } from '../../test-support/game/helpers.js';

const DT = CONFIG.time.dt;

/** Classic debug double of two still targets; returns the harness after the first (off-centre) break. */
function doubleSetup(opts) {
  const h = createHarness('classic', 8, opts, { validate: true });
  h.until((s) => s.phase === 'ready' && s.shells.loaded === 2, 2);
  h.game.debugSpawn([{ still: true, pos: { x: -3, y: 5, z: 20 } }, { still: true, pos: { x: 3, y: 5, z: 20 } }]);
  const a = project(-3, 5, 20);
  h.step(DT, (now) => [shotAt(a.sx + 20, a.sy, now)]); // a break, not a centre hit
  h.run(0.1, { frameS: DT });
  return h;
}

test('hit stop: a break freezes the world for 40 ms of real time (timeScale 0) when nothing else flies; the UI clock keeps running', () => {
  const h = createHarness('zen', 2, {}, { validate: true });
  h.game.debugSetAutoLaunch(false);
  h.step(0.05);
  h.game.debugSpawn({ still: true, pos: { x: 0, y: 5, z: 20 } });
  const p = project(0, 5, 20);
  h.step(DT, (now) => [shotAt(p.sx, p.sy, now)]);
  assert.deepEqual(h.ofType('hitStop').map((e) => e.ms), [40]);
  const s0 = h.snap();
  assert.equal(s0.timeScale, 0);
  const t0 = s0.t;
  h.run(0.03, { frameS: DT });
  assert.equal(h.snap().timeScale, 0, 'the world is frozen');
  assert.ok(h.snap().t > t0 + 0.02, 'real time runs');
  h.run(0.03, { frameS: DT });
  assert.equal(h.snap().timeScale, 1);
});

test('hit stop: never while another clay still flies (a 40 ms freeze of a flying clay reads as a stutter; render feedback 2026-10-03)', () => {
  const h = createHarness('zen', 2, {}, { validate: true });
  h.game.debugSetAutoLaunch(false);
  h.step(0.05);
  h.game.debugSpawn({ still: true, pos: { x: 0, y: 5, z: 20 } });
  h.game.debugSpawn({ pos: { x: 5, y: 8, z: 30 }, vel: { x: 0, y: 3, z: 0 } }); // keeps flying
  const p = project(0, 5, 20);
  h.step(DT, (now) => [shotAt(p.sx, p.sy, now)]);
  assert.deepEqual(h.ofType('hitStop').map((e) => e.ms), [0]);
  assert.equal(h.snap().timeScale, 1);
  const y0 = h.snap().targets[0].y;
  h.run(0.03, { frameS: DT });
  assert.notEqual(h.snap().targets[0].y, y0, 'the other clay keeps flying');
});

test('kill cam: a centre hit that ends a double => timeScale 0.25 for 0.45 s, killCam snapshot and event, zoom 1.12', () => {
  const h = doubleSetup({});
  assert.equal(h.ofType('killCam').length, 0, 'the first, off-centre break of the double: no kill cam');
  const b = project(3, 5, 20);
  h.step(DT, (now) => [shotAt(b.sx, b.sy, now)]);
  const kc = h.ofType('killCam');
  assert.equal(kc.length, 1);
  assert.equal(kc[0].durationMs, 450);
  assert.equal(kc[0].scale, 1.12);
  assert.ok(Math.abs(kc[0].x - b.sx) < 1e-6);
  assert.equal(h.ofType('double').length, 1);
  assert.equal(h.snap().timeScale, 0, 'hit stop first');
  h.run(0.05, { frameS: DT });
  const s = h.snap();
  assert.equal(s.timeScale, 0.25);
  assert.ok(s.killCam && s.killCam.zoom === 1.12 && s.killCam.leftS > 0 && s.killCam.leftS < 0.45);
  h.run(0.42, { frameS: DT });
  assert.equal(h.snap().timeScale, 1);
  assert.equal(h.snap().killCam, null);
});

test('kill cam: a gold clay always triggers it; an ordinary single centre hit does not', () => {
  const h = createHarness('timeattack', 9, {}, { validate: true });
  h.game.debugSetAutoLaunch(false);
  h.step(0.05);
  h.game.debugSpawn({ kind: 'gold', still: true, pos: { x: 2, y: 5, z: 20 } });
  const g = project(2, 5, 20);
  h.step(DT, (now) => [shotAt(g.sx + 25, g.sy, now)]);
  assert.equal(h.ofType('hit')[0].kind, 'gold');
  assert.equal(h.ofType('hit')[0].centre, false);
  assert.equal(h.ofType('killCam').length, 1);
  h.run(0.7);
  h.game.debugSpawn({ still: true, pos: { x: -2, y: 5, z: 20 } });
  const p = project(-2, 5, 20);
  h.step(DT, (now) => [shotAt(p.sx, p.sy, now)]);
  assert.equal(h.ofType('hit').length, 2);
  assert.equal(h.ofType('hit')[1].centre, true);
  assert.equal(h.ofType('killCam').length, 1);
});

test('reduceMotion: no hit stop and no slow motion; the events still fire with 0 durations', () => {
  const h = doubleSetup({ reduceMotion: true });
  assert.deepEqual(h.ofType('hitStop').map((e) => e.ms), [0]);
  const b = project(3, 5, 20);
  h.step(DT, (now) => [shotAt(b.sx, b.sy, now)]);
  assert.equal(h.ofType('killCam').length, 1);
  assert.equal(h.ofType('killCam')[0].durationMs, 0);
  assert.deepEqual(h.ofType('hitStop').map((e) => e.ms), [0, 0]);
  assert.equal(h.snap().timeScale, 1);
  assert.equal(h.snap().killCam, null);
  h.run(0.2, { frameS: DT });
  assert.equal(h.snap().timeScale, 1);
});

test('kill cam slows the world but not the real-time timers (Time Attack clock)', () => {
  const h = createHarness('timeattack', 10, {}, { validate: true });
  h.game.debugSetAutoLaunch(false);
  h.step(0.05);
  h.game.debugSpawn({ kind: 'gold', still: true, pos: { x: 0, y: 5, z: 20 } });
  const p = project(0, 5, 20);
  h.step(DT, (now) => [shotAt(p.sx, p.sy, now)]);
  const s0 = h.snap();
  h.run(0.3, { frameS: DT });
  const s1 = h.snap();
  assert.ok(Math.abs((s0.timeLeft - s1.timeLeft) - (s1.t - s0.t)) < 1e-9, 'the clock follows real time');
  assert.ok(s1.tWorld - s0.tWorld < 0.5 * (s1.t - s0.t), 'the world ran slower');
});
