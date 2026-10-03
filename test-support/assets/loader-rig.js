// A rig for the real loader (public/js/render/assets.js) in Node: a small synthetic manifest, fake <img> elements that the test completes by
// hand, fake timers, a fake fetch (manifest and, for the bitmap route, blobs) and a fake canvas factory. OWNER: integrator.
//
// Nothing here loads a real image or touches the network: every "image" is an object {src, onload, onerror, decode, width, height} whose
// outcome the test decides (`rig.images.finish(id)`, `.fail(id)`, `.finishAll()`), so every ordering of "loaded", "failed", "timed out" and
// "released" is testable.
import { FakeCanvas } from '../render/fake-canvas.js';

const box = (x, y, w, h) => ({ x, y, w, h });

/** A manifest in the shape of docs/assets-integration.md 1.4 with two groups of the game's kind (core, stage:x) and one of another. */
export function makeManifest() {
  const core = [
    { id: 'logo', file: 'ui/logo.png', kind: 'logo', group: 'core', width: 400, height: 200, bytes: 1, contentBox: box(2, 4, 396, 190), anchor: { x: 200, y: 99 } },
    { id: 'btn_default', file: 'ui/btn_default.png', kind: 'ui', group: 'core', width: 840, height: 262, bytes: 1, contentBox: box(3, 3, 834, 256), anchor: { x: 420, y: 131 }, slice: { l: 190, r: 190, t: 0, b: 0 } },
    { id: 'btn_focused', file: 'ui/btn_focused.png', kind: 'ui', group: 'core', width: 840, height: 281, bytes: 1, contentBox: box(3, 3, 834, 275), anchor: { x: 420, y: 140 }, slice: { l: 190, r: 190, t: 0, b: 0 }, ref: 'btn_default' },
    { id: 'panel', file: 'ui/panel.png', kind: 'ui', group: 'core', width: 512, height: 512, bytes: 1, contentBox: box(1, 1, 510, 510), anchor: { x: 256, y: 256 }, slice: { l: 48, r: 48, t: 48, b: 48, scale: 0.5 } },
    { id: 'fruit', file: 'sprites/fruit.png', kind: 'fruit', group: 'core', width: 512, height: 512, bytes: 1, contentBox: box(73, 63, 365, 385), anchor: { x: 256, y: 256 }, body: { cx: 256, cy: 256, r: 187 } },
  ];
  const stage = ['far', 'mid', 'near'].map((layer, i) => ({
    id: `bg_x_${layer}`, file: `backgrounds/bg_x_${layer}.${i === 0 ? 'jpg' : 'png'}`, kind: 'layer', group: 'stage:x',
    width: i === 0 ? 2560 : 2048, height: i === 0 ? 1440 : 1152, bytes: 1, contentBox: box(0, 0, i === 0 ? 2560 : 2048, i === 0 ? 1440 : 1152), anchor: { x: 1024, y: 576 },
  }));
  const other = [{ id: 'other_1', file: 'ui/other_1.png', kind: 'icon', group: 'stage:y', width: 256, height: 256, bytes: 1, contentBox: box(0, 0, 256, 256), anchor: { x: 128, y: 128 } }];
  const assets = [...core, ...stage, ...other];
  return {
    version: 1, generator: 'test',
    groups: { core: core.map((a) => a.id), 'stage:x': stage.map((a) => a.id), 'stage:y': other.map((a) => a.id) },
    stages: {}, assets,
  };
}

