import test from 'node:test';
import assert from 'node:assert/strict';
import { BladeTracker } from '../../public/js/motion/blade-tracker.js';
import { MOTION_CONFIG } from '../../public/js/motion/motion-config.js';
import { createRng } from '../../public/js/shared/rng.js';
import { assertValid } from '../../public/js/shared/validate.js';
import { record, createAbsolutePipeline } from '../../test-support/motion/harness.js';

const T = 1000;
const CAP = MOTION_CONFIG.cut.safetyCapMousePxPerS;

/**
 * Drive a fresh pipeline through the aim path with a piecewise-constant speed profile along +x.
 * segments: [{ms, v}] (v in px/s, may be 0). Starts at x0 = 100 after `restMs` of rest.
 */
function runProfile(profile, { hz = 250, restMs = 100, settings = {}, y = 500 } = {}) {
  const pipe = createAbsolutePipeline({ settings });
  const rec = record(pipe);
  const dt = 1000 / hz;
  let t = 1000;
  let x = 100;
  pipe.pushAim({ t, x, y, discontinuity: true });
  for (let ms = 0; ms < restMs; ms += dt) {
    t += dt;
    pipe.pushAim({ t, x, y });
  }
  const marks = [];
  for (const seg of profile) {
    marks.push({ t, v: seg.v });
    for (let ms = 0; ms < seg.ms; ms += dt) {
      t += dt;
      x += (seg.v * dt) / 1000;
      pipe.pushAim({ t, x, y });
    }
  }
  return { pipe, rec, marks, endT: t };
}

const cuttingRuns = (blades) => {
  const runs = [];
  let cur = null;
  for (const b of blades) {
    if (b.cutting && !cur) cur = { start: b.t, id: b.swingId, end: b.t };
    else if (b.cutting) cur.end = b.t;
    else if (cur) {
      runs.push(cur);
      cur = null;
    }
  }
  if (cur) runs.push(cur);
  return runs;
};

// --------------------------------------------------------------------------------------------------------------- threshold

test('threshold: 900 px/s never cuts, 1100 px/s cuts (T = 1000), at 33, 66, 250 and 1000 Hz', () => {
  for (const hz of [33, 66, 250, 1000]) {
    const slow = runProfile([{ ms: 800, v: 900 }], { hz });
    assert.equal(slow.rec.blades.some((b) => b.cutting), false, `${hz} Hz: 900 px/s must not cut`);
    assert.equal(slow.rec.drain().length, 0);
    const fast = runProfile([{ ms: 800, v: 1100 }], { hz });
    const cutting = fast.rec.blades.filter((b) => b.cutting);
    assert.ok(cutting.length > 5, `${hz} Hz: 1100 px/s cuts`);
    assert.ok(fast.rec.drain().length > 3);
    assert.ok(cutting.every((b) => b.swingId === 1));
  }
});

test('threshold: measured speed equals the true speed within 2 percent (600 to 9000 px/s, diagonal too)', (t) => {
  let worst = 0;
  for (const hz of [33, 66, 250]) {
    for (const v of [600, 1500, 4000, 9000]) {
      const pipe = createAbsolutePipeline();
      const rec = record(pipe);
      const dt = 1000 / hz;
      let tt = 1000;
      let x = 100;
      let y = 100;
      const dx = (v * 0.8 * dt) / 1000; // 3-4-5 diagonal
      const dy = (v * 0.6 * dt) / 1000;
      pipe.pushAim({ t: tt, x, y, discontinuity: true });
      for (let i = 0; i < 200 && x + dx < 1900 && y + dy < 1000; i += 1) {
        tt += dt;
        x += dx;
        y += dy;
        pipe.pushAim({ t: tt, x, y });
      }
      const last = rec.blades[rec.blades.length - 1];
      const err = Math.abs(last.speed / v - 1);
      worst = Math.max(worst, err);
      assert.ok(err < 0.02, `${hz} Hz ${v} px/s: measured ${last.speed}`);
    }
  }
  t.diagnostic(`speed estimate: worst relative error ${(worst * 100).toFixed(3)} % over 12 rate/speed combinations`);
});

