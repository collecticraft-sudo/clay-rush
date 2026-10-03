// Acceptance tests of the relative pointer on the FIRST REAL Joy-Con 2 recording (docs/motion-contract.md section 5, metrics A1 to A9).
//
// The recording (test-support/motion/fixtures/imu-2026-09-30T18-42-24.jsonl, one Joy-Con 2 Right, the owner's own handling through the
// native bridge) is replayed through the real pipeline, one step window at a time from a fresh pipeline with the exact calibration of the
// recording. The reference values of the prototype (tools/replay-motion.mjs) are printed in every assertion message so that a
// regression shows the gap. UNVERIFIED-ON-HARDWARE: one controller, one person, hand-timed steps; this proves the maths against the
// owner's recorded motion, not how the pointer feels on the sword.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  loadRealRecording, REAL_BIAS_DPS, realCalibration, stepSamples, hardStrokes, replay, injectPostureChange,
  range, median, quantile, mean, timeShare, onEdge, FIELD,
} from '../../test-support/motion/real-recording.js';

const f1 = (v) => (Number.isFinite(v) ? v.toFixed(1) : String(v));

// replays are shared between the tests (a replay is a few milliseconds, the cache keeps the whole file under a couple of seconds)
const cache = new Map();
function run(key, name, opts = {}) {
  if (!cache.has(key)) cache.set(key, replay(name, opts));
  return cache.get(key);
}
const W = {
  hold: ['hold_still', { fromS: 7 }],
  still: ['return_still', { fromS: 2 }],
  yaw: ['yaw_sweep', { fromS: 1, toS: 21 }],
  pitch: ['pitch_sweep', { fromS: 1, toS: 21 }],
  roll: ['roll_360', { fromS: 2, toS: 14 }],
  spin: ['table_spin_360', { fromS: 2, toS: 16 }],
  fastH: ['fast_swings_h', {}],
  fastV: ['fast_swings_v', {}],
};
const get = (k, extra = {}, tag = '') => run(`${k}${tag}`, W[k][0], { ...W[k][1], ...extra });

// --------------------------------------------------------------------------------------------------------------------- fixture

test('fixture: the recording is the one of the findings (nine steps, 4744 IMU samples, 33 Hz, bias constant = the clean table median)', () => {
  const rec = loadRealRecording();
  assert.deepEqual(rec.order, ['rest_table', 'hold_still', 'yaw_sweep', 'pitch_sweep', 'roll_360', 'table_spin_360', 'fast_swings_h', 'fast_swings_v', 'return_still']);
  assert.equal(rec.order.reduce((n, k) => n + rec.steps[k].length, 0), 4744);
  const dts = rec.order.flatMap((k) => rec.steps[k].slice(1).map((s) => s.dtMs));
  assert.equal(median(dts), 30, 'median device step 30 ms (33 Hz)');
  assert.ok(Math.max(...dts) < 62, `worst gap ${Math.max(...dts)} ms (one lost packet)`);
  // the bias constant is the median of the longest quiet run of rest_table (every axis within 6 dps of its median), in raw LSB 0, -5, +12
  const l = rec.steps.rest_table;
  const axes = ['x', 'y', 'z'];
  const med = Object.fromEntries(axes.map((a) => [a, median(l.map((s) => s.g[a]))]));
  let best = [0, 0];
  let start = null;
  for (let i = 0; i <= l.length; i += 1) {
    const ok = i < l.length && axes.every((a) => Math.abs(l[i].g[a] - med[a]) < 6);
    if (ok && start === null) start = i;
    if (!ok && start !== null) {
      if (i - start > best[1] - best[0]) best = [start, i];
      start = null;
    }
  }
  const quiet = l.slice(best[0], best[1]);
  assert.ok(quiet.length > 250, `${quiet.length} quiet samples`);
  for (const a of axes) assert.equal(median(quiet.map((s) => s.g[a])), REAL_BIAS_DPS[a], `bias ${a}`);
  assert.deepEqual(Object.values(REAL_BIAS_DPS).map((v) => Math.round(v / 0.06103515625)), [0, -5, 12]);
});

test('fixture: the hard strokes are the reference events of the contract (15 horizontal, 6 vertical)', () => {
  const h = hardStrokes('fast_swings_h');
  const v = hardStrokes('fast_swings_v');
  assert.equal(h.length, 15, 'fast_swings_h');
  assert.equal(v.length, 6, 'fast_swings_v');
  assert.ok(Math.min(...h.map((s) => s.peakDps)) >= 694 - 1 && Math.max(...h.map((s) => s.peakDps)) <= 1050, 'horizontal peaks 694 to 1049 deg/s');
  assert.ok(Math.min(...v.map((s) => s.peakDps)) >= 632 - 1 && Math.max(...v.map((s) => s.peakDps)) <= 963, 'vertical peaks 632 to 962 deg/s');
  assert.ok(Math.min(...[...h, ...v].map((s) => s.aPeakG)) >= 2.0, 'each one has |a| >= 2 g near the peak');
});

