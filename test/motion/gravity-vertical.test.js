// Round F1 (docs/motion-contract.md 2.9): the vertical axis of the relative pointer follows the ELEVATION of the blade (gravity-stabilised
// pitch) with a capped gain, instead of the local `w . right` with the accelerating curve.
//
// Why: replaying the real recording, sustained vigorous swinging sank the cursor to the bottom edge (verifier finding F1: 10 % of the
// CUTTING samples of fast_swings_h in the middle half of the screen, median y 987 of 1080). Two causes, both measured on the recording:
//   1. wrist roll: the owner rolls the sword by +17 to -35 degrees while he slashes, so the sword's own pitch axis is tilted by a changing
//      angle; the local-frame integral of the vertical tip rate is -357 degrees while the true elevation of the tip changes by +1 degree;
//   2. gain hysteresis: the accelerating curve turns up and down movements of unequal speed into a net drift.
// The physical tests below use the synthetic rigid-body generator (exact gravity, lever-arm accelerations) so that the cause and the cure
// are visible without the recording; the recording itself is replayed in real-replay.test.js (F1).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMotionPipeline, MOTION_CONFIG } from '../../public/js/motion/index.js';
import { gravityPitchRate, verticalGainPxPerDeg, pointerGainPxPerDeg, tipVelocity } from '../../public/js/motion/pointer.js';
import { OrientationFilter } from '../../public/js/motion/fusion.js';
import { createSynth, MOUNTS, MOUNT_NAMES } from '../../test-support/motion/synth.js';
import { createTipStream, mountCalibration } from '../../test-support/motion/tip-stream.js';
import { record, feed } from '../../test-support/motion/harness.js';

const CFG = MOTION_CONFIG.pointer;
const OLD = { pointer: { gravityVertical: false } }; // the vertical axis as it was before round F1
const range = (xs) => Math.max(...xs) - Math.min(...xs);
const ss = (x) => {
  const c = Math.max(0, Math.min(1, x));
  return c * c * (3 - 2 * c);
};

// ---------------------------------------------------------------------------------------------------------------- the pure functions

test('gravityPitchRate: the rotation about the horizontal axis perpendicular to the blade, independent of the roll of the sword', () => {
  const f = { x: 0, y: 1, z: 0 };
  const up = { x: 0, y: 0, z: 1 };
  // level and upright: the same as the local rate w . right
  assert.equal(gravityPitchRate({ x: 25, y: 0, z: 0 }, f, up, 0.05), 25);
  assert.equal(gravityPitchRate({ x: 0, y: 0, z: -40 }, f, up, 0.05), 0, 'a turn about the sword up axis is not a pitch');
  assert.equal(gravityPitchRate({ x: 0, y: 500, z: 0 }, f, up, 0.05), 0, 'a roll about the blade is not a pitch');
  // the sword rolled by 40 degrees about its blade: the world vertical is (sin 40, 0, cos 40) in device coordinates. A horizontal slash
  // turns the sword about the world vertical: the tip does not rise or fall, but the local rate w . right sees 64 % of it
  const r40 = (40 * Math.PI) / 180;
  const upRolled = { x: Math.sin(r40), y: 0, z: Math.cos(r40) };
  const slash = { x: 800 * upRolled.x, y: 0, z: 800 * upRolled.z };
  assert.ok(Math.abs(gravityPitchRate(slash, f, upRolled, 0.05)) < 1e-9, 'a horizontal slash of a rolled sword does not change the elevation');
  assert.ok(Math.abs(slash.x - 514.2) < 0.5, `the local vertical rate of the same slash is ${slash.x.toFixed(1)} deg/s: the roll coupling of the old model`);
  // a real pitch of the rolled sword about the horizontal axis n = f x up: the whole rate is seen
  const n = { x: Math.cos(r40), y: 0, z: -Math.sin(r40) };
  assert.ok(Math.abs(gravityPitchRate({ x: 100 * n.x, y: 0, z: 100 * n.z }, f, upRolled, 0.05) - 100) < 1e-9);
  // upside down (the wind-up over the head): device pitch-up is a fall of the tip
  assert.equal(gravityPitchRate({ x: 25, y: 0, z: 0 }, f, { x: 0, y: 0, z: -1 }, 0.05), -25);
  // undefined at the zenith: null, and a number just outside minCos
  assert.equal(gravityPitchRate({ x: 25, y: 0, z: 0 }, f, f, 0.05), null, 'blade and gravity parallel');
  const nearZenith = { x: 0, y: Math.cos(Math.asin(0.04)), z: 0.04 }; // a blade 2.3 degrees from the vertical seen in the device frame
  assert.equal(gravityPitchRate({ x: 25, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }, nearZenith, 0.05), null, 'cos(elevation) 0.04 is below minCos');
  assert.notEqual(gravityPitchRate({ x: 25, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }, { x: 0, y: Math.cos(Math.asin(0.3)), z: 0.3 }, 0.05), null);
});