test('threshold: cutMul 0.8 (Zen) lowers T to 800; cutThreshold scales it; 850 px/s cuts only in Zen', () => {
  const normal = runProfile([{ ms: 600, v: 850 }]);
  assert.equal(normal.rec.blades.some((b) => b.cutting), false);
  const zen = runProfile([{ ms: 600, v: 850 }], { settings: { cutMul: 0.8 } });
  assert.ok(zen.rec.blades.some((b) => b.cutting));
  // cutThreshold is in deg/s since the sword-tuning round; the px/s tracker converts it: T_px = T x cutMul x 10/3 (contract 2.6)
  const hard = runProfile([{ ms: 600, v: 1400 }], { settings: { cutThreshold: 450 } }); // 450 deg/s = 1500 px/s
  assert.equal(hard.rec.blades.some((b) => b.cutting), false);
  const easy = runProfile([{ ms: 600, v: 800 }], { settings: { cutThreshold: 210 } }); // 210 deg/s = 700 px/s
  assert.ok(easy.rec.blades.some((b) => b.cutting));
  const normal300 = runProfile([{ ms: 600, v: 990 }], { settings: { cutThreshold: 300 } }); // 300 deg/s = 1000 px/s exactly as shipped
  assert.equal(normal300.rec.blades.some((b) => b.cutting), false);
  const normal300b = runProfile([{ ms: 600, v: 1010 }], { settings: { cutThreshold: 300 } });
  assert.ok(normal300b.rec.blades.some((b) => b.cutting));
});

// -------------------------------------------------------------------------------------------------------------- hysteresis

test('hysteresis: a dip to 700 px/s for 50 ms keeps the swing; below 0.65 T (650) ends it', () => {
  // 1100 for 150 ms, dip to 700 for 50 ms, 1100 again
  const a = runProfile([{ ms: 150, v: 1100 }, { ms: 50, v: 700 }, { ms: 150, v: 1100 }, { ms: 200, v: 0 }]);
  const runsA = cuttingRuns(a.rec.blades);
  assert.equal(runsA.length, 1, 'one continuous cutting run through the dip to 700');
  assert.equal(new Set(a.rec.blades.filter((b) => b.cutting).map((b) => b.swingId)).size, 1);
  // long dip to 500 px/s (below 650): the run ends inside the dip
  const b = runProfile([{ ms: 150, v: 1100 }, { ms: 300, v: 500 }, { ms: 150, v: 1100 }]);
  const runsB = cuttingRuns(b.rec.blades);
  assert.equal(runsB.length, 2, 'a long slow dip ends the swing');
  assert.ok(runsB[0].end < b.marks[1].t + 300, 'left CUTTING inside the dip');
  // 650 is the boundary: staying just above keeps cutting (constant 660), just below never re-enters
  const c = runProfile([{ ms: 150, v: 1100 }, { ms: 400, v: 660 }]);
  assert.ok(cuttingRuns(c.rec.blades).length === 1 && c.rec.blades[c.rec.blades.length - 1].cutting, '660 px/s keeps a swing alive');
  const d = runProfile([{ ms: 150, v: 1100 }, { ms: 400, v: 640 }]);
  assert.equal(d.rec.blades[d.rec.blades.length - 1].cutting, false, '640 px/s ends it');
});

test('hysteresis: a re-entry within 100 ms of leaving keeps the swingId, a later one starts a new swing', () => {
  const idsFor = (gapMs) => {
    // fast, stop for gapMs, fast again; the tracker leaves CUTTING somewhere inside the stop
    const r = runProfile([{ ms: 200, v: 2000 }, { ms: gapMs, v: 0 }, { ms: 200, v: 2000 }, { ms: 300, v: 0 }]);
    const runs = cuttingRuns(r.rec.blades);
    return runs;
  };
  const short = idsFor(60);
  const long = idsFor(400);
  assert.equal(long.length, 2);
  assert.notEqual(long[0].id, long[1].id, 'a re-entry after a long gap is a new swing');
  assert.equal(long[1].id, long[0].id + 1);
  // measure the rule mechanically: gap between leaving and re-entering
  for (const runs of [short, long]) {
    if (runs.length === 2) {
      const gap = runs[1].start - runs[0].end;
      assert.equal(runs[1].id === runs[0].id, gap <= MOTION_CONFIG.cut.swingGraceMs + 1e-9, `gap ${gap.toFixed(1)} ms`);
    }
  }
  // a stop of 60 ms never even leaves CUTTING on the 50 ms window at 250 Hz, or if it does, the grace rule keeps the id
  const ids = new Set(short.map((r) => r.id));
  assert.equal(ids.size, 1);
});

