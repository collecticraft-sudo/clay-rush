// Mount-agnostic calibration wizard (steps 1 to 3 of docs/game-design.md 12.5; step 4, the practice round, is the game's).
// OWNER: motion engineer. Reference algorithm of docs/architecture.md 6.4 with the refinements listed in
// docs/contract-notes.md (all UNVERIFIED-ON-HARDWARE, design HW-7, protocol UOH-6 and UOH-7).
//
//   step 1  sword still, tip up          -> u1 = mean accel direction (unit), gyro bias b = mean gyro
//   trans.  move to pointing at the screen: the gyro (bias removed, sign +1, default scale) is integrated into a vector
//   step 2  sword still, pointing at the screen (>= poseAngleDeg[0..1] away from pose 1) -> u2
//   step 3  point at the centre, confirmCenter() or hold still -> yaw/pitch references (done by the pipeline)
//
//   forward = normalize(u1 - (u1.u2) u2)        tip direction in DEVICE coordinates (gravity runs along the blade in pose 1)
//   up      = normalize(u2 - (u2.forward) forward)
//   right   = forward x up                      right x forward = up (right-handed)
//
// The player never has to say how the Joy-Con is mounted or which side it is: only the two gravity directions matter.
//
// Stillness is measured on the gyro RELATIVE to a reference: in step 1 the running mean of the hold (the bias is not known
// yet; this also makes the rule independent of the disputed gyro scale, which would inflate an offset 8.14 times), in the
// later steps the bias found in step 1. A tilt-stability test on the accelerometer direction catches slow rotations that the
// rate limits alone would let through, and step 1 limits |mean gyro| so a steady spin is not mistaken for a bias.

import { CAL_STEP_FAIL } from '../shared/contracts.js';
import { qIdentity, qIntegrate, qRotateInv } from './quat.js';
import { DEG, RAD, clamp, vAngleDeg, vCos, vCross, vDot, vLen, vNormalize, vScale, vSub } from './vec.js';

/** Tracks one continuous stillness hold and answers "did the sword stay still?" sample by sample. */
class StillHold {
  /** @param {typeof import('./motion-config.js').MOTION_CONFIG.calibration} cfg */
  constructor(cfg) {
    this.cfg = cfg;
    this.reset();
  }

  reset() {
    this.n = 0;
    this.startT = 0;
    this.lastT = 0;
    this.gx = 0;
    this.gy = 0;
    this.gz = 0;
    this.ax = 0;
    this.ay = 0;
    this.az = 0;
    this.sumSpeed = 0;
    this.sumMag = 0;
    this.peak = 0;
    this.lastSpeed = 0;
    this.lastAccelMag = 1;
  }

  /** Mean |a| (g) of the samples of this hold: step 1 keeps it as g0 (round 2 finding M2). */
  meanMag() {
    return this.n > 0 ? this.sumMag / this.n : 1;
  }

  /**
   * Is this reading's |a| acceptable for a hold? The sensor may read 0.94 or 1.06 g at rest (gain and offset are unknown), so the
   * rule is not "1 g +- 5 %" but: inside the plausible band (widened by the noise margin: the MEAN of a step 1 hold must lie in
   * accelG0Range, see CalibrationWizard._passStep), and steady against the hold's own mean.
   */
  _accelOk(amag) {
    const c = this.cfg;
    if (amag < c.accelG0Range[0] - c.stillAccelTolerance || amag > c.accelG0Range[1] + c.stillAccelTolerance) return false;
    if (this.n === 0) return true;
    return Math.abs(amag / (this.sumMag / this.n) - 1) <= c.stillAccelTolerance;
  }

  meanDir() {
    return vNormalize({ x: this.ax, y: this.ay, z: this.az });
  }

  meanGyro() {
    const k = this.n > 0 ? 1 / this.n : 0;
    return { x: this.gx * k, y: this.gy * k, z: this.gz * k };
  }

  meanSpeed() {
    return this.n > 0 ? this.sumSpeed / this.n : 0;
  }

