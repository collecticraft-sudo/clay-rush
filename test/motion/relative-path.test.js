// The path between two IMU samples in the relative model (docs/motion-contract.md 2.5): collision chords, the trail ring with interpolated
// samples, head extrapolation, and the new BladeSample / MotionState fields (4.2, 4.3).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMotionPipeline, MOTION_CONFIG } from '../../public/js/motion/index.js';
import { planChords, planTrail, extrapolateHead, pathPoint } from '../../public/js/motion/pointer.js';
import { createTipStream, mountCalibration } from '../../test-support/motion/tip-stream.js';
import { createAbsolutePipeline, feed, record } from '../../test-support/motion/harness.js';

const PTR = MOTION_CONFIG.pointer;

function rel({ hz = 33, settings = {}, mount = 'faceUp', config } = {}) {
  const pipe = createMotionPipeline({ pointerModel: 'relative', settings: { autoCenter: false, ...settings }, config });
  const rec = record(pipe);
  pipe.setCalibration(mountCalibration(mount));
  return { pipe, rec, stream: createTipStream({ mount, hz }) };
}

// ------------------------------------------------------------------------------------------------------------ pure path helpers

const interval = (o = {}) => ({ x0: 500, y0: 300, vx0: 0, vy0: 0, s0: 0, t0: 1000, x1: 500, y1: 300, vx1: 0, vy1: 0, s1: 0, ax: 0, ay: 0, haveInterval: true, carried: false, carryDx: 0, carryDy: 0, ...o });

test('pathPoint: the position is quadratic in time (velocity linear), clamped to the playfield, ends exactly at the interval end', () => {
  // constant velocity 1000 px/s over 30 ms: 30 px, linear
  const o = interval({ vx0: 1000, vx1: 1000, x1: 530 });
  const p = { x: 0, y: 0 };
  pathPoint(o, 0.015, 0.03, p);
  assert.ok(Math.abs(p.x - 515) < 1e-9 && p.y === 300);
  // velocity 0 -> 2000 px/s: x(t) = 0.5 * (2000 / 0.03) t^2, x(dt) = 30 px = the trapezoid
  const acc = interval({ vx1: 2000, x1: 530 });
  pathPoint(acc, 0.015, 0.03, p);
  assert.ok(Math.abs(p.x - (500 + 0.5 * (2000 / 0.03) * 0.015 * 0.015)) < 1e-9);
  pathPoint(acc, 0.03, 0.03, p);
  assert.ok(Math.abs(p.x - 530) < 1e-9, 'the free path ends at the trapezoid end point');
  // clamping
  const edge = interval({ x0: 1915, x1: 1920, vx0: 5000, vx1: 5000 });
  pathPoint(edge, 0.02, 0.03, p);
  assert.equal(p.x, 1920);
  // a centring displacement is spread linearly, so the path still ends at x1
  const carried = interval({ x1: 500 + 12, carried: true, carryDx: 12 });
  pathPoint(carried, 0.015, 0.03, p);
  assert.ok(Math.abs(p.x - 506) < 1e-9);
});

test('planChords: n = ceil(len / 48) sub-steps, at least 1, at most 32, contiguous, the last one ends exactly at the end point, speeds interpolated x 10/3', () => {
  const cfg = MOTION_CONFIG;
  const still = planChords(interval(), 1000, 1030, 30, cfg);
  assert.equal(still.length, 1, 'no motion: one (empty) chord');
  // 408 px in one interval (the owner\'s fastest stroke): about 9 chords, none longer than 2 x 48
  const fast = interval({ x0: 300, x1: 708, vx0: 13000, vx1: 14000, s0: 950, s1: 1000 });
  const ch = planChords(fast, 1000, 1030, 30, cfg);
  assert.ok(ch.length >= 8 && ch.length <= 10, `${ch.length} chords`);
  assert.equal(ch[0].t0, 1000);
  assert.equal(ch[0].x0, 300);
  assert.equal(ch.at(-1).t1, 1030);
  assert.equal(ch.at(-1).x1, 708);
  for (let i = 1; i < ch.length; i += 1) assert.ok(ch[i].t0 === ch[i - 1].t1 && ch[i].x0 === ch[i - 1].x1 && ch[i].y0 === ch[i - 1].y1, 'contiguous');
  assert.ok(Math.max(...ch.map((c) => Math.hypot(c.x1 - c.x0, c.y1 - c.y0))) <= 2 * PTR.maxChordPx);
  assert.ok(Math.abs(ch.at(-1).speed - 1000 * (10 / 3)) < 1e-9 && ch[0].speed > 950 * (10 / 3));
  // a lost packet (60 ms at full speed) is cut into more chords but never more than maxSubSteps
  const gap = planChords(interval({ x0: 100, x1: 1500, vx0: 14000, vx1: 14000, s0: 1000, s1: 1000 }), 1000, 1060, 60, cfg);
  assert.ok(gap.length <= PTR.maxSubSteps && gap.length >= 25, `${gap.length}`);
  const huge = planChords(interval({ x0: 0, x1: 1900, vx0: 14000, vx1: 14000 }), 1000, 1200, 200, cfg);
  assert.equal(huge.length, PTR.maxSubSteps, 'capped at 32 sub-steps');
  assert.ok(ch.every((c) => c.speed > 0 && c.swingId === 0));
});

