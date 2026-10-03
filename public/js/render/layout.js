// Canvas sizing maths: devicePixelRatio-aware full-window scaling with 16:9 letterboxing. OWNER: Presentation engineer.
// Pure functions (docs/architecture.md 8.1, design 2.1). The playfield is the logical 1920 x 1080 rectangle from
// shared/playfield.js; the canvas element fills the window and shows the playfield aspect-fit and centred.

import { FIELD, fitRect, clientToPlayfield } from '../shared/playfield.js';

/** The backing store never exceeds twice the CSS size (design 2.1: min(devicePixelRatio, 2)). */
export const MAX_BACKING_SCALE = 2;

/** Backing-store scale for a devicePixelRatio; auto-degrade level 3 forces 1.0 (design 9.11). */
export function backingScaleFor(dpr, degradeLevel = 0) {
  if (degradeLevel >= 3) return 1;
  const d = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
  return Math.min(d, MAX_BACKING_SCALE);
}

/**
 * @typedef {Object} Layout
 * @property {number} cssW        canvas CSS width
 * @property {number} cssH        canvas CSS height
 * @property {number} backingScale
 * @property {number} pixelW      canvas.width
 * @property {number} pixelH      canvas.height
 * @property {{scale:number, offsetX:number, offsetY:number, w:number, h:number}} fit   playfield rect in CSS px
 * @property {number} k           device pixels per logical playfield pixel
 * @property {number} tx          device-pixel translation of the playfield origin
 * @property {number} ty
 */

/**
 * @param {{cssW:number, cssH:number, dpr?:number, degradeLevel?:number}} p
 * @returns {Layout}
 */
export function computeLayout({ cssW, cssH, dpr = 1, degradeLevel = 0 }) {
  const w = Math.max(1, Number.isFinite(cssW) ? cssW : 1);
  const h = Math.max(1, Number.isFinite(cssH) ? cssH : 1);
  const backingScale = backingScaleFor(dpr, degradeLevel);
  const pixelW = Math.max(1, Math.round(w * backingScale));
  const pixelH = Math.max(1, Math.round(h * backingScale));
  const fit = fitRect(w, h);
  const bsx = pixelW / w;
  const bsy = pixelH / h;
  return {
    cssW: w,
    cssH: h,
    backingScale,
    pixelW,
    pixelH,
    fit,
    k: fit.scale * bsx,
    tx: fit.offsetX * bsx,
    ty: fit.offsetY * bsy,
  };
}

/** Set the context transform so that drawing uses logical playfield coordinates. */
export function applyPlayfieldTransform(ctx, layout) {
  ctx.setTransform(layout.k, 0, 0, layout.k, layout.tx, layout.ty);
}

/**
 * Letterbox bars in DEVICE pixels ({x,y,w,h}); 0 to 2 entries. Drawn last, with the identity transform, so that
 * screen shake and zoom of the game layer can never leak outside the 16:9 rectangle.
 */
export function letterboxBars(layout) {
  const bars = [];
  const { fit, pixelW, pixelH } = layout;
  const bsx = pixelW / layout.cssW;
  const bsy = pixelH / layout.cssH;
  const left = Math.round(fit.offsetX * bsx);
  const top = Math.round(fit.offsetY * bsy);
  const right = Math.round((fit.offsetX + fit.w) * bsx);
  const bottom = Math.round((fit.offsetY + fit.h) * bsy);
  if (left > 0) {
    bars.push({ x: 0, y: 0, w: left, h: pixelH });
    bars.push({ x: right, y: 0, w: pixelW - right, h: pixelH });
  }
  if (top > 0) {
    bars.push({ x: 0, y: 0, w: pixelW, h: top });
    bars.push({ x: 0, y: bottom, w: pixelW, h: pixelH - bottom });
  }
  return bars.filter((b) => b.w > 0 && b.h > 0);
}

/** Client (viewport) coordinates to playfield coordinates for a canvas bounding rect. Never clamps. */
export function pointerToPlayfield(rect, clientX, clientY) {
  return clientToPlayfield(rect, clientX, clientY);
}

/**
 * Apply a layout to a canvas element: sets the backing store size only when it changed (resizing clears the canvas and
 * resets the context state). Returns true when the size changed.
 */
export function applyLayoutToCanvas(canvas, layout) {
  if (canvas.width === layout.pixelW && canvas.height === layout.pixelH) return false;
  canvas.width = layout.pixelW;
  canvas.height = layout.pixelH;
  return true;
}

/** Read the CSS size of a canvas (layout read: call on resize only, never per frame). */
export function readCssSize(canvas, win) {
  const rect = typeof canvas.getBoundingClientRect === 'function' ? canvas.getBoundingClientRect() : null;
  const w = rect && rect.width > 0 ? rect.width : canvas.clientWidth || win?.innerWidth || FIELD.w;
  const h = rect && rect.height > 0 ? rect.height : canvas.clientHeight || win?.innerHeight || FIELD.h;
  return { cssW: w, cssH: h };
}
