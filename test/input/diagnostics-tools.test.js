// Diagnostics page maths (docs/architecture.md 5.10, 5.12): histogram, rate meter, scale integrator, gravity-vs-gyro sign
// test, rest check, latency probe, owner report. The tools are driven with the simulator's IMU stream. What they would
// show on a real Joy-Con is UNVERIFIED-ON-HARDWARE until the owner runs them.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  percentile, intervalStats, histogram, createRateMeter, createStillWindow, createScaleTool, createSignTest, createRestCheck, createLatencyProbe,
  batteryBand, formatHex, CHECKLIST, buildReport, saveScale, loadScale, saveAccelSign, loadAccelSign, buildGameUrl, GAME_ACCEL_RANGE, clearSavedRecord,
  NATIVE_CHECKLIST, parseMode, formatAdverts, createKeepAliveExperiment,
} from '../../public/js/input/diagnostics-tools.js';
import { makeSim, MOUNT_NAMES } from '../../test-support/input/sim-harness.js';
import { INPUT_CONFIG } from '../../public/js/input/input-config.js';

const T = { timeout: 60000 };

test('percentile and interval statistics', () => {
  assert.equal(percentile([], 0.5), null);
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.95), 10);
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.5), 5);
  const s = intervalStats([15, 15, 16, 14, 30, 15, 15]);
  assert.deepEqual([s.count, s.min, s.median, s.max], [7, 14, 15, 30]);
  assert.equal(s.p95, 30);
  assert.ok(Math.abs(s.mean - 120 / 7) < 1e-12);
  assert.equal(intervalStats([]).median, null);
  assert.equal(intervalStats([1, 3]).median, 2);
});

test('histogram: bins of the given width, values beyond the maximum in overflow', () => {
  const h = histogram([1, 2, 2.4, 2.6, 14.9, 15, 59.9, 60, 500], { binMs: 2.5, maxMs: 60 });
  assert.equal(h.bins.length, 24);
  assert.equal(h.bins[0].count, 3);
  assert.equal(h.bins[1].count, 1);
  assert.equal(h.bins[5].count, 1);
  assert.equal(h.bins[6].count, 1);
  assert.equal(h.bins[23].count, 1);
  assert.equal(h.overflow, 2);
  assert.equal(h.bins.reduce((a, b) => a + b.count, 0) + h.overflow, 9);
  assert.equal(histogram([]).overflow, 0);
});

test('rate meter: packets per second over 1 s and 10 s, inter-arrival list, reset', () => {
  const m = createRateMeter();
  assert.equal(m.rate(0, 1000), null);
  m.push(0);
  assert.equal(m.rate(0, 1000), null);
  const period = 1000 / 66;
  let last = 0;
  for (let i = 1; i <= 66 * 12; i++) {
    last = i * period;
    m.push(last);
  }
  assert.ok(Math.abs(m.rate(last, 1000) - 66) < 1.5, `rate 1 s: ${m.rate(last, 1000)}`);
  assert.ok(Math.abs(m.rate(last, 10_000) - 66) < 0.5, `rate 10 s: ${m.rate(last, 10_000)}`);
  const iv = m.intervals();
  assert.ok(iv.length <= 600 && iv.every((v) => Math.abs(v - period) < 1e-6));
  assert.equal(m.rate(last + 20_000, 1000), 0, 'stalled stream');
  m.reset();
  assert.equal(m.count(), 0);
  assert.equal(m.rate(0, 1000), null);
});

test('rate meter memory stays bounded over a long run', () => {
  const m = createRateMeter();
  for (let i = 0; i < 200_000; i++) m.push(i * 4);
  assert.ok(m.count() < 4000, `${m.count()} timestamps kept for a 10 s window at 250 Hz`);
  assert.ok(Math.abs(m.rate(199_999 * 4, 1000) - 250) < 2);
});

