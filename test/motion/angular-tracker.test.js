// The angular cut decision of the relative model (docs/motion-contract.md 2.4, metric A11): enter at T (deg/s, tip speed), a minimum
// duration, hysteresis (leave below 0.65 T), a retroactive first chord, swing ids, discontinuities, rate independence.
// Part 1 drives the pure state machine with exact tip speeds; part 2 goes through pushImu with exact tip-speed streams.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMotionPipeline, MOTION_CONFIG } from '../../public/js/motion/index.js';
import { AngularCutTracker } from '../../public/js/motion/angular-tracker.js';
import { pointerSpeedPxS } from '../../public/js/motion/pointer.js';
import { createTipStream, mountCalibration } from '../../test-support/motion/tip-stream.js';
import { feed, record } from '../../test-support/motion/harness.js';

const CUT = MOTION_CONFIG.cut;

// ------------------------------------------------------------------------------------------------ part 1: the pure state machine

/** samples: [{t, s, disc?}] -> one result row per sample; every sample carries a tagged chord and a tagged trail sample. */
function drive(samples, { T = 300, tracker = new AngularCutTracker(CUT) } = {}) {
  const rows = samples.map((smp, i) => {
    const chords = [{ id: i }];
    const trail = [{ id: i, cutting: false }];
    const r = tracker.update(smp.t, smp.s, smp.T ?? T, !!smp.disc, chords, trail);
    return { t: smp.t, cutting: r.cutting, swingId: r.swingId, entered: r.entered, left: r.left, segs: r.segments.map((c) => c.id), trail: r.cutTrail.map((p) => p.id) };
  });
  return { rows, tracker };
}
/** Uniform sampling: a list of tip speeds at `hz`. */
const at = (hz, list, t0 = 1000) => list.map((s, i) => (typeof s === 'number' ? { t: t0 + (i * 1000) / hz, s } : { t: t0 + (i * 1000) / hz, ...s }));
const cuttingOf = (rows) => rows.map((r) => (r.cutting ? 1 : 0)).join('');

test('A11 290 deg/s never cuts, 310 held for two samples cuts, a single sample above T never cuts (33 Hz)', () => {
  assert.equal(cuttingOf(drive(at(33, Array(60).fill(290))).rows), '0'.repeat(60));
  const two = drive(at(33, [0, 0, 310, 310, 0, 0]));
  assert.equal(cuttingOf(two.rows), '000100', 'two samples 30 ms apart: ENTER on the second, leave on the next one below 195');
  const spike = drive(at(33, [0, 0, 600, 0, 0, 600, 0, 0, 1000, 0]));
  assert.equal(cuttingOf(spike.rows), '0000000000', 'one sample above T, whatever its height, never cuts');
  assert.equal(spike.tracker.swingId, 0, 'and never starts a swing');
  // a spike, then a dip that stays above the release level, then another one: the candidate survives (60 ms after the first)
  const dip = drive(at(33, [0, 310, 250, 310, 0]));
  assert.equal(cuttingOf(dip.rows), '00010');
});

test('A11 retroactive chord: at ENTER the held chords of the candidate and the chord of the current interval are delivered together, in order', () => {
  const { rows } = drive(at(33, [0, 0, 310, 310, 400, 0, 0]));
  assert.deepEqual(rows[2].segs, [], 'the candidate holds its chord back');
  assert.deepEqual(rows[3].segs, [2, 3], 'ENTER delivers the chord of the interval that ended at the first fast sample and the current one');
  assert.deepEqual(rows[4].segs, [4], 'while cutting every interval is delivered');
  assert.deepEqual(rows[5].segs, [], 'the chord of the interval that ends at the LEAVING sample is not delivered (segmentValid => cutting)');
  assert.equal(rows[5].left, true);
  assert.deepEqual(rows[3].trail, [2, 3], 'the trail samples of those intervals are marked as cut samples');
  assert.deepEqual(rows[4].trail, [4]);
  assert.deepEqual(rows[5].trail, []);
  // the dip keeps the candidate and its chords
  const d = drive(at(33, [0, 310, 250, 310, 0])).rows;
  assert.deepEqual(d[3].segs, [1, 2, 3], 'the chords of a candidate that survived a dip are all delivered');
  // a dropped candidate delivers nothing, ever
  const x = drive(at(33, [0, 310, 100, 310, 100, 0]));
  assert.deepEqual(x.rows.flatMap((r) => r.segs), []);
});

