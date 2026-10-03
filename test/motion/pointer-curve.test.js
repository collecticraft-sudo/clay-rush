// The relative pointer: tip velocity, dead zone, acceleration curve, directions (docs/motion-contract.md 2.1, 2.2, metric A10).
// Constant tip speeds are fed through pushImu on the six mount presets and both sides (test-support/motion/tip-stream.js writes the gyro
// of an exact tip velocity), and the cursor velocity and excursion are compared with the value table of the contract.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMotionPipeline, MOTION_CONFIG } from '../../public/js/motion/index.js';
import { tipVelocity, pointerSpeedPxS, pointerGainPxPerDeg, verticalGainPxPerDeg } from '../../public/js/motion/pointer.js';
import { MOUNT_NAMES, MOUNTS } from '../../test-support/motion/synth.js';
import { createTipStream, mountCalibration } from '../../test-support/motion/tip-stream.js';
import { feed, record } from '../../test-support/motion/harness.js';

const CFG = MOTION_CONFIG.pointer;

// the value table of contract 2.2, sensitivity 1.0: tip speed (deg/s) -> F (px/s)
const TABLE = [[5, 0], [6, 5], [8, 15], [10, 25], [20, 76], [30, 129], [50, 250], [75, 437], [100, 678], [150, 1345], [200, 2236], [300, 4128], [450, 6230], [600, 8330], [800, 11130], [1000, 13930]];

function setup({ mount = 'faceUp', side = 'R', settings = {}, hz = 33 } = {}) {
  const pipe = createMotionPipeline({ pointerModel: 'relative', settings: { autoCenter: false, ...settings } });
  const rec = record(pipe);
  pipe.setCalibration(mountCalibration(mount, side));
  return { pipe, rec, stream: createTipStream({ mount, side, hz }) };
}

/** Feed `n` samples of a constant tip velocity and return the last blade sample and the cursor displacement from the centre. */
function drive(r, n, vR, vU = 0, roll = 0) {
  feed(r.pipe, r.stream.hold(n, vR, vU, roll));
  const b = r.rec.blades.at(-1);
  return { b, dx: b.x - 960, dy: b.y - 540 };
}

test('the pure curve reproduces the value table of the contract (within 1 px/s) and is continuous, monotonic and zero in the dead zone', () => {
  for (const [s, F] of TABLE) {
    const got = pointerSpeedPxS(s, 1, CFG);
    assert.ok(Math.abs(got - F) <= 1, `F(${s}) = ${got.toFixed(2)}, table ${F}`);
  }
  // sensitivity scales the speed and nothing else: 100 deg/s gives 407 and 1017 px/s at 0.6 and 1.5 (contract 2.2)
  assert.ok(Math.abs(pointerSpeedPxS(100, 0.6, CFG) - 407) <= 1);
  assert.ok(Math.abs(pointerSpeedPxS(100, 1.5, CFG) - 1017) <= 1);
  assert.equal(pointerSpeedPxS(5, 2.0, CFG), 0, 'the dead zone does not scale with the sensitivity');
  assert.equal(pointerSpeedPxS(4.99, 1, CFG), 0);
  assert.equal(pointerSpeedPxS(0, 1, CFG), 0);
  assert.equal(pointerSpeedPxS(-3, 1, CFG), 0);
  let prev = 0;
  for (let s = 0; s <= 1200; s += 0.25) {
    const F = pointerSpeedPxS(s, 1, CFG);
    assert.ok(F >= prev - 1e-9, `monotonic at ${s}`);
    assert.ok(F - prev < 8, `no step at ${s}: ${F - prev} px/s for a quarter of a deg/s (the steepest part of the ramp is about 24 px/s per deg/s)`);
    prev = F;
  }
  // effective px per degree: 0 in the dead zone, 0.8 at 6, 13.8 at 300, 13.9 beyond (the contract table)
  assert.equal(pointerGainPxPerDeg(5, 1, CFG), 0);
  assert.ok(Math.abs(pointerGainPxPerDeg(6, 1, CFG) - 0.83) < 0.02);
  assert.ok(Math.abs(pointerGainPxPerDeg(10, 1, CFG) - 2.5) < 0.05);
  assert.ok(Math.abs(pointerGainPxPerDeg(100, 1, CFG) - 6.8) < 0.05);
  assert.ok(Math.abs(pointerGainPxPerDeg(300, 1, CFG) - 13.8) < 0.05);
  assert.ok(Math.abs(pointerGainPxPerDeg(1000, 1, CFG) - 13.93) < 0.05);
  // the gain never goes above gHi x sensitivity and never below zero
  for (let s = 0; s < 3000; s += 7) assert.ok(pointerGainPxPerDeg(s, 1, CFG) <= CFG.gHiPxDeg + 1e-9);
});