  /**
   * @param {number} t ms
   * @param {{x:number,y:number,z:number}} g raw gyro
   * @param {{x:number,y:number,z:number}} a accel (g)
   * @param {{x:number,y:number,z:number}|null} ref bias to compare against, or null = running mean of this hold
   * @param {number} scale gyro scale used only for the rate limits (true dps = parsed * scale)
   * @returns {null | {reason:string, heldMs:number}} null = still so far; otherwise the hold was reset
   */
  add(t, g, a, ref, scale) {
    const c = this.cfg;
    if (this.n > 0 && t - this.lastT > c.holdGapMs) this.reset(); // a long silence restarts the hold quietly
    const amag = Math.hypot(a.x, a.y, a.z);
    this.lastAccelMag = amag;

    let wx = 0;
    let wy = 0;
    let wz = 0;
    if (ref) {
      wx = (g.x - ref.x) * scale;
      wy = (g.y - ref.y) * scale;
      wz = (g.z - ref.z) * scale;
    } else if (this.n > 0) {
      const inv = 1 / this.n;
      wx = (g.x - this.gx * inv) * scale;
      wy = (g.y - this.gy * inv) * scale;
      wz = (g.z - this.gz * inv) * scale;
    }
    const speed = Math.hypot(wx, wy, wz);
    this.lastSpeed = speed;

    const invA = amag > 1e-9 ? 1 / amag : 0;
    const ux = a.x * invA;
    const uy = a.y * invA;
    const uz = a.z * invA;
    let tilt = 0;
    if (this.n > 0) {
      const mm = Math.hypot(this.ax, this.ay, this.az);
      if (mm > 1e-9) tilt = Math.acos(clamp((ux * this.ax + uy * this.ay + uz * this.az) / mm, -1, 1)) * DEG;
    }

    let reason = null;
    if (speed > c.stillPeakDegPerS || tilt > c.stillTiltDeg) reason = CAL_STEP_FAIL.MOVED;
    else if (!this._accelOk(amag)) reason = CAL_STEP_FAIL.BAD_ACCEL;

    if (!reason) {
      if (this.n === 0) this.startT = t;
      this.n += 1;
      this.lastT = t;
      this.gx += g.x;
      this.gy += g.y;
      this.gz += g.z;
      this.ax += ux;
      this.ay += uy;
      this.az += uz;
      this.sumMag += amag;
      this.sumSpeed += speed;
      if (speed > this.peak) this.peak = speed;
      if (this.n >= c.minHoldSamples) {
        if (this.sumSpeed / this.n >= c.stillMeanDegPerS) reason = CAL_STEP_FAIL.MOVED;
        else if (!ref && (Math.hypot(this.gx, this.gy, this.gz) / this.n) * scale > c.maxStillBiasDps) reason = CAL_STEP_FAIL.MOVED;
      }
    }
    if (reason) {
      const heldMs = this.n > 0 ? this.lastT - this.startT : 0;
      this.reset();
      this.lastAccelMag = amag; // keep the latest readings for the progress events
      this.lastSpeed = speed;
      return { reason, heldMs };
    }
    return null;
  }
}

/**
 * Integrates the gyro between the two still holds. `theta` is the plain sum of body rates (degrees, default scale, sign +1),
 * exactly as the reference algorithm describes; it is exact for a single-axis turn and keeps its linear dependence on the
 * gyro scale, which the scale estimate needs. In parallel a quaternion per (sign, scale candidate) hypothesis is integrated
 * for the gravity-consistency tie-break used when the axis test is ambiguous.
 */
export class TransitionIntegrator {
  /** @param {number} minGapMs an unknown time step is charged as a hole only above this wall-clock distance (round 2 finding M1) */
  constructor(bias, scaleCandidates, minGapMs = 40) {
    this.bias = bias;
    this.minGapMs = minGapMs;
    this.theta = { x: 0, y: 0, z: 0 };
    this.hyps = [];
    for (const sign of [1, -1]) for (const scale of scaleCandidates) this.hyps.push({ sign, scale, q: qIdentity() });
    this.prev = null;
    this.prevT = 0;
    this.gapMs = 0;
  }

