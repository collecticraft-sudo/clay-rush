// Orientation filter (gyro integration + gravity correction) and online gyro bias estimation. OWNER: motion engineer.
//
// Frames (docs/architecture.md 3.3): the filter tracks the DEVICE orientation q (device -> world). World: x right, y forward
// (towards the screen), z up. The accelerometer reads +1 g pointing UP at rest, so the measured up direction in device
// coordinates is normalize(accel) and the predicted one is rotate(conj(q), (0,0,1)).
//
// The correction is a Mahony-style proportional term. Derivation of the sign: a world-fixed vector seen from a body that
// rotates with omega changes as d(u_p)/dt = u_p x omega. Choosing omega_c = k * (u_m x u_p) gives
// d(u_p)/dt = k * (u_m - u_p (u_p . u_m)), i.e. u_p moves towards u_m. k = trust / tau.
//
// Yaw is never corrected (no magnetometer: hard-iron field of a sword and strap, protocol 5.3); it drifts with the residual
// gyro bias and is handled by aim.js (soft centring, edge slip, manual recentre). UNVERIFIED-ON-HARDWARE (HW-3).

import { qIdentity, qIntegrate, qFromUnitVectors, qRotateInvInto, qRotateInto } from './quat.js';
import { DEG, clamp } from './vec.js';

const UP = Object.freeze({ x: 0, y: 0, z: 1 });

export class OrientationFilter {
  /**
   * @param {number} tauS time constant of the gravity correction, seconds
   * @param {{bootS?:number, bootTauS?:number, confirmTrust?:number, confirmTiltDeg?:number, unconfirmedTauS?:number}} [opts] start-up boost: for the first bootS seconds
   *   after (re)initialisation the time constant runs from bootTauS up to tauS, so the tilt error of the very first (noisy) reading fades
   *   quickly. `confirmed` (round F1): false after every (re)initialisation, true from the first correction with a trust weight of at
   *   least confirmTrust whose residual tilt error is at most confirmTiltDeg, i.e. the first time a calm accelerometer reading agreed with
   *   the gyro-integrated gravity direction. The vertical axis of the pointer relies on the tilt only while it is confirmed.
   */
  constructor(tauS, opts = {}) {
    this.tauS = tauS;
    this.bootS = opts.bootS ?? 0;
    this.bootTauS = opts.bootTauS ?? tauS;
    this.confirmTrust = opts.confirmTrust ?? 0.4;
    this.confirmTiltDeg = opts.confirmTiltDeg ?? 8;
    this.unconfirmedTauS = opts.unconfirmedTauS ?? tauS; // time constant of the correction while the tilt is unconfirmed after the start-up boost
    this.confirmed = false; // a calm reading has agreed with the tilt since the last (re)initialisation
    this.age = 0; // seconds since the last (re)initialisation
    this.q = qIdentity();
    this.ready = false;
    this._up = { x: 0, y: 0, z: 0 };
    this._aim = { x: 0, y: 0, z: 0 };
  }

  /** Forget the orientation; the next sample re-initialises from gravity (yaw restarts at an arbitrary zero). */
  reset() {
    this.q = qIdentity();
    this.ready = false;
    this.confirmed = false;
    this.age = 0;
  }

  /** Initialise from one accelerometer reading: pitch and roll from gravity, yaw arbitrary (zero). */
  initFromAccel(ax, ay, az) {
    const n = Math.hypot(ax, ay, az);
    if (n < 1e-6) {
      this.q = qIdentity();
    } else {
      // rotation taking the measured up direction (device coordinates) onto world up
      this.q = qFromUnitVectors({ x: ax / n, y: ay / n, z: az / n }, UP);
    }
    this.ready = true;
    this.confirmed = false;
    this.age = 0;
  }

  /** Apply body-frame angular rate (rad/s) over dt seconds. */
  integrate(wx, wy, wz, dtS) {
    if (dtS > 0) qIntegrate(this.q, wx, wy, wz, dtS);
  }

