import test from 'node:test';
import assert from 'node:assert/strict';
import { OrientationFilter, BiasEstimator, accelTrustWeight } from '../../public/js/motion/fusion.js';
import { MOTION_CONFIG } from '../../public/js/motion/motion-config.js';
import { vAngleDeg } from '../../public/js/motion/vec.js';
import { createSynth, keyframes, holdPose, MOUNTS, ALT_SCALE } from '../../test-support/motion/synth.js';
import { feed, record, createAbsolutePipeline } from '../../test-support/motion/harness.js';

const RAD = Math.PI / 180;

test('filter: converges from a wrong initial pitch (< 1 deg after 5 tau), at 33, 66 and 250 Hz', () => {
  for (const hz of [33, 66, 250]) {
    const f = new OrientationFilter(MOTION_CONFIG.fusion.tauS);
    // initialise from an accelerometer reading that is 30 deg off (device tilted 30 deg about x)
    f.initFromAccel(0, Math.sin(30 * RAD), Math.cos(30 * RAD));
    const errAt = () => vAngleDeg(f.predictedUp(), { x: 0, y: 0, z: 1 });
    assert.ok(Math.abs(errAt() - 30) < 1e-6, 'starts 30 deg away from the true (level) up direction');
    // the device is actually level: measured up = (0,0,1)
    const dtS = 1 / hz;
    const steps = Math.round(7.5 * hz); // 5 tau
    let err1tau = null;
    for (let i = 0; i < steps; i += 1) {
      f.integrate(0, 0, 0, dtS);
      f.correct(0, 0, 1, dtS, 1);
      if (err1tau === null && (i + 1) * dtS >= 1.5) err1tau = errAt();
    }
    // The initial error is measured against the level truth: 30 deg
    assert.ok(errAt() < 1, `${hz} Hz: residual ${errAt().toFixed(3)} deg after 5 tau`);
    assert.ok(err1tau > 8 && err1tau < 14, `${hz} Hz: after 1 tau the error is about 30/e = 11 deg, got ${err1tau.toFixed(2)}`);
  }
});

test('filter: the start-up boost fades the error of the first noisy reading faster, then hands over to the normal tau', () => {
  const make = (opts) => {
    const f = new OrientationFilter(1.5, opts);
    f.initFromAccel(0, Math.sin(6 * RAD), Math.cos(6 * RAD)); // the first reading is 6 deg off (level device)
    return f;
  };
  const err = (f) => vAngleDeg(f.predictedUp(), { x: 0, y: 0, z: 1 });
  const plain = make({});
  const boosted = make({ bootS: 1.0, bootTauS: 0.2 });
  const step = (f, seconds, hz = 66) => {
    for (let i = 0; i < Math.round(seconds * hz); i += 1) f.correct(0, 0, 1, 1 / hz, 1);
  };
  step(plain, 0.5);
  step(boosted, 0.5);
  assert.ok(err(boosted) < 0.6 * err(plain), `boosted ${err(boosted).toFixed(3)} vs plain ${err(plain).toFixed(3)} deg after 0.5 s`);
  step(plain, 7);
  step(boosted, 7);
  assert.ok(err(boosted) < 0.05 && err(plain) < 0.1);
  // after the boost period the gain is the normal one: a fresh 6 deg error then decays with tau = 1.5 s
  boosted.initFromAccel(0, 0, 1);
  step(boosted, 1.2); // boost over
  const b2 = boosted;
  b2.q = make({}).q; // 6 deg off again, age stays beyond the boost period
  const before = err(b2);
  step(b2, 1.5);
  assert.ok(Math.abs(err(b2) / before - Math.exp(-1)) < 0.03, `decay ratio ${err(b2) / before}`);
});

test('filter: pure rotation is integrated in the body frame (90 deg about each device axis)', () => {
  const expectUp = { x: { x: 0, y: 1, z: 0 }, y: { x: -1, y: 0, z: 0 }, z: { x: 0, y: 0, z: 1 } };
  // Rotate the device +90 deg about its own x axis: world up seen from the device becomes (0, sin, cos) = (0, 1, 0).
  // About y: (-sin, 0, cos) = (-1, 0, 0). About z: unchanged.
  for (const axis of ['x', 'y', 'z']) {
    const f = new OrientationFilter(1.5);
    f.initFromAccel(0, 0, 1);
    const w = { x: 0, y: 0, z: 0 };
    w[axis] = 100 * RAD; // 100 dps for 0.9 s
    const hz = 66;
    for (let i = 0; i < Math.round(0.9 * hz); i += 1) f.integrate(w.x, w.y, w.z, 1 / hz);
    const up = f.predictedUp();
    assert.ok(vAngleDeg(up, expectUp[axis]) < 0.7, `axis ${axis}: up ${JSON.stringify(up)}`);
  }
});

