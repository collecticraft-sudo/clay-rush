// Procedural painters of Clay Rush: every picture of the game drawn with canvas paths and gradients, the fallback of every asset of the
// manifest (architecture 6.1, rule 7: `?assets=0` must give a complete, good-looking game). OWNER: Render & Audio engineer.
//
// A painter paints ONE sprite into its own canvas space, the same space as the generated picture it replaces: PROC_META gives the canvas
// size, anchor, body circle (clays) and muzzle (gun) exactly like a manifest entry, so the drawing code never cares where a picture came
// from. Painters run at bake time only (sprites.js caches the result), never per frame, so they may create gradients freely. Every random
// choice comes from a seeded mulberry32 stream: the same id paints the same picture every time.
//
// Style (design 10): flat-vector game art with soft painterly gradients, thin dark outlines (#1B1F24) on gameplay objects only, none on
// scenery. Clays keep the highest saturation on screen and a dark rim.

import { mulberry32 } from '../shared/rng.js';
import { COLORS, STAGE_PALETTES } from './palette.js';

const TAU = Math.PI * 2;
const OUT = COLORS.slate;

/** Canvas size, content box, anchor and extras of every procedural sprite (mirrors the manifest entries of the generated art). */
const box = (w, h) => Object.freeze({ x: 0, y: 0, w, h });
const meta = (id, w, h, extra = {}) => Object.freeze({ id, width: w, height: h, contentBox: box(w, h), anchor: Object.freeze({ x: w / 2, y: h / 2 }), procedural: true, ...extra });
const CLAY_BODY = Object.freeze({ cx: 128, cy: 128, r: 104 });

export const PROC_META = Object.freeze({
  clay_std_tilt: meta('clay_std_tilt', 256, 256, { body: CLAY_BODY }),
  clay_std_below: meta('clay_std_below', 256, 256, { body: CLAY_BODY }),
  clay_std_edge: meta('clay_std_edge', 256, 256, { body: CLAY_BODY }),
  clay_gold_tilt: meta('clay_gold_tilt', 256, 256, { body: CLAY_BODY }),
  clay_rabbit: meta('clay_rabbit', 256, 256, { body: CLAY_BODY }),
  shard_std_1: meta('shard_std_1', 128, 128), shard_std_2: meta('shard_std_2', 128, 128), shard_std_3: meta('shard_std_3', 128, 128),
  shard_std_4: meta('shard_std_4', 128, 128), shard_std_5: meta('shard_std_5', 128, 128), shard_std_6: meta('shard_std_6', 128, 128),
  shard_gold_1: meta('shard_gold_1', 128, 128), shard_gold_2: meta('shard_gold_2', 128, 128),
  fx_flash_star: meta('fx_flash_star', 256, 256), fx_flash_side: meta('fx_flash_side', 256, 256), fx_smoke_puff: meta('fx_smoke_puff', 256, 256),
  fx_smoke_trail: meta('fx_smoke_trail', 256, 256), fx_dust_burst: meta('fx_dust_burst', 256, 256), fx_shell_casing: meta('fx_shell_casing', 256, 256),
  house_trap: Object.freeze({ ...meta('house_trap', 512, 512), contentBox: Object.freeze({ x: 20, y: 184, w: 471, h: 144 }), anchor: Object.freeze({ x: 255.5, y: 328 }) }),
  house_skeet: Object.freeze({ ...meta('house_skeet', 512, 512), contentBox: Object.freeze({ x: 85, y: 95, w: 341, h: 321 }), anchor: Object.freeze({ x: 255.5, y: 416 }) }),
  house_tower: Object.freeze({ ...meta('house_tower', 512, 512), contentBox: Object.freeze({ x: 89, y: 106, w: 332, h: 300 }), anchor: Object.freeze({ x: 255, y: 406 }) }),
  icon_shell_full: meta('icon_shell_full', 128, 128), icon_shell_empty: meta('icon_shell_empty', 128, 128), icon_clay: meta('icon_clay', 128, 128),
  icon_trophy: meta('icon_trophy', 128, 128), icon_wind: meta('icon_wind', 128, 128), icon_clock: meta('icon_clock', 128, 128),
  icon_star: meta('icon_star', 128, 128),
  gun_ou: Object.freeze({ ...meta('gun_ou', 689, 800), anchor: Object.freeze({ x: 689, y: 800 }), muzzle: Object.freeze({ x: 0.05, y: 0.045 }) }),
  /** Procedural only (no asset): the additive glow of the muzzle flash and of the gold clay, and a sparkle. */
  fx_glow: meta('fx_glow', 128, 128),
  fx_glow_gold: meta('fx_glow_gold', 128, 128),
  fx_sparkle: meta('fx_sparkle', 64, 64),
  fx_vignette: meta('fx_vignette', 256, 144),
});

// --------------------------------------------------------------------------------------------------------------------------- helpers

function ell(ctx, cx, cy, rx, ry, rot = 0) {
  ctx.beginPath();
  ctx.ellipse(cx, cy, Math.max(0.01, rx), Math.max(0.01, ry), rot, 0, TAU);
}

function radial(ctx, x, y, r, stops) {
  const g = ctx.createRadialGradient(x, y, 0, x, y, r);
  for (const [o, c] of stops) g.addColorStop(o, c);
  return g;
}

function linear(ctx, x0, y0, x1, y1, stops) {
  const g = ctx.createLinearGradient(x0, y0, x1, y1);
  for (const [o, c] of stops) g.addColorStop(o, c);
  return g;
}

function hexRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function rgba(hex, a) {
  const [r, g, b] = hexRgb(hex);
  return `rgba(${r},${g},${b},${a})`;
}
function mix(a, b, t) {
  const [r1, g1, b1] = hexRgb(a);
  const [r2, g2, b2] = hexRgb(b);
  const h = (v) => Math.round(v).toString(16).padStart(2, '0');
  return `#${h(r1 + (r2 - r1) * t)}${h(g1 + (g2 - g1) * t)}${h(b1 + (b2 - b1) * t)}`;
}

