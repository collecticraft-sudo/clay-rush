// A stub of the Assets object (docs/assets-integration.md 2.2) for the UI-kit tests. OWNER: UI-kit engineer.
//
// It implements the members the UI kit uses (has, get, meta, scaled, sliced, generation, config, on, status, ids, load) with the exact size
// formulas of the contract (contain fit, three-slice and nine-slice sizes), on the metadata that the Asset engineer seeds in Appendix A
// (checked against the files of design/ui, design/icons on 2026-09-30: content boxes are measured, label insets, cells, ring and slices
// are the contract's seeds). The canvases are fake canvases tagged with the id they were made from, so a test can say which art a widget drew.
//
// This file does not import the Asset engineer's stub on purpose (parallel work); test/ui/art-crosscheck.test.js compares the two when
// both exist.
import { existsSync, readFileSync } from 'node:fs';
import { FakeCanvas } from '../render/fake-canvas.js';
import { ART_CONFIG } from '../../public/js/render/art-config.js';

const box = (x, y, w, h) => Object.freeze({ x, y, w, h });
const STATES = ['default', 'focused', 'pressed', 'disabled'];

function buttons() {
  const out = {};
  const spec = {
    primary: { slice: { l: 190, r: 190, t: 0, b: 0 }, label: { l: 110, r: 110, t: 46, b: 46 }, sizes: [[840, 262, box(3, 3, 834, 256)], [840, 281, box(3, 3, 834, 275)], [840, 262, box(3, 3, 834, 256)], [840, 264, box(3, 3, 833, 257)]] },
    secondary: { slice: { l: 160, r: 160, t: 0, b: 0 }, label: { l: 125, r: 120, t: 56, b: 56 }, sizes: [[840, 227, box(3, 3, 834, 221)], [840, 245, box(3, 3, 834, 239)], [840, 229, box(3, 3, 834, 223)], [840, 233, box(3, 3, 834, 227)]] },
  };
  for (const [variant, s] of Object.entries(spec)) {
    STATES.forEach((state, i) => {
      const id = `button_${variant}_${state}`;
      const [width, height, cb] = s.sizes[i];
      out[id] = {
        id, kind: 'ui', group: 'core', width, height, contentBox: cb, anchor: { x: cb.x + cb.w / 2, y: cb.y + cb.h / 2 },
        slice: Object.freeze({ ...s.slice }), label: Object.freeze({ ...s.label }), ...(i === 0 ? {} : { ref: `button_${variant}_default` }),
      };
    });
  }
  return out;
}

function steppers() {
  const out = {};
  const sizes = {
    minus: [[336, 346, box(5, 5, 326, 336)], [336, 358, box(5, 4, 327, 349)], [336, 352, box(5, 5, 326, 341)], [336, 358, box(5, 5, 326, 348)]],
    plus: [[336, 346, box(5, 5, 325, 336)], [336, 355, box(5, 4, 326, 346)], [336, 348, box(5, 5, 326, 338)], [336, 359, box(5, 5, 326, 349)]],
  };
  for (const sym of ['minus', 'plus']) {
    STATES.forEach((state, i) => {
      const id = `stepper_${sym}_${state}`;
      const [width, height, cb] = sizes[sym][i];
      out[id] = { id, kind: 'ui', group: 'core', width, height, contentBox: cb, anchor: { x: cb.x + cb.w / 2, y: cb.y + cb.h / 2 }, ...(i === 0 ? {} : { ref: `stepper_${sym}_default` }) };
    });
  }
  return out;
}

const CELLS = Object.freeze([Object.freeze({ x: 0.03, y: 0.11, w: 0.45, h: 0.78 }), Object.freeze({ x: 0.52, y: 0.11, w: 0.45, h: 0.78 })]);