test('A11 hysteresis: a dip to 210 (0.7 T) keeps the swing, anything below 195 (0.65 T) ends it, 195 exactly keeps it', () => {
  const keep = drive(at(33, [0, 400, 400, 400, 210, 400, 400, 0]));
  assert.equal(cuttingOf(keep.rows), '00111110');
  assert.equal(new Set(keep.rows.filter((r) => r.cutting).map((r) => r.swingId)).size, 1, 'one swing through the dip');
  const end = drive(at(33, [0, 400, 400, 190, 400, 0]));
  assert.equal(cuttingOf(end.rows), '001000', 'below 195 ends the swing; a single 400 afterwards is only a candidate');
  const edge = drive(at(33, [0, 400, 400, 195, 195, 195]));
  assert.equal(cuttingOf(edge.rows), '001111', '195 = 0.65 x 300 is not below the release level');
  const below = drive(at(33, [0, 400, 400, 194.99, 400]));
  assert.equal(cuttingOf(below.rows).slice(3, 4), '0');
});

test('A11 swing ids: a re-entry within 100 ms keeps the swingId, a later one starts a new swing, swing 0 before the first', () => {
  const t = new AngularCutTracker(CUT);
  assert.equal(t.swingId, 0);
  // cut, leave, re-enter 60 ms after leaving (candidate 30 ms after, ENTER 60 ms after): within the grace
  const a = drive(at(33, [0, 400, 400, 0, 400, 400, 0]), { tracker: t });
  assert.equal(cuttingOf(a.rows), '0010010');
  assert.deepEqual(a.rows.filter((r) => r.cutting).map((r) => r.swingId), [1, 1]);
  // 3 low samples (leaving at index 3, candidate at index 7, ENTER at index 8): 150 ms after leaving, past the grace
  const b = drive(at(33, [0, 400, 400, 0, 0, 0, 0, 400, 400, 0]));
  assert.deepEqual(b.rows.filter((r) => r.cutting).map((r) => r.swingId), [1, 2]);
  // at 250 Hz the grace is in time, not in samples: 96 ms apart keeps the swing, 104 ms apart starts a new one
  const hz = 250;
  const burst = (n, s) => Array(n).fill(s);
  const keep = drive(at(hz, [0, ...burst(10, 400), ...burst(17, 0), ...burst(10, 400), ...burst(5, 0)]));
  assert.equal(new Set(keep.rows.filter((r) => r.cutting).map((r) => r.swingId)).size, 1, 'left, then ENTER 96 ms later: within the grace');
  const gap = drive(at(hz, [0, ...burst(10, 400), ...burst(19, 0), ...burst(10, 400), ...burst(5, 0)]));
  assert.equal(new Set(gap.rows.filter((r) => r.cutting).map((r) => r.swingId)).size, 2, 'ENTER 104 ms after leaving: a new swing');
});

test('A11 discontinuity: clears the candidate, ends a cut, forces a new swing, delivers no segment', () => {
  const cand = drive(at(33, [0, 310, { s: 0, disc: true }, 310, 0]));
  assert.equal(cuttingOf(cand.rows), '00000', 'the candidate did not survive the discontinuity: the second 310 is a new candidate');
  const cut = drive(at(33, [0, 400, 400, 400, { s: 400, disc: true }, 400, 400, 400]));
  assert.equal(cuttingOf(cut.rows), '00110011', 'cutting ends at the discontinuity; it needs two samples again');
  assert.deepEqual(cut.rows[4].segs, [], 'no chord at a discontinuity');
  assert.equal(cut.rows[4].left, true);
  assert.deepEqual(cut.rows.filter((r) => r.cutting).map((r) => r.swingId), [1, 1, 2, 2], 'a discontinuity within the 100 ms grace still starts a new swing');
  // dropCutting (tracking lost) behaves the same way
  const t = new AngularCutTracker(CUT);
  drive(at(33, [0, 400, 400]), { tracker: t });
  assert.equal(t.cutting, true);
  t.dropCutting(2000);
  assert.equal(t.cutting, false);
  const after = drive(at(33, [400, 400], 2010), { tracker: t });
  assert.deepEqual(after.rows.filter((r) => r.cutting).map((r) => r.swingId), [2]);
});

