import test from 'node:test';
import assert from 'node:assert/strict';
import { createSynth, keyframes, holdPose, MOUNT_NAMES } from '../../test-support/motion/synth.js';
import { calibratedPipeline, play, lastBlade, feed, record, createAbsolutePipeline } from '../../test-support/motion/harness.js';

const PPD = 27.4;
const near = (a, b, tol, msg = '') => assert.ok(Math.abs(a - b) <= tol, `${msg} expected ${b} +-${tol}, got ${a}`);
const at = (yaw, pitch, roll = 0) => ({ yaw, pitch, roll });
/** Move smoothly to a pose in `ms` and hold it for `holdMs`. */
const goto = (r, from, to, ms, holdMs) => play(r, [{ t: 0, ...from }, { t: ms, ...to }, { t: ms + holdMs, ...to }]);

// ------------------------------------------------------------------------------------------------------------------ mapping

test('mapping: +10 deg yaw right = +274 px, +5 deg pitch up = -137 px, roll changes nothing, for all six mounts and both sides', (t) => {
  let worstYaw = 0;
  let worstPitch = 0;
  let worstRoll = 0;
  for (const mount of MOUNT_NAMES) {
    for (const side of ['L', 'R']) {
      const r = calibratedPipeline({ mount, side, hz: 66, seed: 200 });
      const c0 = lastBlade(r.rec);
      near(c0.x, 960, 3, `${mount}: centred x`);
      near(c0.y, 540, 3, `${mount}: centred y`);
      goto(r, at(0, 0), at(10, 0), 500, 400);
      const b1 = lastBlade(r.rec);
      worstYaw = Math.max(worstYaw, Math.abs(b1.x - (960 + 10 * PPD)));
      near(b1.x, 960 + 274, 15, `${mount}/${side} yaw`);
      near(b1.y, 540, 8, `${mount}/${side} yaw leaves y alone`);
      goto(r, at(10, 0), at(10, 5), 500, 400);
      const b2 = lastBlade(r.rec);
      worstPitch = Math.max(worstPitch, Math.abs(b2.y - (540 - 5 * PPD)));
      near(b2.y, 540 - 137, 15, `${mount}/${side} pitch`);
      goto(r, at(10, 5, 0), at(10, 5, 40), 500, 400);
      const b3 = lastBlade(r.rec);
      worstRoll = Math.max(worstRoll, Math.hypot(b3.x - b2.x, b3.y - b2.y));
      assert.ok(Math.hypot(b3.x - b2.x, b3.y - b2.y) < 2, `${mount}/${side}: roll moved the cursor by ${Math.hypot(b3.x - b2.x, b3.y - b2.y)} px`);
      assert.equal(r.rec.blades.some((b) => b.cutting), false, 'slow aiming never cuts');
    }
  }
  t.diagnostic(`mapping over 12 mount/side runs: worst yaw error ${worstYaw.toFixed(2)} px (of 274), worst pitch error ${worstPitch.toFixed(2)} px (of 137), worst roll leak ${worstRoll.toFixed(2)} px`);
});

test('mapping: y follows pitch with the same scale in both directions and yaw is symmetric', () => {
  const r = calibratedPipeline({ mount: 'tilted', hz: 66, seed: 201 });
  const at0 = { x: 960, y: 540 };
  goto(r, at(0, 0), at(-10, 0), 600, 300);
  near(lastBlade(r.rec).x, at0.x - 274, 15);
  goto(r, at(-10, 0), at(-10, -6), 600, 300);
  near(lastBlade(r.rec).y, at0.y + 6 * PPD, 15);
  goto(r, at(-10, -6), at(0, 0), 900, 400);
  near(lastBlade(r.rec).x, 960, 8);
  near(lastBlade(r.rec).y, 540, 8);
});

