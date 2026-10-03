import test from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG, STAGES } from '../../public/js/game/index.js';
import { buildStagePlan } from '../../public/js/game/stages.js';
import { createRng } from '../../public/js/shared/rng.js';
import { project } from '../../public/js/shared/world.js';
import { createHarness, shotAt, aimPoint } from '../../test-support/game/helpers.js';

const centre = (now) => [shotAt(960, 540, now)];
const at = (x, y) => (now) => [shotAt(x, y, now)];
const screenOf = (x, y, z) => {
  const p = project(x, y, z);
  return { x: p.sx, y: p.sy };
};

test('Classic starts in ready on stage 1 with the two-shell insert, then a Shot in ready calls the pull without using a shell', () => {
  const h = createHarness('classic', 11, {}, { validate: true });
  const s0 = h.snap();
  assert.equal(s0.phase, 'ready');
  assert.deepEqual(s0.stage, { index: 0, id: 'meadow', count: 3, name: 'Morning Meadow' });
  assert.deepEqual(s0.pull, { index: 0, count: 10, targetsLeft: 1 });
  assert.equal(s0.shells.loaded, 0);
  assert.ok(s0.shells.reloadingS > 0);
  assert.deepEqual(h.game.drainEvents().map((e) => e.type), ['stageStart', 'phase', 'reload', 'ready']);
  h.run(0.45);
  assert.equal(h.snap().shells.loaded, 2, 'loaded after 0.4 s');
  assert.equal(h.ofType('reload').at(-1).phase, 'done');

  h.step(1 / 60, centre);
  const pull = h.ofType('pull');
  assert.equal(pull.length, 1);
  assert.ok(pull[0].delayMs >= 150 && pull[0].delayMs <= 550);
  assert.equal(h.snap().phase, 'pull');
  assert.equal(h.ofType('shot').length, 0, 'calling the pull is not a shot');
  assert.equal(h.snap().stats.shots, 0);
  assert.equal(h.snap().shells.loaded, 2);
  // the trigger during the pull delay does nothing
  h.step(1 / 60, centre);
  assert.equal(h.ofType('shot').length + h.ofType('dryFire').length, 0);
  assert.ok(h.until((s) => s.phase === 'flight', 1));
  const launch = h.ofType('launch');
  assert.equal(launch.length, 1);
  assert.equal(launch[0].house, 'trap');
  assert.equal(launch[0].double, false);
  assert.equal(h.snap().targets.length, 1);
  assert.equal(h.snap().targets[0].pullIndex, 0);
});

test('two shells per pull: first barrel shell 0, second shell 1, then a dry click with no shot', () => {
  const h = createHarness('classic', 12, {}, { validate: true });
  h.run(0.5);
  h.step(1 / 60, centre);
  h.until((s) => s.phase === 'flight', 1);
  h.step(1 / 60, at(5, 5));
  h.step(1 / 60, at(5, 5));
  h.step(1 / 60, at(5, 5));
  const shots = h.ofType('shot');
  assert.deepEqual(shots.map((e) => e.shell), [0, 1]);
  assert.equal(h.ofType('dryFire').length, 1);
  assert.equal(h.snap().stats.shots, 2);
  assert.equal(h.snap().shells.loaded, 0);
  assert.equal(h.snap().streak, 0, 'a missed shot alone does not reset anything, nothing was broken');
  // the clay falls: lost, settle 0.7 s, then the next ready with the next pull
  assert.ok(h.until((s) => s.phase === 'settle', 8));
  assert.equal(h.ofType('lost').length, 1);
  const settleT = h.snap().t;
  assert.ok(h.until((s) => s.phase === 'ready', 2));
  assert.ok(Math.abs(h.snap().t - settleT - CONFIG.classic.settleS) < 0.05);
  assert.equal(h.snap().pull.index, 1);
  assert.equal(h.ofType('ready').at(-1).pullIndex, 1);
});