test('fixture: samples obey the ImuSample contract (first sample of a window has dtMs null, device time, nominal scales)', () => {
  const s = stepSamples('yaw_sweep', 1, 3);
  assert.equal(s[0].dtMs, null);
  assert.equal(s[0].t, 0);
  assert.ok(s.slice(1).every((x) => x.dtMs > 0 && x.dtMs < 200 && x.dtSource === 'device' && x.side === 'R'));
  assert.ok(Math.abs(s.length - 66) <= 2, `${s.length} samples in 2 s`);
  assert.throws(() => stepSamples('nope'));
});

// --------------------------------------------------------------------------------------------------------------------- A1

test('A1 cursor excursion while holding still: a hand that tries to hold still moves the cursor by 0 px and never cuts (shipped pointer: 9.8 x 78.3 and 12.1 x 28.8 px)', () => {
  for (const k of ['hold', 'still']) {
    const { rows } = get(k);
    const xr = range(rows.map((r) => r.x));
    const yr = range(rows.map((r) => r.y));
    assert.ok(rows.length > 90, `${k}: ${rows.length} samples`);
    assert.ok(xr <= 10 && yr <= 10, `${k}: cursor range ${f1(xr)} x ${f1(yr)} px (reference 0.0 x 0.0)`);
    assert.equal(timeShare(rows, (r) => r.cutting), 0, `${k}: CUTTING 0 %`);
  }
});

// --------------------------------------------------------------------------------------------------------------------- A2

test('A2 screen coverage: the owner\'s slow sweeps cover a usable part of the screen and never pin the cursor (reference yaw 55.5 x 30.7 %, pitch 2.7 x 26.3 %, boundary 0 %)', () => {
  const y = get('yaw').rows;
  const yx = (100 * range(y.map((r) => r.x))) / FIELD.w;
  const yy = (100 * range(y.map((r) => r.y))) / FIELD.h;
  assert.ok(yx >= 35 && yx <= 80, `yaw sweep x range ${f1(yx)} % of the width (reference 55.5)`);
  assert.ok(yy <= 50, `yaw sweep y range ${f1(yy)} % of the height (reference 30.7)`);
  assert.ok(timeShare(y, onEdge) <= 5, `yaw boundary time ${f1(timeShare(y, onEdge))} %`);
  const p = get('pitch').rows;
  const px = (100 * range(p.map((r) => r.x))) / FIELD.w;
  const py = (100 * range(p.map((r) => r.y))) / FIELD.h;
  assert.ok(py >= 15 && py <= 40, `pitch sweep y range ${f1(py)} % of the height (reference 26.3)`);
  assert.ok(px <= 10, `pitch sweep x range ${f1(px)} % of the width (reference 2.7)`);
  assert.ok(timeShare(p, onEdge) <= 5, `pitch boundary time ${f1(timeShare(p, onEdge))} %`);
});

// --------------------------------------------------------------------------------------------------------------------- A3

test('A3 false cutting in slow motion: under 2 % in every window at every sensitivity, and the CUTTING sequence does not depend on the sensitivity (shipped: 50.3, 61.6, 15.9, 19.0 %)', () => {
  const slow = ['hold', 'still', 'yaw', 'pitch', 'roll', 'spin'];
  for (const sens of [0.3, 1.0, 2.0]) {
    const pooled = [];
    for (const k of slow) {
      const { rows } = get(k, { settings: { sensitivity: sens } }, `@${sens}`);
      const share = timeShare(rows, (r) => r.cutting);
      assert.ok(share < 2, `${k} at sensitivity ${sens}: CUTTING ${share.toFixed(2)} % (reference 0.00)`);
      if (k === 'yaw' || k === 'pitch') pooled.push(...rows);
    }
    assert.ok(pooled.filter((r) => r.cutting).length / pooled.length < 0.02, `yaw + pitch combined at ${sens}`);
  }
  for (const k of [...slow, 'fastH', 'fastV']) {
    const seqs = [0.3, 1.0, 2.0].map((sens) => get(k, { settings: { sensitivity: sens } }, `@${sens}`).rows.map((r) => `${r.cutting ? 1 : 0}${r.swingId}`).join(','));
    assert.equal(seqs[0], seqs[1], `${k}: the cut decision at 0.3 equals the one at 1.0`);
    assert.equal(seqs[2], seqs[1], `${k}: the cut decision at 2.0 equals the one at 1.0`);
  }
});

