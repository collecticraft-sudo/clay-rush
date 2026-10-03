// Canvas UI widgets of Clay Rush: panels, buttons, value rows, focus ring, key caps, hint line, toast, chips, rings. OWNER: UI engineer.
// Clean modern sporty kit drawn procedurally (docs/architecture.md 7: no button images): cream panels with a slate outline and a hard drop
// shadow, clay-orange primary buttons and focus ring, gold for records. Every function takes the 2D context and plain numbers; no gradient is
// created per frame except where cached; no shadowBlur or filter (performance rule). Text is never smaller than 28 px.

import { C, TAU, clamp01, font, measure, rr, text } from './theme.js';
import { FOCUS_RING, HINT_LINE } from './layout-data.js';
import { t } from './strings.en.js';

const SHADOW_DY = 8;

/** The panel: hard shadow, cream body, slate outline. (cx, cy) is the centre. */
export function drawPanel(ctx, cx, cy, w, h, o = {}) {
  const x = cx - w / 2;
  const y = cy - h / 2;
  const r = o.radius ?? 28;
  rr(ctx, x, y + SHADOW_DY, w, h, r);
  ctx.fillStyle = C.shadow;
  ctx.fill();
  rr(ctx, x, y, w, h, r);
  ctx.fillStyle = o.fill ?? C.cream;
  ctx.fill();
  if (o.band) {
    // a coloured header band (mode cards, dialog titles), clipped to the rounded top
    ctx.save();
    rr(ctx, x, y, w, h, r);
    ctx.clip();
    ctx.fillStyle = o.band;
    ctx.fillRect(x, y, w, o.bandH ?? 96);
    ctx.restore();
  }
  rr(ctx, x, y, w, h, r);
  ctx.lineWidth = o.lineWidth ?? 4;
  ctx.strokeStyle = o.stroke ?? C.slate;
  ctx.stroke();
}

/** The focus ring around a rectangle {x0, y0, x1, y1}: a soft orange halo and a crisp orange line. */
export function drawFocusRing(ctx, ring, o = {}) {
  if (!ring) return;
  const pad = o.pad ?? FOCUS_RING.pad;
  const x = ring.x0 - pad;
  const y = ring.y0 - pad;
  const w = ring.x1 - ring.x0 + 2 * pad;
  const h = ring.y1 - ring.y0 + 2 * pad;
  const r = o.radius ?? FOCUS_RING.radius;
  const pulse = o.pulse ?? 0;
  rr(ctx, x - 4, y - 4, w + 8, h + 8, r + 4);
  ctx.lineWidth = 10 + 4 * pulse;
  ctx.strokeStyle = 'rgba(242,107,29,0.30)';
  ctx.stroke();
  rr(ctx, x, y, w, h, r);
  ctx.lineWidth = FOCUS_RING.width;
  ctx.strokeStyle = C.orange;
  ctx.stroke();
}

/**
 * A button. `tg` is the layout target (centre x, y, size w, h, enabled, primary). States: focused (ring + lift), pressed (sinks into its
 * shadow), disabled (faded), primary (orange body, cream label).
 * @param {{focused?:boolean, pressed?:boolean, primary?:boolean, size?:number, sub?:string, icon?:(ctx, x, y)=>void, link?:boolean}} [o]
 */