test('A11 the threshold is re-read on every sample: a change mid-swing re-evaluates without resetting the swing id', () => {
  const t = new AngularCutTracker(CUT);
  const a = drive([{ t: 0, s: 400 }, { t: 30, s: 400 }, { t: 60, s: 400 }], { tracker: t });
  assert.equal(a.rows[2].cutting, true);
  const id = t.swingId;
  // T raised to 700: the release level is 455 and 400 is below it
  const b = drive([{ t: 90, s: 400, T: 700 }], { tracker: t });
  assert.equal(b.rows[0].cutting, false);
  // back to 300: the next two samples re-enter within the grace and keep the id
  const c = drive([{ t: 120, s: 400 }, { t: 150, s: 400 }], { tracker: t });
  assert.equal(c.rows[1].cutting, true);
  assert.equal(t.swingId, id, 'same swing');
});

test('A11 the minimum duration is a time, not a sample count (33, 66, 250 Hz)', () => {
  for (const [hz, nCut] of [[33, 2], [66, 3], [250, 8]]) {
    const dt = 1000 / hz;
    // n samples at 310 then silence: ENTER needs the last of them at least 25 ms after the first
    for (let n = 1; n <= 12; n += 1) {
      const { rows } = drive(at(hz, [0, ...Array(n).fill(310), 0, 0, 0, 0]));
      const should = (n - 1) * dt >= CUT.minDurationMs;
      assert.equal(rows.some((r) => r.cutting), should, `${hz} Hz, ${n} samples (${((n - 1) * dt).toFixed(1)} ms between the first and the last)`);
    }
    assert.equal(nCut, Math.ceil(CUT.minDurationMs / dt) + 1, `${hz} Hz needs ${nCut} samples`);
  }
  // a pulse that is high for 24 ms at 250 Hz does not cut, one that is high for 28 ms does
  assert.equal(drive(at(250, [0, ...Array(7).fill(800), 0, 0])).rows.some((r) => r.cutting), false);
  assert.equal(drive(at(250, [0, ...Array(8).fill(800), 0, 0])).rows.some((r) => r.cutting), true);
});

test('A11 a candidate expires after candidateMaxMs in a dip (a first fast sample, 120 ms of 250 deg/s, another fast sample: no cut)', () => {
  const { rows } = drive(at(33, [0, 310, 250, 250, 250, 250, 310, 0]));
  assert.equal(rows.some((r) => r.cutting), false);
  const ok = drive(at(33, [0, 310, 250, 250, 250, 310, 0])); // the last dip sample is 91 ms after the first: the candidate is still alive
  assert.equal(ok.rows.some((r) => r.cutting), true);
});

// ------------------------------------------------------------------------------------------------ part 2: through pushImu

function rel({ hz = 33, settings = {}, mount = 'faceUp' } = {}) {
  const pipe = createMotionPipeline({ pointerModel: 'relative', settings: { autoCenter: false, ...settings } });
  const rec = record(pipe);
  pipe.setCalibration(mountCalibration(mount));
  return { pipe, rec, stream: createTipStream({ mount, hz }) };
}
const speedsOf = (r, list) => {
  feed(r.pipe, r.stream.each(list));
  return r.rec.blades.map((b) => (b.cutting ? 1 : 0)).join('');
};

