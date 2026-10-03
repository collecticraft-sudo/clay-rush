// Relative pointer of the real sword: tip velocity, dead zone, acceleration curve, integration, idle soft auto-centre, and the
// path between two IMU samples (collision chords, trail samples). OWNER: motion engineer. Pure module (no DOM, no timers).
//
// Contract: docs/motion-contract.md 1, 2.1, 2.2, 2.3, 2.5. Evidence: docs/motion-findings.md (one real Joy-Con 2 Right
// recording). Every number lives in MOTION_CONFIG.pointer; all of them are STARTING VALUES, UNVERIFIED-ON-HARDWARE for feel.
//
// The model in one paragraph. The cursor moves like a mouse: by gain(tip speed) x tip velocity, where the tip velocity is the
// gyro vector without its roll component about the blade axis. HORIZONTALLY it is expressed in the local frame of the sword (right):
// there is no yaw reference (no magnetometer), so turning the body or changing posture cannot move the cursor, and the cursor is
// the only state. VERTICALLY (round "F1", docs/motion-contract.md 2.9) the rate is the rate at which the ELEVATION of the blade
// changes, i.e. the angular velocity about the horizontal axis perpendicular to the blade, taken with the gravity direction of the
// orientation filter ("gravity-stabilised pitch"), and its gain is the same curve capped at verticalMaxPxDeg (flat above about
// 75 deg/s): the cursor height is then (nearly) a function of where the blade points, not of the path and the speed that led there,
// so it cannot sink to an edge during continuous slashing.
// A dead zone of 5 deg/s removes hand tremor; the horizontal gain rises from 5 px/deg just above it to 14 px/deg for a fast swing
// (pointer acceleration). When the sword has been idle for a second the cursor glides back to the centre.

import { FIELD } from '../shared/playfield.js';
import { clamp } from './vec.js';

const smoothstep = (x) => {
  const c = x < 0 ? 0 : x > 1 ? 1 : x;
  return c * c * (3 - 2 * c);
};

/**
 * Tip velocity of the blade in the local frame of the sword (contract 2.1).
 * w = (gyro - bias) x sign x scale in deg/s (device frame); frame = {right, forward, up} orthonormal in device coordinates,
 * right x forward = up. tv = w x forward is the velocity of the blade direction (perpendicular to forward, so roll about the blade
 * does not contribute). Signs reproduce the convention of the absolute model: turning the blade to the right gives vR > 0,
 * tipping it up gives vU > 0.
 * @param {{x:number,y:number,z:number}} w
 * @param {{right:{x:number,y:number,z:number}, forward:{x:number,y:number,z:number}, up:{x:number,y:number,z:number}}} frame
 * @param {boolean} flipX mirror the horizontal axis
 * @param {{s:number, vR:number, vU:number}} out written: tip speed (deg/s), velocity towards the right and towards up (deg/s)
 */
export function tipVelocity(w, frame, flipX, out) {
  const f = frame.forward;
  const r = frame.right;
  const u = frame.up;
  const tx = w.y * f.z - w.z * f.y;
  const ty = w.z * f.x - w.x * f.z;
  const tz = w.x * f.y - w.y * f.x;
  const aR = tx * r.x + ty * r.y + tz * r.z; // = -w . up
  const aU = tx * u.x + ty * u.y + tz * u.z; // = +w . right
  out.s = Math.hypot(aR, aU);
  out.vR = flipX ? -aR : aR;
  out.vU = aU;
  return out;
}

/**
 * Cursor speed in px/s for a tip speed s (deg/s) at a sensitivity (contract 2.2):
 *   e = s - deadDps;  F = 0 for e <= 0;  F = sensitivity x e x (gLo + (gHi - gLo) x smoothstep(min(1, e / rampDps))).
 * The sensitivity scales the speed and nothing else (not the dead zone, the ramp, the cut decision or the idle test).
 * @param {number} s
 * @param {number} sensitivity
 * @param {typeof import('./motion-config.js').MOTION_CONFIG.pointer} cfg
 */
export function pointerSpeedPxS(s, sensitivity, cfg) {
  const e = s - cfg.deadDps;
  if (!(e > 0)) return 0;
  const gain = cfg.gLoPxDeg + (cfg.gHiPxDeg - cfg.gLoPxDeg) * smoothstep(e / cfg.rampDps);
  return sensitivity * e * gain;
}

/** Effective px per degree at tip speed s (F / s), 0 inside the dead zone. */
export function pointerGainPxPerDeg(s, sensitivity, cfg) {
  return s > cfg.deadDps ? pointerSpeedPxS(s, sensitivity, cfg) / s : 0;
}

