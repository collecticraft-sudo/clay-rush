// Orientation -> screen mapping, references, soft re-centring, edge slip. OWNER: motion engineer.
//
// Mapping (docs/architecture.md 3.3), with ppd = 27.4 * sensitivity and dYaw wrapped to (-180, 180]:
//     x = 960 + (flipX ? -1 : 1) * dYaw * ppd        (yaw to the right moves the cursor right)
//     y = 540 - dPitch * ppd                          (pointing up moves the cursor up)
// then clamped to the playfield. dYaw/dPitch are the raw aim angles minus the references yawRef/pitchRef.
//
// The references move in three ways, all designed never to fight a swing (docs/game-design.md 8.3):
//   * manual  : recenter() snaps them to the current aim; the cursor eases to the centre over recenterEaseMs and the
//               eased samples are flagged discontinuity (no cutting during the ease).
//   * auto    : at rest (angular speed < restDegPerS for restHoldS, no CUTTING for cutQuietMs) the references slew towards
//               the aim at slewDegPerS, i.e. the cursor drifts to the centre and yaw drift is absorbed. It stops above
//               restBreakDegPerS and never runs while cutting.
//   * edge    : raw aim beyond the playfield by more than edgeSlipDeg for edgeSlipHoldS drags the references at
//               edgeSlipDegPerS until the cursor is back inside, so drift can never pin the cursor to an edge.
//               Suspended while cutting.
// All of these constants are STARTING VALUES, UNVERIFIED-ON-HARDWARE (HW-3).
//
// Who moved the cursor (round 2 finding R2-01): a sample whose position changed because the REFERENCES moved (soft centring, edge
// slip, the recentre ease) and not because the sword moved is reported as `out.refsMoved`. The menu's dwell selection uses it so
// that a cursor the reference dragged onto a target never starts that target's dwell timer.

import { FIELD } from '../shared/playfield.js';
import { clamp, wrapDeg } from './vec.js';

const smoothstep = (x) => {
  const c = clamp(x, 0, 1);
  return c * c * (3 - 2 * c);
};

export class AimMapper {
  /**
   * @param {typeof import('./motion-config.js').MOTION_CONFIG.input} cfg
   * @param {(kind:'auto'|'edge', t:number) => void} onRecenter called when an automatic mechanism announces itself
   */
  constructor(cfg, onRecenter) {
    this.cfg = cfg;
    this.onRecenter = onRecenter;
    this.reset();
  }

  /** Clear references and timers. The next map() call adopts the current yaw as centre and pitch 0 (level) as centre. */
  reset() {
    this.hasRefs = false;
    this.yawRef = 0;
    this.pitchRef = 0;
    this.prevT = null;
    this.ease = { active: false, startT: 0, fromX: FIELD.cx, fromY: FIELD.cy };
    this.restSince = null;
    this.autoSlewing = false;
    this.autoTravelDeg = 0;
    this.edgeSince = null;
    this.edgeActive = false;
  }

  /** Set the references to an absolute raw aim (calibration step 3). No ease. */
  setRefs(yawDeg, pitchDeg) {
    this.yawRef = yawDeg;
    this.pitchRef = pitchDeg;
    this.hasRefs = true;
    this.ease.active = false;
    this._resetTimers();
  }

  /**
   * Manual recentre: the current aim becomes the screen centre and the cursor eases from (fromX, fromY) to it.
   * @param {number} t sample-clock time of the recentre
   */
  recenter(t, yawDeg, pitchDeg, fromX, fromY) {
    this.setRefs(yawDeg, pitchDeg);
    this.ease.active = this.cfg.recenterEaseMs > 0;
    this.ease.startT = t;
    this.ease.fromX = fromX;
    this.ease.fromY = fromY;
  }

  _resetTimers() {
    this.restSince = null;
    this.autoSlewing = false;
    this.autoTravelDeg = 0;
    this.edgeSince = null;
    this.edgeActive = false;
  }

