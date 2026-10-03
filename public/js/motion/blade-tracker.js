// Blade tracker: speed, cut-state hysteresis, swing ids, segment merging, safety cap. OWNER: motion engineer.
// Rules are NORMATIVE (docs/architecture.md 6.3, docs/game-design.md 5.1 and 5.2). One tracker serves the IMU path, the
// mouse path and the debug swing, so there is exactly one place where the cut threshold is applied.
//
// Per input sample at position P (px, already clamped) and time t:
//   1. speed  = length of the polyline through all retained samples with time >= t - 50 ms (at least the last two samples)
//               divided by their time span.
//   2. cap    = a step implying more than the safety cap is a glitch: the cursor follows it but it never feeds the speed
//               window or a segment (the window restarts at that sample so the jump cannot inflate the next speeds).
//   3. state  = CUTTING is entered at speed >= T and left below releaseRatio * T. A re-entry within swingGraceMs of leaving
//               keeps the swingId, otherwise swingId += 1. A discontinuity always forces a new swing.
//   4. segments: while not cutting the anchor follows every sample. While cutting a sample is a valid segment when it is at
//               least mergeSegmentPx from the anchor; otherwise the movement accumulates until mergeFlushMs has passed, when
//               it is dropped as rest jitter. The segment ending at the sample where CUTTING is entered is eligible.
//
// No smoothing is applied to the position (zero added lag). The 50 ms window only affects the speed used for the state.
//
// UNVERIFIED-ON-HARDWARE: whether 1000 px/s (about 36 deg/s) separates deliberate swings from aiming and hand tremor (HW-9),
// the 0.65 release ratio, and the 2190 deg/s safety cap against the real gyro range and saturation (HW-10) are starting values
// taken from the design, tuned only against synthetic motion.

export class BladeTracker {
  /** @param {typeof import('./motion-config.js').MOTION_CONFIG.cut} cut  @param {{historySize?:number}} [opts] */
  constructor(cut, opts = {}) {
    this.cut = cut;
    this.cap = Math.max(8, opts.windowCapacity ?? 64);
    // ring of the samples inside the speed window
    this._t = new Float64Array(this.cap);
    this._x = new Float64Array(this.cap);
    this._y = new Float64Array(this.cap);
    this._len = new Float64Array(this.cap); // step length from the previous window entry
    this._head = 0; // index of the oldest entry
    this._count = 0;
    this._pathLen = 0;

    this.out = {
      speed: 0,
      cutting: false,
      swingId: 0,
      segmentValid: false,
      x0: 0,
      y0: 0,
      t0: 0,
      glitch: false,
      discontinuity: false,
    };
    this.reset();
  }

  /** Forget everything (also the swing counter). */
  reset() {
    this._head = 0;
    this._count = 0;
    this._pathLen = 0;
    this.have = false;
    this.cutting = false;
    this.swingId = 0;
    this.lastLeftT = -Infinity;
    this.lastCuttingT = -Infinity;
    this.forceNewSwing = true;
    this.speed = 0;
    this.prevT = 0;
    this.prevX = 0;
    this.prevY = 0;
    this.anchorX = 0;
    this.anchorY = 0;
    this.anchorT = 0;
    this.glitches = 0;
  }

  _restartWindow(t, x, y) {
    this._head = 0;
    this._count = 1;
    this._t[0] = t;
    this._x[0] = x;
    this._y[0] = y;
    this._len[0] = 0;
    this._pathLen = 0;
  }

  _push(t, x, y) {
    if (this._count === this.cap) this._popOldest(); // capacity guard (never hit below 1 kHz)
    const last = (this._head + this._count - 1) % this.cap;
    const idx = (this._head + this._count) % this.cap;
    const step = Math.hypot(x - this._x[last], y - this._y[last]);
    this._t[idx] = t;
    this._x[idx] = x;
    this._y[idx] = y;
    this._len[idx] = step;
    this._pathLen += step;
    this._count += 1;
  }

  _popOldest() {
    this._head = (this._head + 1) % this.cap;
    this._count -= 1;
    this._pathLen -= this._len[this._head]; // the new oldest no longer has a predecessor
    this._len[this._head] = 0;
    if (this._pathLen < 0) this._pathLen = 0;
  }

