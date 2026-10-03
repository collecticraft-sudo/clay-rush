import test from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG } from '../../public/js/game/index.js';
import { stepBody, lostReason, windAt, simulateFlight, inView } from '../../public/js/game/physics.js';
import { makeBody, finishBody, drawParams, streamRng } from '../../public/js/game/launch.js';
import { WORLD, project } from '../../public/js/shared/world.js';

const DT = CONFIG.time.dt;
const CALM = { base: 0, gustAmp: 0, gustPeriodS: 3, phase: 0 };
const params = (over = {}) => ({ kind: 'standard', house: 'trap', speed: 25, azimuthDeg: 0, elevationDeg: 0, jx: 0, jz: 0, spin: 1, hopSeed: 7, ...over });

test('drag: a clay at 25 m/s slows to about 18 m/s in 1.5 s (design 3)', () => {
  const b = makeBody(params(), { pos: { x: 0, y: 50, z: 10 }, vel: { x: 0, y: 0, z: 25 } });
  for (let i = 0; i < 180; i++) stepBody(b, DT, 0);
  const horizontal = Math.hypot(b.vx, b.vz);
  assert.ok(horizontal > 16.5 && horizontal < 18.5, `horizontal speed ${horizontal}`);
  assert.ok(b.vy < -10, 'gravity');
  assert.ok(Math.abs(b.ageS - 1.5) < 1e-9);
});

test('wind pushes sideways (design formula: a += wind), gusts oscillate around the base speed', () => {
  const a = makeBody(params(), { pos: { x: 0, y: 30, z: 20 }, vel: { x: 0, y: 0, z: 20 } });
  const b = makeBody(params(), { pos: { x: 0, y: 30, z: 20 }, vel: { x: 0, y: 0, z: 20 } });
  for (let i = 0; i < 120; i++) {
    stepBody(a, DT, 0);
    stepBody(b, DT, 2.5);
  }
  assert.ok(b.x - a.x > 1, `drift ${b.x - a.x} m in 1 s`);
  const w = { base: 2.5, gustAmp: 1, gustPeriodS: 3, phase: 0 };
  const xs = [];
  for (let t = 0; t < 3; t += 0.1) xs.push(windAt(w, t).x);
  assert.ok(Math.max(...xs) > 3.4 && Math.min(...xs) < 1.6);
  assert.equal(windAt(CALM, 5).x, 0);
});

test('rabbits roll on the ground at y = radius with hops of 0.2 to 0.6 m and are never lost to the ground', () => {
  const b = makeBody(params({ kind: 'rabbit', house: 'rabbitL', speed: 14, azimuthDeg: 90 }));
  assert.equal(b.y, 0.30);
  let maxY = 0;
  let hops = 0;
  let wasGround = true;
  for (let i = 0; i < 240; i++) {
    stepBody(b, DT, 3);
    maxY = Math.max(maxY, b.y);
    if (wasGround && !b.rabbit.onGround) hops += 1;
    wasGround = b.rabbit.onGround;
    assert.ok(b.y >= 0.30 - 1e-9);
    assert.notEqual(lostReason(b), 'ground');
  }
  assert.ok(hops >= 2, `hops ${hops}`);
  assert.ok(maxY > 0.30 + 0.15 && maxY <= 0.30 + 0.6 + 0.01, `max height ${maxY}`);
  assert.ok(b.vx > 9 && b.vx < 14, 'rolling resistance, no wind');
});

test('battue: drag doubles after 60 percent of the nominal flight time (the dip)', () => {
  const p = params({ kind: 'battue', house: 'skeetL', speed: 26, azimuthDeg: 100, elevationDeg: 12 });
  const plain = makeBody(p);
  const nominal = simulateFlight(plain, 0, CALM).flightS;
  const b = finishBody(makeBody(p), 0, CALM);
  assert.ok(Math.abs(b.dipAtS - 0.6 * nominal) < 1e-9);
  const steps = Math.round((b.dipAtS + 0.3) / DT);
  for (let i = 0; i < steps; i++) {
    stepBody(plain, DT, 0);
    stepBody(b, DT, 0);
  }
  const hv = (x) => Math.hypot(x.vx, x.vz);
  assert.ok(hv(b) < hv(plain) - 0.5, 'loses its horizontal speed after the dip');
  assert.ok(b.vy / hv(b) < plain.vy / hv(plain), 'the path turns down more steeply');
});

