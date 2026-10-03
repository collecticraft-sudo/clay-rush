// End-to-end behaviour of the IMU path on synthetic sensors: swings that must cut, sweeps that must not, sample rates,
// dropped packets, jittery timestamps, latency numbers. The synthetic sensor models docs/joycon2-protocol.md and
// docs/architecture.md 5.8; nothing here is a measurement of the physical Joy-Con 2 (UNVERIFIED-ON-HARDWARE).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSynth, keyframes, holdPose, MOUNT_NAMES } from '../../test-support/motion/synth.js';
import { calibratedPipeline, feed, lastBlade, play, record, createAbsolutePipeline } from '../../test-support/motion/harness.js';

const PPD = 27.4;
const near = (a, b, tol, msg = '') => assert.ok(Math.abs(a - b) <= tol, `${msg} expected ${b} +-${tol}, got ${a}`);
const RATES = [33, 66, 250];

/** Constant-speed yaw sweep from a to b at v px/s (linear interpolation), starting after `restMs` of rest. */
function sweepKeys(from, to, vPxPerS, restMs = 300) {
  const ms = ((Math.abs(to - from) * PPD) / vPxPerS) * 1000;
  return [{ t: 0, yaw: from, pitch: 0 }, { t: restMs, yaw: from, pitch: 0 }, { t: restMs + ms, yaw: to, pitch: 0 }, { t: restMs + ms + 400, yaw: to, pitch: 0 }];
}

// ---------------------------------------------------------------------------------------------------------- cut / no cut

test('a fast swing cuts and a slow sweep never does: 6 mounts x 3 rates, both sides', () => {
  for (const mount of MOUNT_NAMES) {
    for (const hz of RATES) {
      const side = hz === 66 ? 'L' : 'R';
      // slow sweep: 40 deg in 2 s (20 dps = 548 px/s)
      const slow = calibratedPipeline({ mount, hz, side, seed: 500 + hz });
      slow.pipe.setSettings({ autoCenter: false });
      play(slow, [{ t: 0, yaw: -20, pitch: 0 }, { t: 2000, yaw: 20, pitch: 0 }], { ease: 'linear' });
      assert.equal(slow.rec.blades.some((b) => b.cutting), false, `${mount} ${hz} Hz: a 548 px/s sweep must not cut`);
      assert.equal(slow.rec.drain().length, 0);
      // fast swing: 40 deg in 150 ms
      const fast = calibratedPipeline({ mount, hz, side, seed: 600 + hz });
      fast.pipe.setSettings({ autoCenter: false });
      play(fast, [{ t: 0, yaw: 0, pitch: 0 }, { t: 300, yaw: 0, pitch: 0 }, { t: 450, yaw: 40, pitch: 0 }, { t: 900, yaw: 40, pitch: 0 }]);
      const cutting = fast.rec.blades.filter((b) => b.cutting);
      assert.ok(cutting.length >= (hz === 33 ? 3 : 5), `${mount} ${hz} Hz: fast swing cut for only ${cutting.length} samples`);
      assert.equal(new Set(cutting.map((b) => b.swingId)).size, 1, 'one swing');
      const segs = fast.rec.drain();
      assert.ok(segs.length >= 3);
      // the chords cover most of the 40 deg (1096 px) even at 33 Hz
      const covered = segs.reduce((a, s) => a + Math.hypot(s.x1 - s.x0, s.y1 - s.y0), 0);
      assert.ok(covered > 500, `${mount} ${hz} Hz: chords cover ${covered.toFixed(0)} px`);
      assert.equal(lastBlade(fast.rec).cutting, false, 'the swing ended');
    }
  }
});