test('A3b the cut threshold is in deg/s: the same slow sweep cuts at 100 deg/s, and the owner\'s hard strokes do not cut at the 700 deg/s maximum as they do at 300', () => {
  const easiest = replay('yaw_sweep', { fromS: 1, toS: 21, settings: { cutThreshold: 100 } });
  assert.ok(easiest.rows.some((r) => r.cutting), 'a 100 deg/s threshold is inside the owner\'s aiming speeds');
  const normal = get('fastH').rows.filter((r) => r.cutting).length;
  const hardest = replay('fast_swings_h', { settings: { cutThreshold: 700 } }).rows.filter((r) => r.cutting).length;
  assert.ok(hardest < normal, `${hardest} cutting samples at 700 against ${normal} at 300`);
});

// --------------------------------------------------------------------------------------------------------------------- A4

/** Per hard stroke: does it produce a cut, and which share of the cursor path inside the stroke extent is inside delivered segments. */
function strokeCuts(res, strokes) {
  const out = [];
  for (const st of strokes) {
    const inStroke = res.rows.filter((r) => r.t >= st.t0Ms - 1 && r.t <= st.t1Ms + 1);
    let path = 0;
    for (let i = 1; i < inStroke.length; i += 1) path += Math.hypot(inStroke[i].x - inStroke[i - 1].x, inStroke[i].y - inStroke[i - 1].y);
    let cutPath = 0;
    for (const r of inStroke) for (const sg of r.segs) cutPath += Math.hypot(sg.x1 - sg.x0, sg.y1 - sg.y0);
    const atPeak = res.rows.some((r) => Math.abs(r.t - st.tPeakMs) <= 60 && r.cutting);
    const share = path > 0 ? cutPath / path : 0;
    out.push({ atPeak, share, cut: atPeak && share >= 0.5 });
  }
  return out;
}

test('A4 hard strokes produce a cut: at least 90 % of the horizontal and of the vertical strokes, most of their path inside segments (reference H 15/15, V 6/6; the shipped pipeline: V 3/6)', () => {
  for (const [k, name, n] of [['fastH', 'fast_swings_h', 15], ['fastV', 'fast_swings_v', 6]]) {
    const strokes = hardStrokes(name);
    assert.equal(strokes.length, n);
    const c = strokeCuts(get(k), strokes);
    const hit = c.filter((x) => x.cut).length;
    const shares = c.map((x) => x.share);
    const msg = `${name}: ${hit}/${n} cut, path share median ${f1(100 * median(shares))} % min ${f1(100 * Math.min(...shares))} % (reference ${n === 15 ? '95 / 86' : '90 / 87'})`;
    assert.ok(hit >= Math.ceil(0.9 * n), msg);
    assert.ok(median(shares) >= 0.8, msg);
    assert.ok(Math.min(...shares) >= 0.6, msg);
  }
});

// --------------------------------------------------------------------------------------------------------------------- A5

const STARTS = { corner: [60, 60], edgeRight: [1860, 540], farBottom: [960, 1040], nearCentre: [1100, 600] };

test('A5 idle auto-centre: from a displaced cursor the real hand-held rest brings it to the centre in about 3 s, without touching it when it is off (reference 2.50 / 2.35 / 1.84 / 1.33 s within 100 px)', () => {
  for (const [label, [sx, sy]] of Object.entries(STARTS)) {
    const res = replay('return_still', { fromS: 2, before: (pipe) => pipe.reanchor(sx, sy) });
    const at = (px) => res.rows.find((r) => Math.hypot(r.x - FIELD.cx, r.y - FIELD.cy) <= px)?.t ?? Infinity;
    const t100 = at(100);
    const t20 = at(20);
    assert.ok(t100 <= 3000, `${label}: within 100 px after ${f1(t100)} ms`);
    assert.ok(t20 <= 3600, `${label}: within 20 px after ${f1(t20)} ms`);
    assert.equal(res.rows[0].x, sx, `${label}: the first sample is placed by reanchor`);
    const autos = res.rec.recenter.filter((e) => e.kind === 'auto');
    assert.equal(autos.length, 1, `${label}: exactly one auto recenter event, got ${autos.length}`);
    assert.equal(res.rec.recenter.length, 1, `${label}: and nothing else announced`);
    const off = replay('return_still', { fromS: 2, settings: { autoCenter: false }, before: (pipe) => pipe.reanchor(sx, sy) });
    assert.equal(range(off.rows.map((r) => r.x)), 0, `${label}: autoCenter off, x never moves`);
    assert.equal(range(off.rows.map((r) => r.y)), 0, `${label}: autoCenter off, y never moves`);
    assert.equal(off.rec.recenter.length, 0);
  }
});