test('filter: initFromAccel handles upside-down and zero readings', () => {
  const f = new OrientationFilter(1.5);
  f.initFromAccel(0, 0, -1); // device upside down: world up is -z in device coordinates
  assert.ok(vAngleDeg(f.predictedUp(), { x: 0, y: 0, z: -1 }) < 1e-6);
  const w = f.toWorld(0, 0, -1); // the device's -z axis points at world up
  assert.ok(Math.abs(w.z - 1) < 1e-9);
  f.initFromAccel(0, 0, 0);
  assert.ok(f.ready);
  assert.equal(f.correct(0, 0, 0, 0.015, 1), -1, 'a zero accel reading is ignored');
  assert.equal(f.correct(0, 0, 1, 0.015, 0), -1, 'zero trust is ignored');
});

test('accelTrustWeight: zero while cutting or within 200 ms after, outside the band, or too fast; tapers otherwise', () => {
  const f = MOTION_CONFIG.fusion;
  const base = { accelMagG: 1, angularSpeedDps: 0, cutting: false, sinceCutMs: 1e9 };
  const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `expected ${b}, got ${a}`);
  near(accelTrustWeight(f, base), 1);
  assert.equal(accelTrustWeight(f, { ...base, cutting: true }), 0);
  assert.equal(accelTrustWeight(f, { ...base, sinceCutMs: 199 }), 0);
  near(accelTrustWeight(f, { ...base, sinceCutMs: 200 }), 1);
  assert.equal(accelTrustWeight(f, { ...base, accelMagG: 1.16 }), 0);
  assert.equal(accelTrustWeight(f, { ...base, accelMagG: 0.84 }), 0);
  assert.equal(accelTrustWeight(f, { ...base, angularSpeedDps: 301 }), 0);
  near(accelTrustWeight(f, { ...base, accelMagG: 1.04 }), 1);
  near(accelTrustWeight(f, { ...base, accelMagG: 0.96 }), 1);
  assert.ok(Math.abs(accelTrustWeight(f, { ...base, accelMagG: 1.10 }) - 0.5) < 1e-9, 'linear taper');
  assert.ok(Math.abs(accelTrustWeight(f, { ...base, angularSpeedDps: 60 }) - 0.5) < 1e-9, 'soft in angular speed');
  const w = accelTrustWeight(f, { ...base, angularSpeedDps: 30 });
  assert.ok(w > 0.7 && w < 0.9);
});

test('bias estimator: absorbs a resting bias, refuses a bias that is really a rotation, needs rest conditions', () => {
  const cfg = MOTION_CONFIG.gyroBias;
  const rest = { x: 0, y: 0, z: 1 };
  // constant gyro reading 1.5 dps off the current bias, at rest
  const est = new BiasEstimator(cfg);
  const bias = { x: 0, y: 0, z: 0 };
  let updates = 0;
  for (let i = 0; i < 66 * 10; i += 1) {
    if (est.feed(1000 + i * 15, { x: 1.5, y: 0, z: 0 }, rest, bias, 1)) updates += 1;
  }
  assert.ok(updates >= 8 && updates <= 10, `updates ${updates}`);
  assert.ok(Math.abs(bias.x - 1.5) < 0.3, `bias.x ${bias.x}`);
  assert.equal(bias.y, 0);

  // a steady 8 dps rotation about the vertical axis (accel unchanged) is NOT taken for a bias (max correction 5 dps)
  const est2 = new BiasEstimator(cfg);
  const b2 = { x: 0, y: 0, z: 0 };
  for (let i = 0; i < 66 * 6; i += 1) est2.feed(1000 + i * 15, { x: 0, y: 0, z: 8 }, rest, b2, 1);
  assert.equal(b2.z, 0);

  // in true dps: with the alternative scale the same 8 parsed dps is only 0.98 true dps and IS a valid bias
  const est3 = new BiasEstimator(cfg);
  const b3 = { x: 0, y: 0, z: 0 };
  for (let i = 0; i < 66 * 6; i += 1) est3.feed(1000 + i * 15, { x: 0, y: 0, z: 8 }, rest, b3, ALT_SCALE);
  assert.ok(b3.z > 4);

  // spread above 2.4 dps (true) resets the window: a moving sword never updates
  const est4 = new BiasEstimator(cfg);
  const b4 = { x: 0, y: 0, z: 0 };
  for (let i = 0; i < 66 * 6; i += 1) est4.feed(1000 + i * 15, { x: (i % 2) * 3, y: 0, z: 0 }, rest, b4, 1);
  assert.equal(b4.x, 0);

  // accel magnitude off 1 g (being shaken) never updates
  const est5 = new BiasEstimator(cfg);
  const b5 = { x: 0, y: 0, z: 0 };
  for (let i = 0; i < 66 * 6; i += 1) est5.feed(1000 + i * 15, { x: 1, y: 0, z: 0 }, { x: 0, y: 0, z: 1.1 }, b5, 1);
  assert.equal(b5.x, 0);

  // tilt changing inside the window (slow rotation seen by gravity) resets it
  const est6 = new BiasEstimator(cfg);
  const b6 = { x: 0, y: 0, z: 0 };
  for (let i = 0; i < 66 * 6; i += 1) {
    const a = (i * 0.3 * RAD) % 1.5;
    est6.feed(1000 + i * 15, { x: 1, y: 0, z: 0 }, { x: Math.sin(a), y: 0, z: Math.cos(a) }, b6, 1);
  }
  assert.equal(b6.x, 0);
});