test('gravityPitchRate equals the local tip rate (tipVelocity.vU) when the sword is upright, on every mount preset', () => {
  const out = { s: 0, vR: 0, vU: 0 };
  for (const name of MOUNT_NAMES) {
    const m = MOUNTS[name];
    const w = { x: 31, y: -17, z: 52 };
    tipVelocity(w, m, false, out);
    const g = gravityPitchRate(w, m.forward, m.up, 0.05); // up in device coordinates = the sword up axis
    assert.ok(Math.abs(g - out.vU) < 1e-4, `${name}: gravity ${g} against local ${out.vU}`);
  }
});

test('verticalGainPxPerDeg: the horizontal curve below about 75 deg/s, flat at verticalMaxPxDeg above it, scaled by the sensitivity, zero in the dead zone', () => {
  assert.equal(CFG.verticalMaxPxDeg, 6);
  for (const sens of [0.3, 0.6, 1, 1.5, 2]) {
    assert.equal(verticalGainPxPerDeg(0, sens, CFG), 0);
    assert.equal(verticalGainPxPerDeg(CFG.deadDps, sens, CFG), 0, 'the dead zone does not scale');
    let prev = 0;
    for (let s = 0; s <= 1500; s += 2) {
      const v = verticalGainPxPerDeg(s, sens, CFG);
      assert.ok(v >= prev - 1e-12, `monotonic at ${s}`);
      assert.ok(v <= sens * CFG.verticalMaxPxDeg + 1e-12, `never above the cap at ${s}`);
      assert.ok(Math.abs(v - Math.min(pointerGainPxPerDeg(s, sens, CFG), sens * CFG.verticalMaxPxDeg)) < 1e-12);
      prev = v;
    }
    assert.ok(Math.abs(verticalGainPxPerDeg(1000, sens, CFG) - sens * 6) < 1e-12);
  }
  // below the crossing the vertical gain IS the horizontal one: slow vertical aiming feels exactly as before round F1
  for (const s of [6, 10, 20, 30, 50, 70]) assert.equal(verticalGainPxPerDeg(s, 1, CFG), pointerGainPxPerDeg(s, 1, CFG));
  assert.ok(pointerGainPxPerDeg(100, 1, CFG) > 6 && verticalGainPxPerDeg(100, 1, CFG) === 6, 'the cap binds from about 75 deg/s');
});

// ---------------------------------------------------------------------------------------------------------------- physical cause and cure

/**
 * Run a rigid-body pose path through a fresh relative pipeline: 2 s of rest at `restPose` first (a calm, exact gravity reading starts the
 * orientation filter, like the calibration does), then `pose(t)` for `ms`. Returns the blade samples of the moving part.
 */
function synthRun({ pose, ms, restPose, mount = 'faceUp', config, settings = {}, lever = 0.15, accelSign = 1, restMs = 2000 }) {
  const synth = createSynth({ mount, hz: 33, gyroBiasDps: [0, 0, 0], gyroNoiseDps: 0, accelNoiseG: 0, leverM: lever, startMs: 0, accelSign });
  const pipe = createMotionPipeline({ pointerModel: 'relative', settings: { autoCenter: false, ...settings }, config });
  const rec = record(pipe);
  if (accelSign === -1) pipe.setAccelSign(-1);
  pipe.setCalibration(synth.nominalCalibration());
  feed(pipe, synth.generate((t) => (t < restMs ? restPose : pose(t - restMs)), restMs + ms));
  return { pipe, rec, blades: rec.blades.filter((b) => b.t >= restMs) };
}

