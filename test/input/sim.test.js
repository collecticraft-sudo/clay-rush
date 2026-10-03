// Simulator provider tests (docs/architecture.md 5.8, A-12, A-22). Everything goes through the REAL parser and the real
// report stream. The simulator models docs/joycon2-protocol.md, not the Joy-Con: rates, noise and mounts are assumptions
// (UNVERIFIED-ON-HARDWARE). Timers are virtual, the clock is manual, nothing sleeps.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeSim, MOUNT_NAMES, DEG, vec, dot, norm, cross, sub, angleDeg, accelOf, gyroOf } from '../../test-support/input/sim-harness.js';
import { createInputProvider, SIM_MOUNTS } from '../../public/js/input/index.js';
import { INPUT_CONFIG } from '../../public/js/input/input-config.js';
import { createManualClock } from '../../public/js/shared/clock.js';
import { createFakeTimers } from '../../test-support/input/fake-timers.js';
import { assertValid } from '../../public/js/shared/validate.js';
import { FakeTarget, pointerEvent } from '../../test-support/input/fake-dom.js';

const T = { timeout: 60000 };
const QUIET = { noise: false, jitter: false, bursts: false, leverM: 0 };
const PX = INPUT_CONFIG.sim.pxPerDeg;

test('SIM_MOUNTS is the normative table: six presets, all right-handed (right x forward = up)', () => {
  assert.deepEqual(MOUNT_NAMES.sort(), ['faceSide', 'faceUp', 'sideRail', 'tilted', 'tipFlipped', 'upsideDown']);
  assert.deepEqual(SIM_MOUNTS.faceSide, { right: { x: 0, y: 0, z: -1 }, forward: { x: 0, y: 1, z: 0 }, up: { x: 1, y: 0, z: 0 } });
  assert.deepEqual(SIM_MOUNTS.tilted.forward, { x: 0, y: 0.866025, z: 0.5 });
  assert.ok(Object.isFrozen(SIM_MOUNTS) && Object.isFrozen(SIM_MOUNTS.faceUp) && Object.isFrozen(SIM_MOUNTS.faceUp.right));
  for (const name of MOUNT_NAMES) {
    const m = SIM_MOUNTS[name];
    const up = cross(vec(m.right), vec(m.forward));
    assert.ok(norm(sub(up, vec(m.up))) < 1e-5, `${name}: right x forward = up`);
  }
});

test('capabilities and identity of the simulator provider', T, () => {
  const { sim } = makeSim();
  assert.deepEqual(sim.capabilities, { imu: true, aim: false, buttons: false, needsUserGesture: false, needsCalibration: false, hasBattery: false, canVibrate: false });
  assert.equal(sim.kind, 'sim');
  assert.equal(sim.status.state, 'idle');
  assert.equal(sim.status.deviceName, 'Simulator');
  assert.deepEqual(sim.getActionLabels(), { confirm: 'click', back: 'right click', pause: 'middle click', recenter: 'Space', fire: 'Click' });
  assert.equal(typeof sim.fire, 'function', 'the bot hook');
  sim.setTriggerButton('R'); // no-op
  assert.equal(sim.getActionLabels().fire, 'Click');
  assert.equal(typeof sim.tick, 'function');
});

test('connect() is synchronous idle -> streaming; disconnect() -> idle; both idempotent', T, async () => {
  const { sim, statuses } = makeSim();
  const p = sim.connect();
  assert.equal(sim.status.state, 'streaming', 'streaming before the promise settles');
  await p;
  await sim.connect();
  await sim.disconnect();
  await sim.disconnect();
  assert.equal(sim.status.state, 'idle');
  assert.deepEqual(statuses.map((s) => s.state), ['streaming', 'idle']);
  assert.equal(sim.status.battery.level, 'unknown');
  assert.equal(sim.status.featureMask, null);
});

test('at rest the accelerometer reads +1 g along the mount "up" axis, for all six mounts, both sides', T, async () => {
  for (const mount of MOUNT_NAMES) {
    for (const side of ['L', 'R']) {
      for (const quiet of [true, false]) {
        const h = makeSim({ mount, side, ...(quiet ? QUIET : {}) });
        await h.sim.connect();
        h.run(600);
        assert.ok(h.samples.length > 30);
        const up = vec(SIM_MOUNTS[mount].up);
        const a = h.mean(h.samples, accelOf);
        assert.ok(norm(sub(a, up)) < (quiet ? 2e-3 : 0.01), `${mount}/${side}/${quiet ? 'quiet' : 'noisy'}: ${a.map((x) => x.toFixed(4))} vs ${up}`);
        assert.equal(h.samples[0].side, side);
      }
    }
  }
});