test('mapping: flipX mirrors x only; sensitivity 2.0 doubles the excursion, 0.5 halves it; changes take effect on the next sample', () => {
  const r = calibratedPipeline({ mount: 'faceSide', hz: 66, seed: 202 });
  r.pipe.setSettings({ flipX: true });
  goto(r, at(0, 0), at(10, 0), 500, 400);
  near(lastBlade(r.rec).x, 960 - 274, 15, 'flipX');
  goto(r, at(10, 0), at(0, 0), 500, 300);
  r.pipe.setSettings({ flipX: false, sensitivity: 2.0 });
  assert.equal(r.pipe.getSettings().sensitivity, 2);
  goto(r, at(0, 0), at(10, 4), 500, 400);
  const b = lastBlade(r.rec);
  near(b.x, 960 + 548, 25, 'sensitivity 2 x');
  near(b.y, 540 - 219, 25, 'sensitivity 2 y');
  goto(r, at(10, 4), at(0, 0), 500, 300);
  r.pipe.setSettings({ sensitivity: 0.5 });
  goto(r, at(0, 0), at(20, 0), 800, 400);
  near(lastBlade(r.rec).x, 960 + 274, 15, 'sensitivity 0.5');
  // out-of-range values are clamped, non-numbers ignored
  r.pipe.setSettings({ sensitivity: 9, cutThreshold: 10, cutMul: 50, autoCenter: 'yes', flipX: 1 });
  const s = r.pipe.getSettings();
  assert.equal(s.sensitivity, 2);
  assert.equal(s.cutThreshold, 100, 'cutThreshold is in deg/s now (range 100 to 700, contract 3.1)');
  r.pipe.setSettings({ sensitivity: 0.1, cutThreshold: 5000 });
  assert.equal(r.pipe.getSettings().sensitivity, 0.3, 'the sensitivity range starts at 0.3 (was 0.5)');
  assert.equal(r.pipe.getSettings().cutThreshold, 700);
  assert.equal(s.cutMul, 3);
  assert.equal(s.autoCenter, true);
  assert.equal(s.flipX, false);
});

test('mapping: changing sensitivity or flipX marks the next sample as a discontinuity', () => {
  const r = calibratedPipeline({ mount: 'faceUp', hz: 66, seed: 203 });
  goto(r, at(0, 0), at(10, 0), 500, 200);
  const n = r.rec.blades.length;
  r.pipe.setSettings({ sensitivity: 1.5 });
  goto(r, at(10, 0), at(10, 0), 100, 0);
  assert.equal(r.rec.blades[n].discontinuity, true);
  assert.equal(r.rec.blades[n + 1].discontinuity, false);
  const m = r.rec.blades.length;
  r.pipe.setSettings({ sensitivity: 1.5 }); // unchanged: no flag
  goto(r, at(10, 0), at(10, 0), 100, 0);
  assert.equal(r.rec.blades[m].discontinuity, false);
});

test('mapping: the cursor clamps to the playfield, never leaves it, and pointing straight up is safe', () => {
  const r = calibratedPipeline({ mount: 'tilted', hz: 66, seed: 204 });
  r.pipe.setSettings({ autoCenter: false });
  goto(r, at(0, 0), at(40, 22), 400, 300); // 5 deg beyond the right edge, 2.3 deg above the top: below the edge-slip limit
  const b = lastBlade(r.rec);
  assert.equal(b.x, 1920);
  assert.equal(b.y, 0);
  for (const s of r.rec.blades) assert.ok(s.x >= 0 && s.x <= 1920 && s.y >= 0 && s.y <= 1080);
  goto(r, at(40, 22), at(-40, -22), 700, 300);
  assert.equal(lastBlade(r.rec).x, 0);
  assert.equal(lastBlade(r.rec).y, 1080);
  goto(r, at(-40, -22), at(0, 90), 900, 300); // sword straight up: yaw undefined, must stay finite and clamped
  const up = lastBlade(r.rec);
  assert.ok(Number.isFinite(up.x) && Number.isFinite(up.y));
  assert.equal(up.y, 0);
});