function star(ctx, cx, cy, outer, inner, points, rot = -Math.PI / 2) {
  ctx.beginPath();
  for (let i = 0; i < points * 2; i++) {
    const r = i % 2 === 0 ? outer : inner;
    const a = rot + (i * Math.PI) / points;
    const x = cx + Math.cos(a) * r;
    const y = cy + Math.sin(a) * r;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
}

function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

// ------------------------------------------------------------------------------------------------------------------------------ clays

/** Clay colours: standard orange and gold (the clay rim is a dark pitch band). */
export const CLAY_COLORS = Object.freeze({
  std: Object.freeze({ base: '#F26B1D', light: '#FFA45E', deep: '#C2480C', ridge: '#B9430A', rim: '#2B3036', rimLight: '#4A525C' }),
  gold: Object.freeze({ base: '#F2C230', light: '#FFEB94', deep: '#C88D16', ridge: '#B9800F', rim: '#35322B', rimLight: '#5A554A' }),
});

/** A clay seen from above and a little tilted (the frame `tilt`): dark rim under an orange dome with three ridges and a highlight. */
export function paintClayTilt(ctx, c = CLAY_COLORS.std, cx = 128, cy = 128, r = 104) {
  ctx.save();
  ctx.lineJoin = 'round';
  // rim band (the underside lip seen at the front)
  ell(ctx, cx, cy + 0.17 * r, r, 0.6 * r);
  ctx.fillStyle = linear(ctx, cx, cy - 0.4 * r, cx, cy + 0.8 * r, [[0, c.rimLight], [0.6, c.rim], [1, '#15181C']]);
  ctx.fill();
  ctx.lineWidth = 0.055 * r;
  ctx.strokeStyle = OUT;
  ctx.stroke();
  // dome
  ell(ctx, cx, cy - 0.03 * r, 0.95 * r, 0.56 * r);
  ctx.fillStyle = radial(ctx, cx - 0.35 * r, cy - 0.35 * r, 1.35 * r, [[0, c.light], [0.42, c.base], [1, c.deep]]);
  ctx.fill();
  ctx.lineWidth = 0.05 * r;
  ctx.strokeStyle = OUT;
  ctx.stroke();
  // concentric ridges: a dark line and a light line just above it
  for (const k of [0.78, 0.56, 0.34]) {
    ell(ctx, cx + 0.02 * r, cy - 0.06 * r - (1 - k) * 0.06 * r, 0.95 * r * k, 0.56 * r * k);
    ctx.lineWidth = 0.035 * r;
    ctx.strokeStyle = rgba(c.ridge, 0.75);
    ctx.stroke();
    ell(ctx, cx + 0.02 * r, cy - 0.085 * r - (1 - k) * 0.06 * r, 0.95 * r * k, 0.56 * r * k);
    ctx.lineWidth = 0.02 * r;
    ctx.strokeStyle = rgba(c.light, 0.55);
    ctx.stroke();
  }
  // specular highlight
  ell(ctx, cx - 0.42 * r, cy - 0.3 * r, 0.22 * r, 0.09 * r, -0.35);
  ctx.fillStyle = 'rgba(255,255,255,0.6)';
  ctx.fill();
  ctx.restore();
}

/** The clay seen from below (frame `below`): the dark lip ring around the hollow, orange inside with ridges. */
export function paintClayBelow(ctx, c = CLAY_COLORS.std, cx = 128, cy = 128, r = 104) {
  ctx.save();
  // dome top showing behind the rim
  ell(ctx, cx, cy - 0.16 * r, 0.93 * r, 0.52 * r);
  ctx.fillStyle = radial(ctx, cx - 0.2 * r, cy - 0.5 * r, 1.2 * r, [[0, c.light], [0.5, c.base], [1, c.deep]]);
  ctx.fill();
  ctx.lineWidth = 0.05 * r;
  ctx.strokeStyle = OUT;
  ctx.stroke();
  // rim ring
  ell(ctx, cx, cy + 0.1 * r, r, 0.58 * r);
  ctx.fillStyle = linear(ctx, cx, cy - 0.5 * r, cx, cy + 0.7 * r, [[0, c.rimLight], [1, c.rim]]);
  ctx.fill();
  ctx.lineWidth = 0.055 * r;
  ctx.stroke();
  // the hollow
  ell(ctx, cx, cy + 0.12 * r, 0.76 * r, 0.4 * r);
  ctx.fillStyle = radial(ctx, cx, cy + 0.32 * r, 0.9 * r, [[0, c.base], [0.6, c.deep], [1, mix(c.deep, '#000000', 0.35)]]);
  ctx.fill();
  ctx.lineWidth = 0.03 * r;
  ctx.strokeStyle = rgba('#000000', 0.45);
  ctx.stroke();
  for (const k of [0.75, 0.5]) {
    ell(ctx, cx, cy + 0.14 * r, 0.76 * r * k, 0.4 * r * k);
    ctx.lineWidth = 0.025 * r;
    ctx.strokeStyle = rgba(c.light, 0.35);
    ctx.stroke();
  }
  ctx.restore();
}

/** The clay edge-on (frame `edge`, battue): a narrow vertical lens with the rim on its right. */
export function paintClayEdge(ctx, c = CLAY_COLORS.std, cx = 128, cy = 128, r = 104) {
  ctx.save();
  ell(ctx, cx + 0.06 * r, cy, 0.3 * r, r);
  ctx.fillStyle = linear(ctx, cx - 0.2 * r, cy, cx + 0.4 * r, cy, [[0, c.rimLight], [1, c.rim]]);
  ctx.fill();
  ctx.lineWidth = 0.05 * r;
  ctx.strokeStyle = OUT;
  ctx.stroke();
  ell(ctx, cx - 0.04 * r, cy, 0.24 * r, 0.93 * r);
  ctx.fillStyle = linear(ctx, cx - 0.3 * r, cy - r, cx + 0.2 * r, cy + r, [[0, c.light], [0.45, c.base], [1, c.deep]]);
  ctx.fill();
  ctx.lineWidth = 0.04 * r;
  ctx.stroke();
  for (const k of [0.7, 0.42]) {
    ell(ctx, cx - 0.06 * r, cy, 0.24 * r * k, 0.93 * r * k);
    ctx.lineWidth = 0.03 * r;
    ctx.strokeStyle = rgba(c.ridge, 0.7);
    ctx.stroke();
  }
  ell(ctx, cx - 0.14 * r, cy - 0.45 * r, 0.05 * r, 0.22 * r);
  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  ctx.fill();
  ctx.restore();
}

/** The rabbit (a thick wheel seen a little from the side): dark tyre, orange face with five spoke windows and a hub. */
export function paintClayRabbit(ctx, c = CLAY_COLORS.std, cx = 128, cy = 128, r = 104) {
  ctx.save();
  // tyre thickness (the far side)
  ell(ctx, cx + 0.1 * r, cy, 0.52 * r, r);
  ctx.fillStyle = c.rim;
  ctx.fill();
  ctx.lineWidth = 0.05 * r;
  ctx.strokeStyle = OUT;
  ctx.stroke();
  // face
  ell(ctx, cx - 0.04 * r, cy, 0.46 * r, 0.94 * r);
  ctx.fillStyle = linear(ctx, cx - 0.4 * r, cy - r, cx + 0.3 * r, cy + r, [[0, c.rimLight], [1, c.rim]]);
  ctx.fill();
  ctx.stroke();
  // orange windows between spokes
  ctx.save();
  ctx.translate(cx - 0.04 * r, cy);
  ctx.scale(0.46, 0.94);
  for (let i = 0; i < 5; i++) {
    const a0 = (i / 5) * TAU + 0.18;
    const a1 = a0 + TAU / 5 - 0.36;
    ctx.beginPath();
    ctx.arc(0, 0, 0.84 * r, a0, a1);
    ctx.arc(0, 0, 0.42 * r, a1, a0, true);
    ctx.closePath();
    ctx.fillStyle = c.base;
    ctx.fill();
  }
  ctx.beginPath();
  ctx.arc(0, 0, 0.3 * r, 0, TAU);
  ctx.fillStyle = c.base;
  ctx.fill();
  ctx.beginPath();
  ctx.arc(0, 0, 0.16 * r, 0, TAU);
  ctx.fillStyle = c.deep;
  ctx.fill();
  ctx.restore();
  ell(ctx, cx - 0.2 * r, cy - 0.55 * r, 0.05 * r, 0.16 * r, 0.2);
  ctx.fillStyle = 'rgba(255,255,255,0.4)';
  ctx.fill();
  ctx.restore();
}

/** A four-point sparkle (gold clay, gold shards, HUD). */
export function paintSparkle(ctx, cx, cy, size, color = '#FFFFFF') {
  star(ctx, cx, cy, size, size * 0.16, 4, -Math.PI / 2);
  ctx.fillStyle = color;
  ctx.fill();
}

/** One shard of a broken clay: a wedge of the dome with a jagged break line, the dark rim along its outer arc. */
export function paintShard(ctx, index, gold = false, cx = 64, cy = 64) {
  const c = gold ? CLAY_COLORS.gold : CLAY_COLORS.std;
  const rnd = mulberry32(0x5eed + index * 7919 + (gold ? 131 : 0));
  const R = 50 * (index === 6 && !gold ? 0.62 : gold && index === 2 ? 0.7 : 0.82 + 0.18 * rnd());
  const span = (0.9 + 0.7 * rnd()) * (index === 6 ? 0.8 : 1);
  const a0 = -Math.PI / 2 - span / 2;
  const a1 = a0 + span;
  const ox = cx - Math.cos((a0 + a1) / 2) * R * 0.5;
  const oy = cy - Math.sin((a0 + a1) / 2) * R * 0.5;
  ctx.save();
  ctx.lineJoin = 'round';
  // the face
  ctx.beginPath();
  ctx.moveTo(ox + Math.cos(a0) * R, oy + Math.sin(a0) * R);
  ctx.arc(ox, oy, R, a0, a1);
  // jagged break back to the start through the inside
  const steps = 7;
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const ang = a1 + (a0 - a1) * t;
    const rr = R * (0.18 + 0.32 * rnd()) * (0.6 + 0.8 * Math.sin(Math.PI * t));
    ctx.lineTo(ox + Math.cos(ang) * rr, oy + Math.sin(ang) * rr);
  }
  ctx.closePath();
  ctx.fillStyle = radial(ctx, ox - R * 0.2, oy - R * 0.6, R * 1.4, [[0, c.light], [0.5, c.base], [1, c.deep]]);
  ctx.fill();
  ctx.lineWidth = 3;
  ctx.strokeStyle = OUT;
  ctx.stroke();
  // rim along the outer arc
  ctx.beginPath();
  ctx.arc(ox, oy, R - 4, a0 + 0.05, a1 - 0.05);
  ctx.lineWidth = 7;
  ctx.lineCap = 'round';
  ctx.strokeStyle = c.rim;
  ctx.stroke();
  // ridge
  ctx.beginPath();
  ctx.arc(ox, oy, R * 0.66, a0 + 0.15, a1 - 0.2);
  ctx.lineWidth = 2.5;
  ctx.strokeStyle = rgba(c.ridge, 0.7);
  ctx.stroke();
  ctx.restore();
}

