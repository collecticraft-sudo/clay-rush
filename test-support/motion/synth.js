// Synthetic IMU generator for the Motion tests. OWNER: motion engineer. Does NOT import input/ or motion/.
//
// It models a rigid sword swung about a pivot (the wrist) and the sensor that a Joy-Con mounted on it would report. It is
// a MODEL of docs/joycon2-protocol.md and docs/architecture.md 5.8, not of the physical device (UNVERIFIED-ON-HARDWARE).
//
// Truth model
//   pose(t) = {yaw, pitch, roll} in degrees; sword axes in world coordinates are the columns of
//   R = Rz(-yaw) * Rx(pitch) * Ry(roll)  (world: x right, y forward, z up). Neutral (0,0,0) is the identity: the sword points
//   at the screen, top edge up. forward_W = (sin(yaw) cos(pitch), cos(yaw) cos(pitch), sin(pitch)).
//   Body rates come from central differences of R, linear acceleration from the second difference of the sensor position
//   p = leverM * forward_W (pivot at the origin), so centripetal and tangential terms contaminate gravity exactly.
//   Device readings: accel_D = F * (R^T (a_W / g0 + up)), gyro_D = F * omega_S, with F = [right forward up] (columns, device
//   coordinates) from the mount preset. `mirror` negates the gyro (left-handed gyro convention), bias/noise are added, an
//   alternative gyro scale multiplies the parsed value by 8.138 (protocol D1) and everything is quantised and clipped like the
//   int16 fields of the real report.

import { createRng } from '../../public/js/shared/rng.js';

const G0 = 9.80665;
const DEG = Math.PI / 180;
export const GYRO_DPS_PER_LSB = 2000 / 32768;
export const ACCEL_G_PER_LSB = 1 / 4096;
/** parsed = true * ALT_FACTOR when the real scale is 0.0075 dps/LSB but the parser assumes 0.061 dps/LSB */
export const ALT_FACTOR = GYRO_DPS_PER_LSB / 0.0075;
export const ALT_SCALE = 0.0075 / GYRO_DPS_PER_LSB; // 0.12288
const EMPTY = Object.freeze([]);

/** The six mount presets of docs/architecture.md 5.8: sword axes in DEVICE coordinates. */
export const MOUNTS = Object.freeze({
  faceUp: { right: { x: 1, y: 0, z: 0 }, forward: { x: 0, y: 1, z: 0 }, up: { x: 0, y: 0, z: 1 } },
  faceSide: { right: { x: 0, y: 0, z: -1 }, forward: { x: 0, y: 1, z: 0 }, up: { x: 1, y: 0, z: 0 } },
  upsideDown: { right: { x: -1, y: 0, z: 0 }, forward: { x: 0, y: 1, z: 0 }, up: { x: 0, y: 0, z: -1 } },
  tipFlipped: { right: { x: -1, y: 0, z: 0 }, forward: { x: 0, y: -1, z: 0 }, up: { x: 0, y: 0, z: 1 } },
  tilted: { right: { x: 1, y: 0, z: 0 }, forward: { x: 0, y: 0.866025, z: 0.5 }, up: { x: 0, y: -0.5, z: 0.866025 } },
  sideRail: { right: { x: 0, y: -1, z: 0 }, forward: { x: 1, y: 0, z: 0 }, up: { x: 0, y: 0, z: 1 } },
});
export const MOUNT_NAMES = Object.freeze(Object.keys(MOUNTS));

