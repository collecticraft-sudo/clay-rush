// The relative pointer inside the pipeline (docs/motion-contract.md 2.3 and 2.7): idle soft auto-centre, recentre ease, reanchor, holes, reset,
// tracking loss, the calibration flows, persistence of a calibration, and a fuzz run that keeps every contract invariant.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMotionPipeline, MOTION_CONFIG } from '../../public/js/motion/index.js';
import { createRng } from '../../public/js/shared/rng.js';
import { assertValid } from '../../public/js/shared/validate.js';
import { createManualClock } from '../../public/js/shared/clock.js';
import { createTipStream, mountCalibration } from '../../test-support/motion/tip-stream.js';
import { calibratedPipeline, feed, play, record, lastBlade, runCalibration } from '../../test-support/motion/harness.js';
import { replay, realCalibration } from '../../test-support/motion/real-recording.js';

const PTR = MOTION_CONFIG.pointer;
const DT = 1000 / 33;

function rel({ hz = 33, settings = {}, mount = 'faceUp', config, clock } = {}) {
  const pipe = createMotionPipeline({ pointerModel: 'relative', settings, config, clock });
  const rec = record(pipe);
  pipe.setCalibration(mountCalibration(mount));
  return { pipe, rec, stream: createTipStream({ mount, hz }) };
}
/** Feed samples one by one and collect {t, x, y, refDriven, centring, idle} per sample. */
function run(r, samples) {
  const out = [];
  for (const s of samples) {
    feed(r.pipe, [s]);
    const b = r.pipe.latest();
    const st = r.pipe.getState();
    const d = r.pipe.getDebug().pointer;
    out.push({ t: b.t, x: b.x, y: b.y, cutting: b.cutting, disc: b.discontinuity, refDriven: st.refDriven, centring: d.centring, idle: d.idleForS });
  }
  return out;
}
const dist = (p, x = 960, y = 540) => Math.hypot(p.x - x, p.y - y);

// ------------------------------------------------------------------------------------------------------------- idle soft auto-centre

test('idle auto-centre: nothing for the first 1.0 s at rest, then a glide of 120 to 800 px/s that ramps up over 300 ms and arrives exactly', () => {
  const r = rel({ settings: { autoCenter: true } });
  r.pipe.reanchor(100, 100);
  const rows = run(r, r.stream.hold(400, 0)); // 12 s at rest (a zero tip speed, below every threshold)
  const t0 = rows[0].t;
  assert.ok(rows[0].disc && rows[0].x === 100 && rows[0].y === 100, 'the first sample is placed by reanchor');
  const firstMove = rows.findIndex((p, i) => i > 0 && (p.x !== 100 || p.y !== 100));
  assert.ok(firstMove > 0);
  const tMove = rows[firstMove].t - t0;
  assert.ok(tMove >= 1000 && tMove <= 1000 + 2 * DT + 1, `first movement after ${tMove.toFixed(0)} ms (hold 1.0 s)`);
  assert.ok(rows.slice(0, firstMove).every((p) => !p.refDriven && !p.centring || p === rows[firstMove - 1]), 'no centring before the hold expires');
  // step sizes: at most 800 px/s, the ramp takes 300 ms, at least 120 px/s until the last pixels
  let prev = rows[firstMove - 1];
  let arrived = null;
  for (let i = firstMove; i < rows.length; i += 1) {
    const p = rows[i];
    const step = Math.hypot(p.x - prev.x, p.y - prev.y);
    const dtS = (p.t - prev.t) / 1000;
    assert.ok(step / dtS <= 800 * 1.001, `sample ${i}: ${(step / dtS).toFixed(0)} px/s`);
    const since = p.t - (rows[firstMove - 1].t); // close to the centring start
    if (since > PTR.centreRampMs + 2 * DT && dist(prev) > 60 && dist(p) > 0.5) assert.ok(step / dtS >= 120 * 0.999, `sample ${i}: ${(step / dtS).toFixed(0)} px/s is below the 120 px/s floor`);
    if (step > 0) assert.equal(p.refDriven, true, 'refDriven on every sample on which the centring moved the cursor');
    else assert.equal(p.refDriven, false);
    if (arrived === null && dist(p) <= 0.5) arrived = i;
    prev = p;
  }
  assert.ok(arrived !== null, 'the cursor arrives');
  assert.ok(dist(rows.at(-1)) <= 0.5, `ends ${dist(rows.at(-1)).toFixed(2)} px from the centre`);
  const tArrive = rows[arrived].t - t0;
  assert.ok(tArrive > 2000 && tArrive < 6000, `arrival after ${tArrive.toFixed(0)} ms (1211 px to go)`);
  // one announcement, at the arrival
  const autos = r.rec.recenter.filter((e) => e.kind === 'auto');
  assert.equal(autos.length, 1);
  assert.ok(Math.abs(autos[0].t - rows[arrived].t) <= DT + 1);
  assert.equal(r.rec.recenter.length, 1, 'no other kind of recenter');
  assert.ok(rows.slice(arrived + 1).every((p) => !p.refDriven), 'nothing is driven once it has arrived');
});