// ----------------------------------------------------------------------------------------------------------------------------- fx

export function paintFlashStar(ctx, cx = 128, cy = 128, r = 110) {
  ctx.save();
  ctx.fillStyle = radial(ctx, cx, cy, r, [[0, 'rgba(255,255,240,1)'], [0.25, 'rgba(255,236,150,0.95)'], [0.55, 'rgba(255,150,40,0.55)'], [1, 'rgba(255,90,20,0)']]);
  ctx.fillRect(cx - r, cy - r, 2 * r, 2 * r);
  star(ctx, cx, cy, r, r * 0.28, 8, -Math.PI / 2);
  ctx.fillStyle = radial(ctx, cx, cy, r, [[0, '#FFFFF4'], [0.35, '#FFE07A'], [0.75, '#FF9A2A'], [1, 'rgba(242,107,29,0)']]);
  ctx.fill();
  star(ctx, cx, cy, r * 0.55, r * 0.16, 8, -Math.PI / 2 + Math.PI / 8);
  ctx.fillStyle = 'rgba(255,255,255,0.95)';
  ctx.fill();
  ctx.restore();
}

/** Side flash: a cone of fire pointing to +x from the left middle. */
export function paintFlashSide(ctx, w = 256, h = 256) {
  const cy = h / 2;
  ctx.save();
  ctx.fillStyle = radial(ctx, w * 0.22, cy, w * 0.5, [[0, 'rgba(255,255,230,1)'], [0.4, 'rgba(255,200,90,0.6)'], [1, 'rgba(255,110,20,0)']]);
  ctx.fillRect(0, 0, w, h);
  ctx.beginPath();
  ctx.moveTo(w * 0.1, cy);
  const pts = [[0.35, -0.2], [0.42, -0.08], [0.95, -0.03], [0.5, 0.0], [0.95, 0.05], [0.42, 0.09], [0.33, 0.22]];
  for (const [x, y] of pts) ctx.lineTo(w * x, cy + h * y);
  ctx.closePath();
  ctx.fillStyle = linear(ctx, w * 0.1, cy, w * 0.95, cy, [[0, '#FFFFF0'], [0.4, '#FFD45A'], [1, 'rgba(255,120,30,0)']]);
  ctx.fill();
  ctx.restore();
}

/** A soft puff of smoke: overlapping round blobs, lighter on top. `tone` tints it (dust uses a sand tone). */
export function paintPuff(ctx, cx = 128, cy = 128, r = 100, tone = '#ECEAE6', seed = 3, alpha = 0.92) {
  const rnd = mulberry32(seed);
  ctx.save();
  const blobs = 9;
  for (let i = 0; i < blobs; i++) {
    const a = rnd() * TAU;
    const d = (i === 0 ? 0 : 0.25 + 0.35 * rnd()) * r;
    const br = (0.34 + 0.24 * rnd()) * r;
    const x = cx + Math.cos(a) * d;
    const y = cy + Math.sin(a) * d * 0.8;
    ctx.fillStyle = radial(ctx, x - br * 0.25, y - br * 0.3, br * 1.15, [[0, rgba(mix(tone, '#FFFFFF', 0.5), alpha)], [0.55, rgba(tone, alpha * 0.85)], [1, rgba(mix(tone, '#7A7F88', 0.35), 0)]]);
    ctx.beginPath();
    ctx.arc(x, y, br, 0, TAU);
    ctx.fill();
  }
  ctx.restore();
}

export function paintDustBurst(ctx, cx = 128, cy = 128, r = 100) {
  paintPuff(ctx, cx, cy, r, COLORS.dust, 11, 0.9);
  const rnd = mulberry32(77);
  ctx.save();
  for (let i = 0; i < 16; i++) {
    const a = rnd() * TAU;
    const d = (0.6 + 0.45 * rnd()) * r;
    ctx.fillStyle = i % 3 === 0 ? '#8E6B45' : '#B8925F';
    ctx.beginPath();
    ctx.arc(cx + Math.cos(a) * d, cy + Math.sin(a) * d, 2 + 4 * rnd(), 0, TAU);
    ctx.fill();
  }
  ctx.restore();
}

/** A spent shell: red plastic hull with a brass head, drawn diagonally like the generated one. */
export function paintShellCasing(ctx, cx = 128, cy = 128, len = 190, full = true, angle = -Math.PI / 4) {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(angle);
  const w = len * 0.36;
  const hull = full ? COLORS.shellRed : '#8E949C';
  roundRect(ctx, -len / 2, -w / 2, len, w, w * 0.18);
  ctx.fillStyle = linear(ctx, 0, -w / 2, 0, w / 2, [[0, mix(hull, '#FFFFFF', 0.35)], [0.45, hull], [1, mix(hull, '#000000', 0.35)]]);
  ctx.fill();
  ctx.lineWidth = len * 0.03;
  ctx.strokeStyle = OUT;
  ctx.stroke();
  // brass head
  roundRect(ctx, len / 2 - len * 0.3, -w / 2 - len * 0.015, len * 0.3, w + len * 0.03, w * 0.12);
  ctx.fillStyle = linear(ctx, 0, -w / 2, 0, w / 2, [[0, '#FFE9A6'], [0.5, COLORS.brass], [1, '#8A6418']]);
  ctx.fill();
  ctx.stroke();
  // crimp lines at the open end
  ctx.strokeStyle = rgba('#000000', 0.35);
  ctx.lineWidth = len * 0.012;
  for (let i = -2; i <= 2; i++) {
    ctx.beginPath();
    ctx.moveTo(-len / 2 + len * 0.02, (i * w) / 6);
    ctx.lineTo(-len / 2 + len * 0.1, (i * w) / 7);
    ctx.stroke();
  }
  ctx.restore();
}

export function paintGlow(ctx, w = 128, color = '#FFC873') {
  const r = w / 2;
  ctx.fillStyle = radial(ctx, r, r, r, [[0, rgba(mix(color, '#FFFFFF', 0.6), 1)], [0.2, rgba(color, 0.75)], [0.55, rgba(color, 0.22)], [1, rgba(color, 0)]]);
  ctx.fillRect(0, 0, w, w);
}

/** Letterbox vignette of the kill cam: dark edges, clear centre (drawn stretched over the whole field). */
export function paintVignette(ctx, w = 256, h = 144) {
  ctx.save();
  ctx.translate(w / 2, h / 2);
  ctx.scale(w / 2, h / 2);
  ctx.fillStyle = radial(ctx, 0, 0, 1.42, [[0, 'rgba(10,8,6,0)'], [0.55, 'rgba(10,8,6,0.05)'], [0.85, 'rgba(10,8,6,0.55)'], [1, 'rgba(10,8,6,0.85)']]);
  ctx.fillRect(-1, -1, 2, 2);
  ctx.restore();
}

// --------------------------------------------------------------------------------------------------------------------------- houses

function grassMound(ctx, cx, cy, rx, ry, pal = STAGE_PALETTES.meadow) {
  ell(ctx, cx, cy, rx, ry);
  ctx.fillStyle = radial(ctx, cx, cy - ry, rx, [[0, pal.grass[1]], [1, pal.grass[3]]]);
  ctx.fill();
}