test('nominalCalibration validates for every mount and gyro option and describes the virtual mount exactly', T, () => {
  for (const mount of MOUNT_NAMES) {
    for (const mirrorGyro of [false, true]) {
      for (const gyroScaleTrue of ['default', 'alt']) {
        const { sim } = makeSim({ mount, mirrorGyro, gyroScaleTrue, side: 'L' });
        const c = sim.nominalCalibration;
        assertValid('Calibration', c);
        assert.equal(c.side, 'L');
        assert.equal(c.gyroSign, mirrorGyro ? -1 : 1);
        assert.equal(c.gyroScale, gyroScaleTrue === 'alt' ? 0.12288 : 1);
        assert.equal(c.gyroScaleSource, 'stored');
        for (const k of ['right', 'forward', 'up']) assert.ok(norm(sub(vec(c.frame[k]), vec(SIM_MOUNTS[mount][k]))) < 1e-5, `${mount} ${k}`);
        assert.deepEqual(c.gyroBiasDps, sim.getTruth().gyroBiasDps);
        assert.equal(sim.getTruth().gyroSign, c.gyroSign);
        assert.equal(sim.getTruth().side, 'L');
        assert.deepEqual(sim.getTruth().frame, c.frame);
      }
    }
  }
});

test('physics: d(accel)/dt = -omega x accel for every mount, with and without a mirrored gyro (mount and sign handling)', T, async () => {
  for (const mount of MOUNT_NAMES) {
    for (const mirrorGyro of [false, true]) {
      const h = makeSim({ mount, mirrorGyro, ...QUIET });
      await h.sim.connect();
      const sign = mirrorGyro ? -1 : 1;
      h.run(4000, {
        stepMs: 4,
        onStep: (now) => h.sim.setTarget(960 + 450 * Math.sin(2 * Math.PI * 0.5 * (now / 1000)), 540 + 380 * Math.sin(2 * Math.PI * 0.8 * (now / 1000) + 0.7)),
      });
      let num = 0;
      let den = 0;
      for (let i = 20; i < h.samples.length; i++) {
        const a = h.samples[i - 1];
        const b = h.samples[i];
        if (b.dtMs === null) continue;
        const dt = b.dtMs / 1000;
        const am = accelOf(a).map((x, k) => (x + accelOf(b)[k]) / 2);
        const w = gyroOf(a).map((x, k) => ((x + gyroOf(b)[k]) / 2) * DEG * sign); // rad/s, true right-handed rate
        const predicted = cross(w, am).map((x) => -x * dt);
        const actual = sub(accelOf(b), accelOf(a));
        num += norm(sub(actual, predicted)) ** 2;
        den += norm(actual) ** 2;
      }
      assert.ok(den > 0.01, `${mount}: the accelerometer must actually move`);
      assert.ok(Math.sqrt(num / den) < 0.06, `${mount} mirror=${mirrorGyro}: relative error ${Math.sqrt(num / den).toFixed(3)}`);
    }
  }
});

test('the mirrored gyro flips the sign of the reported rate and nothing else', T, async () => {
  const run = async (mirrorGyro) => {
    const h = makeSim({ mirrorGyro, ...QUIET, seed: 4 });
    await h.sim.connect();
    h.run(1200, { onStep: (now) => h.sim.setTarget(960 + 500 * Math.sin(now / 200), 540) });
    return h;
  };
  const a = await run(false);
  const b = await run(true);
  assert.equal(a.samples.length, b.samples.length);
  for (let i = 0; i < a.samples.length; i++) {
    assert.deepEqual(a.samples[i].accel, b.samples[i].accel);
    for (const k of ['x', 'y', 'z']) assert.ok(Math.abs(a.samples[i].gyro[k] + b.samples[i].gyro[k]) < 1e-9);
  }
});

test('steady mouse speed v px/s gives an angular rate of v / 27.4 deg/s within 5 % (A-22), horizontally and vertically', T, async () => {
  for (const v of [300, 1000, 3000]) {
    for (const axis of ['x', 'y']) {
      const h = makeSim({ ...QUIET });
      await h.sim.connect();
      const start = axis === 'x' ? [160, 540] : [960, 100];
      h.sim.setTarget(start[0], start[1], { teleport: true });
      h.run(300);
      const t0 = h.clock.now();
      h.run(500, {
        onStep: (now) => {
          const d = (v * (now - t0)) / 1000;
          h.sim.setTarget(start[0] + (axis === 'x' ? d : 0), start[1] + (axis === 'y' ? d : 0));
        },
      });
      const mid = h.between(t0 + 150, t0 + 450);
      assert.ok(mid.length > 10);
      const rate = mid.reduce((acc, s) => acc + norm(gyroOf(s)), 0) / mid.length;
      const expected = v / PX;
      assert.ok(Math.abs(rate - expected) / expected < 0.05, `v=${v} axis=${axis}: ${rate.toFixed(2)} vs ${expected.toFixed(2)} deg/s`);
    }
  }
});

test('gyroScaleTrue "alt": the parser default scale makes the signal 8.138 times too large; the calibration scale undoes it', T, async () => {
  const h = makeSim({ ...QUIET, gyroScaleTrue: 'alt' });
  await h.sim.connect();
  h.sim.setTarget(160, 540, { teleport: true });
  h.run(300);
  const t0 = h.clock.now();
  h.run(500, { onStep: (now) => h.sim.setTarget(160 + (600 * (now - t0)) / 1000, 540) });
  const mid = h.between(t0 + 150, t0 + 450);
  const rate = mid.reduce((acc, s) => acc + norm(gyroOf(s)), 0) / mid.length;
  const expected = 600 / PX;
  assert.ok(Math.abs(rate / (expected * 8.138) - 1) < 0.05, `parsed rate ${rate.toFixed(1)} vs ${(expected * 8.138).toFixed(1)}`);
  assert.ok(Math.abs((rate * h.sim.nominalCalibration.gyroScale) / expected - 1) < 0.05);
  assert.equal(h.sim.getTruth().gyroScaleTrue, 'alt');
  assert.equal(h.sim.getTruth().gyroScaleTrueDpsPerLsb, 0.0075);
});

