// The real assets loader (public/js/render/assets.js, docs/assets-integration.md 2) in Node, with fake images, fake timers, a fake fetch and a fake
// canvas factory (test-support/assets/loader-rig.js). OWNER: integrator. It proves the promises of the contract: load never rejects, a failure of any
// kind leaves the object usable (has() false), generation and events move as documented, release frees, scaled and sliced sizes follow 2.2 and 2.6.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAssets, NULL_ASSETS } from '../../public/js/render/assets.js';
import { ART_CONFIG } from '../../public/js/render/art-config.js';
import {
  createCanvasRecorder, createFakeBitmaps, createFakeConsole, createFakeFetch, createFakeImages, createFakeTimers, makeManifest, settle,
} from '../../test-support/assets/loader-rig.js';

function rig(o = {}) {
  const manifest = o.manifest ?? makeManifest();
  const images = createFakeImages(manifest);
  const timers = createFakeTimers();
  const fetch = createFakeFetch(manifest, o.fetch ?? {});
  const canvases = createCanvasRecorder();
  const cons = createFakeConsole();
  const bitmaps = o.bitmaps ? createFakeBitmaps(manifest, o.bitmaps) : null;
  const assets = createAssets({
    baseUrl: '/assets/', fetch, createImage: images.createImage, createCanvas: o.noCanvas ? undefined : canvases.createCanvas, setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout, console: cons, config: o.config, ...(o.parsed ? { manifest } : {}),
    ...(bitmaps ? { createBitmap: bitmaps.createBitmap } : { createBitmap: null }),
  });
  return { manifest, images, timers, fetch, canvases, cons, assets, bitmaps };
}

/** Complete every image of a group in the order the loader asks for them. */
async function finishAll(r, group) {
  await settle(); // the manifest first: ids() is empty until it has been read
  const ids = r.assets.ids(group);
  for (let guard = 0; guard < 100; guard++) {
    await settle();
    const next = r.images.pendingIds().find((id) => ids.includes(id));
    if (!next) break;
    r.images.finish(next);
  }
  await settle();
}

test('the loader has every member of NULL_ASSETS, isNull is false, and creating it touches nothing', () => {
  const r = rig();
  for (const key of Object.keys(NULL_ASSETS)) assert.ok(key in r.assets, `member ${key}`);
  assert.equal(r.assets.isNull, false);
  assert.equal(r.assets.config, ART_CONFIG);
  assert.equal(r.assets.generation, 0);
  assert.equal(r.fetch.calls.length, 0, 'nothing is fetched before the first load()');
  assert.equal(r.images.requested.length, 0);
  assert.deepEqual(r.assets.ids(), []);
  assert.equal(r.assets.meta('logo'), null);
  assert.equal(r.assets.has('logo'), false);
  assert.equal(r.assets.get('logo'), null);
  assert.equal(r.assets.scaled('logo', 10, 10), null);
  assert.equal(r.assets.sliced('btn_default', 10, 10), null);
  assert.deepEqual(r.assets.status(), { manifest: 'idle', groups: {}, generation: 0 });
});