export function drawButton(ctx, tg, label, o = {}) {
  if (!tg) return;
  const enabled = tg.enabled !== false;
  const primary = o.primary ?? tg.primary === true;
  const pressed = !!o.pressed;
  const focused = !!o.focused && enabled;
  const x = tg.x - tg.w / 2;
  const y = tg.y - tg.h / 2 + (pressed ? SHADOW_DY - 2 : focused ? -3 : 0);
  const r = Math.min(24, tg.h / 2);
  const prevAlpha = ctx.globalAlpha;
  if (!enabled) ctx.globalAlpha = prevAlpha * 0.5;
  if (o.link) {
    // a text link (diagnostics): underlined label, no body
    const f = font('ui', o.size ?? 30, 700);
    const col = focused ? C.orangeLight : C.cream;
    text(ctx, label, tg.x, tg.y + 10, { font: f, fill: col, align: 'center', maxW: tg.w - 16 });
    const w = Math.min(tg.w - 16, measure(ctx, label, f));
    ctx.fillStyle = col;
    ctx.fillRect(tg.x - w / 2, tg.y + 18, w, 3);
    if (focused) drawFocusRing(ctx, { x0: tg.x - tg.w / 2, y0: tg.y - tg.h / 2, x1: tg.x + tg.w / 2, y1: tg.y + tg.h / 2 });
    ctx.globalAlpha = prevAlpha;
    return;
  }
  if (!pressed) {
    rr(ctx, x, tg.y - tg.h / 2 + SHADOW_DY, tg.w, tg.h, r);
    ctx.fillStyle = C.shadow;
    ctx.fill();
  }
  rr(ctx, x, y, tg.w, tg.h, r);
  ctx.fillStyle = primary ? C.orange : focused ? C.white : C.cream;
  ctx.fill();
  ctx.lineWidth = 4;
  ctx.strokeStyle = C.slate;
  ctx.stroke();
  const size = o.size ?? Math.min(52, Math.max(34, Math.round(tg.h * 0.5)));
  const f = font('display', size);
  const iconW = o.icon ? 56 : 0;
  const sub = o.sub;
  const ty = sub ? y + tg.h * 0.48 : y + tg.h / 2 + size * 0.36;
  if (o.icon) o.icon(ctx, x + 24 + 20, y + tg.h / 2);
  text(ctx, label, tg.x + iconW / 2, ty, { font: f, fill: primary ? C.cream : C.slate, align: 'center', maxW: tg.w - 36 - iconW });
  if (sub) text(ctx, sub, tg.x + iconW / 2, ty + 34, { family: 'ui', size: 28, weight: 600, fill: primary ? C.cream : C.slateMuted, align: 'center', maxW: tg.w - 36 - iconW });
  if (focused) drawFocusRing(ctx, { x0: x, y0: y, x1: x + tg.w, y1: y + tg.h }, { radius: r + FOCUS_RING.pad });
  ctx.globalAlpha = prevAlpha;
}

/**
 * A choice cell of a value row (segmented control). `selected` = the current value (orange body); `focusedRow` marks the whole row.
 * `swatch` draws a colour dot in front of the label.
 */
export function drawChoiceCell(ctx, tg, label, o = {}) {
  const selected = !!o.selected;
  const x = tg.x - tg.w / 2;
  const y = tg.y - tg.h / 2;
  const r = Math.min(18, tg.h / 2);
  rr(ctx, x, y, tg.w, tg.h, r);
  ctx.fillStyle = selected ? C.orange : o.dark ? 'rgba(255,244,220,0.12)' : C.creamDeep;
  ctx.fill();
  ctx.lineWidth = selected ? 4 : 3;
  ctx.strokeStyle = selected ? C.slate : o.dark ? 'rgba(255,244,220,0.45)' : 'rgba(27,31,36,0.35)';
  ctx.stroke();
  const fg = selected ? C.cream : o.dark ? C.cream : C.slate;
  if (o.swatch) {
    const d = Math.min(34, tg.h * 0.42);
    ctx.beginPath();
    ctx.arc(tg.x, tg.y - (label ? 10 : 0), d / 2, 0, TAU);
    ctx.fillStyle = o.swatch;
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = C.slate;
    ctx.stroke();
    if (label) text(ctx, label, tg.x, tg.y + 30, { family: 'ui', size: 28, weight: 700, fill: fg, align: 'center', maxW: tg.w - 8 });
    return;
  }
  text(ctx, label, tg.x, tg.y + (o.size ?? 34) * 0.36, { family: 'display', size: o.size ?? 34, fill: fg, align: 'center', maxW: tg.w - 14 });
}