test('threshold discrimination through the sensor: 0.6 T never cuts, 1.5 T always does (steady sweeps)', () => {
  for (const hz of RATES) {
    for (const mount of ['faceUp', 'tilted', 'upsideDown']) {
      const slow = calibratedPipeline({ mount, hz, seed: 700 + hz });
      slow.pipe.setSettings({ autoCenter: false });
      play(slow, sweepKeys(-15, 15, 600), { ease: 'linear' });
      assert.equal(slow.rec.blades.some((b) => b.cutting), false, `${mount} ${hz} Hz 600 px/s`);
      const fast = calibratedPipeline({ mount, hz, seed: 800 + hz });
      fast.pipe.setSettings({ autoCenter: false });
      play(fast, sweepKeys(-15, 15, 1500), { ease: 'linear' });
      assert.ok(fast.rec.blades.filter((b) => b.cutting).length > 3, `${mount} ${hz} Hz 1500 px/s`);
    }
  }
  // Zen: T = 800, a 900 px/s sweep cuts only there
  const normal = calibratedPipeline({ mount: 'faceUp', hz: 66, seed: 901 });
  normal.pipe.setSettings({ autoCenter: false });
  play(normal, sweepKeys(-15, 15, 900), { ease: 'linear' });
  assert.equal(normal.rec.blades.some((b) => b.cutting), false);
  const zen = calibratedPipeline({ mount: 'faceUp', hz: 66, seed: 902 });
  zen.pipe.setSettings({ autoCenter: false, cutMul: 0.8 });
  play(zen, sweepKeys(-15, 15, 900), { ease: 'linear' });
  assert.ok(zen.rec.blades.some((b) => b.cutting));
});

test('a 3000 px/s swing at 33 Hz makes chords of about 90 px and still registers as ONE swing', () => {
  const r = calibratedPipeline({ mount: 'tilted', hz: 33, seed: 910 });
  r.pipe.setSettings({ autoCenter: false });
  play(r, sweepKeys(-16, 16, 3000), { ease: 'linear' });
  const segs = r.rec.drain();
  assert.ok(segs.length >= 6, `${segs.length} segments`);
  const lens = segs.map((s) => Math.hypot(s.x1 - s.x0, s.y1 - s.y0));
  const interior = lens.slice(1, -1);
  const mean = interior.reduce((a, b) => a + b, 0) / interior.length;
  near(mean, 91, 6, 'mean chord');
  assert.equal(new Set(segs.map((s) => s.swingId)).size, 1);
  assert.equal(lastBlade(r.rec).swingId, 1);
});

// --------------------------------------------------------------------------------------------------------- packet loss

test('dropped packets: 20 percent random loss keeps aim and cuts working (return error and swing detection)', (t) => {
  const seq = [{ t: 0, yaw: 0, pitch: 0 }, { t: 500, yaw: 0, pitch: 0 }];
  let time = 500;
  for (let i = 0; i < 8; i += 1) {
    time += i % 2 ? 200 : 1000;
    seq.push({ t: time, yaw: (i % 2 ? -1 : 1) * 25, pitch: (i % 3 - 1) * 8 });
  }
  time += 1200;
  seq.push({ t: time, yaw: 0, pitch: 0 });
  time += 1500;
  seq.push({ t: time, yaw: 0, pitch: 0 });
  const errs = {};
  for (const [name, drop] of [['none', 0], ['20%', 0.2]]) {
    const r = calibratedPipeline({ mount: 'tilted', hz: 66, seed: 1000, dropRate: drop });
    r.pipe.setSettings({ autoCenter: false });
    // the calibration script itself ran with drops too (dropRate is a synth option): it must still succeed
    play(r, seq);
    const b = lastBlade(r.rec);
    errs[name] = Math.hypot(b.x - 960, b.y - 540);
    assert.ok(r.rec.blades.some((x) => x.cutting), `${name}: fast swings still cut`);
    assert.ok(errs[name] < 2 * PPD, `${name}: return error ${errs[name]} px`);
  }
  t.diagnostic(`return-to-start error with 0 % loss ${errs.none.toFixed(1)} px, with 20 % loss ${errs['20%'].toFixed(1)} px (incl. calibration under loss)`);
});