test('auto pull (setting) calls 1.2 s after ready; debugSetAutoLaunch(false) disables it, (true) pulls as soon as loaded', () => {
  const a = createHarness('classic', 13, { autoPull: true });
  a.run(1.1);
  assert.equal(a.ofType('pull').length, 0);
  a.run(0.2);
  assert.equal(a.ofType('pull').length, 1);
  const pullT = a.ofType('pull')[0].t;
  assert.ok(Math.abs(pullT - 1.2) < 0.02, `pulled at ${pullT}`);

  const b = createHarness('classic', 13, { autoPull: true });
  b.game.debugSetAutoLaunch(false);
  b.run(5);
  assert.equal(b.ofType('pull').length, 0);

  const c = createHarness('classic', 13);
  c.game.debugSetAutoLaunch(true);
  c.run(0.5);
  assert.equal(c.ofType('pull').length, 1);
  assert.ok(Math.abs(c.ofType('pull')[0].t - CONFIG.classic.loadS) < 0.02);

  const d = createHarness('classic', 13);
  d.run(10);
  assert.equal(d.ofType('pull').length, 0, 'without the setting the player calls every pull');
});

test('stage plans (design 7.1): meadow 10 singles with one mini in the last 3; hills 4 singles, 4 doubles, 1 gold; alpine', () => {
  for (let seed = 1; seed <= 40; seed++) {
    const rng = () => createRng(seed * 7919);
    const meadow = buildStagePlan(0, rng());
    assert.equal(meadow.length, 10);
    assert.ok(meadow.every((p) => !p.double && p.members[0].house === 'trap'));
    const minis = meadow.map((p, i) => (p.members[0].kind === 'mini' ? i : -1)).filter((i) => i >= 0);
    assert.equal(minis.length, 1);
    assert.ok(minis[0] >= 7);

    const hills = buildStagePlan(1, rng());
    assert.equal(hills.length, 8);
    const singles = hills.filter((p) => !p.double);
    assert.equal(singles.length, 4);
    assert.equal(singles.filter((p) => p.members[0].house === 'skeetL').length, 2);
    assert.equal(singles.filter((p) => p.members[0].house === 'skeetR').length, 2);
    assert.equal(hills.filter((p) => p.double).length, 4);
    assert.ok(hills.filter((p) => p.double).every((p) => ['skeetPair', 'trapPair'].includes(p.type)));
    assert.equal(hills.flatMap((p) => p.members).filter((mm) => mm.kind === 'gold').length, 1);
    assert.equal(hills[0].double, false, 'the stage opens with a single');

    const alpine = buildStagePlan(2, rng());
    assert.equal(alpine.length, 8);
    assert.equal(alpine[0].type, 'towerSingle');
    assert.equal(alpine.at(-1).type, 'battuePair');
    assert.equal(alpine.filter((p) => p.type === 'towerSingle').length, 2);
    assert.equal(alpine.filter((p) => p.type === 'rabbitClay').length, 2);
    assert.deepEqual(alpine.filter((p) => ['skeetPair', 'trapPair', 'towerSkeet'].includes(p.type)).map((p) => p.type).sort(),
      ['skeetPair', 'towerSkeet', 'trapPair']);
    const targets = [meadow, hills, alpine].map((pl) => pl.reduce((n, p) => n + p.members.length, 0));
    assert.deepEqual(targets, [10, 12, 14]);
    assert.deepEqual(targets, STAGES.map((s) => s.targets));
  }
});

test('the trap pair launches its second clay 0.4 s after the first; a double is announced on both launches', () => {
  // find a seed whose first Time Attack wave on the meadow is a trap pair
  let found = null;
  for (let seed = 1; seed < 60 && !found; seed++) {
    const t = createHarness('timeattack', seed, { stage: 'meadow' });
    t.run(1.6);
    const l = t.ofType('launch');
    if (l.length >= 2 && l[0].double && l[1].double && l[0].house === 'trap') found = l;
  }
  assert.ok(found, 'a seed with a trap pair as first wave');
  assert.ok(Math.abs(found[1].t - found[0].t - 0.4) < 0.01);
});