/** The "-" and "+" cells of a stepper and the value between them. */
export function drawStepper(ctx, minus, plus, valueText, o = {}) {
  for (const [tg, sign, atBound] of [[minus, -1, o.atMin], [plus, 1, o.atMax]]) {
    if (!tg) continue;
    const x = tg.x - tg.w / 2;
    const y = tg.y - tg.h / 2;
    const pressed = o.pressedId === tg.id;
    rr(ctx, x, y + (pressed ? 2 : 0), tg.w, tg.h, 18);
    ctx.fillStyle = atBound ? (o.dark ? 'rgba(255,244,220,0.08)' : C.creamShade) : pressed ? C.orangeLight : o.dark ? 'rgba(255,244,220,0.16)' : C.creamDeep;
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = o.dark ? 'rgba(255,244,220,0.5)' : 'rgba(27,31,36,0.45)';
    ctx.stroke();
    const col = atBound ? (o.dark ? 'rgba(255,244,220,0.35)' : 'rgba(27,31,36,0.3)') : o.dark ? C.cream : C.slate;
    ctx.fillStyle = col;
    const s = tg.h * 0.32;
    ctx.fillRect(tg.x - s, tg.y - 3, 2 * s, 6);
    if (sign > 0) ctx.fillRect(tg.x - 3, tg.y - s, 6, 2 * s);
  }
  if (minus && plus) {
    const cx = (minus.x + plus.x) / 2;
    const room = plus.x - minus.x - minus.w - 16;
    text(ctx, valueText, cx, minus.y + 15, { family: 'display', size: 44, fill: o.dark ? C.cream : C.slate, align: 'center', maxW: room });
    if (Number.isFinite(o.frac)) {
      const w = Math.min(room, 220);
      const by = minus.y + 30;
      rr(ctx, cx - w / 2, by, w, 8, 4);
      ctx.fillStyle = o.dark ? 'rgba(255,244,220,0.18)' : 'rgba(27,31,36,0.14)';
      ctx.fill();
      rr(ctx, cx - w / 2, by, Math.max(8, w * clamp01(o.frac)), 8, 4);
      ctx.fillStyle = C.orange;
      ctx.fill();
    }
  }
}

/** A key cap with a glyph label (A, B, ZR, Enter, STICK ...). Returns its width. (x, y) = left end, vertical centre. */
export function drawKeyCap(ctx, x, y, rawLabel, o = {}) {
  const label = String(rawLabel).toUpperCase(); // the display face is caps-only; the system fallback is not (F15)
  const f = font('display', o.size ?? 30);
  const w = Math.max(o.h ?? 44, measure(ctx, label, f) + 26);
  const h = o.h ?? 44;
  rr(ctx, x, y - h / 2 + 4, w, h, 12);
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  ctx.fill();
  rr(ctx, x, y - h / 2, w, h, 12);
  ctx.fillStyle = o.fill ?? C.cream;
  ctx.fill();
  ctx.lineWidth = 3;
  ctx.strokeStyle = C.slate;
  ctx.stroke();
  text(ctx, label, x + w / 2, y + fontPxOf(f) * 0.36, { font: f, fill: C.slate, align: 'center' });
  return w;
}

const fontPxOf = (f) => Number(/(\d+)px/.exec(f)?.[1] ?? 30);

/** Width of a hint line (key caps + labels + gaps), for centring. */
function hintWidth(ctx, items) {
  const capF = font('display', 30);
  const labF = font('ui', 28, 600);
  let w = 0;
  for (const it of items) w += Math.max(44, measure(ctx, String(it.key).toUpperCase(), capF) + 26) + 12 + measure(ctx, it.label, labF) + 40;
  return w - 40;
}

/** The bottom hint line: "[A] Select  [B] Back" with the glyphs of the active controller, on a translucent slate band. */
export function drawHintLine(ctx, items, o = {}) {
  if (!items || !items.length) return;
  const y = o.y ?? HINT_LINE.y;
  const w = hintWidth(ctx, items);
  const x0 = (o.x ?? HINT_LINE.x) - w / 2;
  rr(ctx, x0 - 22, y - HINT_LINE.h / 2 - 2, w + 44, HINT_LINE.h + 4, (HINT_LINE.h + 4) / 2);
  ctx.fillStyle = 'rgba(16,19,24,0.72)';
  ctx.fill();
  let x = x0;
  const labF = font('ui', 28, 600);
  for (const it of items) {
    x += drawKeyCap(ctx, x, y, it.key) + 12;
    text(ctx, it.label, x, y + 10, { font: labF, fill: C.cream });
    x += measure(ctx, it.label, labF) + 40;
  }
}