/** Trap house: a low concrete bunker in a grass mound with a dark opening (canvas 512, ground at y 328). */
export function paintHouseTrap(ctx) {
  ctx.save();
  ctx.lineJoin = 'round';
  grassMound(ctx, 256, 316, 236, 24);
  // side slopes of earth
  ctx.beginPath();
  ctx.moveTo(40, 318);
  ctx.quadraticCurveTo(120, 214, 186, 206);
  ctx.lineTo(326, 206);
  ctx.quadraticCurveTo(392, 214, 472, 318);
  ctx.closePath();
  ctx.fillStyle = linear(ctx, 0, 200, 0, 320, [[0, '#7FA84A'], [1, '#4F7A2C']]);
  ctx.fill();
  // concrete front: a trapezoid with wing walls
  ctx.beginPath();
  ctx.moveTo(150, 200);
  ctx.lineTo(362, 200);
  ctx.lineTo(430, 312);
  ctx.lineTo(82, 312);
  ctx.closePath();
  ctx.fillStyle = linear(ctx, 0, 200, 0, 312, [[0, '#D6D4CE'], [1, '#A9A69E']]);
  ctx.fill();
  ctx.lineWidth = 4;
  ctx.strokeStyle = OUT;
  ctx.stroke();
  // top slab
  ctx.beginPath();
  ctx.moveTo(140, 192);
  ctx.lineTo(372, 192);
  ctx.lineTo(366, 208);
  ctx.lineTo(146, 208);
  ctx.closePath();
  ctx.fillStyle = '#E6E3DC';
  ctx.fill();
  ctx.stroke();
  // wing wall seams
  ctx.beginPath();
  ctx.moveTo(176, 210);
  ctx.lineTo(150, 312);
  ctx.moveTo(336, 210);
  ctx.lineTo(362, 312);
  ctx.lineWidth = 3;
  ctx.strokeStyle = rgba(OUT, 0.55);
  ctx.stroke();
  // the opening
  roundRect(ctx, 186, 232, 140, 72, 4);
  ctx.fillStyle = linear(ctx, 0, 232, 0, 304, [[0, '#0E1013'], [1, '#2A2E33']]);
  ctx.fill();
  ctx.lineWidth = 4;
  ctx.strokeStyle = OUT;
  ctx.stroke();
  ctx.restore();
}

/** Skeet house: a white clapboard shed with a slanted roof and a dark window (canvas 512, ground at y 416). */
export function paintHouseSkeet(ctx) {
  ctx.save();
  ctx.lineJoin = 'round';
  grassMound(ctx, 256, 408, 150, 14);
  ctx.beginPath();
  ctx.moveTo(150, 152);
  ctx.lineTo(362, 196);
  ctx.lineTo(362, 404);
  ctx.lineTo(150, 404);
  ctx.closePath();
  ctx.fillStyle = linear(ctx, 150, 0, 362, 0, [[0, '#FBFAF4'], [1, '#DCD9CF']]);
  ctx.fill();
  ctx.lineWidth = 5;
  ctx.strokeStyle = OUT;
  ctx.stroke();
  ctx.strokeStyle = rgba('#7C7A72', 0.6);
  ctx.lineWidth = 2.5;
  for (let y = 214; y < 400; y += 24) {
    ctx.beginPath();
    ctx.moveTo(154, y);
    ctx.lineTo(358, y);
    ctx.stroke();
  }
  // corner boards
  ctx.fillStyle = '#F4F2EA';
  ctx.fillRect(150, 160, 12, 244);
  ctx.fillRect(350, 196, 12, 208);
  // roof
  ctx.beginPath();
  ctx.moveTo(132, 134);
  ctx.lineTo(392, 186);
  ctx.lineTo(388, 204);
  ctx.lineTo(128, 150);
  ctx.closePath();
  ctx.fillStyle = '#3A434E';
  ctx.fill();
  ctx.lineWidth = 5;
  ctx.strokeStyle = OUT;
  ctx.stroke();
  // window
  roundRect(ctx, 214, 214, 70, 66, 3);
  ctx.fillStyle = '#F7F5EE';
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = '#121418';
  ctx.fillRect(224, 224, 50, 46);
  ctx.restore();
}

/** Tower house: a green cabin on white legs with an X brace (canvas 512, ground at y 406). */
export function paintHouseTower(ctx) {
  ctx.save();
  ctx.lineJoin = 'round';
  grassMound(ctx, 256, 398, 156, 14);
  // legs and braces
  ctx.lineWidth = 16;
  ctx.lineCap = 'butt';
  ctx.strokeStyle = '#F2F0E8';
  for (const x of [150, 362]) {
    ctx.beginPath();
    ctx.moveTo(x, 252);
    ctx.lineTo(x, 400);
    ctx.stroke();
  }
  ctx.lineWidth = 11;
  ctx.beginPath();
  ctx.moveTo(158, 276);
  ctx.lineTo(354, 392);
  ctx.moveTo(354, 276);
  ctx.lineTo(158, 392);
  ctx.moveTo(146, 270);
  ctx.lineTo(366, 270);
  ctx.stroke();
  // outlines of the legs
  ctx.lineWidth = 3;
  ctx.strokeStyle = OUT;
  for (const x of [142, 158, 354, 370]) {
    ctx.beginPath();
    ctx.moveTo(x, 252);
    ctx.lineTo(x, 400);
    ctx.stroke();
  }
  // cabin
  ctx.beginPath();
  ctx.rect(136, 126, 240, 132);
  ctx.fillStyle = linear(ctx, 136, 0, 376, 0, [[0, '#4E8A4A'], [1, '#2F6230']]);
  ctx.fill();
  ctx.lineWidth = 5;
  ctx.stroke();
  ctx.strokeStyle = rgba('#173A1A', 0.6);
  ctx.lineWidth = 3;
  for (let x = 160; x < 376; x += 26) {
    ctx.beginPath();
    ctx.moveTo(x, 130);
    ctx.lineTo(x, 254);
    ctx.stroke();
  }
  // trim and roof slab
  ctx.fillStyle = '#F2F0E8';
  ctx.fillRect(136, 240, 240, 16);
  roundRect(ctx, 116, 106, 280, 22, 3);
  ctx.fill();
  ctx.lineWidth = 4;
  ctx.strokeStyle = OUT;
  ctx.stroke();
  // window
  ctx.fillStyle = '#F2F0E8';
  ctx.fillRect(208, 150, 96, 64);
  ctx.strokeRect(208, 150, 96, 64);
  ctx.fillStyle = '#101317';
  ctx.fillRect(218, 160, 76, 44);
  ctx.restore();
}

// ------------------------------------------------------------------------------------------------------------------------------ gun

/**
 * The over-and-under shotgun seen from behind the shooter's right shoulder (canvas 689 x 800, anchor bottom-right): two blued barrels from
 * the muzzle (0.05, 0.045) down to a silver engraved receiver, a walnut fore-end and stock running to the bottom-right corner.
 */
