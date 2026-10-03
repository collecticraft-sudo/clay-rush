import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { TransitionIntegrator, estimateGyroModel, frameFromPoses } from '../../public/js/motion/calibration.js';
import { MOTION_CONFIG } from '../../public/js/motion/motion-config.js';
import { qFromAxisAngle } from '../../public/js/motion/quat.js';
import { vAngleDeg, vNormalize } from '../../public/js/motion/vec.js';
import { assertValid } from '../../public/js/shared/validate.js';
import { createManualClock } from '../../public/js/shared/clock.js';
import { createSynth, keyframes, holdPose, calibrationScript, MOUNTS, MOUNT_NAMES, ALT_SCALE } from '../../test-support/motion/synth.js';
import { angleDeg, feed, play, record, runCalibration, calibratedPipeline, createAbsolutePipeline } from '../../test-support/motion/harness.js';
import { validateCalibration } from '../../public/js/shared/validate.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const RAD = Math.PI / 180;
const near = (a, b, tol, msg = '') => assert.ok(Math.abs(a - b) <= tol, `${msg} expected ${b} +-${tol}, got ${a}`);
const assertValidCal = (c) => validateCalibration(c);
/** calibratedPipeline() for a pipeline that the caller built (and tampered with). */
function calibratedPipelineWith(pipe, synthOpts) {
  const r = runCalibration(synthOpts, { pipe });
  if (!r.done) throw new Error(`calibration did not finish: ${JSON.stringify(r.rec.calibration.filter((e) => e.type !== 'progress').slice(-4))}`);
  return r;
}
const types = (rec) => rec.calibration.filter((e) => e.type !== 'progress').map((e) => e.type + (e.step ? `${e.step}` : '') + (e.reason ? `:${e.reason}` : ''));

// ---------------------------------------------------------------------------------------------------------- acceptance matrix

test('calibration acceptance: 6 mounts x 3 rates x mirrored/normal gyro x default/alternative scale x both sides', (t) => {
  let n = 0;
  let maxForward = 0;
  let maxUp = 0;
  let maxRight = 0;
  let maxScaleErr = 0;
  let maxBiasErr = 0;
  for (const mount of MOUNT_NAMES) {
    for (const hz of [33, 66, 250]) {
      for (const mirror of [false, true]) {
        for (const alt of [false, true]) {
          n += 1;
          const side = n % 2 ? 'L' : 'R';
          const opts = { mount, hz, mirror, side, gyroScaleTrue: alt ? 'alt' : 'default', seed: 100 + n };
          const r = runCalibration(opts);
          const label = JSON.stringify(opts);
          assert.ok(r.done, `${label}: calibration did not finish: ${types(r.rec).join(',')}`);
          assert.deepEqual(types(r.rec), ['started', 'stepPassed1', 'stepPassed2', 'stepPassed3', 'done'], label);
          const c = r.cal;
          const truth = MOUNTS[mount];
          const ef = angleDeg(c.frame.forward, truth.forward);
          const eu = angleDeg(c.frame.up, truth.up);
          const er = angleDeg(c.frame.right, truth.right);
          maxForward = Math.max(maxForward, ef);
          maxUp = Math.max(maxUp, eu);
          maxRight = Math.max(maxRight, er);
          assert.ok(ef < 3 && eu < 3 && er < 3, `${label}: frame errors ${ef.toFixed(2)} ${eu.toFixed(2)} ${er.toFixed(2)} deg`);
          assert.equal(c.gyroSign, mirror ? -1 : 1, `${label}: gyroSign`);
          const trueScale = alt ? ALT_SCALE : 1;
          const se = Math.abs(c.gyroScale / trueScale - 1);
          maxScaleErr = Math.max(maxScaleErr, se);
          assert.ok(se < 0.05, `${label}: gyroScale ${c.gyroScale} vs ${trueScale}`);
          assert.equal(c.gyroScaleSource, 'estimated', label);
          assert.equal(c.side, side, label);
          const be = Math.hypot(c.gyroBiasDps.x - r.synth.biasParsed.x, c.gyroBiasDps.y - r.synth.biasParsed.y, c.gyroBiasDps.z - r.synth.biasParsed.z);
          maxBiasErr = Math.max(maxBiasErr, be * (alt ? ALT_SCALE : 1));
          assert.ok(be * (alt ? ALT_SCALE : 1) < 0.15, `${label}: bias error ${be} parsed dps`);
          assert.equal(c.quality.warnings.includes('gyro_sign_flipped'), mirror, `${label}: warnings ${c.quality.warnings}`);
          assert.ok(!c.quality.warnings.includes('gyro_scale_suspect') && !c.quality.warnings.includes('gyro sign undetermined'), label);
          assert.ok(Math.abs(c.quality.poseAngleDeg - 90) < 1, label);
          assert.equal(r.rec.warning.some((w) => w.code === 'gyro_sign_flipped'), mirror, `${label}: sign warning event`);
          assert.ok(c.createdAt > 1.6e12, 'createdAt is wall-clock ms');
          // and the calibrated pipeline reports itself calibrated at the centre
          const st = r.pipe.getState();
          assert.equal(st.calibrated, true);
          assert.equal(st.calibrationStep, null);
        }
      }
    }
  }
  t.diagnostic(`${n} runs: max frame error forward ${maxForward.toFixed(3)} deg, up ${maxUp.toFixed(3)} deg, right ${maxRight.toFixed(3)} deg; max gyroScale error ${(maxScaleErr * 100).toFixed(3)} % (snapped to candidate); max bias error ${maxBiasErr.toFixed(3)} true dps`);
});

