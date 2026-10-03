// Motion pipeline: ImuSample / AimSample -> BladeSample / BladeSegment. OWNER: motion engineer.
// Contract: docs/architecture.md section 6 and the MotionPipeline typedef in shared/contracts.js. Pure module (rule 5): no DOM,
// no timers, no wall-clock time except Date.now() to stamp Calibration.createdAt. Synchronous: pushImu returns after emitting
// the 'blade' event.
//
// Per IMU sample:
//   1. calibration wizard (when running) sees the raw sample first, so a step-2 pass can switch the filter parameters
//   2. orientation filter: gyro (bias, sign and scale corrected, trapezoid rule, sliced over gaps) + gravity correction with
//      a trust weight that is zero while cutting (the swing contaminates gravity) and tapers with |a| and angular speed
//   3. online gyro bias estimate while the sword rests
//   4. position, by one of two pointer models (docs/motion-contract.md section 1, `pointerModel`):
//        'relative' (default, every real Joy-Con): the cursor moves like a mouse by gain(tip speed) x tip velocity in the local
//                   frame of the sword (pointer.js): dead zone, acceleration curve, idle soft auto-centre. No absolute orientation.
//        'absolute' (the simulator, a mouse in disguise): aim angles of the blade axis -> playfield position (aim.js: references,
//                   auto centring, edge slip, recentre ease)
//   5. cut decision and segments: relative = angular tip speed in deg/s with hysteresis, a minimum duration and a retroactive first
//      chord (angular-tracker.js), chords of at most about 48 px between two samples, interpolated trail samples every 8 ms;
//      absolute and aim path = the px/s tracker (blade-tracker.js), threshold T x 10/3.   -> BladeSample -> 'blade' event, segment
//      queue, history ring
//
// Clay Rush additions (docs/architecture.md 4.2): the setting `aimCurve` ('precise' | 'balanced' | 'fast', MOTION_CONFIG.aimCurves) picks
// the gains of the relative pointer; an aim history (its own ring of every emitted sample, real and interpolated, at least 1 s deep)
// serves aimAt(t) (the pointer at the press time of a shot, interpolated, never extrapolated) and shotDiagnostics(tPress, compMs) (the
// trigger jerk). The blade/cut machinery below is unchanged and still runs (C-09: nothing consumes its segments any more).
//
// UNVERIFIED-ON-HARDWARE: everything that depends on the real Joy-Con 2 (sample rate 33 to 67 Hz, gyro scale and sign, drift,
// noise, latency) is modelled from docs/joycon2-protocol.md and design section 17 (HW-1, HW-2, HW-3, HW-7, HW-9, HW-10;
// UOH-4, UOH-6, UOH-7). Tests prove the maths against synthetic sensors, never the physical device.

import { Emitter } from '../shared/emitter.js';
import { FIELD } from '../shared/playfield.js';
import { validateCalibration } from '../shared/validate.js';
import { MOTION_WARNING } from '../shared/contracts.js';
import { MOTION_CONFIG, mergeConfig } from './motion-config.js';
import { OrientationFilter, BiasEstimator, accelTrustWeight } from './fusion.js';
import { AimMapper } from './aim.js';
import { BladeTracker } from './blade-tracker.js';
import { AngularCutTracker } from './angular-tracker.js';
import { RelativePointer, tipVelocity, pointerSpeedPxS, gravityPitchRate, verticalGainPxPerDeg, planChords, planTrail, extrapolateHead, smoothstep } from './pointer.js';
import { CalibrationWizard } from './calibration.js';
import { RAD, clamp } from './vec.js';

const IDENTITY_FRAME = Object.freeze({
  right: Object.freeze({ x: 1, y: 0, z: 0 }),
  forward: Object.freeze({ x: 0, y: 1, z: 0 }),
  up: Object.freeze({ x: 0, y: 0, z: 1 }),
});

const cloneVec = (v) => ({ x: v.x, y: v.y, z: v.z });

// flags of an aim history entry
const SHOT_OK = 1; // trackingOk
const SHOT_DISC = 2; // discontinuity: the path jumped AT this entry, never interpolate into it
const SHOT_AIM = 4; // an aim (mouse) sample: the position holds until the next entry
const SHOT_REAL_IMU = 8; // a real (not interpolated) IMU sample
const cloneFrame = (f) => ({ right: cloneVec(f.right), forward: cloneVec(f.forward), up: cloneVec(f.up) });
const isFiniteVec = (v) => Number.isFinite(v.x + v.y + v.z);

/** Active gyro/frame parameters used by the filter (bias is mutated in place by the online estimator). */
function paramsFromCalibration(cal) {
  return { bias: cloneVec(cal.gyroBiasDps), sign: cal.gyroSign, scale: cal.gyroScale, g0: cal.accelG0 ?? 1, frame: cloneFrame(cal.frame) };
}