test('load(core): fetches the manifest once, loads the group in manifest order with the configured concurrency, then resolves ready', async () => {
  const r = rig({ config: { ...ART_CONFIG, loader: { ...ART_CONFIG.loader, concurrency: 2 } } });
  const p = r.assets.load('core');
  await settle();
  assert.equal(r.fetch.calls.filter((u) => u.endsWith('manifest.json')).length, 1);
  assert.equal(r.fetch.calls[0], '/assets/manifest.json');
  assert.deepEqual(r.images.pendingIds(), ['logo', 'btn_default'], 'two at a time, in manifest order');
  r.images.finish('logo');
  await settle();
  assert.deepEqual(r.images.pendingIds(), ['btn_default', 'btn_focused'], 'a slot freed: the next id starts');
  await finishAll(r, 'core');
  const res = await p;
  assert.deepEqual(res, { group: 'core', state: 'ready', loaded: 5, failed: 0, total: 5 });
  assert.ok(Object.isFrozen(res));
  assert.equal(r.images.peak <= 2, true, 'never more than `concurrency` loads at once');
  assert.deepEqual(r.images.requested, ['logo', 'btn_default', 'btn_focused', 'panel', 'fruit']);
  for (const id of r.assets.ids('core')) assert.equal(r.assets.has(id), true, id);
  assert.equal(r.assets.get('logo').src, '/assets/ui/logo.png');
  assert.equal(r.assets.meta('logo').kind, 'logo');
  assert.ok(Object.isFrozen(r.assets.meta('logo')), 'manifest entries are frozen');
  assert.ok(Object.isFrozen(r.assets.meta('logo').contentBox), 'deeply');
  assert.deepEqual(r.assets.ids('stage:x'), ['bg_x_far', 'bg_x_mid', 'bg_x_near']);
  assert.equal(r.assets.status().manifest, 'ready');
  assert.deepEqual(r.assets.status().groups.core, { state: 'ready', loaded: 5, failed: 0, total: 5 });
  assert.deepEqual(r.assets.status().groups['stage:x'], { state: 'idle', loaded: 0, failed: 0, total: 3 });
  assert.equal(r.images.requested.includes('bg_x_far'), false, 'a stage group is not loaded with core');
});

test('the same promise while loading, an immediate result when done, and the image element is asked with decoding async', async () => {
  const r = rig();
  const a = r.assets.load('core');
  const b = r.assets.load('core');
  assert.notEqual(a, undefined);
  await settle();
  assert.equal(r.assets.load('core'), r.assets.load('core'), 'one promise while loading');
  await finishAll(r, 'core');
  const [ra, rb] = await Promise.all([a, b]);
  assert.deepEqual(ra, rb);
  const again = await r.assets.load('core');
  assert.equal(again.state, 'ready');
  assert.equal(r.fetch.calls.filter((u) => u.endsWith('manifest.json')).length, 1, 'the manifest is fetched once');
  assert.equal(r.images.requested.length, 5, 'nothing is loaded twice');
});

test('events: manifest, then asset and progress after every image, then group when it settles; generation grows with every usable image', async () => {
  const r = rig();
  const seen = [];
  for (const type of ['manifest', 'asset', 'progress', 'group', 'release']) r.assets.on(type, (p) => seen.push([type, p]));
  const gens = [];
  r.assets.on('asset', () => gens.push(r.assets.generation));
  const p = r.assets.load('core');
  await finishAll(r, 'core');
  await p;
  assert.deepEqual(seen[0], ['manifest', { ok: true }]);
  const types = seen.map((s) => s[0]);
  assert.deepEqual(types.slice(1), ['asset', 'progress', 'asset', 'progress', 'asset', 'progress', 'asset', 'progress', 'asset', 'progress', 'group']);
  assert.deepEqual(seen.filter((s) => s[0] === 'progress').map((s) => s[1].loaded), [1, 2, 3, 4, 5]);
  assert.deepEqual(seen.at(-1), ['group', { group: 'core', state: 'ready', loaded: 5, failed: 0, total: 5 }]);
  assert.deepEqual(gens, [1, 2, 3, 4, 5]);
  assert.equal(r.assets.generation, 5);
  // a handler that throws does not break the others or the loader (shared/emitter.js)
  const r2 = rig();
  const errors = [];
  const origError = console.error;
  console.error = (...a) => errors.push(a.join(' '));
  try {
    r2.assets.on('group', () => { throw new Error('boom'); });
    let got = null;
    r2.assets.on('group', (g) => { got = g; });
    const p2 = r2.assets.load('core');
    await finishAll(r2, 'core');
    await p2;
    assert.equal(got.state, 'ready');
  } finally {
    console.error = origError;
  }
  assert.equal(errors.length, 1);
  const off = r.assets.on('group', () => {});
  assert.equal(typeof off, 'function');
});