/**
 * The elevation rate of the blade in the gravity frame (deg/s, positive = the tip rises): the component of the angular velocity
 * about the horizontal axis n = forward x up, where `up` is the world vertical in device coordinates (the orientation filter's
 * gravity direction) and |n| = cos(elevation). The tip velocity is w x forward, its component towards the zenith is
 * (w x forward) . up / cos(elevation) = w . n / |n|. Unlike the local `vU` (w . right) it does not depend on how the wrist has
 * rolled the sword about its own axis, and it stays right when the sword is upside down. Returns null when the blade is within
 * asin(minCos) of the vertical, where n is undefined (the caller falls back on the local vU).
 * Identity mount, level sword, upright: n = (1, 0, 0), so the result is w.x, the same as the local vU.
 * @param {{x:number,y:number,z:number}} w corrected angular rate, deg/s, device frame
 * @param {{x:number,y:number,z:number}} forward blade axis, device coordinates (unit)
 * @param {{x:number,y:number,z:number}} up world up in device coordinates (unit)
 * @param {number} minCos smallest cos(elevation) for which the axis is used
 * @returns {number|null}
 */
export function gravityPitchRate(w, forward, up, minCos) {
  const nx = forward.y * up.z - forward.z * up.y;
  const ny = forward.z * up.x - forward.x * up.z;
  const nz = forward.x * up.y - forward.y * up.x;
  const c = Math.hypot(nx, ny, nz);
  if (!(c >= minCos) || !(c > 1e-9)) return null;
  return (w.x * nx + w.y * ny + w.z * nz) / c;
}

/**
 * Vertical px per degree of ELEVATION at tip speed s (round F1): the horizontal curve (pointerGainPxPerDeg: dead zone, then the
 * acceleration) but never above verticalMaxPxDeg x sensitivity. Below about 75 deg/s it is identical to the horizontal gain, so slow
 * vertical aiming is exactly as before; above it the gain is flat, so that a fast leg and a slow leg through the same elevation angle
 * move the cursor by about the same number of pixels and the cursor height cannot sink to an edge during continuous slashing.
 */
export function verticalGainPxPerDeg(s, sensitivity, cfg) {
  return Math.min(pointerGainPxPerDeg(s, sensitivity, cfg), sensitivity * cfg.verticalMaxPxDeg);
}

export class RelativePointer {
  /**
   * @param {typeof import('./motion-config.js').MOTION_CONFIG.pointer} cfg
   * @param {(kind:'auto', t:number) => void} onRecenter called when the idle centring arrives after a real glide
   */
  constructor(cfg, onRecenter) {
    this.cfg = cfg;
    this.onRecenter = onRecenter;
    /** Result of the last update(); one REUSED object, copy what you keep. */
    this.out = {
      x0: FIELD.cx, y0: FIELD.cy, vx0: 0, vy0: 0, s0: 0, t0: 0, // the previous accepted sample
      x1: FIELD.cx, y1: FIELD.cy, vx1: 0, vy1: 0, s1: 0, // this sample (x1, y1 already include the centring step)
      ax: 0, ay: 0, // (v1 - v0) / dt, px/s^2 (0 without an interval)
      haveInterval: false, // false: first sample or a hole, nothing was integrated
      carried: false, carryDx: 0, carryDy: 0, // the idle centring moved the cursor by (carryDx, carryDy) on this sample
    };
    this.reset();
  }

  /** Cursor to the centre, velocity memory and idle timers cleared. */
  reset() {
    this.x = FIELD.cx;
    this.y = FIELD.cy;
    this.clearMotion();
  }

  /** Forget the velocity memory (the next update() integrates nothing) and the idle state. The position stays. */
  clearMotion() {
    this.vx = 0;
    this.vy = 0;
    this.s = 0;
    this.tPrev = 0;
    this.ax = 0;
    this.ay = 0;
    this.have = false;
    this._stopCentring();
  }

  /** Put the cursor somewhere (clamped) without touching the velocity memory. */
  setPosition(x, y) {
    this.x = clamp(x, 0, FIELD.w);
    this.y = clamp(y, 0, FIELD.h);
    this._stopCentring();
  }

  _stopCentring() {
    this.idleFor = 0;
    this.centring = false;
    this.centreStartT = 0;
    this.centreTravel = 0;
  }