class MotionPipelineImpl {
  constructor(opts = {}) {
    this.cfg = mergeConfig(MOTION_CONFIG, opts.config);
    this.clock = opts.clock ?? null;
    this.gyroScaleOverride = Number.isFinite(opts.gyroScaleOverride) && opts.gyroScaleOverride > 0 ? opts.gyroScaleOverride : null;
    // +1: the accelerometer reads +1 g towards UP at rest (the specific force, the convention the whole pipeline is written for).
    // -1: the sensor reports the gravity vector instead (pointing down), so every reading is negated on entry. Which one a real
    // Joy-Con 2 does is UNVERIFIED-ON-HARDWARE (protocol audit F3); the diagnostics page measures it, ?accelsign=-1 applies it.
    this.accelSign = opts.accelSign === -1 ? -1 : 1;
    // 'relative': real sensors (default); 'absolute': the simulator. Chosen per provider by the host, like the accelerometer sign.
    this.pointerModel = opts.pointerModel === 'absolute' ? 'absolute' : 'relative';
    this.em = new Emitter();

    this.settings = {
      sensitivity: this.cfg.input.sensitivityDefault,
      cutThreshold: this.cfg.cut.thresholdDefault,
      cutMul: 1,
      autoCenter: true,
      flipX: false,
      aimCurve: this.cfg.aimCurveDefault,
    };
    this.curveCfg = this.cfg.pointer; // the `pointer` block with the gains of the selected aimCurve (see _applyAimCurve)
    this._applyAimCurve();
    // aim history for aimAt / shotDiagnostics (Clay Rush): parallel typed arrays, a ring of shot.historySize entries
    this.shotSize = this.cfg.shot.historySize;
    this.shotT = new Float64Array(this.shotSize);
    this.shotX = new Float64Array(this.shotSize);
    this.shotY = new Float64Array(this.shotSize);
    this.shotW = new Float64Array(this.shotSize); // angular speed of a real IMU sample (deg/s), the deg/s-equivalent speed of an aim sample, NaN for interpolated
    this.shotF = new Uint8Array(this.shotSize); // SHOT_OK | SHOT_DISC | SHOT_AIM
    this.shotHead = 0;
    this.shotCount = 0;
    if (opts.settings) this.setSettings(opts.settings);

    this.filter = new OrientationFilter(this.cfg.fusion.tauS, {
      bootS: this.cfg.fusion.bootS,
      bootTauS: this.cfg.fusion.bootTauS,
      confirmTrust: this.cfg.fusion.gravityConfirmTrust,
      confirmTiltDeg: this.cfg.fusion.gravityConfirmTiltDeg,
    });
    this._applyFilterModel();
    this.biasEst = new BiasEstimator(this.cfg.gyroBias);
    this.tracker = new BladeTracker(this.cfg.cut, { windowCapacity: 64 }); // px/s tracker: aim path and absolute model
    this.aim = new AimMapper(this.cfg.input, (kind, t) => this.em.emit('recenter', { t, kind }));
    this.cutter = new AngularCutTracker(this.cfg.cut); // deg/s tracker: relative model
    this.rel = new RelativePointer(this.cfg.pointer, (kind, t) => this.em.emit('recenter', { t, kind }));
    this.wizard = new CalibrationWizard({
      cfg: this.cfg.calibration,
      emit: (evt) => this.em.emit('calibration', evt),
      applyParams: (result) => this._applyWizardParams(result),
      onWarning: (code, message, t) => this._warn(code, message, t),
    });

    this.cal = null; // final Calibration, or null
    this.params = this._defaultParams();
    this.savedParams = null; // parameters to restore when a recalibration is cancelled after step 2
    this.paramsSwitched = false;
    this.side = '?';

    // history ring of emitted BladeSamples
    this.ringSize = this.cfg.tracker.historySize;
    this.ring = new Array(this.ringSize);
    this.ringHead = 0; // index of the next write
    this.ringCount = 0;
    this.segQueue = [];

    this._clearStreamState();

    this.lastWarn = Object.create(null);
    this.emaDt = null;
    this.rateCount = 0;
    this.lowSince = null;
    this.accelTrust = 0;

    this._trIn = { t: 0, x: 0, y: 0, discontinuity: false, dtMs: null, capPxPerS: 0 };
    this._aNorm = { x: 0, y: 0, z: 1 }; // the accelerometer reading divided by g0
    this._mapOut = { x: FIELD.cx, y: FIELD.cy, discontinuity: false, refsMoved: false, yawDeg: 0, pitchDeg: 0 };
    this.rawAim = { yawDeg: 0, pitchDeg: 0 };
    this.pw = { x: 0, y: 0, z: 0 }; // previous corrected angular rate, rad/s
    this._w = { x: 0, y: 0, z: 0 }; // bias, sign and scale corrected angular rate, deg/s (relative model)
    this._tip = { s: 0, vR: 0, vU: 0 };

    // the public object handed to callers: plain functions, safe to destructure
    this.api = {
      pushImu: (s) => this.pushImu(s),
      pushAim: (s) => this.pushAim(s),
      poll: (now) => this.poll(now),
      setSettings: (patch) => this.setSettings(patch),
      getSettings: () => ({ ...this.settings }),
      setCalibration: (cal) => this.setCalibration(cal),
      getCalibration: () => this.getCalibration(),
      startCalibration: (o) => this.startCalibration(o),
      cancelCalibration: () => this.cancelCalibration(),
      confirmCenter: () => this.confirmCenter(),
      beginQuickRecenter: () => this.beginQuickRecenter(),
      recenter: (kind) => this.recenter(kind),
      markDiscontinuity: (reason) => this.markDiscontinuity(reason),
      setAccelSign: (sign) => this.setAccelSign(sign),
      setGyroScaleOverride: (scale) => this.setGyroScaleOverride(scale),
      reanchor: (x, y) => this.reanchor(x, y),
      setPointerModel: (model) => this.setPointerModel(model),
      getPointerModel: () => this.pointerModel,
      drainSegments: () => this.drainSegments(),
      recent: (windowMs) => this.recent(windowMs),
      latest: () => this.lastBlade,
      headAt: (now) => this.headAt(now),
      aimAt: (t) => this.aimAt(t),
      shotDiagnostics: (tPress, compMs) => this.shotDiagnostics(tPress, compMs),
      getState: () => this.getState(),
      getDebug: () => this.getDebug(),
      reset: () => this.reset(),
      on: (type, fn) => this.em.on(type, fn),
      off: (type, fn) => this.em.off(type, fn),
    };
  }

  // ------------------------------------------------------------------ small helpers

  _defaultParams() {
    return { bias: { x: 0, y: 0, z: 0 }, sign: 1, scale: this.gyroScaleOverride ?? 1, g0: 1, frame: cloneFrame(IDENTITY_FRAME) };
  }

  _clearStreamState() {
    this.lastBlade = null;
    this.lastSource = null; // 'imu' | 'aim'
    this.lastT = 0; // newest sample time of either kind
    this.lastImuT = 0;
    this.haveImu = false;
    this.haveAim = false; // rawAim holds a valid orientation
    this.havePw = false;
    this.nextDiscontinuity = false;
    this.pendingRecenter = null;
    this.pendingAnchor = null; // {x, y}: reanchor() waiting for the next IMU sample
    this.trackingOk = false;
    this.refDriven = false; // the newest IMU sample's position came (partly) from the references moving, not from the sword (R2-01)
    this.refJump = false; // a re-reference (recentre after a hole, end of the wizard) is applied on the sample being processed
    // relative model: what the sample being processed still has to do, the recentre ease, the last delivered chord, head extrapolation
    this.pendingPlace = null; // {x, y}: the cursor is put there at the next IMU sample (reanchor, end of the calibration)
    this.ease = { active: false, startT: 0, fromX: FIELD.cx, fromY: FIELD.cy };
    this.segAnchor = null; // start of the material of the current cut run that is not yet delivered (= the end of the last delivered chord)
    this.ignoredSince = false; // a sample above the safety cap was ignored since the last accepted one
    this.head = { valid: false, vx: 0, vy: 0, ax: 0, ay: 0 }; // velocity and acceleration of the newest real relative sample
    this.tipSpeedDps = 0;
    this.pitchRateDps = null; // elevation rate of the blade in the gravity frame, deg/s; null = the local vertical rate was used
    this.curVx = 0;
    this.curVy = 0;
    this.aimIdleEmitted = false;
    this.lastEmitT = -Infinity;
    this.angularSpeedDps = 0;
    this.ringHead = 0;
    this.ringCount = 0;
    this.segQueue = [];
    this.shotHead = 0;
    this.shotCount = 0;
    this.shotOpenT = -Infinity; // time at which the newest aim history entry was opened
  }

  /** Clock time for calls that carry none (recenter, startCalibration, ...). */
  _now() {
    return this.clock ? this.clock.now() : this.lastT;
  }

  _blocked() {
    return this.wizard.active && !this.wizard.quick;
  }

  _warn(code, message, t) {
    const last = this.lastWarn[code];
    if (last !== undefined && t - last < this.cfg.warningIntervalMs) return;
    this.lastWarn[code] = t;
    this.em.emit('warning', { t, code, message });
  }

  _imuSwingId() {
    return this.pointerModel === 'relative' ? this.cutter.swingId : this.tracker.swingId;
  }

  _ringAt(i) {
    // i = 0 newest
    if (i < 0 || i >= this.ringCount) return null;
    return this.ring[(this.ringHead - 1 - i + this.ringSize * 2) % this.ringSize];
  }

  _ringPush(sample) {
    this.ring[this.ringHead] = sample;
    this.ringHead = (this.ringHead + 1) % this.ringSize;
    if (this.ringCount < this.ringSize) this.ringCount += 1;
    this._shotPush(sample);
  }

  /**
   * Aim history entry for every sample that enters the trail ring (real and interpolated, chronological). Entries are opened at least
   * shot.minSpacingMs apart: a sample less than that after the moment the newest entry was OPENED replaces its content (the newer
   * position wins, the error is under minSpacingMs of motion), so the ring spans at least historySize x minSpacingMs whatever the input
   * rate. A replaced entry keeps the discontinuity flag of the one it replaces (the jump stays visible).
   */
  _shotPush(s) {
    const n = this.shotSize;
    let i = this.shotHead;
    let carry = 0;
    const realImu = s.source !== 'aim' && !s.interpolated;
    if (this.shotCount > 0 && s.t - this.shotOpenT < this.cfg.shot.minSpacingMs) {
      i = (i - 1 + n) % n;
      // review I-02: a real IMU sample is never overwritten by a later IMU sample at (almost) the same time (the two reports of a burst
      // under the arrival-time fallback share one t): the first measurement is kept, unless the newer one is a jump (discontinuity)
      if (this.shotF[i] & SHOT_REAL_IMU && s.source !== 'aim' && !s.discontinuity) return;
      // otherwise overwrite the newest entry
      carry = this.shotF[i] & SHOT_DISC;
      this.shotCount -= 1;
    } else {
      this.shotOpenT = s.t;
    }
    this.shotT[i] = s.t;
    this.shotX[i] = s.x;
    this.shotY[i] = s.y;
    this.shotW[i] = s.interpolated ? NaN : s.source === 'aim' ? (s.speedDps ?? 0) : (s.angularSpeedDps ?? s.speedDps ?? 0);
    this.shotF[i] = (s.trackingOk ? SHOT_OK : 0) | (s.discontinuity ? SHOT_DISC : 0) | carry | (s.source === 'aim' ? SHOT_AIM : 0) | (realImu ? SHOT_REAL_IMU : 0);
    this.shotHead = (i + 1) % n;
    if (this.shotCount < n) this.shotCount += 1;
  }