test('dropped packets: a 100 ms hole in the middle of a fast swing keeps ONE swing, integrates the gap, warns sample_gap', (t) => {
  const keys = [{ t: 0, yaw: 0, pitch: 0 }, { t: 400, yaw: 0, pitch: 0 }, { t: 700, yaw: 30, pitch: 0 }, { t: 1200, yaw: 30, pitch: 0 }];
  const truthEnd = 960 + 30 * PPD;
  const run = (holeMs) => {
    const r = calibratedPipeline({ mount: 'faceSide', hz: 66, seed: 1100, dropWhen: null });
    r.pipe.setSettings({ autoCenter: false });
    const warns = [];
    r.pipe.on('warning', (w) => warns.push(w.code));
    const t0 = r.synth.devMs;
    const shifted = keys.map((k) => ({ ...k, t: t0 + k.t }));
    const all = r.synth.generate(keyframes(shifted), t0 + 1200 + 1);
    const holeFrom = t0 + 480;
    const kept = all.filter((s) => !(holeMs > 0 && s.t - 1000 >= holeFrom && s.t - 1000 < holeFrom + holeMs));
    // recompute dtMs across the hole exactly like the device timestamps would
    for (let i = 1; i < kept.length; i += 1) {
      const dt = kept[i].t - kept[i - 1].t;
      kept[i] = { ...kept[i], dtMs: dt < 200 ? dt : null };
    }
    feed(r.pipe, kept);
    const cutting = r.rec.blades.filter((b) => b.cutting);
    return { r, warns, cutting, end: lastBlade(r.rec).x };
  };
  const clean = run(0);
  const hole = run(100);
  assert.equal(new Set(hole.cutting.map((b) => b.swingId)).size, 1, 'still one swing');
  assert.ok(hole.warns.includes('sample_gap'));
  assert.ok(!clean.warns.includes('sample_gap'));
  const errClean = Math.abs(clean.end - truthEnd);
  const errHole = Math.abs(hole.end - truthEnd);
  t.diagnostic(`end of a 30 deg swing: error ${errClean.toFixed(1)} px without loss, ${errHole.toFixed(1)} px with a 100 ms hole mid-swing (${(errHole / PPD).toFixed(2)} deg)`);
  assert.ok(errHole < 3 * PPD, `hole error ${errHole} px`);
  // the chord that spans the hole is one long segment (swept collision needs it)
  const segs = hole.r.rec.drain();
  const longest = Math.max(...segs.map((s) => Math.hypot(s.x1 - s.x0, s.y1 - s.y0)));
  assert.ok(longest > 300, `longest chord ${longest}`);
});

test('dropped packets: a 400 ms silence at rest (dt null) flags a discontinuity, the position does not jump, next swing is new', () => {
  const r = calibratedPipeline({ mount: 'tilted', hz: 66, seed: 1200 });
  r.pipe.setSettings({ autoCenter: false });
  play(r, [{ t: 0, yaw: 0, pitch: 0 }, { t: 200, yaw: 10, pitch: 0 }, { t: 500, yaw: 10, pitch: 0 }]);
  const before = lastBlade(r.rec);
  const t0 = r.synth.devMs;
  const all = r.synth.generate(holdPose(10, 0, 0), t0 + 900);
  const kept = all.filter((s) => s.t - 1000 < t0 || s.t - 1000 >= t0 + 500); // silence for 500 ms
  const n = r.rec.blades.length;
  for (let i = 0; i < kept.length; i += 1) {
    const dt = i ? kept[i].t - kept[i - 1].t : kept[i].t - before.t;
    r.pipe.pushImu({ ...kept[i], dtMs: dt < 200 ? dt : null });
  }
  const after = r.rec.blades.slice(n);
  const first = after[0];
  assert.equal(first.discontinuity, true);
  near(first.x, before.x, 4, 'no jump after the gap');
  assert.equal(after[1].discontinuity, false);
});

test('start-up robustness: the wizard succeeds with 15 percent packet loss and with +-4 ms timestamp jitter on t', () => {
  for (const opts of [{ dropRate: 0.15, seed: 1 }, { tJitterMs: 4, seed: 2 }, { dropRate: 0.1, tJitterMs: 3, hz: 33, seed: 3 }, { dtFromArrival: true, tJitterMs: 3, seed: 4 }]) {
    const r = calibratedPipeline({ mount: 'sideRail', hz: 66, ...opts });
    const c = r.pipe.getCalibration();
    assert.equal(c.gyroSign, 1);
    assert.ok(Math.abs(c.gyroScale - 1) < 0.05, JSON.stringify(opts));
  }
});