test('load never rejects: manifest fetch error, bad status, invalid JSON, wrong version, no assets array, and a fetch that throws', async () => {
  const cases = {
    'fetch rejects': { manifestReject: true },
    'status 404': { manifestStatus: 404 },
    'invalid json': { manifestJson: async () => { throw new SyntaxError('Unexpected token'); } },
    'version 2': { manifestJson: async () => ({ version: 2, assets: [], groups: {} }) },
    'no assets array': { manifestJson: async () => ({ version: 1, groups: {} }) },
    'null body': { manifestJson: async () => null },
  };
  for (const [name, fetchOpts] of Object.entries(cases)) {
    const r = rig({ fetch: fetchOpts });
    const res = await r.assets.load('core');
    assert.deepEqual(res, { group: 'core', state: 'failed', loaded: 0, failed: 0, total: 0 }, name);
    assert.equal(r.assets.status().manifest, 'failed', name);
    assert.equal(r.assets.has('logo'), false, name);
    assert.equal((await r.assets.load('stage:x')).state, 'failed', `${name}: every later load is failed too`);
    assert.equal(r.fetch.calls.filter((u) => u.endsWith('manifest.json')).length, 1, `${name}: no retry`);
    assert.equal(r.cons.lines.length, 1, `${name}: one warning`);
    assert.match(r.cons.lines[0][1], /^\[clay-rush\] /);
  }
  const throwing = createAssets({ baseUrl: '/assets/', fetch: () => { throw new Error('sync boom'); }, createImage: () => ({}), console: createFakeConsole() });
  assert.equal((await throwing.load('core')).state, 'failed');
});

test('manifest timeout: a fetch that never answers fails after manifestTimeoutMs and the loader stays usable', async () => {
  const r = rig({ fetch: { manifestNever: true } });
  const p = r.assets.load('core');
  await settle();
  assert.equal(r.assets.status().manifest, 'loading');
  r.timers.advance(ART_CONFIG.loader.manifestTimeoutMs - 1);
  await settle();
  assert.equal(r.assets.status().manifest, 'loading');
  r.timers.advance(1);
  assert.equal((await p).state, 'failed');
  assert.equal(r.assets.status().manifest, 'failed');
  assert.equal(r.timers.pending(), 0, 'no timer is left behind');
});

test('an unknown group resolves failed with total 0; a loader without fetch or Image behaves like NULL_ASSETS (disabled)', async () => {
  const r = rig();
  assert.deepEqual(await r.assets.load('stage:nope'), { group: 'stage:nope', state: 'failed', loaded: 0, failed: 0, total: 0 });
  const bare = createAssets({ fetch: null, createImage: null });
  assert.equal((await bare.load('core')).state, 'disabled');
  assert.equal(bare.has('logo'), false);
});

test('a parsed manifest skips the fetch and makes meta() and ids() usable at once', async () => {
  const r = rig({ parsed: true });
  assert.equal(r.fetch.calls.length, 0);
  assert.equal(r.assets.status().manifest, 'ready');
  assert.equal(r.assets.meta('fruit').body.r, 187);
  assert.equal(r.assets.ids('core').length, 5);
  const p = r.assets.load('core');
  await finishAll(r, 'core');
  assert.equal((await p).state, 'ready');
  assert.equal(r.fetch.calls.length, 0, 'still no fetch');
});