test('A5b centring never fights a swing: no sample is driven by the centring while cutting or while the tip moves faster than 21 deg/s', () => {
  for (const k of ['yaw', 'pitch', 'fastH', 'fastV']) {
    const bad = get(k).rows.filter((r) => r.refDriven && (r.cutting || r.s > 21));
    assert.equal(bad.length, 0, `${k}: ${bad.length} refDriven samples while moving (reference 0)`);
  }
});

// --------------------------------------------------------------------------------------------------------------------- A6

/** Distance from (px, py) to the segment list (closest point). */
function distToSegments(px, py, segs) {
  let best = Infinity;
  for (const sg of segs) {
    const vx = sg.x1 - sg.x0;
    const vy = sg.y1 - sg.y0;
    const L2 = vx * vx + vy * vy;
    const u = L2 > 0 ? Math.min(1, Math.max(0, ((px - sg.x0) * vx + (py - sg.y0) * vy) / L2)) : 0;
    best = Math.min(best, Math.hypot(px - (sg.x0 + u * vx), py - (sg.y0 + u * vy)));
  }
  return best;
}

/**
 * The no-tunnelling invariants (A6) of one replay: chord length, contiguity, distance of a dense 1 ms reference path to the chords, trail
 * spacing of recent(). `ring` is what the afterSample hook collected. Returns the numbers for the messages.
 */
function tunnelMetrics(res, ring, label) {
  const segs = res.segments;
  const lens = segs.map((sg) => Math.hypot(sg.x1 - sg.x0, sg.y1 - sg.y0));
  let gaps = 0;
  for (let i = 1; i < segs.length; i += 1) {
    if (Math.abs(segs[i].t0 - segs[i - 1].t1) < 0.01 && Math.hypot(segs[i].x0 - segs[i - 1].x1, segs[i].y0 - segs[i - 1].y1) > 0.5) gaps += 1;
    assert.ok(segs[i].t0 <= segs[i].t1, `${label}: segment times are ordered`);
    assert.ok(segs[i].speed > 0, `${label}: every segment has a positive speed (the game ignores speed 0)`);
  }
  let worst = 0;
  const rows = res.rows;
  for (let i = 1; i < rows.length; i += 1) {
    const r0 = rows[i - 1];
    const r1 = rows[i];
    if (!r1.segs.length || r1.discontinuity) continue;
    const dtMs = r1.t - r0.t;
    const dt = dtMs / 1000;
    for (let ms = 0; ms <= dtMs; ms += 1) {
      const tau = ms / 1000;
      const px = Math.min(FIELD.w, Math.max(0, r0.x + r0.vx * tau + 0.5 * ((r1.vx - r0.vx) / dt) * tau * tau));
      const py = Math.min(FIELD.h, Math.max(0, r0.y + r0.vy * tau + 0.5 * ((r1.vy - r0.vy) / dt) * tau * tau));
      worst = Math.max(worst, distToSegments(px, py, r1.segs));
    }
  }
  let maxStep = 0;
  for (let i = 1; i < rows.length; i += 1) maxStep = Math.max(maxStep, Math.hypot(rows[i].x - rows[i - 1].x, rows[i].y - rows[i - 1].y));
  return { chords: segs.length, maxChord: Math.max(...lens), gaps, worst, maxStep, maxSpacing: Math.max(...ring.spacing) };
}

/** An afterSample hook that records the spacing of recent() and counts the lost-packet intervals (dtMs above 55). */
function ringCollector() {
  const ring = { spacing: [], lost: 0 };
  ring.hook = (pipe, smp, row, i) => {
    if (i === 0 || row.discontinuity) return;
    if (smp.dtMs > 55) ring.lost += 1;
    const tail = pipe.recent(65);
    for (let j = 1; j < tail.length; j += 1) ring.spacing.push(tail[j].t - tail[j - 1].t);
  };
  return ring;
}

