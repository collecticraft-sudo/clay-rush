// Tiny 3-vector helpers on plain {x,y,z} objects. OWNER: motion engineer. Pure, no globals.
// Allocation-free variants are not needed here: the per-sample hot path in fusion.js uses scalar maths directly.

export const DEG = 180 / Math.PI;
export const RAD = Math.PI / 180;

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/** Wrap an angle in degrees to (-180, 180]. */
export function wrapDeg(d) {
  let a = d % 360;
  if (a > 180) a -= 360;
  else if (a <= -180) a += 360;
  return a;
}

export const v3 = (x = 0, y = 0, z = 0) => ({ x, y, z });
export const vClone = (a) => ({ x: a.x, y: a.y, z: a.z });
export const vAdd = (a, b) => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
export const vSub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
export const vScale = (a, s) => ({ x: a.x * s, y: a.y * s, z: a.z * s });
export const vDot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
export const vCross = (a, b) => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
export const vLen = (a) => Math.hypot(a.x, a.y, a.z);

/** Unit vector, or the zero vector when the input is (numerically) zero. */
export function vNormalize(a) {
  const n = Math.hypot(a.x, a.y, a.z);
  if (n < 1e-12) return { x: 0, y: 0, z: 0 };
  return { x: a.x / n, y: a.y / n, z: a.z / n };
}

/** Angle between two vectors in degrees, numerically stable for tiny and near-180 angles. 0 if either is zero. */
export function vAngleDeg(a, b) {
  const c = vCross(a, b);
  const s = Math.hypot(c.x, c.y, c.z);
  const d = vDot(a, b);
  if (s === 0 && d === 0) return 0;
  return Math.atan2(s, d) * DEG;
}

/** Cosine of the angle between two vectors; 0 if either is (numerically) zero. */
export function vCos(a, b) {
  const na = vLen(a);
  const nb = vLen(b);
  if (na < 1e-12 || nb < 1e-12) return 0;
  return vDot(a, b) / (na * nb);
}

/** Any unit vector perpendicular to the unit vector `a`. */
export function vPerpendicular(a) {
  const ax = Math.abs(a.x);
  const ay = Math.abs(a.y);
  const az = Math.abs(a.z);
  const helper = ax <= ay && ax <= az ? { x: 1, y: 0, z: 0 } : ay <= az ? { x: 0, y: 1, z: 0 } : { x: 0, y: 0, z: 1 };
  return vNormalize(vCross(a, helper));
}
