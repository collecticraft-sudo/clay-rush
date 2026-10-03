import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame } from '../../public/js/game/index.js';
import { createRng } from '../../public/js/shared/rng.js';
import { createHarness, createAimBot, digest, shotAt } from '../../test-support/game/helpers.js';

/** A scripted session: bot shots plus some random shots, uneven frame times; digest of every snapshot and event. */
function session(mode, seed, { opts = {}, seconds = 40, chaosSeed = 777 } = {}) {
  const h = createHarness(mode, seed, opts);
  h.game.debugSetAutoLaunch(true);
  const bot = createAimBot(h.game, { missEvery: 3, hard: opts.difficulty === 'hard' });
  const rng = createRng(chaosSeed);
  const trace = [];
  let elapsed = 0;
  while (elapsed < seconds && !h.game.isOver()) {
    const dt = rng.range(0.008, 0.034);
    elapsed += dt;
    h.step(dt, (now) => {
      const shots = bot(now);
      if (rng.chance(0.03)) shots.push(shotAt(rng.range(0, 1920), rng.range(0, 1080), now - rng.range(0, 30)));
      return shots;
    });
    trace.push(h.snap());
  }
  return { digest: digest([trace, h.events]), h, trace };
}

test('DETERMINISM: same seed + same shots + same frame times => identical snapshots and events, every mode', () => {
  for (const [mode, opts] of [['classic', { difficulty: 'hard' }], ['timeattack', { stage: 'alpine' }], ['zen', {}], ['practice', {}]]) {
    const a = session(mode, 20261001, { opts });
    const b = session(mode, 20261001, { opts });
    assert.equal(a.digest, b.digest, mode);
    assert.ok(a.h.events.length > 20, `${mode}: the session did something`);
  }
});

test('DETERMINISM: a different seed or different shots give a different game', () => {
  const base = session('timeattack', 1);
  assert.notEqual(session('timeattack', 2).digest, base.digest, 'seed');
  assert.notEqual(session('timeattack', 1, { chaosSeed: 5 }).digest, base.digest, 'shots');
});

test('DETERMINISM: odd seeds are accepted and echoed; the streams use the seed as uint32', () => {
  for (const seed of [0, 1, 42, 0xffffffff, -7, 3.9, NaN]) {
    const g = createGame('zen', seed);
    const s = g.snapshot();
    assert.ok(Number.isFinite(s.seed));
    g.update(1 / 60, [], 16);
    assert.equal(g.snapshot().seed, s.seed);
  }
  const a = createGame('timeattack', -7);
  const b = createGame('timeattack', 0xfffffff9);
  for (let i = 1; i <= 300; i++) {
    a.update(1 / 60, [], i * 1000 / 60);
    b.update(1 / 60, [], i * 1000 / 60);
  }
  assert.deepEqual(a.snapshot().targets, b.snapshot().targets);
});

test('DETERMINISM: the Classic plan and the launches of a pull do not depend on when the player calls it', () => {
  const launches = (waitS) => {
    const h = createHarness('classic', 31);
    h.run(waitS); // idle in 'ready' for a while
    h.step(1 / 60, (now) => [shotAt(960, 540, now)]);
    h.run(1);
    const t = h.snap().targets[0];
    return t && { kind: t.kind, vx: t.vx.toFixed(6), vz: t.vz.toFixed(6) };
  };
  assert.deepEqual(launches(0.5), launches(3.3));
});