test('gyro bias: constant per run, uniform within +-1.5 dps, equal to the truth, and the noise is white with sigma 0.15 dps', T, async () => {
  const h = makeSim({ seed: 21 });
  await h.sim.connect();
  h.run(4000);
  const g = h.mean(h.samples, gyroOf);
  const truth = h.sim.getTruth();
  const bias = vec(truth.gyroBiasDps);
  for (let k = 0; k < 3; k++) {
    assert.ok(Math.abs(bias[k]) <= 1.5);
    assert.ok(Math.abs(g[k] - bias[k]) < 0.06, `axis ${k}: mean ${g[k].toFixed(3)} vs bias ${bias[k].toFixed(3)}`);
  }
  const sd = Math.sqrt(h.samples.reduce((acc, s) => acc + (s.gyro.x - g[0]) ** 2, 0) / h.samples.length);
  assert.ok(sd > 0.1 && sd < 0.25, `gyro noise sigma ${sd.toFixed(3)} dps (raw LSB is 0.061)`);
  const alt = makeSim({ seed: 21, gyroScaleTrue: 'alt' });
  const ratio = vec(alt.sim.getTruth().gyroBiasDps)[0] / vec(alt.sim.getTruth().gyroBiasTrueDps)[0];
  assert.ok(Math.abs(ratio - 8.138) < 0.01, 'the truth is reported in ImuSample units');
});

test('the mouse maps to yaw and pitch at 27.4 px/deg (pointer events through the letterboxed canvas)', T, async () => {
  const h = makeSim({ ...QUIET });
  await h.sim.connect();
  h.target.rect = { left: 100, top: 50, width: 960, height: 540 }; // 0.5 scale, no letterbox
  const at = (x, y) => h.target.pointer('pointermove', { clientX: 100 + x / 2, clientY: 50 + y / 2, timeStamp: h.clock.now() });
  at(960, 540);
  h.run(100);
  at(1560, 540);
  h.run(300);
  let aim = h.sim.getTruth().aim;
  assert.ok(Math.abs(aim.yawDeg - 600 / PX) < 0.05 && Math.abs(aim.pitchDeg) < 0.05, JSON.stringify(aim));
  at(960, 100);
  h.run(300);
  aim = h.sim.getTruth().aim;
  assert.ok(Math.abs(aim.pitchDeg - 440 / PX) < 0.05 && Math.abs(aim.yawDeg) < 0.05, JSON.stringify(aim));
  // outside the letterbox the point is clamped to the playfield
  h.target.rect = { left: 0, top: 0, width: 2000, height: 1000 };
  h.target.pointer('pointermove', { clientX: 5000, clientY: -500, timeStamp: h.clock.now() });
  h.run(300);
  aim = h.sim.getTruth().aim;
  assert.ok(Math.abs(aim.yawDeg - 960 / PX) < 0.1 && Math.abs(aim.pitchDeg - 540 / PX) < 0.1, JSON.stringify(aim));
});

test('coalesced pointer events all move the target in order; the last one wins', T, async () => {
  const h = makeSim({ ...QUIET });
  await h.sim.connect();
  h.target.pointer('pointermove', { clientX: 960, clientY: 540 }, [{ clientX: 960, clientY: 540 }, { clientX: 1000, clientY: 540 }, { clientX: 1200, clientY: 540 }]);
  h.run(300);
  assert.ok(Math.abs(h.sim.getTruth().aim.yawDeg - 240 / PX) < 0.05);
});

test('setPose: tipUp puts +1 g on the blade axis, pointScreen on the up axis, for every mount; clearPose gives the mouse back', T, async () => {
  for (const mount of MOUNT_NAMES) {
    const h = makeSim({ mount, ...QUIET });
    await h.sim.connect();
    const m = SIM_MOUNTS[mount];
    h.sim.setPose('tipUp', { teleport: true });
    h.run(200);
    assert.ok(norm(sub(accelOf(h.samples.at(-1)), vec(m.forward))) < 3e-3, `${mount} tipUp`);
    assert.ok(norm(gyroOf(h.samples.at(-1))) < 0.2);
    h.sim.setPose('pointScreen', { transitionMs: 600 });
    h.run(1200);
    assert.ok(norm(sub(accelOf(h.samples.at(-1)), vec(m.up))) < 3e-3, `${mount} pointScreen`);
    h.sim.setPose('flat', { teleport: true });
    h.run(100);
    assert.ok(norm(sub(accelOf(h.samples.at(-1)), vec(m.up))) < 3e-3, `${mount} flat`);
    h.sim.setPose({ yawDeg: 30, pitchDeg: 10 }, { teleport: true });
    h.run(100);
    const aim = h.sim.getTruth().aim;
    assert.ok(Math.abs(aim.yawDeg - 30) < 0.1 && Math.abs(aim.pitchDeg - 10) < 0.1);
    // mouse events are remembered but do not move a posed sword
    h.target.pointer('pointermove', { clientX: 0, clientY: 0, timeStamp: h.clock.now() });
    h.run(200);
    assert.ok(Math.abs(h.sim.getTruth().aim.yawDeg - 30) < 0.1);
    h.sim.clearPose({ teleport: true });
    h.run(100);
    assert.ok(Math.abs(h.sim.getTruth().aim.yawDeg + 960 / PX) < 0.1, 'back to the mouse target (top left corner)');
  }
  assert.throws(() => makeSim({}).sim.setPose('sideways'), /unknown simulator pose/);
});

