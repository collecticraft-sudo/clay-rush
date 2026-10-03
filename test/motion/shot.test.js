// Clay Rush motion additions (docs/architecture.md 4.2): aimAt(t), shotDiagnostics(tPress, compMs) and the aimCurve presets.
// Synthetic sensors only (exact tip-speed streams, aim samples): nothing here says how a real trigger pull moves a real Joy-Con
// (UNVERIFIED-ON-HARDWARE).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMotionPipeline, MOTION_CONFIG } from '../../public/js/motion/index.js';
import { pointerSpeedPxS, verticalGainPxPerDeg } from '../../public/js/motion/pointer.js';
import { createTipStream, mountCalibration } from '../../test-support/motion/tip-stream.js';
import { feed, record } from '../../test-support/motion/harness.js';

const CFG = MOTION_CONFIG.pointer;
const SH = MOTION_CONFIG.shot;

function relative({ settings = {}, hz = 33 } = {}) {
  const pipe = createMotionPipeline({ pointerModel: 'relative', settings: { autoCenter: false, ...settings } });
  const rec = record(pipe);
  pipe.setCalibration(mountCalibration('faceUp', 'R'));
  return { pipe, rec, stream: createTipStream({ mount: 'faceUp', side: 'R', hz, startMs: 1000 }) };
}

/** Linear interpolation over a chronological list of {t, x, y} (the trail ring as recent() returns it). */
function lerpRing(ring, t) {
  for (let i = 0; i + 1 < ring.length; i += 1) {
    const a = ring[i];
    const b = ring[i + 1];
    if (a.t <= t && t <= b.t) {
      if (b.t === a.t) return { x: b.x, y: b.y };
      const u = (t - a.t) / (b.t - a.t);
      return { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u };
    }
  }
  return null;
}

const aimSample = (t, x, y, discontinuity = false) => ({ t, x, y, discontinuity });

// ------------------------------------------------------------------------------------------------ config

test('config: the aim history spans at least 300 ms whatever the input rate; the analysis defaults are those of the contract', () => {
  assert.ok(SH.historySize * SH.minSpacingMs >= 300, 'size x minimum spacing >= 300 ms');
  assert.equal(SH.jerkWindowMs, 150);
  assert.equal(SH.settleMs, 80);
  assert.equal(SH.intendedLeadMs, 200);
  assert.deepEqual(SH.compCandidatesMs, [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100]);
});

test('aimCurve presets (design 6.2): balanced is the shipped curve, precise 4 -> 11 px/deg, fast 6 -> 18 px/deg', () => {
  const c = MOTION_CONFIG.aimCurves;
  assert.deepEqual(Object.keys(c).sort(), ['balanced', 'fast', 'precise']);
  assert.deepEqual([c.balanced.gLoPxDeg, c.balanced.gHiPxDeg, c.balanced.verticalMaxPxDeg], [CFG.gLoPxDeg, CFG.gHiPxDeg, CFG.verticalMaxPxDeg]);
  assert.deepEqual([c.precise.gLoPxDeg, c.precise.gHiPxDeg], [4, 11]);
  assert.deepEqual([c.fast.gLoPxDeg, c.fast.gHiPxDeg], [6, 18]);
  assert.equal(MOTION_CONFIG.aimCurveDefault, 'balanced');
  assert.ok(Object.isFrozen(c.fast));
});

// ------------------------------------------------------------------------------------------------ aimCurve through setSettings