test('idle auto-centre: a cursor that is already close arrives silently (no auto event under 40 px of travel); it starts only below 8 deg/s and stops above 14 deg/s', () => {
  const near = rel({ settings: { autoCenter: true } });
  near.pipe.reanchor(985, 560); // 32 px away
  run(near, near.stream.hold(120, 0));
  assert.ok(dist(near.rec.blades.at(-1)) <= 0.5, 'still brought to the centre');
  assert.equal(near.rec.recenter.length, 0, '32 px of travel is under the 40 px announcement limit');

  // 10 deg/s keeps the idle timer at zero: the glide never starts (the cursor only follows the slow motion, 25 px/s)
  const slow = rel({ settings: { autoCenter: true } });
  slow.pipe.reanchor(300, 300);
  const slowRows = run(slow, slow.stream.hold(150, 0, 10)); // 5 s of vertical 10 deg/s
  assert.ok(slowRows.every((p) => !p.refDriven && !p.centring), 'above 8 deg/s the idle hold never completes');
  assert.ok(slowRows.at(-1).x === 300, 'x untouched');

  // 7.9 deg/s starts it (and is inside the dead zone or just above it: the cursor barely moves by itself)
  const calm = rel({ settings: { autoCenter: true } });
  calm.pipe.reanchor(300, 300);
  const calmRows = run(calm, calm.stream.hold(120, 7.9));
  assert.ok(calmRows.some((p) => p.refDriven), 'below 8 deg/s the glide starts');

  // once it runs, 10 deg/s (between 8 and 14) does not stop it, 15 deg/s stops it at once and the hold starts over
  const r = rel({ settings: { autoCenter: true } });
  r.pipe.reanchor(200, 900);
  run(r, r.stream.hold(50, 0)); // 1.5 s: centring has started
  assert.equal(r.pipe.getDebug().pointer.centring, true);
  const mid = run(r, r.stream.hold(5, 0, 10));
  assert.ok(mid.every((p) => p.centring) && mid.some((p) => p.refDriven), '10 deg/s: the glide goes on');
  const stop = run(r, r.stream.hold(1, 0, 15));
  assert.equal(stop[0].centring, false, '15 deg/s stops it at once');
  assert.equal(stop[0].refDriven, false);
  assert.equal(stop[0].idle, 0);
  const after = run(r, r.stream.hold(30, 0)); // 0.9 s: not yet
  assert.ok(after.every((p) => !p.refDriven), 'the 1.0 s hold starts over');
  const later = run(r, r.stream.hold(10, 0));
  assert.ok(later.some((p) => p.refDriven), 'and the glide resumes after it');
});

test('idle auto-centre never runs while cutting and waits 500 ms after a swing before its 1.0 s hold starts; autoCenter: false never moves the cursor and stops a glide at once', () => {
  const r = rel({ settings: { autoCenter: true } });
  r.pipe.reanchor(960, 900);
  run(r, r.stream.hold(50, 0)); // the glide is running
  assert.equal(r.pipe.getDebug().pointer.centring, true);
  const swing = run(r, r.stream.each([400, 400, 400, 400, 0]));
  assert.ok(swing.every((p) => !p.refDriven), 'no glide during or right after a cut');
  const lastCut = swing.filter((p) => p.cutting).at(-1).t;
  const rest = run(r, r.stream.hold(70, 0));
  const first = rest.find((p) => p.refDriven);
  assert.ok(first, 'the glide comes back');
  assert.ok(first.t - lastCut >= 500 + 1000 - 1, `first driven sample ${(first.t - lastCut).toFixed(0)} ms after the last cutting sample (500 ms quiet + 1.0 s hold)`);
  assert.ok(rest.filter((p) => p.t - lastCut < 1500 - DT).every((p) => !p.refDriven && !p.centring));

  const off = rel({ settings: { autoCenter: false } });
  off.pipe.reanchor(100, 100);
  const offRows = run(off, off.stream.hold(300, 0));
  assert.ok(offRows.every((p) => p.x === 100 && p.y === 100 && !p.refDriven), 'autoCenter off: the cursor never moves by itself');
  const live = rel({ settings: { autoCenter: true } });
  live.pipe.reanchor(100, 100);
  run(live, live.stream.hold(60, 0));
  assert.equal(live.pipe.getDebug().pointer.centring, true);
  live.pipe.setSettings({ autoCenter: false });
  const stopped = run(live, live.stream.hold(2, 0));
  assert.ok(stopped.every((p) => !p.refDriven && !p.centring));
});