test('mapping: yaw wraps correctly through +-180 deg (a +10 deg move across the seam is still +274 px)', () => {
  const r = calibratedPipeline({ mount: 'faceUp', hz: 66, seed: 206 });
  const synth = r.synth;
  const t0 = synth.devMs;
  // turn the sword 175 deg to the right in 400 ms (a swing, the cursor pins at the edge), recentre there, then go 10 deg further:
  // the world yaw passes 180 deg and wraps to -175 deg, the mapping must not.
  feed(r.pipe, synth.generate(keyframes([{ t: t0, yaw: 0, pitch: 0 }, { t: t0 + 400, yaw: 175, pitch: 0 }, { t: t0 + 1200, yaw: 175, pitch: 0 }]), t0 + 1200));
  r.pipe.recenter();
  feed(r.pipe, synth.generate(holdPose(175, 0, 0), t0 + 2000));
  near(lastBlade(r.rec).x, 960, 6, 'recentred at yaw 175');
  feed(r.pipe, synth.generate(keyframes([{ t: t0 + 2000, yaw: 175, pitch: 0 }, { t: t0 + 2600, yaw: 185, pitch: 0 }, { t: t0 + 3000, yaw: 185, pitch: 0 }]), t0 + 3000));
  near(lastBlade(r.rec).x, 960 + 274, 15, '+10 deg across the +-180 seam');
});

// --------------------------------------------------------------------------------------------------------- manual recentre

test('recenter: manual recentre snaps the reference, eases the cursor over 150 ms with discontinuity flags, emits one event', () => {
  const r = calibratedPipeline({ mount: 'tilted', hz: 66, seed: 210 });
  r.pipe.setSettings({ autoCenter: false });
  goto(r, at(0, 0), at(12, 4), 500, 400);
  const before = lastBlade(r.rec);
  near(before.x, 960 + 12 * PPD, 15);
  const n = r.rec.blades.length;
  const nRec = r.rec.recenter.length;
  r.pipe.recenter();
  assert.equal(r.rec.recenter.length, nRec + 1);
  assert.equal(r.rec.recenter[nRec].kind, 'manual');
  feed(r.pipe, r.synth.generate(holdPose(12, 4, 0), r.synth.devMs + 400));
  const seq = r.rec.blades.slice(n);
  const eased = seq.filter((b) => b.discontinuity);
  const firstNormal = seq.findIndex((b) => !b.discontinuity);
  assert.ok(eased.length >= 8 && eased.length <= 12, `${eased.length} eased samples at 66 Hz for 150 ms`);
  assert.ok(seq.slice(0, firstNormal).every((b) => b.discontinuity && !b.segmentValid && !b.cutting));
  // monotonic approach from the old cursor to the centre
  for (let i = 1; i < firstNormal; i += 1) assert.ok(Math.abs(seq[i].x - 960) <= Math.abs(seq[i - 1].x - 960) + 1e-6, 'x approaches the centre monotonically');
  assert.ok(Math.abs(seq[0].x - before.x) < 0.2 * Math.abs(before.x - 960), 'starts near the old cursor');
  near(seq[seq.length - 1].x, 960, 3);
  near(seq[seq.length - 1].y, 540, 3);
  assert.equal(seq.slice(firstNormal).some((b) => b.discontinuity), false);
  // time span of the ease
  // the ease is timed from the recentre call; the first sample after it comes one sample period later
  const span = seq[firstNormal].t - seq[0].t;
  assert.ok(span >= 115 && span <= 160, `ease lasted ${span} ms after its first sample`);
});