  /**
   * Gravity correction with a trust weight in 0..1 (0 = ignore the accelerometer).
   * @returns {number} residual tilt error in degrees (angle between measured and predicted up), or -1 when skipped
   */
  correct(ax, ay, az, dtS, trust) {
    const n = Math.hypot(ax, ay, az);
    if (!(trust > 0) || !(dtS > 0) || n < 1e-6) return -1;
    const mx = ax / n;
    const my = ay / n;
    const mz = az / n;
    const p = qRotateInvInto(this._up, this.q, 0, 0, 1);
    // omega_c = (trust / tau) * (u_m x u_p), tau shortened during the start-up boost
    let tau = this.age < this.bootS ? this.bootTauS + ((this.tauS - this.bootTauS) * this.age) / this.bootS : this.tauS;
    if (!this.confirmed && this.age >= this.bootS) tau = Math.min(tau, this.unconfirmedTauS); // an unconfirmed tilt is probably wrong: believe calm readings faster
    this.age += dtS;
    const k = trust / tau;
    const cx = (my * p.z - mz * p.y) * k;
    const cy = (mz * p.x - mx * p.z) * k;
    const cz = (mx * p.y - my * p.x) * k;
    qIntegrate(this.q, cx, cy, cz, dtS);
    const dot = clamp(mx * p.x + my * p.y + mz * p.z, -1, 1);
    const err = Math.acos(dot) * DEG;
    if (trust >= this.confirmTrust && err <= this.confirmTiltDeg) this.confirmed = true;
    return err;
  }

  /** Predicted world-up expressed in device coordinates (reused object). */
  predictedUp() {
    return qRotateInvInto(this._up, this.q, 0, 0, 1);
  }

  /** Direction of a device-frame vector in world coordinates (reused object). */
  toWorld(vx, vy, vz) {
    return qRotateInto(this._aim, this.q, vx, vy, vz);
  }

  /**
   * Aim angles of the sword forward axis (device coordinates): yaw = atan2(x, y), pitch = asin(z) of its world direction.
   * Roll about the axis itself does not change them. Writes into `out` = {yawDeg, pitchDeg}.
   */
  aimAngles(fx, fy, fz, out) {
    const a = qRotateInto(this._aim, this.q, fx, fy, fz);
    out.yawDeg = Math.atan2(a.x, a.y) * DEG;
    out.pitchDeg = Math.asin(clamp(a.z, -1, 1)) * DEG;
    return out;
  }
}

/**
 * Accelerometer trust weight in 0..1 for the gravity correction (architecture 6.5 plus a soft taper).
 * Zero when the blade is cutting or was cutting within cutQuietMs, when | |a| - 1 | > trustBandG, or when the angular
 * speed exceeds maxTrustDps. Inside those limits the weight tapers so that centripetal acceleration of a moving sword
 * (which points perpendicular to gravity and barely changes |a|) contaminates the tilt estimate less.
 * @param {typeof import('./motion-config.js').MOTION_CONFIG.fusion} f
 * @param {{accelMagG:number, angularSpeedDps:number, cutting:boolean, sinceCutMs:number}} c
 */
export function accelTrustWeight(f, c) {
  if (c.cutting || c.sinceCutMs < f.cutQuietMs) return 0;
  if (c.angularSpeedDps > f.maxTrustDps) return 0;
  const dev = Math.abs(c.accelMagG - 1);
  if (dev > f.trustBandG) return 0;
  const wa = dev <= f.flatBandG ? 1 : (f.trustBandG - dev) / (f.trustBandG - f.flatBandG);
  const r = c.angularSpeedDps / f.softTrustDps;
  return wa / (1 + r * r);
}