/** A pill with one line of text, centred on (cx, cy). Returns its width. */
export function drawPill(ctx, cx, cy, label, o = {}) {
  const f = o.font ?? font(o.family ?? 'ui', o.size ?? 30, o.weight ?? 700);
  const h = o.h ?? 56;
  const tw = Math.min(o.maxW ?? 1600, measure(ctx, label, f));
  const w = tw + 2 * (o.padX ?? 28);
  const x = o.align === 'right' ? cx - w : cx - w / 2;
  rr(ctx, x, cy - h / 2, w, h, h / 2);
  ctx.fillStyle = o.fill ?? 'rgba(16,19,24,0.78)';
  ctx.fill();
  if (o.stroke) {
    ctx.lineWidth = 3;
    ctx.strokeStyle = o.stroke;
    ctx.stroke();
  }
  text(ctx, label, x + w / 2, cy + fontPxOf(f) * 0.35, { font: f, fill: o.color ?? C.cream, align: 'center', maxW: o.maxW });
  return w;
}

/** The toast: a slate pill near the top. */
export function drawToast(ctx, textStr, alpha = 1, y = 150) {
  if (!textStr) return;
  const prev = ctx.globalAlpha;
  ctx.globalAlpha = prev * clamp01(alpha);
  drawPill(ctx, 960, y, textStr, { h: 64, size: 30, fill: 'rgba(16,19,24,0.88)', stroke: C.orange, maxW: 1500 });
  ctx.globalAlpha = prev;
}

/** A progress ring (0..1) with a faint track. */
export function drawRing(ctx, cx, cy, r, frac, o = {}) {
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, TAU);
  ctx.lineWidth = o.width ?? 12;
  ctx.strokeStyle = o.track ?? 'rgba(255,244,220,0.22)';
  ctx.stroke();
  const f = clamp01(frac);
  if (f > 0) {
    ctx.beginPath();
    ctx.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + TAU * f);
    ctx.lineCap = 'round';
    ctx.strokeStyle = o.color ?? C.orange;
    ctx.stroke();
    ctx.lineCap = 'butt';
  }
}

/** Step dots ("step 2 of 4"): filled up to `n`. */
export function drawStepDots(ctx, cx, cy, n, total, o = {}) {
  const gap = 44;
  const x0 = cx - ((total - 1) * gap) / 2;
  for (let i = 0; i < total; i++) {
    ctx.beginPath();
    ctx.arc(x0 + i * gap, cy, i + 1 === n ? 13 : 10, 0, TAU);
    ctx.fillStyle = i + 1 <= n ? C.orange : o.dark ? 'rgba(27,31,36,0.18)' : 'rgba(255,244,220,0.25)';
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = o.dark ? C.slate : i + 1 <= n ? C.cream : 'rgba(255,244,220,0.5)';
    ctx.stroke();
  }
}

/** A procedural clay target (top view, slightly tilted): orange dome with a dark rim and ridges. */
export function drawClayIcon(ctx, cx, cy, r, o = {}) {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(1, o.tilt ?? 0.62);
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, TAU);
  ctx.fillStyle = o.gold ? C.gold : C.orange;
  ctx.fill();
  ctx.lineWidth = Math.max(3, r * 0.12);
  ctx.strokeStyle = C.slate;
  ctx.stroke();
  ctx.lineWidth = Math.max(2, r * 0.06);
  ctx.strokeStyle = o.gold ? C.goldDeep : C.orangeDeep;
  for (const k of [0.68, 0.4]) {
    ctx.beginPath();
    ctx.arc(0, 0, r * k, 0, TAU);
    ctx.stroke();
  }
  ctx.restore();
}

/** A stopwatch icon (Time Attack). */
export function drawClockIcon(ctx, cx, cy, r) {
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, TAU);
  ctx.fillStyle = C.cream;
  ctx.fill();
  ctx.lineWidth = Math.max(3, r * 0.14);
  ctx.strokeStyle = C.slate;
  ctx.stroke();
  ctx.fillStyle = C.slate;
  ctx.fillRect(cx - r * 0.18, cy - r * 1.35, r * 0.36, r * 0.3);
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(cx, cy - r * 0.62);
  ctx.moveTo(cx, cy);
  ctx.lineTo(cx + r * 0.45, cy + r * 0.2);
  ctx.lineWidth = Math.max(3, r * 0.12);
  ctx.lineCap = 'round';
  ctx.stroke();
  ctx.lineCap = 'butt';
}