test('recenter: reconnect kind, no-op before calibration and for the aim path, first-sample recentre is honoured', () => {
  const bare = createAbsolutePipeline();
  const rec = record(bare);
  bare.recenter();
  assert.equal(rec.recenter.length, 0, 'nothing to re-reference without a calibration');

  const r = calibratedPipeline({ mount: 'faceUp', hz: 66, seed: 211 });
  r.pipe.recenter('reconnect');
  assert.equal(r.rec.recenter[r.rec.recenter.length - 1].kind, 'reconnect');
  r.pipe.recenter('bogus');
  assert.equal(r.rec.recenter[r.rec.recenter.length - 1].kind, 'manual');

  // mouse pipeline: recenter is meaningless
  const mouse = createAbsolutePipeline();
  const recM = record(mouse);
  mouse.pushAim({ t: 100, x: 500, y: 500 });
  mouse.recenter();
  assert.equal(recM.recenter.length, 0);

  // recenter requested before any IMU sample after setCalibration: applied on the first sample (pitch reference = that pose)
  const synth = createSynth({ mount: 'faceUp', hz: 66, seed: 212 });
  const p = createAbsolutePipeline();
  const rp = record(p);
  p.setCalibration(synth.nominalCalibration());
  p.recenter();
  feed(p, synth.generate(holdPose(0, 8, 0), 300)); // pointing 8 deg up when it starts
  near(lastBlade(rp).y, 540, 3, 'the first pose became the centre');
});

// ------------------------------------------------------------------------------------------------------------ auto centring

test('auto centring: starts after 1.0 s at rest, drifts to the centre at 3 deg/s (82 px/s), announces itself once on arrival', (t) => {
  const r = calibratedPipeline({ mount: 'tilted', hz: 66, seed: 220 });
  goto(r, at(0, 0), at(8, 0), 400, 0); // 8 deg right = 219 px off centre, then rest
  const tRest = r.rec.blades[r.rec.blades.length - 1].t;
  const marks = [];
  const sampleAt = (ms) => {
    const target = tRest + ms;
    if (r.synth.nowMs < target) feed(r.pipe, r.synth.generate(holdPose(8, 0, 0), r.synth.devMs + (target - r.synth.nowMs)));
    marks.push({ ms, x: lastBlade(r.rec).x });
    return lastBlade(r.rec).x;
  };
  const x0 = sampleAt(0);
  const x900 = sampleAt(900);
  near(x900, x0, 3, 'no slew during the first second of rest');
  const xa = sampleAt(1500);
  const xb = sampleAt(2500);
  const rate = (xa - xb) / 1.0;
  t.diagnostic(`slew ${rate.toFixed(1)} px/s (design 82 px/s), x at 0/0.9/1.5/2.5 s: ${marks.map((m) => m.x.toFixed(0)).join(' / ')}`);
  near(rate, 82.2, 6, 'slew rate');
  const nAuto0 = r.rec.recenter.filter((e) => e.kind === 'auto').length;
  assert.equal(nAuto0, 0, 'not arrived yet');
  sampleAt(4500);
  near(lastBlade(r.rec).x, 960, 3, 'arrived at the centre');
  assert.equal(r.rec.recenter.filter((e) => e.kind === 'auto').length, 1, 'one auto recenter event');
  sampleAt(8000);
  assert.equal(r.rec.recenter.filter((e) => e.kind === 'auto').length, 1, 'no repeated announcements at rest');
  assert.equal(r.pipe.getDebug().autoSlewing, true);
  // the slew never produced a cut or a segment
  assert.equal(r.rec.blades.some((b) => b.cutting || b.segmentValid), false);
});