test('teleport re-anchors without angular velocity: the gyro sees nothing (docs/architecture.md 5.8)', T, async () => {
  const h = makeSim({ ...QUIET });
  await h.sim.connect();
  h.run(200);
  h.sim.setTarget(1500, 250, { teleport: true });
  const t0 = h.clock.now();
  h.run(300);
  const after = h.between(t0 + 10, t0 + 300);
  for (const s of after) assert.ok(norm(gyroOf(s)) < 0.5, `gyro ${norm(gyroOf(s))} right after a teleport`);
  const aim = h.sim.getTruth().aim;
  assert.ok(Math.abs(aim.yawDeg - (1500 - 960) / PX) < 0.1 && Math.abs(aim.pitchDeg - (540 - 250) / PX) < 0.1);
});

test('glideMs is the physically consistent alternative: smooth motion with a bounded rate', T, async () => {
  const h = makeSim({ ...QUIET });
  await h.sim.connect();
  h.run(200);
  h.sim.setTarget(1560, 540, { glideMs: 1200 });
  const t0 = h.clock.now();
  h.run(1600);
  const moving = h.between(t0, t0 + 1400);
  const peak = Math.max(...moving.map((s) => norm(gyroOf(s))));
  const mean = 600 / PX / 1.2;
  assert.ok(peak > mean && peak < mean * 1.8, `peak ${peak.toFixed(1)} vs mean ${mean.toFixed(1)} deg/s`);
  assert.ok(Math.abs(h.sim.getTruth().aim.yawDeg - 600 / PX) < 0.05);
});

test('pointer leave / enter / blur / 200 ms silence: tracking flag and teleport instead of a phantom swing', T, async () => {
  const h = makeSim({ ...QUIET });
  await h.sim.connect();
  assert.equal(h.sim.status.trackingOk, true);
  h.target.pointer('pointermove', { clientX: 960, clientY: 540, timeStamp: 0 });
  h.run(100);
  h.target.dispatchEvent(pointerEvent('pointerleave'));
  assert.equal(h.sim.status.trackingOk, false);
  h.run(100);
  let t0 = h.clock.now();
  h.target.pointer('pointermove', { clientX: 1700, clientY: 200, timeStamp: t0 });
  assert.equal(h.sim.status.trackingOk, true);
  h.run(300);
  for (const s of h.between(t0 + 8, t0 + 300)) assert.ok(norm(gyroOf(s)) < 0.5, 're-entry is a teleport, not a fast swing');
  // 200 ms of silence, then a far move: teleport again
  h.run(400);
  t0 = h.clock.now();
  h.target.pointer('pointermove', { clientX: 200, clientY: 900, timeStamp: t0 });
  h.run(300);
  for (const s of h.between(t0 + 8, t0 + 300)) assert.ok(norm(gyroOf(s)) < 0.5, 'a move after 200 ms of silence is a teleport');
  // continuous motion is NOT a teleport
  t0 = h.clock.now();
  for (let i = 0; i < 20; i++) {
    h.target.pointer('pointermove', { clientX: 200 + i * 30, clientY: 900, timeStamp: h.clock.now() });
    h.run(16);
  }
  assert.ok(Math.max(...h.between(t0, t0 + 320).map((s) => norm(gyroOf(s)))) > 15);
});

test('a click before any movement places the virtual sword under a pointer that is already over the canvas', T, async () => {
  const h = makeSim({ ...QUIET });
  await h.sim.connect();
  h.run(100);
  const t0 = h.clock.now();
  h.target.pointer('pointerdown', { button: 0, clientX: 1500, clientY: 300, timeStamp: t0 });
  h.run(300);
  const aim = h.sim.getTruth().aim;
  assert.ok(Math.abs(aim.yawDeg - (1500 - 960) / PX) < 0.1 && Math.abs(aim.pitchDeg - (540 - 300) / PX) < 0.1, JSON.stringify(aim));
  for (const s of h.between(t0 + 8, t0 + 300)) assert.ok(norm(gyroOf(s)) < 0.5, 'the first pointer position is a teleport');
  // later clicks do not move it
  h.target.pointer('pointerdown', { button: 0, clientX: 100, clientY: 100, timeStamp: h.clock.now() });
  h.run(300);
  assert.ok(Math.abs(h.sim.getTruth().aim.yawDeg - (1500 - 960) / PX) < 0.1);
});

test('window blur makes the next pointer move a teleport (injected window target)', T, async () => {
  const win = new EventTarget();
  const h = makeSim({ ...QUIET }, { windowTarget: win });
  await h.sim.connect();
  h.target.pointer('pointermove', { clientX: 960, clientY: 540, timeStamp: 0 });
  h.run(50);
  win.dispatchEvent(new Event('blur'));
  const t0 = h.clock.now();
  h.target.pointer('pointermove', { clientX: 1800, clientY: 100, timeStamp: t0 });
  h.run(200);
  for (const s of h.between(t0 + 8, t0 + 200)) assert.ok(norm(gyroOf(s)) < 0.5);
});