test('aimCurve: setSettings applies the preset to the relative pointer (horizontal curve and vertical cap); unknown names are ignored', () => {
  for (const name of ['precise', 'balanced', 'fast']) {
    const preset = { ...CFG, ...MOTION_CONFIG.aimCurves[name] };
    for (const s of [10, 100, 300, 1000]) {
      const r = relative({ settings: { aimCurve: name } });
      assert.equal(r.pipe.getSettings().aimCurve, name);
      feed(r.pipe, r.stream.hold(3, s));
      const b = r.rec.blades.at(-1);
      assert.ok(Math.abs(b.vx - pointerSpeedPxS(s, 1, preset)) < 1e-6, `${name} at ${s} deg/s: ${b.vx}`);
      const up = relative({ settings: { aimCurve: name, sensitivity: 1.5 } });
      feed(up.pipe, up.stream.hold(3, 0, s));
      const bu = up.rec.blades.at(-1);
      assert.ok(Math.abs(-bu.vy - verticalGainPxPerDeg(s, 1.5, preset) * s) < 1e-6, `${name} vertical at ${s} deg/s`);
    }
  }
  // at 1000 deg/s the effective gain is the preset's gHi (995 / 1000 of it: the dead zone)
  const gain = (name) => {
    const r = relative({ settings: { aimCurve: name } });
    feed(r.pipe, r.stream.hold(3, 1000));
    return r.rec.blades.at(-1).vx / 1000;
  };
  assert.ok(Math.abs(gain('precise') - 11 * 0.995) < 1e-9);
  assert.ok(Math.abs(gain('balanced') - 14 * 0.995) < 1e-9);
  assert.ok(Math.abs(gain('fast') - 18 * 0.995) < 1e-9);
  // live change and junk
  const r = relative();
  assert.equal(r.pipe.getSettings().aimCurve, 'balanced');
  r.pipe.setSettings({ aimCurve: 'fast' });
  r.pipe.setSettings({ aimCurve: 'turbo' });
  r.pipe.setSettings({ aimCurve: 3 });
  r.pipe.setSettings({ aimCurve: 'toString' });
  assert.equal(r.pipe.getSettings().aimCurve, 'fast');
  feed(r.pipe, r.stream.hold(3, 300));
  assert.ok(Math.abs(r.rec.blades.at(-1).vx - pointerSpeedPxS(300, 1, { ...CFG, ...MOTION_CONFIG.aimCurves.fast })) < 1e-6);
  r.pipe.reset();
  assert.equal(r.pipe.getSettings().aimCurve, 'fast', 'reset keeps the settings');
});

test('aimCurve: the cut decision, the dead zone and the idle centring do not depend on the preset', () => {
  for (const name of ['precise', 'fast']) {
    const a = relative({ settings: { aimCurve: name } });
    feed(a.pipe, a.stream.hold(10, 4.9));
    assert.equal(a.rec.blades.at(-1).x, 960, `${name}: 4.9 deg/s stays in the dead zone`);
    const b = relative({ settings: { aimCurve: name } });
    const base = relative();
    const prof = [{ ms: 300, s: 0 }, { ms: 200, s: 500 }, { ms: 300, s: 0 }];
    feed(b.pipe, b.stream.profile(prof));
    feed(base.pipe, base.stream.profile(prof));
    assert.deepEqual(b.rec.blades.map((x) => x.cutting), base.rec.blades.map((x) => x.cutting), `${name}: same cut sequence`);
  }
});

// ------------------------------------------------------------------------------------------------ aimAt, relative model (IMU)

test('aimAt (IMU): exact at every ring entry, linear between the two entries around t (real or interpolated), never extrapolated', () => {
  const r = relative();
  const prof = [{ ms: 200, s: 0 }, { ms: 400, vR: 150, vU: 60 }, { ms: 300, vR: -80, vU: -120 }, { ms: 200, s: 0 }];
  feed(r.pipe, r.stream.profile(prof));
  const ring = r.pipe.recent(1e9);
  assert.ok(ring.some((s) => s.interpolated), 'the relative model adds interpolated samples');
  for (const s of ring) {
    const a = r.pipe.aimAt(s.t);
    assert.equal(a.valid, true);
    assert.ok(Math.abs(a.x - s.x) < 1e-9 && Math.abs(a.y - s.y) < 1e-9, `at ${s.t}`);
  }
  for (let t = ring[0].t; t <= ring.at(-1).t; t += 3.7) {
    const want = lerpRing(ring, t);
    const a = r.pipe.aimAt(t);
    assert.equal(a.valid, true, `valid at ${t}`);
    assert.ok(Math.abs(a.x - want.x) < 1e-6 && Math.abs(a.y - want.y) < 1e-6, `lerp at ${t}`);
  }
  const newest = r.pipe.latest();
  const after = r.pipe.aimAt(newest.t + 1);
  assert.equal(after.valid, false, 'after the newest sample: no extrapolation');
  assert.deepEqual([after.x, after.y], [newest.x, newest.y], 'the nearest known position');
  const before = r.pipe.aimAt(ring[0].t - 1);
  assert.equal(before.valid, false, 'before the first sample');
  assert.equal(r.pipe.aimAt(NaN).valid, false);
});