  /** Ring index of the k-th oldest aim history entry (k = 0 oldest). */
  _shotIdx(k) {
    return (this.shotHead - this.shotCount + k + this.shotSize * 2) % this.shotSize;
  }

  /** Index k (0 = oldest) of the newest entry with t <= tMs, or -1. Binary search: entries are chronological. */
  _shotFind(tMs) {
    let lo = 0;
    let hi = this.shotCount - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.shotT[this._shotIdx(mid)] <= tMs) {
        found = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return found;
  }

  // ------------------------------------------------------------------ settings and calibration API

  setSettings(patch) {
    if (!patch || typeof patch !== 'object') return;
    const s = this.settings;
    const range = this.cfg.input.sensitivityRange;
    const tr = this.cfg.cut.thresholdRange;
    if (Number.isFinite(patch.sensitivity)) {
      const v = clamp(patch.sensitivity, range[0], range[1]);
      // absolute model: the cursor jumps when the scale changes; relative model: the next sample simply moves by the new curve
      if (v !== s.sensitivity && this.pointerModel === 'absolute') this.nextDiscontinuity = true;
      s.sensitivity = v;
    }
    if (Number.isFinite(patch.cutThreshold)) s.cutThreshold = clamp(patch.cutThreshold, tr[0], tr[1]);
    if (Number.isFinite(patch.cutMul)) s.cutMul = clamp(patch.cutMul, 0.1, 3);
    if (typeof patch.autoCenter === 'boolean') s.autoCenter = patch.autoCenter;
    if (typeof patch.flipX === 'boolean') {
      if (patch.flipX !== s.flipX && this.pointerModel === 'absolute') this.nextDiscontinuity = true;
      s.flipX = patch.flipX;
    }
    if (typeof patch.aimCurve === 'string' && Object.prototype.hasOwnProperty.call(this.cfg.aimCurves, patch.aimCurve)) {
      // relative model: like a sensitivity change, the next sample simply moves by the new curve (the absolute model ignores it)
      s.aimCurve = patch.aimCurve;
      this._applyAimCurve();
    }
  }

  /**
   * The pointer block the relative model reads its gains from: `pointer` with the gains of the selected preset (all three, 'balanced'
   * included; `pointer` and `aimCurves.balanced` are kept equal and a test pins it).
   */
  _applyAimCurve() {
    // every preset, 'balanced' included (review I-04: editing aimCurves.balanced must take effect)
    const preset = this.cfg.aimCurves[this.settings.aimCurve];
    this.curveCfg = preset ? Object.freeze({ ...this.cfg.pointer, ...preset }) : this.cfg.pointer;
  }

  /**
   * Select the pointer model: 'relative' (real sensors, the default) or 'absolute' (the simulator). Like setAccelSign it is meant to
   * be called when the provider changes, BEFORE reset() and setCalibration(null); it does not reset anything itself. Unknown
   * values are ignored.
   * @param {'relative'|'absolute'} model
   */
  setPointerModel(model) {
    if (model === 'relative' || model === 'absolute') this.pointerModel = model;
    this._applyFilterModel();
  }

  /**
   * The faster correction of an unconfirmed tilt (fusion.unconfirmedTauS, round F1) serves the vertical axis of the RELATIVE model only:
   * the absolute model (the simulator) keeps the time constant schedule of before, sample for sample.
   */
  _applyFilterModel() {
    this.filter.unconfirmedTauS = this.pointerModel === 'relative' ? this.cfg.fusion.unconfirmedTauS : this.cfg.fusion.tauS;
  }

  setCalibration(cal) {
    if (this.wizard.active) this.cancelCalibration();
    if (cal === null || cal === undefined) {
      this.cal = null;
      this.params = this._defaultParams();
    } else {
      const errs = validateCalibration(cal);
      if (errs.length) throw new TypeError(`setCalibration: invalid Calibration:\n  - ${errs.join('\n  - ')}`);
      this.cal = { ...cal, frame: cloneFrame(cal.frame), gyroBiasDps: cloneVec(cal.gyroBiasDps), quality: { ...cal.quality, warnings: [...(cal.quality.warnings ?? [])] } };
      this.params = paramsFromCalibration(cal);
      if (cal.side && cal.side !== '?') this.side = cal.side;
    }
    this.savedParams = null;
    this.paramsSwitched = false;
    // A new frame starts a new filter: orientation, references and tracker restart from the next sample.
    this.filter.reset();
    this.biasEst.reset();
    this.aim.reset();
    this.tracker.reset();
    this._resetRelative();
    this.haveAim = false;
    this.havePw = false;
    this.trackingOk = false;
    this.nextDiscontinuity = true;
    this.pendingRecenter = null;
    this.pendingAnchor = null;
  }

  /** Relative model: cursor to the centre, velocity memory, idle state, ease, cut state and pending placement cleared. */
  _resetRelative() {
    this.rel.reset();
    this.cutter.reset();
    this.ease.active = false;
    this.pendingPlace = null;
    this.segAnchor = null;
    this.ignoredSince = false;
    this.head.valid = false;
  }

  getCalibration() {
    if (!this.cal) return null;
    return {
      ...this.cal,
      frame: cloneFrame(this.params.frame),
      gyroBiasDps: cloneVec(this.params.bias), // the online estimate, not the value found by the wizard
      quality: { ...this.cal.quality, warnings: [...(this.cal.quality.warnings ?? [])] },
    };
  }

  startCalibration(opts = {}) {
    this.wizard.start(this._now(), { side: opts.side ?? this.side, scaleOverride: this.gyroScaleOverride, adoptTime: !this.clock && !this.haveImu });
    this.trackingOk = false;
    if (this.pointerModel === 'relative') {
      // contract 2.7: the cursor goes to the centre, the velocity memory is cleared and the next sample (after the wizard) is a discontinuity
      this.rel.reset();
      this.cutter.dropCutting(this._now());
      this.ease.active = false;
      this.segAnchor = null;
      this.pendingPlace = null;
      this.head.valid = false;
      this.nextDiscontinuity = true;
    }
  }

  cancelCalibration() {
    const t = this._now();
    if (!this.wizard.cancel(t)) return;
    if (this.paramsSwitched) {
      // step 2 had already replaced the parameters: put the previous ones back and start the filter over
      this.params = this.savedParams ?? this._defaultParams();
      this.filter.reset();
      this.aim.reset();
      this.rel.clearMotion(); // the velocity memory was measured with the parameters that are gone
      this.haveAim = false;
      this.havePw = false;
      this.nextDiscontinuity = true;
    }
    this.savedParams = null;
    this.paramsSwitched = false;
  }

  beginQuickRecenter() {
    const t = this._now();
    if (!this.cal) {
      this.em.emit('calibration', { type: 'stepFailed', t, step: 3, reason: 'no_calibration' });
      return;
    }
    this.wizard.startQuick(t, { bias: this.params.bias, scale: this.params.scale, adoptTime: !this.clock && !this.haveImu });
  }

  confirmCenter() {
    if (this.wizard.active && this.wizard.step === 3 && this.filter.ready && this.haveAim) this._finishCalibration(this._now());
  }

  _applyWizardParams(result) {
    if (this.cal && !this.savedParams) this.savedParams = this.params;
    this.params = { bias: cloneVec(result.gyroBiasDps), sign: result.gyroSign, scale: result.gyroScale, g0: result.accelG0 ?? 1, frame: cloneFrame(result.frame) };
    this.paramsSwitched = true;
    this.filter.reset(); // re-initialised from the current accel by the fusion step of the same sample
    this.aim.reset();
    this.rel.clearMotion();
    this.biasEst.reset();
    this.haveAim = false;
    this.havePw = false;
  }

