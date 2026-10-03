// Image asset loader (docs/assets-integration.md 2). OWNER: Asset engineer (body written by the Integrator, see docs/contract-notes.md).
//
// `NULL_ASSETS` is what the game uses when the art is off or absent. `createAssets` is the real loader: it reads the manifest once, loads
// the images of a group with a small number of parallel loads, keeps the decoded images and a bounded cache of scaled canvases, and never
// throws or rejects. Every drawing code path asks `assets.has(id)` (or checks for a null return) first, so a missing, failed, late or
// released image simply means the procedural drawing.
//
// Everything browser-specific (fetch, Image, canvas, timers) is injected, so the loader runs in Node with stubs. Nothing here touches
// `window`, `document`, `Image` or `fetch` at import time (architecture rule 6): the defaults are read inside the factory.

import { ART_CONFIG } from './art-config.js';
import { Emitter } from '../shared/emitter.js';

const noop = () => {};
const noopOff = () => noop;
const disabledResult = (group) => Object.freeze({ group, state: 'disabled', loaded: 0, failed: 0, total: 0 });

/**
 * The "no art" implementation. Frozen, shared, safe to use as a default: has() is false, get() and meta() are null, load() resolves at
 * once, generation never changes. Every drawing code path checks `assets.has(id)` (or a null return) and falls back to the procedural art.
 */
export const NULL_ASSETS = Object.freeze({
  isNull: true,
  config: ART_CONFIG,
  generation: 0,
  load: (group) => Promise.resolve(disabledResult(group)),
  prefetch: noop,
  release: noop,
  get: () => null,
  has: () => false,
  meta: () => null,
  ids: () => [],
  scaled: () => null,
  sliced: () => null,
  status: () => Object.freeze({ manifest: 'idle', groups: Object.freeze({}), generation: 0 }),
  on: noopOff,
  dispose: noop,
});

const MANIFEST_FILE = 'manifest.json';
const BYTES_PER_PIXEL = 4;
const EPS = 1e-6;

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const ceilPx = (v) => Math.max(1, Math.ceil(v - EPS));

function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}

/**
 * Draw a source rectangle into a destination rectangle. A reduction of more than 2x in one axis is done in halving steps (a one-shot
 * drawImage from 512 down to 100 px aliases). Used at bake time only, never per frame.
 */
function blit(createCanvas, ctx, src, sx, sy, sw, sh, dx, dy, dw, dh) {
  let cur = src;
  let cx = sx;
  let cy = sy;
  let cw = sw;
  let ch = sh;
  let guard = 0;
  while ((cw > 2 * dw + EPS || ch > 2 * dh + EPS) && guard++ < 12) {
    const nw = cw > 2 * dw + EPS ? Math.max(1, Math.ceil(cw / 2)) : Math.ceil(cw);
    const nh = ch > 2 * dh + EPS ? Math.max(1, Math.ceil(ch / 2)) : Math.ceil(ch);
    const tmp = createCanvas(nw, nh);
    const tctx = tmp && tmp.getContext ? tmp.getContext('2d') : null;
    if (!tctx) break;
    tctx.imageSmoothingEnabled = true;
    tctx.imageSmoothingQuality = 'high';
    tctx.drawImage(cur, cx, cy, cw, ch, 0, 0, nw, nh);
    cur = tmp;
    cx = 0;
    cy = 0;
    cw = nw;
    ch = nh;
  }
  ctx.drawImage(cur, cx, cy, cw, ch, dx, dy, dw, dh);
}

