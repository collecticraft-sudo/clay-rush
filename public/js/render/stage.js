// Stage backdrops: which two-layer background sits behind (far) and in front of (near) the gameplay. OWNER: Render & Audio engineer.
//
// One stage = two layers loaded as the assets group `stage:<id>` (architecture C-11, section 7): `bg_<id>_far` (2560 x 1440 opaque JPEG,
// horizon at 62 percent of its height) and `bg_<id>_near` (1920 x 1080 transparent PNG, grass along the bottom). Every layer is optional:
// until a group is ready (and for good when it fails, or with `?assets=0`) the stage shows its PROCEDURAL twin, painted once per stage by
// painters.js into a canvas of the same frame. A "visual" is (stage id, art or procedural); a change of visual is a 400 ms crossfade
// (a cut with Reduce motion), so a stage change and the moment the art arrives both blend instead of popping.
//
// RESIDENCY: at most `maxResidentStages` art groups are decoded at once (the shown one and the one fading in). An art group is released
// through `assets.release` when it is neither wanted nor on screen. A release made by someone else drops the stage back to its procedural
// twin at once (no blank frame) and the next setStage loads it again.
//
// DRAWING: `draw(ctx, 'far', view)` before the houses, `draw(ctx, 'near', view)` after the targets. `view` carries the parallax offsets the
// world renderer computed (aim and recoil; zero with Reduce motion) and the clock. Layers are drawn larger than the field by an overscan so
// the offsets and the camera shake never show an edge. No allocation per frame.

import { ART_CONFIG } from './art-config.js';
import { paintBackdropFar, paintBackdropNear } from './painters.js';
import { FIELD } from '../shared/playfield.js';
import { WORLD } from '../shared/world.js';

export const STAGE_IDS = Object.freeze(['meadow', 'hills', 'alpine']);
/** Layer names, back to front. The asset id of a layer is `bg_<stage>_<layer>`. */
export const STAGE_LAYERS = Object.freeze(['far', 'near']);

/** Assets group name of a stage. */
export const stageGroup = (id) => `stage:${id}`;
/** Asset id of one layer of a stage. */
export const layerAssetId = (id, layer) => `bg_${id}_${layer}`;

const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * Destination rectangle of the far layer (logical px) for a picture of aspect `aspect` (w / h): `overscan` wider than the field on each
 * side, placed so that its horizon (`horizonFrac` of its height) lands on WORLD.horizonY. Writes into `out`.
 */
export function farRect(aspect, overscan, horizonFrac, out, baseScale = 1) {
  out.w = (FIELD.w + 2 * overscan) * baseScale;
  out.h = out.w / aspect;
  out.x = FIELD.cx - out.w / 2;
  out.y = WORLD.horizonY - horizonFrac * out.h;
  // never leave a gap at the bottom (a picture whose horizon is too low for the field): grow it
  if (out.y + out.h < FIELD.h) out.h = FIELD.h - out.y;
  return out;
}

/** Destination rectangle of the near layer: `overscan` wider than the field, centred, bottom-heavy (16:9). Writes into `out`. */
export function nearRect(aspect, overscan, out) {
  out.w = FIELD.w + 2 * overscan;
  out.h = out.w / aspect;
  out.x = -overscan;
  out.y = FIELD.h + (out.h - FIELD.h) / 2 - out.h;
  return out;
}

/**
 * Zoom a layer rectangle about the horizon point (FIELD.cx, WORLD.horizonY) by `z`, never below the zoom at which it still covers the field
 * with `margin` px on every side (a zoom-out stops where the picture would show its edge). Writes into `r` and returns the zoom used.
 */
export function zoomRect(r, z, margin) {
  const cx = FIELD.cx;
  const hy = WORLD.horizonY;
  let zz = Number.isFinite(z) && z > 0 ? z : 1;
  if (zz < 1) {
    const need = Math.max(
      (cx + margin) / Math.max(1e-6, cx - r.x),
      (FIELD.w - cx + margin) / Math.max(1e-6, r.x + r.w - cx),
      (hy + margin) / Math.max(1e-6, hy - r.y),
      (FIELD.h - hy + margin) / Math.max(1e-6, r.y + r.h - hy),
    );
    zz = Math.min(1, Math.max(zz, need));
  }
  if (zz !== 1) {
    r.x = cx + (r.x - cx) * zz;
    r.y = hy + (r.y - hy) * zz;
    r.w *= zz;
    r.h *= zz;
  }
  return zz;
}

