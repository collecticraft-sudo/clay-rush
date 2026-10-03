import test from 'node:test';
import assert from 'node:assert/strict';
import { assertValid, VALIDATORS, validateImuSample, validateBladeSample, validateCalibration, validateGameSnapshot, validateGameEvent, validateInputStatus } from '../../public/js/shared/validate.js';

const imu = () => ({ seq: 0, t: 10, arrivedAt: 12, dtMs: 15, dtSource: 'device', accel: { x: 0, y: 0, z: 1 }, gyro: { x: 0, y: 0, z: 0 }, side: 'R', buttons: [], batteryMv: 3700, tempC: 25, imuActive: true });
const blade = () => ({ t: 1, x: 960, y: 540, speed: 0, cutting: false, swingId: 0, segmentValid: false, x0: 960, y0: 540, t0: 1, discontinuity: false, trackingOk: true, angularSpeedDps: null, source: 'aim' });
const cal = () => ({ version: 1, side: 'R', createdAt: 1, frame: { right: { x: 1, y: 0, z: 0 }, forward: { x: 0, y: 1, z: 0 }, up: { x: 0, y: 0, z: 1 } }, gyroBiasDps: { x: 0, y: 0, z: 0 }, gyroSign: 1, gyroScale: 1, gyroScaleSource: 'default', quality: { poseAngleDeg: 90, stillPeakDps: 1, warnings: [] } });
const target = () => ({ id: 1, kind: 'standard', frame: 'tilt', x: 0, y: 3, z: 20, vx: 2, vy: 6, vz: 18, sx: 960, sy: 551, rPx: 12, rot: 0, ageS: 0.4, pullIndex: 0 });
const house = () => ({ id: 'trap', sprite: 'house_trap', x: 0, y: 0.4, z: 14, sx: 960, sy: 812, scale: 118.8, mirrored: false, flashS: 1e9 });
const snap = () => ({
  v: 1, mode: 'classic', difficulty: 'normal', seed: 1, phase: 'flight', t: 0, tWorld: 0, alpha: 0, timeScale: 1,
  stage: { index: 0, id: 'meadow', count: 3, name: 'Morning Meadow' }, pull: { index: 0, count: 10, targetsLeft: 1 }, wind: { x: 0, gust: 0 },
  shells: { loaded: 2, capacity: 2, reloadingS: 0, infinite: false }, score: 0, streak: 0, multiplier: 1, multiplierProgress: 0,
  timeLeft: null, timeTotal: null, targets: [target()], houses: [house()], killCam: null, practice: null,
  stats: { presented: 1, broken: 0, lost: 0, shots: 0, hits: 0, centre: 0, doubles: 0, bestStreak: 0 }, assist: false, endReason: null, events: [],
});

test('valid examples pass', () => {
  assert.deepEqual(validateImuSample(imu()), []);
  assert.deepEqual(validateBladeSample(blade()), []);
  assert.deepEqual(validateCalibration(cal()), []);
  assert.deepEqual(validateGameSnapshot(snap()), []);
  assert.deepEqual(validateGameEvent({ seq: 0, t: 0, type: 'tick', secondsLeft: 3 }), []);
  assert.deepEqual(validateGameEvent({ seq: 1, t: 0.5, type: 'shot', x: 900, y: 400, shell: 0, hitIds: [1], source: 'joycon', compMs: 40 }), []);
});

test('violations are reported with field paths', () => {
  const bad = imu();
  bad.t = 99;
  bad.dtMs = 500;
  delete bad.side;
  const errs = validateImuSample(bad);
  assert.ok(errs.some((e) => e.includes('side')), errs.join('\n'));
  assert.ok(errs.some((e) => e.includes('later than arrivedAt')));
  assert.ok(errs.some((e) => e.includes('dtMs')));
  assert.ok(validateBladeSample({ ...blade(), x: 5000 }).length > 0);
  assert.ok(validateBladeSample({ ...blade(), segmentValid: true }).length > 0, 'segmentValid needs cutting');
  const left = cal();
  left.frame.forward = { x: 0, y: -1, z: 0 };
  assert.ok(validateCalibration(left).some((e) => e.includes('right-handed')));
  const s = snap();
  s.alpha = 2;
  assert.ok(validateGameSnapshot(s).length > 0);
  assert.ok(validateGameEvent({ seq: 0, t: 0, type: 'hit' }).length > 0);
  assert.ok(validateGameSnapshot({ ...snap(), targets: [{ ...target(), kind: 'apple' }] }).length > 0);
  assert.ok(validateInputStatus({}).length > 0);
});

test('assertValid throws with a readable message and returns valid values', () => {
  const v = imu();
  assert.equal(assertValid('ImuSample', v), v);
  assert.throws(() => assertValid('ImuSample', {}), /Contract violation \(ImuSample\)/);
  assert.throws(() => assertValid('Nope', {}), /unknown contract/);
  assert.ok(Object.isFrozen(VALIDATORS));
});