export function paintGun(ctx) {
  const mx = 34;
  const my = 36;
  const ang = Math.atan2(300, 400);
  ctx.save();
  ctx.lineJoin = 'round';
  // ---- trigger guard and trigger first: the stock is painted over their upper half, so they hang from it (QA F15: it floated)
  ctx.beginPath();
  ctx.ellipse(452, 604, 44, 62, 0.5, 0, TAU);
  ctx.lineWidth = 14;
  ctx.strokeStyle = '#2A2F36';
  ctx.stroke();
  ctx.lineWidth = 3;
  ctx.strokeStyle = OUT;
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(452, 556);
  ctx.quadraticCurveTo(436, 600, 462, 636);
  ctx.lineWidth = 8;
  ctx.strokeStyle = COLORS.brass;
  ctx.stroke();
  // ---- stock (screen space): from the receiver down to the corner
  ctx.beginPath();
  ctx.moveTo(452, 380);
  ctx.bezierCurveTo(520, 420, 600, 470, 689, 520);
  ctx.lineTo(689, 800);
  ctx.lineTo(560, 800);
  ctx.bezierCurveTo(540, 700, 500, 640, 440, 560);
  ctx.bezierCurveTo(410, 520, 400, 470, 410, 430);
  ctx.closePath();
  ctx.fillStyle = linear(ctx, 420, 420, 689, 720, [[0, '#B36D38'], [0.35, '#8E4C24'], [0.7, '#A35F2E'], [1, '#5E2F14']]);
  ctx.fill();
  ctx.lineWidth = 6;
  ctx.strokeStyle = OUT;
  ctx.stroke();
  // wood grain
  ctx.strokeStyle = 'rgba(60,24,8,0.35)';
  ctx.lineWidth = 3;
  for (let i = 0; i < 7; i++) {
    ctx.beginPath();
    ctx.moveTo(440 + i * 18, 460 + i * 10);
    ctx.bezierCurveTo(520 + i * 12, 520 + i * 18, 590 + i * 8, 600 + i * 20, 640 + i * 6, 800);
    ctx.stroke();
  }
  // checkering on the grip
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(470, 560);
  ctx.lineTo(560, 610);
  ctx.lineTo(600, 760);
  ctx.lineTo(520, 720);
  ctx.closePath();
  ctx.clip();
  ctx.strokeStyle = 'rgba(40,16,4,0.35)';
  ctx.lineWidth = 2;
  for (let k = -400; k < 400; k += 12) {
    ctx.beginPath();
    ctx.moveTo(400 + k, 500);
    ctx.lineTo(700 + k, 800);
    ctx.moveTo(700 + k, 500);
    ctx.lineTo(400 + k, 800);
    ctx.stroke();
  }
  ctx.restore();
  // ---- barrels, fore-end and receiver in the barrel frame (x along the barrels from the muzzle, y down across them)
  ctx.translate(mx, my);
  ctx.rotate(ang);
  // fore-end (walnut) under the lower barrel
  ctx.beginPath();
  ctx.moveTo(120, 22);
  ctx.bezierCurveTo(200, 30, 330, 34, 430, 40);
  ctx.lineTo(430, 92);
  ctx.bezierCurveTo(330, 96, 220, 86, 140, 62);
  ctx.quadraticCurveTo(110, 44, 120, 22);
  ctx.closePath();
  ctx.fillStyle = linear(ctx, 0, 20, 0, 96, [[0, '#C07A40'], [0.5, '#9A5428'], [1, '#5C2D12']]);
  ctx.fill();
  ctx.lineWidth = 5;
  ctx.strokeStyle = OUT;
  ctx.stroke();
  // checkering on the fore-end
  ctx.strokeStyle = 'rgba(40,16,4,0.3)';
  ctx.lineWidth = 2;
  for (let x = 190; x < 380; x += 14) {
    ctx.beginPath();
    ctx.moveTo(x, 44);
    ctx.lineTo(x + 26, 80);
    ctx.stroke();
  }
  // lower barrel then upper barrel
  const barrel = (y0, h) => {
    roundRect(ctx, -2, y0, 470, h, h / 2);
    ctx.fillStyle = linear(ctx, 0, y0, 0, y0 + h, [[0, '#6E86A6'], [0.3, '#3A4C66'], [0.75, '#1E2938'], [1, '#141B25']]);
    ctx.fill();
    ctx.lineWidth = 5;
    ctx.strokeStyle = OUT;
    ctx.stroke();
    // long specular
    ctx.beginPath();
    ctx.moveTo(10, y0 + h * 0.28);
    ctx.lineTo(450, y0 + h * 0.28);
    ctx.lineWidth = Math.max(2, h * 0.12);
    ctx.lineCap = 'round';
    ctx.strokeStyle = 'rgba(220,235,255,0.75)';
    ctx.stroke();
  };
  barrel(4, 30);
  barrel(-30, 32);
  // rib and bead
  ctx.fillStyle = '#2A3442';
  ctx.fillRect(4, -38, 456, 8);
  ctx.beginPath();
  ctx.arc(6, -38, 6, 0, TAU);
  ctx.fillStyle = COLORS.brass;
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = OUT;
  ctx.stroke();
  // muzzle bores
  ell(ctx, 1, -14, 6, 13);
  ctx.fillStyle = '#05070A';
  ctx.fill();
  ell(ctx, 1, 19, 6, 12);
  ctx.fill();
  // receiver (silver, engraved)
  ctx.beginPath();
  ctx.moveTo(440, -40);
  ctx.lineTo(540, -30);
  ctx.quadraticCurveTo(560, 40, 540, 110);
  ctx.lineTo(450, 112);
  ctx.quadraticCurveTo(430, 40, 440, -40);
  ctx.closePath();
  ctx.fillStyle = linear(ctx, 440, -40, 540, 110, [[0, '#F1F3F6'], [0.45, '#B9BEC6'], [1, '#7D848E']]);
  ctx.fill();
  ctx.lineWidth = 5;
  ctx.strokeStyle = OUT;
  ctx.stroke();
  ctx.strokeStyle = 'rgba(70,76,86,0.55)';
  ctx.lineWidth = 2;
  const rnd = mulberry32(42);
  for (let i = 0; i < 14; i++) {
    const x = 455 + rnd() * 70;
    const y = -20 + rnd() * 110;
    ctx.beginPath();
    ctx.arc(x, y, 5 + rnd() * 9, rnd() * TAU, rnd() * TAU + 2.2);
    ctx.stroke();
  }
  // top lever
  ctx.beginPath();
  ctx.moveTo(520, -36);
  ctx.quadraticCurveTo(600, -40, 640, -10);
  ctx.lineTo(630, 6);
  ctx.quadraticCurveTo(590, -18, 520, -16);
  ctx.closePath();
  ctx.fillStyle = '#9AA1AB';
  ctx.fill();
  ctx.lineWidth = 4;
  ctx.strokeStyle = OUT;
  ctx.stroke();
  ctx.restore();
}

// ------------------------------------------------------------------------------------------------------------------------------ icons

export function paintIconShell(ctx, full) {
  ctx.save();
  ctx.lineJoin = 'round';
  const x = 40;
  const w = 48;
  const top = 10;
  const h = 108;
  const hull = full ? COLORS.shellRed : '#868D96';
  roundRect(ctx, x, top, w, h * 0.72, 8);
  ctx.fillStyle = linear(ctx, x, 0, x + w, 0, [[0, mix(hull, '#000000', 0.25)], [0.35, mix(hull, '#FFFFFF', 0.3)], [0.6, hull], [1, mix(hull, '#000000', 0.4)]]);
  ctx.fill();
  ctx.lineWidth = 5;
  ctx.strokeStyle = OUT;
  ctx.stroke();
  // crimp star on top
  ctx.strokeStyle = rgba('#000000', 0.4);
  ctx.lineWidth = 2;
  for (let i = 0; i < 4; i++) {
    ctx.beginPath();
    ctx.moveTo(x + 8 + i * 10, top + 4);
    ctx.lineTo(x + 12 + i * 8, top + 14);
    ctx.stroke();
  }
  // brass head
  roundRect(ctx, x - 3, top + h * 0.7, w + 6, h * 0.3, 6);
  ctx.fillStyle = linear(ctx, x, 0, x + w, 0, [[0, '#9A7020'], [0.35, '#FFE7A0'], [0.65, COLORS.brass], [1, '#80601A']]);
  ctx.fill();
  ctx.lineWidth = 5;
  ctx.strokeStyle = OUT;
  ctx.stroke();
  ctx.restore();
}

export function paintIconWind(ctx) {
  ctx.save();
  ctx.lineJoin = 'round';
  // pole
  ctx.lineWidth = 9;
  ctx.lineCap = 'round';
  ctx.strokeStyle = OUT;
  ctx.beginPath();
  ctx.moveTo(18, 18);
  ctx.lineTo(18, 118);
  ctx.stroke();
  ctx.lineWidth = 4;
  ctx.strokeStyle = '#5B6470';
  ctx.stroke();
  // sock: a tapered tube in 5 stripes
  const x0 = 24;
  const x1 = 120;
  const y0 = 26;
  const h0 = 34;
  const h1 = 16;
  for (let i = 0; i < 5; i++) {
    const a = i / 5;
    const b = (i + 1) / 5;
    const xa = x0 + (x1 - x0) * a;
    const xb = x0 + (x1 - x0) * b;
    const ha = h0 + (h1 - h0) * a;
    const hb = h0 + (h1 - h0) * b;
    const sag = 10;
    ctx.beginPath();
    ctx.moveTo(xa, y0 + sag * a * a);
    ctx.lineTo(xb, y0 + sag * b * b);
    ctx.lineTo(xb, y0 + sag * b * b + hb);
    ctx.lineTo(xa, y0 + sag * a * a + ha);
    ctx.closePath();
    ctx.fillStyle = i % 2 === 0 ? COLORS.orange : '#FFFFFF';
    ctx.fill();
  }
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y0 + 10);
  ctx.lineTo(x1, y0 + 10 + h1);
  ctx.lineTo(x0, y0 + h0);
  ctx.closePath();
  ctx.lineWidth = 5;
  ctx.strokeStyle = OUT;
  ctx.stroke();
  ell(ctx, x0 + 2, y0 + h0 / 2, 6, h0 / 2);
  ctx.fillStyle = COLORS.orangeDeep;
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