test('still window: quiet data is still after the hold time, motion resets it, the unknown bias does not count as motion', () => {
  const w = createStillWindow({ holdMs: 1000 });
  const s = (t, gyro = { x: 2, y: -1, z: 0.5 }, accel = { x: 0, y: 0, z: 1 }) => ({ t, gyro, accel });
  for (let t = 0; t <= 500; t += 15) w.push(s(t));
  assert.equal(w.isStill(), false, 'not enough time yet');
  for (let t = 515; t <= 1100; t += 15) w.push(s(t));
  assert.equal(w.isStill(), true, 'a constant 2 dps offset is a bias, not motion');
  w.push(s(1115, { x: 200, y: 0, z: 0 }));
  assert.equal(w.isStill(), false);
  const steady = createStillWindow({ holdMs: 1000 });
  for (let t = 0; t <= 1200; t += 15) steady.push(s(t, { x: 0, y: 0, z: 30 }));
  assert.equal(steady.isStill(), false, 'a steady 30 dps turn is constant but it is not rest');
  const m = createStillWindow({ holdMs: 500 });
  for (let t = 0; t <= 600; t += 15) m.push(s(t, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1.5 }));
  assert.equal(m.isStill(), false, '|a| = 1.5 g is not resting');
  assert.ok(m.spanMs() > 500);
});

test('scale tool: hold still for the bias, then integrate |omega - bias|; one turn is about 360 degrees', T, async () => {
  const cfg = INPUT_CONFIG.diagnostics.scale;
  const tool = createScaleTool();
  assert.equal(tool.state().phase, 'idle');
  tool.start();
  assert.equal(tool.state().phase, 'holding');
  const dt = 15;
  const bias = { x: 0.8, y: -0.4, z: 1.1 };
  for (let ms = 0; ms < cfg.holdStillMs + 100; ms += dt) tool.push({ gyro: bias, dtMs: dt });
  assert.equal(tool.state().phase, 'rotating');
  assert.ok(Math.abs(tool.state().holdProgress - 1) < 1e-9);
  // 3 s at 120 dps about Z: 360 degrees
  for (let ms = 0; ms < 3000; ms += dt) tool.push({ gyro: { x: bias.x, y: bias.y, z: bias.z + 120 }, dtMs: dt });
  tool.push({ gyro: bias, dtMs: null }); // a gap is skipped
  const r = tool.stop();
  assert.ok(Math.abs(r.integratedDeg - 360) < 3, `${r.integratedDeg}`);
  assert.equal(r.verdict, 'default');
  assert.equal(r.gyroScale, 1);
  assert.ok(Math.abs(r.biasDps.z - 1.1) < 0.01);
  assert.equal(tool.stop(), r, 'stop is idempotent');
});

test('scale tool verdicts: default (360), alt (2930 = 360 x 8.138), other, too short, implausible', () => {
  const run = (deg) => {
    const tool = createScaleTool();
    tool.start();
    for (let ms = 0; ms < 1100; ms += 10) tool.push({ gyro: { x: 0, y: 0, z: 0 }, dtMs: 10 });
    const seconds = 4;
    const rate = deg / seconds;
    for (let ms = 0; ms < seconds * 1000; ms += 10) tool.push({ gyro: { x: rate, y: 0, z: 0 }, dtMs: 10 });
    return tool.stop();
  };
  assert.equal(run(350).verdict, 'default');
  assert.equal(run(350).gyroScale, 1);
  const alt = run(2930);
  assert.equal(alt.verdict, 'alt');
  assert.equal(alt.gyroScale, 0.12288);
  const other = run(720);
  assert.equal(other.verdict, 'other');
  assert.ok(Math.abs(other.gyroScale - 0.5) < 0.01, 'any other value is used as measured (360 / integrated)');
  assert.equal(run(40).verdict, 'too_short');
  assert.equal(run(40).gyroScale, null);
  assert.equal(run(9000).verdict, 'implausible');
  assert.equal(run(9000).gyroScale, null);
});

test('scale tool driven by the simulator: one revolution measures 360 degrees, or 2930 when the true scale is 0.0075', T, async () => {
  for (const gyroScaleTrue of ['default', 'alt']) {
    const h = makeSim({ mount: 'faceSide', gyroScaleTrue, seed: 6 });
    await h.sim.connect();
    const tool = createScaleTool();
    h.sim.on('sample', (s) => tool.push(s));
    h.run(200);
    tool.start();
    h.run(1400); // hold still
    assert.equal(tool.state().phase, 'rotating');
    const t0 = h.clock.now();
    h.run(300);
    // four quarter turns about the blade axis, back to back
    for (let i = 1; i <= 4; i++) {
      h.sim.setPose({ yawDeg: 0, pitchDeg: 0, rollDeg: 90 * i }, { transitionMs: 1000 });
      h.run(1000);
    }
    h.run(300);
    const r = tool.stop();
    const expected = gyroScaleTrue === 'alt' ? 360 * 8.138 : 360;
    assert.ok(Math.abs(r.integratedDeg / expected - 1) < 0.04, `${gyroScaleTrue}: integrated ${r.integratedDeg.toFixed(0)} deg`);
    assert.equal(r.verdict, gyroScaleTrue === 'alt' ? 'alt' : 'default');
    assert.equal(r.gyroScale, gyroScaleTrue === 'alt' ? 0.12288 : 1);
    assert.ok(t0 > 0);
  }
});

