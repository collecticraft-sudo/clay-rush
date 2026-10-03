import test from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG } from '../../public/js/game/index.js';
import { createHarness, aimPoint, shotAt } from '../../test-support/game/helpers.js';

// A fast crosser (40 m/s to the right at 20 m): 40 ms of flight move it by 1.6 m = 133 px, far more than the pattern.
const CROSSER = { pos: { x: -4, y: 6, z: 20 }, vel: { x: 40, y: 0, z: 0 } };

function setup(mode = 'zen', opts = {}) {
  const h = createHarness(mode, 3, opts, { validate: true });
  h.game.debugSetAutoLaunch(false);
  h.step(0.05);
  const [id] = h.game.debugSpawn(CROSSER);
  h.step(1 / 60);
  h.step(1 / 60);
  return { h, id };
}

/** Where the crosser is `afterMs` after the setup (a twin game advanced by exactly that much). */
function positionAfter(afterMs, mode, opts) {
  const { h, id } = setup(mode, opts);
  if (afterMs > 0) h.step(afterMs / 1000);
  const s = h.snap();
  return aimPoint(s, s.targets.find((t) => t.id === id));
}

test('a shot is resolved at its press time inside the frame, not at the frame time', () => {
  const atPress = positionAfter(10);
  const atFrameEnd = positionAfter(50);
  assert.ok(Math.hypot(atPress.x - atFrameEnd.x, atPress.y - atFrameEnd.y) > 120, 'the two instants are far apart on screen');

  // aim where the target is at the press time (10 ms into a 50 ms frame): hit
  let { h, id } = setup();
  let ev = h.step(0.05, (now) => [shotAt(atPress.x, atPress.y, now + 10)]);
  assert.deepEqual(ev.find((e) => e.type === 'shot').hitIds, [id]);
  const hit = ev.find((e) => e.type === 'hit');
  assert.ok(Math.hypot(hit.x - atPress.x, hit.y - atPress.y) < 0.5, 'the hit is reported where the target was at the press');
  assert.equal(hit.centre, true);

  // aim where the target is at the END of the frame, press time 10 ms: miss (never tested against newer positions)
  ({ h, id } = setup());
  ev = h.step(0.05, (now) => [shotAt(atFrameEnd.x, atFrameEnd.y, now + 10)]);
  assert.deepEqual(ev.find((e) => e.type === 'shot').hitIds, []);

  // the same aim with a press time at the end of the frame: hit
  ({ h, id } = setup());
  ev = h.step(0.05, (now) => [shotAt(atFrameEnd.x, atFrameEnd.y, now + 50)]);
  assert.deepEqual(ev.find((e) => e.type === 'shot').hitIds, [id]);
});

test('two shots in one frame are resolved in press order, each at its own instant', () => {
  const p10 = positionAfter(10);
  const p40 = positionAfter(40);
  const { h, id } = setup();
  // given out of order: the 40 ms shot must not be resolved before the 10 ms one
  const ev = h.step(0.05, (now) => [shotAt(p40.x, p40.y, now + 40), shotAt(p10.x, p10.y, now + 10)]);
  const shots = ev.filter((e) => e.type === 'shot');
  assert.equal(shots.length, 2);
  assert.deepEqual(shots[0].hitIds, [id], 'the earlier press breaks it');
  assert.deepEqual(shots[1].hitIds, [], 'the later one finds nothing left');
  assert.ok(Math.abs(shots[0].x - p10.x) < 1e-9);
});

test('a late shot (press time older than the simulation) is rewound to its press time', () => {
  const { h, id } = setup();
  const s = h.snap();
  const before = aimPoint(s, s.targets.find((t) => t.id === id));
  const pressedAt = h.now;
  h.step(0.04); // the report arrives 40 ms late: the world already moved on
  const cur = aimPoint(h.snap(), h.target(id));
  assert.ok(Math.hypot(cur.x - before.x, cur.y - before.y) > 100);
  const ev = h.step(1 / 60, () => [shotAt(before.x, before.y, pressedAt)]);
  assert.deepEqual(ev.find((e) => e.type === 'shot').hitIds, [id]);
  // and the same late shot aimed at the newer position misses
  const t2 = setup();
  const pressed2 = t2.h.now;
  t2.h.step(0.04);
  const cur2 = aimPoint(t2.h.snap(), t2.h.target(t2.id));
  const ev2 = t2.h.step(1 / 60, () => [shotAt(cur2.x, cur2.y, pressed2)]);
  assert.deepEqual(ev2.find((e) => e.type === 'shot').hitIds, []);
});

