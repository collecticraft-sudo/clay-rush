// Accelerometer sign (round 1 finding F3). The pipeline is written for a sensor that reports the specific force (+1 g towards UP
// at rest). Nothing in the third-party sources settles that for the Joy-Con 2, and the wizard cannot detect the opposite: its gyro
// sign test uses cross(u2, u1), which does not change when every accelerometer reading changes sign. So the sign is a parameter
// (`accelSign`, +1 default) that the diagnostics page measures and that ?accelsign=-1 or the saved diagnostics value applies.
// The synthetic sensor models both conventions; which one the physical Joy-Con uses stays UNVERIFIED-ON-HARDWARE.
import test from 'node:test';
import assert from 'node:assert/strict';
import { MOUNTS, MOUNT_NAMES, createSynth, holdPose } from '../../test-support/motion/synth.js';
import { angleDeg, calibratedPipeline, feed, lastBlade, play, record, runCalibration, createAbsolutePipeline } from '../../test-support/motion/harness.js';

const PPD = 27.4;
const near = (a, b, tol, msg = '') => assert.ok(Math.abs(a - b) <= tol, `${msg} expected ${b} +-${tol}, got ${a}`);

test('accelSign defaults to +1, accepts only -1 as the flip, and is reported by getDebug()', () => {
  assert.equal(createAbsolutePipeline().getDebug().accelSign, 1);
  assert.equal(createAbsolutePipeline({ accelSign: -1 }).getDebug().accelSign, -1);
  for (const junk of [0, 2, 'x', null, undefined, NaN, true]) assert.equal(createAbsolutePipeline({ accelSign: junk }).getDebug().accelSign, 1);
});

test('setAccelSign and setGyroScaleOverride (round 2 M3): per-provider sensor conventions, same effect as the constructor options, junk is ignored', () => {
  const p = createAbsolutePipeline();
  p.setAccelSign(-1);
  assert.equal(p.getDebug().accelSign, -1);
  for (const junk of [0, 2, 'x', null, undefined, NaN]) {
    p.setAccelSign(junk);
    assert.equal(p.getDebug().accelSign, 1, `junk ${String(junk)} means +1`);
  }
  // the scale override reaches the default parameters of a pipeline without calibration and the wizard
  p.setGyroScaleOverride(0.12288);
  assert.equal(p.getDebug().gyroScale, 0.12288);
  p.setGyroScaleOverride(null);
  assert.equal(p.getDebug().gyroScale, 1);
  p.setGyroScaleOverride(-3);
  assert.equal(p.getDebug().gyroScale, 1);
  // a pipeline switched to accelSign -1 behaves exactly like one created with it
  const a = runCalibration({ mount: 'tilted', hz: 66, seed: 1401, accelSign: -1 }, { pipeOpts: { accelSign: -1 } });
  const viaSetter = createAbsolutePipeline();
  viaSetter.setAccelSign(-1);
  const b = runCalibration({ mount: 'tilted', hz: 66, seed: 1401, accelSign: -1 }, { pipe: viaSetter });
  assert.deepEqual(b.cal.frame, a.cal.frame);
  // and the override set through the setter is the wizard's stored scale
  const alt = createAbsolutePipeline();
  alt.setGyroScaleOverride(0.12288);
  const c = runCalibration({ mount: 'faceUp', hz: 66, gyroScaleTrue: 'alt', seed: 14 }, { pipe: alt });
  assert.equal(c.cal.gyroScaleSource, 'stored');
  assert.equal(c.cal.gyroScale, 0.12288);
  // set and cleared again before the wizard: it estimates the scale itself
  const cleared = createAbsolutePipeline();
  cleared.setGyroScaleOverride(0.5);
  cleared.setGyroScaleOverride(null);
  const d = runCalibration({ mount: 'faceUp', hz: 66, gyroScaleTrue: 'alt', seed: 14 }, { pipe: cleared });
  assert.equal(d.cal.gyroScaleSource, 'estimated');
});

test('WITHOUT the parameter a gravity-vector sensor passes the wizard but the frame is turned round: forward and up point the wrong way (why the diagnostics check exists)', () => {
  for (const mount of MOUNT_NAMES) {
    const r = runCalibration({ mount, hz: 66, seed: 1400, accelSign: -1 });
    assert.ok(r.done, `${mount}: the wizard still finishes (it cannot see the problem)`);
    const truth = MOUNTS[mount];
    assert.ok(angleDeg(r.cal.frame.forward, truth.forward) > 170, `${mount}: forward points at the hilt, ${angleDeg(r.cal.frame.forward, truth.forward).toFixed(0)} deg off`);
    assert.ok(angleDeg(r.cal.frame.up, truth.up) > 170, `${mount}: up points down`);
    // the gyro sign self-test is blind to it: same verdict as with the normal sensor
    const normal = runCalibration({ mount, hz: 66, seed: 1400 });
    assert.equal(r.cal.gyroSign, normal.cal.gyroSign, `${mount}: gyro sign identical, cross(u2,u1) is invariant under a global accelerometer sign flip`);
  }
});