test('sign test driven by the simulator: "ok" for a normal gyro and "mirrored" for a mirrored one, for every mount and both sides', T, async () => {
  for (const mount of MOUNT_NAMES) {
    for (const mirrorGyro of [false, true]) {
      for (const side of ['L', 'R']) {
        const h = makeSim({ mount, mirrorGyro, side, seed: 15 });
        await h.sim.connect();
        const test = createSignTest();
        h.sim.on('sample', (s) => test.push(s));
        h.sim.setPose('pointScreen', { teleport: true });
        h.run(2600); // hold A
        assert.equal(test.state().phase, 'turning', `${mount}: hold A must finish`);
        // a slow 70 degree turn about the sword's own right axis (pitch up), so gravity moves in the device frame
        h.sim.setPose({ yawDeg: 0, pitchDeg: 70 }, { transitionMs: 2500 });
        h.run(2700);
        h.run(2200); // hold B
        const st = test.state();
        assert.equal(st.phase, 'done', `${mount}: ${JSON.stringify(st)}`);
        const r = st.result;
        assert.ok(Math.abs(r.angleDeg - 70) < 3, `${mount}: gravity moved ${r.angleDeg.toFixed(1)} degrees`);
        assert.equal(r.verdict, mirrorGyro ? 'mirrored' : 'ok', `${mount}/${side}/mirror=${mirrorGyro}: cos ${r.cos.toFixed(2)}`);
        assert.ok(Math.abs(r.cos) > 0.9);
      }
    }
  }
});

test('sign test: a turn that is too small is reported, and a yaw-only turn (invisible to the accelerometer) is not misjudged', T, async () => {
  const small = makeSim({ mount: 'faceUp', seed: 2 });
  await small.sim.connect();
  const a = createSignTest();
  small.sim.on('sample', (s) => a.push(s));
  small.sim.setPose('pointScreen', { teleport: true });
  small.run(2600);
  small.sim.setPose({ yawDeg: 0, pitchDeg: 20 }, { transitionMs: 1500 });
  small.run(1600);
  small.run(2600);
  assert.equal(a.state().phase, 'done');
  assert.equal(a.state().result.verdict, 'too_small');

  const yaw = makeSim({ mount: 'faceUp', seed: 2 });
  await yaw.sim.connect();
  const b = createSignTest();
  yaw.sim.on('sample', (s) => b.push(s));
  yaw.sim.setPose('pointScreen', { teleport: true });
  yaw.run(2600);
  yaw.sim.setPose({ yawDeg: 60, pitchDeg: 0 }, { transitionMs: 2000 });
  yaw.run(6000);
  assert.notEqual(b.state().phase, 'done', 'turning about gravity does not change the accelerometer: the test keeps waiting');
  b.reset();
  assert.equal(b.state().phase, 'holdA');
});

test('rest check: passes for a still sword, reports the numbers, fails when moved or when |a| is off', T, async () => {
  const still = makeSim({ seed: 40 });
  await still.sim.connect();
  const rest = createRestCheck();
  still.sim.on('sample', (s) => rest.push(s));
  still.run(1500);
  assert.ok(rest.state().progress > 0.4 && rest.state().progress < 0.6);
  assert.equal(rest.state().result, null);
  still.run(2000);
  const r = rest.state().result;
  assert.ok(r, 'result after 3 s');
  assert.equal(r.pass, true);
  assert.ok(Math.abs(r.accelMagG - 1) < 0.01);
  assert.ok(Math.abs(r.gyroMeanDps.x) < 1.6 && Math.abs(r.gyroMeanDps.y) < 1.6 && Math.abs(r.gyroMeanDps.z) < 1.6);
  assert.ok(r.gyroStdDps.x > 0.05 && r.gyroStdDps.x < 0.4, 'noise sigma about 0.15 dps in the simulator');
  assert.equal(r.imuActive, true);
  assert.equal(r.moved, false);
  rest.reset();
  assert.equal(rest.state().result, null);

  const moving = makeSim({ seed: 41 });
  await moving.sim.connect();
  const rest2 = createRestCheck();
  moving.sim.on('sample', (s) => rest2.push(s));
  moving.run(3500, { onStep: (now) => moving.sim.setTarget(960 + 500 * Math.sin(now / 200), 540) });
  assert.equal(rest2.state().result.pass, false);
  assert.equal(rest2.state().result.moved, true);

  const off = createRestCheck(500);
  for (let t = 0; t <= 700; t += 15) off.push({ t, accel: { x: 0, y: 0, z: 1.2 }, gyro: { x: 0, y: 0, z: 0 }, imuActive: true });
  assert.equal(off.state().result.passAccel, false);
  assert.equal(off.state().result.pass, false);
});

