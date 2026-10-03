// The presentation facade, with its renderer factories injected (docs/architecture.md 8.1). OWNER: UI engineer.
// presentation.js wires the real render/world.js, render/hud.js and audio/audio.js into this; the tests inject fakes (test-support/ui).
//
//   step({nowMs, dtS, snapshot, events, aim:{x, y, visible, trackingOk, speedDps?}, debug})
//        runs the UI state machine, forwards the GameEvents to the world renderer, the HUD and audio.handleGameEvent, chooses the stage
//        (snapshot.stage.id in a round, the chosen stage on the setup screen, 'hills' for the other menus), updates the world and the audio
//        ambience. Never draws.
//   draw()
//        world pass (world.draw; idle mode with a soft dark veil behind the menus; gun and crosshair only in play and calibration step 4,
//        the crosshair also on the tuning screen), HUD on 'playing' / 'paused', then the screen UI, overlays, toast and the hint line.
//
// Everything browser-specific (canvas, document, window, matchMedia, createCanvas, storage, audio) is injected so the logic runs in Node.

import { NULL_ASSETS } from '../render/assets.js';
import { applyPlayfieldTransform, computeLayout, pointerToPlayfield, readCssSize } from './canvas-layout.js';
import { createStorage } from './storage.js';
import { setStrictStrings, t } from './strings.en.js';
import { createUi } from './ui.js';
import { C, clamp01 } from './theme.js';
import { drawDim, drawHintLine, drawToast, drawVeil } from './widgets.js';
import { SCREEN_DRAWERS, drawConfirm, drawDisconnect, drawResumeCountdown } from './screens/index.js';

const NO_AIM = Object.freeze({ x: 960, y: 540, visible: false, trackingOk: false });
const GAME_SCREENS = Object.freeze(['playing', 'paused', 'countdown', 'results']);

/** A world renderer that draws a plain sky (used when render/world.js is missing or throws at creation). */
function createFallbackWorld() {
  let stage = 'hills';
  const SKY = { meadow: ['#7EC4F2', '#CDEBFA', '#5E9A44'], hills: ['#E89A50', '#F8DDA0', '#8E7A33'], alpine: ['#3B3A6B', '#C37A8C', '#2F3B52'] };
  return {
    fallback: true,
    setStage(id) { stage = id; },
    reset() {},
    handleEvents() {},
    update() {},
    draw(ctx) {
      const s = SKY[stage] ?? SKY.hills;
      ctx.fillStyle = s[0];
      ctx.fillRect(0, 0, 1920, 670);
      ctx.fillStyle = s[1];
      ctx.fillRect(0, 470, 1920, 200);
      ctx.fillStyle = s[2];
      ctx.fillRect(0, 670, 1920, 410);
    },
    getDebug: () => ({ particles: 0, stage, layers: { far: false, near: false }, shake: 0, zoom: 1 }),
  };
}

const NULL_HUD = Object.freeze({ reset() {}, handleEvents() {}, update() {}, draw() {} });

/**
 * @param {object} deps  {canvas, clock, storage?, audio?, document?, window?, matchMedia?, createCanvas?, hasBluetooth?, config?, assets?, bestHelpers?}
 * @param {{createWorldRenderer?:Function, createHud?:Function, createAudio?:Function}} factories
 */
