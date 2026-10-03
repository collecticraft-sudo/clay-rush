// The art layer inside the whole app (public/js/app.js, docs/assets-integration.md 6.3): the loader is created from the environment, group `core`
// is preloaded behind the boot screen for at most `bootWaitMs` of real time, the night stage follows, `?assets=0` and a missing environment mean the
// procedural game, and nothing the loader does can stop the game from reaching the menu. Node, manual clock, fake canvas, stub loaders.
// It says nothing about the physical Joy-Con (UNVERIFIED-ON-HARDWARE).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../../public/js/app.js';
import { NULL_ASSETS } from '../../public/js/render/assets.js';
import { ART_CONFIG } from '../../public/js/render/art-config.js';
import { parseFlags } from '../../public/js/flags.js';
import { FakeCanvas, FakeWindow, createFakeCanvasFactory } from '../../test-support/render/fake-canvas.js';
import { FakeDocument } from '../../test-support/input/fake-dom.js';
import { memoryBackend } from '../../test-support/ui/fixtures.js';
import { silentConsole } from '../../test-support/app/harness.js';
import { createArtStub } from '../../test-support/ui/art-stub.js';
import { createFakeFetch, createFakeImages, makeManifest, settle } from '../../test-support/assets/loader-rig.js';

const FLAGS = '?input=sim&clock=manual&skipsafety=1&mute=1&seed=1';

/** Timers the test controls: the boot wait (bootWaitMs) is captured, everything else is real. */
function bootTimers() {
  const waits = [];
  return {
    waits,
    setTimeout(fn, ms) {
      if (ms === ART_CONFIG.loader.bootWaitMs) {
        const w = { fn, ms, cleared: false };
        waits.push(w);
        return w;
      }
      return globalThis.setTimeout(fn, ms);
    },
    clearTimeout(id) {
      if (id && typeof id === 'object' && 'cleared' in id) id.cleared = true;
      else globalThis.clearTimeout(id);
    },
    fire() {
      for (const w of waits) if (!w.cleared) { w.cleared = true; w.fn(); }
    },
  };
}

/** A stub loader whose `load(group)` promises the test settles by hand. */
function controllableAssets() {
  const stub = createArtStub();
  const calls = [];
  const pending = new Map();
  stub.load = (group, opts) => {
    calls.push([group, opts?.priority ?? 'normal']);
    return new Promise((resolve) => pending.set(group, resolve));
  };
  stub.calls = calls;
  /** What the APP asked for (normal priority); the stage asks for the night stage on its own, at low priority, when it draws. */
  stub.appCalls = () => calls.filter((c) => c[1] === 'normal');
  stub.settle = (group, state = 'ready') => {
    const total = group === 'core' ? 90 : 3;
    pending.get(group)?.({ group, state, loaded: state === 'failed' ? 0 : total, failed: state === 'failed' ? total : 0, total });
  };
  stub.disposed = 0;
  stub.dispose = () => { stub.disposed++; };
  return stub;
}

function bootApp(search, env = {}) {
  const canvas = new FakeCanvas();
  const win = env.window ?? new FakeWindow();
  const factory = createFakeCanvasFactory();
  const console = silentConsole();
  const app = createApp({
    window: win, document: new FakeDocument(), canvas, search, createCanvas: factory.createCanvas, requestAnimationFrame: null,
    storageBackend: memoryBackend(), localStorage: null, console, ...env,
  });
  return { app, canvas, win, console, factory };
}

/** The loading bar is a thin fillRect along the bottom edge of the playfield (y 1074, 6 px high) and has no text. */
const barRects = (h) => h.canvas.ctx.calls.filter((c) => c[0] === 'fillRect' && c[2] === 1074 && c[4] === 6);

// ------------------------------------------------------------------------------------------------------------------ flags

test('flags: ?assets=0, off, false and no switch the art off; 1, on and no flag leave it on; anything else is ignored with a warning', () => {
  assert.equal(parseFlags('').assets, true);
  for (const v of ['0', 'off', 'OFF', 'false', 'no']) assert.equal(parseFlags(`?assets=${v}`).assets, false, v);
  for (const v of ['1', 'on', 'true', 'yes', '']) assert.equal(parseFlags(`?assets=${v}`).assets, true, `"${v}"`);
  const bad = parseFlags('?assets=maybe');
  assert.equal(bad.assets, true);
  assert.equal(bad.warnings.length, 1);
  assert.match(bad.warnings[0], /\?assets=maybe ignored/);
});

// ------------------------------------------------------------------------------------------------------------------ no art

