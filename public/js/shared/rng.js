// Seeded random numbers. OWNER: architect (frozen). Pure, no globals, works in Node and the browser.
// Game gameplay randomness NEVER uses Math.random(). Two independent streams (docs/game-design.md 2.8):
//   rngWave(k) = createRng(hash32(seed, k))            everything about wave k
//   rngFx      = createRng(seed ^ SEED_XOR.gameFx)     cosmetic randomness that lives inside the Game (half spin, ...)
// The Presentation makes its own cosmetic stream with createRng(seed ^ SEED_XOR.renderFx).

export const SEED_XOR = Object.freeze({ gameFx: 0x9e3779b9, renderFx: 0x85ebca6b, background: 0xc0ffee });

/** mulberry32: returns a function producing floats in [0, 1). seed is coerced to uint32. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Deterministic uint32 hash of (seed, k) (murmur3 finaliser). Used for per-wave streams. */
export function hash32(seed, k) {
  let h = ((seed >>> 0) ^ Math.imul((k >>> 0) + 1, 0x9e3779b1)) >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

/** Convenience wrapper around mulberry32. */
export function createRng(seed) {
  const next = mulberry32(seed);
  const rng = {
    /** float in [0,1) */
    next,
    /** float in [a,b) */
    range: (a, b) => a + (b - a) * next(),
    /** integer in [a,b] inclusive */
    int: (a, b) => a + Math.floor(next() * (b - a + 1)),
    /** true with probability p */
    chance: (p) => next() < p,
    /** -1 or +1 */
    sign: () => (next() < 0.5 ? -1 : 1),
    pick: (arr) => arr[Math.floor(next() * arr.length)],
    /** index chosen with probability proportional to weights[i] (weights >= 0, not all 0) */
    weightedIndex(weights) {
      let total = 0;
      for (const w of weights) total += w;
      let r = next() * total;
      for (let i = 0; i < weights.length; i++) {
        r -= weights[i];
        if (r < 0) return i;
      }
      return weights.length - 1;
    },
  };
  return rng;
}