export function createPresentationCore(deps, factories = {}) {
  const { canvas, clock } = deps;
  const win = deps.window ?? (typeof window !== 'undefined' ? window : undefined);
  const doc = deps.document ?? win?.document ?? (typeof document !== 'undefined' ? document : undefined);
  const storage = deps.storage ?? createStorage({
    matchMedia: deps.matchMedia ?? (win && typeof win.matchMedia === 'function' ? win.matchMedia.bind(win) : undefined),
    bestHelpers: deps.bestHelpers,
  });
  const log = (level, msg, err) => { if (typeof console !== 'undefined') console[level](`[clay-rush] ${msg}`, err ?? ''); };
  let audio = deps.audio ?? null;
  if (!audio && typeof factories.createAudio === 'function') {
    try {
      audio = factories.createAudio({ clock });
    } catch (err) {
      log('error', 'the audio engine could not be created, the game runs silent', err);
    }
  }
  if (!audio) audio = createSilentAudio();
  const hasBluetooth = deps.hasBluetooth ?? !!win?.navigator?.bluetooth;

  let ctx = null;
  try {
    ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
  } catch {
    ctx = null;
  }
  if (!ctx) ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('createPresentation: the canvas has no 2D context');

  const createCanvas = deps.createCanvas ?? ((w, h) => {
    const c = doc.createElement('canvas');
    c.width = w;
    c.height = h;
    return c;
  });
  const assets = deps.assets && deps.assets.isNull !== true && typeof deps.assets.has === 'function' ? deps.assets : NULL_ASSETS;

  let world = null;
  if (typeof factories.createWorldRenderer === 'function') {
    try {
      world = factories.createWorldRenderer({ assets, createCanvas, config: deps.config });
    } catch (err) {
      log('error', 'the world renderer could not be created, a plain sky is drawn', err);
    }
  }
  if (!world) world = createFallbackWorld();
  let hud = null;
  if (typeof factories.createHud === 'function') {
    try {
      hud = factories.createHud({ assets, createCanvas });
    } catch (err) {
      log('error', 'the HUD could not be created', err);
    }
  }
  if (!hud) hud = NULL_HUD;

  const ui = createUi({
    clock, storage, hasBluetooth,
    sfx: (id, params) => { try { audio.play?.(id, params); } catch { /* audio never breaks the UI */ } },
    sfxStop: (id) => { try { audio.stop?.(id); } catch { /* ignore */ } },
  });

  // ---- art loading bar (app.js tells us when the core art group is still loading after the boot wait)
  let artLoading = false;
  let artFrac = 0;
  const offAssets = [];
  if (assets !== NULL_ASSETS && typeof assets.on === 'function') {
    offAssets.push(assets.on('progress', (p) => { if (p && p.group === 'core' && p.total > 0) artFrac = clamp01((p.loaded + p.failed) / p.total); }));
    offAssets.push(assets.on('group', (r) => { if (r && r.group === 'core') artLoading = false; }));
  }

  // ---- frame state kept between step() and draw()
  const frame = {
    nowMs: 0, dtS: 0, snapshot: null, events: [], aim: NO_AIM, state: ui.getState(), view: ui.getView(), stageId: 'hills', worldView: null, debug: false,
  };
  let currentStage = null;
  let hadSnap = false;
  let lastSeed = null;
  let lastMode = null;
  let lastT = 0;
  let lastVolume = -1;
  let strictOn = false;
  let ema = 0;
  let layout = computeLayout({ cssW: 1920, cssH: 1080, dpr: 1 });
  let rect = { left: 0, top: 0, width: 1920, height: 1080 };
  let lastCursor = null;
  let lastDpr = win?.devicePixelRatio ?? 1;
  const listeners = [];
  const targetMap = { list: null, map: new Map() };
  const baseMap = { list: null, map: new Map() };
  const worldView = {
    nowMs: 0, snapshot: null, stageId: 'hills', aim: { x: 960, y: 540, visible: false }, showGun: false, showCrosshair: false, idle: true,
    settings: { reduceMotion: false, reduceFlash: false, crosshairColor: 'white' },
  };

  function listen(target, type, fn, opts) {
    if (!target || typeof target.addEventListener !== 'function') return;
    target.addEventListener(type, fn, opts);
    listeners.push([target, type, fn, opts]);
  }

  function resize() {
    const { cssW, cssH } = readCssSize(canvas, win);
    const dpr = win?.devicePixelRatio ?? 1;
    lastDpr = dpr;
    layout = computeLayout({ cssW, cssH, dpr });
    if (canvas.width !== layout.pixelW || canvas.height !== layout.pixelH) {
      canvas.width = layout.pixelW;
      canvas.height = layout.pixelH;
    }
    rect = typeof canvas.getBoundingClientRect === 'function' ? canvas.getBoundingClientRect() : { left: 0, top: 0, width: cssW, height: cssH };
  }

  // ---- pointer (the DOM mouse; the Joy-Con pointer never selects menu items, C-07) and audio unlock
  const toField = (e) => pointerToPlayfield(rect, e.clientX, e.clientY);
  listen(canvas, 'pointermove', (e) => { const p = toField(e); ui.pointerMove(p.x, p.y); });
  listen(canvas, 'pointerenter', () => { if (typeof canvas.getBoundingClientRect === 'function') rect = canvas.getBoundingClientRect(); });
  // a click is a press AND a release on the same target of the same screen (F7: the press that breaks the practice clay ends calibration,
  // its release must not click the menu card that appears under the cursor)
  listen(canvas, 'pointerdown', (e) => {
    if (e.button !== undefined && e.button !== 0) return;
    const p = toField(e);
    ui.pointerDown(p.x, p.y);
  });
  listen(canvas, 'pointerup', (e) => {
    if (e.button !== undefined && e.button !== 0) return;
    const p = toField(e);
    ui.pointerUp(p.x, p.y);
  });
  const unlock = () => { try { audio.unlock?.(); } catch { /* ignore */ } };
  listen(win, 'pointerdown', unlock, true);
  listen(win, 'keydown', unlock, true);
  listen(win, 'keydown', (e) => {
    if (e.repeat || e.ctrlKey || e.metaKey || e.altKey || (e.key !== 'm' && e.key !== 'M')) return;
    if (typeof audio.setMuted !== 'function') return;
    audio.setMuted(!audio.muted);
    ui.toast(t(audio.muted ? 'audio.muted' : 'audio.unmuted'), 1500);
  });
  if (win && typeof win.ResizeObserver === 'function') {
    const ro = new win.ResizeObserver(() => resize());
    ro.observe(canvas);
    listeners.push([{ removeEventListener: () => ro.disconnect() }, 'resize', null, undefined]);
  } else {
    listen(win, 'resize', resize);
  }
  resize();

  // ---------------------------------------------------------------- step
  function normalize(input) {
    const a = input.aim;
    return {
      nowMs: Number.isFinite(input.nowMs) ? input.nowMs : clock.now(),
      dtS: Math.min(0.1, Math.max(0, input.dtS ?? 0)),
      snapshot: input.snapshot ?? null,
      events: Array.isArray(input.events) ? input.events : [],
      aim: a && typeof a === 'object' ? a : NO_AIM,
      debug: !!input.debug,
    };
  }

  /** The stage the world shows: the round's while one runs, the chosen one on the setup screen, 'hills' behind the other menus. */
  function pickStage(state, view, snap) {
    const s = state.screen;
    if ((GAME_SCREENS.includes(s) || (s === 'calibration' && state.calibrationStep === 4)) && snap?.stage?.id) return snap.stage.id;
    if (s === 'countdown') return view.countdown.stage;
    if (s === 'results') return currentStage ?? 'hills';
    if (s === 'setup') return view.setup.mode === 'classic' ? 'meadow' : view.setup.stage;
    return 'hills';
  }

  function step(raw) {
    const input = normalize(raw);
    if ((win?.devicePixelRatio ?? 1) !== lastDpr) resize();
    const settings = storage.getSettings();
    if (settings.volume !== lastVolume) {
      try { audio.setVolume?.(settings.volume); } catch { /* ignore */ }
      lastVolume = settings.volume;
    }
    if (input.debug && !strictOn) {
      strictOn = true;
      setStrictStrings(true);
    }
    const snap = input.snapshot;
    // a new round: the world and the HUD drop the previous round's effects
    let roundChanged = false;
    if (snap && !hadSnap) roundChanged = true;
    else if (snap && hadSnap && (snap.seed !== lastSeed || snap.mode !== lastMode || snap.t < lastT - 0.25)) roundChanged = true;
    else if (!snap && hadSnap) roundChanged = true;
    hadSnap = !!snap;
    if (snap) { lastSeed = snap.seed; lastMode = snap.mode; lastT = snap.t; }
    if (roundChanged) {
      try { world.reset(); } catch (err) { log('error', 'world.reset failed', err); }
      try { hud.reset(); } catch (err) { log('error', 'hud.reset failed', err); }
    }

    ui.step({ nowMs: input.nowMs, dtS: input.dtS, snapshot: snap, events: input.events, aim: input.aim });
    const state = ui.getState();
    const view = ui.getView();

    const stageId = pickStage(state, view, snap);
    if (stageId !== currentStage) {
      currentStage = stageId;
      try { world.setStage(stageId); } catch (err) { log('error', 'world.setStage failed', err); }
    }

    if (input.events.length) {
      try { world.handleEvents(input.events, input.nowMs); } catch (err) { log('error', 'world.handleEvents failed', err); }
      try { hud.handleEvents(input.events, input.nowMs); } catch (err) { log('error', 'hud.handleEvents failed', err); }
      for (const ev of input.events) {
        try { audio.handleGameEvent?.(ev); } catch { /* ignore */ }
      }
    }

    const s = state.screen;
    const practice = s === 'calibration' && state.calibrationStep === 4;
    const inRound = GAME_SCREENS.includes(s) || practice;
    // results are not frozen: the gun and the crosshair of the last frame must animate away behind the card (F21)
    const frozen = s === 'paused' || state.resuming || state.overlay !== null;
    worldView.nowMs = input.nowMs;
    worldView.snapshot = inRound ? snap : null;
    worldView.stageId = stageId;
    worldView.aim.x = input.aim.x;
    worldView.aim.y = input.aim.y;
    worldView.aim.visible = input.aim.visible === true;
    worldView.showGun = (s === 'playing' || practice) && state.overlay === null;
    worldView.showCrosshair = (s === 'playing' || practice) && state.overlay === null && !(s === 'playing' && state.resuming);
    worldView.idle = !inRound;
    worldView.settings.reduceMotion = settings.reduceMotion;
    worldView.settings.reduceFlash = settings.reduceFlash;
    worldView.settings.crosshairColor = settings.crosshairColor;
    try { world.update(frozen ? 0 : input.dtS, worldView); } catch (err) { log('error', 'world.update failed', err); }
    try { hud.update(frozen ? 0 : input.dtS); } catch (err) { log('error', 'hud.update failed', err); }
    try { audio.update?.(input.dtS, { screen: s, stageId, snapshot: snap, paused: frozen }); } catch { /* ignore */ }

    const cursor = state.systemCursor ? 'default' : 'none';
    if (cursor !== lastCursor && canvas.style) {
      canvas.style.cursor = cursor;
      lastCursor = cursor;
    }
    const dtMs = input.dtS * 1000;
    if (dtMs > 0) ema = ema ? ema * 0.92 + dtMs * 0.08 : dtMs;

    frame.nowMs = input.nowMs;
    frame.dtS = input.dtS;
    frame.snapshot = snap;
    frame.events = input.events;
    frame.aim = input.aim;
    frame.state = state;
    frame.view = view;
    frame.stageId = stageId;
    frame.worldView = worldView;
    frame.debug = input.debug;
  }

  // ---------------------------------------------------------------- HUD texts
  // The HUD asks for its texts through hv.t with the keys of 8.5. Two of them depend on things the HUD does not know (F11, F18): outside
  // Classic there is no "STAGE n" (Zen and Time Attack play one stage), and the mouse's trigger is a click, not a key. One translator per
  // round mode, created once, so the HUD's string memo (keyed by the function) stays valid frame after frame.
  const hudTranslators = new Map();
  function hudTranslator(mode) {
    let fn = hudTranslators.get(mode);
    if (!fn) {
      fn = (key, params) => {
        if (key === 'hud.stage' && mode === 'zen') return t('hud.zenStage', params);
        if (key === 'hud.stage' && mode === 'timeattack') return t('hud.timeAttackStage', params);
        if (key === 'hud.pullPrompt' && typeof params?.fire === 'string' && /click/i.test(params.fire)) return t('hud.pullPromptClick');
        return t(key, params);
      };
      hudTranslators.set(mode, fn);
    }
    return fn;
  }

  // ---------------------------------------------------------------- draw
  function lookup(cache, list) {
    if (cache.list !== list) {
      cache.map.clear();
      for (const tg of list ?? []) cache.map.set(tg.id, tg);
      cache.list = list;
    }
    return cache.map;
  }

  const g = {
    ctx, v: frame.view, assets, density: 1, nowMs: 0,
    target: (id) => lookup(targetMap, g.v.targets).get(id) ?? lookup(baseMap, g.v.baseTargets).get(id) ?? null,
    focused: (id) => g.v.focus.id !== null && g.v.focus.valueRow === null && g.v.focus.ids.includes(id),
    pressed: (id) => g.v.pressedId === id,
  };

  function drawArtBar() {
    if (!artLoading || frame.state.screen === 'boot') return;
    ctx.fillStyle = 'rgba(16,19,24,0.4)';
    ctx.fillRect(0, 1074, 1920, 6);
    ctx.fillStyle = C.orange;
    if (artFrac > 0) ctx.fillRect(0, 1074, 1920 * artFrac, 6);
    else {
      const x = frame.view.settings.reduceMotion ? 0 : ((frame.nowMs % 1600) / 1600) * 2180 - 260;
      ctx.fillRect(Math.max(0, x), 1074, Math.min(x + 260, 1920) - Math.max(0, x), 6);
    }
  }

  function draw() {
    const state = frame.state;
    const v = frame.view;
    const s = state.screen;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#0B0D10';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // ---- world pass, clipped to the playfield (camera shake and the kill-cam zoom never leak into the letterbox)
    ctx.save();
    applyPlayfieldTransform(ctx, layout);
    ctx.beginPath();
    ctx.rect(0, 0, 1920, 1080);
    ctx.clip();
    try {
      world.draw(ctx, worldView);
    } catch (err) {
      log('error', 'world.draw failed', err);
    }
    ctx.restore();
    ctx.save();
    applyPlayfieldTransform(ctx, layout);
    ctx.globalAlpha = 1;

    g.v = v;
    g.nowMs = frame.nowMs;
    g.density = Math.max(1, Math.min(2, layout.k));

    const practice = s === 'calibration' && state.calibrationStep === 4;
    if (worldView.idle && s !== 'calibration') drawVeil(ctx, s === 'menu' || s === 'setup' ? 0.9 : 1.15);
    else if (s === 'calibration' && !practice) drawVeil(ctx, 1);

    if ((s === 'playing' || s === 'paused') && frame.snapshot) {
      try {
        hud.draw(ctx, frame.snapshot, {
          nowMs: frame.nowMs, t: hudTranslator(frame.snapshot.mode), labels: v.labels, reduceMotion: v.settings.reduceMotion, reduceFlash: v.settings.reduceFlash,
          battery: v.provider?.status?.battery?.level ?? 'unknown',
        });
      } catch (err) {
        log('error', 'hud.draw failed', err);
      }
    }
    if (s === 'paused') drawDim(ctx, 0.5);
    if (s === 'results') drawDim(ctx, 0.45);
    if (s === 'countdown') drawDim(ctx, 0.25);

    const drawer = SCREEN_DRAWERS[s];
    if (drawer) {
      try {
        drawer.draw(g);
      } catch (err) {
        log('error', `screen ${s} failed to draw`, err);
      }
    }
    if (s === 'playing' && state.resuming) drawResumeCountdown(g);
    if (state.overlay) {
      drawDim(ctx, 0.55);
      try {
        if (state.overlay === 'confirm') drawConfirm(g);
        else drawDisconnect(g);
      } catch (err) {
        log('error', 'overlay failed to draw', err);
      }
    }
    if (v.toast.text) {
      const age = frame.nowMs - v.toast.from;
      const left = v.toast.until - frame.nowMs;
      drawToast(ctx, v.toast.text, Math.min(1, age / 150, left / 250), s === 'playing' ? 220 : 150);
    }
    if (v.hint.show) drawHintLine(ctx, v.hint.items);
    if (artLoading) drawArtBar();
    ctx.restore();
  }

  function getPerf() {
    return { fps: ema ? 1000 / ema : 0, avgFrameMs: ema };
  }

  const uiApi = {
    onIntent: (fn) => ui.onIntent(fn),
    notify(fact) {
      if (fact && fact.type === 'visibility') {
        try {
          if (fact.hidden) audio.suspend?.();
          else audio.resume?.();
        } catch { /* ignore */ }
      }
      ui.notify(fact);
    },
    getState: () => ui.getState(),
    force: (screen, opts) => ui.force(screen, opts),
    getView: () => ui.getView(),
    pointerClick: (x, y) => ui.pointerClick(x, y),
    pointerDown: (x, y) => ui.pointerDown(x, y),
    pointerUp: (x, y) => ui.pointerUp(x, y),
    pointerMove: (x, y) => ui.pointerMove(x, y),
    activate: (id) => ui.activate(id),
    getTargets: () => ui.getTargets(),
  };

  return {
    ui: uiApi,
    step,
    draw,
    resize,
    getPerf,
    setArtLoading(on) {
      artLoading = !!on && assets !== NULL_ASSETS;
    },
    audio,
    storage,
    dispose() {
      for (const [target, type, fn, opts] of listeners) {
        if (fn) target.removeEventListener(type, fn, opts);
        else target.removeEventListener(type);
      }
      listeners.length = 0;
      for (const off of offAssets.splice(0)) { try { off(); } catch { /* ignore */ } }
      try { world.dispose?.(); } catch { /* ignore */ }
      try { audio.dispose?.(); } catch { /* ignore */ }
    },
    /** Internals for tests and the debug API (additive, not part of the contract). */
    debug: {
      ui, world, hud, assets, storage,
      getWorldView: () => worldView,
      getStageId: () => currentStage,
      getLayout: () => layout,
      getWorldDebug: () => { try { return world.getDebug?.() ?? null; } catch { return null; } },
    },
  };
}

/** An audio stand-in with the engine's API that plays nothing. */
function createSilentAudio() {
  const noop = () => {};
  return { muted: false, play: noop, stop: noop, setVolume: noop, setMuted(m) { this.muted = !!m; }, unlock: noop, suspend: noop, resume: noop, update: noop, handleGameEvent: noop, dispose: noop };
}