  /**
   * Advance by one IMU sample.
   * @param {number} t sample time, ms
   * @param {number|null} dtMs integration step in ms; null = integrate nothing (first sample, a hole, a discontinuity)
   * @param {number} vx1 cursor velocity of THIS sample, px/s
   * @param {number} vy1
   * @param {number} s1 tip speed of this sample, deg/s
   * @param {{autoCenter:boolean, cutting:boolean, sinceCutMs:number}} c state of the cut decision BEFORE this sample
   */
  update(t, dtMs, vx1, vy1, s1, c) {
    const o = this.out;
    const cfg = this.cfg;
    o.x0 = this.x;
    o.y0 = this.y;
    o.vx0 = this.vx;
    o.vy0 = this.vy;
    o.s0 = this.s;
    o.t0 = this.tPrev;
    o.vx1 = vx1;
    o.vy1 = vy1;
    o.s1 = s1;
    o.carried = false;
    o.carryDx = 0;
    o.carryDy = 0;
    o.ax = 0;
    o.ay = 0;
    if (dtMs === null || !(dtMs > 0) || !this.have) {
      // first sample or a hole: nothing moves, the velocity memory restarts from this sample
      o.haveInterval = false;
      this._stopCentring();
      this.vx = vx1;
      this.vy = vy1;
      this.s = s1;
      this.ax = 0;
      this.ay = 0;
      this.tPrev = t;
      this.have = true;
      o.x1 = this.x;
      o.y1 = this.y;
      return o;
    }
    const dt = dtMs / 1000;
    // trapezoid rule: the cursor velocity is linear in time over the step
    let ex = clamp(this.x + 0.5 * (this.vx + vx1) * dt, 0, FIELD.w);
    let ey = clamp(this.y + 0.5 * (this.vy + vy1) * dt, 0, FIELD.h);

    // idle soft auto-centre (contract 2.3): never while cutting, stops the moment the sword moves
    if (c.autoCenter && !c.cutting && c.sinceCutMs >= cfg.quietMs) {
      if (!this.centring) {
        if (s1 < cfg.idleDps) {
          this.idleFor += dt;
          if (this.idleFor >= cfg.idleHoldS) {
            this.centring = true;
            this.centreStartT = t;
            this.centreTravel = 0;
          }
        } else {
          this.idleFor = 0;
        }
      } else if (s1 > cfg.idleBreakDps) {
        this._stopCentring();
      }
    } else {
      this._stopCentring();
    }
    if (this.centring) {
      const dx = FIELD.cx - ex;
      const dy = FIELD.cy - ey;
      const d = Math.hypot(dx, dy);
      if (d > 0.5) {
        const ramp = Math.min(1, (t - this.centreStartT) / cfg.centreRampMs);
        const speed = clamp(cfg.centreGain * d, cfg.centreMinPxS, cfg.centreMaxPxS) * ramp;
        const step = Math.min(d, speed * dt);
        if (step > 0) {
          o.carryDx = (dx / d) * step;
          o.carryDy = (dy / d) * step;
          ex += o.carryDx;
          ey += o.carryDy;
          o.carried = true;
          this.centreTravel += step;
        }
        if (d - step <= 0.5) this._arrived(t);
      } else {
        this._arrived(t);
      }
    }

    o.haveInterval = true;
    o.ax = (vx1 - this.vx) / dt;
    o.ay = (vy1 - this.vy) / dt;
    this.ax = o.ax;
    this.ay = o.ay;
    this.x = ex;
    this.y = ey;
    this.vx = vx1;
    this.vy = vy1;
    this.s = s1;
    this.tPrev = t;
    o.x1 = ex;
    o.y1 = ey;
    return o;
  }

  /** The centring reached the centre: announce it once if the cursor really travelled (not for tremor-sized corrections). */
  _arrived(t) {
    if (this.centreTravel >= this.cfg.centreArriveEventPx) this.onRecenter('auto', t);
    this.centreTravel = 0;
  }
}

// ---------------------------------------------------------------------------------------------------- the path of one interval

/**
 * Position at time `tauS` seconds into an interval (contract 2.5): quadratic, i.e. the velocity is linear in time from (vx0, vy0)
 * to (vx1, vy1); each point is clamped to the playfield; the centring displacement of the interval (carry) is spread linearly so
 * that the path still ends exactly at (x1, y1).
 * @param {RelativePointer['out']} o
 * @param {number} tauS
 * @param {number} dtS the physical length of the interval, seconds
 * @param {{x:number,y:number}} out
 */
export function pathPoint(o, tauS, dtS, out) {
  const kx = (o.vx1 - o.vx0) / dtS;
  const ky = (o.vy1 - o.vy0) / dtS;
  const share = tauS / dtS;
  out.x = clamp(clamp(o.x0 + o.vx0 * tauS + 0.5 * kx * tauS * tauS, 0, FIELD.w) + o.carryDx * share, 0, FIELD.w);
  out.y = clamp(clamp(o.y0 + o.vy0 * tauS + 0.5 * ky * tauS * tauS, 0, FIELD.h) + o.carryDy * share, 0, FIELD.h);
  return out;
}