test('aimAt (IMU): the history covers at least 300 ms (here several seconds at 33 Hz), valid only where tracking was ok', () => {
  const r = relative();
  feed(r.pipe, r.stream.profile([{ ms: 3000, vR: 40, vU: 10 }]));
  const newest = r.pipe.latest();
  for (const back of [0, 100, 300, 1000, 2500]) assert.equal(r.pipe.aimAt(newest.t - back).valid, true, `${back} ms back`);
  // tracking lost: poll() emits a synthetic sample with trackingOk false; nothing around it is valid
  r.pipe.poll(newest.t + MOTION_CONFIG.trackingLostMs + 50);
  const lost = r.pipe.latest();
  assert.equal(lost.trackingOk, false);
  assert.equal(r.pipe.aimAt(lost.t).valid, false, 'the lost sample');
  assert.equal(r.pipe.aimAt(newest.t + 100).valid, false, 'inside the hole');
  assert.equal(r.pipe.aimAt(newest.t - 100).valid, true, 'before it, still fine');
  r.pipe.reset();
  assert.equal(r.pipe.aimAt(newest.t - 100).valid, false, 'reset() forgets the history');
});

test('aimAt (IMU): a hole longer than maxGapMs is not interpolated across; a reanchor jump holds the earlier position', () => {
  const r = relative();
  feed(r.pipe, r.stream.hold(10, 50));
  const before = r.pipe.latest();
  r.stream.skip(400);
  feed(r.pipe, r.stream.hold(3, 50), { poll: false });
  assert.equal(r.pipe.aimAt(before.t + 150).valid, false, 'inside a 400 ms hole');
  const q = relative();
  feed(q.pipe, q.stream.hold(10, 50));
  const p0 = q.pipe.latest();
  q.pipe.reanchor(300, 200);
  feed(q.pipe, q.stream.hold(1, 50));
  const p1 = q.pipe.latest();
  assert.equal(p1.discontinuity, true);
  assert.deepEqual([p1.x, p1.y], [300, 200]);
  const mid = q.pipe.aimAt((p0.t + p1.t) / 2);
  assert.equal(mid.valid, true);
  assert.deepEqual([mid.x, mid.y], [p0.x, p0.y], 'no sweep across a teleport');
});

// ------------------------------------------------------------------------------------------------ aimAt, aim path (mouse)

test('aimAt (aim samples): the latest sample at or before t, which holds beyond the newest one; invalid before the first', () => {
  const pipe = createMotionPipeline({});
  record(pipe);
  pipe.pushAim(aimSample(100, 10, 20, true));
  pipe.pushAim(aimSample(110, 30, 40));
  pipe.pushAim(aimSample(150, 1000, 500));
  assert.equal(pipe.aimAt(99).valid, false);
  assert.deepEqual(pipe.aimAt(100), { x: 10, y: 20, valid: true });
  assert.deepEqual(pipe.aimAt(109.9), { x: 10, y: 20, valid: true }, 'no interpolation for a mouse: it was there');
  assert.deepEqual(pipe.aimAt(110), { x: 30, y: 40, valid: true });
  assert.deepEqual(pipe.aimAt(149), { x: 30, y: 40, valid: true });
  assert.deepEqual(pipe.aimAt(5000), { x: 1000, y: 500, valid: true }, 'a resting mouse sends nothing: it is still there');
  pipe.pushAim(aimSample(160, -50, 5000)); // clamped like every blade sample
  assert.deepEqual(pipe.aimAt(170), { x: 0, y: 1080, valid: true });
});

test('aimAt (aim samples): a 1 kHz and an 8 kHz mouse still leave at least 300 ms of history, to within half a millisecond of motion', () => {
  for (const stepMs of [1, 0.125]) {
    const pipe = createMotionPipeline({});
    const xAt = (t) => 200 + t * 0.5; // 500 px/s
    let t = 0;
    for (; t <= 2000; t += stepMs) pipe.pushAim(aimSample(t, xAt(t), 300));
    const newestT = t - stepMs;
    for (const back of [0, 50, 150, 300]) {
      const q = newestT - back - 0.3;
      const a = pipe.aimAt(q);
      assert.equal(a.valid, true, `${stepMs} ms steps, ${back} ms back`);
      assert.ok(Math.abs(a.x - xAt(q)) <= 0.5 * (SH.minSpacingMs + stepMs), `${stepMs} ms steps, ${back} ms back: ${a.x} vs ${xAt(q)}`);
    }
  }
});