test('an image that errors, times out, decodes to another size or fails decode() is failed; the rest of the group loads; one warning per group; no retry', async () => {
  const r = rig();
  const events = [];
  r.assets.on('asset', (e) => events.push([e.id, e.ok]));
  const p = r.assets.load('core');
  await settle();
  r.images.fail('logo'); // network error
  await settle();
  r.images.finish('btn_default', { size: [100, 100] }); // wrong decoded size
  await settle();
  r.images.finish('btn_focused', { decodeFails: true }); // decode() rejects
  await settle();
  // panel is now pending; let it time out
  assert.deepEqual(r.images.pendingIds().slice(0, 2), ['panel', 'fruit']);
  r.images.finish('fruit');
  await settle();
  r.timers.advance(ART_CONFIG.loader.imageTimeoutMs);
  const res = await p;
  assert.deepEqual(res, { group: 'core', state: 'partial', loaded: 1, failed: 4, total: 5 });
  assert.deepEqual(events.map((e) => e[0]).sort(), ['btn_default', 'btn_focused', 'fruit', 'logo', 'panel']);
  assert.deepEqual(Object.fromEntries(events), { logo: false, btn_default: false, btn_focused: false, panel: false, fruit: true });
  for (const id of ['logo', 'btn_default', 'btn_focused', 'panel']) {
    assert.equal(r.assets.has(id), false, id);
    assert.equal(r.assets.get(id), null, id);
    assert.ok(r.assets.meta(id), `${id}: the manifest entry stays known`);
  }
  assert.equal(r.assets.has('fruit'), true);
  assert.equal(r.cons.lines.filter((l) => /asset group "core" is partial/.test(l[1])).length, 1, 'one warning for the group, not one per image');
  assert.equal(r.images.log.srcCleared >= 1, true, 'the timed out image is cancelled');
  const before = r.images.requested.length;
  await r.assets.load('core');
  assert.equal(r.images.requested.length, before, 'a failed id is not retried');
  assert.equal(r.timers.pending(), 0);
});

test('every image failing makes the group failed; a layer gets layerTimeoutMs, not imageTimeoutMs', async () => {
  const r = rig();
  const p = r.assets.load('stage:x');
  await settle();
  r.timers.advance(ART_CONFIG.loader.imageTimeoutMs + 1);
  await settle();
  assert.equal(r.assets.status().groups['stage:x'].state, 'loading', 'layers are slower than the sprites');
  r.timers.advance(ART_CONFIG.loader.layerTimeoutMs);
  const res = await p;
  assert.deepEqual(res, { group: 'stage:x', state: 'failed', loaded: 0, failed: 3, total: 3 });
  assert.equal(r.assets.has('bg_x_far'), false);
});

test('release drops the images, bumps the generation, emits release, cancels what is in flight and lets the group load again', async () => {
  const r = rig();
  const p = r.assets.load('stage:x');
  await settle();
  r.images.finish('bg_x_far');
  await settle();
  assert.equal(r.assets.has('bg_x_far'), true);
  const gen = r.assets.generation;
  const seen = [];
  r.assets.on('release', (e) => seen.push(e));
  r.assets.release('stage:x'); // while two layers are still loading
  assert.deepEqual(seen, [{ group: 'stage:x' }]);
  assert.equal(r.assets.generation, gen + 1);
  assert.equal(r.assets.has('bg_x_far'), false);
  assert.equal((await p).state, 'released', 'the pending load promise resolves');
  assert.equal(r.assets.status().groups['stage:x'].state, 'released');
  assert.equal(r.images.log.srcCleared, 2, 'the two requests that were in flight are cancelled by clearing their src');
  r.images.pending.length = 0;
  const p2 = r.assets.load('stage:x');
  await finishAll(r, 'stage:x');
  assert.equal((await p2).state, 'ready');
  assert.equal(r.assets.has('bg_x_far'), true);
  // release of something never loaded does nothing (no event, no generation change)
  const g2 = r.assets.generation;
  r.assets.release('stage:y');
  assert.equal(r.assets.generation, g2);
  assert.equal(seen.length, 1);
});

test('a slot held by a cancelled load is given back: the next group still loads at full concurrency', async () => {
  const r = rig({ config: { ...ART_CONFIG, loader: { ...ART_CONFIG.loader, concurrency: 3 } } });
  r.assets.load('stage:x');
  await settle();
  assert.equal(r.images.pendingIds().length, 3);
  r.assets.release('stage:x');
  r.images.pending.length = 0;
  const p = r.assets.load('core');
  await settle();
  assert.deepEqual(r.images.pendingIds(), ['logo', 'btn_default', 'btn_focused']);
  await finishAll(r, 'core');
  assert.equal((await p).state, 'ready');
});