test('a target launched after the press time cannot be hit by that shot', () => {
  const h = createHarness('zen', 4);
  h.game.debugSetAutoLaunch(false);
  h.step(0.05);
  const pressed = h.now;
  h.step(0.02);
  const [id] = h.game.debugSpawn({ still: true, pos: { x: 0, y: 4, z: 20 } });
  const p = aimPoint(h.snap(), h.target(id));
  const ev = h.step(1 / 60, () => [shotAt(p.x, p.y, pressed)]);
  assert.deepEqual(ev.find((e) => e.type === 'shot').hitIds, []);
  const ev2 = h.step(1 / 60, (now) => [shotAt(p.x, p.y, now)]);
  assert.deepEqual(ev2.find((e) => e.type === 'shot').hitIds, [id]);
});

test('shot fields: the aim is clamped to the field, source and compMs are echoed; invalid shots are dropped', () => {
  const h = createHarness('zen', 4, {}, { validate: true });
  h.step(0.05);
  const ev = h.step(1 / 60, (now) => [
    { t: now, x: -50, y: 5000, source: 'joycon', compMs: 40 },
    { t: NaN, x: 1, y: 1, source: 'mouse', compMs: 0 },
    null,
  ]);
  const shots = ev.filter((e) => e.type === 'shot');
  assert.equal(shots.length, 1);
  assert.equal(shots[0].x, 0);
  assert.equal(shots[0].y, 1080);
  assert.equal(shots[0].source, 'joycon');
  assert.equal(shots[0].compMs, 40);
  assert.equal(shots[0].shell, -1, 'Zen: unlimited shells');
});

test('Hard: pellet travel time z / pelletSpeed (750 m/s); aiming at the press-time position misses, leading hits later', () => {
  const opts = { difficulty: 'hard' };
  const setupHard = () => {
    const h = createHarness('classic', 3, opts, { validate: true });
    h.until((s) => s.phase === 'ready' && s.shells.loaded === 2, 2);
    const [id] = h.game.debugSpawn({ pos: { x: -4, y: 6, z: 30 }, vel: { x: 40, y: 0, z: 0 } });
    h.step(1 / 60);
    return { h, id };
  };
  // no lead: aim exactly at the target at the press time
  let { h, id } = setupHard();
  let s = h.snap();
  let p = aimPoint(s, s.targets.find((t) => t.id === id));
  let ev = h.step(1 / 60, (now) => [shotAt(p.x, p.y, now)]);
  const shot = ev.find((e) => e.type === 'shot');
  assert.deepEqual(shot.hitIds, [], 'Hard: the shot event comes at the press, hits come later');
  h.run(0.3);
  assert.equal(h.ofType('hit').length, 0, 'no lead, no hit');

  // lead by the travel time: hit, resolved about 30/750 s = 40 ms after the press
  ({ h, id } = setupHard());
  s = h.snap();
  const tgt = s.targets.find((t) => t.id === id);
  p = aimPoint(s, tgt, tgt.z / CONFIG.shot.pelletSpeed);
  const pressed = h.now;
  ev = h.step(1 / 60, () => [shotAt(p.x, p.y, pressed)]);
  assert.equal(ev.filter((e) => e.type === 'hit').length, 0, 'not yet: the pellets are travelling');
  h.run(0.2);
  const hit = h.ofType('hit');
  assert.equal(hit.length, 1);
  assert.equal(hit[0].id, id);
  const lag = hit[0].t - h.ofType('shot')[0].t;
  assert.ok(lag > 0.03 && lag < 0.07, `resolved ${lag} s after the press`);

  // Normal: the same no-lead aim breaks it at once
  const n = createHarness('classic', 3, { difficulty: 'normal' });
  n.until((q) => q.phase === 'ready' && q.shells.loaded === 2, 2);
  const [nid] = n.game.debugSpawn({ pos: { x: -4, y: 6, z: 30 }, vel: { x: 40, y: 0, z: 0 } });
  n.step(1 / 60);
  const ns = n.snap();
  const np = aimPoint(ns, ns.targets.find((t) => t.id === nid));
  const nev = n.step(1 / 60, (now) => [shotAt(np.x, np.y, now)]);
  assert.deepEqual(nev.find((e) => e.type === 'shot').hitIds, [nid]);
});