test('hysteresis: re-entry gap of exactly the tracker rule (direct tracker test with a crafted speed sequence)', () => {
  const tr = new BladeTracker(MOTION_CONFIG.cut);
  let t = 0;
  let x = 0;
  const step = (v, ms = 4) => {
    t += ms;
    x += (v * ms) / 1000;
    return { ...tr.update({ t, x, y: 0, discontinuity: false, capPxPerS: CAP }, T) };
  };
  // start
  tr.update({ t, x, y: 0, discontinuity: false, capPxPerS: CAP }, T);
  for (let i = 0; i < 40; i += 1) step(2000);
  assert.equal(tr.cutting, true);
  const id = tr.swingId;
  // stop dead until it leaves, remember when
  let leaveT = null;
  for (let i = 0; i < 100 && leaveT === null; i += 1) {
    const r = step(0);
    if (!r.cutting) leaveT = t;
  }
  assert.ok(leaveT !== null);
  // resume 96 ms later at high speed: enters within the grace period (window mean must reach T again)
  while (t - leaveT < 76) step(0);
  let enterT = null;
  for (let i = 0; i < 80 && enterT === null; i += 1) {
    const r = step(9000);
    if (r.cutting) enterT = t;
  }
  assert.ok(enterT !== null && enterT - leaveT <= 100, `re-entered ${enterT - leaveT} ms after leaving`);
  assert.equal(tr.swingId, id, 'same swing inside the 100 ms grace');
  // again, but wait 140 ms before re-entering
  for (let i = 0; i < 40; i += 1) step(2000);
  let leave2 = null;
  for (let i = 0; i < 100 && leave2 === null; i += 1) {
    const r = step(0);
    if (!r.cutting) leave2 = t;
  }
  while (t - leave2 < 140) step(0);
  for (let i = 0; i < 40; i += 1) step(9000);
  assert.equal(tr.swingId, id + 1, 'a re-entry later than 100 ms is a new swing');
});

test('hysteresis: changing cutMul or cutThreshold mid-swing re-evaluates on the next sample without resetting swingId', () => {
  const pipe = createAbsolutePipeline();
  const rec = record(pipe);
  let t = 0;
  let x = 100;
  const push = (v, n = 20) => {
    for (let i = 0; i < n; i += 1) {
      t += 4;
      x += (v * 4) / 1000;
      pipe.pushAim({ t, x, y: 300 });
    }
  };
  pipe.pushAim({ t, x, y: 300, discontinuity: true });
  push(1200, 40);
  const id = rec.blades[rec.blades.length - 1].swingId;
  assert.equal(rec.blades[rec.blades.length - 1].cutting, true);
  pipe.setSettings({ cutThreshold: 600 }); // 600 deg/s = 2000 px/s, release below 1300: 1200 px/s is now too slow
  push(1200, 5);
  assert.equal(rec.blades[rec.blades.length - 1].cutting, false);
  pipe.setSettings({ cutThreshold: 300 });
  push(1200, 5);
  const last = rec.blades[rec.blades.length - 1];
  assert.equal(last.cutting, true);
  assert.equal(last.swingId, id, 'same swing: the change happened well within the 100 ms grace');
  assert.ok(id >= 1);
});

// ----------------------------------------------------------------------------------------------------------------- segments