export function paintIconClock(ctx) {
  ctx.save();
  roundRect(ctx, 52, 6, 24, 14, 4);
  ctx.fillStyle = '#5B6470';
  ctx.fill();
  ctx.lineWidth = 4;
  ctx.strokeStyle = OUT;
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(64, 72, 50, 0, TAU);
  ctx.fillStyle = '#5B6470';
  ctx.fill();
  ctx.lineWidth = 5;
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(64, 72, 40, 0, TAU);
  ctx.fillStyle = '#FFF8EA';
  ctx.fill();
  ctx.lineWidth = 3;
  ctx.stroke();
  ctx.lineCap = 'round';
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * TAU;
    ctx.beginPath();
    ctx.moveTo(64 + Math.cos(a) * 31, 72 + Math.sin(a) * 31);
    ctx.lineTo(64 + Math.cos(a) * 36, 72 + Math.sin(a) * 36);
    ctx.lineWidth = i % 3 === 0 ? 4 : 2;
    ctx.stroke();
  }
  ctx.beginPath();
  ctx.moveTo(64, 72);
  ctx.lineTo(84, 50);
  ctx.lineWidth = 5;
  ctx.strokeStyle = COLORS.terracotta;
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(64, 72, 5, 0, TAU);
  ctx.fillStyle = OUT;
  ctx.fill();
  ctx.restore();
}

export function paintIconStar(ctx) {
  star(ctx, 64, 66, 54, 24, 5);
  ctx.fillStyle = linear(ctx, 0, 10, 0, 120, [[0, '#FFE58A'], [1, '#E0A21C']]);
  ctx.fill();
  ctx.lineWidth = 5;
  ctx.lineJoin = 'round';
  ctx.strokeStyle = OUT;
  ctx.stroke();
}

