// Integration of the Motion pipeline with the Input engineer's simulator provider (independent virtual sword model, byte-exact
// Joy-Con packets, the real parser and report stream). If the simulator cannot be imported the tests are SKIPPED (reported as
// skipped, never as passed). Both sides model docs/joycon2-protocol.md, not the physical device (UNVERIFIED-ON-HARDWARE).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createManualClock } from '../../public/js/shared/clock.js';
import { angleDeg, record, createAbsolutePipeline } from '../../test-support/motion/harness.js';

let createInputProvider = null;
let SIM_MOUNTS = null;
let importError = null;
try {
  ({ createInputProvider, SIM_MOUNTS } = await import('../../public/js/input/index.js'));
} catch (err) {
  importError = err;
}

const skip = importError ? `input module not importable: ${importError.message}` : false;
const near = (a, b, tol, msg = '') => assert.ok(Math.abs(a - b) <= tol, `${msg} expected ${b} +-${tol}, got ${a}`);

async function makeRig(simOpts = {}, pipeOpts = {}) {
  const clock = createManualClock(0);
  const prov = createInputProvider('sim', { clock, sim: { hz: 66, seed: 7, ...simOpts } });
  const pipe = createAbsolutePipeline({ clock, ...pipeOpts });
  const rec = record(pipe);
  prov.on('sample', (s) => pipe.pushImu(s));
  await prov.connect();
  const run = (ms) => {
    for (let i = 0; i < Math.round(ms / 4); i += 1) {
      clock.advance(4);
      prov.tick(clock.now());
      pipe.poll(clock.now());
    }
  };
  return { clock, prov, pipe, rec, run };
}

test('sim integration: the real calibration wizard recovers the simulator truth for every mount, side, mirror and scale', { skip }, async (t) => {
  let n = 0;
  let worstFrame = 0;
  let worstScale = 0;
  for (const mount of Object.keys(SIM_MOUNTS)) {
    for (const variant of [{}, { mirrorGyro: true }, { gyroScaleTrue: 'alt' }]) {
      n += 1;
      const side = n % 2 ? 'L' : 'R';
      const rig = await makeRig({ mount, side, seed: 10 + n, ...variant });
      rig.pipe.startCalibration({ side });
      void rig.prov.playCalibrationScript();
      rig.run(9200 + 600);
      const done = rig.rec.calibration.find((e) => e.type === 'done');
      const label = `${mount} ${side} ${JSON.stringify(variant)}`;
      assert.ok(done, `${label}: no calibration (${rig.rec.calibration.filter((e) => e.type !== 'progress').map((e) => e.type + (e.step ?? '') + (e.reason ? ':' + e.reason : '')).join(',')})`);
      const truth = rig.prov.getTruth();
      const c = done.calibration;
      const ef = angleDeg(c.frame.forward, truth.frame.forward);
      const eu = angleDeg(c.frame.up, truth.frame.up);
      worstFrame = Math.max(worstFrame, ef, eu);
      assert.ok(ef < 3 && eu < 3, `${label}: frame error ${ef.toFixed(2)} / ${eu.toFixed(2)} deg`);
      assert.equal(c.gyroSign, truth.gyroSign, `${label}: gyro sign`);
      const se = Math.abs(c.gyroScale / truth.gyroScaleRatio - 1);
      worstScale = Math.max(worstScale, se);
      assert.ok(se < 0.05, `${label}: gyroScale ${c.gyroScale} vs ${truth.gyroScaleRatio}`);
      assert.equal(c.side, side);
      // the wizard's bias against the simulator's true bias (both in ImuSample.gyro units), compared in true dps
      const be = Math.hypot(c.gyroBiasDps.x - truth.gyroBiasDps.x, c.gyroBiasDps.y - truth.gyroBiasDps.y, c.gyroBiasDps.z - truth.gyroBiasDps.z) * truth.gyroScaleRatio;
      assert.ok(be < 0.2, `${label}: bias error ${be.toFixed(3)} true dps`);
    }
  }
  t.diagnostic(`${n} simulator calibrations through the real parser: worst frame error ${worstFrame.toFixed(3)} deg, worst gyroScale error ${(worstScale * 100).toFixed(2)} %`);
});

