import test from 'node:test';
import assert from 'node:assert/strict';
import { createMotionPipeline, MOTION_CONFIG } from '../../public/js/motion/index.js';
import { BladeTracker } from '../../public/js/motion/blade-tracker.js';
import { assertValid } from '../../public/js/shared/validate.js';
import { createManualClock } from '../../public/js/shared/clock.js';
import { createSynth, holdPose, keyframes } from '../../test-support/motion/synth.js';
import { calibratedPipeline, feed, lastBlade, play, record, createAbsolutePipeline } from '../../test-support/motion/harness.js';

const near = (a, b, tol, msg = '') => assert.ok(Math.abs(a - b) <= tol, `${msg} expected ${b} +-${tol}, got ${a}`);
const at = (yaw, pitch, roll = 0) => ({ yaw, pitch, roll });

const imu = (i, extra = {}) => ({
  seq: i, t: 1000 + i * 15, arrivedAt: 1004 + i * 15, dtMs: i ? 15 : null, dtSource: 'synthetic',
  accel: { x: 0, y: 0, z: 1 }, gyro: { x: 0, y: 0, z: 0 }, side: 'R', buttons: [], batteryMv: 3700, tempC: 25, imuActive: true, ...extra,
});

// ------------------------------------------------------------------------------------------------------------ the two paths

test('pushAim path = pure position stream: the same positions through IMU and aim pipelines give identical blades and segments', () => {
  const r = calibratedPipeline({ mount: 'tilted', hz: 66, seed: 300 });
  r.pipe.setSettings({ autoCenter: false });
  play(r, [
    { t: 0, yaw: 0, pitch: 0 }, { t: 300, yaw: 0, pitch: 0 }, { t: 450, yaw: -20, pitch: 6 }, { t: 700, yaw: -20, pitch: 6 },
    { t: 850, yaw: 18, pitch: -4 }, { t: 1300, yaw: 18, pitch: -4 },
  ]);
  const imuBlades = r.rec.blades; // everything since the calibration finished: both pipelines start from an empty tracker
  assert.ok(imuBlades.some((b) => b.cutting));
  // replay the positions of the IMU pipeline through a mouse-style pipeline, including the discontinuity flags
  const aimPipe = createAbsolutePipeline();
  const aimRec = record(aimPipe);
  for (const b of imuBlades) aimPipe.pushAim({ t: b.t, x: b.x, y: b.y, discontinuity: b.discontinuity });
  const aimBlades = aimRec.blades;
  assert.equal(aimBlades.length, imuBlades.length);
  for (let i = 0; i < imuBlades.length; i += 1) {
    const a = imuBlades[i];
    const b = aimBlades[i];
    assert.equal(b.source, 'aim');
    assert.equal(b.angularSpeedDps, null);
    assert.equal(a.source, 'imu');
    assert.ok(a.angularSpeedDps !== null);
    for (const k of ['t', 'x', 'y', 'speed', 'cutting', 'swingId', 'segmentValid', 'x0', 'y0', 't0', 'discontinuity']) assert.equal(b[k], a[k], `${k} at ${i}`);
  }
  // the segment streams are identical too
  const segsImu = r.rec.drain();
  const segsAim = aimRec.drain();
  assert.ok(segsAim.length > 5);
  assert.deepEqual(segsAim, segsImu);
});