// ---- 3x3 matrices as arrays of 9, row-major, independent from public/js/motion ----
const mul = (a, b) => {
  const o = new Array(9);
  for (let r = 0; r < 3; r += 1) for (let c = 0; c < 3; c += 1) o[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c];
  return o;
};
const transpose = (a) => [a[0], a[3], a[6], a[1], a[4], a[7], a[2], a[5], a[8]];
const apply = (a, v) => [a[0] * v[0] + a[1] * v[1] + a[2] * v[2], a[3] * v[0] + a[4] * v[1] + a[5] * v[2], a[6] * v[0] + a[7] * v[1] + a[8] * v[2]];
const rx = (a) => [1, 0, 0, 0, Math.cos(a), -Math.sin(a), 0, Math.sin(a), Math.cos(a)];
const ry = (a) => [Math.cos(a), 0, Math.sin(a), 0, 1, 0, -Math.sin(a), 0, Math.cos(a)];
const rz = (a) => [Math.cos(a), -Math.sin(a), 0, Math.sin(a), Math.cos(a), 0, 0, 0, 1];

/** Sword-to-world rotation matrix for a pose in degrees. */
export function poseMatrix({ yaw = 0, pitch = 0, roll = 0 }) {
  return mul(mul(rz(-yaw * DEG), rx(pitch * DEG)), ry(roll * DEG));
}

/** Forward axis of the sword in world coordinates for a pose. */
export function poseForward(pose) {
  const R = poseMatrix(pose);
  return { x: R[1], y: R[4], z: R[7] };
}

// ---- pose builders ----
const smooth = (x) => {
  const c = Math.min(1, Math.max(0, x));
  return c * c * (3 - 2 * c);
};

/**
 * Piecewise pose path. keys: [{t, yaw, pitch, roll?}] sorted by t (ms). Between two keys the pose is interpolated with a
 * smoothstep (zero velocity at both ends) or linearly; before the first / after the last key it holds.
 */
export function keyframes(keys, { ease = 'smooth' } = {}) {
  return (t) => {
    if (t <= keys[0].t) return { yaw: keys[0].yaw, pitch: keys[0].pitch, roll: keys[0].roll ?? 0 };
    const last = keys[keys.length - 1];
    if (t >= last.t) return { yaw: last.yaw, pitch: last.pitch, roll: last.roll ?? 0 };
    let i = 0;
    while (keys[i + 1].t < t) i += 1;
    const a = keys[i];
    const b = keys[i + 1];
    const u = (t - a.t) / (b.t - a.t);
    const s = ease === 'linear' ? u : smooth(u);
    return {
      yaw: a.yaw + (b.yaw - a.yaw) * s,
      pitch: a.pitch + (b.pitch - a.pitch) * s,
      roll: (a.roll ?? 0) + ((b.roll ?? 0) - (a.roll ?? 0)) * s,
    };
  };
}

/** Constant pose. */
export const holdPose = (yaw = 0, pitch = 0, roll = 0) => () => ({ yaw, pitch, roll });

/**
 * The calibration gesture of docs/architecture.md 5.8 (`playCalibrationScript`): still tip up, rotate to pointing at the
 * screen, still, then hold at the centre. All times in ms from t = 0. Returns the pose function and the phase boundaries.
 */
export function calibrationScript({ tipUpMs = 2600, moveMs = 1200, pointMs = 2200, centreMs = 3200, tipYaw = 0, pointYaw = 0, pointPitch = 0 } = {}) {
  const t1 = tipUpMs;
  const t2 = t1 + moveMs;
  const t3 = t2 + pointMs;
  const t4 = t3 + centreMs;
  const pose = keyframes([
    { t: 0, yaw: tipYaw, pitch: 90 },
    { t: t1, yaw: tipYaw, pitch: 90 },
    { t: t2, yaw: pointYaw, pitch: pointPitch },
    { t: t4, yaw: pointYaw, pitch: pointPitch },
  ]);
  return { pose, totalMs: t4, tipUpEndMs: t1, moveEndMs: t2, pointEndMs: t3 };
}

// ---- generator ----

function gaussian(rng) {
  let u = 0;
  while (u === 0) u = rng.next();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng.next());
}