test('planTrail: m = clamp(ceil(dt / 8 ms), 1, 8) points per interval, the real sample being the last one', () => {
  const cfg = MOTION_CONFIG;
  const count = (dt) => planTrail(interval({ x1: 600, vx0: 1000, vx1: 1000 }), 1000, 1000 + dt, dt, cfg).length;
  assert.equal(count(4), 0, '250 Hz: no interpolation needed');
  assert.equal(count(8), 0);
  assert.equal(count(10), 1);
  assert.equal(count(15), 1);
  assert.equal(count(16.1), 2);
  assert.equal(count(30), 3);
  assert.equal(count(60), 7);
  assert.equal(count(64), 7);
  assert.equal(count(200), 7, 'capped at 8 steps');
  const pts = planTrail(interval({ x1: 530, vx0: 1000, vx1: 1000 }), 1000, 1030, 30, cfg);
  assert.deepEqual(pts.map((p) => p.t), [1007.5, 1015, 1022.5]);
  assert.ok(pts.every((p) => Math.abs(p.vx - 1000) < 1e-9));
});

test('extrapolateHead: velocity and acceleration, at most 35 ms, never reversing, exactly the sample when there is nothing to extrapolate', () => {
  const b = { x: 500, y: 300, t: 1000 };
  const same = extrapolateHead(b, { vx: 5000, vy: 0, ax: 0, ay: 0 }, 1000, PTR);
  assert.deepEqual(same, { x: 500, y: 300 });
  assert.deepEqual(extrapolateHead(b, { vx: 5000, vy: 0, ax: 0, ay: 0 }, 900, PTR), { x: 500, y: 300 }, 'a clock behind the sample');
  const lin = extrapolateHead(b, { vx: 5000, vy: -1000, ax: 0, ay: 0 }, 1020, PTR);
  assert.ok(Math.abs(lin.x - 600) < 1e-9 && Math.abs(lin.y - 280) < 1e-9);
  const capped = extrapolateHead(b, { vx: 5000, vy: 0, ax: 0, ay: 0 }, 1500, PTR);
  assert.ok(Math.abs(capped.x - (500 + 5000 * 0.035)) < 1e-9, 'never further than 35 ms');
  const acc = extrapolateHead(b, { vx: 1000, vy: 0, ax: 100000, ay: 0 }, 1030, PTR);
  assert.ok(Math.abs(acc.x - (500 + 1000 * 0.03 + 0.5 * 100000 * 0.03 * 0.03)) < 1e-9);
  // decelerating at 100000 px/s^2 from 1000 px/s: the velocity would reverse after 10 ms, the head stops at v^2 / (2 a) = 5 px
  const dec = extrapolateHead(b, { vx: 1000, vy: 0, ax: -100000, ay: 0 }, 1035, PTR);
  assert.ok(Math.abs(dec.x - 505) < 1e-9, `${dec.x}`);
  const dec2 = extrapolateHead(b, { vx: -1000, vy: 500, ax: 100000, ay: -50000 }, 1035, PTR);
  assert.ok(Math.abs(dec2.x - (500 - 5)) < 1e-9 && Math.abs(dec2.y - (300 + 2.5)) < 1e-9);
  // clamped to the playfield
  assert.equal(extrapolateHead({ x: 1915, y: 5, t: 0 }, { vx: 9000, vy: -9000, ax: 0, ay: 0 }, 30, PTR).x, 1920);
  assert.equal(extrapolateHead({ x: 1915, y: 5, t: 0 }, { vx: 9000, vy: -9000, ax: 0, ay: 0 }, 30, PTR).y, 0);
});

// ------------------------------------------------------------------------------------------------------------ through the pipeline