  /** Step 3 satisfied (by stillness or confirmCenter): the current aim becomes the centre. */
  _finishCalibration(t) {
    const w = this.wizard;
    const quick = w.quick;
    // the current aim becomes the centre: absolute model = the references, relative model = the cursor itself (there are no references)
    if (this.pointerModel === 'absolute') {
      this.aim.setRefs(this.rawAim.yawDeg, this.rawAim.pitchDeg);
    } else {
      this.rel.setPosition(FIELD.cx, FIELD.cy);
      this.rel.clearMotion();
      this.ease.active = false;
      this.segAnchor = null;
    }
    if (!quick && w.result) {
      const r = w.result;
      this.cal = {
        version: 1,
        side: r.side,
        createdAt: Date.now(), // the only wall-clock use in Motion (Calibration.createdAt)
        frame: cloneFrame(r.frame),
        gyroBiasDps: cloneVec(r.gyroBiasDps),
        gyroSign: r.gyroSign,
        gyroScale: r.gyroScale,
        gyroScaleSource: r.gyroScaleSource,
        accelG0: r.accelG0,
        quality: { poseAngleDeg: r.quality.poseAngleDeg, stillPeakDps: r.quality.stillPeakDps, warnings: [...r.quality.warnings] },
      };
      this.params = paramsFromCalibration(this.cal);
    }
    this.savedParams = null;
    this.paramsSwitched = false;
    w.finish();
    this.nextDiscontinuity = true; // the cursor jumps to the centre
    this.refJump = true;
    this.em.emit('calibration', { type: 'stepPassed', t, step: 3 });
    this.em.emit('recenter', { t, kind: 'calibration' });
    const calibration = this.getCalibration();
    this.em.emit('calibration', { type: 'done', t, quick, calibration, warnings: [...calibration.quality.warnings] });
  }

  recenter(kind = 'manual') {
    if (!this.cal || this._blocked() || this.lastSource === 'aim') return; // nothing to re-reference
    const t = this._now();
    if (this.pointerModel === 'relative') {
      // the cursor is put at the centre; the emitted samples ease from the old position to "centre + motion since now" over
      // recenterEaseMs and carry discontinuity (no cutting), as in the absolute model. The velocity memory is kept: the sword moves on.
      const b = this.lastBlade;
      const ease = this.ease;
      ease.active = this.haveImu && this.cfg.input.recenterEaseMs > 0;
      ease.startT = t;
      ease.fromX = b ? b.x : FIELD.cx;
      ease.fromY = b ? b.y : FIELD.cy;
      this.rel.setPosition(FIELD.cx, FIELD.cy);
      this.em.emit('recenter', { t, kind: kind === 'reconnect' ? 'reconnect' : 'manual' });
      return;
    }
    if (!this.haveAim) {
      this.pendingRecenter = kind === 'reconnect' ? 'reconnect' : 'manual';
      this.em.emit('recenter', { t, kind: this.pendingRecenter });
      return;
    }
    const b = this.lastBlade;
    this.aim.recenter(t, this.rawAim.yawDeg, this.rawAim.pitchDeg, b ? b.x : FIELD.cx, b ? b.y : FIELD.cy);
    this.em.emit('recenter', { t, kind: kind === 'reconnect' ? 'reconnect' : 'manual' });
  }

  /**
   * The sensor pose JUMPED (the simulator teleports its virtual sword when the pointer enters the window, returns from a
   * blur or rests for a while): restart the orientation filter from gravity at the next IMU sample and make that sample map
   * to the playfield point (x, y), with a discontinuity so nothing cuts. Additive to the frozen contract (contract-notes,
   * integrator). Ignored without a calibration and while the full wizard runs. A real Joy-Con never teleports, so the
   * Bluetooth path never calls this.
   */
  reanchor(x, y) {
    if (!this.cal || this._blocked() || !Number.isFinite(x) || !Number.isFinite(y)) return;
    this.filter.reset();
    this.havePw = false;
    this.haveAim = false;
    this.pendingRecenter = null;
    const at = { x: clamp(x, 0, FIELD.w), y: clamp(y, 0, FIELD.h) };
    if (this.pointerModel === 'relative') this.pendingPlace = at; // the cursor is put there at the next IMU sample
    else this.pendingAnchor = at;
    this.nextDiscontinuity = true;
  }

  /**
   * Per-provider sensor conventions (round 2 finding M3): the host applies the accelerometer sign and the stored gyro scale of the
   * ACTIVE provider, because what the diagnostics page measured on a real Joy-Con says nothing about the simulator. Both are meant
   * to be called when the provider changes, before `reset()` and `setCalibration(null)`; changing them under a running stream
   * would make the orientation filter inconsistent, so the caller restarts it.
   * @param {1|-1} sign
   */
  setAccelSign(sign) {
    this.accelSign = sign === -1 ? -1 : 1;
  }

  /** @param {number|null} scale stored gyro scale (multiplier on the default), null = none: the wizard then estimates it */
  setGyroScaleOverride(scale) {
    this.gyroScaleOverride = Number.isFinite(scale) && scale > 0 ? scale : null;
    if (!this.cal && !this.wizard.active) this.params = this._defaultParams();
  }

  /**
   * The next blade sample has `discontinuity: true`. Reason 'lost' (the link dropped) also restarts the orientation, see
   * `_restartOrientation`: nothing is integrated while the link is down, so the sword may have been tilted meanwhile.
   */
  markDiscontinuity(reason) {
    this.nextDiscontinuity = true;
    if (reason === 'lost') this._restartOrientation();
  }

  /**
   * Forget the tilt: the next IMU sample re-initialises the filter from gravity (exact at rest, with the start-up boost of the
   * time constant) and, with a calibration, the cursor is re-referenced on that same sample through the pendingRecenter path.
   * Used after a hole in the stream (round 1 finding M1). Yaw cannot be recovered across a hole without a magnetometer, so
   * the references restart from the pose the sword is in when the stream resumes.
   */
  _restartOrientation() {
    this.filter.reset();
    this.biasEst.reset();
    this.havePw = false;
    this.haveAim = false;
    // the absolute model re-references the cursor from the pose the sword is in when the stream resumes; the relative model has
    // nothing to re-reference (a hole loses only the motion inside it, the cursor stays where it was)
    if (this.pointerModel === 'absolute' && this.cal && !this._blocked() && !this.pendingRecenter) this.pendingRecenter = 'reconnect';
  }

  reset() {
    this.filter.reset();
    this.biasEst.reset();
    this.aim.reset();
    this.tracker.reset();
    this._resetRelative();
    this._clearStreamState();
    if (this.pointerModel === 'relative') this.nextDiscontinuity = true; // contract 2.7: the next sample is a discontinuity
    this.emaDt = null;
    this.rateCount = 0;
    this.lowSince = null;
    this.accelTrust = 0;
    this.lastWarn = Object.create(null);
  }

  // ------------------------------------------------------------------ rate, saturation

  _trackRate(t, dtMs) {
    const dt = dtMs !== null ? dtMs : this.haveImu ? t - this.lastImuT : null;
    if (dt !== null && dt > 0 && dt < 500) {
      this.emaDt = this.emaDt === null ? dt : this.emaDt + 0.1 * (dt - this.emaDt);
      this.rateCount += 1;
    }
    const rate = this.rateCount >= 2 && this.emaDt ? 1000 / this.emaDt : null;
    if (rate !== null && rate < this.cfg.lowSampleRateHz) {
      if (this.lowSince === null) this.lowSince = t;
      else if (t - this.lowSince >= this.cfg.lowSampleRateS * 1000) {
        this._warn(MOTION_WARNING.LOW_SAMPLE_RATE, `input rate ${rate.toFixed(1)} Hz is below ${this.cfg.lowSampleRateHz} Hz`, t);
      }
    } else {
      this.lowSince = null;
    }
  }

