// A stub `Assets` for the render tests, built from the REAL public/assets/manifest.json. OWNER: Render & Audio engineer.
//
// It implements what the world renderer, the HUD, the sprites and the stage use (isNull, config, generation, has, get, meta, ids, scaled,
// sliced, on, status, load, prefetch, release, dispose). `get(id)` returns a stub drawable `{id, width, height, isStub: true}`; `scaled()`
// builds a fake canvas through the injected factory (contain fit of the content box) and caches like the loader. Loads settle in a
// microtask with every id of the group present unless it is listed in `missing`.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ART_CONFIG } from '../../public/js/render/art-config.js';
import { FakeCanvas } from './fake-canvas.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const MANIFEST = JSON.parse(readFileSync(join(ROOT, 'public', 'assets', 'manifest.json'), 'utf8'));

/**
 * @param {{createCanvas?:(w:number,h:number)=>any, loaded?:string[]|'all', missing?:string[]}} [o]
 *   loaded: ids present from the start ('all' = every id of the manifest; default: none, load() brings groups in)
 */
export function createArtStub(o = {}) {
  const meta = new Map(MANIFEST.assets.map((a) => [a.id, Object.freeze({ ...a })]));
  const groups = MANIFEST.groups;
  const missing = new Set(o.missing ?? []);
  const images = new Map();
  const listeners = { group: new Set(), release: new Set(), asset: new Set(), progress: new Set(), manifest: new Set() };
  const createCanvas = o.createCanvas ?? ((w, h) => new FakeCanvas(w, h));
  const cache = new Map();
  let generation = 0;
  const calls = { scaled: 0, loads: [], releases: [] };

  const put = (id) => {
    if (missing.has(id) || !meta.has(id)) return false;
    const m = meta.get(id);
    images.set(id, { id, width: m.width, height: m.height, naturalWidth: m.width, naturalHeight: m.height, isStub: true });
    return true;
  };
  if (o.loaded === 'all') for (const id of meta.keys()) put(id);
  else for (const id of o.loaded ?? []) put(id);

  const emit = (type, payload) => {
    for (const fn of [...(listeners[type] ?? [])]) fn(payload);
  };

  const stub = {
    isNull: false,
    config: ART_CONFIG,
    get generation() { return generation; },
    calls,
    load(group) {
      calls.loads.push(group);
      const ids = groups[group] ?? [];
      return Promise.resolve().then(() => {
        let loaded = 0;
        for (const id of ids) if (put(id)) loaded++;
        generation++;
        cache.clear();
        const state = ids.length === 0 ? 'failed' : loaded === ids.length ? 'ready' : loaded === 0 ? 'failed' : 'partial';
        const r = Object.freeze({ group, state, loaded, failed: ids.length - loaded, total: ids.length });
        emit('group', r);
        return r;
      });
    },
    prefetch(group) { stub.load(group); },
    release(group) {
      calls.releases.push(group);
      for (const id of groups[group] ?? []) images.delete(id);
      generation++;
      cache.clear();
      emit('release', { group });
    },
    get: (id) => images.get(id) ?? null,
    has: (id) => images.has(id),
    meta: (id) => meta.get(id) ?? null,
    ids: (group) => (group === undefined ? [...meta.keys()] : groups[group] ?? []),
    scaled(id, boxW, boxH, density = 1) {
      calls.scaled++;
      const m = meta.get(id);
      if (!images.has(id) || !m || !(boxW > 0) || !(boxH > 0)) return null;
      const key = `${id}|${boxW}|${boxH}|${density}`;
      const hit = cache.get(key);
      if (hit) return hit;
      const cb = m.contentBox;
      const s = Math.min(boxW / cb.w, boxH / cb.h);
      const w = cb.w * s;
      const h = cb.h * s;
      const value = Object.freeze({ canvas: createCanvas(Math.ceil(w * density), Math.ceil(h * density)), w, h, density });
      cache.set(key, value);
      return value;
    },
    sliced: () => null,
    status: () => ({ manifest: 'ready', groups: {}, generation }),
    on(type, fn) {
      const set = listeners[type];
      if (!set) return () => {};
      set.add(fn);
      return () => set.delete(fn);
    },
    dispose() {},
    /** Test control: drop an id (bumps generation). */
    remove(id) {
      images.delete(id);
      generation++;
      cache.clear();
    },
  };
  return stub;
}