/**
 * The owner's slash pattern: horizontal strokes of 150 degrees in 220 ms (peak about 990 deg/s) at a constant elevation, and the wrist
 * rolls BETWEEN the strokes (the forward stroke at roll rF, the return stroke at roll rB), 300 ms pauses. The elevation never changes.
 */
const STROKE = { strokeMs: 220, pauseMs: 300, sweep: 150, el: 15, rF: -28, rB: -4 };
const CYCLE = 2 * (STROKE.strokeMs + STROKE.pauseMs);
function slashPose({ strokeMs, pauseMs, sweep, el, rF, rB } = STROKE) {
  return (t) => {
    const u = ((t % CYCLE) + CYCLE) % CYCLE;
    let yaw;
    let roll;
    if (u < strokeMs) {
      yaw = sweep * ss(u / strokeMs);
      roll = rF;
    } else if (u < strokeMs + pauseMs) {
      yaw = sweep;
      roll = rF + (rB - rF) * ss((u - strokeMs) / pauseMs);
    } else if (u < 2 * strokeMs + pauseMs) {
      yaw = sweep * (1 - ss((u - strokeMs - pauseMs) / strokeMs));
      roll = rB;
    } else {
      yaw = 0;
      roll = rB + (rF - rB) * ss((u - 2 * strokeMs - pauseMs) / pauseMs);
    }
    return { yaw, pitch: el, roll };
  };
}
const REST = { yaw: 0, pitch: STROKE.el, roll: STROKE.rF };

test('F1 cause and cure: slashes at a constant elevation with the wrist rolling between the strokes keep the cursor height, the old vertical axis sinks to the bottom edge', () => {
  const run = (config, lever) => synthRun({ pose: slashPose(), ms: 10 * CYCLE, restPose: REST, config, lever });
  for (const lever of [0, 0.11, 0.3]) {
    const now = run(undefined, lever).blades;
    const old = run(OLD, lever).blades;
    assert.ok(now.filter((b) => b.cutting).length > 80, `${lever}: the strokes cut (${now.filter((b) => b.cutting).length} samples)`);
    // the elevation of the tip is constant: the cursor height must stay where it was (540), whatever the roll, the speed and the lever arm
    assert.ok(range(now.map((b) => b.y)) <= 30, `lever ${lever}: y range ${range(now.map((b) => b.y)).toFixed(0)} px with the gravity vertical axis`);
    assert.ok(Math.abs(now.at(-1).y - 540) <= 30, `lever ${lever}: final y ${now.at(-1).y.toFixed(0)}`);
    // the old axis: the roll between the strokes makes the forward and the return stroke tilt by different angles (about -50 degrees of net
    // pitch per cycle at 14 px/deg): the cursor is pinned at the bottom within a few strokes
    assert.ok(old.at(-1).y > 900 && range(old.map((b) => b.y)) > 400, `lever ${lever}: the old vertical axis ends at y ${old.at(-1).y.toFixed(0)}, range ${range(old.map((b) => b.y)).toFixed(0)}`);
    // nothing else changed: the horizontal axis and the cut decision are the same sample by sample
    assert.deepEqual(now.map((b) => [b.x, b.cutting, b.swingId]), old.map((b) => [b.x, b.cutting, b.swingId]), 'x and CUTTING do not depend on the vertical model');
  }
});

test('F1 on every mount preset (right-handed, left-handed, upside down, tip flipped, tilted, side rail): the physical pose gives the same cursor height', () => {
  for (const mount of MOUNT_NAMES) {
    for (const side of ['R']) {
      const { blades } = synthRun({ pose: slashPose(), ms: 6 * CYCLE, restPose: REST, mount });
      assert.ok(range(blades.map((b) => b.y)) <= 30, `${mount}/${side}: y range ${range(blades.map((b) => b.y)).toFixed(0)} px`);
      assert.ok(blades.filter((b) => b.cutting).length > 40, `${mount}: the strokes cut`);
    }
  }
});