/** A crosshair icon (white ring, dark outline, centre dot), the look of the in-game crosshair. */
export function drawCrosshairIcon(ctx, cx, cy, r, color = C.white) {
  ctx.lineCap = 'round';
  for (const [lw, col] of [[r * 0.34, C.slate], [r * 0.16, color]]) {
    ctx.lineWidth = lw;
    ctx.strokeStyle = col;
    ctx.beginPath();
    ctx.arc(cx, cy, r * 0.62, 0, TAU);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cx - r, cy); ctx.lineTo(cx - r * 0.32, cy);
    ctx.moveTo(cx + r * 0.32, cy); ctx.lineTo(cx + r, cy);
    ctx.moveTo(cx, cy - r); ctx.lineTo(cx, cy - r * 0.32);
    ctx.moveTo(cx, cy + r * 0.32); ctx.lineTo(cx, cy + r);
    ctx.stroke();
  }
  ctx.lineCap = 'butt';
  ctx.beginPath();
  ctx.arc(cx, cy, r * 0.1, 0, TAU);
  ctx.fillStyle = color;
  ctx.fill();
}

/** A Joy-Con held like a pistol, side view, pointing along `angle` (0 = right, -PI/2 = up). Procedural, for the calibration pictures. */
export function drawJoyconPistol(ctx, cx, cy, len, angle) {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(angle);
  const w = len;
  const h = len * 0.3;
  rr(ctx, -w / 2, -h / 2 + 10, w, h, h / 2);
  ctx.fillStyle = 'rgba(0,0,0,0.3)';
  ctx.fill();
  rr(ctx, -w / 2, -h / 2, w, h, h / 2);
  ctx.fillStyle = C.terracotta;
  ctx.fill();
  ctx.lineWidth = 5;
  ctx.strokeStyle = C.slate;
  ctx.stroke();
  // the rail and the ZR trigger under the index finger
  ctx.fillStyle = C.slate;
  rr(ctx, w * 0.18, h / 2 - 4, w * 0.2, h * 0.32, 8);
  ctx.fill();
  // the stick
  ctx.beginPath();
  ctx.arc(-w * 0.18, 0, h * 0.24, 0, TAU);
  ctx.fillStyle = C.slateSoft;
  ctx.fill();
  // the "top" end marker
  ctx.beginPath();
  ctx.arc(w / 2 - h * 0.35, 0, h * 0.12, 0, TAU);
  ctx.fillStyle = C.cream;
  ctx.fill();
  ctx.restore();
}

/** An arrow from (x0, y0) to (x1, y1). */
export function drawArrow(ctx, x0, y0, x1, y1, color = C.orange) {
  const a = Math.atan2(y1 - y0, x1 - x0);
  ctx.lineWidth = 10;
  ctx.lineCap = 'round';
  ctx.strokeStyle = color;
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1 - Math.cos(a) * 18, y1 - Math.sin(a) * 18);
  ctx.stroke();
  ctx.lineCap = 'butt';
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x1 - Math.cos(a - 0.5) * 36, y1 - Math.sin(a - 0.5) * 36);
  ctx.lineTo(x1 - Math.cos(a + 0.5) * 36, y1 - Math.sin(a + 0.5) * 36);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
}

const veilCache = new WeakMap();
/** The soft dark veil over the living menu backdrop (readability). Gradient cached per context. */
export function drawVeil(ctx, strength = 1) {
  let g = veilCache.get(ctx);
  if (!g && typeof ctx.createLinearGradient === 'function') {
    g = ctx.createLinearGradient(0, 0, 0, 1080);
    g.addColorStop(0, C.veilTop);
    g.addColorStop(0.42, C.veilMid);
    g.addColorStop(1, C.veilBottom);
    veilCache.set(ctx, g);
  }
  const prev = ctx.globalAlpha;
  ctx.globalAlpha = prev * clamp01(strength);
  ctx.fillStyle = g ?? C.dim;
  ctx.fillRect(0, 0, 1920, 1080);
  ctx.globalAlpha = prev;
}

/** A flat dim layer (pause, overlays). */
export function drawDim(ctx, alpha = 0.55) {
  ctx.fillStyle = `rgba(10,12,16,${alpha})`;
  ctx.fillRect(0, 0, 1920, 1080);
}

/**
 * An asset image contained in a w x h box, centred on (cx, cy), or false when the picture is not available (missing, failed, not loaded).
 * @param {object|null} assets  render/assets.js loader
 */