test('mouse actions: left press = fire, right click = back, middle click = pause; a double click (two shots) does NOT recentre (I-01)', T, async () => {
  const h = makeSim();
  await h.sim.connect();
  const actions = [];
  h.sim.on('action', (a) => actions.push(a));
  h.target.pointer('pointerdown', { button: 0 });
  h.target.pointer('pointerdown', { button: 2 });
  const middle = h.target.pointer('pointerdown', { button: 1 });
  h.target.pointer('pointerdown', { button: 0 });
  h.target.dispatchEvent(pointerEvent('dblclick'));
  const ctx = pointerEvent('contextmenu');
  h.target.dispatchEvent(ctx);
  assert.deepEqual(actions.map((a) => a.action), ['fire', 'back', 'pause', 'fire']);
  assert.deepEqual(actions.map((a) => a.label), ['Click', 'right click', 'middle click', 'Click']);
  assert.ok(actions.every((a) => a.source === 'sim'));
  for (const a of actions) assertValid('ActionEvent', a);
  assert.equal(middle.defaultPrevented, true);
  assert.equal(ctx.defaultPrevented, true, 'the context menu is suppressed over the canvas');
});

test('timing: rate, jitter, bursts and delivery order at 33, 66 and 250 Hz (A-12; UNVERIFIED-ON-HARDWARE, UOH-4)', T, async () => {
  for (const hz of [33, 66, 250]) {
    const h = makeSim({ hz, seed: 5 });
    await h.sim.connect();
    h.run(10_000);
    const n = h.samples.length;
    assert.ok(Math.abs(n / 10 - hz) / hz < 0.03, `${hz} Hz: ${n} samples in 10 s`);
    const period = 1000 / hz;
    const amp = Math.min(3, period * 0.35);
    const dts = h.samples.map((s) => s.dtMs).filter((d) => d !== null);
    assert.equal(dts.length, n - 1, 'only the first sample has no dt');
    assert.ok(Math.min(...dts) >= period - 2 * amp - 0.01, `min dt ${Math.min(...dts)}`);
    assert.ok(Math.max(...dts) <= period + 2 * amp + 0.01, `max dt ${Math.max(...dts)}`);
    assert.ok(Math.abs(dts.reduce((a, b) => a + b, 0) / dts.length - period) < period * 0.02);
    for (let i = 1; i < n; i++) {
      assert.ok(h.samples[i].t >= h.samples[i - 1].t);
      assert.ok(h.samples[i].t <= h.samples[i].arrivedAt + 1e-9);
      assert.ok(h.samples[i].arrivedAt >= h.samples[i - 1].arrivedAt);
      assert.equal(h.samples[i].seq, i);
    }
    assert.ok(h.samples.every((s) => s.dtSource === 'device'));
    const bursts = h.samples.filter((s, i) => i > 0 && s.arrivedAt === h.samples[i - 1].arrivedAt).length;
    assert.ok(bursts >= 1, `${hz} Hz: at least one burst pair in 10 s (3 % probability per report)`);
    assert.ok(bursts < n * 0.08);
    const st = h.sim.getDiagnostics().stream;
    assert.ok(st.dtRatio > 0.97 && st.dtRatio < 1.03, `device timestamps agree with arrivals: ${st.dtRatio}`);
    assert.equal(st.gaps, 0);
    assert.ok(Math.abs(h.sim.status.packetRateHz - hz) / hz < 0.06, `status.packetRateHz ${h.sim.status.packetRateHz}`);
  }
});

test('bursts: two packets share the arrival time and their timestamps are exactly one period apart', T, async () => {
  const h = makeSim({ hz: 66, seed: 9, jitter: false, burstProb: 0.4, ...QUIET, bursts: true });
  await h.sim.connect();
  h.run(10_000);
  const period = 1000 / 66;
  const pairs = [];
  for (let i = 1; i < h.samples.length; i++) if (h.samples[i].arrivedAt === h.samples[i - 1].arrivedAt) pairs.push(i);
  assert.ok(pairs.length > 100, `${pairs.length} burst pairs with burstProb 0.4`);
  for (const i of pairs) {
    assert.ok(Math.abs(h.samples[i].dtMs - period) < 0.002, `burst partner dt ${h.samples[i].dtMs}`);
    assert.ok(h.samples[i].t >= h.samples[i - 1].t);
  }
  // a held packet never chains: no three packets share one arrival time
  for (let i = 2; i < h.samples.length; i++) assert.ok(!(h.samples[i].arrivedAt === h.samples[i - 1].arrivedAt && h.samples[i - 1].arrivedAt === h.samples[i - 2].arrivedAt));
  const off = makeSim({ hz: 66, seed: 9, jitter: false, burstProb: 0, ...QUIET, bursts: true });
  await off.sim.connect();
  off.run(5000);
  assert.equal(new Set(off.samples.map((s) => s.arrivedAt)).size, off.samples.length);
});