  _checkSaturation(s, t) {
    const sat = this.cfg.saturation;
    const a = s.accel;
    const g = s.gyro;
    if (Math.max(Math.abs(a.x), Math.abs(a.y), Math.abs(a.z)) >= sat.accelG) {
      this._warn(MOTION_WARNING.ACCEL_SATURATED, 'accelerometer at full scale', t);
    }
    if (Math.max(Math.abs(g.x), Math.abs(g.y), Math.abs(g.z)) >= sat.gyroDps) {
      this._warn(MOTION_WARNING.GYRO_SATURATED, 'gyro at full scale', t);
    }
  }

  // ------------------------------------------------------------------ IMU path

  /** @param {import('../shared/contracts.js').ImuSample} s */
  pushImu(s) {
    if (!s || !s.accel || !s.gyro || s.imuActive === false) return;
    if (this.accelSign === -1) s = { ...s, accel: { x: -s.accel.x, y: -s.accel.y, z: -s.accel.z } };
    const g = s.gyro;
    if (!isFiniteVec(s.accel) || !isFiniteVec(g)) return;
    this._lastGyro = g;
    const cfg = this.cfg;
    let t = Number.isFinite(s.t) ? s.t : this.lastImuT;
    if (this.haveImu && t < this.lastImuT) t = this.lastImuT; // time never goes backwards

    // dtMs: the integration step. null = unknown (first sample, a gap, or a non-positive device delta): never integrate across it.
    let dtMs = s.dtMs;
    if (!(dtMs > 0) || dtMs >= cfg.maxGapMs) dtMs = null;
    let gapDisc = false;
    if (this.haveImu) {
      const sinceLast = t - this.lastImuT;
      if (s.dtMs >= cfg.maxGapMs || sinceLast > cfg.maxGapMs) gapDisc = true; // a real hole in the stream
      else if (dtMs === null && sinceLast > cfg.sliceOverMs) gapDisc = true; // unknown dt and a visible hole
      // dtMs === null with the sample right behind the previous one (a burst pair under the arrival-time fallback) only
      // skips the integration of that step; breaking the trail there would cut every swing in two.
    }
    if (this.lastSource === 'aim') gapDisc = true; // provider switched
    if (this.haveImu && t - this.lastImuT > cfg.orientationResetGapMs) this._restartOrientation(); // M1: the tilt is stale
    if (s.side && s.side !== '?') this.side = s.side;
    this._trackRate(t, dtMs);
    this._checkSaturation(s, t);
    if (s.dtSource === 'arrival') this._warn(MOTION_WARNING.DT_FALLBACK, 'device timestamps rejected, using arrival times', t);

    // 1. wizard sees the raw sample first (a step-2 pass may reset the filter)
    if (this.wizard.active) this.wizard.feed(s, t, dtMs);

    // 2. orientation filter. The accelerometer is divided by the resting magnitude g0 the wizard learned in step 1 (round 2 finding
    // M2: the sensor need not read exactly 1 g); the wizard itself saw the raw reading, the saturation check too.
    const p = this.params;
    const a = this._aNorm; // scratch object: no allocation per sample; every consumer below reads it at once
    const invG0 = 1 / p.g0;
    a.x = s.accel.x * invG0;
    a.y = s.accel.y * invG0;
    a.z = s.accel.z * invG0;
    const k = p.sign * p.scale * RAD;
    const wx = (g.x - p.bias.x) * k;
    const wy = (g.y - p.bias.y) * k;
    const wz = (g.z - p.bias.z) * k;
    const speedDps = Math.hypot(g.x - p.bias.x, g.y - p.bias.y, g.z - p.bias.z) * p.scale;
    this.angularSpeedDps = speedDps;
    if (!this.filter.ready) {
      this.filter.initFromAccel(a.x, a.y, a.z);
    } else if (dtMs !== null) {
      let mx = wx;
      let my = wy;
      let mz = wz;
      if (this.havePw) {
        // Trapezoid rule plus the two-sample coning correction (dt/12) * (w_prev x w_now): the rotation vector of a step in
        // which the rate changes linearly is 0.5 (w0 + w1) dt + (dt^2 / 12) (w0 x w1). It matters for fast moves that turn
        // about a changing axis at 33 to 66 Hz (second-order non-commutativity error).
        const c = dtMs / 12000;
        mx = 0.5 * (this.pw.x + wx) + c * (this.pw.y * wz - this.pw.z * wy);
        my = 0.5 * (this.pw.y + wy) + c * (this.pw.z * wx - this.pw.x * wz);
        mz = 0.5 * (this.pw.z + wz) + c * (this.pw.x * wy - this.pw.y * wx);
      }
      if (dtMs > cfg.sliceOverMs) {
        this._warn(MOTION_WARNING.SAMPLE_GAP, `sample gap of ${dtMs.toFixed(0)} ms integrated in slices`, t);
        const n = Math.ceil(dtMs / cfg.sliceMs);
        const dts = dtMs / 1000 / n;
        for (let i = 0; i < n; i += 1) this.filter.integrate(mx, my, mz, dts);
      } else {
        this.filter.integrate(mx, my, mz, dtMs / 1000);
      }
      const amag = Math.hypot(a.x, a.y, a.z);
      this.accelTrust = accelTrustWeight(cfg.fusion, {
        accelMagG: amag,
        angularSpeedDps: speedDps,
        cutting: this._imuCutting(),
        sinceCutMs: t - this._imuLastCuttingT(),
      });
      this.filter.correct(a.x, a.y, a.z, dtMs / 1000, this.accelTrust);
    }
    this.pw.x = wx;
    this.pw.y = wy;
    this.pw.z = wz;
    this.havePw = true;

    // 3. online bias while resting (only with a calibration and outside the full wizard)
    const blocked = this._blocked();
    if (this.cal && !blocked && dtMs !== null) this.biasEst.feed(t, g, a, p.bias, p.scale);

    // aim angles of the blade axis
    const f = this.params.frame.forward;
    this.filter.aimAngles(f.x, f.y, f.z, this.rawAim);
    this.haveAim = true;
    this.lastImuT = t;
    this.lastT = t;
    this.haveImu = true;
    this.lastSource = 'imu';

    // step 3 satisfied by stillness during this sample
    if (this.wizard.active && this.wizard.takeCentreRequest()) this._finishCalibration(t);

    // 4./5. position and blade
    if (!this.cal || this._blocked()) {
      this.trackingOk = false;
      this.refDriven = false;
      return;
    }
    const st = this.settings;
    if (this.pointerModel === 'relative') {
      this._relativeStep(t, dtMs, gapDisc, speedDps);
      return;
    }
    if (this.pendingRecenter) {
      this.aim.setRefs(this.rawAim.yawDeg, this.rawAim.pitchDeg);
      this.pendingRecenter = null;
      this.nextDiscontinuity = true;
      this.refJump = true;
    }
    if (this.pendingAnchor) {
      // references such that the current raw aim maps exactly to the requested point (inverse of the mapping of aim.js)
      const ppd = this.cfg.input.pxPerDegBase * st.sensitivity;
      const fx = st.flipX ? -1 : 1;
      this.aim.setRefs(this.rawAim.yawDeg - (fx * (this.pendingAnchor.x - FIELD.cx)) / ppd, this.rawAim.pitchDeg + (this.pendingAnchor.y - FIELD.cy) / ppd);
      this.pendingAnchor = null;
      this.nextDiscontinuity = true;
    }
    this.aim.map(
      this.rawAim.yawDeg,
      this.rawAim.pitchDeg,
      t,
      {
        angularSpeedDps: speedDps,
        cutting: this.tracker.cutting,
        sinceCutMs: t - this.tracker.lastCuttingT,
        sensitivity: st.sensitivity,
        flipX: st.flipX,
        autoCenter: st.autoCenter,
      },
      this._mapOut,
    );
    this.refDriven = this._mapOut.refsMoved || this.refJump;
    this.refJump = false;
    const disc = gapDisc || this.nextDiscontinuity || this._mapOut.discontinuity;
    this.nextDiscontinuity = false;
    const inp = this._trIn;
    inp.t = t;
    inp.x = this._mapOut.x;
    inp.y = this._mapOut.y;
    inp.discontinuity = disc;
    inp.dtMs = dtMs; // the cap is a rotation rate: measure it against the device step, not against bursty arrival times
    inp.capPxPerS = cfg.cut.safetyCapDegPerS * cfg.input.pxPerDegBase * st.sensitivity;
    const r = this.tracker.update(inp, this._pxThreshold());
    if (r.glitch) this._warn(MOTION_WARNING.GYRO_SATURATED, 'aim step above the safety cap, sample excluded from the blade', t);
    this._emitBlade(r, this.tracker.prevT, this._mapOut.x, this._mapOut.y, speedDps, 'imu', true);
  }