test('A11 through pushImu: 290 never cuts, 310 for two samples cuts, one sample at 600 never cuts, at 33 Hz', () => {
  const a = rel();
  feed(a.pipe, a.stream.hold(60, 0));
  feed(a.pipe, a.stream.hold(60, 290));
  assert.equal(a.rec.blades.some((b) => b.cutting), false, '290 deg/s is below the threshold of 300');
  const b = rel();
  assert.equal(speedsOf(b, [0, 0, 310, 310, 0, 0]), '000100');
  const c = rel();
  assert.equal(speedsOf(c, [0, 0, 600, 0, 0, 600, 0, 0]), '00000000');
  assert.equal(c.pipe.getState().swingId, 0);
});

test('A11 through pushImu: the retroactive chord is delivered with the ENTER sample, the BladeSample says where it starts', () => {
  const r = rel();
  feed(r.pipe, r.stream.each([0, 0]));
  const p0 = { x: r.rec.blades.at(-1).x, t: r.rec.blades.at(-1).t };
  feed(r.pipe, r.stream.each([310]));
  assert.deepEqual(r.pipe.drainSegments(), [], 'nothing yet: the candidate is held');
  const first = r.rec.blades.at(-1);
  assert.equal(first.cutting, false);
  assert.equal(first.segmentValid, false);
  feed(r.pipe, r.stream.each([310]));
  const enter = r.rec.blades.at(-1);
  assert.equal(enter.cutting, true);
  assert.equal(enter.segmentValid, true);
  const segs = r.pipe.drainSegments();
  assert.ok(segs.length >= 2, `${segs.length} chords`);
  assert.equal(segs[0].t0, p0.t, 'the first chord starts at the sample BEFORE the first fast one');
  assert.equal(segs[0].x0, p0.x);
  assert.equal(enter.t0, segs[0].t0);
  assert.equal(enter.x0, segs[0].x0);
  assert.equal(segs.at(-1).t1, enter.t);
  assert.equal(segs.at(-1).x1, enter.x);
  for (let i = 1; i < segs.length; i += 1) {
    assert.equal(segs[i].t0, segs[i - 1].t1, 'contiguous in time');
    assert.ok(Math.abs(segs[i].x0 - segs[i - 1].x1) < 1e-9 && Math.abs(segs[i].y0 - segs[i - 1].y1) < 1e-9, 'contiguous in space');
  }
  assert.ok(segs.every((s) => s.swingId === 1 && s.speed > 0));
  // the next sample while cutting delivers its own chords only
  feed(r.pipe, r.stream.each([310]));
  const more = r.pipe.drainSegments();
  assert.ok(more.length >= 1 && more[0].t0 === enter.t);
  // leaving: the chord of the interval that ends at the leaving sample is not delivered
  feed(r.pipe, r.stream.each([0]));
  assert.deepEqual(r.pipe.drainSegments(), []);
  assert.equal(r.rec.blades.at(-1).cutting, false);
  assert.equal(r.rec.blades.at(-1).segmentValid, false);
});

test('A11 through pushImu: a dip to 210 keeps the swing, 190 ends it, a re-entry within 100 ms keeps the swingId, a later one is a new swing', () => {
  const a = rel();
  assert.equal(speedsOf(a, [0, 400, 400, 400, 210, 400, 400, 0]), '00111110');
  assert.equal(new Set(a.rec.blades.filter((b) => b.cutting).map((b) => b.swingId)).size, 1);
  const b = rel();
  assert.equal(speedsOf(b, [0, 400, 400, 190, 0]), '00100');
  const c = rel();
  speedsOf(c, [0, 400, 400, 0, 400, 400, 0, 0, 0, 0, 0, 400, 400, 0]);
  const ids = c.rec.blades.filter((b) => b.cutting).map((b) => b.swingId);
  assert.deepEqual(ids, [1, 1, 2], `ids ${ids}`);
});

