// Launch parameters and the fairness rule (docs/game-design.md section 3). OWNER: Gameplay engineer. Pure.
//
// Every target of a launch is drawn from a seeded stream (speed, azimuth, elevation, spin, launch point jitter), then its
// whole flight is simulated with the real physics (physics.js simulateFlight). If it stays less than
// CONFIG.fairness.minVisibleS in the shootable view the draw is repeated (same stream, up to CONFIG.fairness.retries times);
// after that the parameters are clamped to the house's `safe` set.

import { CONFIG } from './config.js';
import { createRng, hash32 } from '../shared/rng.js';
import { rabbitState, simulateFlight, groundYOf } from './physics.js';
import { WORLD } from '../shared/world.js';

const DEG = Math.PI / 180;
const HOP_SEED_MAX = 0x7fffffff;

/** A seeded stream for (stream id, k) of a round: createRng(hash32(hash32(seed, stream), k)). */
export function streamRng(seed32, stream, k = 0) {
  return createRng(hash32(hash32(seed32 >>> 0, stream >>> 0), k >>> 0));
}

/**
 * Draw launch parameters for one member of a pull.
 * @param {ReturnType<typeof createRng>} rng
 * @param {{kind:string, house:string}} member
 * @param {{speedMul?:number, speedOverride?:object|null, ranges?:object|null, k?:number}} [mods]
 *   ranges: {speed, azimuthDeg, elevationDeg} replacing the house ranges (practice round).
 *   k: world scale (difficulty distanceMul), applied by makeBody to positions and speeds. `speed` stays in Normal-world m/s.
 */
export function drawParams(rng, member, mods = {}) {
  const house = CONFIG.houses[member.house];
  const kind = CONFIG.targets[member.kind];
  if (!house) throw new RangeError(`unknown house "${member.house}"`);
  if (!kind) throw new RangeError(`unknown target kind "${member.kind}"`);
  const R = mods.ranges ?? null;
  const speedRange = R?.speed ?? mods.speedOverride?.[member.house] ?? house.speed;
  const elevRange = R?.elevationDeg ?? kind.elevationDeg ?? house.elevationDeg;
  const azRange = R?.azimuthDeg ?? house.azimuthDeg;
  const j = CONFIG.physics.jitterM;
  const [s0, s1] = CONFIG.physics.spinRadS;
  // fixed draw order, whatever the kind, so that the stream consumption never depends on the outcome
  const speed = rng.range(speedRange[0], speedRange[1]);
  const azimuthDeg = rng.range(azRange[0], azRange[1]);
  const elevationDeg = rng.range(elevRange[0], elevRange[1]);
  const jx = rng.range(-j, j);
  const jz = rng.range(-j, j);
  const spin = rng.range(s0, s1) * rng.sign();
  const hopSeed = rng.int(0, HOP_SEED_MAX);
  return {
    kind: member.kind, house: member.house,
    speed: speed * kind.speedMul * (mods.speedMul ?? 1),
    azimuthDeg, elevationDeg, jx, jz, spin, hopSeed, k: mods.k ?? 1,
  };
}

/** The clamp of the fairness rule: the house's safe parameters (kind elevation range respected), no jitter. */
export function safeParams(member, mods = {}, spin = 0, hopSeed = 1) {
  const house = CONFIG.houses[member.house];
  const kind = CONFIG.targets[member.kind];
  let elevationDeg = house.safe.elevationDeg;
  if (kind.elevationDeg) elevationDeg = Math.min(Math.max(elevationDeg, kind.elevationDeg[0]), kind.elevationDeg[1]);
  return {
    kind: member.kind, house: member.house,
    speed: house.safe.speed * kind.speedMul * (mods.speedMul ?? 1),
    azimuthDeg: house.safe.azimuthDeg, elevationDeg, jx: 0, jz: 0, spin, hopSeed, k: mods.k ?? 1,
  };
}

/**
 * House launch point in the world of scale k, scaled about the camera point (0, camY, 0): the same screen point at every k.
 * `groundY` is the ground plane of that world (physics.js groundYOf), where the house stands.
 */
