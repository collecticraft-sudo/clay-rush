import test from 'node:test';
import assert from 'node:assert/strict';
import {
  qIdentity, qMul, qIntegrate, qRotate, qRotateInv, qFromAxisAngle, qFromUnitVectors, qToRotationVector, qNormalize,
} from '../../public/js/motion/quat.js';
import { vAngleDeg, vCross, vDot, vNormalize, vPerpendicular, wrapDeg, vCos } from '../../public/js/motion/vec.js';
import { MOTION_CONFIG, mergeConfig } from '../../public/js/motion/motion-config.js';

const close = (a, b, eps = 1e-9, msg = '') => assert.ok(Math.abs(a - b) <= eps, `${msg} expected ${b}, got ${a}`);
const closeVec = (a, b, eps = 1e-9) => {
  close(a.x, b.x, eps, 'x');
  close(a.y, b.y, eps, 'y');
  close(a.z, b.z, eps, 'z');
};

test('vec: angle, cross, normalize, wrap, perpendicular', () => {
  close(vAngleDeg({ x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }), 90, 1e-9);
  close(vAngleDeg({ x: 1, y: 0, z: 0 }, { x: -1, y: 0, z: 0 }), 180, 1e-9);
  close(vAngleDeg({ x: 1, y: 0, z: 0 }, { x: 1, y: 1e-9, z: 0 }), 1e-9 * (180 / Math.PI), 1e-12);
  assert.equal(vAngleDeg({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }), 0);
  closeVec(vCross({ x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }), { x: 0, y: 0, z: 1 });
  assert.deepEqual(vNormalize({ x: 0, y: 0, z: 0 }), { x: 0, y: 0, z: 0 });
  close(vCos({ x: 1, y: 0, z: 0 }, { x: 1, y: 1, z: 0 }), Math.SQRT1_2);
  assert.equal(vCos({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }), 0);
  assert.equal(wrapDeg(190), -170);
  assert.equal(wrapDeg(-190), 170);
  assert.equal(wrapDeg(180), 180);
  assert.equal(wrapDeg(-180), 180);
  assert.equal(wrapDeg(725), 5);
  for (const v of [{ x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: 1 }, vNormalize({ x: 1, y: 2, z: 3 })]) {
    const p = vPerpendicular(v);
    close(vDot(p, v), 0, 1e-12);
    close(Math.hypot(p.x, p.y, p.z), 1, 1e-12);
  }
});

test('quat: rotation direction, inverse, composition matches sequential rotation', () => {
  // +90 deg about z (right-hand rule) carries x to y
  const qz = qFromAxisAngle(0, 0, 1, Math.PI / 2);
  closeVec(qRotate(qz, { x: 1, y: 0, z: 0 }), { x: 0, y: 1, z: 0 });
  closeVec(qRotateInv(qz, { x: 0, y: 1, z: 0 }), { x: 1, y: 0, z: 0 });
  const qx = qFromAxisAngle(1, 0, 0, Math.PI / 2);
  const v = { x: 0.3, y: -0.5, z: 0.8 };
  // (qz * qx) v == qz (qx v)
  closeVec(qRotate(qMul(qz, qx), v), qRotate(qz, qRotate(qx, v)));
  // identity
  closeVec(qRotate(qIdentity(), v), v);
});

test('quat: qIntegrate applies body-frame rates on the right and is accurate for constant rates', () => {
  // 90 deg/s about body x for 1 s in 66 Hz steps = 90 deg rotation
  const q = qIdentity();
  const dt = 1 / 66;
  for (let i = 0; i < 66; i += 1) qIntegrate(q, (90 * Math.PI) / 180, 0, 0, dt);
  const rv = qToRotationVector(q);
  close((rv.x * 180) / Math.PI, 90, 1e-6);
  close(rv.y, 0, 1e-9);
  // body-frame composition order: rotate about x, then about the NEW z axis
  const q2 = qIdentity();
  qIntegrate(q2, Math.PI / 2, 0, 0, 1); // 90 deg about x
  qIntegrate(q2, 0, 0, Math.PI / 2, 1); // 90 deg about body z
  const expected = qMul(qFromAxisAngle(1, 0, 0, Math.PI / 2), qFromAxisAngle(0, 0, 1, Math.PI / 2));
  closeVec(qRotate(q2, { x: 1, y: 2, z: 3 }), qRotate(expected, { x: 1, y: 2, z: 3 }), 1e-9);
  // tiny rates do not blow up
  const q3 = qIdentity();
  qIntegrate(q3, 1e-12, 0, 0, 1e-3);
  close(q3.w, 1, 1e-12);
  const n = qNormalize({ w: 0, x: 0, y: 0, z: 0 });
  assert.deepEqual(n, { w: 1, x: 0, y: 0, z: 0 });
});

