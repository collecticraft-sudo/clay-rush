// The first real Joy-Con 2 recording as a test fixture (docs/motion-findings.md, docs/motion-contract.md section 5.1). OWNER: motion engineer.
//
// The fixture is a copy of recordings/imu-2026-09-30T18-42-24.jsonl (one Joy-Con 2 Right, handled by the owner through the native
// bridge, nine hand-timed steps, one JSON line per report {t, ht, step, hex}). It is the ground truth of the relative pointer: the tests
// that replay it (test/motion/real-replay.test.js) are the acceptance metrics A1 to A9 of the contract. A port of tools/lib/imu-recording.mjs
// and of the adapters of tools/replay-motion.mjs; the tools stay in the repository as the cross-check.
//
// UNVERIFIED-ON-HARDWARE: one controller, one person, one mount (forward = device +y, up = +z, right = +x), hand-timed steps without a
// reference instrument. Nothing here says anything about the Left unit, about other people's swings or about how the pointer feels.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseInputReport, hexToBytes, imuDeltaUs, GYRO_DPS_PER_LSB, ACCEL_G_PER_LSB } from '../../public/js/input/joycon2-parse.js';
import { createMotionPipeline } from '../../public/js/motion/index.js';
import { record, feed } from './harness.js';

export const RECORDING_FILE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'imu-2026-09-30T18-42-24.jsonl');

/** Median of the clean rest_table window (raw 0, -5, +12 times 0.06103515625): the gyro bias of this unit in deg/s. */
export const REAL_BIAS_DPS = Object.freeze({ x: 0, y: -0.30517578125, z: 0.732421875 });

export const FIELD = Object.freeze({ w: 1920, h: 1080, cx: 960, cy: 540 });

let cache = null;

/**
 * @returns {{steps: Record<string, Array<{us:number, t:number, dtMs:number|null, gyroRaw:object, accelRaw:object, g:object, a:object}>>, order: string[]}}
 *   per step: t = device time in ms from the first sample of the step, dtMs = the device delta (null for the first sample of a step)
 */