test('A10 through pushImu: the cursor speed matches the table for every tip speed, every mount, both sides and three sensitivities', () => {
  const speeds = [5, 6, 10, 30, 100, 300, 1000];
  for (const mount of MOUNT_NAMES) {
    for (const side of ['L', 'R']) {
      for (const sens of [1.0, 0.6, 1.5]) {
        for (const s of speeds) {
          const r = setup({ mount, side, settings: { sensitivity: sens } });
          const { b } = drive(r, 3, s);
          const want = pointerSpeedPxS(s, sens, CFG);
          const got = Math.hypot(b.vx, b.vy);
          assert.ok(Math.abs(got - want) <= 1, `${mount}/${side} sens ${sens} at ${s} deg/s: ${got.toFixed(2)} px/s, wanted ${want.toFixed(2)}`);
          // the tilted preset's axes are unit vectors to 6 digits only
          assert.ok(Math.abs(b.speedDps - s) < 1e-5 * s, `${mount}: tip speed ${b.speedDps}`);
          assert.ok(Math.abs(b.speed - s * (10 / 3)) < 1e-4 * s, 'speed is the px/s-equivalent of the tip speed');
          assert.ok(Math.abs(b.angularSpeedDps - s) < 1e-5 * s, 'a pure tip rotation: |w| equals the tip speed');
          if (want > 0) assert.ok(b.vx > 0 && Math.abs(b.vy) < 1e-6, `${mount}/${side}: yaw to the right moves x right and nothing else`);
        }
      }
    }
  }
  // the literal table rows at sensitivity 1.0 on the default mount
  for (const [s, F] of TABLE.filter(([v]) => [5, 6, 10, 30, 100, 300, 1000].includes(v))) {
    const { b } = drive(setup(), 3, s);
    assert.ok(Math.abs(Math.hypot(b.vx, b.vy) - F) <= 1, `table row ${s}`);
  }
});

test('A10 directions on all mounts and both sides: yaw right moves x right, pitch up moves y up, roll about the blade moves nothing', () => {
  for (const mount of MOUNT_NAMES) {
    for (const side of ['L', 'R']) {
      const right = drive(setup({ mount, side }), 5, 200, 0);
      assert.ok(right.dx > 150 && Math.abs(right.dy) < 1e-3, `${mount}/${side}: right ${right.dx.toFixed(1)}, ${right.dy.toFixed(1)}`);
      const left = drive(setup({ mount, side }), 5, -200, 0);
      assert.ok(left.dx < -150 && Math.abs(left.dy) < 1e-3, `${mount}/${side}: left`);
      assert.ok(Math.abs(left.dx + right.dx) < 1e-6, 'symmetric');
      const up = drive(setup({ mount, side }), 5, 0, 200);
      // the vertical gain is the curve capped at verticalMaxPxDeg (round F1): 200 deg/s for four steps of 30.3 ms
      const wantUp = (verticalGainPxPerDeg(200, 1, CFG) * 200 * 4) / 33;
      assert.ok(up.dy < -100 && Math.abs(up.dy + wantUp) < 1 && Math.abs(up.dx) < 1e-3, `${mount}/${side}: up ${up.dx.toFixed(1)}, ${up.dy.toFixed(1)} (screen y is down, wanted ${-wantUp.toFixed(1)})`);
      const down = drive(setup({ mount, side }), 5, 0, -200);
      assert.ok(down.dy > 100 && Math.abs(down.dy - wantUp) < 1 && Math.abs(down.dx) < 1e-3, `${mount}/${side}: down`);
      assert.ok(Math.abs(up.dy + down.dy) < 1e-6, 'symmetric');
      const roll = drive(setup({ mount, side }), 66, 0, 0, 300); // two seconds of a fast roll about the blade axis
      assert.ok(Math.abs(roll.dx) <= 2 && Math.abs(roll.dy) <= 2, `${mount}/${side}: roll moved the cursor by ${roll.dx}, ${roll.dy}`);
      assert.equal(roll.b.cutting, false, 'a roll never cuts: |w| is 300 but the tip does not move');
      assert.ok(roll.b.speedDps < 1e-3, 'the tip speed of a pure roll is 0');
      assert.ok(Math.abs(roll.b.angularSpeedDps - 300) < 1e-3, '|w| is still reported for diagnostics');
    }
  }
});

