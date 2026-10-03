// presentation-core.js (the facade of docs/architecture.md 8.1) with a stub world renderer, HUD and audio: events forwarding, stage choice,
// world view flags, frozen time, drawing every screen and overlay, pointer listeners, fallbacks. The real presentation.js is exercised at the
// end with the real render/world.js and render/hud.js when they exist.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createManualClock } from '../../public/js/shared/clock.js';
import { SCREEN } from '../../public/js/shared/contracts.js';
import { createPresentationCore } from '../../public/js/ui/presentation-core.js';
import { createStorage } from '../../public/js/ui/storage.js';
import { UI_TIMING } from '../../public/js/ui/ui.js';
import { FakeCanvas, createFakeAudio, createFakeCanvas, createFakeHud, createFakeWorld } from '../../test-support/ui/fakes.js';
import { calFact, hitEvent, makeSnapshot, memoryBackend, practiceEvent, providerFact, roundResult, shotEvent } from '../../test-support/ui/fixtures.js';

function rig(opts = {}) {
  const clock = createManualClock(0);
  const canvas = new FakeCanvas();
  const world = createFakeWorld();
  const hud = createFakeHud();
  const audio = createFakeAudio();
  const storage = createStorage({ backend: memoryBackend(), matchMedia: () => ({ matches: false }) });
  storage.setSafetyAck();
  const p = createPresentationCore({ canvas, clock, storage, audio, createCanvas: createFakeCanvas, ...opts.deps }, {
    createWorldRenderer: opts.worldFactory ?? (() => world), createHud: opts.hudFactory ?? (() => hud),
  });
  const intents = [];
  p.ui.onIntent((i) => intents.push(i));
  let snapshot = null;
  const r = {
    p, clock, canvas, world, hud, audio, storage, intents,
    setSnapshot(s) { snapshot = s; },
    frame(over = {}) {
      clock.advance(16);
      p.step({ nowMs: clock.now(), dtS: 0.016, snapshot, events: [], aim: { x: 700, y: 400, visible: true, trackingOk: true }, debug: false, ...over });
      p.draw();
    },
    frames(n, over) { for (let i = 0; i < n; i++) r.frame(over); },
    view: () => p.ui.getView(),
    state: () => p.ui.getState(),
    lastUpdate: () => world.calls.update.at(-1),
  };
  p.ui.notify(providerFact('sim', 'streaming'));
  p.ui.notify({ type: 'ready' });
  r.frame();
  return r;
}

test('the facade has the shape of 8.1', () => {
  const { p } = rig();
  for (const k of ['ui', 'step', 'draw', 'resize', 'getPerf', 'setArtLoading', 'audio', 'storage', 'dispose', 'debug']) assert.ok(k in p, k);
  for (const k of ['onIntent', 'notify', 'getState', 'force', 'getView', 'pointerClick', 'pointerMove', 'activate', 'getTargets']) assert.equal(typeof p.ui[k], 'function', k);
  assert.deepEqual(Object.keys(p.ui.getState()).sort(), ['calibrationStep', 'gameActive', 'overlay', 'resuming', 'roundMode', 'screen', 'systemCursor']);
});

test('step forwards the GameEvents to the world renderer, the HUD and audio.handleGameEvent', () => {
  const r = rig();
  r.p.ui.force('playing', { roundMode: 'classic' });
  r.setSnapshot(makeSnapshot());
  const events = [shotEvent(), hitEvent()];
  r.frame({ events });
  assert.deepEqual(r.world.calls.handleEvents.at(-1).events.map((e) => e.type), ['shot', 'hit']);
  assert.deepEqual(r.hud.calls.handleEvents.at(-1).map((e) => e.type), ['shot', 'hit']);
  assert.deepEqual(r.audio.rec.events.slice(-2), ['shot', 'hit']);
});

