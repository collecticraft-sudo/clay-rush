// Quaternion helpers. OWNER: motion engineer. Pure, no globals.
//
// A quaternion is {w, x, y, z}, unit length. In the orientation filter `q` maps DEVICE coordinates to WORLD coordinates:
// v_W = rotate(q, v_D). Body-frame angular rates are applied on the right: q <- q * exp(omega_D * dt / 2).

export const qIdentity = () => ({ w: 1, x: 0, y: 0, z: 0 });
export const qClone = (q) => ({ w: q.w, x: q.x, y: q.y, z: q.z });
export const qConj = (q) => ({ w: q.w, x: -q.x, y: -q.y, z: -q.z });

/** Normalise in place (falls back to identity for a degenerate quaternion). Returns q. */
export function qNormalize(q) {
  const n = Math.hypot(q.w, q.x, q.y, q.z);
  if (n < 1e-12) {
    q.w = 1;
    q.x = q.y = q.z = 0;
    return q;
  }
  const inv = 1 / n;
  q.w *= inv;
  q.x *= inv;
  q.y *= inv;
  q.z *= inv;
  return q;
}

/** Hamilton product a * b, new object. */
export function qMul(a, b) {
  return {
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
  };
}

/** q <- q * exp(omega * dt / 2) in place, omega in rad/s (body frame), dt in s. Normalises. */
export function qIntegrate(q, wx, wy, wz, dt) {
  const hx = wx * dt * 0.5;
  const hy = wy * dt * 0.5;
  const hz = wz * dt * 0.5;
  const half = Math.hypot(hx, hy, hz);
  let dw;
  let dx;
  let dy;
  let dz;
  if (half < 1e-9) {
    dw = 1;
    dx = hx;
    dy = hy;
    dz = hz;
  } else {
    const s = Math.sin(half) / half;
    dw = Math.cos(half);
    dx = hx * s;
    dy = hy * s;
    dz = hz * s;
  }
  const w = q.w * dw - q.x * dx - q.y * dy - q.z * dz;
  const x = q.w * dx + q.x * dw + q.y * dz - q.z * dy;
  const y = q.w * dy - q.x * dz + q.y * dw + q.z * dx;
  const z = q.w * dz + q.x * dy - q.y * dx + q.z * dw;
  q.w = w;
  q.x = x;
  q.y = y;
  q.z = z;
  return qNormalize(q);
}

/** Rotate vector (vx,vy,vz) by q, writing into `out` (may be reused). Returns out. */
export function qRotateInto(out, q, vx, vy, vz) {
  // v' = v + 2 w (u x v) + 2 u x (u x v), u = (q.x, q.y, q.z)
  const tx = 2 * (q.y * vz - q.z * vy);
  const ty = 2 * (q.z * vx - q.x * vz);
  const tz = 2 * (q.x * vy - q.y * vx);
  out.x = vx + q.w * tx + (q.y * tz - q.z * ty);
  out.y = vy + q.w * ty + (q.z * tx - q.x * tz);
  out.z = vz + q.w * tz + (q.x * ty - q.y * tx);
  return out;
}

/** Rotate by the inverse (conjugate) of q. */
export function qRotateInvInto(out, q, vx, vy, vz) {
  const tx = 2 * (-q.y * vz + q.z * vy);
  const ty = 2 * (-q.z * vx + q.x * vz);
  const tz = 2 * (-q.x * vy + q.y * vx);
  out.x = vx + q.w * tx + (-q.y * tz + q.z * ty);
  out.y = vy + q.w * ty + (-q.z * tx + q.x * tz);
  out.z = vz + q.w * tz + (-q.x * ty + q.y * tx);
  return out;
}

export const qRotate = (q, v) => qRotateInto({ x: 0, y: 0, z: 0 }, q, v.x, v.y, v.z);
export const qRotateInv = (q, v) => qRotateInvInto({ x: 0, y: 0, z: 0 }, q, v.x, v.y, v.z);

/** Rotation of `angleRad` about the (not necessarily unit) axis (ax,ay,az). */
export function qFromAxisAngle(ax, ay, az, angleRad) {
  const n = Math.hypot(ax, ay, az);
  if (n < 1e-12 || angleRad === 0) return qIdentity();
  const s = Math.sin(angleRad / 2) / n;
  return { w: Math.cos(angleRad / 2), x: ax * s, y: ay * s, z: az * s };
}

/** Shortest rotation taking unit vector a to unit vector b. */
export function qFromUnitVectors(a, b) {
  const d = a.x * b.x + a.y * b.y + a.z * b.z;
  if (d > 1 - 1e-12) return qIdentity();
  if (d < -1 + 1e-12) {
    // antiparallel: rotate by 180 degrees about any axis perpendicular to a
    const ax = Math.abs(a.x) <= Math.abs(a.y) && Math.abs(a.x) <= Math.abs(a.z) ? 1 : 0;
    const ay = !ax && Math.abs(a.y) <= Math.abs(a.z) ? 1 : 0;
    const az = !ax && !ay ? 1 : 0;
    // axis = a x helper
    const cx = a.y * az - a.z * ay;
    const cy = a.z * ax - a.x * az;
    const cz = a.x * ay - a.y * ax;
    return qFromAxisAngle(cx, cy, cz, Math.PI);
  }
  const cx = a.y * b.z - a.z * b.y;
  const cy = a.z * b.x - a.x * b.z;
  const cz = a.x * b.y - a.y * b.x;
  return qNormalize({ w: 1 + d, x: cx, y: cy, z: cz });
}

/** Rotation vector (axis * angle, rad) of a unit quaternion. */
export function qToRotationVector(q) {
  const s = Math.hypot(q.x, q.y, q.z);
  if (s < 1e-12) return { x: 0, y: 0, z: 0 };
  let angle = 2 * Math.atan2(s, q.w);
  if (angle > Math.PI) angle -= 2 * Math.PI; // shortest representation
  const k = angle / s;
  return { x: q.x * k, y: q.y * k, z: q.z * k };
}