test('calibration: an imprecise pose 1 (tip up 8 deg off vertical) still gives a frame within 10 deg and a working aim', (t) => {
  const synth = createSynth({ mount: 'tilted', hz: 66, seed: 9 });
  const pipe = createAbsolutePipeline();
  const rec = record(pipe);
  pipe.startCalibration();
  const pose = keyframes([
    { t: 0, yaw: 0, pitch: 82 }, // 8 deg short of vertical
    { t: 2600, yaw: 0, pitch: 82 },
    { t: 3800, yaw: 0, pitch: 4 }, // 4 deg above horizontal
    { t: 9000, yaw: 0, pitch: 4 },
  ]);
  feed(pipe, synth.generate(pose, 9000));
  const done = rec.calibration.find((e) => e.type === 'done');
  assert.ok(done, types(rec).join(','));
  const c = done.calibration;
  const truth = MOUNTS.tilted;
  const ef = angleDeg(c.frame.forward, truth.forward);
  t.diagnostic(`imprecise poses: forward error ${ef.toFixed(2)} deg, pose angle ${c.quality.poseAngleDeg.toFixed(1)} deg`);
  assert.ok(ef < 10);
  // +10 deg yaw after centring still maps to about +274 px
  const b0 = rec.blades[rec.blades.length - 1];
  feed(pipe, synth.generate(keyframes([{ t: 9000, yaw: 0, pitch: 4 }, { t: 9500, yaw: 10, pitch: 4 }, { t: 9900, yaw: 10, pitch: 4 }]), 9900));
  const b1 = rec.blades[rec.blades.length - 1];
  assert.ok(Math.abs(b1.x - b0.x - 274) < 15, `moved ${b1.x - b0.x}`);
});

// ---------------------------------------------------------------------------------------------------------- failure reasons

test('calibration failure: moving during a hold announces stepFailed moved (once per second) and the hold restarts', () => {
  const synth = createSynth({ mount: 'faceUp', hz: 66, seed: 1 });
  const pipe = createAbsolutePipeline();
  const rec = record(pipe);
  pipe.startCalibration();
  const pose = keyframes([
    { t: 0, yaw: 0, pitch: 90 },
    { t: 1200, yaw: 0, pitch: 90 },
    { t: 1300, yaw: 25, pitch: 90 }, // a jerk after 1.2 s of stillness
    { t: 1350, yaw: 25, pitch: 90 },
  ]);
  feed(pipe, synth.generate(pose, 1350));
  const fails = rec.calibration.filter((e) => e.type === 'stepFailed');
  assert.equal(fails.length, 1);
  assert.equal(fails[0].step, 1);
  assert.equal(fails[0].reason, 'moved');
  assert.equal(rec.calibration.some((e) => e.type === 'stepPassed'), false);
  // keeps failing at most once per second while it is shaken, then passes 2 s after it stops
  const shake = keyframes([{ t: 1350, yaw: 25, pitch: 90 }].concat(Array.from({ length: 40 }, (_, i) => ({ t: 1350 + (i + 1) * 60, yaw: 25 + (i % 2 ? 30 : -30), pitch: 90 }))));
  feed(pipe, synth.generate(shake, 1350 + 40 * 60));
  const failsAfterShake = rec.calibration.filter((e) => e.type === 'stepFailed');
  for (let i = 1; i < failsAfterShake.length; i += 1) assert.ok(failsAfterShake[i].t - failsAfterShake[i - 1].t >= 1000 - 1e-6, 'rate limited');
  feed(pipe, synth.generate(holdPose(25, 90, 0), 1350 + 40 * 60 + 2600));
  assert.ok(rec.calibration.some((e) => e.type === 'stepPassed' && e.step === 1), 'passes once still for 2 s');
});

test('calibration: continuous motion without any stillness never announces a failure, only waiting progress', () => {
  const synth = createSynth({ mount: 'faceUp', hz: 66, seed: 2 });
  const pipe = createAbsolutePipeline();
  const rec = record(pipe);
  pipe.startCalibration();
  const keys = Array.from({ length: 30 }, (_, i) => ({ t: i * 200, yaw: (i % 2) * 40, pitch: 90 }));
  feed(pipe, synth.generate(keyframes(keys), 5800));
  assert.equal(rec.calibration.filter((e) => e.type === 'stepFailed').length, 0);
  const prog = rec.calibration.filter((e) => e.type === 'progress');
  assert.ok(prog.length > 20);
  assert.ok(prog.every((p) => p.step === 1 && p.progress < 0.2), 'brief pauses between moves never build a hold');
});

test('calibration failure: poses only 30 deg apart -> bad_pose, back to step 1; a long rest at pose 1 is NOT bad_pose', () => {
  const synth = createSynth({ mount: 'tilted', hz: 66, seed: 3 });
  const pipe = createAbsolutePipeline();
  const rec = record(pipe);
  pipe.startCalibration();
  const pose = keyframes([
    { t: 0, yaw: 0, pitch: 90 },
    { t: 6000, yaw: 0, pitch: 90 }, // rests at pose 1 far longer than step 2 needs
    { t: 7000, yaw: 0, pitch: 60 }, // only 30 deg away
    { t: 10000, yaw: 0, pitch: 60 },
  ]);
  feed(pipe, synth.generate(pose, 10000));
  const ev = types(rec);
  assert.deepEqual(ev.slice(0, 3), ['started', 'stepPassed1', 'stepFailed2:bad_pose'], ev.join(','));
  const fail = rec.calibration.find((e) => e.type === 'stepFailed');
  assert.ok(fail.t > 1000 + 6000, 'no bad_pose while still resting at pose 1');
  // afterwards the wizard is back at step 1. The sword is still in the pose that failed: that stillness must NOT pass as
  // "pose 1" (it would capture the wrong gravity direction), so step 1 waits for a tilt of at least 15 deg first
  const after = rec.calibration.filter((e) => e.type === 'progress' && e.t > fail.t);
  assert.ok(after.length > 0 && after[0].step === 1);
  assert.ok(after.every((p) => p.step === 1 && p.progress === 0), 'no hold builds at the failed pose');
  assert.equal(rec.calibration.filter((e) => e.type === 'stepPassed').length, 1, 'step 1 passed only once (before the failure)');
  assert.equal(pipe.getState().calibrationStep, 1);
  assert.equal(rec.calibration.some((e) => e.type === 'done'), false);
  // moving to a proper tip-up pose and holding it passes step 1 again, and the wizard can finish
  const t0 = synth.devMs;
  feed(pipe, synth.generate(keyframes([{ t: t0, yaw: 0, pitch: 60 }, { t: t0 + 600, yaw: 0, pitch: 90 }, { t: t0 + 3200, yaw: 0, pitch: 90 }, { t: t0 + 4400, yaw: 0, pitch: 0 }, { t: t0 + 9800, yaw: 0, pitch: 0 }]), t0 + 9800));
  assert.ok(rec.calibration.some((e) => e.type === 'done'), types(rec).join(','));
  const done = rec.calibration.find((e) => e.type === 'done').calibration;
  assert.ok(angleDeg(done.frame.forward, MOUNTS.tilted.forward) < 1, 'the frame comes from the second, proper attempt');
});