test('the stage: hills behind the menus, the chosen stage on setup (meadow for Classic), the round\'s in play', () => {
  const r = rig();
  assert.equal(r.p.debug.getStageId(), 'hills');
  r.p.ui.activate('menu.timeattack');
  r.p.ui.activate('setup.stage.opt.alpine');
  r.frame();
  assert.equal(r.p.debug.getStageId(), 'alpine');
  assert.equal(r.world.calls.setStage.at(-1), 'alpine');
  r.p.ui.activate('setup.back');
  r.p.ui.activate('menu.classic');
  r.frame();
  assert.equal(r.p.debug.getStageId(), 'meadow');
  r.p.ui.activate('setup.start');
  r.frame();
  assert.equal(r.p.debug.getStageId(), 'meadow', 'countdown: the stage of the round');
  r.setSnapshot(makeSnapshot({ stage: { index: 1, id: 'hills', count: 3, name: 'Golden Hills' } }));
  r.frames(Math.ceil((3 * UI_TIMING.countdownNumberMs + UI_TIMING.countdownGoMs) / 16) + 2);
  assert.equal(r.state().screen, SCREEN.PLAYING);
  assert.equal(r.p.debug.getStageId(), 'hills');
  assert.equal(r.audio.rec.updates.at(-1).stageId, 'hills');
});

test('world view: idle behind menus; gun and crosshair in play and in the practice round; frozen time while paused', () => {
  const r = rig();
  let u = r.lastUpdate();
  assert.equal(u.view.idle, true);
  assert.equal(u.view.showGun, false);
  assert.equal(u.view.showCrosshair, false);
  assert.equal(u.view.snapshot, null);
  r.p.ui.force('playing', { roundMode: 'classic' });
  r.setSnapshot(makeSnapshot());
  r.frame();
  u = r.lastUpdate();
  assert.equal(u.view.idle, false);
  assert.equal(u.view.showGun, true);
  assert.equal(u.view.showCrosshair, true);
  assert.equal(u.view.aim.x, 700);
  assert.ok(u.view.snapshot);
  assert.ok(u.dtS > 0);
  assert.deepEqual(Object.keys(u.view.settings).sort(), ['crosshairColor', 'reduceFlash', 'reduceMotion']);
  r.p.ui.notify({ type: 'action', event: { t: 0, action: 'pause', label: 'P', source: 'keyboard' } });
  r.frame();
  u = r.lastUpdate();
  assert.equal(r.state().screen, SCREEN.PAUSED);
  assert.equal(u.dtS, 0, 'frozen');
  assert.equal(u.view.showGun, false);
  r.p.ui.notify(calFact({ type: 'started', quick: false }));
  r.frame();
  assert.equal(r.lastUpdate().view.showGun, false, 'wizard steps 1-3: no gun');
  r.p.ui.notify(calFact({ type: 'done', quick: false, calibration: {}, warnings: [] }));
  r.setSnapshot(makeSnapshot({ mode: 'practice' }));
  r.frame();
  u = r.lastUpdate();
  assert.equal(u.view.showGun, true);
  assert.equal(u.view.showCrosshair, true);
  r.frame({ events: [practiceEvent('hit')] });
  assert.equal(r.state().screen, SCREEN.MENU);
});

test('the HUD draws on playing and paused only, with labels that include fire and the battery level', () => {
  const r = rig();
  r.p.ui.force('playing', { roundMode: 'classic' });
  r.setSnapshot(makeSnapshot({ phase: 'ready' }));
  r.frame();
  const n = r.hud.calls.draw.length;
  assert.ok(n > 0);
  assert.equal(r.hud.calls.draw.at(-1).labels.fire, 'F');
  assert.equal(r.hud.calls.draw.at(-1).battery, 'unknown');
  r.p.ui.force('menu');
  r.setSnapshot(null);
  r.frame();
  assert.equal(r.hud.calls.draw.length, n);
});