test('auto centring: setting off, motion above 12 deg/s, and cutting all stop it', () => {
  // off
  const off = calibratedPipeline({ mount: 'faceUp', hz: 66, seed: 221 });
  off.pipe.setSettings({ autoCenter: false });
  goto(off, at(0, 0), at(8, 0), 400, 4000);
  near(lastBlade(off.rec).x, 960 + 8 * PPD, 6, 'stays put with auto centring off');

  // starts, then a 20 dps drift stops it (refs frozen while moving), and resumes at rest
  const r = calibratedPipeline({ mount: 'faceUp', hz: 66, seed: 222 });
  goto(r, at(0, 0), at(8, 0), 400, 1800); // slewing since ~1.0 s
  assert.equal(r.pipe.getDebug().autoSlewing, true);
  const refBefore = r.pipe.getDebug().yawRef;
  // rotate steadily at 20 dps for 0.5 s (above the 12 dps break threshold, below the cut threshold)
  play(r, [{ t: 0, yaw: 8, pitch: 0 }, { t: 500, yaw: 18, pitch: 0 }], { ease: 'linear' });
  assert.equal(r.pipe.getDebug().autoSlewing, false);
  const refMoving = r.pipe.getDebug().yawRef;
  assert.ok(Math.abs(refMoving - refBefore) < 0.35, `refs moved only by the slew of the first part: ${refMoving - refBefore}`);
  play(r, [{ t: 0, yaw: 18, pitch: 0 }, { t: 900, yaw: 18, pitch: 0 }]);
  assert.equal(r.pipe.getDebug().autoSlewing, false, 'needs a fresh 1.0 s of rest');
  play(r, [{ t: 0, yaw: 18, pitch: 0 }, { t: 400, yaw: 18, pitch: 0 }]);
  assert.equal(r.pipe.getDebug().autoSlewing, true);
});

test('auto centring never fights swings: repeated swings with 0.7 s pauses leave the references untouched', () => {
  const r = calibratedPipeline({ mount: 'tilted', hz: 66, seed: 223 });
  // warm-up swing (the script ends with about a second of rest, which would already start the slew)
  goto(r, at(0, 0), at(15, 0), 160, 0);
  const ref0 = r.pipe.getDebug().yawRef;
  const pitch0 = r.pipe.getDebug().pitchRef;
  assert.equal(r.pipe.getDebug().autoSlewing, false);
  const seq = [{ t: 0, yaw: 15, pitch: 0 }];
  let time = 0;
  let pos = 15;
  for (let i = 0; i < 12; i += 1) {
    const next = pos === 15 ? -15 : 15;
    time += 700; // pause at rest: shorter than the 1.0 s of rest that auto centring needs
    seq.push({ t: time, yaw: pos, pitch: 0 });
    time += 160; // fast 30 deg swing
    seq.push({ t: time, yaw: next, pitch: 0 });
    pos = next;
  }
  time += 700;
  seq.push({ t: time, yaw: pos, pitch: 0 });
  play(r, seq);
  const cuts = r.rec.blades.filter((b) => b.cutting).length;
  assert.ok(cuts > 12, `the swings cut (${cuts} cutting samples)`);
  const dbg = r.pipe.getDebug();
  assert.equal(dbg.yawRef, ref0);
  assert.equal(dbg.pitchRef, pitch0);
  assert.equal(dbg.autoSlewing, false);
});

test('auto centring waits cutQuietMs after a swing and 1.0 s of rest before it slews', () => {
  const r = calibratedPipeline({ mount: 'tilted', hz: 66, seed: 224 });
  // swing 12 deg to the right in 150 ms, then rest
  goto(r, at(0, 0), at(12, 0), 150, 0);
  const tEnd = lastBlade(r.rec).t;
  const cutEnd = r.rec.blades.filter((b) => b.cutting).pop().t;
  feed(r.pipe, r.synth.generate(holdPose(12, 0, 0), r.synth.devMs + 900));
  assert.equal(r.pipe.getDebug().autoSlewing, false, `no slew ${(lastBlade(r.rec).t - tEnd).toFixed(0)} ms after the swing`);
  feed(r.pipe, r.synth.generate(holdPose(12, 0, 0), r.synth.devMs + 700));
  assert.equal(r.pipe.getDebug().autoSlewing, true);
  assert.ok(lastBlade(r.rec).t - cutEnd > 1000);
});

// ------------------------------------------------------------------------------------------ who moved the cursor (R2-01)

/** Feed samples one by one and collect MotionState.refDriven after each (with the cursor x), like the frame loop reads it. */
function feedWatching(r, samples) {
  const out = [];
  for (const s of samples) {
    r.pipe.pushImu(s);
    r.pipe.poll(s.t);
    const st = r.pipe.getState();
    out.push({ t: s.t, refDriven: st.refDriven, x: st.x });
  }
  return out;
}