test('every real sample emits exactly one blade event; the ring holds interpolated samples between them (recent())', () => {
  const r = rel();
  let events = 0;
  r.pipe.on('blade', () => { events += 1; });
  feed(r.pipe, r.stream.each([0, 0, 0]));
  feed(r.pipe, r.stream.hold(6, 300));
  assert.equal(events, 9, 'one blade event per IMU sample, the interpolated ones are only in recent()');
  const ring = r.pipe.recent(1e9);
  const real = ring.filter((s) => !s.interpolated);
  const interp = ring.filter((s) => s.interpolated);
  assert.equal(real.length, 9);
  assert.equal(interp.length, 8 * 3, 'three interpolated samples between each two real ones (8 intervals at 30.3 ms)');
  assert.ok(real.every((s, i) => s === r.rec.blades[i]), 'the real ring entries are the very objects of the events');
  // chronological and at most 8 ms apart
  for (let i = 1; i < ring.length; i += 1) {
    const d = ring[i].t - ring[i - 1].t;
    assert.ok(d > 0 && d <= 8.5, `spacing ${d}`);
  }
  // the last entry is the newest real sample, latest() agrees
  assert.equal(ring.at(-1), r.pipe.latest());
  // interpolated samples lie between their neighbours on the path and carry the tip speed, vx and vy
  for (let i = 1; i < ring.length - 1; i += 1) {
    if (!ring[i].interpolated) continue;
    assert.ok(ring[i].x >= ring[i - 1].x - 1e-9 && ring[i].x <= ring[ring.length - 1].x + 1e-9);
    assert.ok(ring[i].speedDps >= 0 && Number.isFinite(ring[i].vx) && ring[i].vy === 0 || Math.abs(ring[i].vy) < 1e-6);
    assert.equal(ring[i].segmentValid, false);
    assert.equal(ring[i].discontinuity, false);
    assert.equal(ring[i].trackingOk, true);
    assert.equal(ring[i].source, 'imu');
  }
  // recent(window) is relative to the newest sample
  const w = r.pipe.recent(20);
  assert.ok(w.length >= 3 && w.every((s) => s.t >= ring.at(-1).t - 20));
});

test('no interpolated samples across a discontinuity; a 60 ms step gets seven; a 250 Hz stream gets none', () => {
  const r = rel();
  feed(r.pipe, r.stream.each([0, 200]));
  r.stream.skip(30);
  feed(r.pipe, r.stream.each([200]));
  let ring = r.pipe.recent(1e9);
  // 1st sample alone, then 3 interpolated + real, then 7 interpolated + real
  assert.equal(ring.length, 1 + 4 + 8);
  assert.equal(ring.filter((s) => s.interpolated).length, 3 + 7);
  r.pipe.markDiscontinuity('lost');
  const before = r.pipe.recent(1e9).length;
  feed(r.pipe, r.stream.each([200]));
  assert.equal(r.pipe.recent(1e9).length, before + 1, 'the sample after a discontinuity has no interpolated predecessors');
  const fast = rel({ hz: 250 });
  feed(fast.pipe, fast.stream.hold(50, 100));
  assert.equal(fast.pipe.recent(1e9).filter((s) => s.interpolated).length, 0);
  assert.equal(fast.pipe.recent(1e9).length, 50);
  // the ring keeps historySize samples: 384
  const big = rel();
  feed(big.pipe, big.stream.hold(200, 50));
  assert.equal(big.pipe.recent(1e9).length, MOTION_CONFIG.tracker.historySize);
});

test('the trail colours are right: interpolated samples of the cut intervals (the held ones included) are cutting with the swing id, the leaving interval is not', () => {
  const r = rel();
  feed(r.pipe, r.stream.each([0, 0, 350, 350, 350, 0, 0]));
  // real samples b0..b6: b2 is the first fast one (a candidate), b3 is the ENTER sample, b5 is the leaving one
  const b = r.rec.blades;
  assert.deepEqual(b.map((x) => x.cutting), [false, false, false, true, true, false, false]);
  const ring = r.pipe.recent(1e9);
  const inInterval = (k) => ring.filter((q) => q.interpolated && q.t > b[k - 1].t && q.t < b[k].t);
  const expectCutting = { 1: false, 2: true, 3: true, 4: true, 5: false, 6: false };
  for (const [k, cutting] of Object.entries(expectCutting)) {
    const pts = inInterval(Number(k));
    assert.equal(pts.length, 3, `interval ${k}`);
    assert.ok(pts.every((q) => q.cutting === cutting), `interval ${k} (ending at sample ${k}) is ${cutting ? '' : 'not '}cutting`);
    assert.ok(pts.every((q) => q.swingId === (Number(k) >= 2 ? 1 : 0)), `interval ${k}: swing id ${pts.map((q) => q.swingId)}`);
  }
  // the interval that started the candidate was patched when the cut was recognised; the real sample b2 had already been emitted
  assert.equal(b[2].cutting, false, 'a real sample that was already emitted is never rewritten');
  assert.equal(b[2].swingId, 0);
});

