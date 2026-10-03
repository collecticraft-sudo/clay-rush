// Sprite provider: one call draws any picture of the game, from the generated art when it is loaded and from the procedural painter
// otherwise. OWNER: Render & Audio engineer.
//
// Both paths share the geometry of the manifest entry (procedural ones use PROC_META of painters.js, which mirrors it): canvas size, content
// box, anchor, body circle, muzzle. A sprite is drawn at a SCALE (logical px per source px) about a PIVOT in source px (default: the anchor).
//
// CACHE (no per-frame allocation): scales are quantised to buckets (ratio ART_CONFIG.targets.bucketRatio, the next bucket UP so the cached
// picture is only ever reduced by the GPU), and each (id, bucket) keeps one baked canvas: for the art the loader's `assets.scaled()` (a
// high-quality halving downscale of the content box), for the procedural picture a canvas painted once at that size. Lookups go through
// nested Maps keyed by the id string and the integer bucket, so a hit builds no string and no object. The cache is dropped when the assets
// generation changes (a group loaded or released) and is capped (oldest bucket maps cleared first).

import { ART_CONFIG } from './art-config.js';
import { PROC_META, paintSprite } from './painters.js';

const MAX_PIXELS = 2048; // longest side of a baked canvas, device px
const MAX_ENTRIES = 900;

/**
 * @param {{assets?:object, createCanvas?:(w:number,h:number)=>any, density?:number, config?:object}} [opts]
 */