test('calibration failure: bad_accel when |a| stays off 1 g while the sword is still', () => {
  const pipe = createAbsolutePipeline();
  const rec = record(pipe, { validate: false });
  pipe.startCalibration();
  const samples = [];
  for (let i = 0; i < 66 * 4; i += 1) {
    samples.push({ seq: i, t: 1000 + i * 15, arrivedAt: 1004 + i * 15, dtMs: i ? 15 : null, dtSource: 'synthetic', accel: { x: 0, y: 0, z: 1.3 }, gyro: { x: 0.2, y: -0.1, z: 0.1 }, side: 'R', buttons: [], batteryMv: 3700, tempC: 25, imuActive: true });
  }
  feed(pipe, samples, { validate: false });
  const fails = rec.calibration.filter((e) => e.type === 'stepFailed');
  assert.ok(fails.length >= 1 && fails.length <= 3, `fails ${fails.length}`);
  assert.ok(fails.every((f) => f.reason === 'bad_accel' && f.step === 1));
  const prog = rec.calibration.filter((e) => e.type === 'progress');
  assert.ok(Math.abs(prog[prog.length - 1].accelMagG - 1.3) < 1e-9, 'progress reports |a|');
});

test('calibration failure: no_data after a second without samples (via poll), rate limited; timeout after the wait limit', () => {
  const clock = createManualClock(0);
  const pipe = createAbsolutePipeline({ clock, config: { calibration: { waitTimeoutS: 8 } } });
  const rec = record(pipe);
  clock.set(1000);
  pipe.startCalibration();
  const synth = createSynth({ mount: 'faceUp', hz: 66, seed: 4 });
  const samples = synth.generate(holdPose(0, 90, 0), 500);
  feed(pipe, samples.slice(0, 20));
  const lastT = samples[19].t;
  pipe.poll(lastT + 900);
  assert.equal(rec.calibration.filter((e) => e.reason === 'no_data').length, 0);
  pipe.poll(lastT + 1100);
  assert.equal(rec.calibration.filter((e) => e.reason === 'no_data').length, 1);
  pipe.poll(lastT + 1900);
  assert.equal(rec.calibration.filter((e) => e.reason === 'no_data').length, 1, 'rate limited to once per second');
  pipe.poll(lastT + 2200);
  assert.equal(rec.calibration.filter((e) => e.reason === 'no_data').length, 2);
  // timeout: 8 s after the step started (t = 1000)
  pipe.poll(1000 + 8500);
  const to = rec.calibration.filter((e) => e.reason === 'timeout');
  assert.equal(to.length, 1);
  assert.equal(to[0].step, 1);
});

test('calibration without a clock: the time origin comes from the first sample or poll (a real-clock poll never times the step out at once)', () => {
  const pipe = createAbsolutePipeline(); // no clock option
  const rec = record(pipe);
  pipe.startCalibration();
  pipe.poll(5_000_000_000); // a real clock long after page load
  assert.equal(rec.calibration.filter((e) => e.type === 'stepFailed').length, 0, 'no instant timeout or no_data');
  pipe.poll(5_000_000_000 + 1100);
  assert.deepEqual(rec.calibration.filter((e) => e.type === 'stepFailed').map((e) => e.reason), ['no_data']);
  // and with samples on that time base the wizard runs normally
  const synth = createSynth({ mount: 'faceUp', hz: 66, seed: 17, startMs: 5_000_000_000 + 2000 });
  feed(pipe, synth.generate(holdPose(0, 90, 0), 3000));
  assert.ok(rec.calibration.some((e) => e.type === 'stepPassed' && e.step === 1));
});

test('calibration failure: step 2 timeout goes back to step 1 (pose 1 is needed again)', () => {
  const pipe = createAbsolutePipeline({ config: { calibration: { waitTimeoutS: 6 } } });
  const rec = record(pipe);
  pipe.startCalibration();
  const synth = createSynth({ mount: 'faceUp', hz: 66, seed: 5 });
  const keys = [{ t: 0, yaw: 0, pitch: 90 }, { t: 2600, yaw: 0, pitch: 90 }];
  for (let i = 1; i <= 40; i += 1) keys.push({ t: 2600 + i * 150, yaw: (i % 2) * 40, pitch: 60 + (i % 2) * 30 }); // keeps moving in step 2
  feed(pipe, synth.generate(keyframes(keys), 2600 + 6 * 1000 + 2500));
  const ev = types(rec);
  assert.ok(ev.includes('stepPassed1'));
  assert.ok(ev.includes('stepFailed2:timeout'), ev.join(','));
  const fail = rec.calibration.find((e) => e.reason === 'timeout');
  const after = rec.calibration.filter((e) => e.type === 'progress' && e.t > fail.t);
  assert.equal(after[0].step, 1);
});

// ---------------------------------------------------------------------------------------------------------- lifecycle

test('calibration lifecycle: restart, cancel, events are contract shaped, progress runs at about 10 per second', () => {
  const pipe = createAbsolutePipeline();
  const rec = record(pipe);
  assert.equal(pipe.getState().calibrationStep, null);
  pipe.cancelCalibration();
  assert.equal(rec.calibration.length, 0, 'cancel with nothing running is silent');
  pipe.startCalibration();
  assert.equal(pipe.getState().calibrationStep, 1);
  const synth = createSynth({ mount: 'faceUp', hz: 66, seed: 6 });
  const samples = synth.generate(holdPose(0, 90, 0), 1500);
  feed(pipe, samples);
  const prog1 = rec.calibration.filter((e) => e.type === 'progress');
  const spanS = (prog1[prog1.length - 1].t - prog1[0].t) / 1000;
  const rate = (prog1.length - 1) / spanS;
  assert.ok(rate > 8 && rate < 12, `progress rate ${rate}`);
  const last = prog1[prog1.length - 1];
  assert.equal(last.phase, 'holding');
  assert.ok(last.progress > 0.5 && last.progress < 1);
  assert.ok(last.meanDps < 6 && last.peakDps < 15 && Math.abs(last.accelMagG - 1) < 0.05);
  // restarting emits started again and resets the ring
  pipe.startCalibration();
  assert.equal(rec.calibration.filter((e) => e.type === 'started').length, 2);
  feed(pipe, synth.generate(holdPose(0, 90, 0), 1600));
  const afterRestart = rec.calibration.filter((e) => e.type === 'progress').pop();
  assert.ok(afterRestart.progress < 0.3);
  pipe.cancelCalibration();
  assert.equal(rec.calibration[rec.calibration.length - 1].type, 'cancelled');
  assert.equal(pipe.getState().calibrationStep, null);
  assert.equal(pipe.getState().calibrated, false);
  // nothing else is emitted after a cancel
  const n = rec.calibration.length;
  feed(pipe, synth.generate(holdPose(0, 90, 0), 3000));
  assert.equal(rec.calibration.length, n);
});