/**
 * @param {{
 *   mount?: keyof typeof MOUNTS | {right:object, forward:object, up:object},
 *   side?: 'L'|'R'|'?', hz?: number, mirror?: boolean, gyroScaleTrue?: 'default'|'alt',
 *   gyroBiasDps?: [number,number,number], gyroNoiseDps?: number, accelNoiseG?: number,
 *   leverM?: number, seed?: number, startMs?: number, tJitterMs?: number, latencyMs?: number,
 *   dropRate?: number, dropWhen?: (k:number)=>boolean, dtFromArrival?: boolean, quantize?: boolean,
 *   accelSign?: 1|-1
 * }} [opts]
 *
 * accelSign -1 models a sensor that reports the gravity vector (pointing DOWN at rest) instead of the specific force
 * (pointing UP): every accelerometer reading is negated. The real sign is unknown (docs/protocol-audit.md F3).
 */
export function createSynth(opts = {}) {
  const mountOpt = opts.mount ?? 'faceUp';
  const frame = typeof mountOpt === 'string' ? MOUNTS[mountOpt] : mountOpt;
  if (!frame) throw new Error(`unknown mount ${String(mountOpt)}`);
  const hz = opts.hz ?? 66;
  const dt = 1000 / hz;
  const side = opts.side ?? 'R';
  const mirror = opts.mirror ?? false;
  const alt = opts.gyroScaleTrue === 'alt';
  const altK = alt ? ALT_FACTOR : 1;
  const biasTrue = opts.gyroBiasDps ?? [0.6, -0.9, 0.4];
  const gyroNoise = opts.gyroNoiseDps ?? 0.15;
  const accelNoise = opts.accelNoiseG ?? 0.004;
  const lever = opts.leverM ?? 0.45;
  const rng = createRng(opts.seed ?? 1);
  const jitter = opts.tJitterMs ?? 0;
  const latency = opts.latencyMs ?? 4;
  const quantize = opts.quantize ?? true;
  const startMs = opts.startMs ?? 1000;
  const accelSgn = opts.accelSign === -1 ? -1 : 1;

  // F: device = right * s.x + forward * s.y + up * s.z  (columns are the sword axes in device coordinates)
  const F = [frame.right.x, frame.forward.x, frame.up.x, frame.right.y, frame.forward.y, frame.up.y, frame.right.z, frame.forward.z, frame.up.z];

  const state = { k: 0, seq: 0, lastDevT: null, lastT: -Infinity };

  function truth(pose, tMs) {
    const R = poseMatrix(pose(tMs));
    // body rates (sword coordinates) from a central difference of R
    const h = 0.25; // ms
    const Ra = poseMatrix(pose(tMs - h));
    const Rb = poseMatrix(pose(tMs + h));
    const dR = mul(transpose(Ra), Rb);
    const inv2h = 1 / (2 * h * 1e-3);
    const omegaS = [(dR[7] - dR[5]) * 0.5 * inv2h, (dR[2] - dR[6]) * 0.5 * inv2h, (dR[3] - dR[1]) * 0.5 * inv2h]; // rad/s
    // sensor position p = lever * forward_W, second difference with a 1 ms step
    const hs = 1e-3;
    const fw = (tt) => {
      const M = poseMatrix(pose(tt));
      return [M[1] * lever, M[4] * lever, M[7] * lever];
    };
    const p0 = fw(tMs - 1);
    const p1 = fw(tMs);
    const p2 = fw(tMs + 1);
    const aW = [(p2[0] - 2 * p1[0] + p0[0]) / (hs * hs) / G0, (p2[1] - 2 * p1[1] + p0[1]) / (hs * hs) / G0, (p2[2] - 2 * p1[2] + p0[2]) / (hs * hs) / G0];
    const fW = [aW[0], aW[1], aW[2] + 1]; // specific force in world coordinates, g
    const fS = apply(transpose(R), fW);
    return { accelD: apply(F, fS), gyroD: apply(F, omegaS).map((r) => r / DEG) }; // gyro in true dps
  }

  const q16 = (v, lsb) => {
    if (!quantize) return v;
    const raw = Math.max(-32768, Math.min(32767, Math.round(v / lsb)));
    return raw * lsb;
  };

  return {
    frame,
    side,
    hz,
    dtMs: dt,
    /** Clock time (ms) that the next sample will carry. */
    get nowMs() {
      return startMs + state.k * dt;
    },
    /** Device time (ms, 0-based) that the next sample will carry: the time base of pose(t) functions. */
    get devMs() {
      return state.k * dt;
    },
    /** Exact Calibration a perfect wizard would produce for this synthetic sensor (bias in parsed units). */
    nominalCalibration() {
      return {
        version: 1,
        side,
        createdAt: 0,
        frame: { right: { ...frame.right }, forward: { ...frame.forward }, up: { ...frame.up } },
        gyroBiasDps: { x: biasTrue[0] * altK, y: biasTrue[1] * altK, z: biasTrue[2] * altK },
        gyroSign: mirror ? -1 : 1,
        gyroScale: alt ? ALT_SCALE : 1,
        gyroScaleSource: 'stored',
        quality: { poseAngleDeg: 90, stillPeakDps: 0, warnings: [] },
      };
    },
    /** True gyro bias in parsed units, device frame. */
    biasParsed: { x: biasTrue[0] * altK, y: biasTrue[1] * altK, z: biasTrue[2] * altK },

    /**
     * Generate samples for device times [current, toMs) and advance. `pose(tMs)` receives ms on the synth's own time base
     * (0 = first sample when startMs is 0; keep scripts in absolute ms and leave startMs alone).
     */
    generate(pose, toMs) {
      const out = [];
      for (;;) {
        const devT = state.k * dt;
        if (devT >= toMs) break;
        state.k += 1;
        if (opts.dropWhen?.(state.k) || (opts.dropRate && rng.next() < opts.dropRate)) continue;
        const { accelD, gyroD } = truth(pose, devT);
        const ax = accelSgn * (accelD[0] + accelNoise * gaussian(rng));
        const ay = accelSgn * (accelD[1] + accelNoise * gaussian(rng));
        const az = accelSgn * (accelD[2] + accelNoise * gaussian(rng));
        const sgn = mirror ? -1 : 1;
        const gx = (sgn * gyroD[0] + biasTrue[0] + gyroNoise * gaussian(rng)) * altK;
        const gy = (sgn * gyroD[1] + biasTrue[1] + gyroNoise * gaussian(rng)) * altK;
        const gz = (sgn * gyroD[2] + biasTrue[2] + gyroNoise * gaussian(rng)) * altK;

        const dev = startMs + devT;
        let t = dev + (jitter ? (rng.next() * 2 - 1) * jitter : 0);
        if (t < state.lastT) t = state.lastT; // ImuSample.t is non-decreasing
        const arrivedAt = t + latency + (jitter ? rng.next() * jitter : 0);
        let dtMs = state.lastDevT === null ? null : dev - state.lastDevT;
        if (opts.dtFromArrival && state.lastDevT !== null) dtMs = Math.max(0.5, t - state.lastT);
        if (dtMs !== null && !(dtMs > 0 && dtMs < 200)) dtMs = null;
        state.lastDevT = dev;
        state.lastT = t;
        out.push({
          seq: state.seq++,
          t,
          arrivedAt,
          dtMs,
          dtSource: opts.dtFromArrival ? 'arrival' : 'synthetic',
          accel: { x: q16(ax, ACCEL_G_PER_LSB), y: q16(ay, ACCEL_G_PER_LSB), z: q16(az, ACCEL_G_PER_LSB) },
          gyro: { x: q16(gx, GYRO_DPS_PER_LSB), y: q16(gy, GYRO_DPS_PER_LSB), z: q16(gz, GYRO_DPS_PER_LSB) },
          side,
          buttons: EMPTY,
          batteryMv: 3700,
          tempC: 25,
          imuActive: true,
        });
      }
      return out;
    },
  };
}