export function createFakeTimers() {
  let now = 0;
  let nextId = 1;
  const timers = new Map();
  return {
    setTimeout(fn, ms) {
      const id = nextId++;
      timers.set(id, { fn, at: now + ms });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    now: () => now,
    pending: () => timers.size,
    /** Advance time; fires due timers in order (also timers created by the fired ones). */
    advance(ms) {
      const end = now + ms;
      for (;;) {
        let best = null;
        for (const [id, t] of timers) if (t.at <= end && (best === null || t.at < timers.get(best).at)) best = id;
        if (best === null) break;
        const t = timers.get(best);
        timers.delete(best);
        now = Math.max(now, t.at);
        t.fn();
      }
      now = end;
    },
  };
}

/**
 * Fake images. `createImage` returns objects that stay pending until the test settles them by asset id (the id is found from the file name
 * through the manifest). `naturalSize` overrides the decoded size of one id (a size mismatch); `decode` can fail per id.
 */
export function createFakeImages(manifest) {
  const byFile = new Map(manifest.assets.map((a) => [a.file, a]));
  const pending = []; // {id, img, entry}
  const requested = [];
  const log = { created: 0, srcCleared: 0 };
  let inFlightPeak = 0;
  const api = {
    requested,
    pending,
    log,
    get peak() { return inFlightPeak; },
    createImage() {
      log.created++;
      const img = {
        _src: '', onload: null, onerror: null, width: 0, height: 0, decoding: '',
        decodeFails: false,
        get src() { return this._src; },
        set src(v) {
          this._src = v;
          if (v === '') { log.srcCleared++; return; }
          const file = String(v).replace(/^.*?assets\//, '');
          const entry = byFile.get(file);
          const rec = { id: entry ? entry.id : null, img, entry, url: v };
          requested.push(rec.id);
          pending.push(rec);
          inFlightPeak = Math.max(inFlightPeak, pending.length);
        },
        decode() {
          return this.decodeFails ? Promise.reject(new Error('EncodingError')) : Promise.resolve();
        },
      };
      return img;
    },
    /** Complete the pending load of `id` (default: the oldest). `size` overrides the decoded size, `decodeFails` makes decode() reject. */
    finish(id, { size, decodeFails } = {}) {
      const i = id === undefined ? 0 : pending.findIndex((p) => p.id === id);
      if (i < 0) throw new Error(`no pending image ${id}`);
      const [rec] = pending.splice(i, 1);
      rec.img.width = size ? size[0] : rec.entry.width;
      rec.img.height = size ? size[1] : rec.entry.height;
      rec.img.decodeFails = !!decodeFails;
      rec.img.onload?.();
      return rec;
    },
    fail(id) {
      const i = id === undefined ? 0 : pending.findIndex((p) => p.id === id);
      if (i < 0) throw new Error(`no pending image ${id}`);
      const [rec] = pending.splice(i, 1);
      rec.img.onerror?.();
      return rec;
    },
    pendingIds: () => pending.map((p) => p.id),
  };
  return api;
}

/** A fake fetch for the manifest (and, with `blobs`, for the images of the bitmap route). */
export function createFakeFetch(manifest, o = {}) {
  const calls = [];
  const byFile = new Map(manifest.assets.map((a) => [a.file, a]));
  const pendingBlobs = [];
  const fn = (url, init) => {
    calls.push(String(url));
    if (String(url).endsWith('manifest.json')) {
      if (o.manifestNever) return new Promise(() => {});
      if (o.manifestReject) return Promise.reject(new TypeError('Failed to fetch'));
      if (o.manifestStatus) return Promise.resolve({ ok: false, status: o.manifestStatus, json: async () => ({}) });
      return Promise.resolve({ ok: true, status: 200, json: o.manifestJson ?? (async () => manifest) });
    }
    const entry = byFile.get(String(url).replace(/^.*?assets\//, ''));
    if (!o.blobs || !entry) return Promise.resolve({ ok: false, status: 404, blob: async () => { throw new Error('404'); } });
    return new Promise((resolve, reject) => {
      const rec = { id: entry.id, entry, resolve: (v) => resolve(v ?? { ok: true, status: 200, blob: async () => ({ isBlob: true, id: entry.id }) }), reject, signal: init?.signal };
      pendingBlobs.push(rec);
      if (o.blobsImmediate) rec.resolve();
    });
  };
  fn.calls = calls;
  fn.pendingBlobs = pendingBlobs;
  return fn;
}

/** A fake createImageBitmap: makes {width, height, close()} bitmaps of the size the id's manifest entry says (or `sizes[id]`). */
export function createFakeBitmaps(manifest, o = {}) {
  const made = [];
  const sizes = o.sizes ?? {};
  const failIds = new Set(o.failIds ?? []);
  return {
    made,
    createBitmap: async (blob) => {
      if (failIds.has(blob.id)) throw new Error('InvalidStateError');
      const entry = manifest.assets.find((a) => a.id === blob.id);
      const [width, height] = sizes[blob.id] ?? [entry.width, entry.height];
      const bmp = { id: blob.id, width, height, closed: false, close() { this.closed = true; } };
      made.push(bmp);
      return bmp;
    },
  };
}

export function createFakeConsole() {
  const lines = [];
  return { lines, warn: (...a) => lines.push(['warn', a.join(' ')]), error: (...a) => lines.push(['error', a.join(' ')]), log() {}, info() {} };
}

export function createCanvasRecorder() {
  const created = [];
  return { created, createCanvas: (w, h) => new FakeCanvas(w, h, created) };
}

/** Let promise callbacks run (microtasks, a few rounds). */
export async function settle(rounds = 8) {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
  await new Promise((r) => setImmediate(r));
}
