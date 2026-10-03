// Canvas sizing maths of the presentation: devicePixelRatio-aware full-window scaling with 16:9 letterboxing. OWNER: UI engineer.
// Pure functions. The playfield is the logical 1920 x 1080 rectangle of shared/playfield.js, shown aspect-fit and centred.

import { FIELD, clientToPlayfield, fitRect } from '../shared/playfield.js';

export const MAX_BACKING_SCALE = 2;

/**
 * @param {{cssW:number, cssH:number, dpr?:number}} p
 * @returns {{cssW:number, cssH:number, backingScale:number, pixelW:number, pixelH:number, k:number, tx:number, ty:number}}
 */
export function computeLayout({ cssW, cssH, dpr = 1 }) {
  const w = Math.max(1, Number.isFinite(cssW) ? cssW : FIELD.w);
  const h = Math.max(1, Number.isFinite(cssH) ? cssH : FIELD.h);
  const backingScale = Math.min(Number.isFinite(dpr) && dpr > 0 ? dpr : 1, MAX_BACKING_SCALE);
  const pixelW = Math.max(1, Math.round(w * backingScale));
  const pixelH = Math.max(1, Math.round(h * backingScale));
  const fit = fitRect(w, h);
  const bsx = pixelW / w;
  const bsy = pixelH / h;
  return { cssW: w, cssH: h, backingScale, pixelW, pixelH, k: fit.scale * bsx, tx: fit.offsetX * bsx, ty: fit.offsetY * bsy };
}

/** Set the context transform so that drawing uses logical playfield coordinates. */
export function applyPlayfieldTransform(ctx, layout) {
  ctx.setTransform(layout.k, 0, 0, layout.k, layout.tx, layout.ty);
}

/** Read the CSS size of a canvas (on resize only, never per frame). */
export function readCssSize(canvas, win) {
  const rect = typeof canvas.getBoundingClientRect === 'function' ? canvas.getBoundingClientRect() : null;
  const w = rect && rect.width > 0 ? rect.width : canvas.clientWidth || win?.innerWidth || FIELD.w;
  const h = rect && rect.height > 0 ? rect.height : canvas.clientHeight || win?.innerHeight || FIELD.h;
  return { cssW: w, cssH: h };
}

/** Client (viewport) coordinates to playfield coordinates for a canvas bounding rect. */
export function pointerToPlayfield(rect, clientX, clientY) {
  return clientToPlayfield(rect, clientX, clientY);
}