  /**
   * @param {{x:number,y:number,z:number}} g raw gyro
   * @param {number|null} dtMs device time step, null = unknown (duplicate stamp, backwards stamp, burst partner, or a hole)
   * @param {number} t sample time (ms, never going backwards): the wall-clock distance to the previous sample tells a hole from
   *   a report that simply carries no usable step. A duplicate or a backwards stamp (distance 0) loses no rotation at all, and a
   *   burst partner (a few ms behind its neighbour) is integrated over that distance. Only a real hole is charged to `gapMs`.
   */
  add(g, dtMs, t) {
    const w = { x: g.x - this.bias.x, y: g.y - this.bias.y, z: g.z - this.bias.z };
    let stepMs = null;
    if (this.prev) {
      if (dtMs !== null && dtMs > 0) {
        stepMs = dtMs;
      } else {
        const dist = t - this.prevT;
        if (dist > this.minGapMs) this.gapMs += dist; // a real hole: rotation was lost and cannot be recovered
        else if (dist > 0) stepMs = dist; // no usable step, but the samples are right behind each other: integrate over the distance
        // dist <= 0: the same instant (duplicate report) or a stamp that went backwards: no time passed, nothing was lost
      }
    }
    if (stepMs !== null) {
      const dt = stepMs / 1000;
      const mx = 0.5 * (this.prev.x + w.x);
      const my = 0.5 * (this.prev.y + w.y);
      const mz = 0.5 * (this.prev.z + w.z);
      this.theta.x += mx * dt;
      this.theta.y += my * dt;
      this.theta.z += mz * dt;
      for (const h of this.hyps) {
        const k = h.sign * h.scale * RAD;
        qIntegrate(h.q, mx * k, my * k, mz * k, dt);
      }
    }
    this.prev = w;
    this.prevT = t;
  }

  snapshot() {
    return {
      theta: { ...this.theta },
      gapMs: this.gapMs,
      hyps: this.hyps.map((h) => ({ sign: h.sign, scale: h.scale, q: { ...h.q } })),
    };
  }
}

/** Sword frame in device coordinates from the two gravity directions (unit vectors). */
export function frameFromPoses(u1, u2) {
  const forward = vNormalize(vSub(u1, vScale(u2, vDot(u1, u2))));
  const up = vNormalize(vSub(u2, vScale(forward, vDot(u2, forward))));
  const right = vCross(forward, up);
  return { right, forward, up };
}

/**
 * Gyro sign and scale from the rotation integrated between the poses (architecture 6.4, protocol 7.4 point 2).
 * Pure function so it can be unit-tested on its own.
 * @returns {{gyroSign:1|-1, gyroScale:number, gyroScaleSource:'default'|'stored'|'estimated', warnings:string[],
 *   events:Array<{code:string, message:string}>, cosAxis:number, ratio:number|null}}
 */
export function estimateGyroModel({ u1, u2, snapshot, override, cfg }) {
  const warnings = [];
  const events = [];
  const angle = vAngleDeg(u1, u2);
  const nExp = vNormalize(vCross(u2, u1)); // = -normalize(u1 x u2); the rotation that carries u2 back onto u1
  const tg = snapshot.theta;
  const tgLen = vLen(tg);
  let sign = 1;
  let signKnown = false;
  let cosAxis = 0;
  let tieScale = null;

  if (snapshot.gapMs > cfg.transitionGapBudgetMs || tgLen < 1e-6 || angle < 1e-6) {
    warnings.push('gyro sign undetermined');
  } else {
    cosAxis = vCos(tg, vScale(nExp, angle));
    if (cosAxis < -cfg.signAcceptCos) {
      sign = -1;
      signKnown = true;
    } else if (cosAxis > cfg.signAcceptCos) {
      sign = 1;
      signKnown = true;
    } else {
      // Ambiguous axis test (a large yaw component in the move): decide by gravity consistency instead. For every
      // hypothesis predict where gravity should point in pose 2 and compare with the measurement.
      let bestPlus = { err: Infinity, scale: 1 };
      let bestMinus = { err: Infinity, scale: 1 };
      for (const h of snapshot.hyps) {
        const err = vAngleDeg(qRotateInv(h.q, u1), u2);
        const slot = h.sign === 1 ? bestPlus : bestMinus;
        if (err < slot.err) {
          slot.err = err;
          slot.scale = h.scale;
        }
      }
      const best = bestPlus.err <= bestMinus.err ? bestPlus : bestMinus;
      const other = best === bestPlus ? bestMinus : bestPlus;
      if (best.err <= cfg.signTieBreakErrDeg && other.err - best.err >= cfg.signTieBreakMarginDeg) {
        sign = best === bestPlus ? 1 : -1;
        signKnown = true;
        tieScale = best.scale;
      } else {
        warnings.push('gyro sign undetermined');
      }
    }
  }
  if (sign === -1) {
    warnings.push('gyro_sign_flipped');
    events.push({ code: 'gyro_sign_flipped', message: 'gyro handedness is mirrored relative to the accelerometer; the sign was flipped' });
  }

  // ---- scale ----
  let scale = 1;
  let source = 'default';
  let ratio = null;
  if (signKnown && angle >= cfg.scaleMinAngleDeg && cosAxis * sign >= cfg.scaleAcceptCos) {
    const proj = sign * vDot(tg, nExp);
    if (proj > 1e-6) ratio = angle / proj;
  }
  if (override != null) {
    scale = override;
    source = 'stored';
    if (ratio !== null && Math.abs(ratio / override - 1) > 0.3) {
      warnings.push('gyro_scale_suspect');
      events.push({ code: 'gyro_scale_suspect', message: `stored gyro scale ${override} disagrees with the measured ${ratio.toFixed(3)}` });
    }
  } else if (ratio !== null) {
    const cand = cfg.scaleCandidates.find((k) => Math.abs(ratio / k - 1) <= cfg.scaleSnapTolerance);
    if (cand !== undefined) {
      scale = cand;
      source = 'estimated';
    } else if (ratio >= 0.05 && ratio <= 2) {
      scale = ratio;
      source = 'estimated';
      warnings.push('gyro_scale_suspect');
      events.push({ code: 'gyro_scale_suspect', message: `measured gyro scale ${ratio.toFixed(3)} matches neither known candidate` });
    } else {
      warnings.push('gyro_scale_suspect');
      events.push({ code: 'gyro_scale_suspect', message: `measured gyro scale ${ratio.toFixed(3)} is out of range; using the default` });
    }
  } else if (tieScale !== null && tieScale !== 1) {
    scale = tieScale;
    source = 'estimated';
  }
  return { gyroSign: sign, gyroScale: scale, gyroScaleSource: source, warnings, events, cosAxis, ratio };
}