test('quat: qFromUnitVectors is the shortest rotation, also for parallel and antiparallel vectors', () => {
  const cases = [
    [{ x: 1, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }],
    [vNormalize({ x: 1, y: 2, z: 3 }), vNormalize({ x: -3, y: 0.5, z: 1 })],
    [{ x: 0, y: 0, z: 1 }, { x: 0, y: 0, z: 1 }],
    [{ x: 0, y: 0, z: 1 }, { x: 0, y: 0, z: -1 }],
    [{ x: 1, y: 0, z: 0 }, { x: -1, y: 0, z: 0 }],
    [{ x: 0, y: 1, z: 0 }, { x: 0, y: -1, z: 0 }],
  ];
  for (const [a, b] of cases) {
    const q = qFromUnitVectors(a, b);
    closeVec(qRotate(q, a), b, 1e-9);
    close(Math.hypot(q.w, q.x, q.y, q.z), 1, 1e-12);
  }
  const q = qFromUnitVectors({ x: 1, y: 0, z: 0 }, vNormalize({ x: 1, y: 1, z: 0 }));
  close((2 * Math.acos(q.w) * 180) / Math.PI, 45, 1e-9);
});

test('MOTION_CONFIG is deep-frozen and carries the architecture 6.8 values; mergeConfig overrides deeply', () => {
  const frozen = (o) => Object.isFrozen(o) && Object.values(o).every((v) => v === null || typeof v !== 'object' || frozen(v));
  assert.ok(frozen(MOTION_CONFIG));
  assert.equal(MOTION_CONFIG.fusion.tauS, 1.5);
  assert.equal(MOTION_CONFIG.fusion.trustBandG, 0.15);
  assert.equal(MOTION_CONFIG.fusion.maxTrustDps, 300);
  assert.equal(MOTION_CONFIG.fusion.cutQuietMs, 200);
  assert.deepEqual({ ...MOTION_CONFIG.gyroBias }.blend, 0.25);
  assert.equal(MOTION_CONFIG.tracker.historySize, 384, 'was 128: the ring also holds the interpolated trail samples');
  assert.equal(MOTION_CONFIG.tracker.segmentQueueMax, 1024, 'was 512: several chords per IMU sample');
  assert.equal(MOTION_CONFIG.trackingLostMs, 200);
  assert.equal(MOTION_CONFIG.extrapolateMaxMs, 15);
  assert.equal(MOTION_CONFIG.cut.releaseRatio, 0.65);
  assert.equal(MOTION_CONFIG.cut.safetyCapMousePxPerS, 60000);
  assert.ok(!('zenMul' in MOTION_CONFIG.cut), 'zenMul was removed by A-02');
  assert.deepEqual(MOTION_CONFIG.calibration.scaleCandidates, [1, 0.12288]);
  assert.equal(MOTION_CONFIG.input.pxPerDegBase, 27.4);
  // the sword-tuning round (docs/motion-contract.md 2.8)
  assert.deepEqual([...MOTION_CONFIG.input.sensitivityRange], [0.3, 2.0, 0.1]);
  assert.equal(MOTION_CONFIG.cut.thresholdDefault, 300);
  assert.deepEqual([...MOTION_CONFIG.cut.thresholdRange], [100, 700, 25]);
  assert.equal(MOTION_CONFIG.cut.minDurationMs, 25);
  assert.equal(MOTION_CONFIG.cut.candidateMaxMs, 100);
  assert.equal(MOTION_CONFIG.cut.swingGraceMs, 100);
  assert.equal(MOTION_CONFIG.cut.aimPxPerDps, 10 / 3);
  assert.equal(MOTION_CONFIG.cut.safetyCapDegPerS, 2190);
  const ptr = MOTION_CONFIG.pointer;
  assert.deepEqual([ptr.deadDps, ptr.rampDps, ptr.gLoPxDeg, ptr.gHiPxDeg], [5, 300, 5, 14]);
  assert.deepEqual([ptr.idleDps, ptr.idleBreakDps, ptr.idleHoldS, ptr.quietMs], [8, 14, 1.0, 500]);
  assert.deepEqual([ptr.centreGain, ptr.centreMinPxS, ptr.centreMaxPxS, ptr.centreRampMs, ptr.centreArriveEventPx], [2.5, 120, 800, 300, 40]);
  assert.deepEqual([ptr.maxChordPx, ptr.maxSubSteps, ptr.trailStepMs, ptr.maxTrailSteps, ptr.extrapolateMaxMs], [48, 32, 8, 8, 35]);
  const merged = mergeConfig(MOTION_CONFIG, { fusion: { tauS: 3 }, cut: { thresholdDefault: 1200 } });
  assert.equal(merged.fusion.tauS, 3);
  assert.equal(merged.fusion.trustBandG, 0.15);
  assert.equal(merged.cut.thresholdDefault, 1200);
  assert.equal(merged.cut.releaseRatio, 0.65);
  assert.ok(Object.isFrozen(merged) && Object.isFrozen(merged.fusion));
  assert.equal(MOTION_CONFIG.fusion.tauS, 1.5, 'the base config is untouched');
});