test('F1 with the accelerometer sign reversed (the sensor reports the gravity vector): the pipeline that applies accelSign -1 behaves the same', () => {
  const { blades } = synthRun({ pose: slashPose(), ms: 6 * CYCLE, restPose: REST, accelSign: -1 });
  assert.ok(range(blades.map((b) => b.y)) <= 30, `y range ${range(blades.map((b) => b.y)).toFixed(0)} px`);
});

test('F1 path independence: an elevation that goes up fast and comes down slower returns the cursor to the same height every cycle (above about 75 deg/s the vertical gain is flat)', () => {
  // up 30 degrees in 120 ms (250 deg/s on average), down in 240 ms (125 deg/s): both legs are above the crossing of the cap
  const CYC = 700;
  const pose = (t) => {
    const u = ((t % CYC) + CYC) % CYC;
    const pitch = u < 120 ? 10 + 30 * ss(u / 120) : u < 360 ? 40 - 30 * ss((u - 120) / 240) : 10;
    return { yaw: 0, pitch, roll: 0 };
  };
  const now = synthRun({ pose, ms: 8 * CYC, restPose: { yaw: 0, pitch: 10, roll: 0 } }).blades;
  const old = synthRun({ pose, ms: 8 * CYC, restPose: { yaw: 0, pitch: 10, roll: 0 }, config: OLD }).blades;
  const atCycleEnd = (bl) => bl.filter((b, i) => i > 0 && Math.floor((b.t - 2000) / CYC) !== Math.floor((bl[i - 1].t - 2000) / CYC)).map((b) => b.y);
  const ends = atCycleEnd(now);
  assert.ok(ends.length >= 7, `${ends.length} cycle ends`);
  assert.ok(range(ends) <= 40, `the cursor height at the end of each cycle varies by ${range(ends).toFixed(0)} px`);
  assert.ok(Math.abs(ends.at(-1) - 540) <= 60, `and stays at the start height: ${ends.at(-1).toFixed(0)}`);
  assert.ok(range(now.map((b) => b.y)) > 120, 'the strokes themselves do move the cursor (about 30 degrees x 6 px/deg)');
  const oldEnds = atCycleEnd(old);
  assert.ok(oldEnds.at(-1) > 800 || oldEnds.at(-1) < 300, `the accelerating curve walks away by ${Math.abs(oldEnds.at(-1) - 540).toFixed(0)} px after 8 cycles`);
});

test('F1 vertical direction: tipping the sword up moves the cursor up and down moves it down, also upside down and with a rolled sword', () => {
  const tip = (pose) => {
    const { blades } = synthRun({ pose, ms: 600, restPose: { yaw: 0, pitch: 0, roll: pose(0).roll } });
    return blades.at(-1).y - 540;
  };
  const up = (roll) => tip((t) => ({ yaw: 0, pitch: 40 * ss(t / 300), roll }));
  const down = (roll) => tip((t) => ({ yaw: 0, pitch: -40 * ss(t / 300), roll }));
  for (const roll of [0, 30, -45, 120]) {
    assert.ok(up(roll) < -150, `roll ${roll}: up moved the cursor by ${up(roll).toFixed(0)} px`);
    assert.ok(down(roll) > 150, `roll ${roll}: down moved the cursor by ${down(roll).toFixed(0)} px`);
    // 40 degrees at the capped gain: at most 40 x 6 px
    assert.ok(Math.abs(up(roll)) <= 40 * CFG.verticalMaxPxDeg + 15 && Math.abs(up(roll) + down(roll)) < 25, `roll ${roll}: about 240 px and symmetric`);
  }
  // upside down (roll 180): the tip rising is still the cursor going up
  assert.ok(up(180) < -150 && down(180) > 150, 'upside down');
});