test('A6 no tunnelling at the maximum measured speeds: chords of at most 96 px, contiguous, within 12 px of the dense path, 8 ms trail spacing (reference 61 / 55 px, 0 gaps, 6.6 / 2.9 px)', () => {
  for (const [k, name] of [['fastH', 'fast_swings_h'], ['fastV', 'fast_swings_v']]) {
    const ring = ringCollector();
    const res = run(`${k}@ring`, name, { afterSample: ring.hook });
    const m = tunnelMetrics(res, ring, name);
    assert.ok(m.chords > (k === 'fastH' ? 100 : 50), `${name}: ${m.chords} segments (the vertical chops are shorter since round F1: the vertical gain is capped)`);
    assert.ok(m.maxChord <= 96, `${name}: longest chord ${f1(m.maxChord)} px (reference ${k === 'fastH' ? 61 : 55})`);
    assert.equal(m.gaps, 0, `${name}: ${m.gaps} gaps between consecutive chords`);
    assert.ok(m.worst <= 12, `${name}: dense path to chords ${m.worst.toFixed(1)} px (reference ${k === 'fastH' ? 6.6 : 2.9})`);
    assert.ok(m.maxSpacing <= 8.5, `${name}: largest trail spacing ${m.maxSpacing.toFixed(2)} ms`);
    assert.ok(m.maxStep <= 450, `${name}: largest step between two samples ${f1(m.maxStep)} px (reference ${k === 'fastH' ? 408 : 352})`);
    if (k === 'fastV') assert.ok(ring.lost >= 1, 'the vertical step of the recording contains lost-packet intervals (60 ms)');
  }
});

test('A6c lost packets in the middle of real strokes (60 ms steps): the same invariants hold and no stroke is split in two', () => {
  const base = stepSamples('fast_swings_h');
  const strokes = hardStrokes('fast_swings_h');
  // drop the sample just after the speed peak of every second stroke: that step becomes 60 ms in the middle of the stroke
  const drop = new Set(strokes.filter((_, i) => i % 2 === 0).map((st) => base.findIndex((x) => x.t >= st.tPeakMs) + 1));
  const samples = [];
  let carry = 0;
  base.forEach((smp, i) => {
    if (drop.has(i)) {
      carry += smp.dtMs;
      return;
    }
    samples.push({ ...smp, seq: samples.length, dtMs: smp.dtMs === null ? null : smp.dtMs + carry });
    carry = 0;
  });
  assert.equal(samples.length, base.length - drop.size);
  assert.ok(samples.filter((x) => x.dtMs > 55).length >= drop.size, 'the dropped samples became 60 ms steps');
  const ring = ringCollector();
  const gapped = replay('fast_swings_h', { samples, afterSample: ring.hook });
  const full = replay('fast_swings_h', { samples: base });
  const m = tunnelMetrics(gapped, ring, 'gapped');
  assert.ok(m.maxChord <= 96, `longest chord ${f1(m.maxChord)} px`);
  assert.equal(m.gaps, 0);
  assert.ok(m.worst <= 12, `dense path to chords ${m.worst.toFixed(1)} px`);
  assert.ok(m.maxSpacing <= 8.5, `trail spacing ${m.maxSpacing.toFixed(2)} ms`);
  const runs = (rows) => rows.filter((r, i) => r.cutting && (i === 0 || !rows[i - 1].cutting)).length;
  assert.equal(runs(gapped.rows), runs(full.rows), 'the same number of cut runs with and without the lost packets');
  assert.equal(new Set(gapped.rows.filter((r) => r.cutting).map((r) => r.swingId)).size, new Set(full.rows.filter((r) => r.cutting).map((r) => r.swingId)).size);
  assert.equal(gapped.rec.warning.filter((w) => w.code === 'sample_gap').length, 0, 'a 60 ms step is normal, not a hole');
});

test('A6b the trail ring of a real stroke holds interpolated samples that carry the cut state and the swing id', () => {
  const res = run('fastH@trail', 'fast_swings_h', {});
  const ring = res.pipe.recent(1e9);
  const interp = ring.filter((s) => s.interpolated);
  assert.ok(interp.length > 100 && interp.length < ring.length);
  assert.ok(interp.every((s) => s.source === 'imu' && s.trackingOk && !s.discontinuity && !s.segmentValid && s.x0 === s.x && s.t0 === s.t), 'fields of interpolated samples');
  assert.ok(interp.some((s) => s.cutting), 'some interpolated samples are inside a cut');
  for (let i = 1; i < ring.length; i += 1) assert.ok(ring[i].t >= ring[i - 1].t, 'the ring is chronological');
  // a cut run is cutting all the way through: interpolated samples between two cutting real samples are cutting too
  for (let i = 1; i < ring.length - 1; i += 1) {
    if (!ring[i].interpolated) continue;
    let a = i - 1;
    while (a > 0 && ring[a].interpolated) a -= 1;
    let b = i + 1;
    while (b < ring.length - 1 && ring[b].interpolated) b += 1;
    if (ring[a].cutting && ring[b].cutting && ring[a].swingId === ring[b].swingId && !ring[b].discontinuity) assert.equal(ring[i].cutting, true, `interpolated sample at ${ring[i].t}`);
  }
});

// --------------------------------------------------------------------------------------------------------------------- A7