  /**
   * Feed one sample. Returns a REUSED result object (copy what you keep).
   * @param {{t:number, x:number, y:number, discontinuity:boolean, capPxPerS:number, dtMs?:number|null}} s
   * @param {number} thresholdPxPerS effective T = cutThreshold * cutMul, re-read on every sample
   */
  update(s, thresholdPxPerS) {
    const cfg = this.cut;
    const out = this.out;
    const T = thresholdPxPerS;
    // time never goes backwards inside the tracker
    const t = this.have && s.t < this.prevT ? this.prevT : s.t;
    const { x, y } = s;
    out.glitch = false;
    out.segmentValid = false;

    if (s.discontinuity || !this.have) {
      const wasCutting = this.cutting;
      this._restartWindow(t, x, y);
      this.cutting = false;
      if (wasCutting) this.lastLeftT = t;
      this.forceNewSwing = true;
      this.speed = 0;
      this.anchorX = x;
      this.anchorY = y;
      this.anchorT = t;
      this.have = true;
      this.prevT = t;
      this.prevX = x;
      this.prevY = y;
      this._finish(out, x, y, t, !!s.discontinuity); // the very first sample has nothing to break away from
      return out;
    }

    // 2. safety cap on the step from the previous sample
    // the step is measured against the device step when the caller knows it (bursty arrival times would fake huge speeds)
    const dtStepMs = Math.max(s.dtMs > 0 ? s.dtMs : t - this.prevT, 0.5);
    const step = Math.hypot(x - this.prevX, y - this.prevY);
    if ((step * 1000) / dtStepMs > s.capPxPerS) {
      this.glitches += 1;
      out.glitch = true;
      this._restartWindow(t, x, y);
      this.anchorX = x;
      this.anchorY = y;
      this.anchorT = t;
      this.prevT = t;
      this.prevX = x;
      this.prevY = y;
      this._finish(out, x, y, t, false);
      return out;
    }

    // 1. speed over the retained window
    this._push(t, x, y);
    while (this._count > 2 && this._t[this._head] < t - cfg.speedWindowMs) this._popOldest();
    const span = t - this._t[this._head];
    if (span > 0) this.speed = (this._pathLen * 1000) / span;

    // 3. cut state with hysteresis
    if (!this.cutting) {
      if (this.speed >= T) {
        this.cutting = true;
        if (this.forceNewSwing || this.swingId === 0 || t - this.lastLeftT > cfg.swingGraceMs) {
          this.swingId += 1;
          this.forceNewSwing = false;
        }
      }
    } else if (this.speed < cfg.releaseRatio * T) {
      this.cutting = false;
      this.lastLeftT = t;
    }

    // 4. segments
    if (this.cutting) {
      const dist = Math.hypot(x - this.anchorX, y - this.anchorY);
      if (dist >= cfg.mergeSegmentPx) {
        out.segmentValid = true;
        out.x0 = this.anchorX;
        out.y0 = this.anchorY;
        out.t0 = this.anchorT;
        this.anchorX = x;
        this.anchorY = y;
        this.anchorT = t;
      } else if (t - this.anchorT >= cfg.mergeFlushMs) {
        this.anchorX = x; // rest jitter, dropped
        this.anchorY = y;
        this.anchorT = t;
      }
    } else {
      this.anchorX = x;
      this.anchorY = y;
      this.anchorT = t;
    }

    this.prevT = t;
    this.prevX = x;
    this.prevY = y;
    this._finish(out, x, y, t, false);
    return out;
  }

  _finish(out, x, y, t, discontinuity) {
    out.speed = this.speed;
    out.cutting = this.cutting;
    out.swingId = this.swingId;
    out.discontinuity = discontinuity;
    if (this.cutting) this.lastCuttingT = t;
    if (!out.segmentValid) {
      out.x0 = x;
      out.y0 = y;
      out.t0 = t;
    }
  }

  /** Leave the cutting state without a position (tracking lost). The next real sample must be a discontinuity. */
  dropCutting(t) {
    if (this.cutting) this.lastLeftT = t;
    this.cutting = false;
    this.speed = 0;
    this.forceNewSwing = true;
  }
}