  /** The px/s tracker threshold of the aim path and the absolute model: T (deg/s) x cutMul x aimPxPerDps (300 deg/s = 1000 px/s). */
  _pxThreshold() {
    const st = this.settings;
    return st.cutThreshold * st.cutMul * this.cfg.cut.aimPxPerDps;
  }

  /** The cut state that serves the IMU samples of the active model (the orientation filter must not trust gravity while cutting). */
  _imuCutting() {
    return this.pointerModel === 'relative' ? this.cutter.cutting : this.tracker.cutting;
  }

  _imuLastCuttingT() {
    return this.pointerModel === 'relative' ? this.cutter.lastCuttingT : this.tracker.lastCuttingT;
  }

  // ------------------------------------------------------------------ relative model (docs/motion-contract.md 2.1 to 2.5)

  /**
   * One IMU sample in the relative model: tip velocity -> pointer curve -> integration (+ idle centring) -> path of the interval
   * -> angular cut decision -> trail samples, chords and the BladeSample.
   */
  _relativeStep(t, dtMsIn, gapDisc, totalDps) {
    const cfg = this.cfg;
    const st = this.settings;
    const p = this.params;
    const g = this._lastGyro;
    // safety cap: a sample above it is ignored completely (no pointer motion, no candidate); the next sample integrates over the
    // device step from the last accepted one
    if (totalDps > cfg.cut.safetyCapDegPerS) {
      this.ignoredSince = true;
      this.cutter.glitches += 1;
      this._warn(MOTION_WARNING.GYRO_SATURATED, 'angular speed above the safety cap, sample ignored', t);
      return;
    }
    let dtMs = dtMsIn;
    let disc = gapDisc || this.nextDiscontinuity;
    this.nextDiscontinuity = false;
    if (this.ignoredSince) {
      this.ignoredSince = false;
      if (dtMs !== null && this.rel.have) dtMs = t - this.rel.tPrev > 0 ? t - this.rel.tPrev : null;
    }

    // tip velocity and cursor velocity (contract 2.1, 2.2)
    const k = p.sign * p.scale;
    const w = this._w;
    w.x = (g.x - p.bias.x) * k;
    w.y = (g.y - p.bias.y) * k;
    w.z = (g.z - p.bias.z) * k;
    const tip = tipVelocity(w, p.frame, st.flipX, this._tip);
    const F = pointerSpeedPxS(tip.s, st.sensitivity, this.curveCfg);
    const vx1 = tip.s > 1e-6 ? (F * tip.vR) / tip.s : 0;
    let vy1 = tip.s > 1e-6 ? (-F * tip.vU) / tip.s : 0;
    // vertical (round F1, contract 2.9): the cursor height follows the ELEVATION of the blade. The rate is the rotation about the
    // horizontal axis perpendicular to the blade (gravity frame of the orientation filter) and the gain is capped, so a wrist roll
    // cannot tilt the vertical axis and a fast leg and a slow leg through the same angle move the cursor about equally. The local
    // rate (tip.vU) takes its place, with the same capped gain, while the tilt is not yet confirmed by a calm accelerometer reading
    // (a start or a reconnection in the middle of a swing) and within gravityMinCos of the zenith, where the axis is undefined.
    this.pitchRateDps = null;
    if (cfg.pointer.gravityVertical && tip.s > 1e-6) {
      const rate = this.filter.ready && this.filter.confirmed ? gravityPitchRate(w, p.frame.forward, this.filter.predictedUp(), cfg.pointer.gravityMinCos) : null;
      this.pitchRateDps = rate === null ? null : clamp(rate, -tip.s, tip.s); // the elevation rate cannot exceed the tip speed: numerical safety only
      const r = rate === null ? tip.vU : this.pitchRateDps;
      vy1 = -verticalGainPxPerDeg(tip.s, st.sensitivity, this.curveCfg) * r;
    }
    this.tipSpeedDps = tip.s;
    this.curVx = vx1;
    this.curVy = vy1;

    // the cursor is put somewhere (reanchor, end of the calibration): nothing integrates, the sample is a discontinuity
    if (this.pendingPlace) {
      this.rel.setPosition(this.pendingPlace.x, this.pendingPlace.y);
      this.rel.clearMotion();
      this.ease.active = false;
      this.pendingPlace = null;
      disc = true;
    }

    const cutter = this.cutter;
    const T = st.cutThreshold * st.cutMul;
    const o = this.rel.update(t, disc ? null : dtMs, vx1, vy1, tip.s, {
      autoCenter: st.autoCenter,
      cutting: cutter.cutting,
      sinceCutMs: t - cutter.lastCuttingT,
    });

    // the recentre ease: the emitted position glides from the old cursor to the true one; such samples are discontinuities
    let x = o.x1;
    let y = o.y1;
    let easing = false;
    if (this.ease.active) {
      const el = Math.max(0, t - this.ease.startT);
      if (el >= cfg.input.recenterEaseMs) {
        this.ease.active = false;
      } else {
        const e = smoothstep(el / cfg.input.recenterEaseMs);
        x = this.ease.fromX + (o.x1 - this.ease.fromX) * e;
        y = this.ease.fromY + (o.y1 - this.ease.fromY) * e;
        easing = true;
      }
    }
    const outDisc = disc || easing;
    this.refDriven = o.carried || easing || this.refJump;
    this.refJump = false;

    // path of the interval: chords for the collision, interpolated samples for the trail (only between two real samples)
    const tStart = Math.min(o.t0, t);
    const interval = o.haveInterval && !outDisc && dtMs !== null;
    const chords = interval ? planChords(o, tStart, t, dtMs, cfg) : [];
    const trailPlan = interval ? planTrail(o, tStart, t, dtMs, cfg) : [];
    const trail = [];
    for (const q of trailPlan) {
      trail.push({
        t: q.t,
        x: q.x,
        y: q.y,
        speed: q.s * cfg.cut.aimPxPerDps,
        cutting: false,
        swingId: cutter.swingId,
        segmentValid: false,
        x0: q.x,
        y0: q.y,
        t0: q.t,
        discontinuity: false,
        trackingOk: true,
        angularSpeedDps: q.s,
        source: 'imu',
        speedDps: q.s,
        vx: q.vx,
        vy: q.vy,
        interpolated: true,
      });
    }

    // cut decision (contract 2.4)
    const r = cutter.update(t, tip.s, T, outDisc, chords, trail);
    for (const q of r.cutTrail) {
      q.cutting = true;
      q.swingId = r.swingId;
    }
    if (!r.cutting || r.entered || outDisc) this.segAnchor = null;
    const first = r.segments.length ? this._queueChords(r.segments, r.swingId) : null;
    for (const q of trail) {
      // the ring stays chronological even when a synthetic tracking-lost sample was stamped with a poll time ahead of the stream
      if (q.t < this.lastEmitT) q.t = this.lastEmitT;
      q.t0 = q.t;
      this.lastEmitT = q.t;
      this._ringPush(q);
    }

    this.head.valid = true;
    this.head.vx = vx1;
    this.head.vy = vy1;
    this.head.ax = o.ax;
    this.head.ay = o.ay;
    const sample = {
      t,
      x,
      y,
      speed: tip.s * cfg.cut.aimPxPerDps,
      cutting: r.cutting,
      swingId: r.swingId,
      segmentValid: first !== null,
      x0: first ? first.x0 : x,
      y0: first ? first.y0 : y,
      t0: first ? first.t0 : t,
      discontinuity: outDisc,
      trackingOk: true,
      angularSpeedDps: totalDps,
      source: 'imu',
      speedDps: tip.s,
      vx: vx1,
      vy: vy1,
      interpolated: false,
    };
    this._publish(sample, 'imu', true);
  }