test('latency probe: min / average / max / p95 of the newest sample age, bounded window', () => {
  const p = createLatencyProbe(5);
  assert.deepEqual(p.stats(), { count: 0, min: null, avg: null, max: null, p95: null });
  p.record(100, 90);
  p.record(116, 100);
  p.record(133, 120);
  p.record(150, NaN);
  p.record(150, 150);
  const s = p.stats();
  assert.equal(s.count, 4);
  assert.equal(s.min, 0);
  assert.equal(s.max, 16);
  assert.equal(s.avg, (10 + 16 + 13 + 0) / 4);
  for (let i = 0; i < 20; i++) p.record(i, i - 1);
  assert.equal(p.stats().count, 5);
  p.record(10, 12);
  assert.equal(p.stats().min, 0, 'a sample from the future is clamped to age 0');
  p.reset();
  assert.equal(p.stats().count, 0);
});

test('battery bands, hex formatting, the checklist and the owner report', () => {
  assert.equal(batteryBand(3679), 'ok');
  assert.equal(batteryBand(3400), 'low');
  assert.equal(batteryBand(3100), 'critical');
  assert.equal(batteryBand(null), 'unknown');
  assert.equal(formatHex(Uint8Array.of(0, 1, 2, 3, 4, 5, 6, 7, 8, 255)), '0001020304050607 08ff');
  assert.equal(CHECKLIST.length, 9);
  assert.deepEqual(CHECKLIST.slice(0, 7).map((c) => c.id), [1, 2, 3, 4, 5, 6, 7], 'the seven steps of protocol section 12');
  const report = buildReport({
    createdAt: '2026-09-30T10:00:00.000Z', userAgent: 'test', kind: 'joycon', side: 'L', state: 'streaming', rate1s: 66.1, scale: { verdict: 'default' },
    checklist: { 1: { status: 'pass', note: 'took 4 s' }, 2: { status: 'pass' }, 4: { status: 'fail', note: '2800 degrees' } },
  });
  assert.equal(report.checklist.length, 9);
  assert.equal(report.checklist[0].status, 'pass');
  assert.equal(report.checklist[2].status, 'untested');
  assert.deepEqual(report.uohConfirmedByOwner, ['UOH-1', 'UOH-2', 'UOH-3', 'UOH-4']);
  assert.deepEqual(report.uohFailedByOwner, ['UOH-6']);
  assert.match(report.note, /UNVERIFIED-ON-HARDWARE/);
  JSON.parse(JSON.stringify(report));
  assert.equal(buildReport({}).device.side, null);
});

test('saving the scale: {gyroScale, measuredAt} under joyconNinja.imu.v1, with an in-memory fallback', () => {
  const store = new Map();
  const storage = { setItem: (k, v) => store.set(k, v), getItem: (k) => store.get(k) ?? null };
  const res = saveScale(storage, { gyroScale: 0.12288 }, '2026-09-30T10:00:00.000Z');
  assert.deepEqual(res.value, { gyroScale: 0.12288, measuredAt: '2026-09-30T10:00:00.000Z' });
  assert.equal(res.persistent, true);
  assert.deepEqual(JSON.parse(store.get('joyconNinja.imu.v1')), res.value);
  assert.deepEqual(loadScale(storage), res.value);
  const broken = { setItem: () => { throw new Error('QuotaExceeded'); }, getItem: () => { throw new Error('denied'); } };
  const memory = {};
  const fallback = saveScale(broken, { gyroScale: 1 }, 'x', undefined, memory);
  assert.equal(fallback.ok, true);
  assert.equal(fallback.persistent, false);
  assert.match(fallback.reason, /not available/);
  assert.ok(memory['joyconNinja.imu.v1']);
  assert.equal(loadScale(broken), null);
  assert.equal(saveScale(null, { gyroScale: 1 }, 'x').persistent, false);
  assert.equal(saveScale(storage, { gyroScale: null }, 'x').ok, false);
  assert.equal(saveScale(storage, null, 'x').ok, false);
  assert.equal(loadScale({ getItem: () => 'not json' }), null);
  assert.equal(loadScale({ getItem: () => '{"gyroScale":-1}' }), null);
  assert.equal(INPUT_CONFIG.diagnostics.storageKey, 'joyconNinja.imu.v1');
});