// ---------------------------------------------------------------------------------------------------- jittery timestamps

test('jittery timestamps: exact dtMs keeps the orientation identical; only the speed window sees the jitter, cuts stay right', (t) => {
  const seq = [{ t: 0, yaw: 0, pitch: 0 }, { t: 400, yaw: 0, pitch: 0 }, { t: 600, yaw: 30, pitch: 5 }, { t: 1000, yaw: 30, pitch: 5 }, { t: 1200, yaw: -30, pitch: -5 }, { t: 1800, yaw: -30, pitch: -5 }];
  const clean = calibratedPipeline({ mount: 'tilted', hz: 66, seed: 1300 });
  const jit = calibratedPipeline({ mount: 'tilted', hz: 66, seed: 1300, tJitterMs: 4 });
  clean.pipe.setSettings({ autoCenter: false });
  jit.pipe.setSettings({ autoCenter: false });
  play(clean, seq);
  play(jit, seq);
  const a = lastBlade(clean.rec);
  const b = lastBlade(jit.rec);
  const d = Math.hypot(a.x - b.x, a.y - b.y);
  t.diagnostic(`final position with +-4 ms jitter on t differs by ${d.toFixed(2)} px from the jitter-free run`);
  assert.ok(d < 4, `orientation must not depend on t jitter: ${d}`);
  assert.equal(new Set(jit.rec.blades.filter((x) => x.cutting).map((x) => x.swingId)).size, new Set(clean.rec.blades.filter((x) => x.cutting).map((x) => x.swingId)).size);
  // slow sweep must not cut even with jitter (speed noise from 1/15 timing error stays far from T)
  const slow = calibratedPipeline({ mount: 'tilted', hz: 66, seed: 1301, tJitterMs: 4 });
  slow.pipe.setSettings({ autoCenter: false });
  play(slow, sweepKeys(-15, 15, 750), { ease: 'linear' });
  assert.equal(slow.rec.blades.some((x) => x.cutting), false);
});

test('arrival-time dt (dtSource arrival, jittery): warns dt_fallback and the return error stays bounded', (t) => {
  const seq = [{ t: 0, yaw: 0, pitch: 0 }, { t: 400, yaw: 0, pitch: 0 }];
  let time = 400;
  for (let i = 0; i < 6; i += 1) {
    time += 700;
    seq.push({ t: time, yaw: (i % 2 ? -1 : 1) * 25, pitch: 0 });
  }
  time += 800;
  seq.push({ t: time, yaw: 0, pitch: 0 });
  time += 1500;
  seq.push({ t: time, yaw: 0, pitch: 0 });
  const r = calibratedPipeline({ mount: 'tilted', hz: 66, seed: 1400, tJitterMs: 3, dtFromArrival: true });
  r.pipe.setSettings({ autoCenter: false });
  const warns = [];
  r.pipe.on('warning', (w) => warns.push(w.code));
  play(r, seq);
  assert.ok(warns.includes('dt_fallback'));
  const b = lastBlade(r.rec);
  const err = Math.hypot(b.x - 960, b.y - 540);
  t.diagnostic(`arrival-time dt with +-3 ms jitter: return error ${err.toFixed(1)} px`);
  assert.ok(err < 2 * PPD);
});

// ---------------------------------------------------------------------------------------------------------------- latency