test('F1 sensitivity scales the vertical excursion, flipX does not touch it, and the horizontal axis is not changed by the vertical model', () => {
  const pose = (t) => ({ yaw: 60 * ss(t / 400), pitch: 15 + 25 * ss(t / 400), roll: 10 });
  const base = synthRun({ pose, ms: 500, restPose: { yaw: 0, pitch: 15, roll: 10 } }).blades.at(-1);
  const twice = synthRun({ pose, ms: 500, restPose: { yaw: 0, pitch: 15, roll: 10 }, settings: { sensitivity: 2 } }).blades.at(-1);
  const flip = synthRun({ pose, ms: 500, restPose: { yaw: 0, pitch: 15, roll: 10 }, settings: { flipX: true } }).blades.at(-1);
  const old = synthRun({ pose, ms: 500, restPose: { yaw: 0, pitch: 15, roll: 10 }, config: OLD }).blades.at(-1);
  assert.ok(base.y < 540 - 50);
  assert.ok(Math.abs(540 - twice.y - 2 * (540 - base.y)) < 12, `sensitivity 2: ${(540 - twice.y).toFixed(0)} against ${(540 - base.y).toFixed(0)}`);
  assert.ok(Math.abs(flip.y - base.y) < 1e-9 && Math.abs(flip.x - 960 + (base.x - 960)) < 1e-6, 'flipX mirrors x only');
  assert.equal(old.x, base.x, 'the horizontal axis does not depend on the vertical model');
});

test('F1 the switch: gravityVertical false restores the vertical axis of the contract 2.2 curve exactly (F(200) = 2236 px/s), on the same pipeline', () => {
  const stream = createTipStream({});
  const pipe = createMotionPipeline({ pointerModel: 'relative', settings: { autoCenter: false }, config: OLD });
  const rec = record(pipe);
  pipe.setCalibration(mountCalibration('faceUp', 'R'));
  feed(pipe, stream.hold(5, 0, 200));
  assert.ok(Math.abs(Math.hypot(rec.blades.at(-1).vx, rec.blades.at(-1).vy) - 2236) <= 1);
  assert.equal(pipe.getDebug().pointer.pitchRateDps, null, 'the local rate is used');
  const now = createMotionPipeline({ pointerModel: 'relative', settings: { autoCenter: false } });
  const rec2 = record(now);
  now.setCalibration(mountCalibration('faceUp', 'R'));
  feed(now, createTipStream({}).hold(5, 0, 200));
  assert.ok(Math.abs(rec2.blades.at(-1).vy + 6 * 200) <= 1e-6, `the vertical speed is capped: ${rec2.blades.at(-1).vy}`);
});

// ---------------------------------------------------------------------------------------------------------------- the tilt must be trusted

test('F1 the gravity axis is used only after a calm reading confirmed the tilt: a start in the middle of a swing falls back on the local rate, then confirms when the sword rests', () => {
  const pose = slashPose();
  // start the pipeline 60 ms into a stroke (the first accelerometer reading is contaminated by the swing), swing for 1.6 s, then hold still
  const synth = createSynth({ mount: 'faceUp', hz: 33, gyroBiasDps: [0, 0, 0], gyroNoiseDps: 0, accelNoiseG: 0, leverM: 0.25, startMs: 0 });
  const pipe = createMotionPipeline({ pointerModel: 'relative', settings: { autoCenter: false } });
  record(pipe);
  pipe.setCalibration(synth.nominalCalibration());
  const samples = synth.generate((t) => pose(Math.min(t, 1600) + 60), 3000);
  let firstConfirm = null;
  let usedWhileUnconfirmed = 0;
  let swingSamples = 0;
  for (const s of samples) {
    pipe.pushImu(s);
    pipe.poll(s.t);
    const d = pipe.getDebug().pointer;
    if (d.gravityConfirmed && firstConfirm === null) firstConfirm = s.t;
    if (!d.gravityConfirmed && d.pitchRateDps !== null) usedWhileUnconfirmed += 1;
    if (s.t < 1600 && d.tipSpeedDps > 300) swingSamples += 1;
  }
  assert.ok(swingSamples > 10, `${swingSamples} fast samples while swinging`);
  assert.equal(usedWhileUnconfirmed, 0, 'an unconfirmed tilt never drives the vertical axis');
  assert.ok(firstConfirm !== null && firstConfirm > 100, `confirmed at ${firstConfirm} ms: not on the contaminated first reading`);
  assert.equal(pipe.getDebug().pointer.gravityConfirmed, true, 'confirmed once the sword rests');
  // a calm start confirms within two samples
  const calm = synthRun({ pose, ms: 0, restPose: REST });
  assert.equal(calm.pipe.getDebug().pointer.gravityConfirmed, true);
});