/**
 * Online gyro bias estimator. While the sword rests it averages the raw gyro over windowS and nudges the bias towards
 * the mean (weight `blend` per window), so the bias is re-estimated whenever the sword is still. All rates are compared
 * in TRUE degrees per second, i.e. multiplied by the calibrated gyro scale, so the same thresholds work for both known
 * scale candidates (protocol D1).
 *
 * "Rest" = | |a| - 1 | <= restBandG, the accel direction stays inside a tiltStableDeg cone, and the per-axis gyro spread
 * (max - min) stays <= restSpreadDps. A constant slow rotation about the vertical axis looks identical to a bias; that is
 * why corrections larger than maxCorrectionDps are refused. UNVERIFIED-ON-HARDWARE (HW-3, HW-7).
 */
export class BiasEstimator {
  /** @param {typeof import('./motion-config.js').MOTION_CONFIG.gyroBias} cfg */
  constructor(cfg) {
    this.cfg = cfg;
    this.updates = 0;
    this.reset();
  }

  reset() {
    this.n = 0;
    this.startT = 0;
    this.sx = 0;
    this.sy = 0;
    this.sz = 0;
    this.minX = 0;
    this.minY = 0;
    this.minZ = 0;
    this.maxX = 0;
    this.maxY = 0;
    this.maxZ = 0;
    this.fux = 0;
    this.fuy = 0;
    this.fuz = 0;
  }

  _start(t, g, ux, uy, uz) {
    this.n = 1;
    this.startT = t;
    this.sx = g.x;
    this.sy = g.y;
    this.sz = g.z;
    this.minX = this.maxX = g.x;
    this.minY = this.maxY = g.y;
    this.minZ = this.maxZ = g.z;
    this.fux = ux;
    this.fuy = uy;
    this.fuz = uz;
  }

  /**
   * @param {number} t sample time, ms
   * @param {{x:number,y:number,z:number}} g raw gyro (parsed units, bias NOT removed)
   * @param {{x:number,y:number,z:number}} a accel, g
   * @param {{x:number,y:number,z:number}} bias current bias, UPDATED IN PLACE when a window completes
   * @param {number} scale calibrated gyro scale (true dps = parsed dps * scale)
   * @returns {boolean} true when the bias was updated by this call
   */
  feed(t, g, a, bias, scale) {
    const c = this.cfg;
    const amag = Math.hypot(a.x, a.y, a.z);
    if (Math.abs(amag - 1) > c.restBandG || amag < 1e-6) {
      this.reset();
      return false;
    }
    const ux = a.x / amag;
    const uy = a.y / amag;
    const uz = a.z / amag;
    if (this.n === 0) {
      this._start(t, g, ux, uy, uz);
      return false;
    }
    const cosTilt = ux * this.fux + uy * this.fuy + uz * this.fuz;
    if (cosTilt < Math.cos((c.tiltStableDeg * Math.PI) / 180)) {
      this._start(t, g, ux, uy, uz);
      return false;
    }
    const minX = Math.min(this.minX, g.x);
    const minY = Math.min(this.minY, g.y);
    const minZ = Math.min(this.minZ, g.z);
    const maxX = Math.max(this.maxX, g.x);
    const maxY = Math.max(this.maxY, g.y);
    const maxZ = Math.max(this.maxZ, g.z);
    const spread = Math.max(maxX - minX, maxY - minY, maxZ - minZ) * scale;
    if (spread > c.restSpreadDps) {
      this._start(t, g, ux, uy, uz);
      return false;
    }
    this.minX = minX;
    this.minY = minY;
    this.minZ = minZ;
    this.maxX = maxX;
    this.maxY = maxY;
    this.maxZ = maxZ;
    this.n += 1;
    this.sx += g.x;
    this.sy += g.y;
    this.sz += g.z;
    if (t - this.startT < c.windowS * 1000 || this.n < c.minSamples) return false;

    const mx = this.sx / this.n;
    const my = this.sy / this.n;
    const mz = this.sz / this.n;
    this.reset();
    const dx = mx - bias.x;
    const dy = my - bias.y;
    const dz = mz - bias.z;
    if (Math.hypot(dx, dy, dz) * scale > c.maxCorrectionDps) return false;
    bias.x += c.blend * dx;
    bias.y += c.blend * dy;
    bias.z += c.blend * dz;
    this.updates += 1;
    return true;
  }
}