test('idle auto-centre: a hole in the stream restarts the hold, and a lost track stops the glide', () => {
  const r = rel({ settings: { autoCenter: true } });
  r.pipe.reanchor(200, 200);
  run(r, r.stream.hold(45, 0));
  assert.equal(r.pipe.getDebug().pointer.centring, true);
  r.stream.skip(300); // a hole of 330 ms: a discontinuity
  const rows = run(r, r.stream.hold(3, 0));
  assert.ok(rows[0].disc && !rows[0].centring && rows[0].idle === 0, 'the hole restarts the hold');
  assert.ok(rows.every((p) => !p.refDriven));
});

// ------------------------------------------------------------------------------------------------------------- recenter, reanchor, holes

test('recenter: the cursor goes to the centre, the emitted samples ease from the old position over 150 ms as discontinuities, the motion since the call is kept', () => {
  const r = rel();
  feed(r.pipe, r.stream.each([0, { vR: 300 }, { vR: 300 }, { vR: 300 }, { vR: 0 }, { vR: 0 }]));
  const old = lastBlade(r.rec);
  assert.ok(old.x > 1100, `the cursor is at ${old.x}`);
  r.pipe.recenter('manual');
  assert.equal(r.rec.recenter.length, 1);
  assert.equal(r.rec.recenter[0].kind, 'manual');
  const rows = run(r, r.stream.hold(8, 100)); // the sword keeps turning right at 100 deg/s (678 px/s)
  const easing = rows.filter((p) => p.disc);
  assert.ok(easing.length >= 4 && easing.length <= 6, `${easing.length} eased samples`);
  assert.ok(easing.every((p) => p.refDriven && !p.cutting), 'eased samples are reference driven and never cut');
  assert.ok(rows.slice(0, easing.length).every((p) => p.disc), 'the eased samples come first');
  for (let i = 1; i < easing.length; i += 1) assert.ok(easing[i].x < easing[i - 1].x, 'the cursor glides towards the centre');
  assert.ok(easing[0].x < old.x + 1 && easing[0].x > 960);
  const settled = rows.slice(easing.length);
  assert.ok(settled.every((p) => !p.disc && !p.refDriven));
  // after the ease: the centre plus the motion since the call (about 678 px/s x elapsed, minus what the ease still owed)
  const elapsed = (settled[0].t - old.t) / 1000;
  assert.ok(Math.abs(settled[0].x - (960 + 678 * elapsed)) < 15, `${settled[0].x.toFixed(1)} against ${(960 + 678 * elapsed).toFixed(1)}`);
  // reconnect is a valid kind, anything else is a manual one
  r.pipe.recenter('reconnect');
  r.pipe.recenter('whatever');
  assert.deepEqual(r.rec.recenter.map((e) => e.kind), ['manual', 'reconnect', 'manual']);
});

test('recenter: ignored without a calibration, during the full wizard and for the aim source; before any sample it only announces', () => {
  const bare = createMotionPipeline({ pointerModel: 'relative' });
  const rec = record(bare);
  bare.recenter('manual');
  assert.equal(rec.recenter.length, 0, 'no calibration: nothing to centre');
  const fresh = rel();
  fresh.pipe.recenter('manual');
  assert.equal(fresh.rec.recenter.length, 1);
  feed(fresh.pipe, fresh.stream.each([0, 0, 0]));
  assert.ok(fresh.rec.blades.slice(1).every((b) => !b.discontinuity), 'no sample to ease from: no ease');
  const aim = rel();
  aim.pipe.pushAim({ t: 10, x: 100, y: 100, discontinuity: true });
  aim.pipe.recenter('manual');
  assert.equal(aim.rec.recenter.length, 0, 'the aim source has nothing to re-reference');
  const wiz = createMotionPipeline({ pointerModel: 'relative' });
  const wrec = record(wiz);
  wiz.setCalibration(mountCalibration());
  wiz.startCalibration({ side: 'R' });
  wiz.recenter('manual');
  assert.equal(wrec.recenter.length, 0, 'the full wizard blocks it');
});