test('headAt in the relative model: extrapolates up to 35 ms from the newest real sample, holds still on a discontinuity and once the track is lost', () => {
  const r = rel();
  feed(r.pipe, r.stream.each([0, 200, 300]));
  const b = r.pipe.latest();
  const h0 = r.pipe.headAt(b.t);
  assert.deepEqual(h0, { x: b.x, y: b.y });
  const h15 = r.pipe.headAt(b.t + 15);
  const h35 = r.pipe.headAt(b.t + 35);
  const h200 = r.pipe.headAt(b.t + 200);
  assert.ok(h15.x > b.x + 20 && h35.x > h15.x, 'the head runs ahead');
  assert.ok(h200.x === h35.x && h200.y === h35.y, 'but never more than 35 ms');
  assert.ok(Math.abs(h35.x - b.x) > 2 * Math.abs(r.pipe.headAt(b.t + 15).x - b.x) * 0.9, 'the window is 35 ms, not the 15 ms of the absolute model');
  assert.deepEqual(r.pipe.headAt(b.t - 50), { x: b.x, y: b.y });
  // a discontinuity sample: no extrapolation
  r.pipe.markDiscontinuity('other');
  feed(r.pipe, r.stream.each([300]));
  const d = r.pipe.latest();
  assert.equal(d.discontinuity, true);
  assert.deepEqual(r.pipe.headAt(d.t + 30), { x: d.x, y: d.y });
  // the next real sample extrapolates again; a lost track (poll) holds the position
  feed(r.pipe, r.stream.each([300]));
  const e = r.pipe.latest();
  assert.ok(r.pipe.headAt(e.t + 20).x > e.x);
  r.pipe.poll(e.t + 300);
  const lost = r.pipe.latest();
  assert.equal(lost.trackingOk, false);
  assert.deepEqual(r.pipe.headAt(e.t + 320), { x: lost.x, y: lost.y });
  // never outside the playfield
  const edge = rel();
  feed(edge.pipe, edge.stream.hold(40, 700));
  const last = edge.pipe.latest();
  assert.equal(last.x, 1920);
  const head = edge.pipe.headAt(last.t + 35);
  assert.ok(head.x <= 1920 && head.y >= 0 && head.y <= 1080);
});

test('the absolute model and the aim path keep the linear head of 15 ms', () => {
  const p = createAbsolutePipeline();
  p.pushAim({ t: 0, x: 100, y: 100, discontinuity: true });
  p.pushAim({ t: 10, x: 110, y: 100 });
  const h = p.headAt(1000);
  assert.ok(Math.abs(h.x - (110 + 1000 * 0.015)) < 1e-6, `${h.x}`);
});

test('BladeSample and MotionState carry the new fields: speedDps, vx, vy, interpolated, cutThresholdDps, pointerModel; yaw and pitch are null in the relative model', () => {
  const r = rel({ settings: { cutMul: 0.8 } });
  assert.equal(r.pipe.getPointerModel(), 'relative');
  feed(r.pipe, r.stream.each([0, 0, 500, 500, 500, 0]));
  const b = r.rec.blades[3];
  assert.equal(typeof b.speedDps, 'number');
  assert.ok(Math.abs(b.speedDps - 500) < 1e-9);
  assert.ok(Math.abs(b.speed - 500 * (10 / 3)) < 1e-6, 'speed keeps the px/s-equivalent scale of the game, the trail and the audio');
  assert.ok(b.vx > 5000 && b.vy === 0 || Math.abs(b.vy) < 1e-9);
  assert.equal(b.interpolated, false);
  assert.equal(b.source, 'imu');
  const st = r.pipe.getState();
  assert.equal(st.pointerModel, 'relative');
  assert.equal(st.cutThresholdDps, 240, 'the effective threshold: cutThreshold x cutMul');
  assert.equal(st.speedDps, 0, 'the newest sample is at rest');
  assert.equal(st.yawDeg, null);
  assert.equal(st.pitchDeg, null);
  assert.equal(st.calibrated, true);
  assert.equal(st.speed, r.pipe.latest().speed);
  const dbg = r.pipe.getDebug();
  assert.equal(dbg.pointer.model, 'relative');
  assert.equal(dbg.pointer.tipSpeedDps, 0);
  assert.deepEqual(Object.keys(dbg.pointer).sort(), ['centring', 'elevationDeg', 'gravityConfirmed', 'idleForS', 'model', 'pitchRateDps', 'tipSpeedDps', 'vx', 'vy'], 'round F1 added elevationDeg, gravityConfirmed and pitchRateDps');
  feed(r.pipe, r.stream.each([450]));
  assert.ok(Math.abs(r.pipe.getDebug().pointer.tipSpeedDps - 450) < 1e-9);
  assert.ok(r.pipe.getState().speedDps === 450 || Math.abs(r.pipe.getState().speedDps - 450) < 1e-9);
  assert.equal(r.pipe.getState().angularSpeedDps, 450);
});