export function paintIconTrophy(ctx) {
  ctx.save();
  ctx.lineJoin = 'round';
  ctx.lineWidth = 5;
  ctx.strokeStyle = OUT;
  // handles
  ctx.beginPath();
  ctx.arc(26, 38, 16, Math.PI * 0.5, Math.PI * 1.6);
  ctx.moveTo(102, 22);
  ctx.arc(102, 38, 16, -Math.PI * 0.6, Math.PI * 0.5);
  ctx.lineWidth = 9;
  ctx.strokeStyle = '#D9A21C';
  ctx.stroke();
  // cup
  ctx.beginPath();
  ctx.moveTo(28, 12);
  ctx.lineTo(100, 12);
  ctx.quadraticCurveTo(100, 76, 64, 82);
  ctx.quadraticCurveTo(28, 76, 28, 12);
  ctx.closePath();
  ctx.fillStyle = linear(ctx, 28, 0, 100, 0, [[0, '#E0A21C'], [0.4, '#FFE58A'], [1, '#C88D16']]);
  ctx.fill();
  ctx.lineWidth = 5;
  ctx.strokeStyle = OUT;
  ctx.stroke();
  ctx.fillStyle = '#E0A21C';
  ctx.fillRect(56, 82, 16, 16);
  ctx.strokeRect(56, 82, 16, 16);
  roundRect(ctx, 34, 98, 60, 20, 4);
  ctx.fillStyle = '#7A4A26';
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

// ------------------------------------------------------------------------------------------------------------------------ backdrops

/** Sum of sines: a smooth seeded ridge line y(x) for hills. */
function ridge(rnd, amp, waves = 3) {
  const parts = [];
  for (let i = 0; i < waves; i++) parts.push({ f: (0.6 + i * 0.9 + rnd()) * TAU, p: rnd() * TAU, a: amp / (i + 1) });
  return (u) => {
    let y = 0;
    for (const w of parts) y += Math.sin(u * w.f + w.p) * w.a;
    return y;
  };
}

function cypress(ctx, x, base, h, color) {
  ctx.beginPath();
  ctx.moveTo(x, base - h);
  ctx.bezierCurveTo(x + h * 0.16, base - h * 0.7, x + h * 0.14, base - h * 0.1, x, base);
  ctx.bezierCurveTo(x - h * 0.14, base - h * 0.1, x - h * 0.16, base - h * 0.7, x, base - h);
  ctx.fillStyle = color;
  ctx.fill();
}

function pine(ctx, x, base, h, color) {
  ctx.beginPath();
  ctx.moveTo(x, base - h);
  for (let i = 1; i <= 3; i++) {
    const y = base - h + (h * i) / 3.2;
    const w = h * 0.12 * i;
    ctx.lineTo(x + w, y);
    ctx.lineTo(x + w * 0.45, y - h * 0.04);
  }
  ctx.lineTo(x + h * 0.06, base);
  ctx.lineTo(x - h * 0.06, base);
  for (let i = 3; i >= 1; i--) {
    const y = base - h + (h * i) / 3.2;
    const w = h * 0.12 * i;
    ctx.lineTo(x - w * 0.45, y - h * 0.04);
    ctx.lineTo(x - w, y);
  }
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
}

function cloud(ctx, x, y, s, tint) {
  const blobs = [[0, 0, 1], [0.9, 0.15, 0.75], [-0.9, 0.2, 0.7], [0.4, -0.45, 0.8], [-0.4, -0.3, 0.65], [1.7, 0.35, 0.5], [-1.6, 0.4, 0.45]];
  ctx.fillStyle = rgba(tint, 0.95);
  for (const [dx, dy, r] of blobs) {
    ctx.beginPath();
    ctx.arc(x + dx * s, y + dy * s, r * s * 0.62, 0, TAU);
    ctx.fill();
  }
  ctx.fillStyle = 'rgba(160,180,210,0.28)';
  ctx.beginPath();
  ctx.ellipse(x, y + s * 0.45, s * 2.1, s * 0.2, 0, 0, TAU);
  ctx.fill();
}

/**
 * Far layer of a stage (opaque): sky, sun glow, clouds or stars, mountains, rolling hills with trees, a farmhouse, the hedge and fence at
 * the horizon, and the mown meadow with stripes converging on the vanishing point. Painted in a w x h canvas whose horizon sits at
 * `horizonFrac` of the height (the generated pictures use 0.62), so it is drawn exactly like the JPEG it replaces.
 */
export function paintBackdropFar(ctx, stageId, w, h, horizonFrac = 0.62) {
  const pal = STAGE_PALETTES[stageId] ?? STAGE_PALETTES.hills;
  const rnd = mulberry32(stageId === 'meadow' ? 101 : stageId === 'alpine' ? 303 : 202);
  const hy = h * horizonFrac;
  const k = w / 1920;
  ctx.save();
  // sky
  ctx.fillStyle = linear(ctx, 0, 0, 0, hy, [[0, pal.sky[0]], [0.45, pal.sky[1]], [0.8, pal.sky[2]], [1, pal.sky[3]]]);
  ctx.fillRect(0, 0, w, hy + 2);
  // sun glow
  const sun = pal.sun;
  ctx.fillStyle = radial(ctx, sun.x * k, sun.y * k, sun.r * k, [[0, rgba(sun.color, sun.alpha)], [0.25, rgba(sun.color, sun.alpha * 0.55)], [1, rgba(sun.color, 0)]]);
  ctx.fillRect(0, 0, w, hy);
  if (stageId === 'hills') {
    ctx.beginPath();
    ctx.arc(sun.x * k, sun.y * k, 46 * k, 0, TAU);
    ctx.fillStyle = 'rgba(255,246,214,0.9)';
    ctx.fill();
  }
  // stars
  if (pal.stars) {
    for (let i = 0; i < 70; i++) {
      const x = rnd() * w;
      const y = rnd() * hy * 0.45;
      const s = 0.8 + rnd() * 1.8;
      ctx.fillStyle = `rgba(255,255,255,${0.35 + rnd() * 0.6})`;
      ctx.fillRect(x, y, s, s);
    }
  }
  // clouds only at the edges: the sky band in the centre stays clean for the targets (design 10 readability)
  if (pal.clouds) {
    const tint = stageId === 'hills' ? '#FFF2D8' : '#FFFFFF';
    cloud(ctx, 210 * k, 250 * k, 70 * k, tint);
    cloud(ctx, 1740 * k, 210 * k, 62 * k, tint);
    cloud(ctx, 60 * k, 420 * k, 40 * k, tint);
  }
  // mountains (alpine: snow peaks; others: soft blue ranges)
  const mBase = hy - 0.04 * h;
  if (stageId === 'alpine') {
    const peaks = [[-0.02, 0.17], [0.1, 0.21], [0.26, 0.29], [0.4, 0.2], [0.5, 0.14], [0.62, 0.22], [0.77, 0.32], [0.9, 0.22], [1.04, 0.18]];
    ctx.beginPath();
    ctx.moveTo(0, mBase + 0.05 * h);
    for (let i = 0; i < peaks.length; i++) {
      const [u, ph] = peaks[i];
      const x = u * w;
      ctx.lineTo(x - 0.05 * w, mBase - ph * h * 0.55);
      ctx.lineTo(x, mBase - ph * h);
      ctx.lineTo(x + 0.04 * w, mBase - ph * h * 0.6);
    }
    ctx.lineTo(w, mBase + 0.05 * h);
    ctx.closePath();
    ctx.fillStyle = linear(ctx, 0, mBase - 0.32 * h, 0, mBase, [[0, pal.mountains[0]], [1, pal.mountains[1]]]);
    ctx.fill();
    // snow caps lit by the dusk
    for (const [u, ph] of peaks) {
      const x = u * w;
      const top = mBase - ph * h;
      ctx.beginPath();
      ctx.moveTo(x, top);
      ctx.lineTo(x + 0.04 * w * 0.45, top + ph * h * 0.18);
      ctx.lineTo(x + 0.01 * w, top + ph * h * 0.14);
      ctx.lineTo(x - 0.012 * w, top + ph * h * 0.22);
      ctx.lineTo(x - 0.05 * w * 0.45, top + ph * h * 0.2);
      ctx.closePath();
      ctx.fillStyle = linear(ctx, x - 0.03 * w, top, x + 0.03 * w, top, [[0, pal.snow], [1, '#FFC9A8']]);
      ctx.fill();
    }
  } else {
    for (let layer = 0; layer < 2; layer++) {
      const f = ridge(rnd, 0.022 * h, 3);
      const base = mBase - (0.05 - layer * 0.025) * h;
      ctx.beginPath();
      ctx.moveTo(0, hy);
      for (let x = 0; x <= w; x += 12) ctx.lineTo(x, base + f(x / w) - 0.02 * h * Math.sin((x / w) * Math.PI));
      ctx.lineTo(w, hy);
      ctx.closePath();
      ctx.fillStyle = pal.mountains[layer];
      ctx.fill();
    }
  }
  // haze over the distance
  ctx.fillStyle = linear(ctx, 0, hy - 0.16 * h, 0, hy, [[0, rgba(pal.haze, 0)], [1, rgba(pal.haze, 0.55)]]);
  ctx.fillRect(0, hy - 0.16 * h, w, 0.16 * h);
  // a lake in the valley (alpine)
  if (pal.lake) {
    ell(ctx, w * 0.52, hy - 0.035 * h, w * 0.16, 0.022 * h);
    ctx.fillStyle = linear(ctx, 0, hy - 0.06 * h, 0, hy, [[0, rgba(pal.lake, 0.95)], [1, rgba(pal.accent, 0.9)]]);
    ctx.fill();
  }
  // rolling hills: three bands, nearer = lower and darker, with trees on the crests
  for (let layer = 0; layer < 3; layer++) {
    const f = ridge(rnd, (0.018 + layer * 0.008) * h, 3);
    const base = hy - (0.07 - layer * 0.025) * h;
    const col = pal.hills[layer];
    const pts = [];
    ctx.beginPath();
    ctx.moveTo(0, hy + 4);
    for (let x = 0; x <= w; x += 10) {
      // keep the middle low (the valley) so the targets fly over open sky
      const valley = 0.03 * h * Math.exp(-(((x / w - 0.5) / 0.18) ** 2));
      const y = base + f(x / w) + valley;
      pts.push([x, y]);
      ctx.lineTo(x, y);
    }
    ctx.lineTo(w, hy + 4);
    ctx.closePath();
    ctx.fillStyle = linear(ctx, 0, base - 0.04 * h, 0, hy, [[0, mix(col, pal.hillTint, 0.35)], [1, col]]);
    ctx.fill();
    // field rows on the golden hills
    if (stageId === 'hills' && layer === 1) {
      ctx.save();
      ctx.clip();
      ctx.strokeStyle = rgba('#5E6A2A', 0.35);
      ctx.lineWidth = 2;
      for (let i = 0; i < 26; i++) {
        const x = w * 0.62 + i * 14 * k;
        ctx.beginPath();
        ctx.moveTo(x, hy);
        ctx.lineTo(x + 70 * k, base - 0.03 * h);
        ctx.stroke();
      }
      ctx.restore();
    }
    // trees along the crest, never in the central sky band
    const count = 26 + layer * 8;
    for (let i = 0; i < count; i++) {
      const u = rnd();
      if (u > 0.36 && u < 0.64 && layer < 2) continue;
      const p = pts[Math.min(pts.length - 1, Math.floor(u * (pts.length - 1)))];
      const th = (0.03 + layer * 0.012 + rnd() * 0.02) * h;
      const color = layer === 0 ? pal.treesFar : mix(pal.trees, pal.treesFar, 0.4 - layer * 0.2);
      if (stageId === 'alpine') pine(ctx, p[0], p[1] + 3, th * 1.1, color);
      else if (rnd() < 0.75) cypress(ctx, p[0], p[1] + 3, th * 1.2, color);
      else {
        ctx.beginPath();
        ctx.arc(p[0], p[1] - th * 0.3, th * 0.38, 0, TAU);
        ctx.fillStyle = color;
        ctx.fill();
      }
    }
    // a farmhouse on the middle band
    if (layer === 1) {
      const hx = stageId === 'hills' ? 0.12 * w : 0.82 * w;
      const p = pts[Math.floor((hx / w) * (pts.length - 1))];
      const bw = 70 * k;
      const bh = 34 * k;
      ctx.fillStyle = stageId === 'alpine' ? '#5A4636' : '#F1D9B0';
      ctx.fillRect(hx - bw / 2, p[1] - bh, bw, bh);
      ctx.fillStyle = stageId === 'alpine' ? '#2E2420' : COLORS.terracotta;
      ctx.beginPath();
      ctx.moveTo(hx - bw * 0.6, p[1] - bh);
      ctx.lineTo(hx, p[1] - bh - 16 * k);
      ctx.lineTo(hx + bw * 0.6, p[1] - bh);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = stageId === 'alpine' ? '#FFD27A' : '#7A5A3A';
      for (let i = 0; i < 3; i++) ctx.fillRect(hx - bw * 0.36 + i * bw * 0.28, p[1] - bh * 0.62, 8 * k, 9 * k);
    }
  }
  // hedge and fence on the horizon
  ctx.fillStyle = pal.hedge;
  ctx.beginPath();
  ctx.moveTo(0, hy + 6);
  for (let x = 0; x <= w; x += 14) ctx.lineTo(x, hy - 10 - 7 * Math.abs(Math.sin(x * 0.037)) - 5 * rnd());
  ctx.lineTo(w, hy + 6);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = pal.fence;
  ctx.fillRect(0, hy - 8, w, 3);
  ctx.fillRect(0, hy - 2, w, 3);
  for (let x = 6; x < w; x += 46 * k) ctx.fillRect(x, hy - 14, 4, 18);
  // the mown meadow
  ctx.fillStyle = linear(ctx, 0, hy, 0, h, [[0, pal.grass[1]], [0.35, pal.grass[0]], [1, pal.grass[3]]]);
  ctx.fillRect(0, hy, w, h - hy);
  // stripes converging on the vanishing point
  const vx = w / 2;
  const vy = hy - 0.25 * h;
  const n = 18;
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, hy, w, h - hy);
  ctx.clip();
  for (let i = 0; i < n; i += 2) {
    const xa = -w * 1.2 + (i / n) * w * 3.4;
    const xb = -w * 1.2 + ((i + 1) / n) * w * 3.4;
    ctx.beginPath();
    ctx.moveTo(vx, vy);
    ctx.lineTo(xa, h * 1.6);
    ctx.lineTo(xb, h * 1.6);
    ctx.closePath();
    ctx.fillStyle = rgba(pal.stripeA, 0.55);
    ctx.fill();
  }
  ctx.restore();
  // depth: darker towards the bottom, haze at the horizon
  ctx.fillStyle = linear(ctx, 0, hy, 0, h, [[0, rgba(pal.haze, 0.35)], [0.12, rgba(pal.haze, 0)], [1, 'rgba(0,0,0,0.18)']]);
  ctx.fillRect(0, hy, w, h - hy);
  ctx.restore();
}

/**
 * Near layer of a stage (transparent): tall grass in the bottom corners dipping towards the middle, with flowers; a fence post on the left
 * (meadow), poppies and wheat (hills), rocks and a lantern post (alpine). Painted in a w x h canvas (16:9).
 */
