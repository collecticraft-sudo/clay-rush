// A controllable stand-in for the assets loader, for the stage tests only. OWNER: Render & Audio engineer.
//
// It implements the part of the Assets API of docs/assets-integration.md 2.2 that stage.js uses (isNull, config, generation, load, prefetch,
// release, get, has, meta, ids, status, on, dispose) for the four stage groups. Nothing loads by itself unless `auto` is set: the test
// decides when a group settles (`stub.settle(group)`), which makes every ordering of "load finished", "frame drawn" and "release" testable.
// The drawables are plain stubs `{id, width, height, isStub: true}` with the shipped sizes (far 2560 x 1440, near 1920 x 1080).

import { ART_CONFIG } from '../../public/js/render/art-config.js';

const STAGES = ['meadow', 'hills', 'alpine'];
const LAYERS = ['far', 'near'];
export const SHIPPED_SIZES = Object.freeze({ far: [2560, 1440], near: [1920, 1080] });

/**
 * @param {{config?:object, auto?:boolean, sizes?:Record<string,[number,number]>, failIds?:string[], failGroups?:string[], generation?:number}} [o]
 *   auto        settle every load in a microtask (a fast disk); default false (the test calls settle)
 *   failIds     asset ids that never load (their group settles `partial`, or `failed` when nothing loaded)
 *   failGroups  groups that settle `failed` without loading anything (a failed manifest, for example)
 */
export function createStageStubAssets(o = {}) {
  const config = o.config ?? ART_CONFIG;
  const sizes = { ...SHIPPED_SIZES, ...(o.sizes ?? {}) };
  const failIds = new Set(o.failIds ?? []);
  const failGroups = new Set(o.failGroups ?? []);
  const listeners = { group: new Set(), release: new Set(), asset: new Set(), progress: new Set(), manifest: new Set() };
  const groups = new Map(); // group -> {state, promise, resolve}
  const images = new Map(); // id -> drawable
  let generation = o.generation ?? 0;
  let disposed = false;

  const log = { loads: [], prefetches: [], releases: [], groupEvents: [], releaseEvents: [] };

  const idsOf = (group) => {
    const stage = group.startsWith('stage:') ? group.slice(6) : null;
    return STAGES.includes(stage) ? LAYERS.map((l) => `bg_${stage}_${l}`) : [];
  };

  function emit(type, payload) {
    for (const fn of [...(listeners[type] ?? [])]) {
      try {
        fn(payload);
      } catch {
        /* handler errors are isolated, as in shared/emitter.js */
      }
    }
  }

  function settleNow(group, forced) {
    const g = groups.get(group);
    if (!g || g.state !== 'loading') return g?.promise ?? Promise.resolve(null);
    const ids = idsOf(group);
    let state = forced;
    let loaded = 0;
    if (!state) {
      if (failGroups.has(group) || ids.length === 0) state = 'failed';
      else {
        for (const id of ids) {
          if (failIds.has(id)) continue;
          const layer = id.slice(id.lastIndexOf('_') + 1);
          const [width, height] = sizes[layer];
          images.set(id, { id, width, height, isStub: true });
          loaded++;
        }
        state = loaded === ids.length ? 'ready' : loaded === 0 ? 'failed' : 'partial';
      }
    } else if (state === 'ready' || state === 'partial') {
      for (const id of ids) {
        if (failIds.has(id) && state === 'partial') continue;
        const layer = id.slice(id.lastIndexOf('_') + 1);
        const [width, height] = sizes[layer];
        images.set(id, { id, width, height, isStub: true });
        loaded++;
      }
    }
    g.state = state;
    generation++;
    const result = Object.freeze({ group, state, loaded, failed: ids.length - loaded, total: ids.length });
    log.groupEvents.push(result);
    emit('group', result);
    g.resolve(result);
    return g.promise;
  }

  const stub = {
    isNull: false,
    config,
    get generation() {
      return generation;
    },
    /** Test seam: what the stage asked for. */
    log,
    load(group, opts) {
      log.loads.push({ group, low: opts?.priority === 'low' });
      if (disposed) return Promise.resolve(Object.freeze({ group, state: 'disabled', loaded: 0, failed: 0, total: 0 }));
      let g = groups.get(group);
      if (g && (g.state === 'loading' || g.state === 'ready' || g.state === 'partial' || g.state === 'failed')) return g.promise;
      if (idsOf(group).length === 0) return Promise.resolve(Object.freeze({ group, state: 'failed', loaded: 0, failed: 0, total: 0 }));
      let resolve;
      const promise = new Promise((r) => { resolve = r; });
      g = { state: 'loading', promise, resolve };
      groups.set(group, g);
      if (o.auto) Promise.resolve().then(() => settleNow(group));
      return promise;
    },
    prefetch(group) {
      log.prefetches.push(group);
      stub.load(group, { priority: 'low' });
    },
    release(group) {
      log.releases.push(group);
      const g = groups.get(group);
      if (g) {
        for (const id of idsOf(group)) images.delete(id);
        groups.delete(group);
      }
      generation++;
      log.releaseEvents.push(group);
      emit('release', { group });
    },
    get: (id) => images.get(id) ?? null,
    has: (id) => images.has(id),
    meta: () => null,
    ids: (group) => (group ? idsOf(group) : STAGES.flatMap((s) => idsOf(`stage:${s}`))),
    scaled: () => null,
    sliced: () => null,
    status: () => ({ manifest: 'ready', groups: {}, generation }),
    on(type, fn) {
      const set = listeners[type];
      if (!set) return () => {};
      set.add(fn);
      return () => set.delete(fn);
    },
    dispose() {
      disposed = true;
    },

    // ---- test controls
    /** Finish the pending load of `group`. `state` forces the outcome (ready, partial, failed); default follows failIds and failGroups. */
    settle: (group, state) => settleNow(group, state),
    /** Groups whose load is still pending. */
    pending: () => [...groups].filter(([, g]) => g.state === 'loading').map(([name]) => name),
    /** Groups that are decoded right now. */
    loaded: () => [...groups].filter(([, g]) => g.state === 'ready' || g.state === 'partial').map(([name]) => name),
    loadCount: (group) => log.loads.filter((l) => l.group === group).length,
    listenerCount: (type) => listeners[type].size,
    /** Make a group's images disappear WITHOUT a release event (a loader that dropped them silently); bumps generation. */
    dropImagesSilently(group) {
      for (const id of idsOf(group)) images.delete(id);
      generation++;
    },
    /** Replace the drawables of a ready group with new objects (a reload we did not cause); bumps generation. */
    replaceImages(group) {
      for (const id of idsOf(group)) {
        const old = images.get(id);
        if (old) images.set(id, { ...old });
      }
      generation++;
    },
  };
  return stub;
}