test('A11 through pushImu: cutMul 0.8 (Zen) makes the threshold 240, cutThreshold and cutMul are re-read on the next sample', () => {
  const normal = rel();
  assert.equal(speedsOf(normal, [0, 250, 250, 250, 0]).includes('1'), false, '250 is below 300');
  const zen = rel({ settings: { cutMul: 0.8 } });
  assert.equal(speedsOf(zen, [0, 250, 250, 250, 0]).includes('1'), true, '250 is above 240');
  const z2 = rel({ settings: { cutMul: 0.8 } });
  assert.equal(speedsOf(z2, [0, 230, 230, 230, 0]).includes('1'), false);
  assert.equal(z2.pipe.getState().cutThresholdDps, 240);
  assert.equal(normal.pipe.getState().cutThresholdDps, 300);
  // Zen releases below 0.65 x 240 = 156
  const z3 = rel({ settings: { cutMul: 0.8 } });
  assert.equal(speedsOf(z3, [0, 300, 300, 160, 160, 150, 0]), '0011100');
  // mid-swing change: the same 400 deg/s is now too slow (T 700), the swing id survives a change back
  const m = rel();
  speedsOf(m, [0, 400, 400, 400]);
  const id = m.pipe.getState().swingId;
  assert.equal(m.pipe.getState().cutting, true);
  m.pipe.setSettings({ cutThreshold: 700 });
  feed(m.pipe, m.stream.each([400]));
  assert.equal(m.pipe.getState().cutting, false, 'T 700: release level 455, 400 is below it');
  m.pipe.setSettings({ cutThreshold: 300 });
  feed(m.pipe, m.stream.each([400, 400]));
  assert.equal(m.pipe.getState().cutting, true);
  assert.equal(m.pipe.getState().swingId, id, 'the change did not reset the swing counter and the re-entry was within the grace');
  assert.equal(m.pipe.getSettings().cutThreshold, 300);
  m.pipe.setSettings({ cutThreshold: 1e6 });
  assert.equal(m.pipe.getSettings().cutThreshold, 700, 'clamped to the range maximum');
  m.pipe.setSettings({ cutThreshold: -5 });
  assert.equal(m.pipe.getSettings().cutThreshold, 100);
});

test('A11 through pushImu: the decision is the same at 33, 66 and 250 Hz for the same pulse in time', () => {
  for (const hz of [33, 66, 250]) {
    const dt = 1000 / hz;
    const r = rel({ hz });
    const ms = 100;
    feed(r.pipe, r.stream.hold(Math.ceil(300 / dt), 0));
    feed(r.pipe, r.stream.hold(Math.round(ms / dt), 420));
    feed(r.pipe, r.stream.hold(Math.ceil(300 / dt), 0));
    const cut = r.rec.blades.filter((b) => b.cutting);
    assert.ok(cut.length >= 1, `${hz} Hz: a 100 ms pulse at 420 deg/s cuts`);
    const short = rel({ hz });
    feed(short.pipe, short.stream.hold(Math.ceil(300 / dt), 0));
    feed(short.pipe, short.stream.hold(Math.max(1, Math.floor(20 / dt)), 900)); // 20 ms or one sample: too short at every rate
    feed(short.pipe, short.stream.hold(Math.ceil(300 / dt), 0));
    assert.equal(short.rec.blades.some((b) => b.cutting), false, `${hz} Hz: a 20 ms pulse never cuts`);
  }
});

test('A11 through pushImu: a 60 ms gap in the middle of a stroke does not break it, a hole of 200 ms or more does', () => {
  const r = rel();
  feed(r.pipe, r.stream.each([0, 0, 400, 400, 500, 500]));
  r.stream.skip(30); // one lost packet: the next step is 60 ms
  feed(r.pipe, r.stream.each([500, 400, 400, 0, 0]));
  const cutting = r.rec.blades.map((b) => (b.cutting ? 1 : 0)).join('');
  assert.equal(cutting, '00011111100', cutting);
  assert.equal(new Set(r.rec.blades.filter((b) => b.cutting).map((b) => b.swingId)).size, 1, 'one swing');
  assert.equal(r.rec.blades.filter((b) => b.discontinuity).length, 1, 'only the very first sample is a discontinuity');
  assert.equal(r.rec.warning.filter((w) => w.code === 'sample_gap').length, 0);
  // a 250 ms hole is a discontinuity: the blade leaves CUTTING and the next swing is a new one
  const h = rel();
  feed(h.pipe, h.stream.each([0, 400, 400, 400]));
  h.stream.skip(250);
  feed(h.pipe, h.stream.each([400, 400, 400, 0]));
  const b = h.rec.blades;
  const afterHole = b[4];
  assert.equal(afterHole.discontinuity, true);
  assert.equal(afterHole.cutting, false);
  assert.deepEqual(b.filter((x) => x.cutting).map((x) => x.swingId), [1, 1, 2]);
});