export function paintBackdropNear(ctx, stageId, w, h) {
  const pal = STAGE_PALETTES[stageId] ?? STAGE_PALETTES.hills;
  const rnd = mulberry32(stageId === 'meadow' ? 909 : stageId === 'alpine' ? 707 : 808);
  const k = w / 1920;
  const edge = (u) => h - (0.11 + 0.26 * Math.pow(Math.abs(u - 0.5) * 2, 2.2)) * h;
  ctx.save();
  // alpine: rocks behind the grass
  if (stageId === 'alpine') {
    for (const [u, s] of [[0.15, 1], [0.86, 1.15], [0.42, 0.45], [0.66, 0.4]]) {
      const x = u * w;
      const y = edge(u) + 40 * k;
      ell(ctx, x, y, 150 * s * k, 70 * s * k);
      ctx.fillStyle = linear(ctx, x - 100 * k, y - 70 * k, x + 100 * k, y + 50 * k, [[0, '#8C8AA8'], [1, '#3E3E58']]);
      ctx.fill();
    }
    // lantern post with a warm glow
    const lx = 90 * k;
    const ly = h * 0.62;
    ctx.fillStyle = radial(ctx, lx + 60 * k, ly + 80 * k, 220 * k, [[0, 'rgba(255,190,110,0.55)'], [1, 'rgba(255,170,90,0)']]);
    ctx.fillRect(lx - 200 * k, ly - 160 * k, 480 * k, 480 * k);
    ctx.fillStyle = '#4A3528';
    ctx.fillRect(lx - 10 * k, ly, 20 * k, h - ly);
    ctx.fillRect(lx - 10 * k, ly, 110 * k, 14 * k);
    roundRect(ctx, lx + 70 * k, ly + 30 * k, 40 * k, 56 * k, 6 * k);
    ctx.fillStyle = '#FFD58A';
    ctx.fill();
    ctx.lineWidth = 4 * k;
    ctx.strokeStyle = '#2A1E16';
    ctx.stroke();
  }
  if (stageId === 'meadow') {
    // fence post and rail on the left
    ctx.fillStyle = linear(ctx, 120 * k, 0, 220 * k, 0, [[0, '#8C7458'], [1, '#5E4A36']]);
    roundRect(ctx, 130 * k, h * 0.6, 84 * k, h * 0.4, 10 * k);
    ctx.fill();
    ctx.fillRect(-20, h * 0.66, 150 * k, 46 * k);
  }
  // grass body
  ctx.beginPath();
  ctx.moveTo(0, h);
  for (let x = 0; x <= w; x += 8) ctx.lineTo(x, edge(x / w) + 24 * k);
  ctx.lineTo(w, h);
  ctx.closePath();
  ctx.fillStyle = linear(ctx, 0, h * 0.6, 0, h, [[0, pal.nearGrass[1]], [1, pal.nearGrass[0]]]);
  ctx.fill();
  // blades
  const blades = 520;
  for (let i = 0; i < blades; i++) {
    const u = rnd();
    const x = u * w;
    const base = edge(u) + 30 * k + rnd() * 60 * k;
    const len = (40 + rnd() * 90) * k * (0.6 + 0.8 * Math.abs(u - 0.5) * 2);
    const lean = (rnd() - 0.5) * 50 * k;
    const bw = (5 + rnd() * 7) * k;
    ctx.beginPath();
    ctx.moveTo(x - bw, base);
    ctx.quadraticCurveTo(x + lean * 0.3, base - len * 0.6, x + lean, base - len);
    ctx.quadraticCurveTo(x + lean * 0.3 + bw * 0.3, base - len * 0.5, x + bw, base);
    ctx.closePath();
    ctx.fillStyle = pal.nearGrass[i % 3];
    ctx.fill();
  }
  // flowers
  const flowers = stageId === 'alpine' ? 18 : 30;
  for (let i = 0; i < flowers; i++) {
    let u = rnd();
    if (u > 0.3 && u < 0.7) u = u < 0.5 ? u - 0.25 : u + 0.25;
    const x = u * w;
    const y = edge(u) + (50 + rnd() * 160) * k;
    const s = (7 + rnd() * 6) * k;
    const col = pal.flowers[i % pal.flowers.length];
    if (stageId === 'hills' && i % 2 === 0) {
      // poppy
      ctx.beginPath();
      ctx.arc(x, y, s * 1.1, 0, TAU);
      ctx.fillStyle = col;
      ctx.fill();
      ctx.beginPath();
      ctx.arc(x, y, s * 0.35, 0, TAU);
      ctx.fillStyle = '#2A1A14';
      ctx.fill();
    } else {
      ctx.fillStyle = col;
      for (let p = 0; p < 6; p++) {
        const a = (p / 6) * TAU;
        ctx.beginPath();
        ctx.ellipse(x + Math.cos(a) * s * 0.8, y + Math.sin(a) * s * 0.8, s * 0.55, s * 0.32, a, 0, TAU);
        ctx.fill();
      }
      ctx.beginPath();
      ctx.arc(x, y, s * 0.4, 0, TAU);
      ctx.fillStyle = stageId === 'alpine' ? '#F4F0FF' : '#F2B630';
      ctx.fill();
    }
  }
  // soft shade at the very bottom so the HUD reads
  ctx.fillStyle = linear(ctx, 0, h * 0.86, 0, h, [[0, 'rgba(0,0,0,0)'], [1, 'rgba(0,0,0,0.22)']]);
  ctx.fillRect(0, h * 0.86, w, h * 0.14);
  ctx.restore();
}

// ------------------------------------------------------------------------------------------------------------------------ dispatch

/** Paint the procedural picture of an id into a context already scaled to its canvas space. Unknown ids paint nothing (returns false). */
export function paintSprite(ctx, id) {
  switch (id) {
    case 'clay_std_tilt': paintClayTilt(ctx); return true;
    case 'clay_std_below': paintClayBelow(ctx); return true;
    case 'clay_std_edge': paintClayEdge(ctx); return true;
    case 'clay_rabbit': paintClayRabbit(ctx); return true;
    case 'clay_gold_tilt':
      paintClayTilt(ctx, CLAY_COLORS.gold);
      paintSparkle(ctx, 84, 78, 30, '#FFFFFF');
      return true;
    case 'fx_flash_star': paintFlashStar(ctx); return true;
    case 'fx_flash_side': paintFlashSide(ctx); return true;
    case 'fx_smoke_puff': paintPuff(ctx); return true;
    case 'fx_smoke_trail':
      paintPuff(ctx, 90, 140, 60, '#ECEAE6', 5);
      paintPuff(ctx, 170, 110, 44, '#ECEAE6', 6);
      return true;
    case 'fx_dust_burst': paintDustBurst(ctx); return true;
    case 'fx_shell_casing': paintShellCasing(ctx); return true;
    case 'fx_glow': paintGlow(ctx, 128, '#FFC873'); return true;
    case 'fx_glow_gold': paintGlow(ctx, 128, '#FFD95A'); return true;
    case 'fx_sparkle':
      paintGlow(ctx, 64, '#FFF2B0');
      paintSparkle(ctx, 32, 32, 30, '#FFFFFF');
      return true;
    case 'fx_vignette': paintVignette(ctx); return true;
    case 'house_trap': paintHouseTrap(ctx); return true;
    case 'house_skeet': paintHouseSkeet(ctx); return true;
    case 'house_tower': paintHouseTower(ctx); return true;
    case 'icon_shell_full': paintIconShell(ctx, true); return true;
    case 'icon_shell_empty': paintIconShell(ctx, false); return true;
    case 'icon_clay': paintClayTilt(ctx, CLAY_COLORS.std, 64, 64, 54); return true;
    case 'icon_wind': paintIconWind(ctx); return true;
    case 'icon_clock': paintIconClock(ctx); return true;
    case 'icon_star': paintIconStar(ctx); return true;
    case 'icon_trophy': paintIconTrophy(ctx); return true;
    case 'gun_ou': paintGun(ctx); return true;
    default:
      if (id.startsWith('shard_std_')) {
        paintShard(ctx, Number(id.slice(10)) || 1, false);
        return true;
      }
      if (id.startsWith('shard_gold_')) {
        paintShard(ctx, Number(id.slice(11)) || 1, true);
        return true;
      }
      return false;
  }
}