test('bursts and jitter can be switched off: then the stream is perfectly regular', T, async () => {
  const h = makeSim({ hz: 66, seed: 2, noise: false, jitter: false, bursts: false });
  await h.sim.connect();
  h.run(5000);
  const dts = h.samples.slice(1).map((s) => s.dtMs);
  for (const d of dts) assert.ok(Math.abs(d - 1000 / 66) < 0.002, `dt ${d}`);
  assert.equal(new Set(h.samples.map((s) => s.arrivedAt)).size, h.samples.length);
});

test('IMU timestamps wrap at 2^32 microseconds without a gap; the counter is a millisecond clock', T, async () => {
  const h = makeSim({ startTimestampUs: 4_294_930_000, ...QUIET, jitter: true, bursts: true, seed: 3 });
  await h.sim.connect();
  h.run(3000);
  const ts = h.packets.map((p) => p.report.imuTimestampUs);
  const wrapAt = ts.findIndex((v, i) => i > 0 && v < ts[i - 1]);
  assert.ok(wrapAt > 0 && ts[wrapAt - 1] > 4_294_900_000 && ts[wrapAt] < 100_000, 'the timestamp wrapped');
  assert.equal(h.sim.getDiagnostics().stream.gaps, 0);
  for (const s of h.samples.slice(1)) assert.ok(s.dtMs > 5 && s.dtMs < 30, `dt ${s.dtMs} across the wrap`);
  // the 0x00 counter advances in milliseconds, the IMU timestamp in microseconds: both clocks agree over the run
  let imuMs = 0;
  let counterMs = 0;
  for (let i = 1; i < h.packets.length; i++) {
    imuMs += ((ts[i] - ts[i - 1]) >>> 0) / 1000;
    counterMs += (h.packets[i].report.counter - h.packets[i - 1].report.counter) >>> 0;
  }
  assert.ok(Math.abs(imuMs - counterMs) < 0.001 * imuMs + 2, `IMU clock ${imuMs.toFixed(1)} ms vs counter ${counterMs} ms`);
});

test('saturation: like the real fields the int16 values clip (gyro at 2000 dps, accel at 8 g)', T, async () => {
  const h = makeSim({ hz: 250, ...QUIET, leverM: 0.45 });
  await h.sim.connect();
  h.run(100);
  h.sim.setPose({ yawDeg: 90, pitchDeg: 0 }, { transitionMs: 30 });
  h.run(300);
  const gmax = Math.max(...h.samples.flatMap((s) => [Math.abs(s.gyro.x), Math.abs(s.gyro.y), Math.abs(s.gyro.z)]));
  assert.ok([2000, 32767 * (2000 / 32768)].includes(gmax), `a swing faster than the range shows the clipped extreme (int16: -32768 or 32767), got ${gmax}`);
  const amax = Math.max(...h.samples.flatMap((s) => [Math.abs(s.accel.x), Math.abs(s.accel.y), Math.abs(s.accel.z)]));
  assert.ok(amax <= 32768 / 4096);
  assert.ok(amax > 7, `the lever arm contaminates the accelerometer strongly during the swing: ${amax.toFixed(2)} g`);
  for (const s of h.samples) assertValid('ImuSample', s);
});

test('lever-arm acceleration contaminates the accelerometer during swings but not at rest', T, async () => {
  const h = makeSim({ mount: 'faceUp', noise: false, jitter: false, bursts: false, leverM: 0.45 });
  await h.sim.connect();
  h.run(500);
  const rest = h.samples.slice(-10).map((s) => norm(accelOf(s)));
  assert.ok(rest.every((m) => Math.abs(m - 1) < 0.002));
  const t0 = h.clock.now();
  h.run(600, { onStep: (now) => h.sim.setTarget(960 + 700 * Math.sin((now - t0) / 100), 540) });
  const during = h.between(t0, t0 + 600).map((s) => Math.abs(norm(accelOf(s)) - 1));
  assert.ok(Math.max(...during) > 0.3, `max deviation ${Math.max(...during).toFixed(2)} g`);
});

test('determinism: same seed and commands give identical bytes, other seeds differ; the tick pattern does not matter', T, async () => {
  const run = async (seed, stepMs) => {
    const h = makeSim({ seed });
    await h.sim.connect();
    h.run(3000, {
      stepMs,
      onStep: (now) => {
        if (now % 16 === 0) h.sim.setTarget(960 + 500 * Math.sin(now / 300), 540 + 200 * Math.cos(now / 500));
      },
    });
    return h.packets.map((p) => Array.from(p.bytes).join(','));
  };
  const a = await run(1, 4);
  const b = await run(1, 4);
  const c = await run(1, 1);
  const d = await run(1, 16);
  const e = await run(2, 4);
  assert.ok(a.length > 150);
  assert.deepEqual(a, b);
  assert.deepEqual(a, c, 'ticking every 1 ms produces the same packets as every 4 ms');
  assert.deepEqual(a, d, 'ticking every 16 ms produces the same packets');
  assert.notDeepEqual(a, e);
});

test('every packet is a byte-exact 63-byte report that the real parser accepts', T, async () => {
  const h = makeSim({ seed: 8 });
  await h.sim.connect();
  h.run(2000, { onStep: (now) => h.sim.setTarget(960 + 600 * Math.sin(now / 250), 540) });
  assert.ok(h.packets.length > 100);
  for (const p of h.packets) {
    assert.equal(p.length, 63);
    assert.ok(p.report && p.report.imuActive && p.report.imuMarker === 1);
    assert.deepEqual([...p.bytes.slice(7, 10)], [0xe0, 0xff, 0x0f], 'the constant bits of the real captures');
    assert.equal(p.report.temperatureRaw, INPUT_CONFIG.sim.temperatureRaw);
    assert.equal(p.report.batteryMv, 3700);
  }
});