/**
 * @param {object} [opts] see docs/assets-integration.md 2.1
 * @param {string} [opts.baseUrl]        joined with entry.file
 * @param {Function} [opts.fetch]        (url) => Promise<{ok, status, json()}>; the manifest only
 * @param {Function} [opts.createImage]  () => image-like {src, onload, onerror, decode?, width, height, naturalWidth?, naturalHeight?}
 * @param {Function} [opts.createCanvas] (w, h) => canvas; without it scaled() and sliced() return null
 * @param {Function|null} [opts.createBitmap] (blob) => Promise<ImageBitmap>; default: the global createImageBitmap when there is one. With it the
 *   loader fetches every file and decodes it into a bitmap it can close() when a group is released (a decoded <img> element keeps its
 *   pixels in the browser's caches after the last reference is gone: measured about 5 MB per stage switch for good). `null` forces the
 *   <img> route (`createImage`), which is also the route when there is no createImageBitmap and the one the tests use.
 * @param {Function} [opts.setTimeout]
 * @param {Function} [opts.clearTimeout]
 * @param {Function} [opts.now]
 * @param {object} [opts.config]
 * @param {object} [opts.manifest]       an already parsed manifest: skips the fetch (tests)
 * @param {object} [opts.console]        where the one-line group warnings go
 * @returns {typeof NULL_ASSETS} an Assets object
 */