// ---- round 1 findings F3 (accelerometer sign) and M5 / F2 (the game URL that uses what the page proved)

const restZ = (accel, ms = 3200) => {
  const rest = createRestCheck();
  for (let t = 0; t <= ms; t += 15) rest.push({ t, accel, gyro: { x: 0.2, y: -0.1, z: 0.1 }, imuActive: true });
  return rest.state().result;
};

test('rest check (F3): Z reading +1 g with the buttons up -> "plus"; -1 g -> "minus"; tilted or on its side -> "not_flat"', () => {
  const plus = restZ({ x: 0.01, y: -0.02, z: 1.0 });
  assert.equal(plus.zSign, 'plus');
  assert.equal(plus.pass, true);
  assert.ok(Math.abs(plus.accelMeanG.z - 1) < 1e-9);
  const minus = restZ({ x: 0.01, y: -0.02, z: -1.0 });
  assert.equal(minus.zSign, 'minus');
  assert.equal(minus.pass, true, 'the sign is a separate verdict: |a| = 1 g is still a pass of the rest check itself');
  assert.equal(restZ({ x: 0.9, y: 0.1, z: 0.4 }).zSign, 'not_flat');
  assert.equal(restZ({ x: 1, y: 0, z: 0 }).zSign, 'not_flat');
  assert.equal(restZ({ x: 0.3, y: 0.2, z: 0.9 }).zSign, 'not_flat', 'Z carries less than 95 % of the reading (a 22 degree tilt)');
  assert.equal(restZ({ x: 0.05, y: 0.05, z: 0.99 }).zSign, 'plus', 'a slightly tilted table is fine');
});

test('rest check (F3): with the simulator a normal virtual sensor reads "plus" and a gravity-vector sensor reads "minus"', T, async () => {
  for (const [accelSign, expected] of [[1, 'plus'], [-1, 'minus']]) {
    const h = makeSim({ seed: 50, accelSign });
    await h.sim.connect();
    const rest = createRestCheck();
    h.sim.on('sample', (s) => rest.push(s));
    h.run(3500);
    const r = rest.state().result;
    assert.ok(r, 'result');
    assert.equal(r.zSign, expected, `accelSign ${accelSign}`);
    assert.equal(r.pass, true);
    rest.reset();
    assert.equal(rest.state().result, null);
  }
});

test('saving the accelerometer sign keeps the saved gyro scale (one record, two fields) and the other way round', () => {
  const store = new Map();
  const storage = { setItem: (k, v) => store.set(k, v), getItem: (k) => store.get(k) ?? null };
  assert.equal(loadAccelSign(storage), null);
  const a = saveScale(storage, { gyroScale: 0.12288 }, 't1');
  assert.equal(a.ok, true);
  const b = saveAccelSign(storage, -1, 't2');
  assert.deepEqual(b.value, { gyroScale: 0.12288, accelSign: -1, measuredAt: 't2' });
  assert.equal(loadAccelSign(storage), -1);
  assert.equal(loadScale(storage).gyroScale, 0.12288);
  const c = saveScale(storage, { gyroScale: 1 }, 't3');
  assert.deepEqual(c.value, { gyroScale: 1, accelSign: -1, measuredAt: 't3' }, 'saving a scale later does not lose the sign');
  assert.equal(saveAccelSign(storage, 1, 't4').value.accelSign, 1);
  assert.equal(loadAccelSign(storage), 1);
  for (const bad of [0, 2, '1', null, undefined, NaN]) assert.equal(saveAccelSign(storage, bad, 'x').ok, false, String(bad));
  assert.equal(loadAccelSign({ getItem: () => 'not json' }), null);
  assert.equal(loadAccelSign({ getItem: () => '{"accelSign":5}' }), null);
  assert.equal(loadAccelSign({ getItem: () => { throw new Error('denied'); } }), null);
  // a broken storage still works from memory and reports it
  const broken = { setItem: () => { throw new Error('Quota'); }, getItem: () => { throw new Error('denied'); } };
  const memory = {};
  const m1 = saveAccelSign(broken, -1, 'x', undefined, memory);
  assert.deepEqual([m1.ok, m1.persistent], [true, false]);
  assert.equal(JSON.parse(memory['joyconNinja.imu.v1']).accelSign, -1);
  const m2 = saveScale(broken, { gyroScale: 1 }, 'y', undefined, memory);
  assert.deepEqual(JSON.parse(memory['joyconNinja.imu.v1']), { accelSign: -1, gyroScale: 1, measuredAt: 'y' }, 'the memory record is merged too');
  assert.equal(m2.persistent, false);
});