test('aim path: works uncalibrated, clamps to the playfield, reports source aim, angular speed null, never tracking-lost', () => {
  const pipe = createAbsolutePipeline();
  const rec = record(pipe);
  assert.equal(pipe.getState().calibrated, false);
  pipe.pushAim({ t: 10, x: -50, y: 2000, discontinuity: true });
  pipe.pushAim({ t: 25, x: 3000, y: -3, discontinuity: false });
  const [a, b] = rec.blades;
  assert.deepEqual([a.x, a.y, b.x, b.y], [0, 1080, 1920, 0]);
  assert.ok(rec.blades.every((s) => s.source === 'aim' && s.angularSpeedDps === null && s.trackingOk));
  assert.equal(pipe.getState().trackingOk, true);
  assert.equal(pipe.getState().calibrated, false);
  // garbage is ignored
  pipe.pushAim(null);
  pipe.pushAim({ t: 30, x: NaN, y: 1 });
  pipe.pushAim({ t: 30, x: 1, y: Infinity });
  assert.equal(rec.blades.length, 2);
  // a resting mouse is NOT tracking-lost, however long it rests
  pipe.poll(10000);
  assert.equal(rec.blades.length, 2);
  assert.equal(pipe.getState().trackingOk, true);
});

test('aim path: a mouse that stops during CUTTING gets one synthetic "at rest" sample from poll so the blade stops cutting', () => {
  const pipe = createAbsolutePipeline();
  const rec = record(pipe);
  let t = 0;
  let x = 100;
  pipe.pushAim({ t, x, y: 300, discontinuity: true });
  for (let i = 0; i < 20; i += 1) {
    t += 8;
    x += 24; // 3000 px/s
    pipe.pushAim({ t, x, y: 300 });
  }
  assert.equal(lastBlade(rec).cutting, true);
  const n = rec.blades.length;
  pipe.poll(t + 30); // less than aimIdleMs: nothing
  assert.equal(rec.blades.length, n);
  pipe.poll(t + 80);
  assert.equal(rec.blades.length, n + 1);
  const rest = lastBlade(rec);
  assert.deepEqual([rest.cutting, rest.x, rest.y, rest.segmentValid, rest.source, rest.trackingOk], [false, x, 300, false, 'aim', true]);
  assert.ok(rest.speed < 0.65 * 1000);
  pipe.poll(t + 500);
  assert.equal(rec.blades.length, n + 1, 'only once');
  assert.equal(pipe.getState().cutting, false);
  // moving again continues normally with a fresh swing
  t += 600;
  for (let i = 0; i < 20; i += 1) {
    t += 8;
    x += 24;
    pipe.pushAim({ t, x, y: 300 });
  }
  assert.equal(lastBlade(rec).cutting, true);
  assert.equal(lastBlade(rec).swingId, 2);
});

test('switching provider kind between imu and aim flags a discontinuity', () => {
  const r = calibratedPipeline({ mount: 'faceUp', hz: 66, seed: 301 });
  r.pipe.pushAim({ t: r.synth.nowMs + 20, x: 500, y: 500 });
  assert.equal(lastBlade(r.rec).discontinuity, true);
  assert.equal(lastBlade(r.rec).source, 'aim');
  r.pipe.pushAim({ t: r.synth.nowMs + 36, x: 505, y: 500 });
  assert.equal(lastBlade(r.rec).discontinuity, false);
  feed(r.pipe, r.synth.generate(holdPose(0, 0, 0), r.synth.devMs + 100));
  const firstImu = r.rec.blades.find((b, i) => i > 0 && b.source === 'imu' && r.rec.blades[i - 1].source === 'aim');
  assert.equal(firstImu.discontinuity, true);
});

// -------------------------------------------------------------------------------------------------------- poll: tracking loss

