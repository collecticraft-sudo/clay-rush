// The look of the Clay Rush UI kit: colour tokens, font strings and the one text helper the screens use. OWNER: UI engineer.
// Clean modern sporty style (docs/game-design.md 10): rounded cream panels with a slate outline, clay-orange focus ring and accents, gold for
// records. Text goes through render/draw-util.js (drawText, fitText, wrapLines); the families come from render/palette.js (ClayDisplay, ClayUI).
//
// The render modules are imported as namespaces so that a renamed or not-yet-written export never breaks the module graph at link time
// (render/ is being rebuilt in parallel): every function is checked before use and a tiny local fallback draws plain text.

import * as palette from '../render/palette.js';
import * as du from '../render/draw-util.js';
import * as fonts from '../render/fonts.js';

export const C = Object.freeze({
  cream: '#FFF4DC',
  creamDeep: '#F3E3BF',
  creamShade: '#E6D3A8',
  slate: '#1B1F24',
  slateSoft: '#3A414B',
  slateMuted: '#5D6672',
  orange: '#F26B1D',
  orangeDeep: '#C9520F',
  orangeLight: '#FF9A52',
  gold: '#F2C230',
  goldDeep: '#C99A12',
  sky: '#3C7FC8',
  olive: '#6B7F3A',
  terracotta: '#C8553D',
  white: '#FFFFFF',
  shadow: 'rgba(8,10,14,0.38)',
  veilTop: 'rgba(10,12,16,0.62)',
  veilMid: 'rgba(10,12,16,0.30)',
  veilBottom: 'rgba(10,12,16,0.72)',
  dim: 'rgba(10,12,16,0.55)',
});

/** Accent colour of each mode (menu cards, setup title). */
export const MODE_ACCENT = Object.freeze({ classic: C.orange, timeattack: C.sky, zen: C.olive, practice: C.orange });

const DISPLAY_FALLBACK = '"ClayDisplay", "Bebas Neue", "Oswald", "Impact", "Arial Narrow Bold", sans-serif';
const UI_FALLBACK = '"ClayUI", "Barlow", "Helvetica Neue", "Segoe UI", system-ui, sans-serif';

/** The font stacks: palette.js's when it already names the Clay families, else the same stacks written here (docs/architecture.md 6.3). */
export function fontStacks() {
  const f = palette.FONTS ?? {};
  const display = typeof f.display === 'string' && f.display.includes('ClayDisplay') ? f.display : DISPLAY_FALLBACK;
  const ui = typeof f.ui === 'string' && f.ui.includes('ClayUI') ? f.ui : UI_FALLBACK;
  return { display, ui };
}

const fontCache = new Map();
/**
 * CSS font shorthand. `family` 'display' (Bebas Neue: capitals, one weight) or 'ui' (Barlow 600 / 700). Memoised.
 * @param {'display'|'ui'} family
 * @param {number} size  px, never below 28 (design 10)
 * @param {number} [weight]
 */
export function font(family, size, weight) {
  const s = Math.max(28, Math.round(size));
  const w = weight ?? (family === 'display' ? 700 : 600);
  const key = `${family}|${s}|${w}`;
  let v = fontCache.get(key);
  if (!v) {
    const stacks = fontStacks();
    v = `${w} ${s}px ${family === 'display' ? stacks.display : stacks.ui}`;
    fontCache.set(key, v);
  }
  return v;
}

/** Size in px of a font string. */
export function fontSize(f) {
  const m = /(\d+(?:\.\d+)?)px/.exec(f);
  return m ? Number(m[1]) : 28;
}

/** Re-build the font strings (a web font arrived, or palette.js changed its stacks). */
export function resetFonts() {
  fontCache.clear();
}

/**
 * Draw one line of text. `maxW` shrinks the size (never below 28 px) so the line fits.
 * @param {CanvasRenderingContext2D} ctx
 * @param {string} str
 * @param {number} x
 * @param {number} y  baseline unless opts.baseline
 * @param {{family?:'display'|'ui', size?:number, weight?:number, font?:string, fill?:string, align?:CanvasTextAlign, baseline?:CanvasTextBaseline,
 *          alpha?:number, stroke?:string, strokeWidth?:number, maxW?:number, tracking?:number}} [o]
 */