export function housePos(id, k = 1) {
  const h = CONFIG.houses[id];
  return { x: h.x * k, y: WORLD.camY + k * (h.y - WORLD.camY), z: h.z * k, groundY: groundYOf(k) };
}

/**
 * Build a body (the internal target state) from launch parameters. `dipAtS` of a battue is filled by fairLaunch/finishBody.
 * The house position, the jitter and the speed are scaled by params.k. Explicit `pos` / `vel` (debug spawns) are taken as
 * they are (actual world metres and m/s); the body still uses the world scale k for its physics.
 */
export function makeBody(params, { pos = null, vel = null, still = false } = {}) {
  const k = params.k ?? 1;
  const house = housePos(params.house, k);
  const kind = CONFIG.targets[params.kind];
  const az = params.azimuthDeg * DEG;
  const el = params.elevationDeg * DEG;
  const sp = params.speed * k;
  const x = pos ? pos.x : house.x + params.jx * k;
  const y = pos ? pos.y : house.y;
  const z = pos ? pos.z : house.z + params.jz * k;
  const vx = vel ? vel.x : sp * Math.sin(az) * Math.cos(el);
  const vy = vel ? vel.y : sp * Math.sin(el);
  const vz = vel ? vel.z : sp * Math.cos(az) * Math.cos(el);
  const isRabbit = params.kind === 'rabbit';
  const rabbit = isRabbit ? rabbitState(params.hopSeed) : null;
  // a rabbit rolls on the ground plane of its world: its centre one radius (metres, not scaled) above it
  if (rabbit) rabbit.groundY = house.groundY + kind.sizeM / 2;
  return {
    id: 0,
    kind: params.kind,
    house: params.house,
    x, y: isRabbit && !pos ? rabbit.groundY : y, z,
    px: x, py: isRabbit && !pos ? rabbit.groundY : y, pz: z,
    vx, vy: isRabbit ? 0 : vy, vz,
    ageS: 0,
    sizeM: kind.sizeM,
    drag: CONFIG.physics.drag,
    k,
    dipAtS: Infinity,
    rabbit,
    seen: false,
    rot: 0,
    spin: params.spin,
    still: Boolean(still),
    pullIndex: 0,
    launchT: 0,
  };
}

/** Battue: the dip starts at dipAtFrac of the nominal flight time (the flight without the dip). */
export function finishBody(body, tWorld, wind) {
  if (body.kind === 'battue' && !body.still) {
    const nominal = simulateFlight(body, tWorld, wind);
    body.dipAtS = CONFIG.physics.battue.dipAtFrac * nominal.flightS;
  }
  return body;
}

/**
 * Draw a fair launch for one member (design 3, fairness rule).
 * @param {ReturnType<typeof createRng>} rng
 * @param {{kind:string, house:string}} member
 * @param {object} mods        drawParams mods
 * @param {{tWorld:number, wind:object}} ctx   world time of the launch and the stage wind
 * @returns {{body:object, params:object, attempts:number, clamped:boolean, visibleS:number}}
 */
export function fairLaunch(rng, member, mods, ctx) {
  const F = CONFIG.fairness;
  let last = null;
  for (let attempt = 1; attempt <= F.retries + 1; attempt++) {
    const params = drawParams(rng, member, mods);
    last = params;
    const body = finishBody(makeBody(params), ctx.tWorld, ctx.wind);
    const sim = simulateFlight(body, ctx.tWorld, ctx.wind);
    if (sim.visibleS >= F.minVisibleS) return { body, params, attempts: attempt, clamped: false, visibleS: sim.visibleS };
  }
  const params = safeParams(member, mods, last.spin, last.hopSeed);
  const body = finishBody(makeBody(params), ctx.tWorld, ctx.wind);
  const sim = simulateFlight(body, ctx.tWorld, ctx.wind);
  return { body, params, attempts: F.retries + 1, clamped: true, visibleS: sim.visibleS };
}