test('reanchor: the cursor is put at the point at the next IMU sample (discontinuity, no cutting), clamped to the field; ignored without a calibration', () => {
  const r = rel();
  feed(r.pipe, r.stream.each([0, 0]));
  r.pipe.reanchor(1234, 321);
  assert.notEqual(r.pipe.latest().x, 1234, 'applied at the next sample, not at the call');
  feed(r.pipe, r.stream.each([{ vR: 500 }]));
  const b = r.pipe.latest();
  assert.equal(b.x, 1234);
  assert.equal(b.y, 321);
  assert.equal(b.discontinuity, true);
  assert.equal(b.cutting, false);
  feed(r.pipe, r.stream.each([{ vR: 100 }]));
  assert.ok(r.pipe.latest().x > 1234 && !r.pipe.latest().discontinuity, 'the motion goes on from there');
  r.pipe.reanchor(-500, 5000);
  feed(r.pipe, r.stream.each([0]));
  assert.deepEqual([r.pipe.latest().x, r.pipe.latest().y], [0, 1080]);
  r.pipe.reanchor(NaN, 10);
  feed(r.pipe, r.stream.each([0]));
  assert.ok(!r.pipe.latest().discontinuity, 'a non-finite point is ignored');
  const bare = createMotionPipeline({ pointerModel: 'relative' });
  bare.reanchor(10, 10);
  assert.equal(bare.getState().x, 960);
});

test('a stroke does not cut across a reanchor: the candidate dies and the new swing needs two fast samples again', () => {
  const r = rel();
  feed(r.pipe, r.stream.each([0, 400]));
  r.pipe.reanchor(100, 100);
  feed(r.pipe, r.stream.each([400, 400, 400]));
  assert.deepEqual(r.rec.blades.map((b) => b.cutting), [false, false, false, false, true]);
});

test('markDiscontinuity("lost"): the next sample is a discontinuity, the cursor does not move across the hole, nothing is re-referenced; recenter("reconnect") stays valid', () => {
  const r = rel();
  feed(r.pipe, r.stream.each([0, { vR: 200 }, { vR: 200 }, { vR: 200 }]));
  const before = r.pipe.latest();
  r.pipe.markDiscontinuity('lost');
  feed(r.pipe, r.stream.each([{ vR: 200 }]));
  const after = r.pipe.latest();
  assert.equal(after.discontinuity, true);
  assert.equal(after.x, before.x, 'the cursor does not jump, it does not move either');
  assert.equal(after.y, before.y);
  feed(r.pipe, r.stream.each([{ vR: 200 }]));
  assert.ok(r.pipe.latest().x > before.x, 'and moves on afterwards');
  assert.equal(r.rec.recenter.length, 0, 'the relative model re-references nothing on a lost link');
  feed(r.pipe, r.stream.hold(2, 0)); // the sword comes to rest
  r.pipe.recenter('reconnect');
  assert.deepEqual(r.rec.recenter.map((e) => e.kind), ['reconnect']);
  feed(r.pipe, r.stream.hold(6, 0));
  assert.ok(Math.abs(r.pipe.latest().x - 960) < 1 && Math.abs(r.pipe.latest().y - 540) < 1, 'recenter centres the cursor');
  // a hole of more than orientationResetGapMs is treated the same way: no re-reference, no jump
  const g = rel();
  feed(g.pipe, g.stream.each([0, { vR: 200 }, { vR: 200 }]));
  const x0 = g.pipe.latest().x;
  g.stream.skip(1500);
  feed(g.pipe, g.stream.each([{ vR: 200 }]));
  assert.equal(g.pipe.latest().x, x0);
  assert.equal(g.pipe.latest().discontinuity, true);
  assert.equal(g.rec.recenter.length, 0);
});

test('reset() and setCalibration(): the cursor goes to the centre, the velocity memory is cleared, the next sample is a discontinuity and moves nothing', () => {
  const r = rel();
  feed(r.pipe, r.stream.each([0, { vR: 300 }, { vR: 300 }, { vR: 300 }]));
  assert.ok(r.pipe.latest().x > 1100);
  r.pipe.setCalibration(mountCalibration());
  feed(r.pipe, r.stream.each([{ vR: 300 }]));
  assert.equal(r.pipe.latest().x, 960, 'a new calibration starts the cursor at the centre and integrates nothing on its first sample');
  assert.equal(r.pipe.latest().discontinuity, true);
  feed(r.pipe, r.stream.each([{ vR: 300 }]));
  assert.ok(r.pipe.latest().x > 960);
  r.pipe.reset();
  r.rec.resetTime();
  assert.equal(r.pipe.getState().x, 960);
  assert.equal(r.pipe.latest(), null);
  assert.deepEqual(r.pipe.recent(1e9), []);
  assert.deepEqual(r.pipe.drainSegments(), []);
  assert.ok(r.pipe.getCalibration(), 'reset keeps the calibration');
  const s2 = createTipStream({});
  feed(r.pipe, s2.each([{ vR: 300 }, { vR: 300 }]));
  assert.equal(r.rec.blades.at(-2).discontinuity, true);
  assert.equal(r.rec.blades.at(-2).x, 960);
  // the swing counter restarts too
  feed(r.pipe, s2.each([400, 400]));
  assert.equal(r.pipe.latest().swingId, 1);
  r.pipe.setCalibration(null);
  feed(r.pipe, s2.each([400, 400]));
  assert.equal(r.pipe.getState().calibrated, false);
});