export function createSprites(opts = {}) {
  const assets = opts.assets && typeof opts.assets.has === 'function' ? opts.assets : null;
  const createCanvas = typeof opts.createCanvas === 'function' ? opts.createCanvas : null;
  const cfg = opts.config ?? ART_CONFIG;
  const ratio = cfg.targets?.bucketRatio > 1 ? cfg.targets.bucketRatio : 1.12;
  const logRatio = Math.log(ratio);
  let density = opts.density > 0 ? opts.density : cfg.density ?? 2;
  /** @type {Map<string, Map<number, object|null>>} */
  const cache = new Map();
  /** id -> the loader's picture the cached bitmaps were made from (null: the procedural painter). */
  const srcOf = new Map();
  let entries = 0;
  let seenGen = assets ? assets.generation : 0;
  let bakes = 0;

  /**
   * The loader's generation moved (any group loaded or released, stage backdrops included): drop ONLY the ids whose picture changed (the
   * art arrived or left), so a backdrop arriving mid-round never re-bakes the clays, the houses and the gun (code review R-03).
   */
  function refresh() {
    if (!assets) return;
    const g = assets.generation;
    if (g === seenGen) return;
    seenGen = g;
    for (const [id, byId] of cache) {
      const img = assets.has(id) ? assets.get(id) : null;
      if (img === (srcOf.get(id) ?? null)) continue;
      entries -= byId.size;
      cache.delete(id);
      srcOf.delete(id);
    }
  }

  function clear() {
    cache.clear();
    srcOf.clear();
    entries = 0;
  }

  /** True when the generated picture of `id` is loaded. */
  function isArt(id) {
    return !!assets && assets.has(id) && !!assets.meta(id);
  }

  /** The geometry of `id`: the manifest entry of the art when loaded, else PROC_META (null for an unknown id). */
  function meta(id) {
    if (isArt(id)) return assets.meta(id);
    return PROC_META[id] ?? null;
  }

  function bucketOf(scale) {
    return Math.ceil(Math.log(scale) / logRatio - 1e-6);
  }

  function bake(id, b) {
    const s = Math.pow(ratio, b);
    if (isArt(id)) {
      const m = assets.meta(id);
      const cb = m.contentBox;
      const dens = Math.min(density, MAX_PIXELS / Math.max(cb.w * s, cb.h * s, 1));
      const img = assets.scaled(id, cb.w * s, cb.h * s, dens);
      if (img && img.canvas) return { canvas: img.canvas, art: true, cbx: cb.x, cby: cb.y, cbw: cb.w, cbh: cb.h, m };
      return null;
    }
    const m = PROC_META[id];
    if (!m || !createCanvas) return null;
    const dens = Math.min(density, MAX_PIXELS / Math.max(m.width * s, m.height * s, 1));
    const k = s * dens;
    const pw = Math.max(1, Math.ceil(m.width * k));
    const ph = Math.max(1, Math.ceil(m.height * k));
    let canvas = null;
    try {
      canvas = createCanvas(pw, ph);
      const c = canvas && canvas.getContext ? canvas.getContext('2d') : null;
      if (!c) return null;
      c.setTransform(k, 0, 0, k, 0, 0);
      c.imageSmoothingEnabled = true;
      if (!paintSprite(c, id)) return null;
    } catch {
      return null;
    }
    bakes++;
    return { canvas, art: false, cbx: 0, cby: 0, cbw: m.width, cbh: m.height, m };
  }

  /** The baked entry of `id` for a draw at `scale`, or null (unknown id, no canvas factory). */
  function lookup(id, scale) {
    refresh();
    if (!(scale > 0)) return null;
    const b = bucketOf(scale);
    let byId = cache.get(id);
    if (!byId) {
      byId = new Map();
      cache.set(id, byId);
      srcOf.set(id, assets && assets.has(id) ? assets.get(id) : null);
    }
    let e = byId.get(b);
    if (e === undefined) {
      if (entries >= MAX_ENTRIES) {
        clear();
        byId = new Map();
        cache.set(id, byId);
        srcOf.set(id, assets && assets.has(id) ? assets.get(id) : null);
      }
      e = bake(id, b);
      byId.set(b, e);
      entries++;
    }
    return e;
  }

  /**
   * Draw `id` with its pivot (source px, default the anchor) at (x, y), at `scale`, rotated by `rot` rad, with `alpha`. `flipX` mirrors it.
   * `bucketScale` (default `scale`) picks the cached picture: an effect that grows or a family of pieces of one size class passes its
   * largest scale, so it uses ONE cached canvas for its whole life instead of a new bucket per step.
   * Returns false when nothing could be drawn (the caller may paint something simpler).
   */
  function draw(ctx, id, x, y, scale, rot = 0, alpha = 1, pivotX, pivotY, flipX = false, bucketScale = scale) {
    if (!(alpha > 0.003) || !(scale > 0)) return true;
    const e = lookup(id, bucketScale > 0 ? bucketScale : scale);
    if (!e) return false;
    const px = pivotX ?? e.m.anchor.x;
    const py = pivotY ?? e.m.anchor.y;
    const dx = (e.cbx - px) * scale;
    const dy = (e.cby - py) * scale;
    const dw = e.cbw * scale;
    const dh = e.cbh * scale;
    const prevA = ctx.globalAlpha;
    if (alpha !== 1) ctx.globalAlpha = prevA * alpha;
    if (rot === 0 && !flipX) {
      ctx.drawImage(e.canvas, x + dx, y + dy, dw, dh);
    } else {
      ctx.save();
      ctx.translate(x, y);
      if (rot !== 0) ctx.rotate(rot);
      if (flipX) ctx.scale(-1, 1);
      ctx.drawImage(e.canvas, dx, dy, dw, dh);
      ctx.restore();
    }
    if (alpha !== 1) ctx.globalAlpha = prevA;
    return true;
  }

  /**
   * Draw `id` with a screen-space vertical squash: translate to (x, y), scale(1, squashY), rotate(rot), the sprite about its pivot. The
   * clays use it for their continuous look (a level disc seen edge-on is a flat ellipse). Coordinates stay sub-pixel (no rounding).
   */
  function drawSquashed(ctx, id, x, y, scale, rot, squashY, alpha, pivotX, pivotY, bucketScale = scale) {
    if (!(alpha > 0.003) || !(scale > 0)) return true;
    const e = lookup(id, bucketScale > 0 ? bucketScale : scale);
    if (!e) return false;
    const dx = (e.cbx - pivotX) * scale;
    const dy = (e.cby - pivotY) * scale;
    const prevA = ctx.globalAlpha;
    ctx.save();
    ctx.globalAlpha = prevA * alpha;
    ctx.translate(x, y);
    if (squashY !== 1) ctx.scale(1, squashY);
    if (rot !== 0) ctx.rotate(rot);
    ctx.drawImage(e.canvas, dx, dy, e.cbw * scale, e.cbh * scale);
    ctx.restore();
    return true;
  }

  // ---- prewarm: bake the size buckets of the clays ahead of time, a few per frame, so no clay ever pays a bake while it flies
  const warmQueue = [];
  /** Queue every bucket of `id` between minScale and maxScale (the cache skips those already baked). */
  function prewarm(id, minScale, maxScale) {
    if (!(minScale > 0) || !(maxScale > minScale)) return;
    const b0 = bucketOf(minScale);
    const b1 = bucketOf(maxScale);
    for (let b = b0; b <= b1; b++) warmQueue.push(id, b);
  }
  /** Bake up to `n` queued buckets now. Returns how many are still queued. */
  function pump(n = 2) {
    refresh();
    let done = 0;
    while (warmQueue.length > 0 && done < n) {
      const b = warmQueue.pop();
      const id = warmQueue.pop();
      let byId = cache.get(id);
      if (!byId) {
        byId = new Map();
        cache.set(id, byId);
        srcOf.set(id, assets && assets.has(id) ? assets.get(id) : null);
      }
      if (byId.has(b)) continue;
      if (entries >= MAX_ENTRIES) break;
      byId.set(b, bake(id, b));
      entries++;
      done++;
    }
    return warmQueue.length / 2;
  }

  /** Draw `id` centred on (cx, cy), fitted (contain) into a box of `size` x `size` logical px (`bucketSize`: see draw()). */
  function drawIcon(ctx, id, cx, cy, size, alpha = 1, rot = 0, flipX = false, bucketSize = size) {
    const m = meta(id);
    if (!m) return false;
    const cb = m.contentBox;
    const k = 1 / Math.max(cb.w, cb.h);
    return draw(ctx, id, cx, cy, size * k, rot, alpha, cb.x + cb.w / 2, cb.y + cb.h / 2, flipX, bucketSize * k);
  }

  return {
    meta,
    isArt,
    lookup,
    draw,
    drawIcon,
    drawSquashed,
    prewarm,
    pump,
    bucketScaleOf: (scale) => Math.pow(ratio, bucketOf(scale)),
    clear,
    setDensity(k) {
      const d = Math.min(3, Math.max(1, Math.ceil((Number(k) || 1) * 2) / 2));
      if (d !== density) {
        density = d;
        clear();
      }
    },
    get density() { return density; },
    stats: () => ({ entries, bakes, ids: cache.size }),
  };
}