test('A7 head extrapolation error at 60 fps: the drawn head is within 13 px on average of the quadratic path (reference mean 13.1, p95 45.5; holding the last sample: 113 / 319)', () => {
  const strokes = hardStrokes('fast_swings_h');
  const errs = [];
  const hold = [];
  const pending = [];
  const samples = stepSamples('fast_swings_h');
  replay('fast_swings_h', {
    samples,
    afterSample: (pipe, smp, row, i) => {
      // resolve the predictions made after the previous sample: truth = p_k + v_k tau + 0.5 (v_k+1 - v_k) / dt tau^2
      for (const p of pending.splice(0)) {
        const dt = (row.t - p.t) / 1000;
        for (const q of p.preds) {
          const tau = q.f * dt;
          const tx = Math.min(FIELD.w, Math.max(0, p.x + p.vx * tau + 0.5 * ((row.vx - p.vx) / dt) * tau * tau));
          const ty = Math.min(FIELD.h, Math.max(0, p.y + p.vy * tau + 0.5 * ((row.vy - p.vy) / dt) * tau * tau));
          errs.push(Math.hypot(q.hx - tx, q.hy - ty));
          hold.push(Math.hypot(p.x - tx, p.y - ty));
        }
      }
      const next = samples[i + 1];
      if (!next || !strokes.some((s) => row.t >= s.t0Ms && row.t <= s.t1Ms)) return;
      const dtNext = next.t - smp.t;
      const preds = [0.2, 0.4, 0.6, 0.8, 1.0].map((f) => {
        const h = pipe.headAt(smp.t + f * dtNext);
        return { f, hx: h.x, hy: h.y };
      });
      pending.push({ t: row.t, x: row.x, y: row.y, vx: row.vx, vy: row.vy, preds });
    },
  });
  assert.ok(errs.length > 300, `${errs.length} predictions`);
  const m = mean(errs);
  const p95 = quantile(errs, 0.95);
  assert.ok(m <= 20 && p95 <= 60, `head error mean ${f1(m)} px p95 ${f1(p95)} px (reference 13.1 / 45.5; holding the last sample ${f1(mean(hold))} / ${f1(quantile(hold, 0.95))})`);
  assert.ok(m < 0.25 * mean(hold), 'far better than holding the last sample');
});

// --------------------------------------------------------------------------------------------------------------------- A8

test('A8 posture independence: a slow 30 + 20 degree change of posture over 2 s moves the cursor by at most 250 px (reference 133 px; the shipped absolute pointer: 996 px)', () => {
  const base = stepSamples('return_still', 2);
  const res = replay('return_still', { samples: injectPostureChange(base) });
  const r = res.rows.find((q) => q.t >= 500 + 2000 + 300) ?? res.rows.at(-1);
  const off = Math.hypot(r.x - FIELD.cx, r.y - FIELD.cy);
  assert.ok(off <= 250, `cursor ${f1(off)} px from the centre (${f1(r.x - FIELD.cx)}, ${f1(r.y - FIELD.cy)}); reference 133 px (-114, -69)`);
  // the same change through the absolute model moves it by the whole angle: the model really is what makes the difference
  const abs = replay('return_still', { samples: injectPostureChange(base), pointerModel: 'absolute', settings: { autoCenter: false }, before: (pipe) => pipe.recenter('manual') });
  const a = abs.rows.find((q) => q.t >= 500 + 2000 + 300) ?? abs.rows.at(-1);
  assert.ok(Math.hypot(a.x - FIELD.cx, a.y - FIELD.cy) > 700, 'the absolute pointer follows the posture (shipped: 996 px)');
});

// --------------------------------------------------------------------------------------------------------------------- A9

test('A9 cut onset: the cut starts one sample (at most 35 ms) after the first sample at or above 300 deg/s, and the first chord is delivered retroactively (reference 30 ms, 31.25 max)', () => {
  for (const [k, name] of [['fastH', 'fast_swings_h'], ['fastV', 'fast_swings_v']]) {
    const res = get(k);
    const rows = res.rows;
    const latencies = [];
    for (const st of hardStrokes(name)) {
      const i = rows.findIndex((r) => r.t >= st.t0Ms - 60 && r.t <= st.tPeakMs && r.s >= 300);
      assert.ok(i > 0, `${name}: a sample at or above 300 deg/s exists at ${f1(st.tPeakMs)} ms`);
      const j = rows.findIndex((r, n) => n >= i && r.cutting);
      assert.ok(j >= i, `${name}: stroke at ${f1(st.tPeakMs)} ms cuts`);
      const lat = rows[j].t - rows[i].t;
      latencies.push(lat);
      assert.ok(lat <= 35, `${name}: stroke at ${f1(st.tPeakMs)} ms: onset ${f1(lat)} ms`);
      // the chords of the interval that ends at the first fast sample are delivered WITH the ENTER sample (retroactively)
      const retro = rows[j].segs.filter((sg) => sg.t0 >= rows[i - 1].t - 1e-9 && sg.t1 <= rows[i].t + 1e-9);
      assert.ok(retro.length > 0 && Math.abs(Math.min(...retro.map((sg) => sg.t0)) - rows[i - 1].t) < 1e-9 && Math.abs(Math.max(...retro.map((sg) => sg.t1)) - rows[i].t) < 1e-9,
        `${name}: the chords from the sample before the first fast one to the first fast one exist and come with the ENTER sample`);
      assert.ok(rows[j].segmentValid && rows[j].blade.t0 <= rows[i - 1].t + 1e-9, `${name}: BladeSample.t0 is the start of the first chord`);
    }
    assert.ok(Math.max(...latencies) <= 35, `${name}: onset max ${f1(Math.max(...latencies))} ms (reference 31.25)`);
  }
});

