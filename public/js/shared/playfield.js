// Playfield geometry shared by the Renderer, the mouse provider and the debug API. OWNER: architect (frozen).
// The logical playfield is 1920 x 1080 px. The canvas element shows it aspect-fit (letterboxed) and centred.

export const FIELD = Object.freeze({ w: 1920, h: 1080, cx: 960, cy: 540 });

/** Aspect-fit rectangle of the playfield inside a view of viewW x viewH CSS px. */
export function fitRect(viewW, viewH) {
  const scale = Math.min(viewW / FIELD.w, viewH / FIELD.h);
  const w = FIELD.w * scale;
  const h = FIELD.h * scale;
  return { scale, offsetX: (viewW - w) / 2, offsetY: (viewH - h) / 2, w, h };
}

/**
 * Client (viewport) coordinates -> playfield coordinates.
 * @param {{left:number, top:number, width:number, height:number}} rect  canvas.getBoundingClientRect()
 * @param {number} clientX
 * @param {number} clientY
 * @param {{clamp?:boolean}} [opts]
 * @returns {{x:number, y:number}}
 */
export function clientToPlayfield(rect, clientX, clientY, opts = {}) {
  const fit = fitRect(rect.width, rect.height);
  let x = (clientX - rect.left - fit.offsetX) / fit.scale;
  let y = (clientY - rect.top - fit.offsetY) / fit.scale;
  if (opts.clamp) {
    x = Math.min(FIELD.w, Math.max(0, x));
    y = Math.min(FIELD.h, Math.max(0, y));
  }
  return { x, y };
}

/** Playfield -> client coordinates (inverse of clientToPlayfield). */
export function playfieldToClient(rect, x, y) {
  const fit = fitRect(rect.width, rect.height);
  return { x: rect.left + fit.offsetX + x * fit.scale, y: rect.top + fit.offsetY + y * fit.scale };
}

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