test('WITH accelSign -1 the same sensor calibrates to the true frame on every mount, both sides, mirrored gyro, both scales', () => {
  let n = 0;
  for (const mount of MOUNT_NAMES) {
    for (const [mirror, alt] of [[false, false], [true, false], [false, true], [true, true]]) {
      n += 1;
      const opts = { mount, hz: 66, side: n % 2 ? 'L' : 'R', mirror, gyroScaleTrue: alt ? 'alt' : 'default', seed: 1500 + n, accelSign: -1 };
      const r = runCalibration(opts, { pipeOpts: { accelSign: -1 } });
      const label = JSON.stringify(opts);
      assert.ok(r.done, `${label}: calibration finished`);
      const truth = MOUNTS[mount];
      assert.ok(angleDeg(r.cal.frame.forward, truth.forward) < 3, `${label}: forward ${angleDeg(r.cal.frame.forward, truth.forward).toFixed(2)} deg`);
      assert.ok(angleDeg(r.cal.frame.up, truth.up) < 3, `${label}: up`);
      assert.ok(angleDeg(r.cal.frame.right, truth.right) < 3, `${label}: right`);
      assert.equal(r.cal.gyroSign, mirror ? -1 : 1, `${label}: gyro sign`);
    }
  }
});

test('WITH accelSign -1 the aim mapping is right: a slow 20 degree sweep to the right moves the cursor 548 px right, and a fast swing cuts', () => {
  const r = calibratedPipeline({ mount: 'tilted', hz: 66, seed: 1600, accelSign: -1 }, { accelSign: -1 });
  r.pipe.setSettings({ autoCenter: false });
  play(r, [{ t: 0, yaw: 0, pitch: 0 }, { t: 2000, yaw: 20, pitch: 0 }, { t: 2600, yaw: 20, pitch: 0 }], { ease: 'linear' });
  near(lastBlade(r.rec).x, 960 + 20 * PPD, 8, 'x after the sweep');
  near(lastBlade(r.rec).y, 540, 8, 'y after the sweep');
  assert.equal(r.rec.blades.some((b) => b.cutting), false, 'slow movement never cuts');
  play(r, [{ t: 0, yaw: 20, pitch: 0 }, { t: 300, yaw: 20, pitch: 0 }, { t: 450, yaw: -10, pitch: 0 }, { t: 900, yaw: -10, pitch: 0 }]);
  assert.ok(r.rec.blades.filter((b) => b.cutting).length >= 4, 'a fast swing cuts');
  near(lastBlade(r.rec).x, 960 - 10 * PPD, 10, 'x after the swing');
  // and up is up: pitching the sword up 8 degrees moves the cursor up
  play(r, [{ t: 0, yaw: -10, pitch: 0 }, { t: 1600, yaw: -10, pitch: 8 }, { t: 2200, yaw: -10, pitch: 8 }], { ease: 'linear' });
  near(lastBlade(r.rec).y, 540 - 8 * PPD, 8, 'y after pitching up');
});

test('a normal sensor with the parameter left at +1 is untouched, and a flipped parameter on a normal sensor is the mirror-image error (the diagnostics decide which is right)', () => {
  const ok = runCalibration({ mount: 'faceUp', hz: 66, seed: 1700 });
  assert.ok(angleDeg(ok.cal.frame.forward, MOUNTS.faceUp.forward) < 3);
  const wrong = runCalibration({ mount: 'faceUp', hz: 66, seed: 1700 }, { pipeOpts: { accelSign: -1 } });
  assert.ok(wrong.done);
  assert.ok(angleDeg(wrong.cal.frame.forward, MOUNTS.faceUp.forward) > 170);
});

test('the sign is applied to everything that reads the accelerometer: online bias, gravity correction and the reconnect restart', () => {
  const r = calibratedPipeline({ mount: 'faceUp', hz: 66, seed: 1800, accelSign: -1 }, { accelSign: -1 });
  r.pipe.setSettings({ autoCenter: false });
  feed(r.pipe, r.synth.generate(holdPose(0, 0, 0), r.synth.devMs + 1000));
  r.synth.generate(holdPose(0, 25, 0), r.synth.devMs + 10000); // a 10 s hole with the sword raised
  r.pipe.markDiscontinuity('lost');
  r.pipe.recenter('reconnect');
  feed(r.pipe, r.synth.generate(holdPose(0, 25, 0), r.synth.devMs + 60));
  near(r.pipe.getDebug().rawPitchDeg, 25, 2, 'the restart from gravity used the corrected sign');
  const y0 = lastBlade(r.rec).y;
  feed(r.pipe, r.synth.generate(holdPose(0, 25, 0), r.synth.devMs + 3000));
  near(lastBlade(r.rec).y, y0, 20, 'the cursor stays');
});

test('the saved-sign sample object is not mutated (the input sample of the caller stays as it was)', () => {
  const synth = createSynth({ mount: 'faceUp', seed: 1900, accelSign: -1 });
  const pipe = createAbsolutePipeline({ accelSign: -1 });
  record(pipe, { validate: false });
  pipe.setCalibration(synth.nominalCalibration());
  const [s] = synth.generate(holdPose(0, 0, 0), 20);
  const before = JSON.stringify(s);
  pipe.pushImu(s);
  assert.equal(JSON.stringify(s), before);
});