test('poll: a lost track (200 ms without a sample) ends CUTTING with one synthetic sample; the first real sample afterwards is a discontinuity and a new swing', () => {
  const r = rel();
  feed(r.pipe, r.stream.each([0, 400, 400, 400]));
  const last = r.pipe.latest();
  assert.equal(last.cutting, true);
  r.pipe.poll(last.t + 100);
  assert.equal(r.pipe.latest(), last, 'nothing before 200 ms');
  r.pipe.poll(last.t + 250);
  const lost = r.pipe.latest();
  assert.notEqual(lost, last);
  assert.equal(lost.trackingOk, false);
  assert.equal(lost.cutting, false);
  assert.equal(lost.speed, 0);
  assert.equal(lost.speedDps, 0);
  assert.equal(lost.source, 'imu');
  assert.equal(lost.discontinuity, false);
  assert.equal([lost.x, lost.y].join(), [last.x, last.y].join());
  assert.equal(r.pipe.getState().trackingOk, false);
  r.pipe.poll(last.t + 400);
  assert.equal(r.pipe.latest(), lost, 'only one synthetic sample');
  r.stream.skip(250);
  feed(r.pipe, r.stream.each([400, 400, 400]));
  const after = r.rec.blades.slice(r.rec.blades.indexOf(lost) + 1);
  assert.equal(after[0].discontinuity, true);
  assert.equal(after[0].x, last.x, 'no jump');
  assert.equal(after[0].cutting, false);
  assert.equal(after[1].cutting, false, 'one fast sample is only a candidate');
  assert.ok(after[2].cutting && after[2].swingId === last.swingId + 1, 'a new swing');
  assert.equal(r.pipe.getState().trackingOk, true);
});

test('sensitivity and flipX changes take effect on the next sample and raise no discontinuity in the relative model (the cursor does not jump)', () => {
  const r = rel({ settings: { autoCenter: false } });
  feed(r.pipe, r.stream.each([0, { vR: 100 }, { vR: 100 }]));
  const x0 = r.pipe.latest().x;
  r.pipe.setSettings({ sensitivity: 2.0 });
  feed(r.pipe, r.stream.each([{ vR: 100 }]));
  const b = r.pipe.latest();
  assert.equal(b.discontinuity, false);
  // the trapezoid of that step still starts from the old velocity (678 px/s) and ends at the new one (1356 px/s): no jump
  assert.ok(Math.abs(b.x - x0 - 0.5 * (678.2 + 1356.4) * (DT / 1000)) < 1.5, `the step is the average of the two speeds: ${(b.x - x0).toFixed(1)} px`);
  feed(r.pipe, r.stream.each([{ vR: 100 }]));
  assert.ok(Math.abs(r.pipe.latest().x - b.x - 1356.4 * (DT / 1000)) < 1.5, 'and the one after is twice as long as it was');
  const beforeFlip = r.pipe.latest().x;
  r.pipe.setSettings({ flipX: true });
  feed(r.pipe, r.stream.each([{ vR: 100 }]));
  const c = r.pipe.latest();
  assert.equal(c.discontinuity, false);
  assert.ok(Math.abs(c.x - beforeFlip) < 1e-6, 'the trapezoid of the flip step averages +v and -v: the cursor does not jump');
  feed(r.pipe, r.stream.each([{ vR: 100 }]));
  assert.ok(Math.abs(r.pipe.latest().x - (c.x - 1356.4 * (DT / 1000))) < 1.5, 'and then moves the other way');
  assert.equal(r.rec.blades.filter((x) => x.discontinuity).length, 1, 'only the first sample');
});

test('a second full wizard on a running relative pipeline replaces the calibration and ends with the cursor at the centre', () => {
  const r = calibratedPipeline({ mount: 'faceUp', side: 'R', hz: 66, seed: 41 }, { pointerModel: 'relative', settings: { autoCenter: false } });
  play(r, [{ t: 0, yaw: 0, pitch: 0 }, { t: 600, yaw: 25, pitch: 8 }, { t: 800, yaw: 25, pitch: 8 }]);
  assert.ok(lastBlade(r.rec).x > 1000);
  const again = runCalibration({ mount: 'tilted', side: 'L', hz: 66, seed: 42, startMs: r.pipe.getState().lastSampleT + 2000 }, { pipe: r.pipe });
  assert.ok(again.done, 'the second wizard finished');
  assert.equal(r.pipe.getCalibration().side, 'L');
  const b = r.pipe.latest();
  assert.ok(Math.abs(b.x - 960) < 1 && Math.abs(b.y - 540) < 1, `the cursor is at the centre: ${b.x}, ${b.y}`);
});

