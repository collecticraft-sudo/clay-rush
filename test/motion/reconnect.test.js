// Orientation after a link gap (round 1 finding M1). While the link is down nothing is integrated, so the sword may have been
// tilted meanwhile: the filter must start over from gravity instead of creeping to the new tilt with its 1.5 s time constant,
// and the references must be taken on that exact tilt. The synthetic sensor models docs/joycon2-protocol.md; nothing here
// measures the physical Joy-Con 2 (UNVERIFIED-ON-HARDWARE).
import test from 'node:test';
import assert from 'node:assert/strict';
import { holdPose } from '../../test-support/motion/synth.js';
import { calibratedPipeline, feed, lastBlade, play } from '../../test-support/motion/harness.js';

const PPD = 27.4;
const TOL_PX = 20; // 0.73 deg: single-sample accelerometer noise, see the first test
const near = (a, b, tol, msg = '') => assert.ok(Math.abs(a - b) <= tol, `${msg} expected ${b} +-${tol}, got ${a}`);

/** A calibrated pipeline that has rested 1 s at pitch 0 (auto centring off, so only the filter can move the cursor). */
function ready(seed, opts = {}) {
  const r = calibratedPipeline({ mount: 'faceUp', hz: 66, seed, ...opts });
  r.pipe.setSettings({ autoCenter: false });
  feed(r.pipe, r.synth.generate(holdPose(0, 0, 0), r.synth.devMs + 1000));
  return r;
}

/** A slow, deliberate move to (yaw, pitch) followed by a rest: 12 deg/s, far below the cut threshold, so nothing cuts. */
function moveTo(r, yaw, pitch) {
  const t0 = r.synth.devMs;
  play(r, [{ t: 0, yaw: 0, pitch: 0 }, { t: 1200, yaw, pitch }, { t: 2200, yaw, pitch }], { ease: 'linear' });
  assert.ok(r.synth.devMs > t0);
}

/** The sword is raised to `pitch` while the link is down: the samples of the hole are generated and thrown away. */
function raiseDuringHole(r, pitch, holeMs) {
  r.synth.generate(holdPose(0, pitch, 0), r.synth.devMs + holeMs);
}

/** Feed still samples at `pitch` and return the raw pitch estimate of the filter after each `stepMs`. */
function restAt(r, pitch, totalMs, stepMs = 500) {
  const out = [];
  for (let el = 0; el < totalMs; el += stepMs) {
    feed(r.pipe, r.synth.generate(holdPose(0, pitch, 0), r.synth.devMs + stepMs));
    out.push(r.pipe.getDebug().rawPitchDeg);
  }
  return out;
}

test('a 10 s hole with the sword raised to pitch 25: after markDiscontinuity("lost") + recenter("reconnect") the pitch is exact from the first sample (was 6.96 deg after 0.5 s)', () => {
  const r = ready(901);
  raiseDuringHole(r, 25, 10000);
  // exactly what app.js does: the provider reports `lost`, later `streaming` again
  r.pipe.markDiscontinuity('lost');
  r.pipe.recenter('reconnect');
  feed(r.pipe, r.synth.generate(holdPose(0, 25, 0), r.synth.devMs + 30));
  near(r.pipe.getDebug().rawPitchDeg, 25, 2, 'first samples after the reconnect');
  const estimates = restAt(r, 25, 4000);
  for (const [i, e] of estimates.entries()) near(e, 25, 1.5, `raw pitch at ${(i + 1) * 0.5} s`);
  // the reference was taken on the true tilt: the cursor sits on the centre and stays there. What is left is the accelerometer
  // noise of the single sample the filter restarted from (about 0.2 deg 1 sigma, at most 0.6 deg in 30 seeds = 16 px), a
  // sixteenth of the 255 px creep of the old behaviour.
  near(lastBlade(r.rec).y, 540, TOL_PX, 'cursor y after 4 s');
  near(lastBlade(r.rec).x, 960, TOL_PX, 'cursor x after 4 s');
});

test('the same hole WITHOUT any call from the app (no lost fact, no recenter): a gap over 1 s restarts the filter by itself and the cursor re-centres', () => {
  const r = ready(902);
  raiseDuringHole(r, 25, 10000);
  feed(r.pipe, r.synth.generate(holdPose(0, 25, 0), r.synth.devMs + 30));
  near(r.pipe.getDebug().rawPitchDeg, 25, 2, 'first samples after the hole');
  assert.equal(r.rec.blades.filter((b) => b.discontinuity).length >= 1, true);
  const estimates = restAt(r, 25, 3000);
  for (const [i, e] of estimates.entries()) near(e, 25, 1.5, `raw pitch at ${(i + 1) * 0.5} s`);
  near(lastBlade(r.rec).y, 540, TOL_PX);
  near(lastBlade(r.rec).x, 960, TOL_PX);
});