export function text(ctx, str, x, y, o = {}) {
  let f = o.font ?? font(o.family ?? 'ui', o.size ?? 32, o.weight);
  if (o.maxW && typeof du.fitText === 'function') {
    const size = du.fitText(ctx, String(str), f, o.maxW, 28);
    if (size !== fontSize(f)) f = o.font ? f.replace(/(\d+(?:\.\d+)?)px/, `${size}px`) : font(o.family ?? 'ui', size, o.weight);
  }
  const opts = { font: f, fill: o.fill ?? C.slate, align: o.align ?? 'left', baseline: o.baseline ?? 'alphabetic', alpha: o.alpha, stroke: o.stroke ?? null, strokeWidth: o.strokeWidth ?? 0 };
  if (typeof du.drawText === 'function') {
    du.drawText(ctx, String(str), x, y, opts);
    return;
  }
  ctx.font = f;
  ctx.textAlign = opts.align;
  ctx.textBaseline = opts.baseline;
  const prev = ctx.globalAlpha;
  if (opts.alpha !== undefined) ctx.globalAlpha = prev * opts.alpha;
  if (opts.stroke && opts.strokeWidth > 0) {
    ctx.lineWidth = opts.strokeWidth;
    ctx.strokeStyle = opts.stroke;
    ctx.lineJoin = 'round';
    ctx.strokeText(String(str), x, y);
  }
  ctx.fillStyle = opts.fill;
  ctx.fillText(String(str), x, y);
  ctx.globalAlpha = prev;
}

const wrapFallback = new Map();
/** Word-wrap `str` to `maxW` with font `f` (cached). */
export function wrap(ctx, str, f, maxW) {
  if (typeof du.wrapLines === 'function') return du.wrapLines(ctx, String(str), f, maxW);
  const key = `${f}|${maxW}|${str}`;
  const hit = wrapFallback.get(key);
  if (hit) return hit;
  ctx.font = f;
  const lines = [];
  let line = '';
  for (const w of String(str).split(/\s+/).filter(Boolean)) {
    const cand = line ? `${line} ${w}` : w;
    if (line && ctx.measureText(cand).width > maxW) { lines.push(line); line = w; } else line = cand;
  }
  if (line) lines.push(line);
  if (wrapFallback.size > 300) wrapFallback.clear();
  wrapFallback.set(key, lines);
  return lines;
}

/** Draw wrapped text; returns the number of lines. `y` is the baseline of the first line. */
export function textWrapped(ctx, str, x, y, maxW, lineH, o = {}) {
  const f = o.font ?? font(o.family ?? 'ui', o.size ?? 32, o.weight);
  const lines = wrap(ctx, str, f, maxW);
  const max = o.maxLines ?? lines.length;
  for (let i = 0; i < Math.min(lines.length, max); i++) text(ctx, lines[i], x, y + i * lineH, { ...o, font: f });
  return Math.min(lines.length, max);
}

const widthCache = new Map();
// a web font that arrives changes every measurement while the font string stays the same: drop the cached widths then
if (typeof fonts.onFontsChange === 'function') fonts.onFontsChange(() => { widthCache.clear(); wrapFallback.clear(); });
/** Measured width of a line (cached per font and text). */
export function measure(ctx, str, f) {
  const key = `${f}|${str}`;
  let w = widthCache.get(key);
  if (w === undefined) {
    ctx.font = f;
    w = ctx.measureText(String(str)).width;
    if (widthCache.size > 600) widthCache.clear();
    widthCache.set(key, w);
  }
  return w;
}

/** Rounded rectangle path (draw-util's when present). */
export function rr(ctx, x, y, w, h, r) {
  if (typeof du.roundRectPath === 'function') {
    du.roundRectPath(ctx, x, y, w, h, r);
    return;
  }
  const q = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + q, y);
  ctx.arcTo(x + w, y, x + w, y + h, q);
  ctx.arcTo(x + w, y + h, x, y + h, q);
  ctx.arcTo(x, y + h, x, y, q);
  ctx.arcTo(x, y, x + w, y, q);
  ctx.closePath();
}

export const TAU = Math.PI * 2;
export const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const easeOutCubic = (t) => 1 - (1 - t) ** 3;
export function easeOutBack(t) {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * (t - 1) ** 3 + c1 * (t - 1) ** 2;
}