test('latency: no smoothing lag on the position (tracks the truth within a few px during a fast swing) and cut onset within one window', (t) => {
  const report = [];
  for (const hz of RATES) {
    const r = calibratedPipeline({ mount: 'tilted', hz, seed: 1500 + hz });
    r.pipe.setSettings({ autoCenter: false });
    const t0 = r.synth.devMs;
    const start = t0 + 400;
    const keys = [{ t: t0, yaw: 0, pitch: 0 }, { t: start, yaw: 0, pitch: 0 }, { t: start + 160, yaw: 30, pitch: 0 }, { t: start + 700, yaw: 30, pitch: 0 }];
    const pose = keyframes(keys);
    const samples = r.synth.generate(pose, start + 700);
    let worstPos = 0;
    let onset = null;
    let truthCross = null;
    const dtPose = 0.5;
    for (const s of samples) {
      r.pipe.pushImu(s);
      const devT = s.t - 1000;
      const b = lastBlade(r.rec);
      const truthX = 960 + pose(devT).yaw * PPD;
      const err = Math.abs(b.x - truthX);
      if (devT > start) worstPos = Math.max(worstPos, err);
      const truthSpeed = (Math.abs(pose(devT + dtPose).yaw - pose(devT - dtPose).yaw) * PPD) / (2 * dtPose / 1000);
      if (truthCross === null && truthSpeed >= 1000) truthCross = devT;
      if (onset === null && b.cutting) onset = devT;
    }
    const lag = onset - truthCross;
    report.push(`${hz} Hz: position error max ${worstPos.toFixed(1)} px, cut onset ${lag.toFixed(1)} ms after the true speed crossed T`);
    // a lagging position would show up as (speed x lag): 8 ms at the 6600 px/s peak is 53 px; we are far below that
    assert.ok(worstPos < (hz === 33 ? 30 : 12), `${hz} Hz: position error ${worstPos}`);
    assert.ok(onset >= truthCross - 1e-6);
    assert.ok(lag <= (hz === 33 ? 90 : 70), `${hz} Hz: cut onset lag ${lag} ms`);
    assert.ok(samples.length > 10);
  }
  t.diagnostic(report.join(' | '));
});

test('extrapolation: headAt within the last sample interval lands within a few px of the truth during a fast swing', (t) => {
  const r = calibratedPipeline({ mount: 'faceUp', hz: 66, seed: 1600 });
  r.pipe.setSettings({ autoCenter: false });
  const t0 = r.synth.devMs;
  const start = t0 + 300;
  const pose = keyframes([{ t: t0, yaw: 0, pitch: 0 }, { t: start, yaw: 0, pitch: 0 }, { t: start + 300, yaw: 30, pitch: 0 }, { t: start + 900, yaw: 30, pitch: 0 }]);
  const samples = r.synth.generate(pose, start + 400);
  let sumPlain = 0;
  let sumExtra = 0;
  let n = 0;
  for (const s of samples) {
    r.pipe.pushImu(s);
    const b = lastBlade(r.rec);
    const dev = s.t - 1000;
    if (dev < start + 60 || dev > start + 240) continue; // mid-swing
    const now = s.t + 10; // render 10 ms after the sample time
    const truth = 960 + pose(dev + 10).yaw * PPD;
    sumPlain += Math.abs(b.x - truth);
    sumExtra += Math.abs(r.pipe.headAt(now).x - truth);
    n += 1;
  }
  t.diagnostic(`mid-swing, drawn 10 ms after the sample: mean error ${(sumPlain / n).toFixed(1)} px without extrapolation, ${(sumExtra / n).toFixed(1)} px with headAt`);
  assert.ok(sumExtra < sumPlain * 0.4, 'extrapolation removes most of the 10 ms lag');
});

// --------------------------------------------------------------------------------------------------------------- misc

test('two providers, one pipeline: mouse aim then IMU: a fresh calibration is not needed for the mouse path', () => {
  const pipe = createAbsolutePipeline();
  const rec = record(pipe);
  pipe.pushAim({ t: 1, x: 100, y: 100, discontinuity: true });
  assert.equal(rec.blades.length, 1);
  assert.equal(pipe.getState().calibrated, false);
  const synth = createSynth({ mount: 'faceUp', hz: 66, seed: 1700 });
  feed(pipe, synth.generate(holdPose(0, 0, 0), 300));
  assert.equal(rec.blades.length, 1, 'IMU samples of an uncalibrated pipeline produce no blade samples');
});
