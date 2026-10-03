// Seeded fuzzing of the whole Motion API: random sensor garbage and random call order must never throw, never produce NaN,
// and every emitted object must satisfy the contract validators.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRng } from '../../public/js/shared/rng.js';
import { assertValid } from '../../public/js/shared/validate.js';
import { createManualClock } from '../../public/js/shared/clock.js';
import { createSynth, keyframes } from '../../test-support/motion/synth.js';
import { record, createAbsolutePipeline } from '../../test-support/motion/harness.js';

function randomSample(rng, i, t, dtMs) {
  const wild = rng.chance(0.05);
  const mag = wild ? rng.range(0, 8) : 1;
  const ux = rng.range(-1, 1);
  const uy = rng.range(-1, 1);
  const uz = rng.range(-1, 1);
  const n = Math.hypot(ux, uy, uz) || 1;
  const gscale = wild ? 2000 : rng.chance(0.3) ? 300 : 5;
  return {
    seq: i, t, arrivedAt: t + 4, dtMs, dtSource: rng.chance(0.05) ? 'arrival' : 'device',
    accel: rng.chance(0.02) ? { x: 0, y: 0, z: 0 } : { x: (ux / n) * mag, y: (uy / n) * mag, z: (uz / n) * mag },
    gyro: { x: rng.range(-gscale, gscale), y: rng.range(-gscale, gscale), z: rng.range(-gscale, gscale) },
    side: rng.pick(['L', 'R', '?']), buttons: [], batteryMv: 3700, tempC: 25, imuActive: !rng.chance(0.02),
  };
}

test('fuzz: 40 000 random operations (garbage samples, random API order) never throw or produce NaN', () => {
  const rng = createRng(20260930);
  const clock = createManualClock(0);
  const pipe = createAbsolutePipeline({ clock });
  const synth = createSynth({ mount: 'tilted', hz: 66, seed: 5 });
  const goodCal = synth.nominalCalibration();
  // The Emitter swallows exceptions thrown inside listeners, so problems are collected and asserted at the end.
  const rec = record(pipe); // validates every BladeSample and Calibration and checks monotonic blade time
  const problems = [];
  const expect = (cond, msg) => {
    if (!cond) problems.push(msg);
  };
  pipe.on('blade', (b) => {
    for (const v of [b.x, b.y, b.speed, b.t]) expect(Number.isFinite(v), `non-finite value in ${JSON.stringify(b)}`);
  });
  pipe.on('calibration', (e) => expect(typeof e.type === 'string' && Number.isFinite(e.t), `bad calibration event ${JSON.stringify(e)}`));
  pipe.on('recenter', (e) => expect(['manual', 'auto', 'edge', 'calibration', 'reconnect'].includes(e.kind), `bad recenter kind ${e.kind}`));
  pipe.on('warning', (w) => expect(typeof w.code === 'string' && typeof w.message === 'string', 'bad warning'));

  let t = 100;
  for (let i = 0; i < 40000; i += 1) {
    const r = rng.next();
    if (r < 0.7) {
      const dt = rng.chance(0.03) ? rng.pick([null, 0, -5, 250, 900]) : rng.range(3, 40);
      t += dt !== null && dt > 0 && dt < 200 ? dt : rng.range(0, 400);
      clock.set(Math.max(clock.now(), t));
      pipe.pushImu(randomSample(rng, i, rng.chance(0.01) ? t - 50 : t, dt));
    } else if (r < 0.75) {
      t += rng.range(1, 30);
      clock.set(Math.max(clock.now(), t));
      pipe.pushAim({ t, x: rng.range(-500, 2500), y: rng.range(-500, 1500), discontinuity: rng.chance(0.05) });
    } else if (r < 0.8) {
      clock.set(clock.now() + rng.range(0, 500));
      pipe.poll(clock.now() + rng.range(0, 300));
    } else if (r < 0.83) {
      pipe.startCalibration({ side: rng.pick(['L', 'R', '?']) });
    } else if (r < 0.85) {
      pipe.cancelCalibration();
    } else if (r < 0.87) {
      pipe.confirmCenter();
    } else if (r < 0.89) {
      pipe.beginQuickRecenter();
    } else if (r < 0.91) {
      pipe.recenter(rng.pick(['manual', 'reconnect', undefined]));
    } else if (r < 0.92) {
      pipe.setCalibration(rng.chance(0.2) ? null : goodCal);
    } else if (r < 0.93) {
      pipe.reset();
      rec.resetTime(); // a reset starts a new session
    } else if (r < 0.95) {
      pipe.setSettings({ sensitivity: rng.range(0.1, 3), cutThreshold: rng.range(0, 5000), cutMul: rng.range(0, 4), autoCenter: rng.chance(0.5), flipX: rng.chance(0.5) });
    } else if (r < 0.96) {
      pipe.markDiscontinuity('fuzz');
    } else if (r < 0.98) {
      const segs = pipe.drainSegments();
      for (const s of segs) assertValid('BladeSegment', s);
      pipe.recent(rng.range(0, 400));
    } else {
      const h = pipe.headAt(clock.now() + rng.range(-20, 60));
      if (h) assert.ok(Number.isFinite(h.x) && Number.isFinite(h.y) && h.x >= 0 && h.x <= 1920 && h.y >= 0 && h.y <= 1080);
      const st = pipe.getState();
      for (const k of ['x', 'y', 'speed', 'angularSpeedDps']) assert.ok(Number.isFinite(st[k]), `state.${k}`);
      pipe.getDebug();
      const c = pipe.getCalibration();
      if (c) assertValid('Calibration', c);
    }
  }
  rec.check();
  assert.deepEqual(problems, []);
  assert.ok(rec.blades.length > 1000, `${rec.blades.length} blade samples validated`);
});

test('fuzz: a realistic stream with random cuts of the API (cancel, restart, recentre) during a long session stays consistent', () => {
  const rng = createRng(7);
  const synth = createSynth({ mount: 'sideRail', side: 'L', hz: 66, seed: 8 });
  const pipe = createAbsolutePipeline();
  pipe.setCalibration(synth.nominalCalibration());
  const keys = [{ t: 0, yaw: 0, pitch: 0 }];
  for (let i = 1; i <= 120; i += 1) keys.push({ t: i * 400, yaw: rng.range(-30, 30), pitch: rng.range(-15, 15), roll: rng.range(-90, 90) });
  const samples = synth.generate(keyframes(keys), 48000);
  const rec = record(pipe); // contract validation and monotonic blade time (violations are collected, then re-thrown)
  for (const s of samples) {
    pipe.pushImu(s);
    if (rng.chance(0.01)) pipe.recenter();
    if (rng.chance(0.005)) pipe.markDiscontinuity('x');
    if (rng.chance(0.01)) pipe.poll(s.t + rng.range(0, 300));
    if (rng.chance(0.02)) for (const g of pipe.drainSegments()) assertValid('BladeSegment', g);
  }
  rec.check();
  assert.ok(rec.blades.length > 2000);
});