test('low priority: a prefetched group starts only when no normal load is queued; a normal load() of it promotes it', async () => {
  const r = rig({ parsed: true, config: { ...ART_CONFIG, loader: { ...ART_CONFIG.loader, concurrency: 2 } } });
  r.assets.prefetch('stage:x');
  await settle();
  assert.deepEqual(r.images.pendingIds(), ['bg_x_far', 'bg_x_mid'], 'nothing else is queued, so it runs');
  const r2 = rig({ parsed: true, config: { ...ART_CONFIG, loader: { ...ART_CONFIG.loader, concurrency: 2 } } });
  const core = r2.assets.load('core');
  r2.assets.prefetch('stage:x');
  await settle();
  assert.deepEqual(r2.images.pendingIds(), ['logo', 'btn_default'], 'core first');
  r2.images.finish('logo');
  r2.images.finish('btn_default');
  await settle();
  assert.deepEqual(r2.images.pendingIds(), ['btn_focused', 'panel'], 'the low group still waits while normal loads are queued');
  // promote: a normal load() of the prefetched group moves its queued images to the front line
  const promoted = r2.assets.load('stage:x');
  await settle();
  assert.equal(r2.assets.status().groups['stage:x'].state, 'loading');
  for (let guard = 0; guard < 40 && r2.images.pending.length > 0; guard++) {
    r2.images.finish();
    await settle();
  }
  assert.equal((await core).state, 'ready');
  assert.equal((await promoted).state, 'ready');
  const order = r2.images.requested;
  assert.ok(order.indexOf('bg_x_far') < order.indexOf('fruit'), `the promoted group jumped ahead of the last core image: ${order}`);
});

// ------------------------------------------------------------------------------------------------------------------ scaled

async function loaded(o = {}) {
  const r = rig(o);
  const p = r.assets.load('core');
  await finishAll(r, 'core');
  await p;
  return r;
}

test('scaled: contain fits the content box into the box, canvas size is ceil(size * density), the result is cached and has a stable identity', async () => {
  const r = await loaded();
  const s = r.assets.scaled('logo', 200, 200, 1); // content box 396 x 190
  assert.equal(s.w, 200);
  assert.ok(Math.abs(s.h - 190 * (200 / 396)) < 1e-9);
  assert.equal(s.density, 1);
  assert.equal(s.canvas.width, 200);
  assert.equal(s.canvas.height, Math.ceil(190 * (200 / 396)));
  assert.equal(r.assets.scaled('logo', 200, 200, 1), s, 'cached: the same object');
  const d2 = r.assets.scaled('logo', 200, 200, 2);
  assert.equal(d2.canvas.width, 400);
  assert.notEqual(d2, s);
  const st = r.assets.scaled('logo', 100, 60, 1, { fit: 'stretch' });
  assert.deepEqual([st.w, st.h, st.canvas.width, st.canvas.height], [100, 60, 100, 60]);
  assert.ok(Object.isFrozen(s));
  // it draws exactly the content box of the image
  const call = s.canvas.getContext('2d').calls.find((c) => c[0] === 'drawImage');
  assert.deepEqual(call.slice(2), [2, 4, 396, 190, 0, 0, 200, s.canvas.height]);
  // 84 * 2 is 168, not 169 (a float residue must not add a pixel)
  const eps = r.assets.scaled('fruit', 84 * 1.0000000000000002, 84, 2);
  assert.ok(eps.canvas.width <= 169);
});