test('poll: after 200 ms without an IMU sample one synthetic tracking-lost sample, then a discontinuity on the first real one', () => {
  const r = calibratedPipeline({ mount: 'tilted', hz: 66, seed: 302 });
  r.pipe.setSettings({ autoCenter: false });
  play(r, [{ t: 0, yaw: 0, pitch: 0 }, { t: 150, yaw: 14, pitch: 0 }, { t: 200, yaw: 14, pitch: 0 }]);
  const last = lastBlade(r.rec);
  const n = r.rec.blades.length;
  r.pipe.poll(last.t + 150);
  assert.equal(r.rec.blades.length, n, 'not yet');
  r.pipe.poll(last.t + 250);
  assert.equal(r.rec.blades.length, n + 1);
  const lost = lastBlade(r.rec);
  assert.deepEqual([lost.trackingOk, lost.cutting, lost.speed, lost.segmentValid, lost.x, lost.y, lost.t], [false, false, 0, false, last.x, last.y, last.t + 250]);
  assert.equal(r.pipe.getState().trackingOk, false);
  r.pipe.poll(last.t + 400);
  assert.equal(r.rec.blades.length, n + 1, 'exactly one');
  assert.equal(r.pipe.headAt(last.t + 500).x, last.x, 'no extrapolation while tracking is lost');
  // data comes back: first sample breaks the trail
  feed(r.pipe, r.synth.generate(holdPose(14, 0, 0), r.synth.devMs + 100));
  const back = r.rec.blades[n + 1];
  assert.equal(back.discontinuity, true);
  assert.equal(back.trackingOk, true);
  assert.equal(r.rec.blades[n + 2].discontinuity, false);
  assert.equal(r.pipe.getState().trackingOk, true);
});

test('poll: a swing interrupted by tracking loss leaves CUTTING and the next swing is a new swingId', () => {
  const r = calibratedPipeline({ mount: 'faceUp', hz: 66, seed: 303 });
  const pose = keyframes([{ t: r.synth.devMs, yaw: 0, pitch: 0 }, { t: r.synth.devMs + 300, yaw: 40, pitch: 0 }]);
  const samples = r.synth.generate(pose, r.synth.devMs + 150); // stop feeding in the middle of the swing
  feed(r.pipe, samples, { poll: false });
  assert.equal(lastBlade(r.rec).cutting, true);
  const id = lastBlade(r.rec).swingId;
  r.pipe.poll(lastBlade(r.rec).t + 260);
  assert.equal(lastBlade(r.rec).cutting, false);
  feed(r.pipe, r.synth.generate(keyframes([{ t: r.synth.devMs, yaw: 20, pitch: 0 }, { t: r.synth.devMs + 200, yaw: -20, pitch: 0 }]), r.synth.devMs + 200));
  const again = r.rec.blades.filter((b) => b.cutting).pop();
  assert.equal(again.swingId, id + 1);
});

// ------------------------------------------------------------------------------------------------------ headAt, recent, drain

test('headAt: newest position plus at most 15 ms of extrapolation, clamped to the playfield, null before any sample', () => {
  const pipe = createAbsolutePipeline();
  assert.equal(pipe.headAt(100), null);
  let t = 0;
  let x = 100;
  pipe.pushAim({ t, x, y: 500, discontinuity: true });
  for (let i = 0; i < 12; i += 1) {
    t += 15;
    x += 30; // 2000 px/s
    pipe.pushAim({ t, x, y: 500 });
  }
  const h0 = pipe.headAt(t);
  assert.deepEqual([h0.x, h0.y], [x, 500]);
  near(pipe.headAt(t + 5).x - x, 10, 0.5, '5 ms x 2000 px/s');
  near(pipe.headAt(t + 15).x - x, 30, 0.5, '15 ms');
  near(pipe.headAt(t + 60).x - x, 30, 0.5, 'capped at 15 ms');
  assert.equal(pipe.headAt(t - 10).x, x, 'never extrapolates backwards');
  // clamp at the edge
  const edge = createAbsolutePipeline();
  edge.pushAim({ t: 0, x: 1700, y: 500, discontinuity: true });
  for (let i = 1; i <= 10; i += 1) edge.pushAim({ t: i * 15, x: 1700 + i * 21, y: 500 });
  assert.ok(edge.headAt(150 + 15).x <= 1920);
  // no extrapolation across a discontinuity
  const d = createAbsolutePipeline();
  d.pushAim({ t: 0, x: 100, y: 100, discontinuity: true });
  d.pushAim({ t: 15, x: 130, y: 100 });
  d.pushAim({ t: 30, x: 900, y: 100, discontinuity: true });
  assert.deepEqual(d.headAt(45), { x: 900, y: 100 });
});