test('simulateLoss / simulateRecovery: lost with lost_signal, reconnect fails until recovery, then streaming resumes with a gap', T, async () => {
  const h = makeSim({ ...QUIET });
  await h.sim.connect();
  h.run(500);
  const errors = [];
  h.sim.on('error', (e) => errors.push(e));
  const before = h.samples.length;
  h.sim.simulateLoss();
  assert.equal(h.sim.status.state, 'lost');
  assert.equal(h.sim.status.error.code, 'lost_signal');
  assert.equal(h.sim.status.trackingOk, false);
  assert.equal(h.sim.status.cooldownUntil, null, 'the simulator never cools down');
  assert.equal(errors.at(-1).code, 'lost_signal');
  h.run(1000);
  assert.equal(h.samples.length, before, 'no samples while the link is down');
  await assert.rejects(h.sim.reconnect(), (e) => e.code === 'gatt_failure');
  assert.equal(h.sim.status.state, 'lost');
  h.sim.simulateRecovery();
  assert.equal(h.sim.status.state, 'streaming');
  assert.equal(h.sim.status.error, null);
  assert.equal(h.sim.status.trackingOk, true);
  h.run(500);
  assert.ok(h.samples.length > before + 20);
  assert.equal(h.samples[before].dtMs, null, 'the first sample after the outage does not integrate across it');
  assert.ok(h.samples[before + 1].dtMs > 5);
  h.sim.simulateLoss();
  h.sim.simulateLoss(); // repeated loss is a no-op
  await h.sim.reconnect().then(
    () => assert.fail('reconnect must fail while the link is down and was not recovered'),
    (e) => assert.equal(e.code, 'gatt_failure'),
  );
  h.sim.simulateRecovery();
  h.sim.simulateRecovery();
  assert.equal(h.sim.status.state, 'streaming');
  // recovery armed before a loss makes reconnect() succeed
  h.sim.simulateLoss();
  h.sim.simulateRecovery();
  h.sim.simulateLoss();
  h.sim.simulateRecovery();
  await h.sim.reconnect();
});

test('simulateLoss outside streaming is a no-op; disconnect() clears a pending loss', T, async () => {
  const h = makeSim();
  h.sim.simulateLoss();
  assert.equal(h.sim.status.state, 'idle');
  await h.sim.connect();
  h.sim.simulateLoss();
  await h.sim.disconnect();
  assert.equal(h.sim.status.state, 'idle');
  await h.sim.connect();
  assert.equal(h.sim.status.state, 'streaming');
  h.run(300);
  assert.ok(h.samples.length > 10);
});

test('disconnect stops the samples and detaches the pointer; a new connect starts a fresh timeline', T, async () => {
  const h = makeSim({ ...QUIET });
  await h.sim.connect();
  h.run(500);
  const n = h.samples.length;
  await h.sim.disconnect();
  h.run(500);
  assert.equal(h.samples.length, n);
  const moved = h.target.pointer('pointermove', { clientX: 100, clientY: 100 });
  assert.ok(moved);
  await h.sim.connect();
  h.run(300);
  assert.ok(h.samples.length > n);
  assert.equal(h.samples[n].dtMs, null, 'first sample of the new session');
  assert.equal(h.samples[n].seq, n, 'sequence numbers carry on within the provider session');
});

test('catch-up: a tick far behind does not replay minutes of reports (they become a gap)', T, async () => {
  const h = makeSim({ ...QUIET });
  await h.sim.connect();
  h.clock.advance(120_000);
  const started = Date.now();
  h.sim.tick(h.clock.now());
  assert.ok(Date.now() - started < 500, 'must not simulate two minutes of physics');
  assert.ok(h.samples.length > 0 && h.samples.length <= 40, `${h.samples.length} samples replayed`);
  for (const s of h.samples) assert.ok(s.arrivedAt >= h.clock.now() - 260 - 20);
  h.run(500);
  assert.ok(h.samples.length > 30);
  h.sim.tick(h.clock.now());
  const n = h.samples.length;
  h.sim.tick(h.clock.now());
  assert.equal(h.samples.length, n, 'tick(now) is idempotent');
});