test('scaled: a reduction of more than 2x is done in halving steps (never a one-shot drawImage from 512 down to 100)', async () => {
  const r = await loaded();
  const before = r.canvases.created.length;
  const s = r.assets.scaled('fruit', 60, 60, 1); // content box 365 x 385 -> about 57 x 60: a 6x reduction
  const made = r.canvases.created.slice(before);
  assert.equal(made[0], s.canvas, 'the target canvas is made first');
  const steps = made.slice(1);
  assert.ok(steps.length >= 2, `intermediate canvases were made (${steps.length})`);
  const widths = steps.map((c) => c.width);
  for (let i = 1; i < widths.length; i++) assert.ok(widths[i] < widths[i - 1], `each step is smaller: ${widths}`);
  for (const c of made) {
    for (const call of c.getContext('2d').calls.filter((k) => k[0] === 'drawImage')) {
      assert.ok(call[4] <= 2 * call[8] + 1 && call[5] <= 2 * call[9] + 1, `no step shrinks by more than 2x: ${call.slice(2)}`);
    }
  }
  assert.equal(s.canvas.getContext('2d').imageSmoothingQuality, 'high');
});

test('scaled: null for an id that is not loaded, without a canvas factory, and for a box that is not a positive number', async () => {
  const r = await loaded();
  assert.equal(r.assets.scaled('bg_x_far', 100, 100), null, 'not loaded');
  assert.equal(r.assets.scaled('nope', 100, 100), null);
  for (const bad of [0, -5, NaN, undefined]) assert.equal(r.assets.scaled('logo', bad, 100), null, String(bad));
  assert.equal(r.assets.scaled('logo', 100, 100, 0), null);
  const noCanvas = await loaded({ noCanvas: true });
  assert.equal(noCanvas.assets.scaled('logo', 100, 100), null);
  assert.equal(noCanvas.assets.sliced('btn_default', 300, 100), null);
});

test('scaled cache: at most scaledCacheMaxEntries entries and scaledCacheMaxBytes bytes, least recently used first; release purges the entries of the released ids', async () => {
  const r = await loaded({ config: { ...ART_CONFIG, loader: { ...ART_CONFIG.loader, scaledCacheMaxEntries: 3, scaledCacheMaxBytes: 1e9 } } });
  const a = r.assets.scaled('logo', 10, 10);
  r.assets.scaled('logo', 11, 11);
  r.assets.scaled('logo', 12, 12);
  assert.equal(r.assets.scaled('logo', 10, 10), a, 'still cached (and now the most recent)');
  r.assets.scaled('logo', 13, 13); // evicts 11
  assert.equal(r.assets.scaled('logo', 10, 10), a);
  assert.notEqual(r.assets.scaled('logo', 11, 11), undefined);
  assert.equal(r.assets._stats.cacheEntries, 3);
  const bytes = await loaded({ config: { ...ART_CONFIG, loader: { ...ART_CONFIG.loader, scaledCacheMaxEntries: 100, scaledCacheMaxBytes: 4 * 100 * 100 * 2.5 } } });
  bytes.assets.scaled('fruit', 100, 100);
  bytes.assets.scaled('fruit', 100, 101);
  bytes.assets.scaled('fruit', 100, 102);
  assert.ok(bytes.assets._stats.cacheBytes <= 4 * 100 * 100 * 2.5, `${bytes.assets._stats.cacheBytes}`);
  assert.ok(bytes.assets._stats.cacheEntries < 3);
  // release purge (stage layers are not scaled by the game, but the rule holds for every id)
  const r2 = rig();
  const p = r2.assets.load('stage:x');
  await finishAll(r2, 'stage:x');
  await p;
  const layer = r2.assets.scaled('bg_x_mid', 200, 100);
  assert.ok(layer);
  assert.equal(r2.assets._stats.cacheEntries, 1);
  r2.assets.release('stage:x');
  assert.equal(r2.assets._stats.cacheEntries, 0);
  assert.equal(r2.assets.scaled('bg_x_mid', 200, 100), null);
});

// ------------------------------------------------------------------------------------------------------------------ sliced

