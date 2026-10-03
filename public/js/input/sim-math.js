// Tiny vector and quaternion helpers of the simulator. OWNER: input engineer.
//
// Private to input/ (the import rules forbid using the Motion engineer's helpers). Vectors are [x, y, z] arrays,
// quaternions are [w, x, y, z] and a rotation matrix is given as its three COLUMN vectors. Pure functions, no globals.

export const DEG = Math.PI / 180;

export const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross3 = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const add3 = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub3 = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale3 = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
export const len3 = (a) => Math.hypot(a[0], a[1], a[2]);
export const normalize3 = (a) => {
  const l = len3(a);
  return l > 0 ? scale3(a, 1 / l) : [0, 0, 0];
};
export const toVec = (a) => ({ x: a[0] + 0, y: a[1] + 0, z: a[2] + 0 }); // + 0 turns -0 into 0
export const fromVec = (v) => [v.x, v.y, v.z];

export const Q_IDENTITY = Object.freeze([1, 0, 0, 0]);

export function qMul(a, b) {
  return [
    a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3],
    a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2],
    a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1],
    a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0],
  ];
}
export const qConj = (q) => [q[0], -q[1], -q[2], -q[3]];
export function qNormalize(q) {
  const l = Math.hypot(q[0], q[1], q[2], q[3]);
  return l > 0 ? [q[0] / l, q[1] / l, q[2] / l, q[3] / l] : [1, 0, 0, 0];
}

/** Rotation vector (axis * angle, rad) -> quaternion. */
export function qExp(v) {
  const angle = len3(v);
  if (angle < 1e-12) return qNormalize([1, v[0] / 2, v[1] / 2, v[2] / 2]);
  const half = angle / 2;
  const s = Math.sin(half) / angle;
  return [Math.cos(half), v[0] * s, v[1] * s, v[2] * s];
}

/** Quaternion -> rotation vector of the shortest arc. */
export function qLog(q) {
  let [w, x, y, z] = q;
  if (w < 0) [w, x, y, z] = [-w, -x, -y, -z];
  const vn = Math.hypot(x, y, z);
  if (vn < 1e-12) return [2 * x, 2 * y, 2 * z];
  const angle = 2 * Math.atan2(vn, w);
  const k = angle / vn;
  return [x * k, y * k, z * k];
}

/** Matrix columns of the rotation q (column j = image of the j-th basis vector). */
export function qToColumns(q) {
  const [w, x, y, z] = q;
  return [
    [1 - 2 * (y * y + z * z), 2 * (x * y + w * z), 2 * (x * z - w * y)],
    [2 * (x * y - w * z), 1 - 2 * (x * x + z * z), 2 * (y * z + w * x)],
    [2 * (x * z + w * y), 2 * (y * z - w * x), 1 - 2 * (x * x + y * y)],
  ];
}

export function qFromColumns(c0, c1, c2) {
  const m00 = c0[0], m10 = c0[1], m20 = c0[2];
  const m01 = c1[0], m11 = c1[1], m21 = c1[2];
  const m02 = c2[0], m12 = c2[1], m22 = c2[2];
  const tr = m00 + m11 + m22;
  let w, x, y, z;
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2;
    w = 0.25 * s; x = (m21 - m12) / s; y = (m02 - m20) / s; z = (m10 - m01) / s;
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    w = (m21 - m12) / s; x = 0.25 * s; y = (m01 + m10) / s; z = (m02 + m20) / s;
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    w = (m02 - m20) / s; x = (m01 + m10) / s; y = 0.25 * s; z = (m12 + m21) / s;
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
    w = (m10 - m01) / s; x = (m02 + m20) / s; y = (m12 + m21) / s; z = 0.25 * s;
  }
  return qNormalize([w, x, y, z]);
}

/** Rotate vector v by quaternion q. */
export function qRotate(q, v) {
  const [c0, c1, c2] = qToColumns(q);
  return [
    c0[0] * v[0] + c1[0] * v[1] + c2[0] * v[2],
    c0[1] * v[0] + c1[1] * v[1] + c2[1] * v[2],
    c0[2] * v[0] + c1[2] * v[1] + c2[2] * v[2],
  ];
}

/** Spherical interpolation along the shortest arc. */
export function qSlerp(a, b, t) {
  let cos = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  let bb = b;
  if (cos < 0) {
    cos = -cos;
    bb = [-b[0], -b[1], -b[2], -b[3]];
  }
  if (cos > 0.9995) return qNormalize([a[0] + (bb[0] - a[0]) * t, a[1] + (bb[1] - a[1]) * t, a[2] + (bb[2] - a[2]) * t, a[3] + (bb[3] - a[3]) * t]);
  const theta = Math.acos(cos);
  const sin = Math.sin(theta);
  const wa = Math.sin((1 - t) * theta) / sin;
  const wb = Math.sin(t * theta) / sin;
  return [a[0] * wa + bb[0] * wb, a[1] * wa + bb[1] * wb, a[2] * wa + bb[2] * wb, a[3] * wa + bb[3] * wb];
}

/**
 * Sword orientation from an aim direction and a roll (world frame: x right, y towards the screen, z up).
 * Roll 0 keeps the sword's right axis horizontal (the same convention as docs/architecture.md 3.3, where yaw = atan2(ax, ay)
 * and pitch = asin(az)). Positive roll is right-handed about the sword's forward axis.
 * Returns the quaternion whose columns are the sword axes (right, forward, up) in world coordinates.
 */
export function orientationFromAim(yawDeg, pitchDeg, rollDeg = 0) {
  const yaw = yawDeg * DEG;
  const pitch = pitchDeg * DEG;
  const roll = rollDeg * DEG;
  const sy = Math.sin(yaw), cy = Math.cos(yaw), sp = Math.sin(pitch), cp = Math.cos(pitch);
  const forward = [sy * cp, cy * cp, sp];
  let right = [cy, -sy, 0];
  let up = cross3(right, forward);
  if (roll !== 0) {
    const cr = Math.cos(roll), sr = Math.sin(roll);
    const nr = sub3(scale3(right, cr), scale3(up, sr));
    const nu = add3(scale3(up, cr), scale3(right, sr));
    right = nr;
    up = nu;
  }
  return qFromColumns(right, forward, up);
}

/** Aim angles of an orientation: the sword's forward axis in the world frame. */
export function aimFromOrientation(q) {
  const f = qToColumns(q)[1];
  return { yawDeg: Math.atan2(f[0], f[1]) / DEG, pitchDeg: Math.asin(Math.max(-1, Math.min(1, f[2]))) / DEG };
}

/** Gram-Schmidt: makes a mount frame exactly orthonormal and right-handed (right x forward = up). */
export function orthonormalFrame(frame) {
  const right = normalize3(fromVec(frame.right));
  const f0 = fromVec(frame.forward);
  const forward = normalize3(sub3(f0, scale3(right, dot3(right, f0))));
  const up = cross3(right, forward);
  return { right, forward, up };
}