test('A10 excursion: the integral of the curve, sensitivity 2.0 doubles it at the same speed, flipX mirrors x only', () => {
  const dt = 1000 / 33;
  for (const s of [30, 100, 150]) {
    const n = 9; // the first sample only starts the stream: eight integrated steps
    const one = drive(setup(), n, s);
    const want = pointerSpeedPxS(s, 1, CFG) * ((n - 1) * dt) / 1000;
    assert.ok(Math.abs(one.dx - want) <= 1, `${s} deg/s: ${one.dx.toFixed(2)} px, wanted ${want.toFixed(2)}`);
    const two = drive(setup({ settings: { sensitivity: 2.0 } }), n, s);
    assert.ok(Math.abs(two.dx - 2 * one.dx) <= 1, `sensitivity 2.0 doubles the excursion: ${two.dx.toFixed(1)} vs ${one.dx.toFixed(1)}`);
    const half = drive(setup({ settings: { sensitivity: 0.5 } }), n, s);
    assert.ok(Math.abs(half.dx - 0.5 * one.dx) <= 1);
    const flip = drive(setup({ settings: { flipX: true } }), n, s);
    assert.ok(Math.abs(flip.dx + one.dx) <= 1e-6 && flip.dy === one.dy, 'flipX mirrors x only');
    const flipUp = drive(setup({ settings: { flipX: true } }), n, 0, s);
    const noFlipUp = drive(setup(), n, 0, s);
    assert.ok(Math.abs(flipUp.dy - noFlipUp.dy) < 1e-9 && Math.abs(flipUp.dx) < 1e-9, 'flipX does not touch y');
  }
});

test('A10 dead zone: a constant 4.9 deg/s gives 0 px after 10 s, 5.5 deg/s gives 25 px (F = 2.5 px/s), at any sensitivity the dead zone stays 5 deg/s', () => {
  const at = (s, sens = 1) => {
    const r = setup({ settings: { sensitivity: sens } });
    return drive(r, Math.round(10 * 33) + 1, s); // 330 integrated steps of 30.3 ms = 10 s
  };
  assert.equal(at(4.9).dx, 0);
  assert.equal(at(4.9, 2.0).dx, 0, 'the dead zone does not shrink with the sensitivity');
  assert.equal(at(-4.9, 2.0).dx, 0);
  const a = at(5.5);
  assert.ok(Math.abs(a.dx - 25) <= 2, `5.5 deg/s for 10 s: ${a.dx.toFixed(2)} px (expected 25 +- 2)`);
  assert.ok(Math.abs(at(5.5, 2.0).dx - 50) <= 4);
  // tremor-sized input (a sine of 3 deg/s amplitude in both axes, bias-free) moves nothing
  const r = setup();
  const samples = [];
  for (let i = 0; i < 400; i += 1) samples.push(...r.stream.each([{ vR: 3 * Math.sin(i * 0.9), vU: 3 * Math.cos(i * 0.7) }]));
  feed(r.pipe, samples);
  assert.ok(Math.hypot(r.rec.blades.at(-1).x - 960, r.rec.blades.at(-1).y - 540) < 1e-9, 'tremor below the dead zone moves the cursor by exactly 0 px');
});