// ------------------------------------------------------------------------------------------------ pipeline level

/** Calibrated pipeline through setCalibration (exact calibration of the synthetic sensor), pointing at the neutral pose. */
function nominalPipeline(synthOpts, pipeOpts = {}, calibrationPatch = null) {
  const synth = createSynth(synthOpts);
  const pipe = createAbsolutePipeline(pipeOpts);
  const cal = synth.nominalCalibration();
  if (calibrationPatch) calibrationPatch(cal);
  pipe.setCalibration(cal);
  const rec = record(pipe);
  return { synth, pipe, rec, cal };
}

test('pipeline fusion: a noisy still sensor stays put (jitter < 1 px, drift < 20 px in 60 s, auto centring off)', (t) => {
  const { synth, pipe, rec } = nominalPipeline({ mount: 'tilted', hz: 66, seed: 11 }, { settings: { autoCenter: false } });
  feed(pipe, synth.generate(holdPose(0, 0, 0), 60000));
  const xs = rec.blades.map((b) => b.x);
  const ys = rec.blades.map((b) => b.y);
  const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
  const std = (a) => Math.sqrt(mean(a.map((v) => (v - mean(a)) ** 2)));
  const drift = Math.max(Math.hypot(xs[xs.length - 1] - 960, ys[ys.length - 1] - 540), ...xs.map((x, i) => Math.hypot(x - 960, ys[i] - 540)));
  t.diagnostic(`still 60 s: std x ${std(xs).toFixed(3)} px, std y ${std(ys).toFixed(3)} px, max excursion ${drift.toFixed(2)} px`);
  assert.ok(std(xs) < 1 && std(ys) < 1);
  assert.ok(drift < 20, `drift ${drift}`);
  assert.equal(rec.blades.some((b) => b.cutting), false, 'a still sword never cuts');
});

test('pipeline fusion: a biased gyro drifts at the bias rate without correction, and the online estimator removes it', (t) => {
  // Calibration says bias 0, truth is (1.5, 0, 0) parsed dps... put the offset on the axis that is yaw for faceUp (z is up-ish),
  // so use gyro z for the yaw drift: faceUp mount, sword up = device z, so a z bias turns the sword about vertical.
  const err = 1.5;
  const patch = (cal) => {
    cal.gyroBiasDps.z -= err; // the estimate is err too small: the residual bias is +1.5 dps about the vertical axis
  };
  // (a) online estimator disabled by blocking every rest window: use a config whose blend is 0
  const off = nominalPipeline({ mount: 'faceUp', hz: 66, seed: 12, gyroBiasDps: [0, 0, 0.5] }, { settings: { autoCenter: false }, config: { gyroBias: { blend: 0 } } }, patch);
  feed(off.pipe, off.synth.generate(holdPose(0, 0, 0), 10000));
  const xOff = off.rec.blades[off.rec.blades.length - 1].x - 960;
  const expectedDrift = err * 10 * 27.4; // 411 px, clamped nothing: 15 deg
  t.diagnostic(`uncorrected: ${xOff.toFixed(1)} px after 10 s (expected about ${expectedDrift.toFixed(0)} px for ${err} dps)`);
  assert.ok(Math.abs(Math.abs(xOff) - expectedDrift) < 0.08 * expectedDrift, `drift ${xOff}`);

  // (b) with the estimator the bias error falls below 0.3 dps within 10 s
  const on = nominalPipeline({ mount: 'faceUp', hz: 66, seed: 12, gyroBiasDps: [0, 0, 0.5] }, { settings: { autoCenter: false } }, patch);
  feed(on.pipe, on.synth.generate(holdPose(0, 0, 0), 10000));
  const bias = on.pipe.getDebug().bias;
  const residual = Math.abs(bias.z - 0.5);
  t.diagnostic(`online bias residual after 10 s at rest: ${residual.toFixed(3)} dps (started at ${err} dps), ${on.pipe.getDebug().biasUpdates} updates`);
  assert.ok(residual < 0.3, `residual ${residual}`);
  // and the drift over the second half is far smaller than uncorrected
  const half = on.rec.blades.length >> 1;
  const drift2 = Math.abs(on.rec.blades[on.rec.blades.length - 1].x - on.rec.blades[half].x);
  assert.ok(drift2 < 0.35 * (expectedDrift / 2), `second-half drift ${drift2}`);
});