export class CalibrationWizard {
  /**
   * @param {{
   *   cfg: typeof import('./motion-config.js').MOTION_CONFIG.calibration,
   *   emit: (evt:object) => void,
   *   applyParams: (result:object) => void,      called when step 2 passes: the pipeline switches to the new parameters
   *   onWarning: (code:string, message:string, t:number) => void,
   * }} deps
   */
  constructor({ cfg, emit, applyParams, onWarning }) {
    this.cfg = cfg;
    this.emit = emit;
    this.applyParams = applyParams;
    this.onWarning = onWarning;
    this.hold = new StillHold(cfg);
    this.active = false;
    this.step = null;
    this.quick = false;
    this.result = null;
    this.centreRequested = false;
    this.override = null;
    this.side = '?';
    this.bias = { x: 0, y: 0, z: 0 };
    this.rateScale = 1;
    this.integ = null;
    this.s1 = null;
    this.snapshot = null;
    this.lastImuT = 0;
    this.stepStartT = 0;
    this.lastProgressT = -Infinity;
    this.lastFailT = -Infinity;
    this.lastNoDataT = -Infinity;
    this.everHeld = false;
    this.lastInstSpeed = 0;
    this.badAccelSince = null;
    this.gate = null; // step 1 after a failure: the direction of the pose to move away from before a hold counts
    this.lastDir = null; // newest accel direction seen by feed()
  }

  /**
   * Start (or restart) the full wizard at step 1.
   * `adoptTime` = the caller has no clock and no sample yet, so `t` is a placeholder: the wizard takes its time origin from
   * the first sample or poll() instead (otherwise a real-clock poll() would time the step out at once).
   */
  start(t, { side = '?', scaleOverride = null, adoptTime = false } = {}) {
    this.active = true;
    this.quick = false;
    this.result = null;
    this.centreRequested = false;
    this.override = scaleOverride;
    if (side && side !== '?') this.side = side;
    this.rateScale = scaleOverride ?? 1;
    this.bias = { x: 0, y: 0, z: 0 };
    this.integ = null;
    this.s1 = null;
    this.snapshot = null;
    this.lastImuT = t;
    this.lastNoDataT = -Infinity;
    this._enterStep(1, t);
    if (adoptTime) this._adoptTimeOrigin();
    this.emit({ type: 'started', t, quick: false });
  }

  _adoptTimeOrigin() {
    this.stepStartT = null;
    this.lastImuT = null;
  }

  /** Step 3 only, with the calibration's own bias and scale as references. */
  startQuick(t, { bias, scale, adoptTime = false }) {
    this.active = true;
    this.quick = true;
    this.result = null;
    this.centreRequested = false;
    this.bias = { ...bias };
    this.rateScale = scale;
    this.lastImuT = t;
    this.lastNoDataT = -Infinity;
    this._enterStep(3, t);
    if (adoptTime) this._adoptTimeOrigin();
    this.emit({ type: 'started', t, quick: true });
  }

