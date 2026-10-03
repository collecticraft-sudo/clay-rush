// Clocks. OWNER: architect (frozen). Every module takes a Clock instead of calling performance.now() directly,
// so the whole game can run on a manual clock (?clock=manual) and tests are deterministic.

/** @returns {import('./contracts.js').Clock} real clock, ms, monotonic. */
export function createRealClock(perf = globalThis.performance) {
  const p = perf ?? { now: () => Date.now() };
  return { now: () => p.now(), manual: false };
}

/**
 * Manual clock: time only moves through advance(ms).
 * @param {number} [start]
 * @returns {import('./contracts.js').Clock & {advance:(ms:number)=>void, set:(ms:number)=>void}}
 */
export function createManualClock(start = 0) {
  let t = start;
  return {
    manual: true,
    now: () => t,
    advance(ms) {
      if (!(ms >= 0) || !Number.isFinite(ms)) throw new RangeError(`advance(${ms}): ms must be a finite number >= 0`);
      t += ms;
    },
    set(ms) {
      if (ms < t) throw new RangeError('manual clock cannot go backwards');
      t = ms;
    },
  };
}