test('aimAt: a change of source is not interpolated across (IMU then mouse)', () => {
  const r = relative();
  feed(r.pipe, r.stream.hold(10, 50));
  const last = r.pipe.latest();
  r.pipe.pushAim(aimSample(last.t + 20, 100, 100));
  assert.equal(r.pipe.aimAt(last.t + 10).valid, false);
  assert.deepEqual(r.pipe.aimAt(last.t + 20), { x: 100, y: 100, valid: true });
  assert.equal(r.pipe.aimAt(last.t).valid, true);
});

// ------------------------------------------------------------------------------------------------ shotDiagnostics

/** Hold still, then a trigger jerk: the tip dips at `dps` for `durMs`, starting `leadMs` BEFORE the press sample. */
function jerkRun({ dps = 60, durMs = 90, leadMs = 30, stillMs = 1000 } = {}) {
  const r = relative();
  const dt = r.stream.dtMs;
  feed(r.pipe, r.stream.hold(Math.round(stillMs / dt), 0));
  const nLead = Math.round(leadMs / dt);
  const nJerk = Math.round(durMs / dt);
  const startT = r.stream.now + dt;
  const samples = [...r.stream.hold(nJerk, 0, -dps), ...r.stream.hold(20, 0)];
  feed(r.pipe, samples);
  const tPress = startT + nLead * dt;
  return { r, tPress };
}

test('shotDiagnostics: jerk peak in [tPress, tPress + 150], displacement from the compensated aim to the aim 80 ms after the press', () => {
  const { r, tPress } = jerkRun();
  const reals = r.rec.blades.filter((b) => !b.interpolated && b.t >= tPress && b.t <= tPress + SH.jerkWindowMs);
  const peak = Math.max(...reals.map((b) => b.angularSpeedDps));
  for (const comp of [0, 40, 100]) {
    const d = r.pipe.shotDiagnostics(tPress, comp);
    assert.equal(d.valid, true);
    assert.ok(Math.abs(d.jerkPeakDps - peak) < 1e-9, `peak ${d.jerkPeakDps} vs ${peak}`);
    const a = r.pipe.aimAt(tPress - comp);
    const b = r.pipe.aimAt(tPress + SH.settleMs);
    assert.ok(Math.abs(d.displacementPx - Math.hypot(b.x - a.x, b.y - a.y)) < 1e-9);
    assert.deepEqual(Object.keys(d).sort(), ['displacementPx', 'jerkPeakDps', 'valid']);
  }
  assert.ok(Math.abs(r.pipe.shotDiagnostics(tPress, 0).jerkPeakDps - 60) < 1e-6, 'a pure tip dip: |w| = 60 deg/s');
  // the compensation looks back to before the jerk started: the displacement grows with it here (the jerk moves the aim away)
  const d0 = r.pipe.shotDiagnostics(tPress, 0).displacementPx;
  const d100 = r.pipe.shotDiagnostics(tPress, 100).displacementPx;
  assert.ok(d100 > d0, `${d100} > ${d0}`);
  // and the aim 100 ms before the press is where the hand rested
  assert.deepEqual([r.pipe.aimAt(tPress - 100).x, r.pipe.aimAt(tPress - 100).y], [960, 540]);
});

test('shotDiagnostics: invalid when the settle point is not covered yet, or before any data; peak 0 without samples in the window', () => {
  const r = relative();
  feed(r.pipe, r.stream.hold(20, 0));
  const newest = r.pipe.latest().t;
  const early = r.pipe.shotDiagnostics(newest - 20, 40);
  assert.equal(early.valid, false, 'tPress + 80 lies beyond the newest sample');
  assert.equal(early.jerkPeakDps, 0);
  const none = createMotionPipeline({}).shotDiagnostics(100, 40);
  assert.deepEqual(none, { jerkPeakDps: 0, displacementPx: 0, valid: false });
  assert.equal(r.pipe.shotDiagnostics(NaN, 40).valid, false);
});