  cancel(t) {
    if (!this.active) return false;
    this.active = false;
    this.step = null;
    this.centreRequested = false;
    this.emit({ type: 'cancelled', t });
    return true;
  }

  /** The pipeline calls this after it built the final Calibration. */
  finish() {
    this.active = false;
    this.step = null;
    this.centreRequested = false;
  }

  takeCentreRequest() {
    const r = this.centreRequested;
    this.centreRequested = false;
    return r;
  }

  _holdSeconds() {
    const h = this.cfg.holdS;
    if (this.step === 1) return h.pose1;
    if (this.step === 2) return h.pose2;
    return this.quick ? h.quickCentre : h.autoCentreS;
  }

  /**
   * @param {number} step
   * @param {number} t
   * @param {{x:number,y:number,z:number}|null} [gateDir] step 1 only: after a failed attempt the sword is still in the pose
   *   that failed; its hold must not pass as "pose 1" (it would capture the wrong gravity direction), so the sword has to
   *   tilt at least poseGateDeg away from that pose first
   */
  _enterStep(step, t, gateDir = null) {
    this.step = step;
    this.stepStartT = t;
    this.hold.reset();
    this.everHeld = false;
    this.lastProgressT = -Infinity;
    this.lastFailT = -Infinity;
    this.centreRequested = false;
    this.badAccelSince = null;
    this.gate = step === 1 ? gateDir : null;
  }

  _fail(t, reason) {
    this.emit({ type: 'stepFailed', t, step: this.step, reason });
    this.lastFailT = t;
  }

  _progress(t, phase) {
    if (t - this.lastProgressT < 1000 / this.cfg.progressHz) return;
    this.lastProgressT = t;
    const holding = this.hold.n > 0;
    const need = this._holdSeconds() * 1000;
    this.emit({
      type: 'progress',
      t,
      step: this.step,
      phase,
      progress: holding ? clamp((t - this.hold.startT) / need, 0, 1) : 0,
      meanDps: holding ? this.hold.meanSpeed() : this.lastInstSpeed,
      peakDps: this.hold.peak,
      accelMagG: this.hold.lastAccelMag,
    });
  }

  _phase() {
    if (this.hold.n > 0) return 'holding';
    return this.step === 2 && !this.everHeld ? 'transition' : 'waiting';
  }

  /** A step wait ran out: announce it and restart (step 2 needs pose 1 again, so it goes back to step 1). */
  _timeout(t) {
    this._fail(t, CAL_STEP_FAIL.TIMEOUT);
    if (this.step === 2) this._enterStep(1, t, this.lastDir);
    else this._enterStep(this.step, t);
  }

  /** @param {import('../shared/contracts.js').ImuSample} s */
  feed(s, t, dtMs) {
    if (!this.active) return;
    const c = this.cfg;
    if (this.stepStartT === null) this.stepStartT = t;
    this.lastImuT = t;
    if (s.side && s.side !== '?') this.side = s.side;
    if (t - this.stepStartT > c.waitTimeoutS * 1000) {
      this._timeout(t);
      return;
    }
    const g = s.gyro;
    const a = s.accel;
    this.lastDir = vNormalize(a);
    if (this.step === 2 && this.integ) this.integ.add(g, dtMs, t);

    if (this.gate) {
      if (vAngleDeg(this.lastDir, this.gate) < c.poseGateDeg) {
        this.hold.reset();
        this._progress(t, this._phase());
        return;
      }
      this.gate = null;
    }
    if (this.step === 2) {
      // Only count a hold once the sword tilted away from pose 1 (otherwise "still at pose 1" would fail as bad_pose).
      if (vAngleDeg(vNormalize(a), this.s1.u1) < c.poseGateDeg) {
        this.hold.reset();
        this._progress(t, this._phase());
        return;
      }
    }

    const ref = this.step === 1 ? null : this.bias;
    const failure = this.hold.add(t, g, a, ref, this.rateScale);
    this.lastInstSpeed = this.hold.lastSpeed;
    if (failure) {
      // A hold that lasted a while and broke is announced. A sensor whose |a| stays off 1 g (no hold ever forms) is
      // announced as bad_accel after a second of it, so the player is not left staring at a ring that never fills.
      if (failure.reason === CAL_STEP_FAIL.BAD_ACCEL) {
        if (this.badAccelSince === null) this.badAccelSince = t;
      } else {
        this.badAccelSince = null;
      }
      const persistentBadAccel = this.badAccelSince !== null && t - this.badAccelSince >= c.noDataMs;
      if ((failure.heldMs >= c.minFailHoldS * 1000 || persistentBadAccel) && t - this.lastFailT >= c.failRepeatMs) {
        this._fail(t, failure.reason);
      }
      this._progress(t, this._phase());
      return;
    }
    // only an established hold ends the "magnitude is off" streak: a reading on the edge of the band alternates between accepted and
    // refused samples and must still be announced after a second
    if (this.hold.n >= c.minHoldSamples) this.badAccelSince = null;
    if (this.hold.n === 1 && this.step === 2 && this.integ) this.snapshot = this.integ.snapshot();
    if (this.hold.n > 0) this.everHeld = true;
    this._progress(t, this._phase());

    if (this.hold.n >= c.minHoldSamples && t - this.hold.startT >= this._holdSeconds() * 1000) this._passStep(t);
  }