/** Seed metadata (shipped px). Keys are asset ids; every entry has width, height, contentBox, anchor. */
export const SEED = (() => {
  const m = { ...buttons(), ...steppers() };
  const add = (id, kind, width, height, cb, extra = {}) => {
    m[id] = { id, kind, group: 'core', width, height, contentBox: cb, anchor: { x: cb.x + cb.w / 2, y: cb.y + cb.h / 2 }, ...extra };
  };
  add('toggle_off', 'ui', 840, 243, box(3, 4, 833, 236), { cells: CELLS });
  add('toggle_on', 'ui', 840, 247, box(3, 3, 833, 240), { cells: CELLS });
  add('toggle_focused', 'ui', 840, 270, box(3, 3, 834, 264), { cells: CELLS });
  add('panel_9slice', 'ui', 512, 512, box(1, 1, 510, 510), { slice: { l: 48, r: 48, t: 48, b: 48, scale: 0.5 } });
  add('timer_ring', 'ui', 512, 508, box(3, 2, 506, 504), { ring: { cx: 256, cy: 254, outer: 253, bandMid: 203, bandHalf: 31, hole: 153 } });
  add('logo_title', 'logo', 1400, 714, box(2, 3, 1396, 710));
  // icons and glyphs: 256 x 256 shipped, content boxes measured on the 512 px sources and halved
  add('icon_trophy', 'icon', 256, 256, box(24, 20, 208, 216));
  add('icon_combo', 'icon', 256, 256, box(28, 20, 201, 216));
  add('icon_freeze', 'icon', 256, 256, box(33, 20, 190, 217));
  add('icon_frenzy', 'icon', 256, 256, box(45, 20, 166, 217));
  add('icon_double', 'icon', 256, 256, box(20, 20, 217, 216));
  add('icon_clock', 'icon', 256, 256, box(22, 20, 213, 217));
  add('icon_life_full', 'icon', 256, 256, box(32, 20, 191, 217));
  add('icon_life_empty', 'icon', 256, 256, box(34, 20, 189, 216));
  add('icon_warning', 'icon', 256, 256, box(20, 30, 216, 196));
  add('glyph_joycon_l', 'glyph', 256, 256, box(88, 19, 81, 218));
  add('glyph_joycon_r', 'glyph', 256, 256, box(88, 19, 81, 218));
  add('glyph_keyboard_enter', 'glyph', 256, 256, box(41, 20, 175, 216));
  add('glyph_mouse', 'glyph', 256, 256, box(60, 20, 137, 217));
  add('glyph_sync_button', 'glyph', 256, 256, box(85, 19, 86, 218));
  return Object.freeze(m);
})();

const GROUP_OF = (id) => SEED[id]?.group ?? 'core';

/**
 * @param {{missing?:string[], noMeta?:string[], only?:string[], config?:object, meta?:Record<string,object>, seed?:Record<string,object>}} [o]
 *   missing: ids whose image is not usable (has() false, scaled/sliced null) although their meta is known;
 *   noMeta: ids without meta; only: usable ids (everything else missing); meta: per-id overrides merged into the seed (for edge cases).
 */