test('sliced (three-slice): the frame height sets the scale, a state with a halo comes out bigger about the same centre, caps are drawn 1:1 and the middle is stretched', async () => {
  const r = await loaded();
  const ref = r.assets.sliced('btn_default', 600, 96, 1); // content box 834 x 256: s = 96 / 256
  assert.ok(Math.abs(ref.h - 96) < 1e-9);
  assert.equal(ref.w, 600);
  assert.equal(ref.canvas.width, 600);
  assert.equal(ref.canvas.height, 96);
  const s = 96 / 256;
  const foc = r.assets.sliced('btn_focused', 600, 96, 1); // the same call with the default's frame size: the focused picture is larger by its halo
  assert.ok(Math.abs(foc.h - 275 * s) < 1e-9, `${foc.h}`);
  assert.ok(Math.abs(foc.w - 600) < 1e-9, 'same width: both boxes are 834 wide');
  const calls = ref.canvas.getContext('2d').calls.filter((c) => c[0] === 'drawImage');
  assert.equal(calls.length, 3, 'left cap, middle, right cap');
  const capPx = Math.round(190 * s);
  // destination rectangles (a source that is reduced by more than 2x goes through an intermediate canvas, so the source rectangle is not asserted)
  assert.deepEqual(calls[0].slice(6), [0, 0, capPx, 96]);
  assert.deepEqual(calls[1].slice(6), [capPx, 0, 600 - 2 * capPx, 96]);
  assert.deepEqual(calls[2].slice(6), [600 - capPx, 0, capPx, 96]);
  assert.equal(r.assets.sliced('btn_default', 600, 96, 1), ref, 'cached');
  const d2 = r.assets.sliced('btn_default', 600, 96, 2);
  assert.equal(d2.canvas.width, 1200);
});

test('sliced (three-slice): when the frame is narrower than the two caps they shrink together and still fill the canvas', async () => {
  const r = await loaded();
  const tiny = r.assets.sliced('btn_default', 100, 96, 1); // caps would need 2 * 71 = 142 px
  const calls = tiny.canvas.getContext('2d').calls.filter((c) => c[0] === 'drawImage');
  const drawn = calls.map((c) => [c[6], c[8]]);
  assert.equal(drawn.at(-1)[0] + drawn.at(-1)[1], 100, 'the last piece ends at the right edge');
  assert.ok(drawn.every(([, w]) => w >= 0));
  assert.equal(calls.length <= 3, true);
  assert.equal(tiny.canvas.width, 100);
});

test('sliced (nine-slice): scale 0.5 from the metadata, corners 24 logical px, the size is the requested one, missing slice data gives null', async () => {
  const r = await loaded();
  const p = r.assets.sliced('panel', 880, 660, 2);
  assert.equal(p.w, 880 + (510 - 510) * 0.5);
  assert.equal(p.h, 660);
  assert.equal(p.canvas.width, 1760);
  assert.equal(p.canvas.height, 1320);
  const calls = p.canvas.getContext('2d').calls.filter((c) => c[0] === 'drawImage');
  assert.equal(calls.length, 9);
  const corner = calls.find((c) => c[6] === 0 && c[7] === 0);
  assert.deepEqual(corner.slice(2), [1, 1, 48, 48, 0, 0, 48, 48], 'a 48 px source corner drawn at 24 logical px x density 2 = 48 px');
  assert.equal(calls.filter((c) => c[8] === 48 && c[9] === 48).length, 4, 'four corners');
  // the nine pieces tile the canvas exactly
  const area = calls.reduce((a, c) => a + c[8] * c[9], 0);
  assert.equal(area, 1760 * 1320);
  assert.equal(r.assets.sliced('fruit', 100, 100), null, 'no slice metadata');
  assert.equal(r.assets.sliced('logo', 100, 100), null);
});

// ------------------------------------------------------------------------------------------------------------------ the bitmap route