test('calibration step 3: confirmCenter finishes at once, stillness finishes after 3 s, motion does not', () => {
  // (a) confirmCenter as soon as step 3 begins
  const a = runCalibration({ mount: 'faceUp', hz: 66, seed: 7 }, { script: { centreMs: 100 } });
  assert.equal(a.done, null, 'not finished by stillness yet');
  assert.equal(a.pipe.getState().calibrationStep, 3);
  a.pipe.confirmCenter();
  const done = a.rec.calibration.find((e) => e.type === 'done');
  assert.ok(done && done.quick === false);
  assert.deepEqual(types(a.rec).slice(-2), ['stepPassed3', 'done']);
  const rc = a.rec.recenter.find((e) => e.kind === 'calibration');
  assert.ok(rc, 'recenter event with kind calibration');
  assert.equal(a.pipe.getState().calibrationStep, null);
  a.pipe.confirmCenter(); // no effect when nothing runs
  assert.equal(a.rec.calibration.filter((e) => e.type === 'done').length, 1);

  // (b) hold still: finishes 3.0 s after step 3 began (holding, not later)
  const b = runCalibration({ mount: 'faceUp', hz: 66, seed: 7 });
  const passed2 = b.rec.calibration.find((e) => e.type === 'stepPassed' && e.step === 2);
  const doneB = b.rec.calibration.find((e) => e.type === 'done');
  assert.ok(doneB.t - passed2.t >= 2900 && doneB.t - passed2.t < 3300, `step 3 took ${doneB.t - passed2.t} ms`);

  // (c) a sword that keeps moving in step 3 does not finish by itself
  const synth = createSynth({ mount: 'faceUp', hz: 66, seed: 8 });
  const pipe = createAbsolutePipeline();
  const rec = record(pipe);
  pipe.startCalibration();
  const sc = calibrationScript({ centreMs: 200 });
  feed(pipe, synth.generate(sc.pose, sc.totalMs));
  const wag = keyframes(Array.from({ length: 40 }, (_, i) => ({ t: sc.totalMs + i * 250, yaw: (i % 2) * 12, pitch: 0 })));
  feed(pipe, synth.generate(wag, sc.totalMs + 9000));
  assert.equal(rec.calibration.some((e) => e.type === 'done'), false);
  assert.equal(pipe.getState().calibrationStep, 3);
});

test('calibration: a full recalibration suppresses blade samples until done; cancel restores the previous calibration', () => {
  const r = calibratedPipeline({ mount: 'faceUp', hz: 66, seed: 10 });
  assert.equal(r.pipe.getState().calibrated, true);
  const before = r.rec.blades.length;
  const cal1 = r.pipe.getCalibration();
  r.pipe.startCalibration();
  assert.equal(r.pipe.getState().calibrated, false, 'blocked while the full wizard runs');
  feed(r.pipe, r.synth.generate(holdPose(0, 90, 0), r.synth.devMs + 1500));
  assert.equal(r.rec.blades.length, before, 'no blade samples during the full wizard');
  r.pipe.cancelCalibration();
  assert.equal(r.pipe.getState().calibrated, true, 'cancel restores the old calibration');
  assert.deepEqual(r.pipe.getCalibration().frame, cal1.frame);
  feed(r.pipe, r.synth.generate(holdPose(0, 0, 0), r.synth.devMs + 500));
  assert.ok(r.rec.blades.length > before);
});

test('calibration quick recenter: needs a calibration, keeps the frame, finishes after 1.5 s of stillness or confirmCenter', () => {
  // without calibration
  const bare = createAbsolutePipeline();
  const recBare = record(bare);
  bare.beginQuickRecenter();
  assert.deepEqual(recBare.calibration.map((e) => `${e.type}:${e.step}:${e.reason}`), ['stepFailed:3:no_calibration']);

  const r = calibratedPipeline({ mount: 'tilted', hz: 66, seed: 12 });
  const frame = JSON.parse(JSON.stringify(r.pipe.getCalibration().frame));
  const mark = r.rec.calibration.length;
  // the user has drifted: turn 6 deg away, then start the quick recentre and hold still there
  feed(r.pipe, r.synth.generate(keyframes([{ t: r.synth.devMs, yaw: 0, pitch: 0 }, { t: r.synth.devMs + 400, yaw: 6, pitch: 0 }, { t: r.synth.devMs + 5000, yaw: 6, pitch: 0 }]), r.synth.devMs + 500));
  const offBefore = r.rec.blades[r.rec.blades.length - 1].x - 960;
  assert.ok(offBefore > 120, `cursor is off centre: ${offBefore}`);
  r.pipe.beginQuickRecenter();
  const started = r.rec.calibration[mark];
  assert.deepEqual([started.type, started.quick], ['started', true]);
  assert.equal(r.pipe.getState().calibrationStep, 3);
  assert.equal(r.pipe.getState().calibrated, true, 'the blade keeps flowing during a quick recentre');
  const t0 = r.synth.nowMs;
  feed(r.pipe, r.synth.generate(holdPose(6, 0, 0), r.synth.devMs + 1700));
  const done = r.rec.calibration.find((e) => e.type === 'done' && e.quick);
  assert.ok(done, types(r.rec).join(','));
  assert.ok(done.t - t0 >= 1400 && done.t - t0 < 1800, `quick recentre took ${done.t - t0} ms`);
  assert.deepEqual(done.calibration.frame, frame, 'frame unchanged');
  const b = r.rec.blades[r.rec.blades.length - 1];
  assert.ok(Math.abs(b.x - 960) < 5 && Math.abs(b.y - 540) < 5, `re-centred: ${b.x},${b.y}`);
  assert.ok(r.rec.recenter.some((e) => e.kind === 'calibration'));

  // confirmCenter completes a quick recentre immediately
  r.pipe.beginQuickRecenter();
  feed(r.pipe, r.synth.generate(holdPose(6, 0, 0), r.synth.devMs + 200));
  r.pipe.confirmCenter();
  assert.equal(r.rec.calibration.filter((e) => e.type === 'done' && e.quick).length, 2);
});