test('recent: samples of the last window relative to the NEWEST sample, oldest first, ring of 384', () => {
  const pipe = createAbsolutePipeline();
  const rec = record(pipe, { validate: false });
  assert.deepEqual(pipe.recent(100), []);
  let t = 0;
  for (let i = 0; i < 500; i += 1) {
    t += 10;
    pipe.pushAim({ t, x: 10 + i, y: 10, discontinuity: i === 0 });
  }
  const all = pipe.recent(1e9);
  assert.equal(all.length, 384, 'the ring holds historySize = 384 samples (was 128: it also holds the interpolated trail samples)');
  assert.deepEqual(all.map((s) => s.t), rec.blades.slice(-384).map((s) => s.t));
  const w = pipe.recent(100);
  assert.deepEqual(w.map((s) => s.t), [4900, 4910, 4920, 4930, 4940, 4950, 4960, 4970, 4980, 4990, 5000]);
  assert.equal(pipe.latest().t, 5000);
  assert.equal(pipe.latest(), rec.blades[rec.blades.length - 1]);
});

test('drainSegments returns the eligible segments once, oldest first, and clears the queue', () => {
  const pipe = createAbsolutePipeline();
  let t = 0;
  let x = 50;
  pipe.pushAim({ t, x, y: 50, discontinuity: true });
  for (let i = 0; i < 20; i += 1) {
    t += 10;
    x += 30;
    pipe.pushAim({ t, x, y: 50 });
  }
  const a = pipe.drainSegments();
  assert.ok(a.length >= 10);
  for (let i = 1; i < a.length; i += 1) assert.ok(a[i].t1 >= a[i - 1].t1 && a[i].x0 === a[i - 1].x1);
  assert.deepEqual(pipe.drainSegments(), []);
  for (const s of a) assertValid('BladeSegment', s);
});

// ---------------------------------------------------------------------------------------------------------- events and API

test('events are emitted synchronously inside pushImu/pushAim; unsubscribe works; a throwing listener does not stop the stream', () => {
  const pipe = createAbsolutePipeline();
  const seen = [];
  const off = pipe.on('blade', (b) => seen.push(b.t));
  pipe.on('blade', () => {
    throw new Error('listener bug');
  });
  const errors = console.error;
  console.error = () => {};
  try {
    pipe.pushAim({ t: 5, x: 1, y: 1 });
    assert.deepEqual(seen, [5], 'delivered before pushAim returned');
    off();
    pipe.pushAim({ t: 10, x: 2, y: 2 });
    assert.deepEqual(seen, [5]);
    const fn = () => seen.push('x');
    pipe.on('blade', fn);
    pipe.off('blade', fn);
    pipe.pushAim({ t: 15, x: 3, y: 3 });
    assert.deepEqual(seen, [5]);
  } finally {
    console.error = errors;
  }
  // methods are safe to destructure (the interface is plain functions)
  const { pushAim, getState } = createAbsolutePipeline();
  pushAim({ t: 1, x: 5, y: 6 });
  assert.equal(getState().x, 5);
});

test('getState reports the documented fields for an IMU session', () => {
  const r = calibratedPipeline({ mount: 'tilted', hz: 66, seed: 310 });
  r.pipe.setSettings({ autoCenter: false });
  play(r, [{ t: 0, yaw: 0, pitch: 0 }, { t: 500, yaw: 10, pitch: 5 }, { t: 900, yaw: 10, pitch: 5 }]);
  const st = r.pipe.getState();
  assert.equal(st.calibrated, true);
  assert.equal(st.calibrationStep, null);
  near(st.x, 960 + 274, 15);
  near(st.y, 540 - 137, 15);
  near(st.yawDeg, 10, 0.6);
  near(st.pitchDeg, 5, 0.6);
  near(st.sampleRateHz, 66, 3);
  assert.equal(st.trackingOk, true);
  assert.equal(st.lastSampleT, lastBlade(r.rec).t);
  assert.ok(st.angularSpeedDps < 1);
  assert.equal(st.cutting, false);
  assert.equal(st.swingId, 0);
  // during a swing
  const marks = [];
  r.pipe.on('blade', () => marks.push(r.pipe.getState().angularSpeedDps));
  play(r, [{ t: 0, yaw: 10, pitch: 5 }, { t: 120, yaw: -20, pitch: 5 }, { t: 300, yaw: -20, pitch: 5 }]);
  assert.ok(Math.max(...marks) > 200);
  assert.equal(r.pipe.getState().swingId, 1);
});

