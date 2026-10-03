// Angular cut tracker of the relative model: the decision to slice is made in TIP speed (deg/s), independent of the sensitivity,
// with hysteresis, a minimum duration and a retroactive first chord. OWNER: motion engineer. Pure module.
//
// Contract: docs/motion-contract.md 2.4. Evidence: docs/motion-findings.md 6, 7, 10.1 (one real Joy-Con 2 Right recording:
// the owner's aiming peaks at 326 deg/s, his 21 hard strokes at 632 to 1049 deg/s; 300 deg/s is the lowest round threshold with no
// false cut and every stroke recognised). The px tracker (blade-tracker.js) keeps serving the aim path and the simulator.
//
// Per sample at time t with tip speed s, T = cutThreshold x cutMul, R = releaseRatio x T:
//   discontinuity  cutting = false, the candidate is dropped, the next swing is a new swing, no segment is emitted
//   not cutting    s >= T starts a CANDIDATE (its chords, and the trail samples of its intervals, are held back); a second sample at
//                  or above T at least minDurationMs after the first one ENTERS the cut; a dip that stays at or above R keeps the
//                  candidate for up to candidateMaxMs; anything else drops it. A single sample above T never cuts.
//   cutting        stays until a sample below R.
//   ENTER          the held chords plus the chords of the current interval are delivered at once (the cut is recognised one
//                  sample late, the first chord is delivered retroactively); a re-entry within swingGraceMs keeps the swingId.
// The chord of the interval that ENDS at the leaving sample is not delivered (segmentValid => cutting, the contract invariant).
//
// UNVERIFIED-ON-HARDWARE: the numbers come from one recording of one controller and one person (risks R1, R2, R9).

export class AngularCutTracker {
  /** @param {typeof import('./motion-config.js').MOTION_CONFIG.cut} cut */
  constructor(cut) {
    this.cut = cut;
    /** Result of the last update(); reused object, copy what you keep. */
    this.out = { cutting: false, swingId: 0, entered: false, left: false, discontinuity: false, segments: [], cutTrail: [] };
    this.reset();
  }

  /** Forget everything (also the swing counter). */
  reset() {
    this.cutting = false;
    this.swingId = 0;
    this.lastLeftT = -Infinity;
    this.lastCuttingT = -Infinity;
    this.forceNewSwing = true;
    this.cand = null; // {tAbove, chords: [], trail: []}
    this.glitches = 0;
  }

  /**
   * Feed one sample.
   * @param {number} t sample time, ms (never goes backwards: the caller clamps it)
   * @param {number} s tip speed, deg/s
   * @param {number} T effective threshold in deg/s (cutThreshold x cutMul), re-read on every sample
   * @param {boolean} discontinuity the trail breaks at this sample
   * @param {Array<object>} chords the collision chords of the interval that ends at this sample (empty without an interval)
   * @param {Array<object>} trail the interpolated ring samples of that interval (objects that the caller already put in the ring)
   * @returns result: `segments` = chords to deliver now (held ones first), `cutTrail` = ring samples that belong to the cut (the
   *   caller marks them cutting with `swingId`), `entered`, `left`, `cutting` (state after this sample), `swingId`
   */
  update(t, s, T, discontinuity, chords, trail) {
    const cfg = this.cut;
    const out = this.out;
    out.entered = false;
    out.left = false;
    out.discontinuity = discontinuity;
    out.segments = [];
    out.cutTrail = [];

    if (discontinuity) {
      if (this.cutting) {
        this.lastLeftT = t;
        out.left = true;
      }
      this.cutting = false;
      this.cand = null;
      this.forceNewSwing = true;
      out.cutting = false;
      out.swingId = this.swingId;
      return out;
    }

    const R = cfg.releaseRatio * T;
    let enter = false;
    if (!this.cutting) {
      if (s >= T) {
        if (this.cand === null) this.cand = { tAbove: t, chords: [], trail: [] };
        if (t - this.cand.tAbove >= cfg.minDurationMs) enter = true;
      } else if (this.cand !== null && s >= R && t - this.cand.tAbove < cfg.candidateMaxMs) {
        // a dip that stays above the release level keeps the candidate
      } else {
        this.cand = null;
      }
      if (enter) {
        const held = this.cand;
        this.cand = null;
        this.cutting = true;
        out.entered = true;
        if (this.forceNewSwing || this.swingId === 0 || t - this.lastLeftT > cfg.swingGraceMs) {
          this.swingId += 1;
          this.forceNewSwing = false;
        }
        out.segments = held.chords.concat(chords);
        out.cutTrail = held.trail.concat(trail);
      } else if (this.cand !== null) {
        for (const c of chords) this.cand.chords.push(c);
        for (const p of trail) this.cand.trail.push(p);
      }
    } else if (s < R) {
      this.cutting = false;
      this.lastLeftT = t;
      out.left = true;
    } else {
      out.segments = chords;
      out.cutTrail = trail;
    }
    if (this.cutting) this.lastCuttingT = t;
    out.cutting = this.cutting;
    out.swingId = this.swingId;
    return out;
  }

  /** Leave the cutting state without a position (tracking lost). The next real sample must be a discontinuity. */
  dropCutting(t) {
    if (this.cutting) this.lastLeftT = t;
    this.cutting = false;
    this.cand = null;
    this.forceNewSwing = true;
  }
}