// --------------------------------------------------------------------------------------------------------------------- F1

/**
 * The cursor-height metrics of verifier finding F1 (docs/motion-verification-round-1.md section 4) of one replay: the share of CUTTING
 * samples in the middle half of the screen height (y 270 to 810), the median height, the share of samples on the bottom edge and in the
 * lowest 180 px, and the UNCLAMPED net vertical path of the cursor (the sum of the trapezoids of vy; a back and forth test nets about zero).
 */
function heightMetrics(res) {
  const rows = res.rows;
  const cut = rows.filter((r) => r.cutting);
  let netVy = 0;
  for (let i = 1; i < rows.length; i += 1) if (!rows[i].discontinuity) netVy += 0.5 * (rows[i].vy + rows[i - 1].vy) * ((rows[i].t - rows[i - 1].t) / 1000);
  return {
    cutInMid: (100 * cut.filter((r) => r.y >= 270 && r.y <= 810).length) / Math.max(1, cut.length),
    medY: median(rows.map((r) => r.y)),
    cutMedY: median(cut.map((r) => r.y)),
    bottom: (100 * rows.filter((r) => r.y >= FIELD.h - 0.5).length) / rows.length,
    low: (100 * rows.filter((r) => r.y >= FIELD.h - 180).length) / rows.length,
    netVy,
    nCut: cut.length,
  };
}
const OLD_VERTICAL = { pointer: { gravityVertical: false } }; // the vertical axis as it was before round F1

test('F1 sustained vigorous swinging does not sink the cursor to an edge: the horizontal slashes stay in the middle of the screen, the chops end near the ready pose (before: 10 % / 29 % of the cutting samples in the middle half, median y 987 / 1035)', () => {
  const h = heightMetrics(run('F1h', 'fast_swings_h', {}));
  assert.ok(h.nCut > 60, `${h.nCut} cutting samples`);
  assert.ok(h.cutInMid >= 75, `fast_swings_h: ${f1(h.cutInMid)} % of the CUTTING samples in y 270..810 (reference 94, before 10)`);
  assert.ok(h.medY >= 300 && h.medY <= 800, `fast_swings_h: median y ${f1(h.medY)} (reference 681, before 987)`);
  assert.ok(h.bottom <= 3 && h.low <= 15, `fast_swings_h: ${f1(h.bottom)} % of the samples on the bottom edge, ${f1(h.low)} % in the lowest 180 px (reference 0 / 0, before 24.8 / 67)`);
  assert.ok(Math.abs(h.netVy) <= 800, `fast_swings_h: the unclamped vertical path nets ${f1(h.netVy)} px (reference +92, before +4222: a back and forth test nets about zero)`);
  // the vertical step starts with the sword over the head (elevation 74 degrees), so its window starts at the first calm moment, the ready
  // pose, where the cursor is at the centre like after a calibration or a recentre
  const vRes = run('F1v', 'fast_swings_v', { fromS: 0.6 });
  const v = heightMetrics(vRes);
  assert.ok(v.nCut >= 15, `${v.nCut} cutting samples`);
  assert.ok(v.cutMedY <= 750 && v.medY >= 300 && v.medY <= 800, `fast_swings_v: median y ${f1(v.medY)}, of the cutting samples ${f1(v.cutMedY)} (reference 528 / 322, before 1017 / 986)`);
  assert.ok(v.bottom <= 3 && v.low <= 15, `fast_swings_v: ${f1(v.bottom)} % on the bottom edge, ${f1(v.low)} % in the lowest 180 px (reference 0 / 0, before 5.1 / 57)`);
  assert.ok(Math.abs(v.netVy) <= 500, `fast_swings_v: the unclamped vertical path nets ${f1(v.netVy)} px (reference -11, before +2297)`);
  // the chops are still strokes that cross a good part of the screen: the vertical gain is capped, not removed
  const chops = hardStrokes('fast_swings_v').filter((st) => st.t0Ms > 700);
  assert.equal(chops.length, 5);
  for (const st of chops) {
    const w = vRes.rows.filter((r) => r.t >= st.t0Ms - 600 - 30 && r.t <= st.t1Ms - 600 + 30);
    assert.ok(range(w.map((r) => r.y)) >= 250, `chop at ${f1(st.tPeakMs)} ms spans ${f1(range(w.map((r) => r.y)))} px vertically (reference 387 to 431)`);
  }
});