test('setCalibration: validates, copies, clears with null, and the first sample defines the centre (level = vertical centre)', () => {
  const synth = createSynth({ mount: 'sideRail', hz: 66, seed: 320 });
  const pipe = createAbsolutePipeline();
  const rec = record(pipe);
  assert.throws(() => pipe.setCalibration({ version: 1 }), TypeError);
  assert.throws(() => pipe.setCalibration({ ...synth.nominalCalibration(), gyroSign: 2 }), /invalid Calibration/);
  const cal = synth.nominalCalibration();
  pipe.setCalibration(cal);
  cal.frame.forward.x = 99; // mutating the caller's object must not affect the pipeline
  cal.gyroBiasDps.x = 99;
  const got = pipe.getCalibration();
  assertValid('Calibration', got);
  assert.notEqual(got.frame.forward.x, 99);
  assert.notEqual(got.gyroBiasDps.x, 99);
  got.frame.forward.x = 55; // and the returned copy is detached too
  assert.notEqual(pipe.getCalibration().frame.forward.x, 55);
  assert.equal(pipe.getState().calibrated, true);
  // first sample: pointing 5 deg above level and 12 deg to the side: yaw becomes the centre, pitch 0 is level
  feed(pipe, synth.generate(holdPose(12, 5, 0), 400));
  const b = lastBlade(rec);
  near(b.x, 960, 3, 'yaw at the first sample is the centre');
  near(b.y, 540 - 5 * 27.4, 12, 'pitch is absolute (level = centre)');
  pipe.setCalibration(null);
  assert.equal(pipe.getCalibration(), null);
  assert.equal(pipe.getState().calibrated, false);
  const n = rec.blades.length;
  feed(pipe, synth.generate(holdPose(12, 5, 0), 600));
  assert.equal(rec.blades.length, n, 'no blade samples without a calibration');
});

test('getCalibration returns the live (online-updated) gyro bias with the same frame', () => {
  const synth = createSynth({ mount: 'faceUp', hz: 66, seed: 321, gyroBiasDps: [0.5, 0.5, 0.5] });
  const pipe = createAbsolutePipeline();
  const cal = synth.nominalCalibration();
  cal.gyroBiasDps.z -= 1.2;
  pipe.setCalibration(cal);
  feed(pipe, synth.generate(holdPose(0, 0, 0), 8000));
  const now = pipe.getCalibration();
  assert.ok(Math.abs(now.gyroBiasDps.z - 0.5) < 0.25, `bias z ${now.gyroBiasDps.z}`);
  assertValid('Calibration', now);
});

test('reset(): clears filter, tracker, history and references but keeps settings and calibration', () => {
  const r = calibratedPipeline({ mount: 'tilted', hz: 66, seed: 330 });
  r.pipe.setSettings({ sensitivity: 1.4, cutThreshold: 1200, flipX: true });
  play(r, [{ t: 0, yaw: 0, pitch: 0 }, { t: 150, yaw: 20, pitch: 8 }, { t: 400, yaw: 20, pitch: 8 }]);
  assert.ok(r.pipe.getState().swingId >= 1);
  r.pipe.reset();
  assert.equal(r.pipe.latest(), null);
  assert.deepEqual(r.pipe.recent(1000), []);
  assert.deepEqual(r.pipe.drainSegments(), []);
  assert.equal(r.pipe.getState().swingId, 0);
  assert.equal(r.pipe.getState().sampleRateHz, null);
  assert.equal(r.pipe.getSettings().sensitivity, 1.4);
  assert.equal(r.pipe.getSettings().flipX, true);
  assert.ok(r.pipe.getCalibration());
  // it works again straight away; the first pose (yaw 20 / pitch 8) is the new yaw centre
  const n = r.rec.blades.length;
  feed(r.pipe, r.synth.generate(holdPose(20, 8, 0), r.synth.devMs + 300));
  assert.ok(r.rec.blades.length > n);
  near(lastBlade(r.rec).x, 960, 4);
});