test('segments: merged chords are never shorter than 6 px, cover the whole path, and follow the samples in order', () => {
  for (const hz of [250, 1000]) {
    const r = runProfile([{ ms: 300, v: 1300 }, { ms: 100, v: 0 }], { hz });
    const segs = r.rec.drain();
    assert.ok(segs.length > 10);
    let prevX = null;
    let total = 0;
    for (const s of segs) {
      const len = Math.hypot(s.x1 - s.x0, s.y1 - s.y0);
      assert.ok(len >= MOTION_CONFIG.cut.mergeSegmentPx - 1e-9, `${hz} Hz: segment length ${len}`);
      assert.ok(s.t1 >= s.t0);
      if (prevX !== null) assert.ok(s.x0 >= prevX - 1e-6, 'segments chain forward');
      prevX = s.x1;
      total += len;
    }
    const travelled = r.rec.blades[r.rec.blades.length - 1].x - 100;
    // the swing is only "live" from the moment the speed window reaches T; before that the anchor follows the samples
    assert.ok(total > 0.5 * travelled && total <= travelled + 1e-6, `${hz} Hz: segments cover ${total} of ${travelled}`);
    // the segment stream is gap-free from its first chord to its last: consecutive chords share an endpoint
    for (let i = 1; i < segs.length; i += 1) assert.ok(Math.abs(segs[i].x0 - segs[i - 1].x1) < 1e-6, 'chords are contiguous');
  }
});

test('segments: rest jitter while cutting is flushed after 8 ms and never becomes a segment', () => {
  const tr = new BladeTracker(MOTION_CONFIG.cut);
  let t = 0;
  let x = 0;
  const out = [];
  const push = (dx, ms = 4) => {
    t += ms;
    x += dx;
    const r = tr.update({ t, x, y: 0, discontinuity: false, capPxPerS: CAP }, T);
    out.push({ ...r, t, x });
    return r;
  };
  tr.update({ t, x, y: 0, discontinuity: false, capPxPerS: CAP }, T);
  for (let i = 0; i < 30; i += 1) push(8); // 2000 px/s at 250 Hz
  assert.equal(tr.cutting, true);
  const before = out.length;
  for (let i = 0; i < 6; i += 1) push(1); // 250 px/s of jitter while the 50 ms window still remembers the swing
  const jitter = out.slice(before);
  assert.ok(jitter.some((o) => o.cutting), 'still in the swing while the window remembers it');
  assert.ok(jitter.filter((o) => o.cutting).every((o) => !o.segmentValid), 'jitter movements below 6 px are not segments');
  // and one sample of 5.9 px is not a segment either (needs >= 6 px from the anchor) but 6.0 px is
  const tr2 = new BladeTracker(MOTION_CONFIG.cut);
  let t2 = 0;
  let x2 = 0;
  tr2.update({ t: t2, x: x2, y: 0, discontinuity: false, capPxPerS: CAP }, T);
  for (let i = 0; i < 30; i += 1) {
    t2 += 4;
    x2 += 8;
    tr2.update({ t: t2, x: x2, y: 0, discontinuity: false, capPxPerS: CAP }, T);
  }
  t2 += 1;
  x2 += 5.9;
  assert.equal(tr2.update({ t: t2, x: x2, y: 0, discontinuity: false, capPxPerS: CAP }, T).segmentValid, false);
  t2 += 1;
  x2 += 0.2; // accumulated 6.1 px
  assert.equal(tr2.update({ t: t2, x: x2, y: 0, discontinuity: false, capPxPerS: CAP }, T).segmentValid, true);
});