test('bitmap route: with createBitmap the files are fetched and decoded into ImageBitmaps (no <img> element), and release closes them', async () => {
  const manifest = makeManifest();
  const r = rig({ manifest, fetch: { blobs: true, blobsImmediate: true }, bitmaps: {}, parsed: true });
  const p = r.assets.load('stage:x');
  await settle();
  const res = await p;
  assert.equal(res.state, 'ready');
  assert.equal(r.images.log.created, 0, 'no image element was made');
  assert.deepEqual(r.fetch.calls.filter((u) => !u.endsWith('manifest.json')), ['/assets/backgrounds/bg_x_far.jpg', '/assets/backgrounds/bg_x_mid.png', '/assets/backgrounds/bg_x_near.png']);
  const far = r.assets.get('bg_x_far');
  assert.equal(far.width, 2560);
  assert.equal(far.closed, false);
  r.assets.release('stage:x');
  assert.equal(far.closed, true, 'the pixels are released at once');
  assert.equal(r.bitmaps.made.every((b) => b.closed), true);
  assert.equal(r.assets.has('bg_x_far'), false);
});

test('bitmap route: a 404, a decode error and a wrong size fail that image only, and the rejected bitmap of a wrong size is closed', async () => {
  const r = rig({ fetch: { blobs: true, blobsImmediate: true }, bitmaps: { failIds: ['bg_x_mid'], sizes: { bg_x_near: [10, 10] } }, parsed: true });
  const res = await r.assets.load('stage:x');
  assert.deepEqual(res, { group: 'stage:x', state: 'partial', loaded: 1, failed: 2, total: 3 });
  assert.equal(r.assets.has('bg_x_far'), true);
  assert.equal(r.assets.has('bg_x_mid'), false);
  assert.equal(r.assets.has('bg_x_near'), false);
  assert.equal(r.bitmaps.made.find((b) => b.id === 'bg_x_near').closed, true);
  const r2 = rig({ fetch: { blobs: false }, bitmaps: {}, parsed: true });
  assert.equal((await r2.assets.load('stage:x')).state, 'failed', 'every file answers 404');
});

test('bitmap route: a group released while its files are still on the way never keeps a bitmap, and the abort signal is used', async () => {
  const r = rig({ fetch: { blobs: true }, bitmaps: {}, parsed: true });
  const p = r.assets.load('stage:x');
  await settle();
  assert.equal(r.fetch.pendingBlobs.length, 3);
  const first = r.fetch.pendingBlobs[0];
  assert.ok(first.signal, 'fetch is given an AbortSignal');
  r.assets.release('stage:x');
  assert.equal(first.signal.aborted, true);
  assert.equal((await p).state, 'released');
  // the answer of an aborted request arrives anyway (a fake fetch does not abort): the bitmap is closed, not stored
  first.resolve();
  await settle();
  assert.equal(r.assets.has('bg_x_far'), false);
  assert.equal(r.bitmaps.made.every((b) => b.closed) || r.bitmaps.made.length === 0, true);
});

test('dispose: later loads are disabled, timers and requests are cancelled, bitmaps closed, listeners removed', async () => {
  const r = rig({ fetch: { blobs: true, blobsImmediate: true }, bitmaps: {}, parsed: true });
  await r.assets.load('stage:x');
  let events = 0;
  r.assets.on('group', () => { events++; });
  r.assets.dispose();
  assert.equal(r.bitmaps.made.every((b) => b.closed), true);
  assert.equal(r.assets.has('bg_x_far'), false);
  assert.equal((await r.assets.load('core')).state, 'disabled');
  assert.equal(r.assets.scaled('bg_x_far', 10, 10), null);
  r.assets.dispose(); // twice is fine
  assert.equal(events, 0);
  const r2 = rig();
  r2.assets.load('core');
  await settle();
  const pending = r2.images.pendingIds().length;
  assert.ok(pending > 0);
  r2.assets.dispose();
  assert.equal(r2.timers.pending(), 0);
});