// ------------------------------------------------------------------------------------------------------- input hygiene, warnings

test('input hygiene: NaN, missing fields and imuActive=false are ignored; backwards t is clamped; dt null after a gap flags a discontinuity', () => {
  const synth = createSynth({ mount: 'faceUp', hz: 66, seed: 340 });
  const pipe = createAbsolutePipeline();
  const rec = record(pipe, { validate: false });
  pipe.setCalibration(synth.nominalCalibration());
  pipe.pushImu(null);
  pipe.pushImu({});
  pipe.pushImu(imu(0, { accel: { x: NaN, y: 0, z: 1 } }));
  pipe.pushImu(imu(0, { gyro: { x: 0, y: Infinity, z: 0 } }));
  pipe.pushImu(imu(0, { imuActive: false }));
  assert.equal(rec.blades.length, 0);
  pipe.pushImu(imu(0));
  pipe.pushImu(imu(1));
  pipe.pushImu(imu(2, { t: 900 })); // earlier than the previous sample
  assert.ok(rec.blades.every((b, i) => i === 0 || b.t >= rec.blades[i - 1].t));
  // a gap: dtMs null and t jumps 400 ms
  pipe.pushImu(imu(3, { t: 1600, dtMs: null }));
  assert.equal(lastBlade(rec).discontinuity, true);
  pipe.pushImu(imu(4, { t: 1615, dtMs: 15 }));
  assert.equal(lastBlade(rec).discontinuity, false);
  // the device clock says 250 ms passed: a real hole, whatever t says
  pipe.pushImu(imu(5, { t: 1630, dtMs: 250 }));
  assert.equal(lastBlade(rec).discontinuity, true);
  // a non-positive device step right behind the previous sample (a burst pair under the arrival-time fallback) only skips
  // the integration of that step: it must not break the trail
  pipe.pushImu(imu(6, { t: 1645, dtMs: 0 }));
  assert.equal(lastBlade(rec).discontinuity, false);
  pipe.pushImu(imu(7, { t: 1645, dtMs: null }));
  assert.equal(lastBlade(rec).discontinuity, false);
  pipe.pushImu(imu(8, { t: 1900, dtMs: null })); // ... but a visible hole with unknown dt does
  assert.equal(lastBlade(rec).discontinuity, true);
});

test('burst pairs (identical t, real device step in dtMs) neither trip the safety cap nor break a swing', () => {
  const r = calibratedPipeline({ mount: 'tilted', hz: 66, seed: 341 });
  r.pipe.setSettings({ autoCenter: false });
  const t0 = r.synth.devMs;
  const pose = keyframes([{ t: t0, yaw: 0, pitch: 0 }, { t: t0 + 300, yaw: 0, pitch: 0 }, { t: t0 + 420, yaw: 30, pitch: 0 }, { t: t0 + 800, yaw: 30, pitch: 0 }]);
  const samples = r.synth.generate(pose, t0 + 800).map((smp, i, all) => (i % 2 === 1 ? { ...smp, t: all[i - 1].t } : smp)); // every second sample arrives with its neighbour
  feed(r.pipe, samples, { validate: false, poll: false });
  assert.equal(r.pipe.getDebug().glitches, 0, 'the 30 deg swing in 120 ms is not a glitch');
  const cutting = r.rec.blades.filter((b) => b.cutting);
  assert.ok(cutting.length >= 4);
  assert.equal(new Set(cutting.map((b) => b.swingId)).size, 1);
  near(lastBlade(r.rec).x, 960 + 30 * 27.4, 6);
});