test('segments: a 1800 px jump in one sample becomes exactly one segment (no tunnelling); a faster jump is a glitch', () => {
  const pipe = createAbsolutePipeline();
  const rec = record(pipe);
  pipe.pushAim({ t: 0, x: 60, y: 500, discontinuity: true });
  for (let i = 1; i <= 5; i += 1) pipe.pushAim({ t: i * 15, x: 60, y: 500 });
  pipe.pushAim({ t: 115, x: 1860, y: 500 }); // 40 ms later: 45 000 px/s, under the 60 000 px/s cap
  const segs = rec.drain();
  assert.equal(segs.length, 1);
  assert.equal(segs[0].x0, 60);
  assert.equal(segs[0].x1, 1860);
  assert.equal(segs[0].y0, 500);
  assert.ok(segs[0].speed > 0);
  assert.equal(rec.blades[rec.blades.length - 1].cutting, true);

  // 10 ms: 180 000 px/s > cap: dropped as a glitch, but the cursor still follows it
  const p2 = createAbsolutePipeline();
  const r2 = record(p2);
  p2.pushAim({ t: 0, x: 60, y: 500, discontinuity: true });
  for (let i = 1; i <= 5; i += 1) p2.pushAim({ t: i * 15, x: 60, y: 500 });
  p2.pushAim({ t: 85, x: 1860, y: 500 });
  assert.equal(r2.drain().length, 0);
  const g = r2.blades[r2.blades.length - 1];
  assert.equal(g.x, 1860);
  assert.equal(g.segmentValid, false);
  assert.equal(g.cutting, false);
  assert.equal(p2.getDebug().glitches, 1);
});

// ------------------------------------------------------------------------------------------------------------- safety cap

test('safety cap: a step above the cap moves the cursor but feeds neither the speed window nor a segment', () => {
  const tr = new BladeTracker(MOTION_CONFIG.cut);
  let t = 0;
  let x = 0;
  tr.update({ t, x, y: 0, discontinuity: false, capPxPerS: CAP }, T);
  for (let i = 0; i < 30; i += 1) {
    t += 15;
    x += 20; // 1333 px/s: cutting
    tr.update({ t, x, y: 0, discontinuity: false, capPxPerS: CAP }, T);
  }
  assert.equal(tr.cutting, true);
  const speedBefore = tr.speed;
  t += 15;
  x += 1500; // 100 000 px/s
  const g = tr.update({ t, x, y: 0, discontinuity: false, capPxPerS: CAP }, T);
  assert.equal(g.glitch, true);
  assert.equal(g.segmentValid, false);
  assert.equal(g.speed, speedBefore, 'the glitch does not change the speed');
  assert.equal(tr.cutting, true, 'state is kept through a single glitch sample');
  // the next normal sample is not a chord across the jump
  t += 15;
  x += 20;
  const n = tr.update({ t, x, y: 0, discontinuity: false, capPxPerS: CAP }, T);
  assert.equal(n.glitch, false);
  assert.ok(!n.segmentValid || Math.hypot(n.x0 - x, 0) < 100, 'no segment spans the glitch jump');
  assert.ok(n.speed < 3000, `speed after the jump ${n.speed} is not inflated by it`);
  // the IMU cap is expressed in degrees: 2190 deg/s at sensitivity 1 = 60 006 px/s, scaled with sensitivity
  const capImu = MOTION_CONFIG.cut.safetyCapDegPerS * MOTION_CONFIG.input.pxPerDegBase;
  assert.ok(Math.abs(capImu - 60006) < 1);
});

// ----------------------------------------------------------------------------------------------------------- discontinuities

test('discontinuity: clears the window, ends cutting, never yields a segment, and forces a new swingId', () => {
  const pipe = createAbsolutePipeline();
  const rec = record(pipe);
  let t = 0;
  let x = 100;
  pipe.pushAim({ t, x, y: 300, discontinuity: true });
  for (let i = 0; i < 30; i += 1) {
    t += 8;
    x += 16; // 2000 px/s
    pipe.pushAim({ t, x, y: 300 });
  }
  const before = rec.blades[rec.blades.length - 1];
  assert.equal(before.cutting, true);
  rec.drain();
  // teleport with a discontinuity flag, 8 ms after the previous sample
  t += 8;
  x += 700;
  pipe.pushAim({ t, x, y: 300, discontinuity: true });
  const d = rec.blades[rec.blades.length - 1];
  assert.deepEqual([d.discontinuity, d.cutting, d.segmentValid, d.speed], [true, false, false, 0]);
  assert.equal(rec.drain().length, 0, 'no chord across the teleport');
  // the swing continues at speed right away (within 100 ms): it is a NEW swing
  for (let i = 0; i < 30; i += 1) {
    t += 8;
    x += 16;
    pipe.pushAim({ t, x, y: 300 });
  }
  const after = rec.blades[rec.blades.length - 1];
  assert.equal(after.cutting, true);
  assert.equal(after.swingId, before.swingId + 1);
  const segs = rec.drain();
  assert.ok(segs.length > 5 && segs.every((s) => s.x0 >= x - 30 * 16 - 16), 'segments only from after the teleport');
  // markDiscontinuity() flags the next sample too
  pipe.markDiscontinuity('test');
  t += 8;
  x += 16;
  pipe.pushAim({ t, x, y: 300 });
  assert.equal(rec.blades[rec.blades.length - 1].discontinuity, true);
});