export function loadRealRecording() {
  if (cache) return cache;
  const rows = readFileSync(RECORDING_FILE, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const steps = {};
  const order = [];
  let prevUs = null;
  let prevStep = null;
  let t = 0;
  for (const r of rows) {
    if (!r.hex || !r.step) continue;
    const p = parseInputReport(hexToBytes(r.hex));
    if (!p || !p.imuActive) continue;
    if (r.step !== prevStep) {
      steps[r.step] = [];
      order.push(r.step);
      prevStep = r.step;
      prevUs = null;
      t = 0;
    }
    const dtMs = prevUs === null ? null : imuDeltaUs(prevUs, p.imuTimestampUs) / 1000;
    prevUs = p.imuTimestampUs;
    if (dtMs !== null) t += dtMs;
    steps[r.step].push({
      us: p.imuTimestampUs,
      t,
      dtMs,
      gyroRaw: p.gyroRaw,
      accelRaw: p.accelRaw,
      g: { x: p.gyroRaw.x * GYRO_DPS_PER_LSB, y: p.gyroRaw.y * GYRO_DPS_PER_LSB, z: p.gyroRaw.z * GYRO_DPS_PER_LSB },
      a: { x: p.accelRaw.x * ACCEL_G_PER_LSB, y: p.accelRaw.y * ACCEL_G_PER_LSB, z: p.accelRaw.z * ACCEL_G_PER_LSB },
    });
  }
  cache = { steps, order };
  return cache;
}

/** The exact Calibration of this recording: identity frame (right x, forward y, up z), sign +1, scale 1, the clean table bias. */
export function realCalibration(overrides = {}) {
  return {
    version: 1,
    side: 'R',
    createdAt: 0,
    frame: { right: { x: 1, y: 0, z: 0 }, forward: { x: 0, y: 1, z: 0 }, up: { x: 0, y: 0, z: 1 } },
    gyroBiasDps: { ...REAL_BIAS_DPS },
    gyroSign: 1,
    gyroScale: 1,
    gyroScaleSource: 'default',
    accelG0: 1,
    quality: { poseAngleDeg: 90, stillPeakDps: 1, warnings: [] },
    ...overrides,
  };
}

/**
 * ImuSamples of one step between two times (seconds from the start of the step). `seq` 0.., `t` and `arrivedAt` = device time in ms
 * relative to the window start, `dtMs` null for the first sample (the countdowns between the steps are not in the file, so a window is
 * replayed as its own session) and for the one duplicated timestamp, otherwise the device delta.
 */
export function stepSamples(name, fromS = 0, toS = Infinity) {
  const all = loadRealRecording().steps[name];
  if (!all) throw new Error(`unknown step ${name}`);
  const l = all.filter((s) => s.t / 1000 >= fromS && s.t / 1000 < toS);
  if (!l.length) throw new Error(`step ${name} has no sample in ${fromS}..${toS} s`);
  const t0 = l[0].t;
  return l.map((s, i) => ({
    seq: i,
    t: s.t - t0,
    arrivedAt: s.t - t0,
    dtMs: i === 0 || !(s.dtMs > 0) ? null : s.dtMs,
    dtSource: 'device',
    accel: { ...s.a },
    gyro: { ...s.g },
    side: 'R',
    buttons: [],
    batteryMv: 3435,
    tempC: null,
    imuActive: true,
  }));
}

/**
 * The reference ("hard") strokes of a fast-swing step (contract 5.1): local maxima of |gyro - bias| of at least 150 dps, peaks closer
 * than 250 ms merged (the higher wins), with |accel| >= 2.0 g within 3 samples of the peak. The extent walks outwards from the peak while
 * the speed is above 100 dps and stops at a local minimum below half the peak. Times are relative to the step start (ms).
 * @returns {Array<{peakDps:number, tPeakMs:number, t0Ms:number, t1Ms:number, aPeakG:number}>}
 */
export function hardStrokes(name) {
  const l = loadRealRecording().steps[name];
  const v = l.map((s) => Math.hypot(s.g.x - REAL_BIAS_DPS.x, s.g.y - REAL_BIAS_DPS.y, s.g.z - REAL_BIAS_DPS.z));
  const peaks = [];
  for (let i = 1; i < l.length - 1; i += 1) if (v[i] >= 150 && v[i] >= v[i - 1] && v[i] > v[i + 1]) peaks.push(i);
  const merged = [];
  for (const i of peaks) {
    const last = merged.at(-1);
    if (last !== undefined && l[i].t - l[last].t < 250) {
      if (v[i] > v[last]) merged[merged.length - 1] = i;
    } else {
      merged.push(i);
    }
  }
  const out = [];
  for (const pk of merged) {
    let aPeak = 0;
    for (let i = Math.max(0, pk - 3); i <= Math.min(l.length - 1, pk + 3); i += 1) aPeak = Math.max(aPeak, Math.hypot(l[i].a.x, l[i].a.y, l[i].a.z));
    if (aPeak < 2.0) continue;
    let a = pk;
    while (a > 0 && v[a - 1] > 100 && !(v[a - 1] > v[a] && v[a] < 0.5 * v[pk])) a -= 1;
    let b = pk;
    while (b < l.length - 1 && v[b + 1] > 100 && !(v[b + 1] > v[b] && v[b] < 0.5 * v[pk])) b += 1;
    out.push({ peakDps: v[pk], tPeakMs: l[pk].t, t0Ms: l[a].t, t1Ms: l[b].t, aPeakG: aPeak });
  }
  return out;
}

/**
 * Inject a slow posture change on top of (real, still) samples (contract A8, prototype postureTest): add `yawDps` to gyro z and
 * `pitchDps` to gyro x from `fromMs` for `durMs`, and rotate the gravity vector about device x by the accumulated pitch (the relative
 * pointer ignores the accelerometer; the absolute model would not). Returns new samples.
 */
export function injectPostureChange(samples, { fromMs = 500, durMs = 2000, yawDps = 15, pitchDps = 10 } = {}) {
  const n = Math.min(20, samples.length);
  const avg = (k) => samples.slice(0, n).reduce((acc, s) => acc + s.accel[k], 0) / n;
  const ay0 = avg('y');
  const az0 = avg('z');
  let th = 0;
  return samples.map((s, i) => {
    const active = s.t >= fromMs && s.t < fromMs + durMs;
    if (i > 0 && active && s.dtMs) th += pitchDps * (s.dtMs / 1000);
    const c = Math.cos((th * Math.PI) / 180);
    const sn = Math.sin((th * Math.PI) / 180);
    const ay = ay0 * c + az0 * sn;
    const az = -ay0 * sn + az0 * c;
    return {
      ...s,
      gyro: { x: s.gyro.x + (active ? pitchDps : 0), y: s.gyro.y, z: s.gyro.z + (active ? yawDps : 0) },
      accel: { x: s.accel.x, y: s.accel.y + (ay - ay0), z: s.accel.z + (az - az0) },
    };
  });
}

/**
 * Replay a window of a step through a FRESH pipeline (cursor at the centre, the exact calibration of the recording).
 * Returns one row per real sample: {t, x, y, s (tip speed, deg/s), cutting, refDriven, discontinuity, vx, vy, segs (the chords drained
 * after this sample), swingId} plus the recorder and the pipeline.
 * @param {string} name step name
 * @param {{fromS?:number, toS?:number, samples?:object[], settings?:object, pointerModel?:'relative'|'absolute', config?:object,
 *   calibration?:object, before?:(pipe:object)=>void, afterSample?:(pipe:object, sample:object, row:object, index:number)=>void,
 *   autoCenter?:boolean}} [opts]
 */
export function replay(name, opts = {}) {
  const { fromS = 0, toS = Infinity, settings = {}, pointerModel = 'relative', config, calibration = realCalibration(), before, afterSample } = opts;
  const samples = opts.samples ?? stepSamples(name, fromS, toS);
  const pipe = createMotionPipeline({ pointerModel, settings, config });
  const rec = record(pipe, { validate: true });
  pipe.reset();
  rec.resetTime();
  pipe.setCalibration(calibration);
  if (before) before(pipe);
  const rows = [];
  const segments = [];
  let seen = 0;
  samples.forEach((smp, i) => {
    feed(pipe, [smp], { poll: false });
    const segs = rec.drain();
    for (const sg of segs) segments.push(sg);
    const st = pipe.getState();
    // one row per real BladeSample emitted by this push (exactly one unless the sample was ignored)
    while (seen < rec.blades.length) {
      const b = rec.blades[seen];
      seen += 1;
      const row = {
        t: b.t, x: b.x, y: b.y, s: b.speedDps, cutting: b.cutting, discontinuity: b.discontinuity, vx: b.vx, vy: b.vy, swingId: b.swingId,
        segmentValid: b.segmentValid, refDriven: st.refDriven, segs, blade: b,
      };
      rows.push(row);
      if (afterSample) afterSample(pipe, smp, row, i);
    }
  });
  return { pipe, rec, rows, segments, samples };
}

// ---------------------------------------------------------------------------------------------------- small statistics helpers
export const range = (xs) => Math.max(...xs) - Math.min(...xs);
export const median = (xs) => {
  const a = Float64Array.from(xs).sort();
  if (!a.length) return NaN;
  const p = (a.length - 1) / 2;
  return 0.5 * (a[Math.floor(p)] + a[Math.ceil(p)]);
};
export const quantile = (xs, q) => {
  const a = Float64Array.from(xs).sort();
  const p = (a.length - 1) * q;
  const lo = Math.floor(p);
  const hi = Math.ceil(p);
  return a[lo] + (a[hi] - a[lo]) * (p - lo);
};
export const mean = (xs) => xs.reduce((acc, x) => acc + x, 0) / (xs.length || 1);

/** Share of the time (by the device step) for which `pred(row)` holds, rows[1..] weighted by their step. */
export function timeShare(rows, pred) {
  let tot = 0;
  let on = 0;
  for (let i = 1; i < rows.length; i += 1) {
    const dt = rows[i].t - rows[i - 1].t;
    tot += dt;
    if (pred(rows[i])) on += dt;
  }
  return tot > 0 ? (100 * on) / tot : 0;
}

export const onEdge = (r) => r.x <= 0.5 || r.x >= FIELD.w - 0.5 || r.y <= 0.5 || r.y >= FIELD.h - 0.5;