test('warnings: rate limited to once per second per code; codes and payloads are contract shaped', () => {
  const pipe = createAbsolutePipeline();
  const seen = [];
  pipe.on('warning', (w) => seen.push(w));
  // dt fallback every sample for 2.5 s
  for (let i = 0; i < 170; i += 1) pipe.pushImu(imu(i, { dtSource: 'arrival' }));
  const fallback = seen.filter((w) => w.code === 'dt_fallback');
  assert.ok(fallback.length >= 2 && fallback.length <= 3, `dt_fallback x${fallback.length}`);
  for (let i = 1; i < fallback.length; i += 1) assert.ok(fallback[i].t - fallback[i - 1].t >= 1000);
  // saturation
  const p2 = createAbsolutePipeline();
  const s2 = [];
  p2.on('warning', (w) => s2.push(w.code));
  p2.pushImu(imu(0, { accel: { x: 0, y: 0, z: 8 } }));
  p2.pushImu(imu(1, { gyro: { x: 1999.9, y: 0, z: 0 } }));
  p2.pushImu(imu(2, { gyro: { x: 0, y: -2000, z: 0 } }));
  assert.deepEqual([...new Set(s2)].sort(), ['accel_saturated', 'gyro_saturated']);
  assert.equal(s2.filter((c) => c === 'gyro_saturated').length, 1, 'rate limited');
  // sample gap
  const p3 = createAbsolutePipeline();
  const s3 = [];
  p3.on('warning', (w) => s3.push(w));
  p3.pushImu(imu(0));
  p3.pushImu(imu(1, { t: 1150, dtMs: 150 }));
  assert.equal(s3.filter((w) => w.code === 'sample_gap').length, 1);
  for (const w of s3) assert.ok(typeof w.message === 'string' && Number.isFinite(w.t));
  // low sample rate: 10 Hz for 3 s
  const p4 = createAbsolutePipeline();
  const s4 = [];
  p4.on('warning', (w) => s4.push(w.code));
  for (let i = 0; i < 40; i += 1) p4.pushImu(imu(i, { t: 1000 + i * 100, dtMs: 100 }));
  assert.ok(s4.includes('low_sample_rate'));
  const p5 = createAbsolutePipeline();
  const s5 = [];
  p5.on('warning', (w) => s5.push(w.code));
  for (let i = 0; i < 300; i += 1) p5.pushImu(imu(i));
  assert.equal(s5.includes('low_sample_rate'), false, '66 Hz is fine');
  assert.ok(MOTION_CONFIG.lowSampleRateHz === 20);
});

test('warnings: a step above the IMU safety cap raises gyro_saturated and is excluded from the blade', () => {
  const r = calibratedPipeline({ mount: 'faceUp', hz: 66, seed: 350 });
  r.pipe.setSettings({ autoCenter: false });
  const warns = [];
  r.pipe.on('warning', (w) => warns.push(w.code));
  // a corrupted sample: gyro spike of 1500 dps about the vertical axis over 15 ms = 22 deg = 617 px in one step: below the
  // cap (60 000 px/s = 900 px per 15 ms), so craft a bigger one: 4 s of dt at once is not possible, use a huge spike
  const s = r.synth.generate(holdPose(0, 0, 0), r.synth.devMs + 60);
  feed(r.pipe, s.slice(0, 2));
  const spike = { ...s[2], gyro: { x: s[2].gyro.x, y: s[2].gyro.y, z: s[2].gyro.z + 1990 } };
  r.pipe.pushImu(spike);
  r.pipe.pushImu(s[3]);
  const segs = r.pipe.drainSegments();
  assert.ok(segs.every((g) => Math.hypot(g.x1 - g.x0, g.y1 - g.y0) < 800), 'no chord across a corrupted step');
  assert.ok(warns.includes('gyro_saturated'));
});