test('buildGameUrl: only what differs from the game defaults, and the URL parses back to the same flags', async () => {
  const { parseFlags } = await import('../../public/js/flags.js');
  const o = 'http://localhost:8137';
  assert.equal(buildGameUrl(o, {}), `${o}/`);
  assert.equal(INPUT_CONFIG.defaultFilter, 'lenient');
  assert.equal(buildGameUrl(o, { filter: 'lenient', mask: INPUT_CONFIG.featureMask, side: 'any', accelSign: 1 }), `${o}/`, 'the default filter needs no flag');
  assert.equal(buildGameUrl(o, { filter: 'strict', mask: 0xb7 }), `${o}/?filter=strict`, 'strict is no longer the default: it is written out');
  assert.equal(buildGameUrl(o, { filter: 'all', mask: 0xff, side: 'L', accelSign: -1 }), `${o}/?filter=all&mask=0xFF&side=L&accelsign=-1`);
  assert.equal(buildGameUrl(o, { mask: 0x37 }), `${o}/?mask=0x37`);
  assert.equal(buildGameUrl('', { mask: 0x0c }), '/?mask=0x0C');
  for (const opts of [{ filter: 'strict', mask: 0x37, side: 'R', accelSign: -1 }, { filter: 'all', mask: 0xff }]) {
    const url = new URL(buildGameUrl(o, opts));
    const f = parseFlags(url.search);
    assert.deepEqual(f.warnings, []);
    assert.equal(f.filter, opts.filter);
    assert.equal(f.mask, opts.mask);
    assert.equal(f.side, opts.side ?? null);
    assert.equal(f.accelsign, opts.accelSign ?? null);
  }
});

test('the checklist step 3 asks for the buttons-up pose and the Z reading (F3), and step 3 settles the new item UOH-20', () => {
  const step3 = CHECKLIST.find((c) => c.id === 3);
  assert.match(step3.title, /BUTTONS UP/);
  assert.match(step3.title, /raw accel Z about \+4096/);
  assert.ok(step3.uoh.includes('UOH-20'));
  const report = buildReport({ checklist: { 3: { status: 'pass' } } });
  assert.ok(report.uohConfirmedByOwner.includes('UOH-20'));
});

// ---- round 3 finding R3-n1: the page must not reject what the game accepts; and a way to forget saved values (m1, n10)

function stillSamples(g, n = 400, extra = {}) {
  const out = [];
  for (let i = 0; i < n; i += 1) out.push({ t: i * 15, accel: { x: 0, y: 0, z: g }, gyro: { x: 0.2, y: -0.1, z: 0.1 }, imuActive: true, ...extra });
  return out;
}

test('R3-n1: the rest check separates "ok" (1.00 +- 0.03 g) from "ok for the game" (0.85 to 1.15 g) and "ko"', () => {
  const verdict = (g) => {
    const r = createRestCheck(3000);
    for (const s of stillSamples(g)) r.push(s);
    return r.state().result;
  };
  assert.equal(verdict(1.0).verdict, 'ok');
  assert.equal(verdict(1.025).verdict, 'ok');
  for (const g of [1.06, 1.09, 1.13, 0.92, 0.88]) {
    const v = verdict(g);
    assert.equal(v.verdict, 'game_ok', `${g} g`);
    assert.equal(v.pass, false, 'the statement about the sensor (1.00 +- 0.03 g) stays strict');
    assert.equal(v.accelGameOk, true);
  }
  for (const g of [0.8, 1.2, 1.5]) assert.equal(verdict(g).verdict, 'ko', `${g} g`);
  assert.deepEqual([...GAME_ACCEL_RANGE], [0.85, 1.15], 'the same range as MOTION_CONFIG.calibration.accelG0Range');
  // a moved Joy-Con is ko whatever |a| says
  const moved = createRestCheck(3000);
  for (const s of stillSamples(1.09)) moved.push({ ...s, gyro: { x: s.t % 60 < 30 ? 40 : -40, y: 0, z: 0 } });
  assert.equal(moved.state().result.verdict, 'ko');
});

