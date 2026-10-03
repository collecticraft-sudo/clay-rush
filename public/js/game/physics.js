// Target physics in world metres (docs/game-design.md section 3). OWNER: Gameplay engineer. Pure, no allocation per step.
//
//   a = g + wind - k |v| v      (semi-implicit Euler, fixed step CONFIG.time.dt)
// g = (0, -WORLD.g, 0); wind = (windX * windAccelPerMps, 0, 0); k = CONFIG.physics.drag (x dragMul for a battue after its dip).
// World scale (difficulty distanceMul, body.k): the world is scaled by k about the CAMERA point C = (0, camY, 0) (QA F9):
// p' = C + k (p - C), speeds and accelerations x k (gravity, wind, hop heights x k, drag coefficients / k), zFar x k, and the
// ground plane moves to y = camY (1 - k). Every screen position is then the same as at k = 1; only the drawn sizes change (x 1/k).
// zNear is not scaled (the nearest point any clay reaches at k 0.55 is the trap house at 7.7 m).
// Rabbits roll along the ground at y = radius with small seeded hops and no wind. Every function here is shared by the
// real simulation and the fairness simulation at spawn, so both see exactly the same flight.

import { CONFIG } from './config.js';
import { WORLD, project } from '../shared/world.js';
import { FIELD } from '../shared/playfield.js';
import { hash32 } from '../shared/rng.js';

const P = CONFIG.physics;
const U32 = 4294967296;

/** Uniform [0,1) number derived from (seed, k): used for the rabbit hops so they need no stateful stream. */
export function hashUnit(seed, k) {
  return hash32(seed >>> 0, k >>> 0) / U32;
}

/**
 * Wind of a stage at world time t (design 7.1): base speed plus a sinusoidal gust.
 * @param {{base:number, gustAmp:number, gustPeriodS:number, phase:number}} wind
 * @param {number} tWorld
 * @returns {{x:number, gust:number}}
 */
export function windAt(wind, tWorld, out = { x: 0, gust: 0 }) {
  let gust = 0;
  if (wind.gustAmp !== 0 && wind.gustPeriodS > 0) gust = wind.gustAmp * Math.sin((2 * Math.PI * tWorld) / wind.gustPeriodS + wind.phase);
  out.gust = gust;
  out.x = wind.base + gust;
  return out;
}

/** Current drag coefficient of a body (battue: x dragMul after its dip time). */
export function dragOf(b) {
  const c = b.drag / b.k;
  return b.ageS >= b.dipAtS ? c * P.battue.dragMul : c;
}

/** Depth beyond which a body of world scale k is lost (and not hittable). */
export function zFarOf(k) {
  return WORLD.zFar * k;
}

/** Height of the ground plane in a world of scale k scaled about the camera (0 at k = 1). */
export function groundYOf(k = 1) {
  return WORLD.camY * (1 - k);
}

/**
 * Acceleration of a flying body (m/s^2) into `out`. Rabbits on the ground: rolling resistance only.
 * @returns {{x:number, y:number, z:number}}
 */
export function accelOf(b, windX, out = { x: 0, y: 0, z: 0 }) {
  if (b.rabbit) {
    const sp = Math.hypot(b.vx, b.vz);
    const k = P.rabbit.groundDrag / b.k;
    out.x = -k * sp * b.vx;
    out.z = -k * sp * b.vz;
    out.y = b.rabbit.onGround ? 0 : -WORLD.g * b.k;
    return out;
  }
  const k = dragOf(b);
  const sp = Math.hypot(b.vx, b.vy, b.vz);
  out.x = windX * P.windAccelPerMps * b.k - k * sp * b.vx;
  out.y = -WORLD.g * b.k - k * sp * b.vy;
  out.z = -k * sp * b.vz;
  return out;
}

const scratchA = { x: 0, y: 0, z: 0 };

/** Duration of the roll before hop n of a rabbit. */
function rollGap(b, n) {
  const [lo, hi] = P.rabbit.rollGapS;
  return lo + (hi - lo) * hashUnit(b.rabbit.hopSeed, 2 * n + 1);
}

/** Vertical launch speed of hop n of a rabbit. */
function hopSpeed(b, n) {
  const [lo, hi] = P.rabbit.hopM;
  const h = (lo + (hi - lo) * hashUnit(b.rabbit.hopSeed, 2 * n)) * b.k;
  return Math.sqrt(2 * WORLD.g * b.k * h);
}