/**
 * The collision chords of one interval (contract 2.5 item 1): n = clamp(ceil(len / maxChordPx), 1, maxSubSteps) sub-steps uniform
 * in time, contiguous, the last one ending exactly at (x1, y1). `speed` is the interpolated tip speed at the end of the chord in
 * px/s-equivalent (deg/s x aimPxPerDps). Chords are returned unfiltered (the pipeline drops the ones shorter than minChordPx).
 * @param {RelativePointer['out']} o
 * @param {number} tStartMs sample time of the interval start
 * @param {number} tEndMs sample time of the interval end
 * @param {number} dtMs physical length of the interval
 * @param {{pointer:object, cut:object}} cfg MOTION_CONFIG
 * @returns {Array<{t0:number,x0:number,y0:number,t1:number,x1:number,y1:number,speed:number,swingId:number}>}
 */
export function planChords(o, tStartMs, tEndMs, dtMs, cfg) {
  const dtS = dtMs / 1000;
  const len = Math.max(Math.hypot(o.x1 - o.x0, o.y1 - o.y0), 0.5 * (Math.hypot(o.vx0, o.vy0) + Math.hypot(o.vx1, o.vy1)) * dtS);
  const n = clamp(Math.ceil(len / cfg.pointer.maxChordPx), 1, cfg.pointer.maxSubSteps);
  const k = cfg.cut.aimPxPerDps;
  const span = tEndMs - tStartMs;
  const chords = [];
  const p = { x: 0, y: 0 };
  let px = o.x0;
  let py = o.y0;
  let pt = tStartMs;
  for (let j = 1; j <= n; j += 1) {
    const u = j / n;
    let x;
    let y;
    if (j === n) {
      x = o.x1;
      y = o.y1;
    } else {
      pathPoint(o, u * dtS, dtS, p);
      x = p.x;
      y = p.y;
    }
    const t1 = j === n ? tEndMs : tStartMs + span * u;
    chords.push({ t0: pt, x0: px, y0: py, t1, x1: x, y1: y, speed: Math.max(1e-3, (o.s0 + (o.s1 - o.s0) * u) * k), swingId: 0 });
    px = x;
    py = y;
    pt = t1;
  }
  return chords;
}

/**
 * The interpolated points of one interval for the trail ring (contract 2.5 item 2): m = clamp(ceil(dt / trailStepMs), 1, maxTrailSteps)
 * points uniform in time, the real sample being the m-th; returns the m - 1 interpolated ones (none when m = 1).
 * @returns {Array<{t:number,x:number,y:number,vx:number,vy:number,s:number}>}
 */
export function planTrail(o, tStartMs, tEndMs, dtMs, cfg) {
  const m = clamp(Math.ceil(dtMs / cfg.pointer.trailStepMs), 1, cfg.pointer.maxTrailSteps);
  const dtS = dtMs / 1000;
  const span = tEndMs - tStartMs;
  const out = [];
  const p = { x: 0, y: 0 };
  for (let j = 1; j < m; j += 1) {
    const u = j / m;
    pathPoint(o, u * dtS, dtS, p);
    out.push({
      t: tStartMs + span * u,
      x: p.x,
      y: p.y,
      vx: o.vx0 + (o.vx1 - o.vx0) * u,
      vy: o.vy0 + (o.vy1 - o.vy0) * u,
      s: o.s0 + (o.s1 - o.s0) * u,
    });
  }
  return out;
}

/**
 * Head position at `nowMs` for drawing only, never for collision (contract 2.5 item 3): the newest real sample extrapolated up to
 * extrapolateMaxMs with the last measured acceleration, never letting the velocity reverse.
 * @param {{x:number,y:number,t:number}} b newest real sample
 * @param {{vx:number,vy:number,ax:number,ay:number}} h its velocity and acceleration (px/s, px/s^2)
 * @param {number} nowMs
 * @param {typeof import('./motion-config.js').MOTION_CONFIG.pointer} cfg
 */
export function extrapolateHead(b, h, nowMs, cfg) {
  const ext = clamp(nowMs - b.t, 0, cfg.extrapolateMaxMs) / 1000;
  if (!(ext > 0)) return { x: b.x, y: b.y };
  const v = Math.hypot(h.vx, h.vy);
  const along = h.ax * h.vx + h.ay * h.vy; // a . v
  let tt = ext;
  if (along < 0 && v > 1e-9) tt = Math.min(ext, v / (-along / v)); // decelerating: stop when the velocity would reverse
  return {
    x: clamp(b.x + h.vx * tt + 0.5 * h.ax * tt * tt, 0, FIELD.w),
    y: clamp(b.y + h.vy * tt + 0.5 * h.ay * tt * tt, 0, FIELD.h),
  };
}

export { smoothstep };