test('doubles: both targets of a double broken => DOUBLE +100 x multiplier; with one shot also TWO WITH ONE +200', () => {
  const h = createHarness('classic', 21, {}, { validate: true });
  h.until((s) => s.phase === 'ready' && s.shells.loaded === 2, 2);
  const [a, b] = h.game.debugSpawn([{ still: true, pos: { x: -3, y: 5, z: 20 } }, { still: true, pos: { x: 3, y: 5, z: 20 } }]);
  assert.equal(h.snap().phase, 'flight');
  const pa = screenOf(-3, 5, 20);
  const pb = screenOf(3, 5, 20);
  h.step(1 / 60, at(pa.x, pa.y));
  assert.equal(h.ofType('double').length, 0);
  h.step(1 / 60, at(pb.x, pb.y));
  const d = h.ofType('double');
  assert.equal(d.length, 1);
  assert.equal(d[0].points, 100);
  const hits = h.ofType('hit');
  assert.deepEqual(hits.map((e) => e.id), [a, b]);
  assert.equal(hits[0].firstBarrel, true);
  assert.equal(hits[1].firstBarrel, false);
  assert.equal(hits[0].points, 100 + 50 + 25, 'standard + centre + first barrel (z 20: no distance bonus)');
  assert.equal(hits[1].points, 100 + 50);
  assert.equal(h.snap().score, 175 + 150 + 100);
  assert.equal(h.snap().stats.doubles, 1);
  assert.equal(h.ofType('twoWithOne').length, 0);

  const g = createHarness('classic', 22, {}, { validate: true });
  g.until((s) => s.phase === 'ready' && s.shells.loaded === 2, 2);
  g.game.debugSpawn([{ still: true, pos: { x: 0, y: 5, z: 30 } }, { still: true, pos: { x: 0.6, y: 5, z: 30 } }]);
  const p = screenOf(0.3, 5, 30);
  g.step(1 / 60, at(p.x, p.y));
  assert.equal(g.ofType('shot')[0].hitIds.length, 2);
  assert.equal(g.ofType('twoWithOne').length, 1);
  assert.equal(g.ofType('twoWithOne')[0].points, 200);
  assert.equal(g.ofType('double').length, 1);
  assert.equal(g.snap().stats.hits, 1, 'one shot that broke something');
  assert.equal(g.snap().stats.broken, 2);
  const dist = Math.floor(4 * 5); // z 30: +4 per metre beyond 25
  const base = g.ofType('hit').map((e) => e.points);
  assert.deepEqual(base, [100 + 25 + dist, 100 + 25 + dist], 'off-centre for both (the aim is between them), first barrel');
});

test('perfect stage: +500 x multiplier when every target of the stage is broken; a lost target spoils it', () => {
  const h = createHarness('classic', 5);
  // the bot breaks the whole first stage
  h.until((s) => s.stage.index === 1, 120, {
    shots: (now) => {
      const s = h.snap();
      if (s.phase === 'ready') return [shotAt(960, 540, now)];
      if (s.phase !== 'flight' || !s.targets.length || s.shells.loaded === 0) return [];
      const t = s.targets[0];
      if (t.ageS < 0.2) return [];
      const p = aimPoint(s, t);
      return [shotAt(p.x, p.y, now)];
    },
  });
  const clear = h.ofType('stageClear')[0];
  assert.equal(clear.perfect, true);
  assert.equal(clear.bonus, 500 * 4, 'x4: ten in a row');
  assert.equal(h.snap().phase, 'stageCard');
  const cardT = h.events.find((e) => e.type === 'phase' && e.phase === 'stageCard').t;
  h.until((s) => s.phase === 'ready', 4);
  assert.ok(Math.abs(h.snap().t - cardT - 2.5) < 0.05, 'stage card 2.5 s');
  assert.equal(h.ofType('stageStart').at(-1).id, 'hills');
  assert.deepEqual(h.snap().houses.map((x) => x.id).sort(), ['skeetL', 'skeetR', 'trap']);

  const lazy = createHarness('classic', 5);
  lazy.until((s) => s.stage.index === 1, 120, { shots: (now) => (lazy.snap().phase === 'ready' ? [shotAt(960, 540, now)] : []) });
  const c2 = lazy.ofType('stageClear')[0];
  assert.equal(c2.perfect, false);
  assert.equal(c2.bonus, 0);
  assert.equal(lazy.snap().stats.lost, 10);
});

test('shots during settle and the stage card are ignored; end() quits at once with a valid result', () => {
  const h = createHarness('classic', 6);
  h.game.debugSetAutoLaunch(true);
  h.until((s) => s.phase === 'settle', 10);
  h.step(1 / 60, centre);
  assert.equal(h.ofType('shot').length + h.ofType('dryFire').length + h.ofType('pull').length, 1, 'only the auto pull');
  h.game.end('quit');
  assert.equal(h.game.isOver(), true);
  const r = h.game.getResult();
  assert.equal(r.endReason, 'quit');
  assert.equal(h.snap().phase, 'over');
  h.step(1 / 60, centre);
  assert.equal(h.snap().stats.shots, 0, 'nothing happens after the end');
});