/** Create the rabbit ground state for a body (call once at launch). */
export function rabbitState(hopSeed) {
  return { onGround: true, rollLeftS: 0, hopN: 0, hopSeed: hopSeed >>> 0, groundY: 0 };
}

/**
 * Advance a body by dt world seconds (mutates it). Keeps the previous position in px/py/pz for interpolation.
 * @param {object} b      body (see launch.js makeBody)
 * @param {number} dt
 * @param {number} windX  m/s at the end of the step
 */
export function stepBody(b, dt, windX) {
  b.px = b.x;
  b.py = b.y;
  b.pz = b.z;
  if (b.still) {
    b.ageS += dt;
    return;
  }
  const a = accelOf(b, windX, scratchA);
  b.vx += a.x * dt;
  b.vz += a.z * dt;
  if (b.rabbit) {
    const r = b.rabbit;
    if (r.onGround) {
      r.rollLeftS -= dt;
      if (r.rollLeftS <= 0) {
        r.onGround = false;
        b.vy = hopSpeed(b, r.hopN);
      }
    } else {
      b.vy += a.y * dt;
    }
    b.x += b.vx * dt;
    b.z += b.vz * dt;
    if (!r.onGround) {
      b.y += b.vy * dt;
      if (b.y <= r.groundY) {
        b.y = r.groundY;
        b.vy = 0;
        r.onGround = true;
        r.hopN += 1;
        r.rollLeftS = rollGap(b, r.hopN);
      }
    }
  } else {
    b.vy += a.y * dt;
    b.x += b.vx * dt;
    b.y += b.vy * dt;
    b.z += b.vz * dt;
  }
  b.rot += b.spin * dt;
  b.ageS += dt;
}

const scratchP = { sx: 0, sy: 0, s: 0, visible: false };

/** True when the body is inside the shootable view: on the screen, between zNear and zFar, above the ground. */
export function inView(b) {
  if (!(b.z >= WORLD.zNear) || b.z > zFarOf(b.k)) return false;
  if (!b.rabbit && b.y <= groundYOf(b.k)) return false;
  const p = project(b.x, b.y, b.z, scratchP);
  return p.sx >= 0 && p.sx <= FIELD.w && p.sy >= 0 && p.sy <= FIELD.h;
}

/**
 * Lost rule (design 3): ground (y <= ground plane, not rabbits), beyond zFar, leaves the screen by more than the margin (after having
 * been on screen), closer than zNear (passed the player) or older than maxLifeS. Updates `b.seen`.
 * @returns {'ground'|'far'|'offscreen'|'timeout'|null}
 */
export function lostReason(b) {
  if (inView(b)) b.seen = true;
  if (b.ageS > P.maxLifeS) return 'timeout';
  if (!b.rabbit && b.y <= groundYOf(b.k)) return 'ground';
  if (b.z > zFarOf(b.k)) return 'far';
  if (!(b.z >= WORLD.zNear)) return 'offscreen';
  if (b.seen) {
    const p = project(b.x, b.y, b.z, scratchP);
    const mg = P.offscreenMarginPx;
    if (p.sx < -mg || p.sx > FIELD.w + mg || p.sy < -mg || p.sy > FIELD.h + mg) return 'offscreen';
  }
  return null;
}

/** A detached copy of a body for look-ahead simulations. */
export function cloneBody(b) {
  const c = { ...b };
  if (b.rabbit) c.rabbit = { ...b.rabbit };
  return c;
}

/**
 * Simulate a body (a copy) from world time tWorld0 until it is lost, exactly as the game will.
 * @param {object} body
 * @param {number} tWorld0     world time of the body's state
 * @param {object} wind        stage wind (windAt)
 * @returns {{visibleS:number, flightS:number, reason:string}}
 */
export function simulateFlight(body, tWorld0, wind) {
  const b = cloneBody(body);
  const dt = CONFIG.time.dt;
  const w = { x: 0, gust: 0 };
  let visibleS = 0;
  let steps = 0;
  const maxSteps = Math.ceil(P.maxLifeS / dt) + 2;
  let reason = 'timeout';
  while (steps < maxSteps) {
    steps += 1;
    windAt(wind, tWorld0 + steps * dt, w);
    stepBody(b, dt, w.x);
    const r = lostReason(b);
    if (r) {
      reason = r;
      break;
    }
    if (inView(b)) visibleS += dt;
  }
  return { visibleS, flightS: steps * dt, reason };
}
