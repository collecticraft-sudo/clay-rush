// Regression tests for the final QA report and code review (docs/qa/final/): F2, F3, G-02, G-03, G-04, G-05, R-01 (event order).
import test from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG } from '../../public/js/game/index.js';
import { project } from '../../public/js/shared/world.js';
import { createHarness, playRound, shotAt, aimPoint } from '../../test-support/game/helpers.js';

const DT = CONFIG.time.dt;

test('F3: doubles count in Time Attack (+100 x multiplier, banner event, stats) and in Zen (stats, no points)', () => {
  const ta = playRound('timeattack', 2, { stage: 'hills' }, { maxS: 200, frameS: 1 / 30, bot: { minAgeS: 0.2 } });
  const d = ta.ofType('double');
  assert.ok(d.length > 10, `${d.length} doubles`);
  assert.ok(d.every((e) => e.points > 0 && e.points % 100 === 0));
  assert.equal(ta.game.getResult().doubles, d.length);
  const zen = playRound('zen', 3, { stage: 'hills' }, { maxS: 120, bot: { minAgeS: 0.2 } });
  const zd = zen.ofType('double');
  assert.ok(zd.length > 3, `${zd.length} Zen doubles`);
  assert.ok(zd.every((e) => e.points === 0));
  assert.equal(zen.snap().stats.doubles, zd.length);
  // a double where one clay is lost is not a double
  const miss = playRound('timeattack', 2, { stage: 'hills' }, { maxS: 60, bot: { minAgeS: 0.2, missEvery: 2, retryS: 99 } });
  assert.ok(miss.ofType('double').length < d.length);
});

test('F2: the Time Attack clock never shows more than the time left before the 180 s cap', () => {
  const h = createHarness('timeattack', 5, { stage: 'meadow' });
  const bot = (now) => {
    const s = h.snap();
    if (s.phase !== 'flight') return [];
    const t = s.targets.find((o) => o.ageS > 0.2);
    if (!t || s.shells.loaded === 0) return [];
    const p = aimPoint(s, t);
    return [shotAt(p.x, p.y, now)];
  };
  let maxShown = 0;
  for (let i = 0; i < 200 * 30 && !h.game.isOver(); i++) {
    h.step(1 / 30, bot);
    const s = h.snap();
    if (s.timeLeft !== null) assert.ok(s.timeLeft <= Math.max(0, CONFIG.timeattack.roundCapS - s.t) + 1e-9);
    maxShown = Math.max(maxShown, s.timeLeft ?? 0);
  }
  const up = h.ofType('timeUp')[0];
  assert.ok(up, 'time up');
  assert.equal(h.snap().timeLeft, 0);
  assert.ok(maxShown > 90, 'bonuses did raise the clock');
});

test('G-03 / G-04: end("finished") completes a Zen session; quitting during the ending keeps the original reason', () => {
  const z = createHarness('zen', 1);
  z.run(3);
  z.game.end('finished');
  assert.equal(z.game.getResult().endReason, 'complete');
  const q = createHarness('zen', 1);
  q.run(1);
  q.game.end('quit');
  assert.equal(q.game.getResult().endReason, 'quit');
  const ta = createHarness('timeattack', 1, { stage: 'meadow' });
  ta.run(90.5);
  assert.equal(ta.snap().phase, 'ending');
  ta.game.end('quit');
  assert.equal(ta.game.getResult().endReason, 'timer', 'a decided round is not lost by a quit');
});

test('G-02: setReduceMotion(true) during a round stops the hit stop and the kill cam from then on', () => {
  const h = createHarness('timeattack', 9, {}, { validate: true });
  h.game.debugSetAutoLaunch(false);
  h.step(0.05);
  h.game.debugSpawn({ kind: 'gold', still: true, pos: { x: 0, y: 5, z: 20 } });
  const p = project(0, 5, 20);
  h.step(DT, (now) => [shotAt(p.sx, p.sy, now)]);
  assert.equal(h.snap().timeScale, 0, 'hit stop running');
  h.game.setReduceMotion(true);
  h.step(DT);
  assert.equal(h.snap().timeScale, 1);
  assert.equal(h.snap().killCam, null);
  h.game.debugSpawn({ kind: 'gold', still: true, pos: { x: 1, y: 5, z: 20 } });
  const q = project(1, 5, 20);
  h.step(DT, (now) => [shotAt(q.sx, q.sy, now)]);
  assert.equal(h.ofType('killCam').at(-1).durationMs, 0);
  assert.equal(h.ofType('hitStop').at(-1).ms, 0);
  assert.equal(h.snap().timeScale, 1);
});

test('G-05: on Hard the pellets travel in world time (a kill cam slows them like the clays)', () => {
  // two identical Hard shots at a crosser, one during a kill cam: the same lead (in world time) must hit in both
  const run = (withKillCam) => {
    const h = createHarness('timeattack', 4, { difficulty: 'hard' }, { validate: true });
    h.game.debugSetAutoLaunch(false);
    h.step(0.05);
    if (withKillCam) {
      h.game.debugSpawn({ kind: 'gold', still: true, pos: { x: 6, y: 9, z: 40 } });
      const g = project(6, 9, 40);
      h.step(DT, (now) => [shotAt(g.sx, g.sy, now)]);
      h.run(0.1, { frameS: DT });
      assert.equal(h.snap().timeScale, CONFIG.juice.killCam.timeScale);
    }
    const [id] = h.game.debugSpawn({ pos: { x: -4, y: 8, z: 40 }, vel: { x: 50, y: 0, z: 0 } });
    h.step(DT);
    const s = h.snap();
    const t = s.targets.find((o) => o.id === id);
    const p = aimPoint(s, t, t.z / CONFIG.shot.pelletSpeed);
    h.step(DT, (now) => [shotAt(p.x, p.y, now)]);
    h.run(0.6, { frameS: DT });
    return h.ofType('hit').filter((e) => e.id === id).length;
  };
  assert.equal(run(false), 1);
  assert.equal(run(true), 1);
});

test('R-01 (event order for the HUD): stageClear is emitted before stageStart of the next stage, in that order', () => {
  const h = createHarness('classic', 5);
  h.game.debugSetAutoLaunch(true);
  h.until((s) => s.stage.index === 1, 120);
  const iClear = h.events.findIndex((e) => e.type === 'stageClear');
  const iStart = h.events.findIndex((e, i) => i > 0 && e.type === 'stageStart');
  assert.ok(iClear >= 0 && iStart > iClear);
  assert.equal(h.events[iStart].id, 'hills');
});