  _passStep(t) {
    const c = this.cfg;
    if (this.step === 1) {
      const g0 = this.hold.meanMag();
      if (g0 < c.accelG0Range[0] || g0 > c.accelG0Range[1]) {
        // a steady reading, but not a gravity the game can work with: announce it like any other bad_accel and start the hold over
        if (t - this.lastFailT >= c.failRepeatMs) this._fail(t, CAL_STEP_FAIL.BAD_ACCEL);
        this.hold.reset();
        return;
      }
      this.s1 = { u1: this.hold.meanDir(), bias: this.hold.meanGyro(), peak: this.hold.peak, g0 };
      this.bias = { ...this.s1.bias };
      this.integ = new TransitionIntegrator(this.bias, c.scaleCandidates, c.transitionGapMinMs);
      if (this.s1.g0 < c.accelG0WarnRange[0] || this.s1.g0 > c.accelG0WarnRange[1]) {
        this.onWarning('accel_gain_off', `the accelerometer reads ${this.s1.g0.toFixed(3)} g at rest; the game divides every reading by it (UNVERIFIED-ON-HARDWARE, UOH-3)`, t);
      }
      this.emit({ type: 'stepPassed', t, step: 1 });
      this._enterStep(2, t);
      return;
    }
    if (this.step === 2) {
      const u2 = this.hold.meanDir();
      const angle = vAngleDeg(this.s1.u1, u2);
      if (angle < c.poseAngleDeg[0] || angle > c.poseAngleDeg[1]) {
        this._fail(t, CAL_STEP_FAIL.BAD_POSE);
        this._enterStep(1, t, u2);
        return;
      }
      const frame = frameFromPoses(this.s1.u1, u2);
      const model = estimateGyroModel({
        u1: this.s1.u1,
        u2,
        snapshot: this.snapshot ?? this.integ.snapshot(),
        override: this.override,
        cfg: c,
      });
      for (const e of model.events) this.onWarning(e.code, e.message, t);
      const warnings = [...model.warnings];
      if (this.s1.g0 < c.accelG0WarnRange[0] || this.s1.g0 > c.accelG0WarnRange[1]) warnings.push('accel_gain_off');
      this.result = {
        version: 1,
        side: this.side,
        frame,
        gyroBiasDps: { ...this.s1.bias },
        gyroSign: model.gyroSign,
        gyroScale: model.gyroScale,
        gyroScaleSource: model.gyroScaleSource,
        accelG0: this.s1.g0,
        quality: { poseAngleDeg: angle, stillPeakDps: Math.max(this.s1.peak, this.hold.peak), warnings },
      };
      this.bias = { ...this.s1.bias };
      this.rateScale = model.gyroScale;
      this.emit({ type: 'stepPassed', t, step: 2 });
      this.applyParams(this.result);
      this._enterStep(3, t);
      return;
    }
    // step 3 satisfied by stillness: the pipeline finishes after this sample updated the filter
    this.centreRequested = true;
  }

  /** Step 3 still-detection reports here through poll() as well: no-data and timeout watchdogs. */
  poll(now) {
    if (!this.active) return;
    const c = this.cfg;
    if (this.stepStartT === null) this.stepStartT = now;
    if (this.lastImuT === null) this.lastImuT = now;
    if (now - this.lastImuT > c.noDataMs && now - this.lastNoDataT >= c.failRepeatMs) {
      this.lastNoDataT = now;
      this.hold.reset();
      this._fail(now, CAL_STEP_FAIL.NO_DATA);
    }
    if (now - this.stepStartT > c.waitTimeoutS * 1000) {
      this._timeout(now);
      return;
    }
    this._progress(now, this._phase());
  }
}