test('the quick re-centre after a reconnect does not let the cursor creep (was 9.3 deg = 255 px after a re-centre at 1.5 s)', () => {
  const r = ready(903);
  raiseDuringHole(r, 25, 10000);
  r.pipe.markDiscontinuity('lost');
  r.pipe.recenter('reconnect');
  feed(r.pipe, r.synth.generate(holdPose(0, 25, 0), r.synth.devMs + 100));
  r.pipe.beginQuickRecenter(); // the UI's "hold still" re-centre
  feed(r.pipe, r.synth.generate(holdPose(0, 25, 0), r.synth.devMs + 2500));
  assert.ok(r.rec.calibration.some((e) => e.type === 'done' && e.quick), 'the quick re-centre finished');
  const y0 = lastBlade(r.rec).y;
  near(y0, 540, 4, 'centre after the quick re-centre');
  let worst = 0;
  for (let el = 0; el < 4000; el += 250) {
    feed(r.pipe, r.synth.generate(holdPose(0, 25, 0), r.synth.devMs + 250));
    worst = Math.max(worst, Math.abs(lastBlade(r.rec).y - y0));
  }
  assert.ok(worst < 8, `the cursor moved by ${worst.toFixed(1)} px (${(worst / PPD).toFixed(2)} deg) after the re-centre`);
});

test('a short hole (under 1 s) keeps the filter and the references: no snap to the centre, the yaw and pitch offsets survive', () => {
  for (const holeMs of [300, 800]) {
    const r = ready(910 + holeMs);
    moveTo(r, 10, 6); // rest 10 deg right, 6 deg up
    const before = lastBlade(r.rec);
    near(before.x, 960 + 10 * PPD, 6);
    near(before.y, 540 - 6 * PPD, 6);
    r.synth.generate(holdPose(10, 6, 0), r.synth.devMs + holeMs); // hole, same pose
    feed(r.pipe, r.synth.generate(holdPose(10, 6, 0), r.synth.devMs + 500));
    const after = lastBlade(r.rec);
    near(after.x, before.x, 8, `x after a ${holeMs} ms hole`);
    near(after.y, before.y, 8, `y after a ${holeMs} ms hole`);
  }
});

test('markDiscontinuity with another reason only flags the next sample: the filter is not restarted', () => {
  const r = ready(920);
  moveTo(r, 10, 6);
  const q = { ...r.pipe.getDebug().q };
  r.pipe.markDiscontinuity('sensitivity');
  feed(r.pipe, r.synth.generate(holdPose(10, 6, 0), r.synth.devMs + 100));
  const d = r.pipe.getDebug();
  near(d.q.w, q.w, 0.01);
  near(lastBlade(r.rec).x, 960 + 10 * PPD, 6, 'still on the offset position');
});

test('the restart works on every mount (the wizard frame, not the identity, maps the tilt) and on the alternative gyro scale', () => {
  for (const [mount, extra] of [['faceUp', {}], ['tilted', {}], ['sideRail', {}], ['upsideDown', { gyroScaleTrue: 'alt' }], ['faceSide', { mirror: true, side: 'L' }]]) {
    const r = ready(930, { mount, ...extra });
    raiseDuringHole(r, 20, 5000);
    r.pipe.markDiscontinuity('lost');
    r.pipe.recenter('reconnect');
    feed(r.pipe, r.synth.generate(holdPose(0, 20, 0), r.synth.devMs + 60));
    near(r.pipe.getDebug().rawPitchDeg, 20, 2, `${mount}: first samples after the reconnect`);
    feed(r.pipe, r.synth.generate(holdPose(0, 20, 0), r.synth.devMs + 2000));
    near(lastBlade(r.rec).y, 540, TOL_PX, `${mount}: cursor centred and steady`);
  }
});

test('markDiscontinuity("lost") restarts the orientation by itself, even when the timestamps show only a short hole (a fast reconnect)', () => {
  const r = ready(940);
  raiseDuringHole(r, 25, 500); // only 500 ms: under the 1 s gap rule
  r.pipe.markDiscontinuity('lost');
  feed(r.pipe, r.synth.generate(holdPose(0, 25, 0), r.synth.devMs + 60));
  near(r.pipe.getDebug().rawPitchDeg, 25, 2, 'exact from the first samples');
  near(lastBlade(r.rec).y, 540, TOL_PX, 're-referenced on the new tilt (pendingRecenter path)');
  // the same short hole without the lost fact keeps the old tilt and converges slowly, as designed for a mere hiccup
  const q = ready(941);
  raiseDuringHole(q, 25, 500);
  feed(q.pipe, q.synth.generate(holdPose(0, 25, 0), q.synth.devMs + 60));
  assert.ok(q.pipe.getDebug().rawPitchDeg < 12, `no restart without the lost fact: ${q.pipe.getDebug().rawPitchDeg.toFixed(1)} deg`);
});
