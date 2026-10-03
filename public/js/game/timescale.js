// World time scale: hit stop (scale 0) and kill-cam slow motion (design 8). OWNER: Gameplay engineer. Pure.
// Both run on REAL time. The effective scale is the minimum of the active sources; with reduceMotion nothing slows.

import { CONFIG } from './config.js';

export class TimeScaler {
  constructor(reduceMotion = false) {
    this.reduceMotion = Boolean(reduceMotion);
    this.holdMs = 0;
    this.slowMs = 0;
    this.slowScale = 1;
  }

  /** Hit stop: freeze the world for `ms` of real time. Returns the ms actually applied (0 with reduceMotion). */
  hold(ms) {
    if (this.reduceMotion) return 0;
    if (ms > this.holdMs) this.holdMs = ms;
    return ms;
  }

  /** Kill cam slow motion. Returns the duration actually applied in ms (0 with reduceMotion). */
  slow(scale, ms) {
    if (this.reduceMotion) return 0;
    this.slowScale = scale;
    if (ms > this.slowMs) this.slowMs = ms;
    return ms;
  }

  /** Effective scale in [0, 1]. */
  current() {
    if (this.holdMs > 0) return 0;
    if (this.slowMs > 0) return this.slowScale;
    return 1;
  }

  /** Advance the clocks by `ms` of real time. */
  advance(ms) {
    if (this.holdMs > 0) this.holdMs = Math.max(0, this.holdMs - ms);
    if (this.slowMs > 0) this.slowMs = Math.max(0, this.slowMs - ms);
  }

  clear() {
    this.holdMs = 0;
    this.slowMs = 0;
  }
}

export const KILL_CAM = CONFIG.juice.killCam;