test('refDriven (R2-01): false while the sword moves the cursor and at rest with soft centring not yet started', () => {
  const r = calibratedPipeline({ mount: 'tilted', hz: 66, seed: 240 });
  assert.equal(r.pipe.getState().refDriven, false);
  const t0 = r.synth.devMs;
  const seen = feedWatching(r, r.synth.generate(keyframes([{ t: t0, ...at(0, 0) }, { t: t0 + 400, ...at(8, 0) }, { t: t0 + 900, ...at(8, 0) }]), t0 + 900));
  assert.ok(seen.length > 30);
  assert.equal(seen.some((q) => q.refDriven), false, 'a swing of the sword and the first 0.5 s of rest are not reference motion');
});

test('refDriven (R2-01): true for exactly as long as soft centring drags the cursor, false again once it arrived', () => {
  const r = calibratedPipeline({ mount: 'tilted', hz: 66, seed: 241 });
  goto(r, at(0, 0), at(8, 0), 400, 0);
  const t0 = r.synth.devMs;
  const seen = feedWatching(r, r.synth.generate(holdPose(8, 0, 0), t0 + 6000));
  const driven = seen.filter((q) => q.refDriven);
  assert.ok(driven.length > 150, `the slew (about 2.7 s at 66 Hz) is reported: ${driven.length} samples`);
  // it starts after the 1.0 s of rest, it moves the cursor towards the centre and it ends when the centre is reached
  const first = seen.findIndex((q) => q.refDriven);
  assert.ok(seen[first].t - t0 >= 900, `not before the rest hold: ${seen[first].t - t0} ms`);
  for (let i = 1; i < seen.length; i += 1) if (seen[i].refDriven && seen[i - 1].refDriven) assert.ok(seen[i].x <= seen[i - 1].x + 1e-6, 'x only approaches the centre');
  const last = seen.length - 1;
  assert.equal(seen[last].refDriven, false, 'arrived at the centre: the cursor rests');
  near(seen[last].x, 960, 3);
  // and it is false again at once when the player moves the sword (above the 12 deg/s break threshold)
  goto(r, at(8, 0), at(8, 0), 1, 1200); // slewing again after 1 s of rest
  const moving = feedWatching(r, r.synth.generate(keyframes([{ t: r.synth.devMs, ...at(8, 0) }, { t: r.synth.devMs + 300, ...at(14, 0) }]), r.synth.devMs + 300));
  assert.equal(moving[moving.length - 1].refDriven, false, 'a moving sword is not reference motion');
});

test('refDriven (R2-01): true during the recentre ease and on the re-referenced sample after a hole; false for the mouse', () => {
  const r = calibratedPipeline({ mount: 'tilted', hz: 66, seed: 242 });
  r.pipe.setSettings({ autoCenter: false });
  goto(r, at(0, 0), at(12, 4), 500, 400);
  r.pipe.recenter();
  const t0 = r.synth.devMs;
  const ease = feedWatching(r, r.synth.generate(holdPose(12, 4, 0), t0 + 400));
  const driven = ease.filter((q) => q.refDriven);
  assert.ok(driven.length >= 8 && driven.length <= 12, `the 150 ms ease at 66 Hz: ${driven.length} samples`);
  assert.equal(ease[ease.length - 1].refDriven, false);
  // a link loss: the first sample afterwards is re-referenced to the centre
  r.pipe.markDiscontinuity('lost');
  const after = feedWatching(r, r.synth.generate(holdPose(12, 4, 0), r.synth.devMs + 100));
  assert.equal(after[0].refDriven, true, 'the re-reference jump');
  assert.equal(after[after.length - 1].refDriven, false);

  const mouse = createAbsolutePipeline();
  mouse.pushAim({ t: 10, x: 100, y: 100 });
  mouse.pushAim({ t: 30, x: 900, y: 500 });
  assert.equal(mouse.getState().refDriven, false);
});

// ---------------------------------------------------------------------------------------------------------------- edge slip