test('a new round resets the world and the HUD effects', () => {
  const r = rig();
  const w0 = r.world.calls.reset;
  r.setSnapshot(makeSnapshot({ seed: 1 }));
  r.frame();
  r.setSnapshot(makeSnapshot({ seed: 2 }));
  r.frame();
  assert.equal(r.world.calls.reset, w0 + 2);
  assert.ok(r.hud.calls.reset >= 2);
});

test('every screen and overlay draws without throwing, with no text under 28 px', () => {
  const r = rig();
  const cases = [
    ['boot'], ['safety'], ['connect'], ['calibration', { step: 1 }], ['calibration', { step: 3 }], ['calibration', { step: 4 }], ['menu'],
    ['setup', { mode: 'classic' }], ['setup', { mode: 'timeattack' }], ['setup', { mode: 'zen' }], ['settings'], ['best'], ['tuning'],
    ['countdown', { roundMode: 'classic' }], ['playing', { roundMode: 'classic' }], ['paused', { roundMode: 'zen' }],
    ['results', { roundMode: 'classic', result: roundResult() }], ['results', { roundMode: 'zen', result: roundResult({ mode: 'zen', rank: null, stageId: 'hills' }) }],
  ];
  const errors = [];
  const origError = console.error;
  console.error = (...a) => errors.push(a.join(' '));
  try {
    for (const [screen, opts] of cases) {
      r.p.ui.force(screen, opts ?? {});
      r.setSnapshot(['playing', 'paused', 'countdown'].includes(screen) || (screen === 'calibration' && opts.step === 4) ? makeSnapshot() : null);
      r.canvas.ctx.clearTexts();
      r.frames(3);
      const texts = r.canvas.ctx.texts;
      assert.ok(texts.length > 0 || screen === 'playing', `${screen} drew text`);
      const small = texts.filter((x) => x.size < 28).map((x) => `${x.text} (${x.size}px)`);
      assert.deepEqual(small, [], `${screen}: text under 28 px`);
    }
    // overlays
    r.p.ui.force('settings');
    r.p.ui.activate('set.reset');
    r.canvas.ctx.clearTexts();
    r.frame();
    assert.ok(r.canvas.ctx.texts.some((x) => x.text === 'DELETE ALL BEST SCORES?'));
    assert.ok(r.canvas.ctx.texts.some((x) => x.text === 'Sensitivity'), 'the screen under the dialog still draws');
    r.p.ui.activate('confirm.no');
    r.p.ui.notify(providerFact('sim', 'lost'));
    r.canvas.ctx.clearTexts();
    r.frame();
    assert.ok(r.canvas.ctx.texts.some((x) => x.text === 'JOY-CON DISCONNECTED'));
  } finally {
    console.error = origError;
  }
  assert.deepEqual(errors, []);
});

test('the toast and the hint line are drawn; the menu shows the provider chip', () => {
  const r = rig();
  r.p.ui.notify({ type: 'recentered' });
  r.canvas.ctx.clearTexts();
  r.frame();
  const texts = r.canvas.ctx.texts.map((x) => x.text);
  assert.ok(texts.includes('Aim recentred'));
  assert.ok(texts.includes('Simulator'));
  assert.ok(texts.includes('Select'));
});

test('pointer listeners: a left-button release on the canvas clicks the target under it; the OS cursor hides in play', () => {
  const r = rig();
  assert.equal(r.canvas.style.cursor, 'default');
  const card = r.p.ui.getTargets().find((x) => x.id === 'menu.zen');
  r.canvas.dispatch('pointermove', { clientX: card.x, clientY: card.y });
  assert.equal(r.view().focus.id, 'menu.zen');
  r.canvas.dispatch('pointerdown', { clientX: card.x, clientY: card.y, button: 2 });
  r.canvas.dispatch('pointerup', { clientX: card.x, clientY: card.y, button: 2 });
  assert.equal(r.state().screen, SCREEN.MENU, 'right button ignored');
  r.canvas.dispatch('pointerup', { clientX: card.x, clientY: card.y, button: 0 });
  assert.equal(r.state().screen, SCREEN.MENU, 'a release without its press does not click');
  r.canvas.dispatch('pointerdown', { clientX: card.x, clientY: card.y, button: 0 });
  r.canvas.dispatch('pointerup', { clientX: card.x, clientY: card.y, button: 0 });
  assert.equal(r.state().screen, SCREEN.SETUP);
  r.p.ui.force('playing', { roundMode: 'zen' });
  r.frame();
  assert.equal(r.canvas.style.cursor, 'none');
});