test('R3-n1: the sign test starts at a resting |a| of 1.09 g (it used to wait for ever above about 1.08 g) and still refuses a sensor outside the game range', () => {
  for (const g of [1.0, 1.04, 1.06, 1.09, 1.13, 0.9]) {
    const w = createStillWindow({ holdMs: 1500 });
    for (const s of stillSamples(g, 200)) w.push(s);
    assert.equal(w.isStill(), true, `${g} g`);
  }
  for (const g of [0.8, 1.2]) {
    const w = createStillWindow({ holdMs: 1500 });
    for (const s of stillSamples(g, 200)) w.push(s);
    assert.equal(w.isStill(), false, `${g} g is outside what the game accepts`);
  }
  // |a| that wanders inside one window (a knock) is still not stillness
  const w = createStillWindow({ holdMs: 1500 });
  stillSamples(1.0, 200).forEach((s, i) => w.push({ ...s, accel: { x: 0, y: 0, z: i % 2 ? 1.0 : 1.2 } }));
  assert.equal(w.isStill(), false);
});

test('m1 / n10: clearSavedRecord forgets the gyro scale and the accelerometer sign; it is safe without localStorage', () => {
  const store = new Map();
  const storage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) };
  const memory = {};
  saveScale(storage, { gyroScale: 0.12288 }, '2026-09-30T00:00:00.000Z', undefined, memory);
  saveAccelSign(storage, -1, '2026-09-30T00:00:00.000Z', undefined, memory);
  assert.equal(loadScale(storage).gyroScale, 0.12288);
  assert.equal(loadAccelSign(storage), -1);
  const res = clearSavedRecord(storage, undefined, memory);
  assert.deepEqual([res.ok, res.persistent], [true, true]);
  assert.equal(loadScale(storage), null);
  assert.equal(loadAccelSign(storage), null);
  assert.deepEqual(memory, {});
  const broken = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); }, removeItem() { throw new Error('blocked'); } };
  const r2 = clearSavedRecord(broken, undefined, { x: 1 });
  assert.deepEqual([r2.ok, r2.persistent], [true, false]);
  assert.doesNotThrow(() => clearSavedRecord(null));
});

// ---- the native Bluetooth bridge mode (docs/native-bridge.md 10, item 6)

test('parseMode: the native bridge is the default, ?input=joycon is Web Bluetooth, ?input=sim the simulator, anything else the default', () => {
  assert.equal(parseMode(''), 'native');
  assert.equal(parseMode(undefined), 'native');
  assert.equal(parseMode('?input=native'), 'native');
  assert.equal(parseMode('?input=joycon'), 'joycon');
  assert.equal(parseMode('?input=sim&simhz=250'), 'sim');
  assert.equal(parseMode('?input=bridge'), 'native', 'the old reserved name means nothing');
  assert.equal(parseMode('?input=gamepad'), 'native');
});

test('the native checklist has three steps (ids 10 to 12) for the new items UOH-21 to UOH-28; the nine shared steps are untouched; the report adds them in native mode only', () => {
  assert.deepEqual(NATIVE_CHECKLIST.map((c) => c.id), [10, 11, 12]);
  assert.equal(CHECKLIST.length, 9);
  assert.deepEqual(NATIVE_CHECKLIST.flatMap((c) => c.uoh), ['UOH-21', 'UOH-22', 'UOH-26', 'UOH-27', 'UOH-5', 'UOH-25', 'UOH-23', 'UOH-24', 'UOH-28']);
  const native = buildReport({ kind: 'native', checklist: { 10: { status: 'pass', note: 'prompt appeared' }, 11: { status: 'fail', note: 'dropped at 14 s' } }, native: { phase: 'streaming', adverts: [] } });
  assert.equal(native.checklist.length, 12);
  assert.deepEqual(native.uohConfirmedByOwner, ['UOH-21', 'UOH-22', 'UOH-26', 'UOH-27']);
  assert.deepEqual(native.uohFailedByOwner, ['UOH-25', 'UOH-5']);
  assert.deepEqual(native.native, { phase: 'streaming', adverts: [] });
  for (const kind of ['joycon', 'sim', undefined]) assert.equal(buildReport({ kind }).checklist.length, 9, String(kind));
  assert.equal(buildReport({}).native, null);
  assert.equal(buildReport({}).tools.keepAlive, null);
  JSON.parse(JSON.stringify(native));
});