export function drawAssetImage(ctx, assets, id, cx, cy, w, h, density = 1) {
  if (!assets || assets.isNull === true || typeof assets.has !== 'function' || !assets.has(id) || typeof assets.scaled !== 'function') return false;
  let img = null;
  try {
    img = assets.scaled(id, w, h, density);
  } catch {
    img = null;
  }
  if (!img || !img.canvas) return false;
  ctx.drawImage(img.canvas, cx - img.w / 2, cy - img.h / 2, img.w, img.h);
  return true;
}

/** The "CLAY RUSH" logo: the logo_title picture, or a procedural wordmark (clay disc + display text) with the same footprint. */
export function drawLogo(ctx, assets, cx, cy, w, h, density = 1) {
  if (drawAssetImage(ctx, assets, 'logo_title', cx, cy, w, h, density)) return 'art';
  const size = Math.round(h * 0.56);
  drawClayIcon(ctx, cx + w * 0.3, cy - h * 0.05, h * 0.36, { tilt: 0.85 });
  const f = font('display', size);
  text(ctx, t('menu.title'), cx - w * 0.04, cy + size * 0.36, { font: f, fill: C.cream, stroke: C.slate, strokeWidth: 14, align: 'center' });
  return 'text';
}

/** The miniature landscape of a stage (setup cards): sky gradient, hills, ground. Gradients cached per (ctx, stage, size). */
const STAGE_ART = Object.freeze({
  meadow: Object.freeze({ sky: ['#7EC4F2', '#CDEBFA'], far: '#7FAF5A', near: '#4E8C3A', sun: '#FFF6C8' }),
  hills: Object.freeze({ sky: ['#F2A65A', '#FBE3A6'], far: '#C99A4A', near: '#8E7A33', sun: '#FFE9A0' }),
  alpine: Object.freeze({ sky: ['#3B3A6B', '#C37A8C'], far: '#4A5878', near: '#2F3B52', sun: '#F7D9B0' }),
});
const stageGrad = new WeakMap();

export function drawStageThumb(ctx, stageId, x, y, w, h) {
  const art = STAGE_ART[stageId] ?? STAGE_ART.hills;
  let byCtx = stageGrad.get(ctx);
  if (!byCtx) { byCtx = new Map(); stageGrad.set(ctx, byCtx); }
  const key = `${stageId}|${x}|${y}|${h}`;
  let g = byCtx.get(key);
  if (!g && typeof ctx.createLinearGradient === 'function') {
    g = ctx.createLinearGradient(0, y, 0, y + h);
    g.addColorStop(0, art.sky[0]);
    g.addColorStop(1, art.sky[1]);
    byCtx.set(key, g);
  }
  ctx.save();
  rr(ctx, x, y, w, h, 18);
  ctx.clip();
  ctx.fillStyle = g ?? art.sky[0];
  ctx.fillRect(x, y, w, h);
  ctx.beginPath();
  ctx.arc(x + w * 0.76, y + h * 0.3, h * 0.12, 0, TAU);
  ctx.fillStyle = art.sun;
  ctx.fill();
  ctx.fillStyle = art.far;
  ctx.beginPath();
  ctx.moveTo(x, y + h * 0.7);
  if (stageId === 'alpine') {
    ctx.lineTo(x + w * 0.18, y + h * 0.38); ctx.lineTo(x + w * 0.34, y + h * 0.62); ctx.lineTo(x + w * 0.52, y + h * 0.28);
    ctx.lineTo(x + w * 0.7, y + h * 0.6); ctx.lineTo(x + w * 0.86, y + h * 0.42); ctx.lineTo(x + w, y + h * 0.6);
  } else {
    ctx.quadraticCurveTo(x + w * 0.25, y + h * 0.45, x + w * 0.5, y + h * 0.62);
    ctx.quadraticCurveTo(x + w * 0.75, y + h * 0.5, x + w, y + h * 0.6);
  }
  ctx.lineTo(x + w, y + h);
  ctx.lineTo(x, y + h);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = art.near;
  ctx.beginPath();
  ctx.moveTo(x, y + h * 0.82);
  ctx.quadraticCurveTo(x + w * 0.5, y + h * 0.7, x + w, y + h * 0.84);
  ctx.lineTo(x + w, y + h);
  ctx.lineTo(x, y + h);
  ctx.closePath();
  ctx.fill();
  // a clay in flight
  drawClayIcon(ctx, x + w * 0.3, y + h * 0.32, Math.max(10, h * 0.06));
  ctx.restore();
}