export function createArtStub(o = {}) {
  const seed = o.seed ?? SEED;
  const missing = new Set(o.missing ?? []);
  const noMeta = new Set(o.noMeta ?? []);
  const only = o.only ? new Set(o.only) : null;
  const overrides = o.meta ?? {};
  const listeners = new Map();
  const stats = { scaled: 0, sliced: 0, has: 0, get: 0, meta: 0 };
  const scaledLog = [];
  const slicedLog = [];
  const usable = (id) => Object.hasOwn(seed, id) && !missing.has(id) && (!only || only.has(id));
  const metaOf = (id) => {
    if (!Object.hasOwn(seed, id) || noMeta.has(id)) return null;
    return Object.freeze({ ...seed[id], ...(overrides[id] ?? {}) });
  };
  const emit = (type, payload) => { for (const fn of listeners.get(type) ?? []) fn(payload); };

  const stub = {
    isNull: false,
    isStub: true,
    config: o.config ?? ART_CONFIG,
    generation: 1,
    stats, scaledLog, slicedLog,
    load: async (group) => ({ group, state: 'ready', loaded: 1, failed: 0, total: 1 }),
    prefetch() {},
    release() {},
    get(id) { stats.get++; return usable(id) ? { id, width: seed[id].width, height: seed[id].height, isStub: true } : null; },
    has(id) { stats.has++; return usable(id); },
    meta(id) { stats.meta++; return metaOf(id); },
    ids(group) { return Object.keys(seed).filter((id) => !group || group === GROUP_OF(id)); },
    scaled(id, boxW, boxH, density = 1, opts = {}) {
      stats.scaled++;
      if (!usable(id)) return null;
      const m = metaOf(id);
      if (!m) return null;
      const cb = m.contentBox;
      let s;
      let w;
      let h;
      if (opts.fit === 'stretch') { w = boxW; h = boxH; s = null; } else { s = Math.min(boxW / cb.w, boxH / cb.h); w = cb.w * s; h = cb.h * s; }
      const canvas = new FakeCanvas(Math.ceil(w * density), Math.ceil(h * density));
      canvas.artId = id;
      canvas.artKind = 'scaled';
      canvas.artScale = s;
      scaledLog.push({ id, boxW, boxH, density, w, h });
      return { canvas, w, h, density };
    },
    sliced(id, w, h, density = 1) {
      stats.sliced++;
      if (!usable(id)) return null;
      const m = metaOf(id);
      if (!m || !m.slice) return null;
      const cb = m.contentBox;
      const ref = metaOf(m.ref ?? id) ?? m;
      const rb = ref.contentBox;
      const sl = m.slice;
      let s;
      let outW;
      let outH;
      if (sl.t === 0 && sl.b === 0) {
        s = h / rb.h;
        outW = w + (cb.w - rb.w) * s;
        outH = cb.h * s;
      } else {
        s = sl.scale ?? 0.5;
        outW = w + (cb.w - rb.w) * s;
        outH = h + (cb.h - rb.h) * s;
      }
      const canvas = new FakeCanvas(Math.ceil(outW * density), Math.ceil(outH * density));
      canvas.artId = id;
      canvas.artKind = 'sliced';
      canvas.artScale = s;
      slicedLog.push({ id, w, h, density, outW, outH, s });
      return { canvas, w: outW, h: outH, density };
    },
    status: () => ({ manifest: 'ready', groups: { core: { state: 'ready', loaded: 60, failed: 0, total: 100 } }, generation: stub.generation }),
    on(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
      return () => listeners.get(type).delete(fn);
    },
    dispose() {},
    /** Test hook: an image became (un)usable; consumers must rebuild what they cached. */
    setMissing(ids, gone = true) {
      for (const id of ids) { if (gone) missing.add(id); else missing.delete(id); }
      stub.generation++;
      emit('group', { group: 'core', state: 'partial' });
    },
    bump() { stub.generation++; },
    resetStats() { for (const k of Object.keys(stats)) stats[k] = 0; scaledLog.length = 0; slicedLog.length = 0; },
  };
  return stub;
}

/**
 * The stub with the glyph switch turned ON (ART_CONFIG.glyphs.enabled is false since art review round 1). The layout tests of the controller
 * pair use it: the pair must still sit in free space the day the owner turns the switch on with replacement pictures.
 */
export function createArtStubWithGlyphs(o = {}) {
  const base = o.config ?? ART_CONFIG;
  return createArtStub({ ...o, config: { ...base, glyphs: { ...base.glyphs, enabled: true } } });
}

/** The stub with the glyph switch turned off (ART_CONFIG.glyphs.enabled = false). */
export function createArtStubNoGlyphs(o = {}) {
  const base = ART_CONFIG;
  return createArtStub({ ...o, config: { ...base, glyphs: { ...base.glyphs, enabled: false } } });
}

/**
 * The metadata of the shipped assets (`public/assets/manifest.json`, written by the Asset engineer's build tool) keyed by asset id, or null
 * when the file is absent or unreadable. Tests that use it run against the real measured numbers instead of the seeds and skip without it.
 */
export function loadManifestSeed() {
  const file = new URL('../../public/assets/manifest.json', import.meta.url);
  try {
    if (!existsSync(file)) return null;
    const m = JSON.parse(readFileSync(file, 'utf8'));
    if (!m || m.version !== 1 || !Array.isArray(m.assets)) return null;
    return Object.freeze(Object.fromEntries(m.assets.map((a) => [a.id, Object.freeze({ ...a })])));
  } catch {
    return null;
  }
}