test('shotDiagnostics (mouse): the jerk is the deg/s-equivalent cursor speed, the displacement the cursor travel', () => {
  const pipe = createMotionPipeline({});
  for (let t = 0; t <= 400; t += 8) pipe.pushAim(aimSample(t, t < 200 ? 500 : 500 + (t - 200), 400));
  const d = pipe.shotDiagnostics(200, 0);
  assert.equal(d.valid, true);
  assert.ok(Math.abs(d.displacementPx - 80) < 1e-9, `${d.displacementPx}`);
  assert.ok(Math.abs(d.jerkPeakDps - 1000 / (10 / 3)) < 1e-6, `1000 px/s is 300 deg/s-equivalent: ${d.jerkPeakDps}`);
});

// ------------------------------------------------------------------------------------------------ review fixes (2026-10-03)

test('MOTION_CONFIG.shooter (the gains the game plays with) matches design 6.2; pointer = aimCurves.balanced; sensitivity 3.0 survives the clamp', () => {
  const s = MOTION_CONFIG.shooter;
  assert.deepEqual(s.aimCurves.precise, { gLoPxDeg: 6, gHiPxDeg: 17, verticalMaxPxDeg: 13 });
  assert.deepEqual(s.aimCurves.balanced, { gLoPxDeg: 8, gHiPxDeg: 24, verticalMaxPxDeg: 19 });
  assert.deepEqual(s.aimCurves.fast, { gLoPxDeg: 11, gHiPxDeg: 32, verticalMaxPxDeg: 25 });
  assert.deepEqual(s.pointer, s.aimCurves.balanced, 'shooter.pointer and shooter.aimCurves.balanced stay equal');
  for (const k of ['gLoPxDeg', 'gHiPxDeg', 'verticalMaxPxDeg']) assert.equal(MOTION_CONFIG.aimCurves.balanced[k], CFG[k], `sword reference: ${k}`);
  assert.deepEqual(s.input.sensitivityRange, [0.3, 3.0, 0.1]);
  const pipe = createMotionPipeline({ pointerModel: 'relative', config: s, settings: { sensitivity: 3.0, autoCenter: false } });
  assert.equal(pipe.getSettings().sensitivity, 3.0, 'not clamped to the sword range 2.0');
  for (const [name, hi] of [['precise', 17], ['balanced', 24], ['fast', 32]]) {
    const p = createMotionPipeline({ pointerModel: 'relative', config: s, settings: { aimCurve: name, autoCenter: false } });
    record(p);
    p.setCalibration(mountCalibration('faceUp', 'R'));
    const st = createTipStream({ mount: 'faceUp', side: 'R', startMs: 1000 });
    feed(p, st.hold(3, 1000));
    assert.ok(Math.abs(p.latest().vx / 1000 - hi * 0.995) < 1e-9, `${name}: ${p.latest().vx / 1000} px/deg at 1000 deg/s`);
  }
});

test('aimCurve balanced reads aimCurves.balanced (review I-04): editing only the preset takes effect', () => {
  const pipe = createMotionPipeline({ pointerModel: 'relative', config: { aimCurves: { balanced: { gLoPxDeg: 5, gHiPxDeg: 20, verticalMaxPxDeg: 6 } } }, settings: { autoCenter: false } });
  record(pipe);
  pipe.setCalibration(mountCalibration('faceUp', 'R'));
  feed(pipe, createTipStream({ mount: 'faceUp', side: 'R', startMs: 1000 }).hold(3, 1000));
  assert.ok(Math.abs(pipe.latest().vx / 1000 - 20 * 0.995) < 1e-9);
});

test('aimAt (review I-02): two real IMU samples with the same t (a burst under the arrival-time fallback) keep the FIRST measurement', () => {
  const r = relative();
  const samples = r.stream.hold(10, 100);
  feed(r.pipe, samples);
  const a = r.pipe.latest();
  // the next report arrives in the same burst: same t, its own (later) motion
  const b = { ...r.stream.hold(1, 100)[0], t: a.t, arrivedAt: a.t, dtMs: 15, dtSource: 'arrival' }; // the arrival fallback still integrates its mean dt
  r.pipe.pushImu(b);
  assert.notDeepEqual([r.pipe.latest().x, r.pipe.latest().y], [a.x, a.y], 'B moved the cursor (otherwise the test proves nothing)');
  const got = r.pipe.aimAt(a.t);
  assert.equal(got.valid, true);
  assert.deepEqual([got.x, got.y], [a.x, a.y], 'the position of report A, not of B');
});