test('calibration: gyroScaleOverride wins (source stored); a disagreeing override raises gyro_scale_suspect', () => {
  const alt = runCalibration({ mount: 'faceUp', hz: 66, gyroScaleTrue: 'alt', seed: 14 }, { pipeOpts: { gyroScaleOverride: ALT_SCALE } });
  assert.equal(alt.cal.gyroScale, ALT_SCALE);
  assert.equal(alt.cal.gyroScaleSource, 'stored');
  assert.ok(!alt.cal.quality.warnings.includes('gyro_scale_suspect'));
  const wrong = runCalibration({ mount: 'faceUp', hz: 66, seed: 15 }, { pipeOpts: { gyroScaleOverride: ALT_SCALE } });
  assert.equal(wrong.cal.gyroScale, ALT_SCALE);
  assert.ok(wrong.cal.quality.warnings.includes('gyro_scale_suspect'));
  assert.ok(wrong.rec.warning.some((w) => w.code === 'gyro_scale_suspect'));
  const ignoredBad = createAbsolutePipeline({ gyroScaleOverride: -1 });
  assert.equal(ignoredBad.getDebug().gyroScale, 1, 'an invalid override is ignored');
});

test('calibration: a gyro scale that matches no candidate is used as measured with a gyro_scale_suspect warning', () => {
  // Build a device whose parsed gyro is 1.6x too small: true = parsed * 1.6 (scale 1.6, between the two candidates? no: above 1).
  // The synth only knows 1 and 0.12288, so scale the gyro of a default run by 0.5 after generation (true scale 2.0 hits the range edge)
  // and by 1/0.45 (true scale 0.45).
  for (const factor of [1 / 0.45, 1 / 0.3]) {
    const synth = createSynth({ mount: 'faceUp', hz: 66, seed: 16 });
    const sc = calibrationScript();
    const samples = synth.generate(sc.pose, sc.totalMs).map((s) => ({ ...s, gyro: { x: s.gyro.x * factor, y: s.gyro.y * factor, z: s.gyro.z * factor } }));
    const pipe = createAbsolutePipeline();
    const rec = record(pipe);
    pipe.startCalibration();
    feed(pipe, samples);
    const done = rec.calibration.find((e) => e.type === 'done');
    assert.ok(done, types(rec).join(','));
    const expected = 1 / factor;
    assert.ok(Math.abs(done.calibration.gyroScale / expected - 1) < 0.05, `scale ${done.calibration.gyroScale} vs ${expected}`);
    assert.equal(done.calibration.gyroScaleSource, 'estimated');
    assert.ok(done.calibration.quality.warnings.includes('gyro_scale_suspect'));
  }
});

// ---------------------------------------------------------------------------------------------------------- pure functions

test('frameFromPoses: orthonormal, right-handed, exact for perpendicular poses and corrected for imperfect ones', () => {
  const u1 = { x: 0, y: 1, z: 0 };
  const u2 = { x: 0, y: 0, z: 1 };
  const f = frameFromPoses(u1, u2);
  assert.deepEqual(f.forward, { x: 0, y: 1, z: 0 });
  assert.deepEqual(f.up, { x: 0, y: 0, z: 1 });
  assert.deepEqual(f.right, { x: 1, y: 0, z: 0 });
  // 100 deg apart: forward is u1 made perpendicular to u2, up = u2
  const u1b = vNormalize({ x: 0, y: Math.sin(100 * RAD), z: Math.cos(100 * RAD) });
  const f2 = frameFromPoses(u1b, u2);
  assert.ok(vAngleDeg(f2.forward, { x: 0, y: 1, z: 0 }) < 1e-9);
  assert.ok(vAngleDeg(f2.up, u2) < 1e-9);
  const cal = { version: 1, side: 'R', createdAt: 1, frame: f2, gyroBiasDps: { x: 0, y: 0, z: 0 }, gyroSign: 1, gyroScale: 1, gyroScaleSource: 'default', quality: { poseAngleDeg: 100, stillPeakDps: 0, warnings: [] } };
  assertValid('Calibration', cal);
});