  /**
   * Deliver chords to the segment queue. A chord whose end is closer than pointer.minChordPx to the start of the pending material is
   * merged into the next one (the cursor did not move, for example against a screen edge), so a cut run stays contiguous and its first
   * chord starts exactly where the run began. Returns the start of the first delivered chord, or null when nothing was delivered.
   */
  _queueChords(chords, swingId) {
    const minLen = this.cfg.pointer.minChordPx;
    const q = this.segQueue;
    let first = null;
    for (const c of chords) {
      if (!this.segAnchor) this.segAnchor = { t: c.t0, x: c.x0, y: c.y0 };
      const a = this.segAnchor;
      if (Math.hypot(c.x1 - a.x, c.y1 - a.y) < minLen) continue;
      if (q.length >= this.cfg.tracker.segmentQueueMax) q.shift();
      q.push({ t0: a.t, x0: a.x, y0: a.y, t1: c.t1, x1: c.x1, y1: c.y1, speed: c.speed, swingId });
      if (first === null) first = { t0: a.t, x0: a.x, y0: a.y };
      this.segAnchor = { t: c.t1, x: c.x1, y: c.y1 };
    }
    return first;
  }

  // ------------------------------------------------------------------ aim path (mouse, debug swing)

  /** @param {import('../shared/contracts.js').AimSample} s */
  pushAim(s) {
    if (!s || !Number.isFinite(s.x) || !Number.isFinite(s.y)) return;
    const cfg = this.cfg;
    let t = Number.isFinite(s.t) ? s.t : this.lastT;
    if (this.lastBlade && t < this.lastT) t = this.lastT;
    const disc = !!s.discontinuity || this.nextDiscontinuity || this.lastSource === 'imu';
    this.nextDiscontinuity = false;
    this.refDriven = false; // an aim sample has no references
    const x = clamp(s.x, 0, FIELD.w);
    const y = clamp(s.y, 0, FIELD.h);
    const inp = this._trIn;
    inp.t = t;
    inp.x = x;
    inp.y = y;
    inp.discontinuity = disc;
    inp.dtMs = null;
    inp.capPxPerS = cfg.cut.safetyCapMousePxPerS;
    const r = this.tracker.update(inp, this._pxThreshold());
    this.lastSource = 'aim';
    this.lastT = this.tracker.prevT;
    this.aimIdleEmitted = false;
    this._emitBlade(r, this.tracker.prevT, x, y, null, 'aim', true);
  }

  // ------------------------------------------------------------------ output

  /** A BladeSample from the px/s tracker (aim path, absolute model, tracking lost). */
  _emitBlade(r, t, x, y, angularSpeedDps, source, trackingOk) {
    // emitted times never go backwards, also across a synthetic tracking-lost sample stamped with the poll time
    if (t < this.lastEmitT) t = this.lastEmitT;
    const sample = {
      t,
      x,
      y,
      speed: r.speed,
      cutting: r.cutting,
      swingId: r.swingId,
      segmentValid: r.segmentValid,
      x0: r.x0,
      y0: r.y0,
      t0: r.t0,
      discontinuity: r.discontinuity,
      trackingOk,
      angularSpeedDps,
      source,
      speedDps: r.speed / this.cfg.cut.aimPxPerDps, // the px/s speed in deg/s-equivalent: the meter means one thing for every provider
      vx: 0,
      vy: 0,
      interpolated: false,
    };
    this.head.valid = false;
    if (sample.segmentValid) {
      const q = this.segQueue;
      if (q.length >= this.cfg.tracker.segmentQueueMax) q.shift();
      q.push({ t0: sample.t0, x0: sample.x0, y0: sample.y0, t1: t, x1: x, y1: y, speed: sample.speed, swingId: sample.swingId });
    }
    this._publish(sample, source, trackingOk);
  }

  /** Make a finished BladeSample the newest one: state, history ring, 'blade' event. */
  _publish(sample, source, trackingOk) {
    if (sample.t < this.lastEmitT) sample.t = this.lastEmitT; // emitted times never go backwards
    this.lastEmitT = sample.t;
    this.lastBlade = sample;
    this.trackingOk = trackingOk;
    this._ringPush(sample);
    this.em.emit('blade', sample);
  }

  /**
   * Housekeeping every frame: calibration watchdogs, tracking loss (IMU) and the "mouse came to rest" sample (aim).
   * @param {number} nowMs
   */
  poll(nowMs) {
    if (!Number.isFinite(nowMs)) return;
    if (this.wizard.active) this.wizard.poll(nowMs);
    const b = this.lastBlade;
    if (!b) return;
    const cfg = this.cfg;
    if (b.source === 'imu') {
      if (this.trackingOk && this.cal && !this._blocked() && nowMs - this.lastImuT > cfg.trackingLostMs) {
        this.tracker.dropCutting(nowMs);
        this.cutter.dropCutting(nowMs);
        this.rel.clearMotion(); // the velocity memory and the idle timers do not survive a lost track
        this.segAnchor = null;
        this.refDriven = false;
        this.nextDiscontinuity = true; // the first real sample afterwards breaks the trail
        this._emitBlade(
          { speed: 0, cutting: false, swingId: this._imuSwingId(), segmentValid: false, x0: b.x, y0: b.y, t0: nowMs, discontinuity: false },
          nowMs,
          b.x,
          b.y,
          0,
          'imu',
          false,
        );
      }
    } else if (!this.aimIdleEmitted && this.tracker.cutting && nowMs - this.lastT >= cfg.aimIdleMs) {
      // A resting mouse produces no events; without this the blade would stay in CUTTING forever.
      this.aimIdleEmitted = true;
      const inp = this._trIn;
      inp.t = nowMs;
      inp.x = b.x;
      inp.y = b.y;
      inp.discontinuity = false;
      inp.dtMs = null;
      inp.capPxPerS = cfg.cut.safetyCapMousePxPerS;
      const r = this.tracker.update(inp, this._pxThreshold());
      this.lastT = this.tracker.prevT;
      this._emitBlade(r, this.tracker.prevT, b.x, b.y, null, 'aim', true);
    }
  }

  drainSegments() {
    const out = this.segQueue;
    this.segQueue = [];
    return out;
  }

  recent(windowMs) {
    const newest = this._ringAt(0);
    if (!newest) return [];
    const tMin = newest.t - windowMs;
    const out = [];
    for (let i = this.ringCount - 1; i >= 0; i -= 1) {
      const s = this._ringAt(i);
      if (s.t >= tMin) out.push(s);
    }
    return out;
  }

  /** Pointing velocity in px/s from the newest samples (no extrapolation across a discontinuity or a lost track). */
  _velocity() {
    const b = this._ringAt(0);
    if (!b || !b.trackingOk || b.discontinuity) return { x: 0, y: 0 };
    let cand = null;
    let after = b;
    for (let i = 1; i < this.ringCount; i += 1) {
      const p = this._ringAt(i);
      if (b.t - p.t > 40 || !p.trackingOk || after.discontinuity) break;
      cand = p;
      after = p;
      if (b.t - p.t >= 8) break;
    }
    if (!cand || b.t - cand.t <= 0) return { x: 0, y: 0 };
    const dt = (b.t - cand.t) / 1000;
    return { x: (b.x - cand.x) / dt, y: (b.y - cand.y) / dt };
  }