test('playCalibrationScript drives the wizard: still tip up, rotate to the screen, still, hold; stillness is calibration grade', T, async () => {
  for (const mount of MOUNT_NAMES) {
    const h = makeSim({ mount, seed: 12 });
    await h.sim.connect();
    const m = SIM_MOUNTS[mount];
    let done = false;
    const script = h.sim.playCalibrationScript().then(() => (done = true));
    h.run(9100);
    await Promise.resolve();
    assert.equal(done, false, 'the script is 9.2 s long');
    h.run(300);
    await script;
    assert.equal(done, true);
    const bias = vec(h.sim.getTruth().gyroBiasDps);
    const still = (from, to) => h.between(from, to);
    for (const [from, to, expected] of [[300, 2500, m.forward], [4300, 5900, m.up], [6500, 9100, m.up]]) {
      const win = still(from, to);
      assert.ok(win.length > 20);
      for (const s of win) {
        assert.ok(norm(sub(gyroOf(s), bias)) < 3, `${mount}: gyro ${norm(sub(gyroOf(s), bias)).toFixed(2)} dps above the bias in a still phase`);
        assert.ok(Math.abs(norm(accelOf(s)) - 1) < 0.05);
      }
      assert.ok(norm(sub(h.mean(win, accelOf), vec(expected))) < 0.03, `${mount}: still pose ${from}-${to}`);
    }
    const a1 = h.mean(still(300, 2500), accelOf);
    const a2 = h.mean(still(4300, 5900), accelOf);
    assert.ok(Math.abs(angleDeg(a1, a2) - 90) < 2, `${mount}: the two poses are 90 degrees apart (${angleDeg(a1, a2).toFixed(1)})`);
    // the rotation between them really happens (a swing of about 90 deg in 1.2 s)
    const peak = Math.max(...still(2600, 3800).map((s) => norm(sub(gyroOf(s), bias))));
    assert.ok(peak > 60 && peak < 200, `${mount}: rotation peak ${peak.toFixed(0)} dps`);
  }
});

test('the calibration script resolves on disconnect instead of hanging', T, async () => {
  const h = makeSim();
  await h.sim.connect();
  const script = h.sim.playCalibrationScript();
  h.run(1000);
  await h.sim.disconnect();
  await script;
});

test('option validation', T, () => {
  const clock = createManualClock(0);
  assert.throws(() => createInputProvider('sim', { clock, sim: { hz: 0 } }), RangeError);
  assert.throws(() => createInputProvider('sim', { clock, sim: { hz: NaN } }), RangeError);
  assert.throws(() => createInputProvider('sim', { clock, sim: { mount: 'sideways' } }), /unknown simulator mount/);
  assert.throws(() => createInputProvider('sim', { clock, sim: { mount: { frame: { right: { x: 1, y: 0, z: 0 } } } } }), TypeError);
  const custom = createInputProvider('sim', { clock, sim: { mount: { frame: { right: { x: 0, y: 1, z: 0 }, forward: { x: -1, y: 0, z: 0 }, up: { x: 0, y: 0, z: 1 } } } } });
  assertValid('Calibration', custom.nominalCalibration);
  assert.deepEqual(custom.nominalCalibration.frame.right, { x: 0, y: 1, z: 0 });
  // a side other than L is R
  assert.equal(createInputProvider('sim', { clock, sim: { side: 'X' } }).nominalCalibration.side, 'R');
});

test('real clock: the simulator self-schedules a 4 ms tick and stops it on disconnect', T, async () => {
  const manual = createManualClock(0);
  const timers = createFakeTimers(manual);
  const clock = { now: () => manual.now(), manual: false };
  const sim = createInputProvider('sim', { clock, timers, sim: { ...QUIET }, strictTransitions: true });
  const samples = [];
  sim.on('sample', (s) => samples.push(s));
  await sim.connect();
  assert.equal(timers.pending(), 1);
  await timers.advance(1000);
  assert.ok(samples.length >= 60 && samples.length <= 70, `${samples.length} samples without any explicit tick`);
  await sim.disconnect();
  assert.equal(timers.pending(), 0);
  sim.dispose();
});

test('contract: statuses and samples of a long mixed run validate; the simulator is not a Joy-Con (no buttons, no battery)', T, async () => {
  const h = makeSim({ seed: 31, mirrorGyro: true, gyroScaleTrue: 'alt', mount: 'tilted', side: 'L' });
  await h.sim.connect();
  h.run(5000, { onStep: (now) => h.sim.setTarget(960 + 800 * Math.sin(now / 500), 540 + 300 * Math.sin(now / 700)) });
  h.sim.simulateLoss();
  h.sim.simulateRecovery();
  h.run(1000);
  assert.ok(h.samples.length > 300);
  assert.ok(h.samples.every((s) => s.side === 'L' && s.buttons.length === 0));
  for (const s of h.statuses) assert.equal(s.battery.level, 'unknown');
  assert.equal(h.sim.getDiagnostics().kind, 'sim');
  JSON.stringify(h.sim.getDiagnostics());
  JSON.stringify(h.sim.getTruth());
});

test('sim.fire() and the left press of the virtual mouse (Clay Rush C-03): fire, source sim, label Click, t = newest report time', T, async () => {
  const h = makeSim({ hz: 66, seed: 3 });
  const before = h.sim.fire();
  assert.deepEqual([before.action, before.t, before.source], ['fire', 0, 'sim'], 'before connect: the clock time');
  await h.sim.connect();
  h.run(300);
  const actions = [];
  h.sim.on('action', (a) => actions.push(a));
  h.clock.advance(9);
  const n = h.samples.length;
  const ev = h.sim.fire();
  assert.ok(h.samples.length >= n, 'reports due by now were emitted first');
  assert.equal(ev.t, h.samples.at(-1).t);
  assert.ok(ev.t <= h.clock.now());
  h.target.pointer('pointerdown', { button: 0, clientX: 10, clientY: 10 });
  assert.deepEqual(actions.map((a) => [a.action, a.label, a.source]), [['fire', 'Click', 'sim'], ['fire', 'Click', 'sim']]);
  for (const a of actions) assertValid('ActionEvent', a);
});