test('lost reasons: ground, far, offscreen (only after being seen), passed the player, timeout', () => {
  const ground = makeBody(params(), { pos: { x: 0, y: -0.01, z: 20 }, vel: { x: 0, y: 0, z: 0 } });
  assert.equal(lostReason(ground), 'ground');
  const far = makeBody(params(), { pos: { x: 0, y: 5, z: WORLD.zFar + 1 } });
  assert.equal(lostReason(far), 'far');
  const near = makeBody(params(), { pos: { x: 0, y: 2, z: WORLD.zNear - 0.5 } });
  assert.equal(lostReason(near), 'offscreen');
  const unseen = makeBody(params(), { pos: { x: -40, y: 3, z: 20 } });
  assert.equal(lostReason(unseen), null, 'coming in from the side: not lost yet');
  const seen = makeBody(params(), { pos: { x: 0, y: 3, z: 20 } });
  assert.equal(lostReason(seen), null);
  assert.equal(seen.seen, true);
  seen.x = 40;
  assert.equal(lostReason(seen), 'offscreen');
  const old = makeBody(params(), { pos: { x: 0, y: 3, z: 20 } });
  old.ageS = CONFIG.physics.maxLifeS + 0.01;
  assert.equal(lostReason(old), 'timeout');
  assert.equal(inView(makeBody(params(), { pos: { x: 0, y: 3, z: 20 } })), true);
});

test('launch draws are seeded: same stream, same parameters; the draw order never depends on the kind', () => {
  const a = drawParams(streamRng(1, 2, 3), { kind: 'standard', house: 'trap' });
  const b = drawParams(streamRng(1, 2, 3), { kind: 'standard', house: 'trap' });
  assert.deepEqual(a, b);
  const r1 = streamRng(9, 9, 9);
  const r2 = streamRng(9, 9, 9);
  drawParams(r1, { kind: 'rabbit', house: 'rabbitL' });
  drawParams(r2, { kind: 'battue', house: 'skeetL' });
  assert.equal(r1.next(), r2.next());
  const h = CONFIG.houses.trap;
  for (let i = 0; i < 50; i++) {
    const p = drawParams(streamRng(i, 1, 1), { kind: 'mini', house: 'trap' }, { speedMul: 1 });
    assert.ok(p.azimuthDeg >= h.azimuthDeg[0] && p.azimuthDeg <= h.azimuthDeg[1]);
    assert.ok(p.speed >= h.speed[0] * 1.25 - 1e-9 && p.speed <= h.speed[1] * 1.25 + 1e-9, 'mini x1.25');
  }
});

test('WORLD SCALE about the camera: screen paths identical to Normal within 1 px for k 0.55 and 1.45, sizes x 1/k', () => {
  const wind = { base: 2.5, gustAmp: 1, gustPeriodS: 3, phase: 0.5 };
  for (const [kind, house] of [['standard', 'trap'], ['standard', 'skeetL'], ['standard', 'skeetR'], ['standard', 'tower'], ['battue', 'skeetL'], ['mini', 'trap']]) {
    for (let seed = 1; seed <= 5; seed++) {
      const p = drawParams(streamRng(seed, 4, 5), { kind, house });
      for (const k of [0.55, 1.45]) {
        const a = finishBody(makeBody({ ...p, k: 1 }), 0, wind);
        const b = finishBody(makeBody({ ...p, k }), 0, wind);
        assert.ok(Math.abs(b.dipAtS - a.dipAtS) < 1e-6 || a.dipAtS === Infinity, 'battue dip at the same time');
        let lostA = null;
        let lostB = null;
        for (let i = 1; i <= 720 && !(lostA && lostB); i++) {
          const w = windAt(wind, i * DT).x;
          stepBody(a, DT, w);
          stepBody(b, DT, w);
          lostA = lostA ?? lostReason(a);
          lostB = lostB ?? lostReason(b);
          if (lostA || lostB) {
            if (lostA !== lostB) assert.ok(lostB === 'offscreen' && b.z < WORLD.zNear + 0.5, `${house} k ${k}: lost ${lostA} vs ${lostB}`);
            break;
          }
          const pa = project(a.x, a.y, a.z);
          const pb = project(b.x, b.y, b.z);
          assert.ok(Math.abs(pa.sx - pb.sx) < 1 && Math.abs(pa.sy - pb.sy) < 1, `${house} k ${k} t ${(i * DT).toFixed(2)}: (${pa.sx}, ${pa.sy}) vs (${pb.sx}, ${pb.sy})`);
          const rA = (0.3 * WORLD.F) / a.z;
          const rB = (0.3 * WORLD.F) / b.z;
          assert.ok(Math.abs(rB / rA - 1 / k) < 1e-9, 'the clay looks 1/k times bigger');
        }
      }
    }
  }
});

test('WORLD SCALE: rabbits roll on the scaled ground plane (y = camY (1 - k) + radius) and never fall through it', () => {
  for (const k of [0.55, 1, 1.45]) {
    const b = makeBody({ ...drawParams(streamRng(7, 4, 5), { kind: 'rabbit', house: 'rabbitL' }), k });
    const ground = WORLD.camY * (1 - k);
    assert.ok(Math.abs(b.y - (ground + 0.3)) < 1e-9);
    for (let i = 0; i < 360; i++) {
      stepBody(b, DT, 0);
      assert.ok(b.y >= ground + 0.3 - 1e-9);
      assert.notEqual(lostReason(b), 'ground');
    }
  }
});
