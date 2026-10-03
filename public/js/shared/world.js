// The 2.5D world of Clay Rush: one camera, one projection, shared by the game (hit tests), the renderer and the debug API.
// OWNER: architect (frozen). docs/game-design.md section 2, docs/architecture.md 3.3.
//
// World metres: x to the right, y up, z away from the player. The camera stands at (0, CAM_Y, 0) looking level along +z.
// Playfield px: 1920 x 1080, origin top-left, y down (shared/playfield.js). The horizon of every backdrop is painted at HORIZON_Y.

export const WORLD = Object.freeze({
  F: 1663, // focal length in px: 60 degree horizontal field of view over 1920 px
  cx: 960,
  horizonY: 670,
  camY: 1.6,
  zNear: 4, // closer than this a target is neither drawn nor hittable
  zFar: 90, // beyond this a target is lost
  g: 9.81,
});

/**
 * Project a world point to the playfield. Writes into `out` (no allocation on the hot path) and returns it.
 * `s` is the scale in px per metre at that depth; `visible` is false in front of zNear (sx, sy are then meaningless).
 * @param {number} x @param {number} y @param {number} z
 * @param {{sx:number, sy:number, s:number, visible:boolean}} [out]
 */
export function project(x, y, z, out = { sx: 0, sy: 0, s: 0, visible: false }) {
  if (!(z >= WORLD.zNear)) {
    out.sx = WORLD.cx;
    out.sy = WORLD.horizonY;
    out.s = 0;
    out.visible = false;
    return out;
  }
  const s = WORLD.F / z;
  out.sx = WORLD.cx + x * s;
  out.sy = WORLD.horizonY - (y - WORLD.camY) * s;
  out.s = s;
  out.visible = true;
  return out;
}

/** The world point at depth z that projects to (sx, sy): the inverse of project() for a known depth. */
export function unproject(sx, sy, z) {
  const s = WORLD.F / z;
  return { x: (sx - WORLD.cx) / s, y: WORLD.camY - (sy - WORLD.horizonY) / s, z };
}

/** Depth at which a ground point (y = 0) appears at screen row sy (sy below the horizon), or Infinity at/above the horizon. */
export function groundDepthAt(sy) {
  const dy = sy - WORLD.horizonY;
  return dy > 0 ? (WORLD.F * WORLD.camY) / dy : Infinity;
}