test('OrientationFilter.confirmed: false after init and reset, true after a calm agreeing correction, not for a disagreeing or untrusted one; unconfirmed time constant', () => {
  const f = new OrientationFilter(1.5, { bootS: 0, bootTauS: 0.2, confirmTrust: 0.4, confirmTiltDeg: 8, unconfirmedTauS: 0.3 });
  assert.equal(f.confirmed, false);
  f.initFromAccel(0, 0, 1);
  assert.equal(f.confirmed, false, 'an initialisation alone confirms nothing');
  f.correct(0, 0, 1, 0.03, 0.2);
  assert.equal(f.confirmed, false, 'a reading with a trust weight below confirmTrust does not confirm');
  f.correct(0.5, 0, 0.87, 0.03, 1); // 30 degrees away
  assert.equal(f.confirmed, false, 'a trusted reading that disagrees by 30 degrees does not confirm');
  f.correct(0, 0, 1, 0.03, 1);
  assert.equal(f.confirmed, true);
  f.reset();
  assert.equal(f.confirmed, false);
  // while unconfirmed (after the boot) the correction uses unconfirmedTauS: a 30 degree error shrinks faster than with tau 1.5 s
  const slow = new OrientationFilter(1.5, { bootS: 0, bootTauS: 0.2, unconfirmedTauS: 1.5 });
  const fast = new OrientationFilter(1.5, { bootS: 0, bootTauS: 0.2, unconfirmedTauS: 0.3 });
  for (const g of [slow, fast]) g.initFromAccel(0.5, 0, 0.866);
  for (let i = 0; i < 10; i += 1) {
    slow.correct(0, 0, 1, 0.03, 0.3);
    fast.correct(0, 0, 1, 0.03, 0.3);
  }
  const tilt = (g) => (Math.acos(Math.max(-1, Math.min(1, g.predictedUp().z))) * 180) / Math.PI;
  assert.ok(tilt(fast) < tilt(slow) - 1, `${tilt(fast).toFixed(1)} against ${tilt(slow).toFixed(1)} degrees after 0.3 s`);
});

test('F1 near the zenith the pitch axis is undefined: the local rate with the capped gain takes over, nothing is non-finite, the cursor stays in the field', () => {
  // the sword swung over the top of its arc (a wind-up over the head): pitch 70 -> 110 degrees passes the vertical smoothly at 500 ms
  const pose = (t) => ({ yaw: 0, pitch: 70 + 40 * ss(t / 1000), roll: 0 });
  const synth = createSynth({ mount: 'faceUp', hz: 33, gyroBiasDps: [0, 0, 0], gyroNoiseDps: 0, accelNoiseG: 0, leverM: 0, startMs: 0 });
  const pipe = createMotionPipeline({ pointerModel: 'relative', settings: { autoCenter: false } });
  const rec = record(pipe);
  pipe.setCalibration(synth.nominalCalibration());
  let nearZenith = 0;
  let awayFromZenith = 0;
  for (const s of synth.generate((t) => (t < 2000 ? { yaw: 0, pitch: 70, roll: 0 } : pose(t - 2000)), 3000)) {
    pipe.pushImu(s);
    pipe.poll(s.t);
    const d = pipe.getDebug().pointer;
    if (!d.gravityConfirmed || s.t < 2000 || d.tipSpeedDps < 20) continue;
    if (d.elevationDeg >= 87.5) {
      nearZenith += 1;
      assert.equal(d.pitchRateDps, null, `elevation ${d.elevationDeg.toFixed(1)}: within asin(gravityMinCos) of the vertical the local rate is used`);
    } else if (d.elevationDeg <= 80) {
      awayFromZenith += 1;
      assert.ok(Number.isFinite(d.pitchRateDps), `elevation ${d.elevationDeg.toFixed(1)}: the gravity axis is defined`);
    }
  }
  assert.ok(nearZenith >= 1 && awayFromZenith >= 5, `${nearZenith} samples near the zenith, ${awayFromZenith} away from it`);
  for (const b of rec.blades) {
    assert.ok(Number.isFinite(b.x) && Number.isFinite(b.y) && Number.isFinite(b.vx) && Number.isFinite(b.vy), 'finite');
    assert.ok(b.y >= 0 && b.y <= 1080 && b.x >= 0 && b.x <= 1920, 'inside the field');
  }
});