test('pipeline fusion: pitch stays within 2 deg of truth during a 5 s sequence with lever-arm acceleration and a swing', (t) => {
  for (const mount of ['faceUp', 'tilted', 'sideRail']) {
    const { synth, pipe, rec } = nominalPipeline({ mount, hz: 66, seed: 21, leverM: 0.45 }, { settings: { autoCenter: false } });
    const seq = [
      { t: 0, yaw: 0, pitch: 0 },
      { t: 800, yaw: 0, pitch: 0 },
      { t: 1800, yaw: 10, pitch: 18 }, // aim up and right
      { t: 2400, yaw: 10, pitch: 18 },
      { t: 2600, yaw: -25, pitch: 5 }, // fast swing (200 ms, 35 deg) -> cutting
      { t: 3100, yaw: -25, pitch: 5 },
      { t: 4000, yaw: 5, pitch: -12, roll: 35 },
      { t: 5000, yaw: 0, pitch: 0, roll: 0 },
    ];
    const pose = keyframes(seq);
    const errs = [];
    let cutSeen = false;
    pipe.on('blade', (b) => {
      if (b.cutting) cutSeen = true;
    });
    const samples = synth.generate(pose, 5000);
    for (const s of samples) {
      pipe.pushImu(s);
      const truth = pose(s.t - 1000).pitch;
      errs.push(Math.abs(pipe.getDebug().rawPitchDeg - truth));
    }
    const max = Math.max(...errs);
    const rms = Math.sqrt(errs.reduce((a, e) => a + e * e, 0) / errs.length);
    t.diagnostic(`${mount}: pitch error max ${max.toFixed(2)} deg, rms ${rms.toFixed(2)} deg over ${samples.length} samples`);
    assert.ok(cutSeen, 'the scripted swing was fast enough to cut');
    assert.ok(max < 2, `${mount}: pitch error ${max}`);
    assert.ok(rec.blades.length === samples.length);
  }
});

test('pipeline fusion: no gravity correction while cutting or within 200 ms after; correction resumes when quiet', () => {
  const { synth, pipe } = nominalPipeline({ mount: 'faceUp', hz: 66, seed: 31 }, { settings: { autoCenter: false } });
  const pose = keyframes([
    { t: 0, yaw: 0, pitch: 0 },
    { t: 1000, yaw: 0, pitch: 0 },
    { t: 1150, yaw: 40, pitch: 0 }, // 150 ms, 40 deg: 400 dps peak
    { t: 3000, yaw: 40, pitch: 0 },
  ]);
  const trace = [];
  let lastCut = -Infinity;
  let sawCut = false;
  pipe.on('blade', (b) => {
    const trust = pipe.getDebug().accelTrust;
    const wasCut = b.t - lastCut < 200;
    trace.push({ t: b.t, cutting: b.cutting, trust, quiet: !wasCut });
    if (b.cutting) {
      lastCut = b.t;
      sawCut = true;
    }
  });
  const samples = synth.generate(pose, 3000);
  for (const s of samples) pipe.pushImu(s);
  assert.ok(sawCut);
  // trust computed for sample n uses the tracker state from sample n-1: verify the documented rule sample by sample
  for (let i = 1; i < trace.length; i += 1) {
    const before = trace[i - 1];
    const recentlyCut = trace.slice(0, i).some((p) => p.cutting && trace[i].t - p.t < 200);
    if (before.cutting || recentlyCut) assert.equal(trace[i].trust, 0, `trust must be 0 at t=${trace[i].t}`);
  }
  const end = trace[trace.length - 1];
  assert.ok(end.trust > 0.9, `trust at rest after the swing: ${end.trust}`);
  const during = trace.filter((p) => p.cutting);
  assert.ok(during.every((p) => p.trust === 0));
});