test('without a way to make images (Node, tests) the app has the null assets and boots synchronously, exactly as before the art existed', () => {
  const h = bootApp(FLAGS);
  const ready = h.app.start();
  assert.equal(h.app.assets, NULL_ASSETS);
  // no await: the menu is already there
  assert.equal(h.app.clay.getUiState().screen, 'menu');
  const a = h.app.clay.getAssets();
  assert.equal(a.enabled, false);
  assert.equal(a.manifest, 'idle');
  assert.deepEqual(a.groups, {});
  assert.equal(a.world.layers.far, false, 'the world draws its procedural backdrop');
  assert.equal(h.app.presentation.debug.assets, NULL_ASSETS);
  assert.ok(ready instanceof Promise);
  h.app.dispose();
});

test('?assets=0 keeps the null assets even when a loader is injected, and the loader is never asked for anything', async () => {
  const stub = controllableAssets();
  const h = bootApp(`${FLAGS}&assets=0`, { assets: stub });
  await h.app.start();
  assert.equal(h.app.assets, NULL_ASSETS);
  assert.equal(stub.calls.length, 0);
  assert.equal(h.app.clay.getAssets().enabled, false);
  assert.equal(h.app.clay.getUiState().screen, 'menu');
  h.app.dispose();
});

test('env.assets = null means no art too', async () => {
  const h = bootApp(FLAGS, { assets: null });
  await h.app.start();
  assert.equal(h.app.assets, NULL_ASSETS);
  h.app.dispose();
});

// ------------------------------------------------------------------------------------------------------------------ boot with art

test('with a loader the boot screen stays until group core is done; then the UI gets `ready` and __clay.ready resolves; the world asks for its stage itself', async () => {
  const stub = controllableAssets();
  const timers = bootTimers();
  const h = bootApp(FLAGS, { assets: stub, timers });
  let resolved = false;
  const ready = h.app.start().then(() => { resolved = true; });
  assert.equal(h.app.assets, stub);
  assert.equal(h.app.clay.getUiState().screen, 'boot', 'the boot screen is up while core loads');
  assert.throws(() => h.app.clay.start('classic'), /after `await __clay.ready`/);
  assert.deepEqual(stub.calls, [['core', 'normal']], 'only core, at boot');
  assert.equal(timers.waits.length, 1, 'one boot wait of bootWaitMs');
  await settle();
  assert.equal(resolved, false);
  h.app.step(); // frames run during the boot screen without harm
  h.app.presentation.draw();
  assert.equal(h.app.clay.getUiState().screen, 'boot');
  stub.settle('core');
  await ready;
  assert.equal(h.app.clay.getUiState().screen, 'menu');
  assert.equal(timers.waits[0].cleared, true, 'the wait timer is cleared when core finishes first');
  await settle();
  assert.deepEqual(stub.calls[0], ['core', 'normal'], 'the app asks for core only');
  assert.ok(stub.calls.slice(1).every(([g]) => /^stage:(meadow|hills|alpine)$/.test(g)), 'everything else is a stage group of the world renderer');
  const a = h.app.clay.getAssets();
  assert.equal(a.enabled, true);
  assert.ok(a.groups.core);
  assert.equal(typeof a.world.stage, 'string', 'the world renderer reports its stage');
  h.app.clay.start('classic'); // the API is open now
  assert.equal(h.app.clay.snapshot().mode, 'classic');
  h.app.dispose();
});

test('the boot wait is capped: with core still loading the game starts anyway, a thin loading bar shows at the bottom edge, and it goes away when core finishes', async () => {
  const stub = controllableAssets();
  const timers = bootTimers();
  const h = bootApp(FLAGS, { assets: stub, timers });
  const ready = h.app.start();
  assert.equal(h.app.clay.getUiState().screen, 'boot');
  timers.fire();
  await ready;
  assert.equal(h.app.clay.getUiState().screen, 'menu', 'the timeout starts the game');
  assert.deepEqual(stub.calls[0], ['core', 'normal']);
  h.app.clay.advance(100);
  h.canvas.ctx.reset();
  h.app.presentation.draw();
  assert.ok(barRects(h).length >= 2, 'the loading bar (track and marker) is drawn over the menu');
  assert.equal(h.canvas.ctx.texts.some((t) => t.text === 'Loading…'), false, 'the bar needs no text');
  // core finishes later: the bar goes, the night stage loads
  stub.settle('core');
  await settle();
  h.canvas.ctx.reset();
  h.app.presentation.draw();
  assert.equal(barRects(h).length, 0, 'no bar once core is done');
  h.app.dispose();
});