  /**
   * Map one raw aim (deg) at time t to a playfield position. Writes {x, y, discontinuity, refsMoved, yawDeg, pitchDeg} into `out`.
   * `refsMoved` is true while the references carry the cursor (auto centring on its way to the centre, edge slip) or the recentre
   * ease is running: the cursor position then partly comes from the references and not from the sword. It is false once the
   * slew has arrived and the references merely follow the aim.
   * @param {number} yawDeg raw absolute yaw of the aim direction
   * @param {number} pitchDeg raw absolute pitch
   * @param {number} t sample time, ms
   * @param {{angularSpeedDps:number, cutting:boolean, sinceCutMs:number, sensitivity:number, flipX:boolean, autoCenter:boolean}} c
   */
  map(yawDeg, pitchDeg, t, c, out) {
    const cfg = this.cfg;
    if (!this.hasRefs) {
      this.yawRef = yawDeg;
      this.pitchRef = 0;
      this.hasRefs = true;
    }
    const dt = this.prevT === null ? 0 : clamp((t - this.prevT) / 1000, 0, 0.05);
    this.prevT = t;
    const ppd = cfg.pxPerDegBase * c.sensitivity;
    const fx = c.flipX ? -1 : 1;

    let dYaw = wrapDeg(yawDeg - this.yawRef);
    let dPitch = pitchDeg - this.pitchRef;
    let ux = FIELD.cx + fx * dYaw * ppd;
    let uy = FIELD.cy - dPitch * ppd;

    // ---- edge slip (suspended while cutting) ----
    const exPx = ux < 0 ? ux : ux > FIELD.w ? ux - FIELD.w : 0;
    const eyPx = uy < 0 ? uy : uy > FIELD.h ? uy - FIELD.h : 0;
    const overDeg = Math.max(Math.abs(exPx), Math.abs(eyPx)) / ppd;
    let refsMoved = false;
    let carried = false; // the references are dragging the cursor itself (not only following a resting or drifting sword)
    if (c.cutting) {
      this.edgeSince = null;
      this.edgeActive = false;
    } else if (!this.edgeActive) {
      if (overDeg > cfg.edgeSlipDeg) {
        if (this.edgeSince === null) this.edgeSince = t;
        else if (t - this.edgeSince >= cfg.edgeSlipHoldS * 1000) {
          this.edgeActive = true;
          this.onRecenter('edge', t);
        }
      } else {
        this.edgeSince = null;
      }
    } else if (overDeg <= 0) {
      this.edgeActive = false;
      this.edgeSince = null;
    }
    if (this.edgeActive) {
      const step = cfg.edgeSlipDegPerS * dt;
      if (exPx !== 0) this.yawRef += fx * Math.sign(exPx) * Math.min(Math.abs(exPx) / ppd, step);
      if (eyPx !== 0) this.pitchRef -= Math.sign(eyPx) * Math.min(Math.abs(eyPx) / ppd, step);
      refsMoved = true;
      carried = true;
    }

    // ---- automatic soft centring ----
    if (!c.autoCenter || c.cutting || c.sinceCutMs < cfg.cutQuietMs || this.edgeActive) {
      this.restSince = null;
      this.autoSlewing = false;
      this.autoTravelDeg = 0;
    } else {
      const w = c.angularSpeedDps;
      if (!this.autoSlewing) {
        if (w < cfg.restDegPerS) {
          if (this.restSince === null) this.restSince = t;
          else if (t - this.restSince >= cfg.restHoldS * 1000) this.autoSlewing = true;
        } else {
          this.restSince = null;
        }
      } else if (w > cfg.restBreakDegPerS) {
        this.autoSlewing = false;
        this.restSince = null;
        this.autoTravelDeg = 0;
      }
      if (this.autoSlewing) {
        const d = Math.hypot(dYaw, dPitch);
        if (d > 1e-9) {
          const step = Math.min(d, cfg.slewDegPerS * dt);
          this.yawRef += (dYaw / d) * step;
          this.pitchRef += (dPitch / d) * step;
          this.autoTravelDeg += step;
          refsMoved = true;
          // step < d: the cursor is still being carried towards the centre. step >= d: the references only follow the aim (the
          // cursor is held at the centre against noise and slow drift); that is not reference motion the player could mistake
          if (step < d) carried = true;
          if (step >= d) {
            // arrived at the centre; announce only if the cursor really travelled (not for tremor-sized corrections)
            if (this.autoTravelDeg >= 0.5) this.onRecenter('auto', t);
            this.autoTravelDeg = 0;
          }
        }
      }
    }

    if (refsMoved) {
      dYaw = wrapDeg(yawDeg - this.yawRef);
      dPitch = pitchDeg - this.pitchRef;
      ux = FIELD.cx + fx * dYaw * ppd;
      uy = FIELD.cy - dPitch * ppd;
    }

    // ---- manual recentre ease ----
    let discontinuity = false;
    if (this.ease.active) {
      const el = t - this.ease.startT;
      if (el >= cfg.recenterEaseMs) {
        this.ease.active = false;
      } else {
        const e = smoothstep(el / cfg.recenterEaseMs);
        const tx = clamp(ux, 0, FIELD.w);
        const ty = clamp(uy, 0, FIELD.h);
        ux = this.ease.fromX + (tx - this.ease.fromX) * e;
        uy = this.ease.fromY + (ty - this.ease.fromY) * e;
        discontinuity = true;
      }
    }

    out.x = clamp(ux, 0, FIELD.w);
    out.y = clamp(uy, 0, FIELD.h);
    out.discontinuity = discontinuity;
    out.refsMoved = carried || discontinuity; // discontinuity here is only ever the running recentre ease
    out.yawDeg = dYaw;
    out.pitchDeg = dPitch;
    return out;
  }
}