/**
 * @typedef {Object} StageDrawView   one object, reused by the world renderer every frame
 * @property {number} nowMs
 * @property {number} farX  @property {number} farY     parallax offset of the far layer, px
 * @property {number} nearX @property {number} nearY    parallax offset of the near layer, px
 * @property {boolean} reduceMotion                      crossfades become cuts
 * @property {number} [zoom]                             difficulty view zoom about the horizon point (1 = none)
 */

/**
 * @param {{assets?:object, createCanvas?:(w:number,h:number)=>any, config?:object}} [opts]
 */
export function createStage(opts = {}) {
  const assets = opts.assets && typeof opts.assets === 'object' ? opts.assets : null;
  const config = opts.config ?? ART_CONFIG;
  const S = config.stage ?? ART_CONFIG.stage;
  const B = ART_CONFIG.stage;
  const createCanvas = typeof opts.createCanvas === 'function' ? opts.createCanvas : null;
  const active = !!assets && assets.isNull !== true && typeof assets.load === 'function' && typeof assets.get === 'function';

  const crossfadeMs = Math.max(0, num(S.crossfadeMs, B.crossfadeMs));
  const ovFar = num(S.farOverscanPx, B.farOverscanPx);
  const ovNear = num(S.nearOverscanPx, B.nearOverscanPx);
  const horizonFrac = num(S.farHorizonFrac, B.farHorizonFrac);
  const farBase = num(S.farBaseScale, B.farBaseScale);
  // cover margin per layer: what parallax (aim up to half the field), recoil and shake can move it, plus 2 px (code review R-05)
  const G = config.gun ?? ART_CONFIG.gun;
  const FXC = config.fx ?? ART_CONFIG.fx;
  const moveFar = num(S.parallaxFar, B.parallaxFar) * FIELD.cx + num(S.recoilFar, B.recoilFar) * G.recoilPx + FXC.shakePx + 2;
  const moveNear = num(S.parallaxNear, B.parallaxNear) * FIELD.cx + num(S.recoilNear, B.recoilNear) * G.recoilPx + FXC.shakePx + 2;
  const zoomMargin = { far: Math.max(num(S.zoomMarginPx, B.zoomMarginPx), moveFar), near: Math.max(num(S.zoomMarginPx, B.zoomMarginPx), moveNear) };
  const waitArtMs = num(S.waitArtMs, B.waitArtMs);
  let nextWanted = null; // the stage prefetched for later (not released when it leaves the screen)
  let waitT0 = NaN; // a wanted stage whose art is still loading: the art on screen stays until it arrives (QA F4), at most waitArtMs
  let lastZoom = { far: 1, near: 1 };
  const maxResident = Math.max(1, Math.floor(num(S.maxResidentStages, B.maxResidentStages)));
  const layerAlpha = (id, layer) => clamp01(num(S.layerAlpha?.[id]?.[layer], 1));

  /** @typedef {{id:string, group:string, phase:string, far:any, near:any, token:number, lastUse:number, procFar:any, procNear:any}} Entry */
  /** @type {Map<string, Entry>} */
  const entries = new Map();
  const list = [];
  for (const id of STAGE_IDS) {
    const e = { id, group: stageGroup(id), phase: 'idle', far: null, near: null, token: 0, lastUse: 0, procFar: null, procNear: null, procFailed: false };
    entries.set(id, e);
    list.push(e);
  }
  // the visuals: {e, art} objects made once per (stage, kind) so a switch allocates nothing
  const visuals = new Map();
  for (const e of list) visuals.set(e.id, { art: { e, art: true }, proc: { e, art: false } });

  let mode = null;
  let cur = null; // visual fully (or fading) on screen
  let prev = null; // visual fading out
  let fadeT0 = NaN;
  let fadeAlpha = 1;
  let useClock = 0;
  let disposed = false;
  let reduce = false;
  let seenGeneration = active ? num(assets.generation, 0) : 0;
  let procPaints = 0;
  const R = { x: 0, y: 0, w: 0, h: 0 };
  const unsubs = [];

  const isStageId = (id) => typeof id === 'string' && entries.has(id);
  const artReady = (e) => e.phase === 'ready' && !!e.far;

  function safeGet(id) {
    try {
      return assets.get(id) || null;
    } catch {
      return null;
    }
  }

  // ---- procedural twins ---------------------------------------------------------------------------------------------------------
  function procCanvas(e, layer) {
    if (!createCanvas || e.procFailed) return null;
    const key = layer === 'far' ? 'procFar' : 'procNear';
    if (e[key]) return e[key];
    try {
      const r = layer === 'far' ? farRect(16 / 9, ovFar, horizonFrac, R, farBase) : nearRect(16 / 9, ovNear, R);
      const w = Math.ceil(r.w);
      const h = Math.ceil(r.h);
      const c = createCanvas(w, h);
      const cx = c && c.getContext ? c.getContext('2d') : null;
      if (!cx) throw new Error('no 2d context');
      if (layer === 'far') paintBackdropFar(cx, e.id, w, h, (WORLD.horizonY - r.y) / r.h);
      else paintBackdropNear(cx, e.id, w, h);
      e[key] = c;
      procPaints++;
      return c;
    } catch {
      e.procFailed = true;
      return null;
    }
  }

  function freeProc(e) {
    e.procFar = null;
    e.procNear = null;
  }

  // ---- residency and loading ----------------------------------------------------------------------------------------------------
  const onScreen = (e) => (cur && cur.e === e) || (prev && prev.e === e);

  function releaseEntry(e) {
    if (e.phase !== 'ready' && e.phase !== 'loading') return;
    e.far = null;
    e.near = null;
    e.phase = 'released';
    e.token++;
    try {
      if (typeof assets.release === 'function') assets.release(e.group);
    } catch {
      /* dropped on our side anyway */
    }
  }

  function committed(except) {
    let n = 0;
    for (const e of list) if (e !== except && (e.phase === 'loading' || e.phase === 'ready')) n++;
    return n;
  }

  function ensureCapacity(e) {
    while (committed(e) >= maxResident) {
      let victim = null;
      for (const x of list) {
        if (x === e || x.id === mode || x.id === nextWanted || onScreen(x) || (x.phase !== 'ready' && x.phase !== 'loading')) continue;
        if (!victim || x.lastUse < victim.lastUse) victim = x;
      }
      if (!victim) return false;
      releaseEntry(victim);
    }
    return true;
  }

  function startLoad(e) {
    if (!active || !ensureCapacity(e)) return;
    e.phase = 'loading';
    e.lastUse = ++useClock;
    const token = ++e.token;
    let p = null;
    try {
      p = assets.load(e.group);
    } catch {
      p = { state: 'failed' };
    }
    if (p && typeof p.then === 'function') {
      p.then(
        (r) => { if (e.token === token) settle(e, r ? r.state : 'failed'); },
        () => { if (e.token === token) settle(e, 'failed'); },
      );
    } else if (p && typeof p === 'object') {
      settle(e, p.state);
    }
  }

  function settle(e, state) {
    if (disposed || e.phase === 'ready' || e.phase === 'failed') return;
    if (state === 'ready' || state === 'partial') {
      e.far = safeGet(layerAssetId(e.id, 'far'));
      e.near = safeGet(layerAssetId(e.id, 'near'));
      e.phase = e.far || e.near ? 'ready' : 'failed';
    } else {
      e.phase = 'failed';
    }
    e.lastUse = ++useClock;
    seenGeneration = num(assets.generation, seenGeneration);
    if (e.id !== mode) return; // a prefetch: ready for later
    waitT0 = NaN;
    if (artReady(e)) {
      if (!(cur && cur.e === e && cur.art)) switchTo(visuals.get(e.id).art);
    } else if (!(cur && cur.e === e)) {
      switchTo(visuals.get(e.id).proc); // the art failed: the procedural twin of the wanted stage
    }
  }

  function onGroup(ev) {
    if (disposed || !ev || typeof ev.group !== 'string' || !ev.group.startsWith('stage:')) return;
    const e = entries.get(ev.group.slice(6));
    if (e && e.phase === 'loading') settle(e, ev.state);
  }

  function onRelease(ev) {
    if (disposed || !ev || typeof ev.group !== 'string' || !ev.group.startsWith('stage:')) return;
    const e = entries.get(ev.group.slice(6));
    if (!e || (e.phase !== 'ready' && e.phase !== 'loading')) return;
    dropArt(e);
  }

  /** The art of a stage vanished (released elsewhere, or a drawable broke): fall back to its procedural twin at once. */
  function dropArt(e) {
    e.far = null;
    e.near = null;
    e.phase = 'released';
    e.token++;
    const v = visuals.get(e.id);
    if (cur && cur.e === e && cur.art) cur = v.proc;
    if (prev && prev.e === e && prev.art) prev = null;
  }

  function refresh() {
    if (!active) return;
    const g = num(assets.generation, seenGeneration);
    if (g === seenGeneration) return;
    seenGeneration = g;
    for (const e of list) {
      if (e.phase !== 'ready') continue;
      const far = safeGet(layerAssetId(e.id, 'far'));
      const near = safeGet(layerAssetId(e.id, 'near'));
      if (far !== e.far || near !== e.near) {
        e.far = far;
        e.near = near;
        if (!far && !near) dropArt(e);
      }
    }
  }

  // ---- transitions -------------------------------------------------------------------------------------------------------------
  function switchTo(v) {
    if (cur === v) return;
    if (!cur || reduce || crossfadeMs <= 0) {
      const old = cur;
      cur = v;
      prev = null;
      fadeT0 = NaN;
      fadeAlpha = 1;
      if (old) retire(old);
      return;
    }
    const old = prev;
    prev = cur;
    cur = v;
    fadeT0 = NaN;
    fadeAlpha = 0;
    if (old && old !== prev && old !== cur) retire(old);
  }

  /** A visual left the screen: release its art when it is not wanted, free its procedural canvases when its art covers it. */
  function retire(v) {
    const e = v.e;
    if (onScreen(e)) return;
    if (e.id !== mode && e.id !== nextWanted && e.phase === 'ready') releaseEntry(e);
    if (e.id !== mode || artReady(e)) freeProc(e);
  }

  /**
   * The wanted stage could not start loading because every resident slot was on screen (a stage chosen during a crossfade): load it now
   * that a fade has ended and a slot is free. (Integrator fix, docs/contract-notes.md: without it a quick meadow -> hills -> alpine switch
   * left alpine procedural for the whole round.)
   */
  function loadWanted() {
    const e = mode ? entries.get(mode) : null;
    if (active && e && (e.phase === 'idle' || e.phase === 'released')) startLoad(e);
  }

  function advance(nowMs) {
    // the old art waited for the new stage's art; past waitArtMs the procedural twin of the wanted stage takes over
    if (!Number.isNaN(waitT0)) {
      const e = mode ? entries.get(mode) : null;
      if (!e || artReady(e) || (cur && cur.e === e)) waitT0 = NaN;
      else if (waitT0 < 0 || nowMs < waitT0) waitT0 = nowMs;
      else if (nowMs - waitT0 >= waitArtMs) {
        waitT0 = NaN;
        switchTo(visuals.get(e.id).proc);
      }
    }
    if (!prev) return;
    if (reduce) {
      const old = prev;
      prev = null;
      fadeAlpha = 1;
      retire(old);
      loadWanted();
      return;
    }
    if (Number.isNaN(fadeT0) || nowMs < fadeT0) fadeT0 = nowMs;
    fadeAlpha = clamp01((nowMs - fadeT0) / crossfadeMs);
    if (fadeAlpha >= 1) {
      const old = prev;
      prev = null;
      retire(old);
      loadWanted();
    }
  }

  // ---- drawing -----------------------------------------------------------------------------------------------------------------
  function drawLayer(ctx, v, layer, alpha, ox, oy, zoom = 1) {
    const e = v.e;
    const a = alpha * layerAlpha(e.id, layer);
    if (a <= 0.002) return false;
    let img = null;
    let aspect = 16 / 9;
    if (v.art) {
      img = layer === 'far' ? e.far : e.near;
      if (!img) return false;
      const iw = img.naturalWidth || img.width;
      const ih = img.naturalHeight || img.height;
      if (iw > 0 && ih > 0) aspect = iw / ih;
    } else {
      img = procCanvas(e, layer);
    }
    const r = layer === 'far' ? farRect(aspect, ovFar, horizonFrac, R, farBase) : nearRect(aspect, ovNear, R);
    lastZoom[layer] = zoomRect(r, zoom, zoomMargin[layer]);
    const prevA = ctx.globalAlpha;
    ctx.globalAlpha = prevA * a;
    try {
      if (img) {
        ctx.drawImage(img, r.x + ox, r.y + oy, r.w, r.h);
      } else {
        // no canvas factory: paint the procedural picture straight into the frame (tests, very old browsers)
        ctx.save();
        ctx.translate(r.x + ox, r.y + oy);
        if (layer === 'far') paintBackdropFar(ctx, e.id, r.w, r.h, (WORLD.horizonY - r.y) / r.h);
        else paintBackdropNear(ctx, e.id, r.w, r.h);
        ctx.restore();
      }
    } catch {
      if (v.art) dropArt(e);
      ctx.globalAlpha = prevA;
      return false;
    }
    ctx.globalAlpha = prevA;
    return true;
  }

  /**
   * Draw one pass. 'far' draws the outgoing visual opaque and the incoming one over it at the fade alpha; 'near' blends the two near
   * layers by the fade. Returns true when something was drawn.
   */
  function draw(ctx, pass, view) {
    if (disposed || !ctx || !cur) return false;
    refresh();
    const nowMs = num(view && view.nowMs, 0);
    reduce = !!(view && view.reduceMotion);
    if (pass === 'far') advance(nowMs);
    const isFar = pass === 'far';
    const ox = num(isFar ? view?.farX : view?.nearX, 0);
    const oy = num(isFar ? view?.farY : view?.nearY, 0);
    const layer = isFar ? 'far' : 'near';
    const zoom = num(view && view.zoom, 1);
    let drew = false;
    // far: the outgoing picture stays opaque under the incoming one; near (transparent): the outgoing grass fades out late, so the
    // coverage never dips far (code review R-08)
    if (prev) drew = drawLayer(ctx, prev, layer, isFar ? 1 : 1 - fadeAlpha * fadeAlpha, ox, oy, zoom) || drew;
    drew = drawLayer(ctx, cur, layer, prev ? fadeAlpha : 1, ox, oy, zoom) || drew;
    // a far art layer that is missing (partial group): the procedural far shows under the near art
    if (isFar && cur.art && !cur.e.far) drew = drawLayer(ctx, visuals.get(cur.e.id).proc, 'far', 1, ox, oy, zoom) || drew;
    return drew;
  }

  // ---- public API --------------------------------------------------------------------------------------------------------------
  function setStage(id) {
    if (disposed || !isStageId(id)) return;
    const e = entries.get(id);
    e.lastUse = ++useClock;
    if (id === nextWanted) nextWanted = null; // arrived
    if (id !== mode) {
      mode = id;
      if (active && (e.phase === 'idle' || e.phase === 'released')) startLoad(e);
    }
    const v = visuals.get(id);
    if (artReady(e)) switchTo(v.art);
    else if (cur && cur.art && cur.e !== e && active && e.phase !== 'failed') {
      // QA F4: never flash the flat procedural backdrop between two painted stages: keep the art on screen until the new art is decoded
      // (settle() then crossfades), or until waitArtMs has passed
      if (Number.isNaN(waitT0)) waitT0 = -1;
    } else switchTo(v.proc);
  }

  /** Load a stage's art ahead of time (the next stage of a Classic round), if a resident slot is free. Does not change what is shown. */
  function prefetch(id) {
    if (id === null) nextWanted = null; // nothing is wanted next (a round without a next stage)
    if (disposed || !active || !isStageId(id) || id === mode) return;
    const e = entries.get(id);
    nextWanted = id;
    if (e.phase !== 'idle' && e.phase !== 'released') return;
    if (!ensureCapacity(e)) return;
    startLoad(e);
  }

  function status() {
    const resident = [];
    const loading = [];
    const failed = [];
    for (const e of list) {
      if (e.phase === 'ready') resident.push(e.id);
      else if (e.phase === 'loading') loading.push(e.id);
      else if (e.phase === 'failed') failed.push(e.id);
    }
    return {
      active,
      stage: mode,
      shown: cur ? cur.e.id : null,
      art: !!(cur && cur.art),
      fading: !!prev,
      fadeAlpha: prev ? fadeAlpha : 1,
      layers: { far: !!(cur && cur.art && cur.e.far), near: !!(cur && cur.art && cur.e.near) },
      resident,
      loading,
      failed,
      procPaints,
      zoom: { far: lastZoom.far, near: lastZoom.near },
    };
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    for (const off of unsubs) {
      try {
        off();
      } catch {
        /* ignore */
      }
    }
    unsubs.length = 0;
    for (const e of list) {
      if (e.phase === 'ready' || e.phase === 'loading') releaseEntry(e);
      freeProc(e);
    }
    cur = null;
    prev = null;
  }

  if (active && typeof assets.on === 'function') {
    try {
      const a = assets.on('group', onGroup);
      const b = assets.on('release', onRelease);
      if (typeof a === 'function') unsubs.push(a);
      if (typeof b === 'function') unsubs.push(b);
    } catch {
      /* the load promises still settle the stages */
    }
  }

  return { setStage, prefetch, draw, status, dispose, get stage() { return mode; } };
}
