// Integration: the SIMULATOR provider feeding the REAL Motion pipeline (docs/architecture.md 5.8 and 10.2, "mount matrix").
// This pins the contract between the two modules: accelerometer sign, gyro sign, the mount frame convention, the gyro
// scale estimate and the nominal calibration. Both sides are software models of docs/joycon2-protocol.md; a green result
// says nothing about the physical Joy-Con (UNVERIFIED-ON-HARDWARE: UOH-6, UOH-7). The test skips, and says so, when the
// Motion module is not present in the tree.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createManualClock } from '../../public/js/shared/clock.js';
import { createInputProvider, SIM_MOUNTS } from '../../public/js/input/index.js';
import { assertValid } from '../../public/js/shared/validate.js';

let createMotionPipeline = null;
try {
  ({ createMotionPipeline } = await import('../../public/js/motion/index.js'));
} catch {
  createMotionPipeline = null;
}
const skip = createMotionPipeline ? false : 'the Motion module is not available in this tree';
const T = { timeout: 120000, skip };

const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
const angleDeg = (a, b) => (Math.acos(Math.max(-1, Math.min(1, dot(a, b)))) * 180) / Math.PI;

function rig(simOpts) {
  const clock = createManualClock(0);
  const sim = createInputProvider('sim', { clock, sim: simOpts, strictTransitions: true });
  // the simulator is a mouse in disguise: it keeps the ABSOLUTE pointer model (docs/motion-contract.md 1.4); the default 'relative' model is the real sword's
  const motion = createMotionPipeline({ clock, pointerModel: 'absolute' });
  const calEvents = [];
  motion.on('calibration', (e) => calEvents.push(e));
  sim.on('sample', (s) => motion.pushImu(s));
  return {
    clock, sim, motion, calEvents,
    run(ms) {
      const end = clock.now() + ms;
      while (clock.now() < end - 1e-9) {
        clock.advance(4);
        sim.tick(clock.now());
        motion.poll(clock.now());
      }
    },
  };
}

test('nominalCalibration: the real Motion pipeline puts the cursor on the virtual mouse, for every mount, gyro sign and scale', T, async () => {
  for (const mount of Object.keys(SIM_MOUNTS)) {
    for (const mirrorGyro of [false, true]) {
      for (const gyroScaleTrue of ['default', 'alt']) {
        const r = rig({ mount, mirrorGyro, gyroScaleTrue, side: 'L', seed: 5 });
        await r.sim.connect();
        assertValid('Calibration', r.sim.nominalCalibration);
        r.motion.setCalibration(r.sim.nominalCalibration);
        r.run(800);
        for (const [x, y] of [[300, 300], [1600, 800], [960, 540], [200, 900]]) {
          r.sim.setTarget(x, y, { glideMs: 900 }); // a smooth, physically consistent move (a teleport is invisible to the gyro)
          r.run(1400);
          const cursor = r.motion.latest();
          assert.ok(Math.hypot(cursor.x - x, cursor.y - y) < 40, `${mount}/mirror=${mirrorGyro}/${gyroScaleTrue}: target (${x},${y}) cursor (${cursor.x.toFixed(0)},${cursor.y.toFixed(0)})`);
        }
      }
    }
  }
});

test('calibration wizard driven by playCalibrationScript(): the real Motion finds the mount frame, the gyro sign and the gyro scale', T, async () => {
  for (const mount of Object.keys(SIM_MOUNTS)) {
    for (const mirrorGyro of [false, true]) {
      for (const gyroScaleTrue of ['default', 'alt']) {
        const side = mirrorGyro ? 'L' : 'R';
        const r = rig({ mount, mirrorGyro, gyroScaleTrue, side, seed: 7 });
        await r.sim.connect();
        r.motion.startCalibration({ side });
        r.sim.playCalibrationScript();
        r.run(12_000);
        const label = `${mount}/mirror=${mirrorGyro}/${gyroScaleTrue}/${side}`;
        const failures = r.calEvents.filter((e) => e.type === 'stepFailed').map((e) => `${e.step}:${e.reason}`);
        assert.deepEqual(failures, [], `${label}: no step may fail`);
        const done = r.calEvents.find((e) => e.type === 'done');
        assert.ok(done, `${label}: the wizard must finish`);
        const cal = done.calibration;
        assertValid('Calibration', cal);
        const truth = r.sim.getTruth();
        for (const k of ['right', 'forward', 'up']) assert.ok(angleDeg(cal.frame[k], truth.frame[k]) < 3, `${label}: ${k} axis is ${angleDeg(cal.frame[k], truth.frame[k]).toFixed(1)} degrees off`);
        assert.equal(cal.gyroSign, truth.gyroSign, `${label}: gyro sign`);
        assert.ok(Math.abs(cal.gyroScale / truth.gyroScaleRatio - 1) < 0.03, `${label}: gyro scale ${cal.gyroScale} vs ${truth.gyroScaleRatio}`);
        assert.equal(cal.side, side);
      }
    }
  }
});

test('with the wizard result the cursor follows the virtual mouse (the whole chain: mouse -> IMU packets -> parser -> Motion)', T, async () => {
  const r = rig({ mount: 'sideRail', mirrorGyro: true, gyroScaleTrue: 'alt', seed: 9 });
  await r.sim.connect();
  r.motion.startCalibration({ side: 'R' });
  r.sim.playCalibrationScript();
  r.run(12_000);
  assert.ok(r.calEvents.some((e) => e.type === 'done'));
  r.motion.recenter('manual');
  r.run(600);
  const start = r.motion.latest();
  assert.ok(Math.hypot(start.x - 960, start.y - 540) < 60, 'recentred');
  r.sim.setTarget(1500, 300, { glideMs: 1000 });
  r.run(1500);
  const end = r.motion.latest();
  assert.ok(Math.hypot(end.x - 1500, end.y - 300) < 60, `cursor (${end.x.toFixed(0)},${end.y.toFixed(0)})`);
});

test('sim.fire() (Clay Rush 4.1): a fire at the newest simulated report time, and motion.aimAt(t) of it is valid and on the virtual mouse', T, async () => {
  const r = rig({ seed: 9 });
  await r.sim.connect();
  r.motion.setCalibration(r.sim.nominalCalibration);
  r.run(800);
  const fires = [];
  const samples = [];
  r.sim.on('action', (a) => fires.push(a));
  r.sim.on('sample', (s) => samples.push(s));
  for (const [x, y] of [[400, 300], [1500, 750]]) {
    r.sim.setTarget(x, y, { glideMs: 600 });
    r.run(1000);
    r.clock.advance(11); // between two reports: fire() first emits what is due
    const ev = r.sim.fire();
    assert.deepEqual([ev.action, ev.label, ev.source], ['fire', 'Click', 'sim']);
    assertValid('ActionEvent', ev);
    assert.equal(fires.at(-1), ev, 'the hook emits the event it returns');
    assert.ok(ev.t <= r.clock.now(), 'never in the future');
    assert.equal(ev.t, samples.at(-1).t, 'the time of the newest report');
    const a = r.motion.aimAt(ev.t);
    assert.equal(a.valid, true);
    assert.ok(Math.hypot(a.x - x, a.y - y) < 40, `aim (${a.x.toFixed(0)}, ${a.y.toFixed(0)}) on the virtual mouse (${x}, ${y})`);
    const head = r.motion.latest();
    assert.ok(Math.hypot(a.x - head.x, a.y - head.y) < 1e-9, 'exactly the newest sample');
  }
  await r.sim.disconnect();
  const idle = r.sim.fire();
  assert.equal(idle.t, r.clock.now(), 'not streaming: the clock time');
});