test('sim integration: nominalCalibration + mouse glides land the cursor on the mouse (within 12 px) for every mount', { skip }, async (t) => {
  let worst = 0;
  for (const mount of Object.keys(SIM_MOUNTS)) {
    const rig = await makeRig({ mount, side: 'R', seed: 21 }, { settings: { autoCenter: false } });
    rig.pipe.setCalibration(rig.prov.nominalCalibration);
    rig.run(2500); // filter converges, cursor at the centre
    for (const [x, y] of [[300, 540], [1500, 300], [700, 900], [960, 540]]) {
      rig.prov.setTarget(x, y, { glideMs: 500 });
      rig.run(500 + 1200);
      const b = rig.rec.blades[rig.rec.blades.length - 1];
      const err = Math.hypot(b.x - x, b.y - y);
      worst = Math.max(worst, err);
      assert.ok(err < 12, `${mount}: aimed at (${x},${y}), cursor at (${b.x.toFixed(1)},${b.y.toFixed(1)})`);
    }
  }
  t.diagnostic(`worst cursor error after glides with the exact calibration: ${worst.toFixed(2)} px`);
});

test('sim integration: a steady mouse speed of v px/s gives a blade speed within 15 percent (A-12 requirement)', { skip }, async (t) => {
  let worst = 0;
  for (const v of [1500, 3000, 6000]) {
    const rig = await makeRig({ mount: 'tilted', seed: 33 }, { settings: { autoCenter: false } });
    rig.pipe.setCalibration(rig.prov.nominalCalibration);
    rig.run(2000);
    rig.prov.setTarget(200, 540, { glideMs: 300 });
    rig.run(300 + 600);
    let x = 200;
    const speeds = [];
    const start = rig.rec.blades.length;
    const steps = Math.floor(((1700 - 200) / v) * 250); // 4 ms per step
    for (let i = 0; i < steps; i += 1) {
      x += (v * 4) / 1000;
      rig.prov.setTarget(x, 540);
      rig.run(4);
    }
    const seg = rig.rec.blades.slice(start + Math.floor(rig.rec.blades.length - start) * 0.3);
    for (const b of seg) if (b.speed > 0) speeds.push(b.speed);
    const median = speeds.sort((a, b) => a - b)[speeds.length >> 1];
    const err = Math.abs(median / v - 1);
    worst = Math.max(worst, err);
    assert.ok(err < 0.15, `v=${v}: median blade speed ${median.toFixed(0)}`);
  }
  t.diagnostic(`steady mouse speed vs blade speed through the whole chain: worst error ${(worst * 100).toFixed(1)} %`);
});

test('sim integration: fast glide cuts, slow glide does not, at the simulator default 66 Hz with jitter, bursts and noise', { skip }, async () => {
  const rig = await makeRig({ mount: 'faceSide', side: 'L', seed: 44 }, { settings: { autoCenter: false } });
  rig.pipe.setCalibration(rig.prov.nominalCalibration);
  rig.run(2000);
  // slow: 1400 px in 2.5 s = 560 px/s
  rig.prov.setTarget(1660, 540, { glideMs: 2500 });
  rig.run(2500 + 600);
  assert.equal(rig.rec.blades.some((b) => b.cutting), false, 'a slow glide never cuts');
  // fast: 1400 px in 220 ms
  const mark = rig.rec.blades.length;
  rig.prov.setTarget(260, 540, { glideMs: 220 });
  rig.run(220 + 600);
  const cutting = rig.rec.blades.slice(mark).filter((b) => b.cutting);
  assert.ok(cutting.length >= 5, `fast glide cut for ${cutting.length} samples`);
  const segs = rig.rec.drain();
  assert.ok(segs.length >= 5);
  assert.equal(new Set(cutting.map((b) => b.swingId)).size, 1, 'one swing');
});