test('time never runs backwards inside the pipeline (late samples are clamped)', () => {
  const pipe = createAbsolutePipeline();
  const rec = record(pipe);
  pipe.pushAim({ t: 100, x: 10, y: 10, discontinuity: true });
  pipe.pushAim({ t: 90, x: 20, y: 10 });
  pipe.pushAim({ t: 95, x: 30, y: 10 });
  pipe.pushAim({ t: 120, x: 40, y: 10 });
  const ts = rec.blades.map((b) => b.t);
  assert.deepEqual(ts, [100, 100, 100, 120]);
  for (const b of rec.blades) assert.ok(Number.isFinite(b.speed));
});

// --------------------------------------------------------------------------------------------------------------- invariants

test('invariants: 30 000 random samples keep every BladeSample and BladeSegment contract-valid', () => {
  const rng = createRng(4242);
  const pipe = createAbsolutePipeline();
  const rec = record(pipe); // collects contract violations (the Emitter swallows exceptions thrown inside listeners)
  let t = 0;
  let x = 960;
  let y = 540;
  let segCount = 0;
  for (let i = 0; i < 30000; i += 1) {
    const mode = rng.next();
    t += mode < 0.02 ? rng.range(50, 400) : rng.range(1, 32);
    if (mode < 0.05) {
      x = rng.range(-500, 2400);
      y = rng.range(-500, 1500);
    } else {
      const v = rng.range(0, mode < 0.4 ? 3000 : 12000);
      const ang = rng.range(0, Math.PI * 2);
      x += Math.cos(ang) * v * 0.008;
      y += Math.sin(ang) * v * 0.008;
    }
    pipe.pushAim({ t, x, y, discontinuity: rng.chance(0.01) });
    if (rng.chance(0.2)) pipe.poll(t + rng.range(0, 100));
    if (rng.chance(0.3)) {
      const segs = rec.drain(); // validates each segment
      segCount += segs.length;
    }
  }
  rec.check();
  assert.ok(rec.blades.length > 30000);
  let lastSwing = 0;
  for (const b of rec.blades) {
    assert.ok(b.swingId >= lastSwing, 'swingId never decreases');
    lastSwing = b.swingId;
    if (b.segmentValid) {
      assert.ok(b.cutting && !b.discontinuity);
      assert.ok(Math.hypot(b.x - b.x0, b.y - b.y0) >= 6 - 1e-9);
    }
  }
  assert.ok(segCount > 100, `random walk produced ${segCount} segments`);
});

test('tracker: reset() forgets everything including the swing counter; the segment queue is bounded at 512', () => {
  const pipe = createAbsolutePipeline();
  const rec = record(pipe, { validate: false });
  let t = 0;
  let x = 50;
  pipe.pushAim({ t, x, y: 50, discontinuity: true });
  for (let i = 0; i < 1500; i += 1) {
    t += 4;
    x = 50 + ((i * 8) % 1700);
    pipe.pushAim({ t, x, y: 50 + (i % 5) });
  }
  const segs = pipe.drainSegments();
  assert.ok(segs.length <= MOTION_CONFIG.tracker.segmentQueueMax);
  assert.ok(rec.blades.length > 1400);
  assert.deepEqual(pipe.drainSegments(), [], 'drained once');
  pipe.reset();
  assert.equal(pipe.latest(), null);
  assert.equal(pipe.getState().swingId, 0);
  assert.deepEqual(pipe.recent(1000), []);
});