test('acceleration: the same 45 degrees of rotation moves the cursor further when it is done fast (low gain for slow aiming, high gain for a swing)', () => {
  const fortyFive = (s) => {
    const r = setup();
    const dt = 1000 / 33;
    const n = Math.round(45 / s / (dt / 1000)) + 1;
    return drive(r, n, s).dx;
  };
  const slow = fortyFive(30);
  const mid = fortyFive(100);
  const fast = fortyFive(400);
  assert.ok(slow < mid && mid < fast, `${slow.toFixed(0)} < ${mid.toFixed(0)} < ${fast.toFixed(0)}`);
  assert.ok(slow > 150 && slow < 300, `45 degrees at 30 deg/s = ${slow.toFixed(0)} px (about 4.3 px/deg)`);
  assert.ok(fast > 3 * slow, `a swing covers the screen, slow aiming does not (${fast.toFixed(0)} against ${slow.toFixed(0)})`);
  // the shipped mapping was 27.4 px/deg at every speed: 45 degrees = 1233 px, however slowly. Nothing of the sort remains.
  assert.ok(slow < 0.25 * 1233);
});

test('tipVelocity: the roll component about the forward axis is removed, the signs follow the contract, a zero vector gives zero', () => {
  const frame = MOUNTS.faceUp;
  const out = { s: 0, vR: 0, vU: 0 };
  tipVelocity({ x: 0, y: 0, z: -40 }, frame, false, out); // w . up < 0: turning the blade to the right
  assert.deepEqual([out.vR, out.vU, out.s], [40, 0, 40]);
  tipVelocity({ x: 25, y: 0, z: 0 }, frame, false, out); // w . right > 0: tipping the blade up
  assert.deepEqual([out.vR, out.vU, out.s], [0, 25, 25]);
  tipVelocity({ x: 0, y: 500, z: 0 }, frame, false, out); // about the blade axis
  assert.deepEqual([out.vR, out.vU, out.s], [0, 0, 0]);
  tipVelocity({ x: 30, y: 500, z: -40 }, frame, true, out);
  assert.deepEqual([out.vR, out.vU, out.s], [-40, 30, 50]);
  tipVelocity({ x: 0, y: 0, z: 0 }, frame, false, out);
  assert.equal(out.s, 0);
  // a tilted mount: the blade axis is not a device axis
  const t = MOUNTS.tilted;
  const along = { x: t.forward.x * 700, y: t.forward.y * 700, z: t.forward.z * 700 };
  tipVelocity(along, t, false, out);
  assert.ok(out.s < 1e-9, 'rotation about the tilted blade axis does not move the tip');
});

test('the pipeline reads the speed from the calibration: bias, sign and scale act before the curve', () => {
  const pipe = createMotionPipeline({ pointerModel: 'relative', settings: { autoCenter: false } });
  const rec = record(pipe);
  const stream = createTipStream({});
  // sign -1, scale 2, bias 3 deg/s on the up axis: the rate the pipeline sees is (raw - bias) x sign x scale
  pipe.setCalibration(mountCalibration('faceUp', 'R', { gyroSign: -1, gyroScale: 2, gyroBiasDps: { x: 0, y: 0, z: 3 } }));
  // the stream puts -vR on the raw up axis: vR = -3 is a raw 3, exactly the bias: no rotation at all
  feed(pipe, stream.each([{ vR: -3 }, { vR: -3 }]));
  assert.equal(rec.blades.at(-1).speedDps, 0, 'the bias is removed first');
  // raw -13 gives (-13 - 3) x -1 x 2 = +32 deg/s about the up axis: the blade turns LEFT at 32 deg/s
  feed(pipe, stream.each([{ vR: 13 }]));
  const b = rec.blades.at(-1);
  assert.ok(Math.abs(b.speedDps - 32) < 1e-9 && b.vx < 0, `tip speed ${b.speedDps}, vx ${b.vx}`);
  // the scale and the sign do not change the direction convention of the model: with sign +1 the same raw value turns the blade right
  const p2 = createMotionPipeline({ pointerModel: 'relative', settings: { autoCenter: false } });
  const r2 = record(p2);
  p2.setCalibration(mountCalibration('faceUp', 'R', { gyroSign: 1, gyroScale: 1, gyroBiasDps: { x: 0, y: 0, z: 3 } }));
  feed(p2, createTipStream({}).each([{ vR: -3 }, { vR: 13 }]));
  assert.ok(r2.blades.at(-1).vx > 0 && Math.abs(r2.blades.at(-1).speedDps - 16) < 1e-9, `${r2.blades.at(-1).speedDps}`);
});