test('formatAdverts: side, signal and whether the controller was in pairing mode; nothing seen says so', () => {
  assert.equal(formatAdverts([]), 'none');
  assert.equal(formatAdverts(undefined), 'none');
  assert.equal(formatAdverts([{ side: 'R', rssi: -40, pairing: true }]), 'right -40 dBm in SYNC mode');
  const two = formatAdverts([{ side: 'R', rssi: -31, pairing: false }, { side: 'L', rssi: null, pairing: true }]);
  assert.match(two, /^right -31 dBm not in SYNC mode \(looking for its saved address\)  \|  left unknown signal in SYNC mode$/);
});

test('buildGameUrl: a native page adds ?input=native and leaves out the filter that only Web Bluetooth has; the URL parses back', () => {
  const o = 'http://localhost:8137';
  assert.equal(buildGameUrl(o, { input: 'native' }), `${o}/?input=native`);
  assert.equal(buildGameUrl(o, { input: 'native', filter: 'all', mask: 0xff, side: 'L', accelSign: -1 }), `${o}/?input=native&mask=0xFF&side=L&accelsign=-1`);
  assert.equal(buildGameUrl(o, { input: 'joycon', filter: 'all' }), `${o}/?filter=all`, 'Web Bluetooth keeps its own flags');
  assert.equal(buildGameUrl(o, { input: undefined }), `${o}/`);
  const u = new URL(buildGameUrl(o, { input: 'native', side: 'R' }));
  assert.equal(u.searchParams.get('input'), 'native');
});

test('keep-alive experiment (UOH-5): armed until streaming, 60 s of streaming is "survived", a drop is timed from the moment of streaming, errors before streaming are "never connected"', () => {
  const x = createKeepAliveExperiment();
  assert.equal(x.state(0).phase, 'idle');
  x.start();
  assert.equal(x.state(0).phase, 'armed');
  x.onState('requesting', 1000);
  x.onState('connecting', 2000);
  assert.equal(x.state(2000).phase, 'armed', 'the clock starts when the stream does, not at the click');
  x.onState('streaming', 10_000);
  assert.deepEqual([x.state(12_500).phase, x.state(12_500).elapsedS], ['running', 2.5]);
  x.tick(40_000);
  assert.equal(x.state(40_000).phase, 'running');
  x.tick(70_000);
  assert.deepEqual(x.state(70_000), { phase: 'done', elapsedS: null, result: { verdict: 'survived', dropS: null, durationS: 60 } });
  // a drop
  const d = createKeepAliveExperiment();
  d.start();
  d.onState('streaming', 5000);
  d.onState('lost', 19_400);
  assert.deepEqual(d.state(20_000).result, { verdict: 'dropped', dropS: 14.4, durationS: 60 });
  d.tick(100_000);
  assert.equal(d.state(100_000).result.verdict, 'dropped', 'a finished experiment does not change its mind');
  // never connected
  const n = createKeepAliveExperiment();
  n.start();
  n.onState('requesting', 100);
  n.onState('error', 9000);
  assert.equal(n.state(9000).result.verdict, 'never_connected');
  // stop, and a restart
  const s = createKeepAliveExperiment();
  s.start();
  s.onState('streaming', 0);
  s.stop();
  assert.equal(s.state(1000).phase, 'idle');
  s.onState('lost', 2000);
  assert.equal(s.state(2000).phase, 'idle', 'nothing is armed after a stop');
  s.start();
  assert.equal(s.state(0).result, null);
  // a shorter experiment for tests
  const short = createKeepAliveExperiment({ durationMs: 1000 });
  short.start();
  short.onState('streaming', 0);
  short.tick(1000);
  assert.equal(short.state(1000).result.durationS, 1);
});