test('pipeline fusion: yaw is bounded by the bias only (return to the start pose after 20 s of large motions)', (t) => {
  // 16 alternating large moves inside the playfield (yaw +-32, pitch +-17, roll up to +-90, every 4th move only 250 ms long),
  // then back to the start pose. The error is the integration error of the sampled gyro plus noise; no bias error here.
  // With the alternative gyro scale (0.0075 dps/LSB) the int16 field would clip at about 245 true dps, so that variant uses
  // slow moves only (2.4 s each, peak below 120 true dps); fast swings could not be measured at all on such a device.
  const bigMoves = (opts, slow = false) => {
    const { synth, pipe, rec } = nominalPipeline(opts, { settings: { autoCenter: false } });
    const keys = [{ t: 0, yaw: 0, pitch: 0 }, { t: 500, yaw: 0, pitch: 0 }];
    let time = 500;
    for (let i = 0; i < 16; i += 1) {
      time += slow ? 2400 : i % 4 === 3 ? 250 : 1200;
      keys.push({ t: time, yaw: (i % 2 ? -1 : 1) * 32, pitch: ((i >> 1) % 2 ? -1 : 1) * 17, roll: (i % 3 - 1) * 90 });
    }
    time += 1500;
    keys.push({ t: time, yaw: 0, pitch: 0, roll: 0 });
    time += 2000;
    keys.push({ t: time, yaw: 0, pitch: 0, roll: 0 });
    feed(pipe, synth.generate(keyframes(keys), time));
    const b = rec.blades[rec.blades.length - 1];
    return { off: Math.hypot(b.x - 960, b.y - 540), seconds: time / 1000 };
  };
  for (const variant of [{}, { mirror: true }, { gyroScaleTrue: 'alt' }, { mount: 'upsideDown', side: 'L' }]) {
    const { off, seconds } = bigMoves({ mount: 'tilted', hz: 66, seed: 41, ...variant }, variant.gyroScaleTrue === 'alt');
    t.diagnostic(`66 Hz ${JSON.stringify(variant)}: ${seconds.toFixed(0)} s of large motion, back at start: offset ${off.toFixed(1)} px (${(off / 27.4).toFixed(2)} deg)`);
    assert.ok(off < 27.4, `66 Hz offset ${off} px (limit 1 degree)`);
  }
  const at250 = bigMoves({ mount: 'tilted', hz: 250, seed: 41 });
  const at33 = bigMoves({ mount: 'tilted', hz: 33, seed: 41 });
  t.diagnostic(`250 Hz offset ${at250.off.toFixed(1)} px, 33 Hz offset ${at33.off.toFixed(1)} px`);
  assert.ok(at250.off < 13.7, `250 Hz offset ${at250.off}`);
  assert.ok(at33.off < 54.8, `33 Hz offset ${at33.off} px (limit 2 degrees)`);
});

test('pipeline fusion: gyro sign mirror and alternative scale are honoured (a 10 deg yaw stays 10 deg)', () => {
  for (const variant of [{ mirror: true }, { gyroScaleTrue: 'alt' }, { mirror: true, gyroScaleTrue: 'alt', mount: 'faceSide' }]) {
    const { synth, pipe, rec } = nominalPipeline({ mount: 'faceUp', hz: 66, seed: 51, ...variant }, { settings: { autoCenter: false } });
    feed(pipe, synth.generate(keyframes([{ t: 0, yaw: 0, pitch: 0 }, { t: 400, yaw: 0, pitch: 0 }, { t: 900, yaw: 10, pitch: 0 }, { t: 1300, yaw: 10, pitch: 0 }]), 1300));
    const b = rec.blades[rec.blades.length - 1];
    assert.ok(Math.abs(b.x - (960 + 274)) < 6, `${JSON.stringify(variant)}: x ${b.x}`);
  }
});

test('pipeline fusion: an uncalibrated pipeline filters but emits no blade samples', () => {
  const synth = createSynth({ mount: 'faceUp', hz: 66, seed: 61 });
  const pipe = createAbsolutePipeline();
  const rec = record(pipe);
  feed(pipe, synth.generate(holdPose(0, 0, 0), 500));
  assert.equal(rec.blades.length, 0);
  const st = pipe.getState();
  assert.equal(st.calibrated, false);
  assert.equal(st.trackingOk, false);
  assert.equal(st.yawDeg, null);
  assert.equal(pipe.latest(), null);
  assert.deepEqual(pipe.drainSegments(), []);
  assert.deepEqual(pipe.recent(1000), []);
  assert.equal(pipe.headAt(1000), null);
  assert.ok(MOUNTS.faceUp);
});