test('intents reach onIntent listeners; visibility suspends the audio and pauses', () => {
  const r = rig();
  let suspended = 0;
  r.audio.suspend = () => { suspended++; };
  r.p.ui.activate('menu.classic');
  r.p.ui.activate('setup.start');
  assert.equal(r.intents.at(-1).type, 'startRound');
  r.frames(Math.ceil((3 * UI_TIMING.countdownNumberMs + UI_TIMING.countdownGoMs) / 16) + 2);
  r.p.ui.notify({ type: 'visibility', hidden: true });
  assert.equal(suspended, 1);
  assert.equal(r.state().screen, SCREEN.PAUSED);
});

test('fallbacks: a world factory that throws gives a plain sky, a missing HUD draws nothing, a throwing audio factory runs silent', () => {
  const errs = [];
  const orig = console.error;
  console.error = (...a) => errs.push(a.join(' '));
  try {
    const r = rig({ worldFactory: () => { throw new Error('boom'); }, hudFactory: null, deps: { audio: undefined } });
    assert.equal(r.p.debug.world.fallback, true);
    r.p.ui.force('playing', { roundMode: 'classic' });
    r.setSnapshot(makeSnapshot());
    r.frames(2);
    assert.ok(r.canvas.ctx.calls.get('fillRect') > 0);
    const clock = createManualClock(0);
    const p = createPresentationCore({ canvas: new FakeCanvas(), clock, createCanvas: createFakeCanvas, storage: createStorage({ backend: memoryBackend() }) }, {
      createAudio: () => { throw new Error('no audio'); },
    });
    assert.equal(typeof p.audio.play, 'function');
    p.step({ nowMs: 16, dtS: 0.016, snapshot: null, events: [] });
    p.draw();
  } finally {
    console.error = orig;
  }
  assert.ok(errs.some((e) => e.includes('world renderer')));
});

test('the volume setting reaches the audio engine; dispose removes the listeners', () => {
  const r = rig();
  assert.equal(r.audio.rec.volume, 0.8);
  r.storage.updateSettings({ volume: 0.3 });
  r.frame();
  assert.equal(r.audio.rec.volume, 0.3);
  r.p.dispose();
  assert.equal((r.canvas.listeners.get('pointerup') ?? []).length, 0);
});

const WORLD_JS = fileURLToPath(new URL('../../public/js/render/world.js', import.meta.url));
test('presentation.js wires the real render/world.js and render/hud.js', { skip: existsSync(WORLD_JS) ? false : 'render/world.js is not there yet' }, async () => {
  const { createPresentation } = await import('../../public/js/ui/presentation.js');
  const clock = createManualClock(0);
  const canvas = new FakeCanvas();
  const p = createPresentation({ canvas, clock, storage: createStorage({ backend: memoryBackend() }), createCanvas: createFakeCanvas, audio: createFakeAudio() });
  assert.notEqual(p.debug.world.fallback, true, 'the real world renderer');
  p.ui.notify(providerFact('sim', 'streaming'));
  for (const s of ['menu', 'playing', 'results']) {
    p.ui.force(s, { roundMode: 'classic' });
    for (let i = 0; i < 3; i++) {
      clock.advance(16);
      p.step({ nowMs: clock.now(), dtS: 0.016, snapshot: s === 'playing' ? makeSnapshot() : null, events: [], aim: { x: 900, y: 500, visible: true, trackingOk: true } });
      p.draw();
    }
  }
  p.dispose();
});