test('estimateGyroModel: axis test, mirrored gyro, scale snapping, and the gravity-consistency tie-break', () => {
  const cfg = MOTION_CONFIG.calibration;
  const u1 = { x: 0, y: 0, z: 1 };
  const u2 = { x: 0, y: 1, z: 0 }; // device turned +90 deg about +x: gravity now along +y in device coordinates
  const q = (deg, ax = 1) => qFromAxisAngle(ax === 1 ? 1 : 0, 0, 0, deg * RAD);
  const hyps = (theta) => [
    { sign: 1, scale: 1, q: q(theta) },
    { sign: 1, scale: 0.12288, q: q(theta * 0.12288) },
    { sign: -1, scale: 1, q: q(-theta) },
    { sign: -1, scale: 0.12288, q: q(-theta * 0.12288) },
  ];
  const model = (theta, snapshotTheta, extra = {}) => estimateGyroModel({ u1, u2, snapshot: { theta: snapshotTheta, gapMs: 0, hyps: hyps(theta) }, override: null, cfg, ...extra });

  // normal gyro, exact scale
  let m = model(90, { x: 90, y: 0, z: 0 });
  assert.deepEqual([m.gyroSign, m.gyroScale, m.gyroScaleSource], [1, 1, 'estimated']);
  // mirrored gyro: the integrated vector points the opposite way
  m = model(90, { x: -90, y: 0, z: 0 });
  assert.equal(m.gyroSign, -1);
  assert.ok(m.warnings.includes('gyro_sign_flipped') && m.events.some((e) => e.code === 'gyro_sign_flipped'));
  // alternative scale: the parsed rotation is 8.138x larger
  m = model(90, { x: 90 / 0.12288, y: 0, z: 0 });
  assert.deepEqual([m.gyroSign, m.gyroScale, m.gyroScaleSource], [1, 0.12288, 'estimated']);
  // a scale between the candidates is used as measured, with a warning
  m = model(90, { x: 90 / 0.5, y: 0, z: 0 });
  assert.ok(Math.abs(m.gyroScale - 0.5) < 1e-9);
  assert.ok(m.warnings.includes('gyro_scale_suspect'));
  // out of range: default, still a warning
  m = model(90, { x: 90 / 0.01, y: 0, z: 0 });
  assert.equal(m.gyroScale, 1);
  assert.equal(m.gyroScaleSource, 'default');
  assert.ok(m.warnings.includes('gyro_scale_suspect'));
  // an override wins
  m = model(90, { x: 90, y: 0, z: 0 }, { override: 0.12288 });
  assert.deepEqual([m.gyroScale, m.gyroScaleSource], [0.12288, 'stored']);

  // ambiguous axis (the summed vector is orthogonal to the expected axis, e.g. a big yaw component): tie-break by gravity
  m = model(90, { x: 0, y: 90, z: 0 });
  assert.equal(m.gyroSign, 1, 'sign +1 hypothesis reproduces u2');
  assert.equal(m.gyroScale, 1);
  assert.ok(!m.warnings.includes('gyro sign undetermined'));
  const mirroredHyps = [
    { sign: 1, scale: 1, q: q(-90) },
    { sign: 1, scale: 0.12288, q: q(-90 * 0.12288) },
    { sign: -1, scale: 1, q: q(90) },
    { sign: -1, scale: 0.12288, q: q(90 * 0.12288) },
  ];
  m = estimateGyroModel({ u1, u2, snapshot: { theta: { x: 0, y: 90, z: 0 }, gapMs: 0, hyps: mirroredHyps }, override: null, cfg });
  assert.equal(m.gyroSign, -1);
  // alternative scale found by the tie-break
  const altHyps = [
    { sign: 1, scale: 1, q: q(90 / 0.12288 - 720 + 33) }, // the wrapped, meaningless full-scale integral
    { sign: 1, scale: 0.12288, q: q(90) },
    { sign: -1, scale: 1, q: q(-(90 / 0.12288) + 720 - 33) },
    { sign: -1, scale: 0.12288, q: q(-90) },
  ];
  m = estimateGyroModel({ u1, u2, snapshot: { theta: { x: 0, y: 700, z: 0 }, gapMs: 0, hyps: altHyps }, override: null, cfg });
  assert.deepEqual([m.gyroSign, m.gyroScale, m.gyroScaleSource], [1, 0.12288, 'estimated']);
  // nothing decisive: undetermined, sign stays +1
  const flat = [1, -1].flatMap((sign) => [1, 0.12288].map((scale) => ({ sign, scale, q: q(45) })));
  m = estimateGyroModel({ u1, u2, snapshot: { theta: { x: 0, y: 90, z: 0 }, gapMs: 0, hyps: flat }, override: null, cfg });
  assert.equal(m.gyroSign, 1);
  assert.ok(m.warnings.includes('gyro sign undetermined'));
  // a long data gap during the transition: integration is not trustworthy
  m = estimateGyroModel({ u1, u2, snapshot: { theta: { x: 90, y: 0, z: 0 }, gapMs: 400, hyps: hyps(90) }, override: null, cfg });
  assert.ok(m.warnings.includes('gyro sign undetermined'));
  assert.equal(m.gyroScaleSource, 'default');
});

// ------------------------------------------------------------------- round 2 finding M1: samples without a usable time step

/** A pipeline whose pushImu passes every sample through `transform` (the harness calls pipe.pushImu at feed time). */
function tamperedPipeline(transform) {
  const pipe = createAbsolutePipeline();
  const orig = pipe.pushImu;
  let n = 0;
  pipe.pushImu = (s) => orig(transform(s, ++n));
  return pipe;
}

test('M1: TransitionIntegrator charges a hole by its wall-clock distance, never a duplicate, a backwards stamp or a burst partner', () => {
  const g = { x: 60, y: 0, z: 0 }; // 60 dps about x
  const zero = { x: 0, y: 0, z: 0 };
  const scales = [1, 0.12288];
  const run = (steps) => {
    const it = new TransitionIntegrator(zero, scales, 40);
    let t = 1000;
    it.add(g, null, t); // the first sample has no predecessor
    for (const [dtMs, dist] of steps) {
      t += dist;
      it.add(g, dtMs, t);
    }
    return it.snapshot();
  };
  const clean = run(Array.from({ length: 60 }, () => [15, 15]));
  near(clean.theta.x, 60 * 0.015 * 60, 1e-9, 'clean: 60 steps of 15 ms');
  assert.equal(clean.gapMs, 0);
  // a report whose device step is unknown but that follows 15 ms behind the previous one is integrated over that distance
  const burst = run(Array.from({ length: 60 }, (_, i) => [i % 2 ? null : 15, 15]));
  near(burst.theta.x, clean.theta.x, 1e-9, 'unknown step, known distance: the same rotation as the clean stream');
  assert.equal(burst.gapMs, 0);
  // a duplicate stamp (distance 0) and a backwards stamp (clamped to distance 0) lose nothing and add nothing
  const dup = run(Array.from({ length: 60 }, (_, i) => (i % 3 === 2 ? [null, 0] : [15, 15])));
  assert.equal(dup.gapMs, 0, 'duplicates are not holes');
  near(dup.theta.x, 60 * 0.015 * 40, 1e-9, 'only the 40 real steps rotate');
  // a real hole is charged by its length, not by a fixed 200 ms
  const hole = run([[15, 15], [null, 120], [15, 15]]);
  assert.equal(hole.gapMs, 120);
  const two = run([[15, 15], [null, 190], [15, 15], [null, 190], [15, 15]]);
  assert.equal(two.gapMs, 380);
  const at = (mod, want) => assert.equal(estimateGyroModel({ u1: { x: 0, y: 0, z: 1 }, u2: { x: 1, y: 0, z: 0 }, snapshot: mod, override: null, cfg: MOTION_CONFIG.calibration }).warnings.includes('gyro sign undetermined'), want);
  at({ theta: { x: 0, y: -90, z: 0 }, gapMs: 290, hyps: [] }, false);
  at({ theta: { x: 0, y: -90, z: 0 }, gapMs: 310, hyps: [] }, true);
});