// ------------------------------------------------------------------------------------------------------------- the calibration flows

test('the wizard ends with the cursor at the centre in the relative model (recenter "calibration"), and the quick recentre does the same after the cursor moved', () => {
  for (const [mount, side] of [['faceUp', 'R'], ['tilted', 'L'], ['sideRail', 'R']]) {
    const r = calibratedPipeline({ mount, side, hz: 66, seed: 77 }, { pointerModel: 'relative', settings: { autoCenter: false } });
    assert.ok(r.done, `${mount}: the wizard finished`);
    const c = lastBlade(r.rec);
    assert.ok(Math.abs(c.x - 960) < 1 && Math.abs(c.y - 540) < 1, `${mount}: centre ${c.x}, ${c.y}`);
    assert.ok(r.rec.recenter.some((e) => e.kind === 'calibration'));
    const cal = r.pipe.getCalibration();
    assert.equal(cal.side, side);
    // move the cursor away with a slow sweep to the right and up
    play(r, [{ t: 0, yaw: 0, pitch: 0 }, { t: 600, yaw: 25, pitch: 8 }, { t: 900, yaw: 25, pitch: 8 }]);
    const away = lastBlade(r.rec);
    assert.ok(away.x > 1000 && away.y < 520, `${mount}: moved to ${away.x.toFixed(0)}, ${away.y.toFixed(0)}`);
    assert.equal(r.rec.blades.some((b) => b.cutting), false, 'slow aiming never cuts');
    // the quick recentre: hold still 1.5 s
    r.pipe.beginQuickRecenter();
    play(r, [{ t: 0, yaw: 25, pitch: 8 }, { t: 2500, yaw: 25, pitch: 8 }]);
    const done = r.rec.calibration.filter((e) => e.type === 'done');
    assert.equal(done.length, 2);
    assert.equal(done[1].quick, true);
    const back = lastBlade(r.rec);
    assert.ok(Math.abs(back.x - 960) < 1 && Math.abs(back.y - 540) < 1, `${mount}: quick recentre ends at the centre, got ${back.x.toFixed(1)}, ${back.y.toFixed(1)}`);
    assert.equal(r.rec.recenter.filter((e) => e.kind === 'calibration').length, 2);
  }
});

test('the full wizard still finds the mount in the relative model: a fast swing afterwards cuts, a slow sweep never does, on all six mounts', () => {
  for (const mount of ['faceUp', 'faceSide', 'upsideDown', 'tipFlipped', 'tilted', 'sideRail']) {
    const r = calibratedPipeline({ mount, side: 'R', hz: 66, seed: 300 }, { pointerModel: 'relative', settings: { autoCenter: false } });
    play(r, [{ t: 0, yaw: 0, pitch: 0 }, { t: 1200, yaw: 40, pitch: 0 }, { t: 1500, yaw: 40, pitch: 0 }]);
    assert.equal(r.rec.blades.some((b) => b.cutting), false, `${mount}: a 40 degree sweep in 1.2 s (about 50 deg/s at its peak) is not a swing`);
    play(r, [{ t: 0, yaw: 40, pitch: 0 }, { t: 160, yaw: -40, pitch: 0 }, { t: 500, yaw: -40, pitch: 0 }]);
    assert.equal(r.rec.blades.some((b) => b.cutting), true, `${mount}: 80 degrees in 160 ms is a swing`);
    assert.ok(r.pipe.drainSegments().length >= 5);
  }
});

test('a saved calibration needs no wizard: getCalibration() survives JSON, a fresh pipeline that loads it points exactly like the original', () => {
  const a = createMotionPipeline({ pointerModel: 'relative' });
  a.setCalibration(realCalibration({ side: 'L' }));
  const saved = JSON.parse(JSON.stringify(a.getCalibration()));
  assert.equal(saved.side, 'L');
  const b = createMotionPipeline({ pointerModel: 'relative' });
  assert.equal(b.getState().calibrated, false);
  b.setCalibration(saved);
  assert.equal(b.getState().calibrated, true, 'calibrated without any wizard step');
  const ra = replay('fast_swings_v', { fromS: 0, toS: 5, calibration: realCalibration({ side: 'L' }) });
  const rb = replay('fast_swings_v', { fromS: 0, toS: 5, calibration: saved });
  assert.deepEqual(rb.rows.map((r) => [r.x, r.y, r.cutting]), ra.rows.map((r) => [r.x, r.y, r.cutting]));
  assert.ok(rb.rows.some((r) => r.cutting));
  assert.deepEqual(rb.pipe.getCalibration().frame, ra.pipe.getCalibration().frame);
  // the online bias estimate stays inside the calibration document that would be saved next
  assert.ok(Number.isFinite(rb.pipe.getCalibration().gyroBiasDps.x));
});