test('a failed core group (state failed) still starts the game; a loader whose load() throws or rejects cannot stop the boot', async () => {
  const failed = controllableAssets();
  const h1 = bootApp(FLAGS, { assets: failed });
  const r1 = h1.app.start();
  failed.settle('core', 'failed');
  await r1;
  assert.equal(h1.app.clay.getUiState().screen, 'menu');
  h1.app.dispose();

  const throwing = createArtStub();
  throwing.load = () => { throw new Error('load exploded'); };
  const h2 = bootApp(FLAGS, { assets: throwing });
  await h2.app.start();
  assert.equal(h2.app.clay.getUiState().screen, 'menu');
  assert.ok(h2.app.getLog().some((l) => l.level === 'warn' && /art: load failed: load exploded/.test(l.message)));
  h2.app.dispose();

  const rejecting = createArtStub();
  rejecting.load = () => Promise.reject(new Error('nope'));
  const h3 = bootApp(FLAGS, { assets: rejecting });
  await h3.app.start();
  assert.equal(h3.app.clay.getUiState().screen, 'menu');
  h3.app.dispose();
});

test('the game is fully playable while the art is missing: a round runs on the procedural drawing with a loader that never loads anything', async () => {
  const stub = createArtStub({ only: [] }); // has() is false for everything
  stub.load = async (group) => ({ group, state: 'failed', loaded: 0, failed: 1, total: 1 });
  const h = bootApp(FLAGS, { assets: stub });
  await h.app.start();
  h.app.clay.start('classic', { seed: 3 });
  h.app.clay.advance(1500);
  h.app.presentation.draw();
  assert.equal(h.app.clay.getUiState().screen, 'playing');
  assert.equal(h.canvas.ctx.forbidden.length, 0, 'no shadowBlur or filter');
  assert.deepEqual(h.console.lines.filter(([level]) => level === 'error'), []);
  h.app.dispose();
});

// ------------------------------------------------------------------------------------------------------------------ the real loader from the environment

test('the app builds the real loader from env.createImage and env.assetFetch (not env.fetch, which belongs to the native bridge) and disposes it with the app', async () => {
  const manifest = makeManifest();
  const images = createFakeImages(manifest);
  const assetFetch = createFakeFetch(manifest);
  const bridgeFetch = () => Promise.resolve({ ok: true, json: async () => ({ available: false, reason: 'none' }) });
  const timers = bootTimers();
  const h = bootApp(FLAGS, { createImage: images.createImage, assetFetch, fetch: bridgeFetch, timers });
  const ready = h.app.start();
  assert.equal(h.app.assets.isNull, false, 'a real loader');
  await settle();
  assert.equal(assetFetch.calls.length, 1, 'the manifest came through assetFetch');
  assert.match(assetFetch.calls[0], /manifest\.json$/);
  assert.ok(images.pendingIds().length > 0, 'images are being loaded');
  // the fake manifest has its own group names, so `core` is the one of the rig: finish its images
  for (let i = 0; i < 20 && images.pending.length; i++) { images.finish(); await settle(); }
  await ready;
  assert.equal(h.app.clay.getUiState().screen, 'menu');
  assert.equal(h.app.clay.getAssets().enabled, true);
  assert.equal(h.app.clay.getAssets().manifest, 'ready');
  assert.equal(h.app.clay.getAssets().groups.core.state, 'ready');
  h.app.dispose();
  assert.equal((await h.app.assets.load('core')).state, 'disabled', 'dispose() disposed the loader the app made');
});

test('an injected loader is not disposed by the app (the caller owns it)', async () => {
  const stub = controllableAssets();
  const h = bootApp(FLAGS, { assets: stub });
  const ready = h.app.start();
  stub.settle('core');
  await ready;
  h.app.dispose();
  assert.equal(stub.disposed, 0);
});

test('a failed manifest (the loader is real, the server answers 404) still boots to the menu on the procedural drawing', async () => {
  const manifest = makeManifest();
  const images = createFakeImages(manifest);
  const assetFetch = createFakeFetch(manifest, { manifestStatus: 404 });
  const h = bootApp(FLAGS, { createImage: images.createImage, assetFetch, timers: bootTimers() });
  await h.app.start();
  assert.equal(h.app.clay.getUiState().screen, 'menu');
  assert.equal(h.app.clay.getAssets().manifest, 'failed');
  h.app.clay.start('zen', { seed: 2 });
  h.app.clay.advance(500);
  h.app.presentation.draw();
  assert.equal(h.app.clay.snapshot().screen, 'playing');
  assert.equal(h.app.clay.debug.getWorld().layers.far, false, 'the painted background is used');
  h.app.dispose();
});