test('M1: one report in ten and one in two without a time step (regular arrival) still give the right gyro sign and scale, also mirrored and 8x', () => {
  for (const every of [10, 2]) {
    for (const [label, opts, sign, scale] of [
      ['default', {}, 1, 1],
      ['mirrored gyro', { mirror: true }, -1, 1],
      ['alternative scale', { gyroScaleTrue: 'alt' }, 1, 0.12288],
      ['mirrored and alternative scale', { mirror: true, gyroScaleTrue: 'alt' }, -1, 0.12288],
    ]) {
      const pipe = tamperedPipeline((s, n) => (n % every === 0 ? { ...s, dtMs: null } : s));
      const r = runCalibration({ mount: 'tilted', hz: 66, seed: 1700 + every, ...opts }, { pipe });
      const tag = `${label}, 1 in ${every}`;
      assert.ok(r.done, `${tag}: the wizard finished`);
      assert.ok(!r.cal.quality.warnings.includes('gyro sign undetermined'), `${tag}: warnings ${r.cal.quality.warnings} (the sign was thrown away before the fix)`);
      assert.equal(r.cal.gyroSign, sign, `${tag}: gyro sign`);
      assert.ok(Math.abs(r.cal.gyroScale / scale - 1) < 0.05, `${tag}: gyro scale ${r.cal.gyroScale}`);
      assert.equal(r.cal.gyroScaleSource, 'estimated', tag);
    }
  }
});

test('M1: duplicate device stamps (same time, no step) in one report in ten do not spoil the sign nor the scale', () => {
  for (const [label, opts, sign, scale] of [['default', {}, 1, 1], ['mirrored', { mirror: true }, -1, 1], ['alternative scale', { gyroScaleTrue: 'alt' }, 1, 0.12288]]) {
    let prevT = null;
    const pipe = tamperedPipeline((s, n) => {
      const out = n % 10 === 0 && prevT !== null ? { ...s, t: prevT, dtMs: null } : s;
      prevT = out.t;
      return out;
    });
    const r = runCalibration({ mount: 'faceSide', hz: 66, seed: 1710, ...opts }, { pipe });
    assert.ok(r.done, label);
    assert.ok(!r.cal.quality.warnings.includes('gyro sign undetermined'), `${label}: ${r.cal.quality.warnings}`);
    assert.equal(r.cal.gyroSign, sign, label);
    assert.ok(Math.abs(r.cal.gyroScale / scale - 1) < 0.15, `${label}: scale ${r.cal.gyroScale} (the lost steps are 10 % of the move)`);
  }
});

test('M1: genuine holes of 227 ms in the move are charged by their length: one is tolerated (300 ms budget), two are not and the wizard says so', () => {
  const hole = (from) => (k) => k >= from && k < from + 14; // 14 dropped reports at 66 Hz: a 227 ms silence
  const one = runCalibration({ mount: 'tilted', hz: 66, seed: 1720, mirror: true, dropWhen: hole(190) });
  assert.ok(one.done);
  assert.ok(!one.cal.quality.warnings.includes('gyro sign undetermined'), `one hole: ${one.cal.quality.warnings}`);
  assert.equal(one.cal.gyroSign, -1);
  const two = runCalibration({ mount: 'tilted', hz: 66, seed: 1720, mirror: true, dropWhen: (k) => hole(190)(k) || hole(215)(k) });
  assert.ok(two.done);
  assert.ok(two.cal.quality.warnings.includes('gyro sign undetermined'), `two holes: ${two.cal.quality.warnings}`);
  assert.equal(two.cal.gyroSign, 1, 'the default sign, flagged as undetermined');
});

// ------------------------------------------------------------------- round 2 finding M2: the resting |a| is learned, not assumed

const scaledAccel = (gain) => (s) => ({ ...s, accel: { x: s.accel.x * gain, y: s.accel.y * gain, z: s.accel.z * gain } });

test('M2: a sensor whose resting |a| is 0.94, 0.97, 1.00, 1.03, 1.06 or 1.14 g calibrates on every mount; g0 is learned and stored; warned outside 0.95 to 1.05', () => {
  for (const gain of [0.94, 0.97, 1.0, 1.03, 1.06, 1.14, 0.86]) {
    for (const mount of ['faceUp', 'tilted', 'sideRail']) {
      const pipe = tamperedPipeline(scaledAccel(gain));
      const r = runCalibration({ mount, hz: 66, seed: 1800 }, { pipe });
      const tag = `gain ${gain}, ${mount}`;
      assert.ok(r.done, `${tag}: the wizard finished (step 1 failed with bad_accel forever before the fix: ${types(r.rec).slice(-3)})`);
      assert.ok(Math.abs(r.cal.accelG0 - gain) < 0.01, `${tag}: g0 ${r.cal.accelG0}`);
      assert.ok(angleDeg(r.cal.frame.forward, MOUNTS[mount].forward) < 3, `${tag}: forward`);
      assert.equal(r.cal.quality.warnings.includes('accel_gain_off'), gain < 0.95 || gain > 1.05, `${tag}: warnings ${r.cal.quality.warnings}`);
      assert.equal(r.rec.warning.some((w) => w.code === 'accel_gain_off'), gain < 0.95 || gain > 1.05, `${tag}: motion warning`);
      assert.equal(r.pipe.getCalibration().accelG0, r.cal.accelG0);
    }
  }
});

test('M2: outside 0.85 to 1.15 g the sensor is still refused with bad_accel, and a moving hold (|a| not steady) fails too', () => {
  for (const gain of [0.8, 0.83, 1.18, 1.2]) {
    const pipe = tamperedPipeline(scaledAccel(gain));
    const r = runCalibration({ mount: 'faceUp', hz: 66, seed: 1801 }, { pipe });
    assert.equal(r.done, null, `gain ${gain}: no calibration`);
    assert.ok(r.rec.calibration.some((e) => e.type === 'stepFailed' && e.step === 1 && e.reason === 'bad_accel'), `gain ${gain}: bad_accel announced`);
  }
  // steady at 1.06 but a hold whose |a| jumps by 8 % in the middle is not still
  let n = 0;
  const pipe = tamperedPipeline((s) => (++n % 60 < 30 ? scaledAccel(1.0)(s) : scaledAccel(1.08)(s)));
  const r = runCalibration({ mount: 'faceUp', hz: 66, seed: 1802 }, { pipe });
  assert.ok(r.rec.calibration.some((e) => e.type === 'stepFailed' && e.reason === 'bad_accel'), 'an unsteady |a| breaks the hold');
});