test('A11 through pushImu: a discontinuity (markDiscontinuity) clears a candidate and ends a cut', () => {
  const a = rel();
  feed(a.pipe, a.stream.each([0, 310]));
  a.pipe.markDiscontinuity('other');
  feed(a.pipe, a.stream.each([310, 0]));
  assert.equal(a.rec.blades.some((b) => b.cutting), false, 'the candidate died at the discontinuity');
  const b = rel();
  feed(b.pipe, b.stream.each([0, 400, 400, 400]));
  assert.equal(b.rec.blades.at(-1).cutting, true);
  b.pipe.markDiscontinuity('other');
  feed(b.pipe, b.stream.each([400]));
  assert.equal(b.rec.blades.at(-1).discontinuity, true);
  assert.equal(b.rec.blades.at(-1).cutting, false);
  assert.equal(b.rec.blades.at(-1).segmentValid, false);
});

test('A11 the cut decision does not depend on the sensitivity or on where the cursor is (pinned at an edge, or not)', () => {
  const seqs = [0.3, 1.0, 2.0].map((sensitivity) => {
    const r = rel({ settings: { sensitivity } });
    // a stroke that runs into the screen edge after two samples, then keeps going at 500 deg/s
    return speedsOf(r, [0, 0, 500, 500, 500, 500, 500, 500, 500, 0, 0]);
  });
  assert.equal(seqs[0], seqs[1]);
  assert.equal(seqs[1], seqs[2]);
  assert.equal(seqs[1], '00011111100');
});

test('A11 the tip speed decides, not |w|: a fast roll about the blade never cuts, a swing with some roll does', () => {
  const roll = rel();
  feed(roll.pipe, roll.stream.each([{ roll: 0 }, ...Array(30).fill({ roll: 900 })]));
  assert.equal(roll.rec.blades.some((b) => b.cutting), false, '900 deg/s about the blade axis is not a swing');
  const swing = rel();
  feed(swing.pipe, swing.stream.each([{ vR: 0 }, { vR: 350, roll: 400 }, { vR: 350, roll: 400 }, { vR: 350, roll: -400 }, { vR: 0 }]));
  assert.equal(swing.rec.blades.some((b) => b.cutting), true, 'the roll does not keep a real swing from cutting');
  assert.ok(Math.abs(swing.rec.blades[2].angularSpeedDps - Math.hypot(350, 400)) < 1e-9);
});

test('A11 a sample above the safety cap (2190 deg/s) is ignored completely: no motion, no candidate, gyro_saturated; the next step integrates from the last accepted one', () => {
  const r = rel();
  feed(r.pipe, r.stream.each([0, 0, 100, 100]));
  const before = r.rec.blades.at(-1);
  const n = r.rec.blades.length;
  feed(r.pipe, r.stream.each([2300]));
  assert.equal(r.rec.blades.length, n, 'no BladeSample for the ignored sample');
  assert.ok(r.rec.warning.some((w) => w.code === 'gyro_saturated'));
  feed(r.pipe, r.stream.each([100]));
  const after = r.rec.blades.at(-1);
  const dt = 2 * (1000 / 33) / 1000;
  const F = pointerSpeedPxS(100, 1, MOTION_CONFIG.pointer);
  assert.ok(Math.abs(after.x - before.x - F * dt) < 3, `x moved ${after.x - before.x}, wanted about ${F * dt} (two device steps)`);
  assert.equal(after.discontinuity, false);
  // a spike just below the cap is a normal sample (R8): it moves the cursor but one sample alone never cuts
  const s = rel();
  feed(s.pipe, s.stream.each([0, 0, 2000, 0, 0]));
  assert.equal(s.rec.blades.some((b) => b.cutting), false);
});