test('the simulator keeps its absolute model: 10 degrees of yaw are still 274 px, and the tuning of the threshold units does not change its cursor', () => {
  const r = calibratedPipeline({ mount: 'faceUp', hz: 66, seed: 12 }, { pointerModel: 'absolute' });
  play(r, [{ t: 0, yaw: 0, pitch: 0 }, { t: 500, yaw: 10, pitch: 0 }, { t: 900, yaw: 10, pitch: 0 }]);
  const b = lastBlade(r.rec);
  assert.ok(Math.abs(b.x - (960 + 274)) < 15, `${b.x}`);
  assert.equal(r.pipe.getState().pointerModel, 'absolute');
  assert.notEqual(r.pipe.getState().yawDeg, null);
  assert.ok(b.interpolated === false && b.vx === 0 && b.vy === 0);
  // the px tracker applies T x 10/3: a sweep at 50 deg/s is 1370 px/s > 1000, it cuts, and the same sweep at T = 450 deg/s (1500 px/s) does not
  // (a smoothstep of 25 degrees in 800 ms peaks at 47 deg/s = 1285 px/s at 27.4 px/deg: above 1000 px/s, below 1500 px/s)
  const swing = [{ t: 0, yaw: 0, pitch: 0 }, { t: 800, yaw: 25, pitch: 0 }, { t: 1000, yaw: 25, pitch: 0 }];
  const run1 = calibratedPipeline({ mount: 'faceUp', hz: 66, seed: 13 }, { pointerModel: 'absolute', settings: { autoCenter: false } });
  play(run1, swing);
  assert.equal(run1.rec.blades.some((x) => x.cutting), true, 'T = 300 deg/s = 1000 px/s');
  const run2 = calibratedPipeline({ mount: 'faceUp', hz: 66, seed: 13 }, { pointerModel: 'absolute', settings: { autoCenter: false, cutThreshold: 450 } });
  play(run2, swing);
  assert.equal(run2.rec.blades.some((x) => x.cutting), false, 'T = 450 deg/s = 1500 px/s');
});

// ------------------------------------------------------------------------------------------------------------- real-world timing

test('rates, jitter, bursts and lost packets: a slow sweep never cuts and a fast swing cuts as one swing, at 33, 66 and 250 Hz, with arrival-time steps and 20 % loss', () => {
  const slowSweep = [{ t: 0, yaw: 0, pitch: 0 }, { t: 1200, yaw: 40, pitch: 0 }, { t: 1500, yaw: 40, pitch: 0 }];
  const fastSwing = [{ t: 0, yaw: 40, pitch: 0 }, { t: 160, yaw: -40, pitch: 0 }, { t: 600, yaw: -40, pitch: 0 }];
  for (const [hz, opts] of [[33, {}], [33, { tJitterMs: 4, dtFromArrival: true }], [66, { tJitterMs: 3 }], [66, { dropRate: 0.2 }], [250, {}]]) {
    for (const mount of ['faceUp', 'tilted']) {
      const label = `${hz} Hz ${JSON.stringify(opts)} ${mount}`;
      const r = calibratedPipeline({ mount, side: 'R', hz, seed: 600 + hz, ...opts }, { pointerModel: 'relative', settings: { autoCenter: false } });
      play(r, slowSweep);
      assert.equal(r.rec.blades.some((b) => b.cutting), false, `${label}: a slow sweep never cuts`);
      const before = r.rec.blades.length;
      play(r, fastSwing);
      const fast = r.rec.blades.slice(before);
      const cutting = fast.filter((b) => b.cutting);
      assert.ok(cutting.length >= 1, `${label}: the swing cuts`);
      assert.equal(new Set(cutting.map((b) => b.swingId)).size, 1, `${label}: as one swing`);
      const segs = r.rec.drain();
      assert.ok(segs.length >= 3, `${label}: ${segs.length} chords`);
      assert.ok(Math.max(...segs.map((x) => Math.hypot(x.x1 - x.x0, x.y1 - x.y0))) <= 2 * PTR.maxChordPx + 1, `${label}: no chord longer than twice maxChordPx`);
      for (let i = 1; i < segs.length; i += 1) assert.ok(segs[i].t0 >= segs[i - 1].t0, `${label}: chords in order`);
      const ring = r.pipe.recent(1e9);
      for (let i = 1; i < ring.length; i += 1) assert.ok(ring[i].t >= ring[i - 1].t, `${label}: the ring is chronological`);
      assert.ok(!r.rec.warning.some((w) => w.code === 'gyro_saturated'), `${label}: no saturation`);
    }
  }
});

// ------------------------------------------------------------------------------------------------------------- fuzz

