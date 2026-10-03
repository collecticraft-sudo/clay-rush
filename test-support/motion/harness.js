// Test harness for the Motion pipeline. OWNER: motion engineer.
// Wires a recorder to a pipeline, feeds synthetic streams, runs the calibration gesture and measures results.
import { createMotionPipeline } from '../../public/js/motion/index.js';
import assert from 'node:assert/strict';
import { assertValid } from '../../public/js/shared/validate.js';
import { calibrationScript, createSynth, keyframes } from './synth.js';

const recorders = new WeakMap();

/**
 * A pipeline in the ABSOLUTE pointer model (orientation -> screen, the simulator's model). The absolute mapping, the references, the
 * soft centring and the edge slip are what the tests of mapping, recentring, calibration and the simulator exercise; the default
 * model of createMotionPipeline is 'relative' (docs/motion-contract.md section 1, test/motion/relative-*.test.js).
 */
export function createAbsolutePipeline(opts = {}) {
  return createMotionPipeline({ pointerModel: 'absolute', ...opts });
}

/**
 * Subscribe to every pipeline event and keep everything in arrays. With validate:true each output is contract-checked.
 * The pipeline's Emitter swallows exceptions thrown by listeners (by design), so violations are COLLECTED in rec.violations
 * and re-thrown by feed(), lastBlade(), rec.drain() and rec.check().
 */
export function record(pipe, { validate = true } = {}) {
  const rec = { blades: [], calibration: [], recenter: [], warning: [], segments: [], violations: [] };
  const guard = (fn) => {
    try {
      fn();
    } catch (err) {
      rec.violations.push(err);
    }
  };
  let lastT = -Infinity;
  pipe.on('blade', (b) => {
    if (validate) {
      guard(() => assertValid('BladeSample', b));
      guard(() => assert.ok(b.t >= lastT, `blade time went backwards: ${b.t} after ${lastT}`));
    }
    lastT = b.t;
    rec.blades.push(b);
  });
  pipe.on('calibration', (e) => {
    if (e.type === 'done' && validate) guard(() => assertValid('Calibration', e.calibration));
    rec.calibration.push(e);
  });
  pipe.on('recenter', (e) => rec.recenter.push(e));
  pipe.on('warning', (e) => rec.warning.push(e));
  /** Call after pipe.reset(): a reset starts a new session, so blade time may restart. */
  rec.resetTime = () => {
    lastT = -Infinity;
  };
  rec.check = () => {
    if (rec.violations.length) throw rec.violations[0];
  };
  rec.drain = () => {
    rec.check();
    const segs = pipe.drainSegments();
    for (const s of segs) {
      if (validate) assertValid('BladeSegment', s);
      rec.segments.push(s);
    }
    return segs;
  };
  recorders.set(pipe, rec);
  return rec;
}

/** Push a list of ImuSamples; calls poll(t) after each one (like the frame loop would) unless poll:false. */
export function feed(pipe, samples, { poll = true, validate = true } = {}) {
  for (const s of samples) {
    if (validate) assertValid('ImuSample', s);
    pipe.pushImu(s);
    if (poll) pipe.poll(s.t);
    recorders.get(pipe)?.check();
  }
}

export const angleDeg = (a, b) => {
  const dot = a.x * b.x + a.y * b.y + a.z * b.z;
  const cx = a.y * b.z - a.z * b.y;
  const cy = a.z * b.x - a.x * b.z;
  const cz = a.x * b.y - a.y * b.x;
  return (Math.atan2(Math.hypot(cx, cy, cz), dot) * 180) / Math.PI;
};

/**
 * Run the calibration gesture (tip up, move to the screen, hold, centre) through a fresh or given pipeline.
 * @returns {{pipe, synth, rec, cal, done, script}}
 */
export function runCalibration(synthOpts = {}, { pipe, pipeOpts = {}, script = {}, validate = true } = {}) {
  const synth = createSynth(synthOpts);
  const p = pipe ?? createAbsolutePipeline(pipeOpts); // pass { pointerModel: 'relative' } in pipeOpts for the relative model
  const rec = record(p, { validate });
  const sc = calibrationScript(script);
  p.startCalibration({ side: synthOpts.side ?? 'R' });
  feed(p, synth.generate(sc.pose, sc.totalMs), { validate });
  const done = rec.calibration.find((e) => e.type === 'done') ?? null;
  return { pipe: p, synth, rec, cal: done ? done.calibration : p.getCalibration(), done, script: sc };
}

/** A calibrated pipeline sitting at the neutral pose, centred, with the recorder attached. */
export function calibratedPipeline(synthOpts = {}, pipeOpts = {}) {
  const r = runCalibration(synthOpts, { pipeOpts });
  if (!r.done) throw new Error(`calibration did not finish: ${JSON.stringify(r.rec.calibration.filter((e) => e.type !== 'progress').slice(-4))}`);
  return r;
}

/**
 * Continue a synth run after `calibratedPipeline`: builds a pose path from keyframes whose times are offsets (ms) from the
 * synth's current device time, generates the samples and feeds them.
 */
export function play(r, keys, { ease = 'smooth', poll = true } = {}) {
  const t0 = r.synth.devMs;
  const shifted = keys.map((k) => ({ ...k, t: t0 + k.t }));
  const pose = keyframes(shifted, { ease });
  const end = t0 + keys[keys.length - 1].t;
  const samples = r.synth.generate(pose, end + 1);
  feed(r.pipe, samples, { poll });
  return samples;
}

/** Latest blade sample of a recorder (re-throws any contract violation collected so far). */
export function lastBlade(rec) {
  rec.check?.();
  return rec.blades[rec.blades.length - 1];
}