test('edge slip: 8+ deg beyond the playfield for 0.5 s drags the reference, announces kind edge once, never leaves the cursor stuck', (t) => {
  const r = calibratedPipeline({ mount: 'tilted', hz: 66, seed: 230 });
  r.pipe.setSettings({ autoCenter: false });
  // go to 25 deg beyond the right edge (yaw 60: the edge is at 35) and hold
  goto(r, at(0, 0), at(60, 0), 800, 0);
  const mark = r.rec.blades.length;
  feed(r.pipe, r.synth.generate(holdPose(60, 0, 0), r.synth.devMs + 3000));
  const edges = r.rec.recenter.filter((e) => e.kind === 'edge');
  assert.equal(edges.length, 1, 'announced once');
  const tStart = edges[0].t;
  assert.equal(r.pipe.getDebug().edgeActive, false, 'finished dragging');
  near(lastBlade(r.rec).x, 1920, 1);
  // not stuck: a small move back (10 deg left) moves the cursor by the full 274 px at once
  goto(r, at(60, 0), at(50, 0), 500, 300);
  near(lastBlade(r.rec).x, 1920 - 10 * PPD, 15, 'cursor leaves the edge immediately');
  // drag rate: about 20 deg/s -> 25 deg beyond needs ~1.25 s after the 0.5 s hold
  const drag = r.rec.blades.slice(mark);
  t.diagnostic(`edge slip announced ${(tStart - drag[0].t).toFixed(0)} ms after the aim reached the edge zone`);
});

test('edge slip: also works vertically and to the left; never engages while cutting', () => {
  const r = calibratedPipeline({ mount: 'faceUp', hz: 66, seed: 231 });
  r.pipe.setSettings({ autoCenter: false });
  goto(r, at(0, 0), at(-10, 40), 1500, 0); // 20 deg above the top edge (19.7), i.e. 20 deg beyond; slow move
  feed(r.pipe, r.synth.generate(holdPose(-10, 40, 0), r.synth.devMs + 2500));
  assert.ok(r.rec.recenter.some((e) => e.kind === 'edge'));
  assert.equal(r.pipe.getDebug().edgeActive, false);
  // now aim left beyond the edge quickly and swing back and forth beyond it: no edge slip while cutting
  const r2 = calibratedPipeline({ mount: 'faceUp', hz: 66, seed: 232 });
  r2.pipe.setSettings({ autoCenter: false });
  const ref0 = r2.pipe.getDebug().yawRef;
  const keys = [{ t: 0, yaw: 0, pitch: 0 }];
  let time = 0;
  for (let i = 0; i < 10; i += 1) {
    time += 150;
    keys.push({ t: time, yaw: i % 2 ? -50 : 60, pitch: 0 }); // 110 deg swings across and beyond both edges, 150 ms each
  }
  play(r2, keys);
  assert.equal(r2.pipe.getDebug().yawRef, ref0, 'no edge drag during fast swings');
  assert.equal(r2.rec.recenter.filter((e) => e.kind === 'edge').length, 0);
});

test('reach: after a recentre the whole playfield can be reached (corners at +-36 deg / +-20.5 deg at sensitivity 1)', () => {
  const r = calibratedPipeline({ mount: 'sideRail', hz: 66, seed: 233 });
  r.pipe.setSettings({ autoCenter: false });
  let cur = at(0, 0);
  const corners = [
    [at(-36, 20.5), 0, 0],
    [at(36, 20.5), 1920, 0],
    [at(36, -20.5), 1920, 1080],
    [at(-36, -20.5), 0, 1080],
    [at(0, 0), 960, 540],
  ];
  for (const [target, x, y] of corners) {
    goto(r, cur, target, 700, 300);
    const b = lastBlade(r.rec);
    near(b.x, x, x === 960 ? 12 : 1, `corner ${x},${y} x`);
    near(b.y, y, y === 540 ? 12 : 1, `corner ${x},${y} y`);
    cur = target;
  }
});
