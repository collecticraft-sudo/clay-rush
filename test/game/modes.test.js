import test from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG } from '../../public/js/game/index.js';
import { modeTraits } from '../../public/js/game/modes.js';
import { project } from '../../public/js/shared/world.js';
import { createHarness, shotAt, playRound, createAimBot } from '../../test-support/game/helpers.js';
import { timeBonusFor } from '../../public/js/game/game.js';

const still = (h, x = 0) => {
  const [id] = h.game.debugSpawn({ still: true, pos: { x, y: 5, z: 20 } });
  const p = project(x, 5, 20);
  return { id, x: p.sx, y: p.sy };
};

test('Time Attack: 90 s clock on real time, ticks in the last 10 s, timeUp, ending, over with endReason timer', () => {
  const h = createHarness('timeattack', 1, { stage: 'meadow' }, { validate: true });
  const s0 = h.snap();
  assert.equal(s0.timeLeft, 90);
  assert.equal(s0.timeTotal, 90);
  assert.equal(s0.phase, 'flight');
  assert.equal(s0.stage.id, 'meadow');
  assert.equal(s0.pull.count, null);
  h.run(30);
  assert.ok(Math.abs(h.snap().timeLeft - 60) < 0.02);
  h.run(61);
  assert.deepEqual(h.ofType('tick').map((e) => e.secondsLeft), [10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
  assert.equal(h.ofType('timeUp').length, 1);
  assert.equal(h.snap().endReason, 'timer');
  h.run(2);
  assert.equal(h.game.isOver(), true);
  const r = h.game.getResult();
  assert.equal(r.endReason, 'timer');
  assert.equal(r.stageId, 'meadow');
  assert.equal(r.rank, 'D', 'nothing broken');
  assert.ok(r.presented > 25, `waves launched automatically: ${r.presented}`);
});

/**
 * Watch a whole Time Attack round tick by tick. Returns the worst value of
 *   (airborne + still to launch in the wave) - (shells in the gun + shots of this wave that broke nothing)
 * which must never be > 0: a wave never brings more clays than shells, and only a miss can leave a clay without a shell.
 */
function watchInvariant(seed, stage, difficulty, bot) {
  const h = createHarness('timeattack', seed, { stage, difficulty });
  const shots = bot ? createAimBot(h.game, bot) : [];
  let worst = -Infinity;
  let misses = 0;
  let waves = 0;
  let wasIdle = true;
  for (let i = 0; i < 200 * 60 && !h.game.isOver(); i++) {
    const before = h.events.length;
    h.step(1 / 60, shots);
    const s = h.snap();
    for (const e of h.events.slice(before)) {
      if (e.type === 'launch' && wasIdle) {
        waves += 1;
        misses = 0;
        wasIdle = false;
      }
      if (e.type === 'shot' && e.hitIds.length === 0) misses += 1;
    }
    assert.equal(s.shells.reloadingS, 0, 'no timed reload in Time Attack any more');
    assert.ok(s.pull.targetsLeft <= s.shells.capacity, 'a wave never exceeds the gun');
    worst = Math.max(worst, s.pull.targetsLeft - s.shells.loaded - misses);
    if (s.pull.targetsLeft === 0) wasIdle = true;
  }
  return { worst, waves, h };
}

test('Time Attack invariant: airborne clays never exceed the shells in the gun (many seeds, every stage, perfect and sloppy bots)', () => {
  for (let seed = 1; seed <= 6; seed++) {
    for (const stage of ['meadow', 'hills', 'alpine']) {
      const difficulty = seed % 2 ? 'easy' : 'normal';
      const perfect = watchInvariant(seed, stage, difficulty, { minAgeS: 0.15 });
      assert.ok(perfect.worst <= 0, `seed ${seed} ${stage} ${difficulty}: ${perfect.worst} more clays than shells`);
      assert.ok(perfect.waves > 20);
      const r = perfect.h.game.getResult();
      assert.equal(r.lost, 0, `seed ${seed} ${stage} ${difficulty}: the perfect bot broke every clay (${r.broken}/${r.presented})`);
      assert.equal(r.endReason, 'timer');
      const sloppy = watchInvariant(seed, stage, difficulty, { minAgeS: 0.15, missEvery: 3 });
      assert.ok(sloppy.worst <= 0, `sloppy seed ${seed} ${stage}: ${sloppy.worst}`);
    }
  }
  // Hard: the pellets travel (hits resolve later); the gun still never holds fewer shells than the wave has clays at launch
  const hard = watchInvariant(3, 'alpine', 'hard', null);
  assert.ok(hard.waves > 20);
  assert.ok(hard.worst <= 0);
  const hardBot = watchInvariant(4, 'hills', 'hard', { hard: true, minAgeS: 0.15 });
  const hr = hardBot.h.game.getResult();
  assert.ok(hr.broken >= 0.8 * hr.presented, `Hard bot broke ${hr.broken}/${hr.presented}`);
});

test('Time Attack waves: one at a time, refilled gun at each wave, gap 1.4 s shrinking to 0.5 s, doubles more often later', () => {
  const h = createHarness('timeattack', 2, { stage: 'hills' }, { validate: true });
  const waves = []; // [launchT, lastResolveT]
  let flying = false;
  let doubles = [0, 0];
  for (let i = 0; i < 160 * 60 && !h.game.isOver(); i++) {
    const before = h.events.length;
    h.step(1 / 60);
    const s = h.snap();
    for (const e of h.events.slice(before)) {
      if (e.type === 'launch' && !flying) {
        waves.push({ start: e.t, end: null, gapBefore: waves.length ? e.t - waves.at(-1).end : null });
        if (e.double) doubles[e.t < 45 ? 0 : 1] += 1;
        flying = true;
      }
    }
    if (flying && s.targets.length === 0 && s.pull.targetsLeft === 0) {
      waves.at(-1).end = s.t;
      flying = false;
    }
  }
  assert.ok(waves.length > 20);
  const gaps = waves.filter((w) => w.gapBefore !== null).map((w) => w.gapBefore);
  assert.ok(gaps.every((g) => g > 0.45), 'never overlapping, always a gap');
  assert.ok(Math.abs(gaps[0] - 1.4) < 0.1, `first gap ${gaps[0]}`);
  assert.ok(Math.min(...gaps.slice(-5)) < 0.7, 'late gaps are short');
  assert.ok(doubles[1] > doubles[0], `doubles early ${doubles[0]}, late ${doubles[1]}`);
});

test('Time Attack shells: two per wave, no reload after two shots, dry click when spent; +1.5 s per break, max 120 s', () => {
  const h = createHarness('timeattack', 3, {}, { validate: true });
  h.game.debugSetAutoLaunch(false);
  h.step(0.1);
  const a = still(h, -2);
  h.step(1 / 60, (now) => [shotAt(a.x, a.y, now)]);
  const bonus = h.ofType('timeBonus')[0];
  assert.equal(bonus.deltaS, 1.5);
  assert.ok(Math.abs(h.snap().timeLeft - (90 - h.snap().t + 1.5)) < 1e-9);
  h.step(1 / 60, (now) => [shotAt(5, 5, now)]);
  h.step(1 / 60, (now) => [shotAt(5, 5, now)]);
  assert.deepEqual(h.ofType('shot').map((e) => e.shell), [0, 1]);
  assert.equal(h.ofType('dryFire').length, 1);
  assert.equal(h.ofType('reload').length, 0, 'no automatic reload');
  h.run(2);
  assert.equal(h.snap().shells.loaded, 0, 'still empty: only a new wave refills');
  still(h, 2);
  h.step(1 / 60);
  assert.deepEqual(h.ofType('reload').map((e) => [e.phase, e.ms]), [['start', 0], ['done', 0]]);
  assert.equal(h.snap().shells.loaded, 2);

  // the clock is capped at 120 s
  const c = createHarness('timeattack', 3);
  c.game.debugSetAutoLaunch(false);
  for (let i = 0; i < 34; i++) {
    const t = still(c, (i % 7) - 3);
    c.step(1 / 60, (now) => [shotAt(t.x, t.y, now)]);
  }
  assert.ok(c.snap().timeLeft <= 120);
  assert.equal(Math.max(...c.ofType('timeBonus').map((e) => e.timeLeft)), 120, 'capped at 120 s');
  assert.ok(c.ofType('timeBonus').some((e) => e.deltaS < 1.5), 'the bonus is cut by the cap');
});

test('Time Attack bonus steps: +1.5 s for breaks 1-20, +0.75 s for 21-40, then +0.25 s', () => {
  assert.deepEqual([1, 20, 21, 40, 41, 500].map(timeBonusFor), [1.5, 1.5, 0.75, 0.75, 0.25, 0.25]);
  const h = createHarness('timeattack', 3, {}, { validate: true });
  h.game.debugSetAutoLaunch(false);
  h.run(60, { frameS: 1 / 30 }); // let the clock fall to 30 s so the 120 s cap never trims a bonus
  for (let i = 0; i < 45; i++) {
    const t = still(h, (i % 7) - 3);
    h.step(1 / 60, (now) => [shotAt(t.x, t.y, now)]);
  }
  const d = h.ofType('timeBonus').map((e) => e.deltaS);
  assert.equal(d.length, 45);
  assert.deepEqual(d, [...Array(20).fill(1.5), ...Array(20).fill(0.75), ...Array(5).fill(0.25)]);
  assert.equal(h.game.isOver(), false);
});

test('Time Attack: a perfect bot cannot play forever, the round ends at the 180 s cap with endReason timer', () => {
  const h = playRound('timeattack', 12, { stage: 'hills' }, { maxS: 200, frameS: 1 / 30, bot: { minAgeS: 0.15 } });
  assert.equal(h.game.isOver(), true);
  const r = h.game.getResult();
  assert.equal(r.endReason, 'timer');
  assert.equal(h.ofType('timeUp').length, 1);
  assert.ok(r.durationS <= 180 + 2, `round lasted ${r.durationS} s`);
  assert.ok(r.broken > 40, `the bot broke ${r.broken}`);
  const upT = h.ofType('timeUp')[0].t;
  assert.ok(upT <= 180 + 1e-6);
  const late = h.ofType('timeBonus').slice(40);
  assert.ok(late.every((e) => e.deltaS <= 0.25 + 1e-9));
});

test('Time Attack: the 180 s cap ends the round, and the clock is honest: it shows the time really left and reaches 0', () => {
  const h = createHarness('timeattack', 4, {}, { validate: false });
  h.game.debugSetAutoLaunch(false);
  // three clays in one pattern every 0.3 s: about 10 breaks per second keep the clock up even at +0.25 s each
  for (let i = 0; i < 2000 && !h.game.isOver(); i++) {
    h.game.debugSpawn([0, 0.05, 0.1].map((dx) => ({ still: true, pos: { x: dx, y: 5, z: 20 } })));
    const p = project(0.05, 5, 20);
    h.step(1 / 60, (now) => [shotAt(p.sx, p.sy, now)]);
    h.run(0.28);
    const s = h.snap();
    assert.ok(s.timeLeft <= Math.max(0, 180 - s.t) + 1e-9, `t ${s.t}: the clock shows ${s.timeLeft}`);
  }
  h.run(3);
  assert.equal(h.game.isOver(), true);
  const up = h.ofType('timeUp');
  assert.equal(up.length, 1);
  assert.ok(Math.abs(up[0].t - 180) < 0.02, `timeUp at ${up[0].t}`);
  const r = h.game.getResult();
  assert.equal(r.endReason, 'timer');
  assert.equal(h.snap().timeLeft, 0, 'the clock reached 0 exactly at the cap');
  assert.deepEqual(h.ofType('tick').slice(-3).map((e) => e.secondsLeft), [3, 2, 1], 'the last seconds were counted down');
  assert.ok(r.broken > 120);
});

test('Time Attack ranks separate players (QA F1, review G-01): 100 -> S, 90 -> A, 75 -> B, 60 -> C, 40 percent hits -> D', () => {
  const expected = [[1, 'S'], [0.9, 'A'], [0.75, 'B'], [0.6, 'C'], [0.4, 'D']];
  for (const [accuracy, rank] of expected) {
    for (const seed of [1, 2]) {
      const h = playRound('timeattack', seed, { stage: 'hills' }, { maxS: 200, frameS: 1 / 30, bot: { accuracy, botSeed: seed * 31 + 7, minAgeS: 0.2 } });
      const r = h.game.getResult();
      assert.equal(r.rank, rank, `accuracy ${accuracy} seed ${seed}: score ${r.score} ranked ${r.rank}`);
    }
  }
});

test('Time Attack: rank by score thresholds; the gold clay appears at most once per round', () => {
  const h = playRound('timeattack', 9, { stage: 'hills' }, { maxS: 120, bot: { missEvery: 2 } });
  if (!h.game.isOver()) h.game.end('quit');
  const r = h.game.getResult();
  assert.ok(['S', 'A', 'B', 'C', 'D'].includes(r.rank));
  const golds = h.ofType('hit').filter((e) => e.kind === 'gold').length + h.ofType('lost').filter((e) => e.kind === 'gold').length;
  assert.ok(golds <= 1);
});

test('Zen: no score, no timer, unlimited shells (shell -1), slower targets, pattern x1.3, recent statistics, rank null', () => {
  const t = modeTraits('zen', { difficulty: 'hard' });
  assert.equal(t.difficulty, 'normal', 'difficulty is ignored');
  assert.equal(t.speedMul, CONFIG.zen.speedMul);
  assert.equal(t.patternMul, CONFIG.zen.patternMul);
  assert.equal(t.gold, false);
  const h = createHarness('zen', 4, { stage: 'meadow' }, { validate: true });
  const s0 = h.snap();
  assert.equal(s0.timeLeft, null);
  assert.equal(s0.shells.infinite, true);
  for (let i = 0; i < 30; i++) h.step(1 / 30, (now) => [shotAt(5, 5, now)]);
  assert.equal(h.ofType('shot').length, 30);
  assert.ok(h.ofType('shot').every((e) => e.shell === -1));
  assert.equal(h.ofType('dryFire').length, 0);
  assert.deepEqual(h.snap().zen, { recentShots: 20, recentHits: 0 });
  const bot = playRound('zen', 4, { stage: 'alpine' }, { maxS: 60, bot: { missEvery: 3 } });
  assert.equal(bot.game.isOver(), false, 'Zen ends only through end()');
  const s = bot.snap();
  assert.equal(s.score, 0);
  assert.ok(s.stats.broken > 10);
  assert.ok(s.zen.recentHits > 0);
  assert.ok(s.targets.length <= 2, 'one wave at a time');
  assert.equal(s.worldScale, CONFIG.zen.distanceMul, 'Zen plays at the Easy distance');
  assert.equal(bot.ofType('hit').filter((e) => e.kind === 'gold').length, 0, 'never gold in Zen');
  bot.game.end('quit');
  assert.equal(bot.game.getResult().rank, null);
  assert.equal(bot.game.getResult().score, 0);
});

test('practice: one slow clay every 3 s from the trap house, practice events thrown / hit / lost, never ends by itself', () => {
  const h = createHarness('practice', 5, {}, { validate: true });
  assert.equal(h.snap().practice.shown, 0);
  h.run(1.05);
  assert.deepEqual(h.ofType('practice').map((e) => e.phase), ['thrown']);
  assert.equal(h.ofType('launch')[0].house, 'trap');
  const t = h.snap().targets[0];
  assert.ok(Math.hypot(t.vx, t.vy, t.vz) < 16, 'slow');
  h.run(3);
  assert.deepEqual(h.ofType('practice').map((e) => e.phase), ['thrown', 'lost', 'thrown']);
  h.until((s) => s.targets.length > 0 && s.targets[0].ageS > 0.4, 4);
  const s = h.snap();
  const tt = s.targets[0];
  const p = project(tt.x + tt.vx * s.alpha / 120, tt.y + tt.vy * s.alpha / 120, tt.z + tt.vz * s.alpha / 120);
  h.step(1 / 60, (now) => [shotAt(p.sx, p.sy, now)]);
  assert.equal(h.ofType('practice').at(-1).phase, 'hit');
  assert.equal(h.snap().practice.hit, 1);
  assert.equal(h.snap().score, 0);
  h.run(60);
  assert.equal(h.game.isOver(), false);
  assert.ok(h.snap().practice.shown >= 20);
  h.game.end('quit');
  const r = h.game.getResult();
  assert.equal(r.mode, 'practice');
  assert.equal(r.rank, null);
  assert.equal(r.endReason, 'quit');
});