test('aim samples and the absolute model: speedDps is the px/s speed divided by 10/3, vx = vy = 0, the px tracker threshold is T x 10/3', () => {
  const p = createAbsolutePipeline();
  const rec = record(p);
  p.pushAim({ t: 0, x: 100, y: 100, discontinuity: true });
  for (let i = 1; i <= 20; i += 1) p.pushAim({ t: i * 5, x: 100 + i * 6, y: 100 }); // 1200 px/s
  const last = rec.blades.at(-1);
  assert.ok(Math.abs(last.speedDps - last.speed / (10 / 3)) < 1e-9 && Math.abs(last.speedDps - 360) < 2);
  assert.equal(last.vx, 0);
  assert.equal(last.vy, 0);
  assert.equal(last.interpolated, false);
  assert.equal(last.cutting, true, '1200 px/s is above the 300 deg/s x 10/3 = 1000 px/s threshold');
  const st = p.getState();
  assert.equal(st.pointerModel, 'absolute');
  assert.equal(st.cutThresholdDps, 300);
  assert.ok(Math.abs(st.speedDps - 360) < 2);
  // the px path is unchanged by the model choice: the same aim stream through a relative pipeline gives the same blades
  const q = createMotionPipeline({ pointerModel: 'relative' });
  const qrec = record(q);
  q.pushAim({ t: 0, x: 100, y: 100, discontinuity: true });
  for (let i = 1; i <= 20; i += 1) q.pushAim({ t: i * 5, x: 100 + i * 6, y: 100 });
  assert.deepEqual(qrec.blades, rec.blades.map((b) => ({ ...b })), 'pushAim does not depend on the pointer model');
});

test('setPointerModel: relative and absolute are accepted, anything else is ignored, nothing is reset by the call', () => {
  const pipe = createMotionPipeline();
  assert.equal(pipe.getPointerModel(), 'relative', 'the default');
  assert.equal(createMotionPipeline({ pointerModel: 'absolute' }).getPointerModel(), 'absolute');
  assert.equal(createMotionPipeline({ pointerModel: 'nonsense' }).getPointerModel(), 'relative');
  pipe.setPointerModel('absolute');
  assert.equal(pipe.getPointerModel(), 'absolute');
  for (const junk of ['', 'rel', null, undefined, 3, {}]) pipe.setPointerModel(junk);
  assert.equal(pipe.getPointerModel(), 'absolute');
  // no reset: a swing in progress and the calibration survive a model switch (the host calls reset() itself)
  const r = rel();
  feed(r.pipe, r.stream.each([0, 400, 400]));
  assert.equal(r.pipe.getState().cutting, true);
  r.pipe.setPointerModel('relative');
  assert.equal(r.pipe.getState().cutting, true);
  assert.ok(r.pipe.getCalibration());
  assert.ok(pipe.getState().pointerModel === 'absolute');
});

test('the segment queue is bounded at 1024 chords and drainSegments empties it', () => {
  const r = rel();
  feed(r.pipe, r.stream.each([0, 400, 400]));
  // push a very long stroke without draining
  const limit = MOTION_CONFIG.tracker.segmentQueueMax;
  assert.equal(limit, 1024);
  for (let i = 0; i < 200; i += 1) feed(r.pipe, r.stream.each([i % 2 ? { vR: 900 } : { vR: -900 }]));
  const segs = r.pipe.drainSegments();
  assert.ok(segs.length > 0 && segs.length <= limit, `${segs.length}`);
  assert.deepEqual(r.pipe.drainSegments(), []);
  assert.ok(segs.every((s) => Number.isFinite(s.x0 + s.y0 + s.x1 + s.y1 + s.t0 + s.t1 + s.speed) && s.t1 >= s.t0 && s.speed > 0));
});
