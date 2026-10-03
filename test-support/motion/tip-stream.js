// Exact tip-speed sample streams for the tests of the relative pointer. OWNER: motion engineer. Does NOT import motion/.
//
// The synthetic sword model of synth.js is a rigid body with noise and lever-arm acceleration: right for the orientation filter and the
// absolute mapping, wrong for testing a curve or a state machine, where the tip speed of every sample must be known EXACTLY. This module
// writes ImuSamples whose gyro is a chosen tip velocity in the local frame of a mount (contract 2.1):
//   gyro_device = right * vU + forward * roll + up * (-vR)        (deg/s; vR = tip towards the right, vU = tip towards up)
// so the contract's tip speed is hypot(vR, vU) and `roll` (about the blade axis) does not move the tip. The accelerometer reads the
// resting specific force (+1 g along the sword's up axis), the bias is zero (use mountCalibration()).
import { MOUNTS } from './synth.js';

/** A valid Calibration for a mount preset: the exact frame, sign +1, scale 1, zero bias. */
export function mountCalibration(mount = 'faceUp', side = 'R', extra = {}) {
  const f = typeof mount === 'string' ? MOUNTS[mount] : mount;
  return {
    version: 1,
    side,
    createdAt: 0,
    frame: { right: { ...f.right }, forward: { ...f.forward }, up: { ...f.up } },
    gyroBiasDps: { x: 0, y: 0, z: 0 },
    gyroSign: 1,
    gyroScale: 1,
    gyroScaleSource: 'default',
    accelG0: 1,
    quality: { poseAngleDeg: 90, stillPeakDps: 0, warnings: [] },
    ...extra,
  };
}

/**
 * @param {{mount?: string|object, side?: 'L'|'R', hz?: number, startMs?: number}} [opts]
 */
export function createTipStream({ mount = 'faceUp', side = 'R', hz = 33, startMs = 0 } = {}) {
  const f = typeof mount === 'string' ? MOUNTS[mount] : mount;
  const dt = 1000 / hz;
  let t = startMs - dt; // the first sample carries startMs
  let seq = 0;
  let first = true;
  let pendingGap = 0;

  const gyroOf = (vR, vU, roll) => ({
    x: f.right.x * vU + f.forward.x * roll - f.up.x * vR,
    y: f.right.y * vU + f.forward.y * roll - f.up.y * vR,
    z: f.right.z * vU + f.forward.z * roll - f.up.z * vR,
  });

  function one(vR, vU = 0, roll = 0) {
    t += dt + pendingGap;
    const sinceLast = dt + pendingGap;
    pendingGap = 0;
    const smp = {
      seq: seq++,
      t,
      arrivedAt: t,
      dtMs: first || !(sinceLast < 200) ? null : sinceLast,
      dtSource: 'device',
      accel: { x: f.up.x, y: f.up.y, z: f.up.z },
      gyro: gyroOf(vR, vU, roll),
      side,
      buttons: [],
      batteryMv: 3700,
      tempC: 25,
      imuActive: true,
    };
    first = false;
    return smp;
  }

  return {
    frame: f,
    side,
    hz,
    dtMs: dt,
    /** Device time of the sample that was produced last. */
    get now() {
      return t;
    },
    /** One sample per entry: a number = tip speed to the right, or {vR, vU, roll}. */
    each(list) {
      return list.map((e) => (typeof e === 'number' ? one(e) : one(e.vR ?? 0, e.vU ?? 0, e.roll ?? 0)));
    },
    /** `n` samples of a constant tip velocity. */
    hold(n, vR, vU = 0, roll = 0) {
      const out = [];
      for (let i = 0; i < n; i += 1) out.push(one(vR, vU, roll));
      return out;
    },
    /** A profile [{ms, vR?, vU?, roll?, s?}] (s = vR shorthand): constant rates for ms, rounded to whole samples (at least one). */
    profile(list) {
      const out = [];
      for (const seg of list) {
        const n = Math.max(1, Math.round(seg.ms / dt));
        for (let i = 0; i < n; i += 1) out.push(one(seg.vR ?? seg.s ?? 0, seg.vU ?? 0, seg.roll ?? 0));
      }
      return out;
    },
    /** Lose `ms` of the stream: the next sample arrives `ms` later (its dtMs is the whole step, null from 200 ms on). */
    skip(ms) {
      pendingGap += ms;
    },
    /** The next sample has dtMs null although its time follows directly (a duplicate report). */
    nullDt() {
      first = true;
    },
  };
}