test('fuzz: 30 000 random relative samples with holes, resets, recentres, reanchors and settings changes keep every contract invariant', () => {
  const rng = createRng(20260930);
  const clock = createManualClock();
  const pipe = createMotionPipeline({ pointerModel: 'relative', clock });
  const rec = record(pipe);
  pipe.setCalibration(mountCalibration('tilted', 'R'));
  const stream = createTipStream({ mount: 'tilted', hz: 33 });
  const pick = (a) => a[Math.floor(rng.next() * a.length)];
  for (let i = 0; i < 30000; i += 1) {
    const roll = rng.next();
    if (roll < 0.002) pipe.markDiscontinuity(pick(['lost', 'other']));
    else if (roll < 0.004) pipe.recenter(pick(['manual', 'reconnect']));
    else if (roll < 0.005) pipe.reanchor(rng.next() * 2200 - 140, rng.next() * 1300 - 110);
    else if (roll < 0.0055) { pipe.reset(); rec.resetTime(); }
    else if (roll < 0.006) pipe.setCalibration(mountCalibration(pick(['faceUp', 'tilted', 'sideRail']), 'R'));
    else if (roll < 0.012) pipe.setSettings({ sensitivity: 0.2 + rng.next() * 2, cutThreshold: rng.next() * 900, cutMul: pick([0.8, 1, 2]), autoCenter: rng.next() < 0.7, flipX: rng.next() < 0.3 });
    else if (roll < 0.014) stream.skip(pick([60, 150, 250, 1200]));
    else if (roll < 0.015) stream.nullDt();
    const kind = rng.next();
    const mag = kind < 0.45 ? 0 : kind < 0.65 ? rng.next() * 12 : kind < 0.85 ? rng.next() * 250 : kind < 0.97 ? rng.next() * 1100 : pick([2100, 2190, 2500, 4000]);
    const ang = rng.next() * Math.PI * 2;
    const s = stream.each([{ vR: mag * Math.cos(ang), vU: mag * Math.sin(ang), roll: rng.next() < 0.1 ? (rng.next() - 0.5) * 2000 : 0 }])[0];
    feed(pipe, [s], { poll: false });
    clock.set?.(s.t);
    if (rng.next() < 0.03) pipe.poll(s.t + pick([10, 250, 600]));
    for (const seg of rec.drain()) {
      assert.ok(Number.isFinite(seg.t0 + seg.t1 + seg.x0 + seg.x1 + seg.y0 + seg.y1) && seg.speed > 0 && seg.t1 >= seg.t0, 'a valid segment');
      assert.ok(seg.x0 >= 0 && seg.x0 <= 1920 && seg.x1 >= 0 && seg.x1 <= 1920 && seg.y0 >= 0 && seg.y0 <= 1080 && seg.y1 >= 0 && seg.y1 <= 1080);
    }
    const st = pipe.getState();
    assert.ok(Number.isFinite(st.x + st.y + st.speed + st.speedDps) && st.x >= 0 && st.x <= 1920 && st.y >= 0 && st.y <= 1080);
    const h = pipe.headAt(s.t + pick([0, 8, 20, 50]));
    assert.ok(h && h.x >= 0 && h.x <= 1920 && h.y >= 0 && h.y <= 1080 && Number.isFinite(h.x + h.y));
  }
  rec.check();
  assert.ok(rec.blades.length > 25000);
  assert.ok(rec.blades.some((b) => b.cutting) && rec.blades.some((b) => b.discontinuity) && rec.blades.some((b) => b.segmentValid));
  for (const b of rec.blades) if (b.segmentValid) assert.ok(b.cutting && !b.discontinuity);
  const ring = pipe.recent(1e9);
  assert.ok(ring.length <= MOTION_CONFIG.tracker.historySize);
  for (let i = 1; i < ring.length; i += 1) assert.ok(ring[i].t >= ring[i - 1].t, 'the ring stays chronological');
  for (const b of ring) assertValid('BladeSample', b);
  assert.ok(pipe.drainSegments().length <= MOTION_CONFIG.tracker.segmentQueueMax);
});

test('the stream with a duplicate report (dtMs null right behind the previous sample) neither breaks a swing nor moves the cursor', () => {
  const r = rel();
  feed(r.pipe, r.stream.each([0, 400, 400]));
  const x0 = r.pipe.latest().x;
  r.stream.nullDt();
  feed(r.pipe, r.stream.each([400]));
  const dup = r.pipe.latest();
  assert.equal(dup.discontinuity, false, 'a duplicate is not a hole');
  assert.equal(dup.cutting, true);
  assert.ok(dup.x === x0, 'nothing integrates over an unknown step');
  feed(r.pipe, r.stream.each([400]));
  assert.ok(r.pipe.latest().x > x0 && r.pipe.latest().cutting);
  assert.equal(r.pipe.latest().swingId, 1);
});