// ------------------------------------------------------------------------------------------------------------------ hygiene

test('purity: never reads wall-clock time except Calibration.createdAt, never Math.random, never performance.now', () => {
  const realDateNow = Date.now;
  const realRandom = Math.random;
  const realPerf = globalThis.performance.now.bind(globalThis.performance);
  let dateCalls = 0;
  Date.now = () => {
    dateCalls += 1;
    return realDateNow();
  };
  Math.random = () => {
    throw new Error('Math.random used');
  };
  globalThis.performance.now = () => {
    throw new Error('performance.now used');
  };
  try {
    const r = calibratedPipeline({ mount: 'tilted', hz: 66, seed: 360 });
    assert.equal(dateCalls, 1, 'exactly one Date.now call: createdAt');
    play(r, [{ t: 0, yaw: 0, pitch: 0 }, { t: 200, yaw: 25, pitch: 5 }, { t: 900, yaw: 25, pitch: 5 }]);
    r.pipe.recenter();
    r.pipe.beginQuickRecenter();
    play(r, [{ t: 0, yaw: 25, pitch: 5 }, { t: 2000, yaw: 25, pitch: 5 }]);
    r.pipe.poll(1e9);
    assert.equal(dateCalls, 1);
  } finally {
    Date.now = realDateNow;
    Math.random = realRandom;
    globalThis.performance.now = realPerf;
  }
});

test('determinism: the same stream produces identical blade samples, segments and events, twice', () => {
  const run = () => {
    const r = calibratedPipeline({ mount: 'sideRail', side: 'L', hz: 66, seed: 370, tJitterMs: 3 });
    play(r, [
      { t: 0, yaw: 0, pitch: 0 }, { t: 400, yaw: 0, pitch: 0 }, { t: 550, yaw: -22, pitch: 5 }, { t: 900, yaw: -22, pitch: 5 },
      { t: 1050, yaw: 20, pitch: -6 }, { t: 1600, yaw: 20, pitch: -6 },
    ]);
    return JSON.stringify({ blades: r.rec.blades, segments: r.rec.drain(), recenter: r.rec.recenter, warnings: r.rec.warning, cal: r.rec.calibration.map((e) => (e.type === 'done' ? { ...e, calibration: { ...e.calibration, createdAt: 0 } } : e)) });
  };
  assert.equal(run(), run());
});

test('performance: well under the 2 ms per sample budget (architecture section 12)', (t) => {
  const synth = createSynth({ mount: 'tilted', hz: 250, seed: 380 });
  const pipe = createAbsolutePipeline();
  pipe.setCalibration(synth.nominalCalibration());
  const keys = [{ t: 0, yaw: 0, pitch: 0 }];
  for (let i = 1; i <= 60; i += 1) keys.push({ t: i * 500, yaw: (i % 2 ? 1 : -1) * 25, pitch: (i % 3) * 5 });
  const samples = synth.generate(keyframes(keys), 30000); // 7500 samples with lots of cutting
  let blades = 0;
  pipe.on('blade', () => {
    blades += 1;
  });
  const t0 = performance.now();
  for (let rep = 0; rep < 8; rep += 1) for (const s of samples) pipe.pushImu(s);
  const elapsed = performance.now() - t0;
  const perSampleUs = (elapsed * 1000) / (samples.length * 8);
  t.diagnostic(`${samples.length * 8} samples in ${elapsed.toFixed(1)} ms = ${perSampleUs.toFixed(2)} us per sample (budget 2000 us)`);
  assert.ok(blades > 0);
  assert.ok(perSampleUs < 200, `${perSampleUs} us per sample`);
});

test('BladeTracker is exposed by the module only through the pipeline (index exports)', async () => {
  const mod = await import('../../public/js/motion/index.js');
  assert.deepEqual(Object.keys(mod).sort(), ['MOTION_CONFIG', 'createMotionPipeline']);
  assert.equal(typeof BladeTracker, 'function');
});