  headAt(nowMs) {
    const b = this.lastBlade;
    if (!b) return null;
    if (this.head.valid && b.source === 'imu' && b.trackingOk && !b.discontinuity) {
      // relative model (contract 2.5 item 3): up to pointer.extrapolateMaxMs ahead, with the last acceleration, never reversing
      return extrapolateHead(b, this.head, nowMs, this.cfg.pointer);
    }
    let x = b.x;
    let y = b.y;
    if (b.trackingOk) {
      const ext = clamp(nowMs - b.t, 0, this.cfg.extrapolateMaxMs);
      if (ext > 0) {
        const v = this._velocity();
        x += (v.x * ext) / 1000;
        y += (v.y * ext) / 1000;
      }
    }
    return { x: clamp(x, 0, FIELD.w), y: clamp(y, 0, FIELD.h) };
  }

  /**
   * Clay Rush (docs/architecture.md 4.2): the pointer at time tMs (Clock ms), from the aim history.
   * IMU samples: linear interpolation between the two entries (real or interpolated) around tMs, never an extrapolation; across a
   * discontinuity the earlier entry holds (the path jumped at the later one). Aim (mouse) samples: the newest entry at or before tMs,
   * which holds until the next one (a resting mouse sends nothing), also beyond the newest entry.
   * valid is false when the history does not cover tMs (older than the ring, before the first sample, after the newest IMU sample,
   * across a hole longer than maxGapMs, or across a change of source) or tracking was not ok then (either bracketing entry). x and y
   * are always numbers in the playfield: the nearest known position when not valid (the centre with no history).
   * @param {number} tMs
   * @returns {{x:number, y:number, valid:boolean}}
   */
  aimAt(tMs) {
    const n = this.shotCount;
    if (!n || !Number.isFinite(tMs)) {
      const b = this.lastBlade;
      return { x: b ? b.x : FIELD.cx, y: b ? b.y : FIELD.cy, valid: false };
    }
    const k = this._shotFind(tMs);
    if (k < 0) {
      const i0 = this._shotIdx(0); // older than the ring
      return { x: this.shotX[i0], y: this.shotY[i0], valid: false };
    }
    const i = this._shotIdx(k);
    const f0 = this.shotF[i];
    const x0 = this.shotX[i];
    const y0 = this.shotY[i];
    const ok0 = (f0 & SHOT_OK) !== 0;
    if (f0 & SHOT_AIM || this.shotT[i] === tMs) return { x: x0, y: y0, valid: ok0 };
    if (k + 1 >= n) return { x: x0, y: y0, valid: false }; // after the newest IMU sample: never extrapolate
    const j = this._shotIdx(k + 1);
    const f1 = this.shotF[j];
    const t0 = this.shotT[i];
    const t1 = this.shotT[j];
    if (f1 & SHOT_AIM || t1 - t0 > this.cfg.maxGapMs) return { x: x0, y: y0, valid: false };
    const valid = ok0 && (f1 & SHOT_OK) !== 0;
    if (f1 & SHOT_DISC) return { x: x0, y: y0, valid };
    const u = (tMs - t0) / (t1 - t0);
    return { x: x0 + (this.shotX[j] - x0) * u, y: y0 + (this.shotY[j] - y0) * u, valid };
  }

  /**
   * Clay Rush (docs/architecture.md 4.2): how much the trigger pull moved the aim. jerkPeakDps = the peak angular speed of the real
   * samples in [tPress, tPress + shot.jerkWindowMs] (IMU: |w| in deg/s; aim samples: the deg/s-equivalent cursor speed), 0 when there is
   * none yet; displacementPx = |aimAt(tPress + shot.settleMs) - aimAt(tPress - compMs)|. valid when both aimAt are valid. Call it at
   * least settleMs after the press (app.js: 160 ms). How big a real trigger jerk is: UNVERIFIED-ON-HARDWARE.
   * @param {number} tPressMs
   * @param {number} compMs
   * @returns {{jerkPeakDps:number, displacementPx:number, valid:boolean}}
   */
  shotDiagnostics(tPressMs, compMs) {
    const sh = this.cfg.shot;
    const comp = Number.isFinite(compMs) ? compMs : 0;
    let peak = 0;
    if (Number.isFinite(tPressMs)) {
      const tEnd = tPressMs + sh.jerkWindowMs;
      for (let k = Math.max(0, this._shotFind(tPressMs)); k < this.shotCount; k += 1) {
        const i = this._shotIdx(k);
        const t = this.shotT[i];
        if (t > tEnd) break;
        if (t < tPressMs) continue;
        const w = this.shotW[i];
        if (w > peak) peak = w; // NaN (interpolated entries) never wins
      }
    }
    const a = this.aimAt(tPressMs - comp);
    const b = this.aimAt(tPressMs + sh.settleMs);
    return { jerkPeakDps: peak, displacementPx: Math.hypot(b.x - a.x, b.y - a.y), valid: a.valid && b.valid };
  }

  getState() {
    const b = this.lastBlade;
    const calibrated = !!this.cal && !this._blocked();
    const hasAim = calibrated && this.haveAim && this.lastSource === 'imu' && this.pointerModel === 'absolute';
    return {
      calibrated,
      calibrationStep: this.wizard.active ? this.wizard.step : null,
      x: b ? b.x : FIELD.cx,
      y: b ? b.y : FIELD.cy,
      speed: b ? b.speed : 0, // px/s-equivalent (tip speed x 10/3 for IMU samples), the scale the game and the trail read
      speedDps: b ? b.speedDps : 0, // the cut-decision speed in deg/s (tip speed; px speed / (10/3) for the aim path and the simulator)
      cutThresholdDps: this.settings.cutThreshold * this.settings.cutMul, // effective T, deg/s
      pointerModel: this.pointerModel,
      cutting: b ? b.cutting : false,
      swingId: b ? b.swingId : 0,
      yawDeg: hasAim ? this._mapOut.yawDeg : null, // null in the relative model: there are no absolute angles
      pitchDeg: hasAim ? this._mapOut.pitchDeg : null,
      angularSpeedDps: this.angularSpeedDps,
      trackingOk: this.trackingOk,
      refDriven: this.refDriven && this.lastSource === 'imu',
      sampleRateHz: this.rateCount >= 2 && this.emaDt ? 1000 / this.emaDt : null,
      lastSampleT: this.lastT,
    };
  }

  /** Internal state for the diagnostics overlay and for tests (additive, not part of the frozen contract). */
  getDebug() {
    return {
      bias: cloneVec(this.params.bias),
      gyroSign: this.params.sign,
      gyroScale: this.params.scale,
      accelG0: this.params.g0, // the learned resting |a| the accelerometer is divided by (1 until a wizard learned one)
      accelSign: this.accelSign,
      frame: cloneFrame(this.params.frame),
      q: { ...this.filter.q },
      rawYawDeg: this.rawAim.yawDeg,
      rawPitchDeg: this.rawAim.pitchDeg,
      yawRef: this.aim.yawRef,
      pitchRef: this.aim.pitchRef,
      accelTrust: this.accelTrust,
      autoSlewing: this.aim.autoSlewing,
      edgeActive: this.aim.edgeActive,
      biasUpdates: this.biasEst.updates,
      glitches: this.tracker.glitches + this.cutter.glitches,
      side: this.side,
      pointer: {
        model: this.pointerModel,
        tipSpeedDps: this.tipSpeedDps,
        pitchRateDps: this.pitchRateDps,
        elevationDeg: this.filter.ready ? this.rawAim.pitchDeg : null,
        gravityConfirmed: this.filter.confirmed,
        vx: this.curVx,
        vy: this.curVy,
        centring: this.rel.centring,
        idleForS: this.rel.idleFor,
      },
    };
  }
}

/**
 * @param {{clock?:import('../shared/contracts.js').Clock, config?:object, settings?:Partial<import('../shared/contracts.js').MotionSettings>, gyroScaleOverride?:number|null, accelSign?:1|-1, pointerModel?:'relative'|'absolute'}} [opts]
 *   pointerModel: 'relative' (default, every real Joy-Con) or 'absolute' (the simulator); see docs/motion-contract.md section 1
 * @returns {import('../shared/contracts.js').MotionPipeline}
 */
export function createMotionPipeline(opts = {}) {
  return new MotionPipelineImpl(opts).api;
}