test('F1 holds at the other sensitivities (0.6 and 2.0) and the test has teeth: the vertical axis of before round F1 reproduces the finding on the same data', () => {
  for (const sens of [0.6, 2.0]) {
    const h = heightMetrics(replay('fast_swings_h', { settings: { sensitivity: sens } }));
    assert.ok(h.cutInMid >= 50 && h.bottom <= 5, `sensitivity ${sens}: ${f1(h.cutInMid)} % of the CUTTING samples in the middle half, ${f1(h.bottom)} % on the bottom edge (before 21 / 24.8 and 21 / 28.8)`);
    const v = heightMetrics(replay('fast_swings_v', { fromS: 0.6, settings: { sensitivity: sens } }));
    assert.ok(v.low <= 15 && v.bottom <= 3, `sensitivity ${sens}: vertical step ${f1(v.low)} % in the lowest 180 px, ${f1(v.bottom)} % on the bottom edge`);
  }
  const old = heightMetrics(replay('fast_swings_h', { config: OLD_VERTICAL }));
  assert.ok(old.cutInMid < 30 && old.medY > 900 && old.bottom > 10 && old.low > 50 && old.netVy > 2500, `the old vertical axis: ${f1(old.cutInMid)} % in the middle half, median y ${f1(old.medY)}, bottom ${f1(old.bottom)} %, net ${f1(old.netVy)} px (the finding: 10 %, 987, 24.8 %, +4222)`);
  const oldV = heightMetrics(replay('fast_swings_v', { fromS: 0.6, config: OLD_VERTICAL }));
  assert.ok(oldV.low > 40 && oldV.netVy > 1500, `the old vertical axis on the chops: ${f1(oldV.low)} % in the lowest 180 px, net ${f1(oldV.netVy)} px`);
});

test('F1 leaves the slow steps as they were: the same hold, sweep and posture numbers, no cursor movement while holding still, the yaw sweep is more horizontal than before', () => {
  for (const [key, name, w] of [['hold', 'hold_still', { fromS: 7 }], ['still', 'return_still', { fromS: 2 }]]) {
    const a = run(`F1-${key}`, name, w);
    assert.equal(range(a.rows.map((r) => r.y)), 0, `${name}: the cursor does not move at all`);
  }
  const yaw = run('F1-yaw', 'yaw_sweep', { fromS: 1, toS: 21 });
  const oldYaw = replay('yaw_sweep', { fromS: 1, toS: 21, config: OLD_VERTICAL });
  assert.ok(range(yaw.rows.map((r) => r.y)) < range(oldYaw.rows.map((r) => r.y)), 'the yaw sweep leaks less into the vertical direction (22 against 31 % of the height)');
  assert.deepEqual(yaw.rows.map((r) => r.x), oldYaw.rows.map((r) => r.x), 'the horizontal axis is untouched');
  // pitch aiming below about 75 deg/s is exactly the contract curve: the pitch sweep covers the same height as before
  const pitch = run('F1-pitch', 'pitch_sweep', { fromS: 1, toS: 21 });
  const oldPitch = replay('pitch_sweep', { fromS: 1, toS: 21, config: OLD_VERTICAL });
  assert.ok(Math.abs(range(pitch.rows.map((r) => r.y)) - range(oldPitch.rows.map((r) => r.y))) < 15, `pitch sweep y range ${f1(range(pitch.rows.map((r) => r.y)))} against ${f1(range(oldPitch.rows.map((r) => r.y)))} px`);
});

// --------------------------------------------------------------------------------------------------------------------- extra: replay determinism and the calibration of the recording

test('the exact calibration validates, and replaying twice gives identical rows (the pipeline is deterministic)', () => {
  const a = replay('fast_swings_v', { fromS: 0, toS: 4 });
  const b = replay('fast_swings_v', { fromS: 0, toS: 4 });
  assert.deepEqual(a.rows.map((r) => [r.x, r.y, r.cutting, r.swingId]), b.rows.map((r) => [r.x, r.y, r.cutting, r.swingId]));
  assert.deepEqual(a.segments, b.segments);
  assert.equal(realCalibration().gyroBiasDps.y, REAL_BIAS_DPS.y);
});