test('M2: after the wizard the pipeline divides the accelerometer by g0: aiming is right, the gravity trust is not lost, the online gyro bias still learns', () => {
  for (const gain of [0.94, 1.06]) {
    const pipe = tamperedPipeline(scaledAccel(gain));
    const r = calibratedPipelineWith(pipe, { mount: 'tilted', hz: 66, seed: 1810 });
    r.pipe.setSettings({ autoCenter: false });
    play(r, [{ t: 0, yaw: 0, pitch: 0 }, { t: 700, yaw: 10, pitch: 5 }, { t: 2500, yaw: 10, pitch: 5 }]);
    const b = r.rec.blades[r.rec.blades.length - 1];
    near(b.x, 960 + 274, 20, `gain ${gain}: x`);
    near(b.y, 540 - 137, 20, `gain ${gain}: y`);
    assert.ok(r.pipe.getDebug().accelTrust > 0.9, `gain ${gain}: full gravity trust at rest (${r.pipe.getDebug().accelTrust})`);
    assert.ok(r.pipe.getDebug().biasUpdates > 0, `gain ${gain}: the online bias estimator runs`);
    // a quick re-centre uses the learned g0 too (step 3 only)
    const done0 = r.rec.calibration.filter((e) => e.type === 'done').length;
    r.pipe.beginQuickRecenter();
    feed(r.pipe, r.synth.generate(holdPose(10, 5, 0), r.synth.devMs + 2500));
    assert.equal(r.rec.calibration.filter((e) => e.type === 'done').length, done0 + 1, `gain ${gain}: quick re-centre finished`);
    assert.ok(!r.rec.calibration.some((e) => e.type === 'stepFailed' && e.reason === 'bad_accel'), `gain ${gain}: no bad_accel`);
  }
});

test('R3-n2: the learned g0 is already in use DURING step 3 (right after step 2 applied the wizard parameters), not only after the wizard', () => {
  for (const gain of [0.9, 1.08, 1.13]) {
    const pipe = tamperedPipeline(scaledAccel(gain));
    const seen = [];
    pipe.on('calibration', (e) => {
      if (e.type === 'progress' && e.step === 3) seen.push(pipe.getDebug().accelG0);
    });
    const r = runCalibration({ mount: 'faceUp', hz: 66, seed: 1830 }, { pipe });
    assert.ok(r.done, `gain ${gain}: finished`);
    assert.ok(seen.length > 0, `gain ${gain}: step 3 reported progress`);
    for (const g0 of seen) assert.ok(Math.abs(g0 - gain) < 0.01, `gain ${gain}: g0 during step 3 was ${g0}`);
    assert.ok(Math.abs(pipe.getDebug().accelG0 - gain) < 0.01, `gain ${gain}: and after it`);
  }
  assert.equal(tamperedPipeline((s) => s).getDebug().accelG0, 1, 'no wizard yet: 1');
});

test('M2: g0 travels with the Calibration: validated (0.5 to 2), optional, and setCalibration applies it', () => {
  const synth = createSynth({ mount: 'faceUp', hz: 66, seed: 1820 });
  const base = synth.nominalCalibration();
  assert.deepEqual(assertValidCal(base), []);
  assert.deepEqual(assertValidCal({ ...base, accelG0: 1.06 }), []);
  assert.equal(assertValidCal({ ...base, accelG0: 3 }).length, 1);
  assert.equal(assertValidCal({ ...base, accelG0: 'x' }).length, 1);
  // a pipeline with a stored g0 = 1.06 reads a 1.06 g sensor as 1 g: its filter trusts gravity fully
  const pipe = createAbsolutePipeline();
  const rec = record(pipe);
  pipe.setCalibration({ ...base, accelG0: 1.06 });
  const scaled = scaledAccel(1.06);
  feed(pipe, synth.generate(holdPose(0, 0, 0), 1500).map(scaled), { validate: false });
  assert.ok(pipe.getDebug().accelTrust > 0.9);
  assert.ok(rec.blades.length > 10);
  assert.equal(pipe.getCalibration().accelG0, 1.06);
});

// ---------------------------------------------------------------------------------------------------------- real captures

test('calibration with the real third-party captures V1 (Left) and V2 (Right): |a| about 1 g, still hold passes step 1', () => {
  const vectors = JSON.parse(readFileSync(join(HERE, '..', '..', 'docs', 'joycon2-test-vectors.json'), 'utf8')).vectors;
  const real = vectors.filter((v) => v.id.includes('real'));
  assert.equal(real.length, 2);
  for (const v of real) {
    const a = v.expected.accelG;
    const g = v.expected.gyroDps;
    const mag = Math.hypot(a.x, a.y, a.z);
    assert.ok(Math.abs(mag - 1) < 0.01, `${v.id}: |a| = ${mag}`);
    const pipe = createAbsolutePipeline();
    const rec = record(pipe);
    pipe.startCalibration({ side: v.side });
    const samples = [];
    for (let i = 0; i < 66 * 3; i += 1) {
      samples.push({ seq: i, t: 5000 + i * 15, arrivedAt: 5004 + i * 15, dtMs: i ? 15 : null, dtSource: 'synthetic', accel: { ...a }, gyro: { ...g }, side: v.side, buttons: [], batteryMv: v.expected.batteryMv, tempC: v.expected.temperatureC, imuActive: v.expected.imuActive });
    }
    feed(pipe, samples);
    const passed = rec.calibration.find((e) => e.type === 'stepPassed' && e.step === 1);
    assert.ok(passed, `${v.id}: step 1 should pass on a real still capture (${types(rec).join(',')})`);
    assert.ok(passed.t - 5000 >= 2000, 'after 2 s');
    // the real capture bias (raw -2, 4, 2 LSB etc.) becomes the wizard's gyro bias
    pipe.cancelCalibration();
  }
});