export function createAssets(opts = {}) {
  const config = opts.config ?? ART_CONFIG;
  const LC = { ...ART_CONFIG.loader, ...(config.loader ?? {}) };
  let baseUrl = typeof opts.baseUrl === 'string' ? opts.baseUrl : (config.baseUrl ?? ART_CONFIG.baseUrl);
  if (baseUrl !== '' && !baseUrl.endsWith('/')) baseUrl += '/';

  const fetchFn = typeof opts.fetch === 'function'
    ? opts.fetch
    : (typeof globalThis.fetch === 'function' ? (url, init) => globalThis.fetch(url, init) : null);
  const createImage = typeof opts.createImage === 'function'
    ? opts.createImage
    : (typeof globalThis.Image === 'function' ? () => new globalThis.Image() : null);
  const createCanvas = typeof opts.createCanvas === 'function' ? opts.createCanvas : null;
  const createBitmap = opts.createBitmap === null
    ? null
    : typeof opts.createBitmap === 'function'
      ? opts.createBitmap
      : (typeof globalThis.createImageBitmap === 'function' ? (src) => globalThis.createImageBitmap(src) : null);
  const setT = typeof opts.setTimeout === 'function' ? opts.setTimeout : (fn, ms) => globalThis.setTimeout(fn, ms);
  const clearT = typeof opts.clearTimeout === 'function' ? opts.clearTimeout : (id) => globalThis.clearTimeout(id);
  const cons = opts.console ?? (typeof console !== 'undefined' ? console : null);
  const concurrency = Math.max(1, Math.floor(isNum(LC.concurrency) ? LC.concurrency : 4));
  const cacheMaxEntries = isNum(LC.scaledCacheMaxEntries) ? LC.scaledCacheMaxEntries : 160;
  const cacheMaxBytes = isNum(LC.scaledCacheMaxBytes) ? LC.scaledCacheMaxBytes : 64 * 1024 * 1024;

  const emitter = new Emitter();
  const emit = (type, payload) => emitter.emit(type, payload);

  /** @type {'idle'|'loading'|'ready'|'failed'} */
  let manifestState = 'idle';
  let manifestPromise = null;
  const metaById = new Map(); // id -> frozen manifest entry
  const groupOrder = []; // group names in manifest order
  const groupIds = new Map(); // group -> frozen ordered ids
  const groups = new Map(); // group -> runtime record
  const images = new Map(); // id -> decoded drawable
  let allIds = Object.freeze([]);
  let generation = 0;
  let disposed = false;
  const usable = !!(fetchFn && (createImage || createBitmap));

  const warn = (message) => {
    try {
      if (cons && typeof cons.warn === 'function') cons.warn(`[clay-rush] ${message}`);
    } catch {
      /* a broken console must not break the loader */
    }
  };

  // ------------------------------------------------------------------------------------------------------------ manifest
  function adopt(data) {
    if (!data || typeof data !== 'object' || data.version !== 1 || !Array.isArray(data.assets)) return false;
    const ids = [];
    for (const raw of data.assets) {
      if (!raw || typeof raw.id !== 'string' || typeof raw.file !== 'string' || !isNum(raw.width) || !isNum(raw.height) || !raw.contentBox) continue;
      if (metaById.has(raw.id)) continue;
      metaById.set(raw.id, deepFreeze(JSON.parse(JSON.stringify(raw))));
      ids.push(raw.id);
    }
    allIds = Object.freeze(ids);
    const listed = data.groups && typeof data.groups === 'object' ? data.groups : null;
    if (listed) {
      for (const [name, list] of Object.entries(listed)) {
        if (!Array.isArray(list)) continue;
        groupOrder.push(name);
        groupIds.set(name, Object.freeze(list.filter((id) => typeof id === 'string' && metaById.has(id))));
      }
    } else {
      const by = new Map();
      for (const id of ids) {
        const g = metaById.get(id).group ?? 'core';
        if (!by.has(g)) by.set(g, []);
        by.get(g).push(id);
      }
      for (const [name, list] of by) {
        groupOrder.push(name);
        groupIds.set(name, Object.freeze(list));
      }
    }
    return true;
  }

  function ensureManifest() {
    if (manifestPromise) return manifestPromise;
    if (opts.manifest !== undefined) {
      manifestState = adopt(opts.manifest) ? 'ready' : 'failed';
      emit('manifest', { ok: manifestState === 'ready' });
      manifestPromise = Promise.resolve(manifestState === 'ready');
      return manifestPromise;
    }
    if (!usable) {
      manifestState = 'failed';
      manifestPromise = Promise.resolve(false);
      return manifestPromise;
    }
    manifestState = 'loading';
    manifestPromise = new Promise((resolve) => {
      let done = false;
      let timer = null;
      const finish = (data) => {
        if (done) return;
        done = true;
        if (timer !== null) clearT(timer);
        const ok = !disposed && adopt(data);
        manifestState = ok ? 'ready' : 'failed';
        if (!ok && !disposed) warn('the asset manifest could not be loaded: the game keeps its painted art');
        if (!disposed) emit('manifest', { ok });
        resolve(ok);
      };
      timer = setT(() => finish(null), isNum(LC.manifestTimeoutMs) ? LC.manifestTimeoutMs : 4000);
      try {
        Promise.resolve(fetchFn(baseUrl + MANIFEST_FILE))
          .then((res) => {
            if (!res || !res.ok) throw new Error('bad status');
            return res.json();
          })
          .then((data) => finish(data), () => finish(null));
      } catch {
        finish(null);
      }
    });
    return manifestPromise;
  }

  // ---------------------------------------------------------------------------------------------------------------- queue
  /** @type {Array<object>} */
  const queueNormal = [];
  const queueLow = [];
  const inflight = new Set();
  let running = 0;

  function pump() {
    while (!disposed && running < concurrency) {
      const job = queueNormal.length > 0 ? queueNormal.shift() : queueLow.shift();
      if (!job) return;
      if (job.gr.token !== job.token) continue; // its group was released meanwhile
      startJob(job);
    }
  }

  const closeBitmap = (d) => {
    try {
      if (d && typeof d.close === 'function') d.close();
    } catch {
      /* already closed */
    }
  };

  const timeoutFor = (entry) => {
    const ms = entry.kind === 'layer' ? LC.layerTimeoutMs : LC.imageTimeoutMs;
    return isNum(ms) ? ms : 15000;
  };

  /**
   * Route 1 (the browser): fetch the file, decode it into an ImageBitmap. No <img> element is involved, so nothing stays in the browser's
   * image caches after `release()`: the loader closes the bitmap and the pixels are gone (measured in headless Chrome: with <img> elements
   * 24 stage switches kept about 130 MB, with fetch + ImageBitmap the same cycle stays flat).
   */
  function startBitmapJob(job) {
    const { gr, entry } = job;
    running++;
    let timer = null;
    let settled = false;
    let ctl = null;
    try {
      ctl = typeof AbortController === 'function' ? new AbortController() : null;
    } catch {
      ctl = null;
    }
    const finish = (ok, bmp, abortLoad) => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearT(timer);
      inflight.delete(job);
      if (abortLoad && ctl) {
        try {
          ctl.abort();
        } catch {
          /* ignore */
        }
      }
      running--;
      if (!disposed && job.gr.token === job.token) recordResult(gr, entry, ok, bmp);
      else closeBitmap(bmp); // the group was released or the loader disposed while this bitmap was being made
      pump();
    };
    job.abort = () => finish(false, null, true);
    inflight.add(job);
    timer = setT(() => finish(false, null, true), timeoutFor(entry));
    try {
      Promise.resolve(fetchFn(baseUrl + entry.file, ctl ? { signal: ctl.signal } : undefined))
        .then((res) => {
          if (!res || !res.ok || typeof res.blob !== 'function') throw new Error('bad status');
          return res.blob();
        })
        .then((blob) => createBitmap(blob))
        .then((bmp) => {
          if (settled) closeBitmap(bmp); // timed out, released or disposed while the bitmap was being made
          else if (bmp && bmp.width === entry.width && bmp.height === entry.height) finish(true, bmp, false);
          else {
            closeBitmap(bmp);
            finish(false, null, false);
          }
        }, () => finish(false, null, false));
    } catch {
      finish(false, null, true);
    }
  }

  /** Route 2 (no createImageBitmap, and the tests): an <img> element, decoded through decode() when it has one. */
  function startImageJob(job) {
    const { gr, entry } = job;
    running++;
    let img = null;
    let timer = null;
    let settled = false;
    const finish = (ok, drawable, abortLoad) => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearT(timer);
      inflight.delete(job);
      if (img) {
        img.onload = null;
        img.onerror = null;
        if (abortLoad) {
          try {
            img.src = '';
          } catch {
            /* ignore */
          }
        }
      }
      running--;
      if (!disposed && job.gr.token === job.token) recordResult(gr, entry, ok, drawable);
      pump();
    };
    job.abort = () => finish(false, null, true);
    inflight.add(job);
    try {
      img = createImage();
      try {
        img.decoding = 'async';
      } catch {
        /* a stub without the property */
      }
      img.onerror = () => finish(false, null, false);
      img.onload = () => {
        const w = img.naturalWidth || img.width;
        const h = img.naturalHeight || img.height;
        if (w !== entry.width || h !== entry.height) {
          finish(false, null, false);
          return;
        }
        if (typeof img.decode === 'function') {
          Promise.resolve().then(() => img.decode()).then(() => finish(true, img, false), () => finish(false, null, false));
        } else finish(true, img, false);
      };
      timer = setT(() => finish(false, null, true), timeoutFor(entry));
      img.src = baseUrl + entry.file;
    } catch {
      finish(false, null, true);
    }
  }

  function startJob(job) {
    if (createBitmap && fetchFn) startBitmapJob(job);
    else startImageJob(job);
  }

  function recordResult(gr, entry, ok, drawable) {
    if (ok) {
      images.set(entry.id, drawable);
      gr.loaded++;
      generation++;
    } else gr.failed++;
    emit('asset', { id: entry.id, ok });
    emit('progress', { group: gr.name, loaded: gr.loaded, failed: gr.failed, total: gr.total });
    if (gr.loaded + gr.failed >= gr.total) settleGroup(gr);
  }

  function settleGroup(gr) {
    gr.state = gr.loaded === 0 ? 'failed' : gr.failed > 0 ? 'partial' : 'ready';
    if (gr.state !== 'ready') warn(`asset group "${gr.name}" is ${gr.state} (${gr.loaded} of ${gr.total} images loaded): the missing art is drawn procedurally`);
    gr.result = Object.freeze({ group: gr.name, state: gr.state, loaded: gr.loaded, failed: gr.failed, total: gr.total });
    const resolve = gr.resolve;
    gr.resolve = null;
    if (resolve) resolve(gr.result);
    emit('group', gr.result);
  }

  function groupRecord(name) {
    let gr = groups.get(name);
    if (!gr) {
      const ids = groupIds.get(name) ?? Object.freeze([]);
      gr = { name, ids, total: ids.length, state: 'idle', loaded: 0, failed: 0, token: 0, low: false, promise: null, resolve: null, result: null };
      groups.set(name, gr);
    }
    return gr;
  }

  function promote(gr) {
    // a low-priority group that somebody now needs: its queued jobs move to the front line (walking from the end keeps their order)
    if (!gr.low) return;
    gr.low = false;
    for (let i = queueLow.length - 1; i >= 0; i--) {
      if (queueLow[i].gr === gr) queueNormal.unshift(...queueLow.splice(i, 1));
    }
    pump();
  }

  function startGroup(gr, low) {
    gr.state = 'loading';
    gr.loaded = 0;
    gr.failed = 0;
    gr.low = low;
    gr.result = null;
    gr.token++;
    gr.promise = new Promise((resolve) => { gr.resolve = resolve; });
    if (gr.total === 0) {
      settleGroup(gr);
      return;
    }
    const q = low ? queueLow : queueNormal;
    gr.ids.forEach((id, order) => q.push({ gr, entry: metaById.get(id), token: gr.token, order, abort: null }));
    pump();
  }

  // ------------------------------------------------------------------------------------------------------------ public API
  function load(group, o) {
    if (disposed) return Promise.resolve(disabledResult(group));
    const low = !!(o && o.priority === 'low');
    const run = () => {
      if (disposed) return Promise.resolve(disabledResult(group));
      if (manifestState !== 'ready') return Promise.resolve(Object.freeze({ group, state: 'failed', loaded: 0, failed: 0, total: 0 }));
      if (!groupIds.has(group)) return Promise.resolve(Object.freeze({ group, state: 'failed', loaded: 0, failed: 0, total: 0 }));
      const gr = groupRecord(group);
      if (gr.state === 'idle' || gr.state === 'released') startGroup(gr, low);
      else if (gr.state === 'loading' && !low) promote(gr);
      return gr.state === 'loading' ? gr.promise : Promise.resolve(gr.result);
    };
    if (!usable && opts.manifest === undefined) return Promise.resolve(disabledResult(group));
    if (manifestState === 'ready' || manifestState === 'failed') return run();
    return ensureManifest().then(run, () => Promise.resolve(Object.freeze({ group, state: 'failed', loaded: 0, failed: 0, total: 0 })));
  }

  function release(group) {
    const gr = groups.get(group);
    if (!gr || gr.state === 'idle' || gr.state === 'released') return;
    const wasLoading = gr.state === 'loading';
    gr.token++;
    for (const q of [queueNormal, queueLow]) {
      for (let i = q.length - 1; i >= 0; i--) if (q[i].gr === gr) q.splice(i, 1);
    }
    for (const job of [...inflight]) if (job.gr === gr && job.abort) job.abort();
    for (const id of gr.ids) {
      closeBitmap(images.get(id)); // an ImageBitmap frees its pixels now; an <img> element has no close() and is left to the garbage collector
      images.delete(id);
    }
    purgeCache(new Set(gr.ids));
    gr.state = 'released';
    gr.loaded = 0;
    gr.failed = 0;
    gr.result = null;
    if (wasLoading && gr.resolve) {
      const resolve = gr.resolve;
      gr.resolve = null;
      resolve(Object.freeze({ group, state: 'released', loaded: 0, failed: 0, total: gr.total }));
    }
    generation++;
    emit('release', { group });
    pump();
  }

  // ------------------------------------------------------------------------------------------------- scaled-sprite cache
  /** @type {Map<string, {value:object, bytes:number, id:string}>} */
  const cache = new Map();
  let cacheBytes = 0;

  function cacheGet(key) {
    const hit = cache.get(key);
    if (!hit) return null;
    cache.delete(key); // most recently used goes last
    cache.set(key, hit);
    return hit.value;
  }
  function cachePut(key, value, bytes, id) {
    cache.set(key, { value, bytes, id });
    cacheBytes += bytes;
    while ((cache.size > cacheMaxEntries || cacheBytes > cacheMaxBytes) && cache.size > 1) {
      const oldest = cache.keys().next().value;
      const e = cache.get(oldest);
      cache.delete(oldest);
      cacheBytes -= e.bytes;
    }
  }
  function purgeCache(idSet) {
    for (const [key, e] of [...cache]) {
      if (idSet.has(e.id)) {
        cache.delete(key);
        cacheBytes -= e.bytes;
      }
    }
  }

  function makeCanvas(w, h) {
    const canvas = createCanvas(w, h);
    const ctx = canvas && typeof canvas.getContext === 'function' ? canvas.getContext('2d') : null;
    if (!ctx) return null;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    return { canvas, ctx };
  }

  function scaled(id, boxW, boxH, density = 1, o) {
    if (!createCanvas || disposed) return null;
    const img = images.get(id);
    const meta = metaById.get(id);
    if (!img || !meta || !(boxW > 0) || !(boxH > 0) || !(density > 0)) return null;
    const fit = o && o.fit === 'stretch' ? 'stretch' : 'contain';
    const key = `${id}|${boxW}x${boxH}|${density}|${fit}`;
    const hit = cacheGet(key);
    if (hit) return hit;
    try {
      const cb = meta.contentBox;
      let w = boxW;
      let h = boxH;
      if (fit === 'contain') {
        const s = Math.min(boxW / cb.w, boxH / cb.h);
        w = cb.w * s;
        h = cb.h * s;
      }
      const pw = ceilPx(w * density);
      const ph = ceilPx(h * density);
      const made = makeCanvas(pw, ph);
      if (!made) return null;
      blit(createCanvas, made.ctx, img, cb.x, cb.y, cb.w, cb.h, 0, 0, pw, ph);
      const value = Object.freeze({ canvas: made.canvas, w, h, density });
      cachePut(key, value, pw * ph * BYTES_PER_PIXEL, id);
      return value;
    } catch {
      return null;
    }
  }

  function sliced(id, w, h, density = 1) {
    if (!createCanvas || disposed) return null;
    const img = images.get(id);
    const meta = metaById.get(id);
    if (!img || !meta || !meta.slice || !(w > 0) || !(h > 0) || !(density > 0)) return null;
    const key = `${id}|${w}x${h}|${density}|slice`;
    const hit = cacheGet(key);
    if (hit) return hit;
    try {
      const cb = meta.contentBox;
      const ref = metaById.get(meta.ref ?? id) ?? meta;
      const rb = ref.contentBox;
      const sl = meta.slice;
      const horizontalOnly = !(sl.t > 0) && !(sl.b > 0);
      const s = horizontalOnly ? h / rb.h : (isNum(sl.scale) ? sl.scale : 0.5);
      const outW = w + (cb.w - rb.w) * s;
      const outH = horizontalOnly ? cb.h * s : h + (cb.h - rb.h) * s;
      const pw = ceilPx(outW * density);
      const ph = ceilPx(outH * density);
      const made = makeCanvas(pw, ph);
      if (!made) return null;
      const { ctx } = made;
      // cap sizes in device pixels, shrunk together when the frame is smaller than the two caps
      let capL = Math.round(sl.l * s * density);
      let capR = Math.round(sl.r * s * density);
      if (capL + capR > pw) {
        const k = pw / (capL + capR);
        capL = Math.floor(capL * k);
        capR = pw - capL;
        if (capL + capR > pw) capR = pw - capL;
      }
      const midW = pw - capL - capR;
      const midSW = cb.w - sl.l - sl.r;
      if (horizontalOnly) {
        if (capL > 0) blit(createCanvas, ctx, img, cb.x, cb.y, sl.l, cb.h, 0, 0, capL, ph);
        if (midW > 0 && midSW > 0) blit(createCanvas, ctx, img, cb.x + sl.l, cb.y, midSW, cb.h, capL, 0, midW, ph);
        if (capR > 0) blit(createCanvas, ctx, img, cb.x + cb.w - sl.r, cb.y, sl.r, cb.h, capL + midW, 0, capR, ph);
      } else {
        let capT = Math.round(sl.t * s * density);
        let capB = Math.round(sl.b * s * density);
        if (capT + capB > ph) {
          const k = ph / (capT + capB);
          capT = Math.floor(capT * k);
          capB = ph - capT;
        }
        const midH = ph - capT - capB;
        const midSH = cb.h - sl.t - sl.b;
        const xs = [[cb.x, sl.l, 0, capL], [cb.x + sl.l, midSW, capL, midW], [cb.x + cb.w - sl.r, sl.r, capL + midW, capR]];
        const ys = [[cb.y, sl.t, 0, capT], [cb.y + sl.t, midSH, capT, midH], [cb.y + cb.h - sl.b, sl.b, capT + midH, capB]];
        for (const [sy, sh, dy, dh] of ys) {
          if (!(dh > 0) || !(sh > 0)) continue;
          for (const [sx, sw, dx, dw] of xs) {
            if (!(dw > 0) || !(sw > 0)) continue;
            blit(createCanvas, ctx, img, sx, sy, sw, sh, dx, dy, dw, dh);
          }
        }
      }
      const value = Object.freeze({ canvas: made.canvas, w: outW, h: outH, density });
      cachePut(key, value, pw * ph * BYTES_PER_PIXEL, id);
      return value;
    } catch {
      return null;
    }
  }

  function status() {
    const out = {};
    for (const name of groupOrder) {
      const gr = groups.get(name);
      out[name] = gr
        ? { state: gr.state, loaded: gr.loaded, failed: gr.failed, total: gr.total }
        : { state: 'idle', loaded: 0, failed: 0, total: (groupIds.get(name) ?? []).length };
    }
    return { manifest: manifestState, groups: out, generation };
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    for (const job of [...inflight]) if (job.abort) job.abort();
    queueNormal.length = 0;
    queueLow.length = 0;
    for (const d of images.values()) closeBitmap(d);
    images.clear();
    cache.clear();
    cacheBytes = 0;
    for (const gr of groups.values()) {
      gr.token++;
      if (gr.resolve) {
        const resolve = gr.resolve;
        gr.resolve = null;
        resolve(Object.freeze({ group: gr.name, state: 'released', loaded: 0, failed: 0, total: gr.total }));
      }
    }
    emitter.removeAll();
  }

  // an already parsed manifest (tests): usable at once, before any load()
  if (opts.manifest !== undefined) ensureManifest();

  return {
    isNull: false,
    config,
    get generation() {
      return generation;
    },
    load,
    prefetch(group) {
      load(group, { priority: 'low' });
    },
    release,
    get: (id) => images.get(id) ?? null,
    has: (id) => images.has(id),
    meta: (id) => metaById.get(id) ?? null,
    ids: (group) => (group === undefined ? allIds : (groupIds.get(group) ?? Object.freeze([]))),
    scaled,
    sliced,
    status,
    on: (type, fn) => emitter.on(type, fn),
    dispose,
    /** @internal counters for tests and the debug panel */
    get _stats() {
      return { cacheEntries: cache.size, cacheBytes, running, queued: queueNormal.length + queueLow.length };
    },
  };
}
