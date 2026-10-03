// Clay Rush application wiring. OWNER: integrator. docs/architecture.md sections 3 and 9.1.
//
// createApp(env) builds the whole game from the modules (input, motion, game, presentation) and runs the frame loop:
//
//   provider events: sample -> motion.pushImu, aim -> motion.pushAim, action/nav -> ui.notify, status -> ui.notify({type:'provider'})
//   ui intents:      fire{t, source} -> Shot{t, x, y, source, compMs} (C-05, trigger compensation) -> shot queue
//                    startRound{mode, difficulty, stage} -> createGame(mode, seed, opts)
//   frame (step):    1 debug jobs, provider.tick (simulator), motion.poll, motion.drainSegments() (dropped: C-09)
//                    2 state = ui.getState()
//                    3 while the game is active: game.update(dtS, queued shots, now), events = game.drainEvents();
//                      shots queued while the game is NOT active are dropped, never replayed later
//                      the first time the game is over: ui.notify({type:'roundOver'}) (the UI records the best score and play time)
//                    4 aim = motion.headAt(now) (the crosshair, extrapolated at most 35 ms)
//                    5 presentation.step({nowMs, dtS, snapshot, events, aim, debug})
//                    6 rumble on `shot` events (C-08), shotFeedback facts due (tuning screen), clay-api afterStep
//   draw (rAF):      presentation.draw()
//
// Everything browser-specific comes in through `env` (window, document, canvas, requestAnimationFrame, ...), so the same code runs
// in Chrome (main.js) and in Node with the fakes of test-support/ (test/app). Nothing here reads the wall clock: all time comes from
// the Clock (performance.now(), or a manual clock under ?clock=manual).
//
// UNVERIFIED-ON-HARDWARE: everything that depends on a real Joy-Con 2 (trigger feel, trigger jerk, the default trigger compensation of
// 40 ms, rumble, aim precision) is inside the input and motion modules or in the settings. This file only routes data; it makes no
// claim about the physical controller.
//
// ART (all of it optional): this file creates the assets loader (render/assets.js) and preloads the group `core` behind the boot screen
// for at most `loader.bootWaitMs`; the world renderer loads the stage groups itself. With `?assets=0`, without an `Image` (Node), with a
// failed manifest or a failed image the game runs on its procedural drawing.

import { createInputProvider, createKeyboardActions, INPUT_CONFIG } from './input/index.js';
import { createMotionPipeline, MOTION_CONFIG } from './motion/index.js';
import { createGame, CONFIG, bestKey, emptyBest, sanitizeBest, isNewBest, updateBest } from './game/index.js';
import { createAssets, NULL_ASSETS } from './render/assets.js';
import { createPresentation } from './ui/presentation.js';
import { createStorage } from './ui/storage.js';
import { createAudio } from './audio/audio.js';
import { createManualClock, createRealClock } from './shared/clock.js';
import { FIELD } from './shared/playfield.js';
import { assertValid } from './shared/validate.js';
import { parseFlags, FILTER_NAMES } from './flags.js';
import { createClayApi } from './clay-api.js';
import { createWakeLock } from './wake-lock.js';

const EMPTY = Object.freeze([]);
const LOG_PREFIX = '[clay-rush]';
const MANUAL_CLOCK_START_MS = 1000; // the manual clock starts at 1 s so that "0" never means "unset"
const LOG_LIMIT = 200;
const LOOP_ERROR_LIMIT = 20;
const VALIDATION_LOG_LIMIT = 5;
const LATENCY_SMOOTHING = 0.1;
const MAX_FRAME_S = 0.05;
const BRIDGE_PROBE_TIMEOUT_MS = 2500; // GET /__bridge/status: a server that does not answer in this long has no usable bridge
// architecture 9.1: the trigger jerk of a press is measured this long after it (motion.shotDiagnostics needs the 80 ms after the press)
const SHOT_FEEDBACK_DELAY_MS = 160;
const SHOT_FEEDBACK_LIMIT = 8; // pending measurements kept at most (a burst of presses cannot grow the list)
const RUMBLE_PRESET_SHOT = 5; // C-08, design 6.4. UNVERIFIED-ON-HARDWARE
// A recenter press while the aim is moving fast is the grip, not the player (the owner's sword recording: the R shoulder button registered
// for one report in the middle of a 1009 deg/s stroke). It is ignored while the pointer moves at RECENTER_BLOCK_DPS or more and for
// RECENTER_HOLDOFF_MS afterwards. This rule NEVER applies to `fire` (C-02, docs/contract-notes.md): the trigger is pulled while swinging.
const RECENTER_BLOCK_DPS = 100;
const RECENTER_HOLDOFF_MS = 250;
const ROUND_MODES = Object.freeze(['classic', 'timeattack', 'zen', 'practice']);
const BEST_HELPERS = Object.freeze({ bestKey, emptyBest, sanitizeBest, isNewBest, updateBest });

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const errText = (err) => (err && err.message ? err.message : String(err));

/**
 * @param {{window?:any, document?:any, canvas:any, search?:string, performance?:any, requestAnimationFrame?:Function,
 *   cancelAnimationFrame?:Function, console?:any, crypto?:any, localStorage?:any, storageBackend?:any, createAudioContext?:Function,
 *   createCanvas?:Function, matchMedia?:Function, bluetooth?:any, navigator?:any, timers?:any, clock?:any, fetch?:Function, EventSource?:Function,
 *   assets?:any, assetFetch?:Function, createImage?:Function}} env
 *   (`clock` is for tests: it replaces the flag-chosen clock; `navigator` supplies `wakeLock`; `fetch` and `EventSource` reach the native Bluetooth
 *   bridge and default to the window's own; the art loader needs `createImage` (default: the window's `Image`), `assetFetch` (default: the window's
 *   `fetch`, NOT `env.fetch`, which belongs to the bridge) and a canvas factory, and without all three the game has no art; `assets` injects a ready-made
 *   loader or stub (tests), `null` means no art)
 */
export function createApp(env) {
  const win = env.window ?? (typeof window !== 'undefined' ? window : undefined);
  const doc = env.document ?? win?.document;
  const canvas = env.canvas;
  const cons = env.console ?? (typeof console !== 'undefined' ? console : { log() {}, info() {}, warn() {}, error() {} });
  if (!canvas) throw new TypeError('createApp: env.canvas is required');

  const flags = parseFlags(env.search ?? win?.location?.search ?? '');
  const clock = env.clock ?? (flags.clock === 'manual' ? createManualClock(MANUAL_CLOCK_START_MS) : createRealClock(env.performance ?? win?.performance));

  // ---------------------------------------------------------------------------------------------------------------- log
  const logRing = [];
  function log(level, message) {
    logRing.push({ t: clock.now(), level, message: String(message) });
    if (logRing.length > LOG_LIMIT) logRing.shift();
    if (level === 'error') cons.error(`${LOG_PREFIX} ${message}`);
    else if (level === 'warn') cons.warn(`${LOG_PREFIX} ${message}`);
    else if (flags.debug) cons.info(`${LOG_PREFIX} ${message}`);
  }
  for (const w of flags.warnings) log('warn', w);

  // debug boundary validation (?debug=1): log problems, never throw
  const validationCounts = Object.create(null);
  function check(kind, value) {
    if (!flags.debug) return;
    try {
      assertValid(kind, value);
    } catch (err) {
      validationCounts[kind] = (validationCounts[kind] ?? 0) + 1;
      if (validationCounts[kind] <= VALIDATION_LOG_LIMIT) log('error', err.message);
    }
  }

  // ------------------------------------------------------------------------------------------------------------- art layer
  const timers = env.timers ?? { setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms), clearTimeout: (id) => globalThis.clearTimeout(id) };
  const createCanvas = env.createCanvas ?? (doc && typeof doc.createElement === 'function'
    ? (w, h) => {
      const c = doc.createElement('canvas');
      c.width = w;
      c.height = h;
      return c;
    }
    : undefined);
  let ownsAssets = false;
  /** The assets loader, or NULL_ASSETS: art off (?assets=0), no way to make images (Node, tests), or a loader that could not be created. */
  function makeAssets() {
    if (!flags.assets) return NULL_ASSETS;
    if (env.assets !== undefined) return env.assets ?? NULL_ASSETS; // tests inject a stub or a loader with fake images
    const createImage = env.createImage ?? (win && typeof win.Image === 'function' ? () => new win.Image() : null);
    const assetFetch = env.assetFetch ?? (win && typeof win.fetch === 'function' ? win.fetch.bind(win) : null);
    if (!createImage || !assetFetch || !createCanvas) return NULL_ASSETS;
    try {
      ownsAssets = true;
      return createAssets({
        fetch: assetFetch, createImage, createCanvas, console: cons,
        setTimeout: (fn, ms) => timers.setTimeout(fn, ms), clearTimeout: (id) => timers.clearTimeout(id),
      });
    } catch (err) {
      ownsAssets = false;
      log('warn', `the art loader could not be created, the game keeps its painted art: ${errText(err)}`);
      return NULL_ASSETS;
    }
  }
  const assets = makeAssets();

  // ------------------------------------------------------------------------------------------------------ presentation
  const matchMedia = env.matchMedia ?? (win && typeof win.matchMedia === 'function' ? win.matchMedia.bind(win) : undefined);
  // ui/ may not import game/index.js (rule 3): the best-score helpers of the game are injected (docs/contract-notes.md, UI engineer)
  const storage = createStorage({
    backend: env.storageBackend,
    matchMedia,
    overrides: { ...(flags.reducemotion ? { reduceMotion: true } : {}), ...(flags.reduceflash ? { reduceFlash: true } : {}) },
    bestHelpers: BEST_HELPERS,
  });
  const audio = createAudio({ clock, mute: flags.mute, createContext: env.createAudioContext });
  const presentation = createPresentation({
    canvas, clock, storage, audio, window: win, document: doc, matchMedia, createCanvas, assets, bestHelpers: BEST_HELPERS,
  });
  const ui = presentation.ui;

  // ---------------------------------------------------------------------------------------------------------- motion
  /** The record of the diagnostics page: {"gyroScale": number, "accelSign": 1|-1, "measuredAt": iso}, each field optional. */
  function readDiagnosticsRecord() {
    try {
      const ls = env.localStorage ?? win?.localStorage;
      const raw = ls?.getItem(INPUT_CONFIG.diagnostics.storageKey);
      if (!raw) return null;
      const v = JSON.parse(raw);
      return v && typeof v === 'object' ? v : null;
    } catch {
      return null;
    }
  }
  function readSavedGyroScale() {
    const v = readDiagnosticsRecord()?.gyroScale;
    return Number.isFinite(v) && v > 0 ? v : null;
  }
  /**
   * The accelerometer sign and the stored gyro scale belong to the ACTIVE provider: what the diagnostics page saved was measured on a real
   * Joy-Con, so only the Bluetooth providers use it. An explicit ?accelsign wins for every provider. Read when the provider is chosen.
   * @param {'joycon'|'native'|'sim'|'mouse'|null} kind  ('native' is the same real Joy-Con as 'joycon', reached through the bridge)
   */
  const isRealJoycon = (kind) => kind === 'joycon' || kind === 'native';
  function accelSignFor(kind) {
    if (flags.accelsign !== null) return flags.accelsign;
    return isRealJoycon(kind) && readDiagnosticsRecord()?.accelSign === -1 ? -1 : 1;
  }
  function gyroScaleFor(kind) {
    return isRealJoycon(kind) ? readSavedGyroScale() : null;
  }
  /** 'absolute' for the simulator (docs/motion-contract.md 1.4), 'relative' for everything else (the mouse never pushes IMU samples). */
  const pointerModelFor = (kind) => (kind === 'sim' ? 'absolute' : 'relative');
  const initialSettings = storage.getSettings();
  const motion = createMotionPipeline({
    clock,
    config: MOTION_CONFIG.shooter, // the shooting gains (motion-config.js, block shooter), not the sword reference
    settings: { sensitivity: initialSettings.sensitivity, aimCurve: initialSettings.aimCurve, autoCenter: initialSettings.autoCenter, flipX: initialSettings.flipX },
    accelSign: accelSignFor(null),
    pointerModel: pointerModelFor(null),
  });

  // ------------------------------------------------------------------------------------------------------ wake lock
  // A Joy-Con is not keyboard or mouse activity for macOS: without a screen wake lock the display can sleep in the middle of a session.
  const wake = createWakeLock({ navigator: env.navigator ?? win?.navigator, document: doc, log });
  const AWAKE_SCREENS = new Set(['countdown', 'playing', 'paused', 'calibration', 'settings', 'tuning']);
  const AWAKE_LINK_STATES = new Set(['requesting', 'connecting', 'initializing', 'streaming', 'lost']);
  function displayMustStayAwake(uiState) {
    if (AWAKE_SCREENS.has(uiState.screen)) return true;
    return provider !== null && provider.kind === 'joycon' && AWAKE_LINK_STATES.has(provider.status.state);
  }

  // ---------------------------------------------------------------------------------------------------- round state
  let game = null;
  let gameMode = null;
  let announced = false;
  let seedOverride = flags.seed; // ?seed=N or __clay.setSeed(n): every later round uses it
  let readyDone = false;
  let disposed = false;
  /** @type {Array<import('./shared/contracts.js').Shot>} shots waiting for the next game.update (C-05) */
  const shotQueue = [];
  let shotsDropped = 0;

  function randomSeed() {
    const c = env.crypto ?? win?.crypto ?? globalThis.crypto;
    if (c && typeof c.getRandomValues === 'function') return c.getRandomValues(new Uint32Array(1))[0];
    return Math.floor(clock.now() * 1000) >>> 0; // no crypto (never in a browser on localhost): still a fresh-looking seed
  }
  const newSeed = () => (seedOverride !== null ? seedOverride : randomSeed());

  /**
   * Start a round. Called by the UI's startRound intent, by __clay.start and by ?mode.
   * @param {string} mode  'classic' | 'timeattack' | 'zen' | 'practice'
   * @param {{difficulty?:string, stage?:string, seed?:number}} [o]
   */
  function beginRound(mode, o = {}) {
    if (!ROUND_MODES.includes(mode)) throw new RangeError(`unknown round mode "${mode}"`);
    const s = storage.getSettings();
    const seed = Number.isFinite(o.seed) ? o.seed >>> 0 : newSeed();
    const opts = {
      difficulty: o.difficulty ?? s.difficulty,
      stage: o.stage ?? s.stage,
      assist: s.aimAssist === true,
      autoPull: s.autoPull === true,
      reduceMotion: s.reduceMotion === true,
    };
    game = createGame(mode, seed, opts);
    gameMode = mode;
    announced = false;
    shotQueue.length = 0;
    log('info', `round started: ${mode}, ${opts.difficulty}, ${opts.stage}, seed ${seed}`);
    return game;
  }

  /** The UI's endRound intent: 'quit' abandons the round; 'finished' drops a finished round, or ends Zen ("End session", results follow). */
  function finishRound(reason) {
    shotQueue.length = 0;
    if (!game) return;
    if (reason === 'finished' && !game.isOver() && gameMode !== 'practice') {
      // Zen "End session" from the pause panel: the UI waits for roundOver to show the session results (docs/contract-notes.md, UI);
      // 'finished' gives endReason 'complete' (review G-03)
      game.end('finished');
      return;
    }
    if (!game.isOver()) game.end('quit');
    game = null;
    gameMode = null;
    announced = false;
  }

  // ------------------------------------------------------------------------------------------------------- settings
  /** Push the persisted settings to Motion and to the provider. The simulator never drifts, so auto-centring is off there. */
  function applySettings() {
    const s = storage.getSettings();
    motion.setSettings({
      sensitivity: s.sensitivity,
      aimCurve: s.aimCurve,
      autoCenter: s.autoCenter && provider?.kind !== 'sim',
      flipX: s.flipX,
    });
    applyTriggerButton(s.triggerButton);
    // review G-02: Reduce motion switched on in the pause menu applies to the running round at once (no hit stop, no kill-cam slow motion)
    if (game && typeof game.setReduceMotion === 'function') game.setReduceMotion(!!s.reduceMotion);
  }

  /** C-02: ZR or R is the trigger (the other one recentres). The labels of the hint line and the HUD follow, so the provider fact is resent. */
  let appliedTrigger = null;
  function applyTriggerButton(button) {
    if (!provider || typeof provider.setTriggerButton !== 'function') return;
    const key = `${provider.kind}:${button}`;
    try {
      provider.setTriggerButton(button);
    } catch (err) {
      log('warn', `setTriggerButton failed: ${errText(err)}`);
      return;
    }
    if (appliedTrigger !== key) {
      appliedTrigger = key;
      notifyProvider();
    }
  }

  // ------------------------------------------------------------------------------------------------------- shots (C-05)
  const isFiniteNum = (v) => typeof v === 'number' && Number.isFinite(v);

  /**
   * Turn a fire intent into a Shot: the press time `t` of the report, the aim at `t - compMs` from Motion's history (the trigger jerk
   * comes after the press), or the crosshair when the history does not cover that time. compMs is the setting for a real Joy-Con and 0
   * for everything else (mouse, keyboard, simulator, debug). The value of the setting is UNVERIFIED-ON-HARDWARE (design 6.3).
   */
  function buildShot(t, source) {
    const now = clock.now();
    const pressT = isFiniteNum(t) ? t : now;
    const compMs = source === 'joycon' ? storage.getSettings().triggerCompMs : 0;
    let a = motion.aimAt(pressT - compMs);
    if (!(a && a.valid) && source !== 'joycon') {
      // review A-01: a keyboard (or other clock-stamped) press is newer than the newest IMU sample, so aimAt(now) is not covered: use the
      // newest MEASURED aim (no compensation), never the extrapolated crosshair
      const newest = motion.latest();
      if (newest && newest.t < pressT) a = motion.aimAt(newest.t);
    }
    let x;
    let y;
    if (a && a.valid) {
      x = a.x;
      y = a.y;
    } else {
      const head = motion.headAt(now);
      x = head ? head.x : FIELD.w / 2;
      y = head ? head.y : FIELD.h / 2;
    }
    return { t: pressT, x: clamp(x, 0, FIELD.w), y: clamp(y, 0, FIELD.h), source, compMs };
  }

  function queueShot(shot) {
    check('Shot', shot);
    shotQueue.push(shot);
  }

  // shotFeedback (architecture 9.1, the tuning screen): measured SHOT_FEEDBACK_DELAY_MS after every trigger press of a provider
  const feedbackDue = [];
  function scheduleShotFeedback(event) {
    if (!event || !isFiniteNum(event.t) || event.source === 'debug') return;
    const compMs = event.source === 'joycon' ? storage.getSettings().triggerCompMs : 0;
    feedbackDue.push({ t: event.t, compMs, dueAt: Math.max(clock.now(), event.t) + SHOT_FEEDBACK_DELAY_MS });
    if (feedbackDue.length > SHOT_FEEDBACK_LIMIT) feedbackDue.shift();
  }
  function flushShotFeedback(now) {
    while (feedbackDue.length && feedbackDue[0].dueAt <= now) {
      const f = feedbackDue.shift();
      let d;
      try {
        d = motion.shotDiagnostics(f.t, f.compMs);
      } catch (err) {
        log('warn', `shotDiagnostics failed: ${errText(err)}`);
        continue;
      }
      ui.notify({ type: 'shotFeedback', jerkPeakDps: d.jerkPeakDps, displacementPx: d.displacementPx, compMs: f.compMs, valid: d.valid === true });
    }
  }

  // ------------------------------------------------------------------------------------------------------- native bridge probe
  // The native Bluetooth bridge (docs/native-bridge.md) needs fetch and EventSource, and a server that has the /__bridge/ endpoints and a
  // helper. The connect screen learns it from GET /__bridge/status each time it opens (a fact `bridgeProbe`), and from localStorage which
  // path worked last. Under the manual clock (tests) nothing is probed: the real network would make a scripted run depend on real time.
  const bridgeFetch = env.fetch ?? (win && typeof win.fetch === 'function' ? win.fetch.bind(win) : null);
  const bridgeEventSource = env.EventSource ?? (win && typeof win.EventSource === 'function' ? win.EventSource : null);
  let probeSeq = 0;
  let rememberedPath = null;
  let rememberedPathLoaded = false;

  function readRememberedPath() {
    if (rememberedPathLoaded) return rememberedPath;
    rememberedPathLoaded = true;
    try {
      const raw = (env.localStorage ?? win?.localStorage ?? null)?.getItem(INPUT_CONFIG.pathStorageKey);
      const v = raw ? JSON.parse(raw)?.path : null;
      if (v === 'native' || v === 'chrome') rememberedPath = v;
    } catch {
      /* blocked or corrupt storage: no memory across sessions */
    }
    return rememberedPath;
  }
  function rememberPath(path) {
    if (readRememberedPath() === path) return;
    rememberedPath = path;
    try {
      (env.localStorage ?? win?.localStorage ?? null)?.setItem(INPUT_CONFIG.pathStorageKey, JSON.stringify({ v: 1, path }));
    } catch {
      /* the in-memory copy still serves this page */
    }
    log('info', `remembered the connection path "${path}" for the next visit`);
  }
  /** The path the connect screen offers first: what ?input= asks for, else the one that last reached `streaming`. */
  function preferredPath() {
    if (flags.input === 'joycon') return 'chrome';
    if (flags.input === 'native') return 'native';
    return readRememberedPath();
  }

  function probeBridge() {
    if (flags.clock === 'manual' || flags.input === 'sim' || flags.input === 'mouse' || flags.mode) return;
    const preferred = preferredPath();
    if (!bridgeFetch || !bridgeEventSource) {
      ui.notify({ type: 'bridgeProbe', phase: 'done', available: false, reason: 'no_fetch', canBuild: false, built: false, preferred });
      return;
    }
    const seq = ++probeSeq;
    ui.notify({ type: 'bridgeProbe', phase: 'checking', preferred });
    let settled = false;
    const done = (st) => {
      if (settled || seq !== probeSeq || disposed) return;
      settled = true;
      timers.clearTimeout(timer);
      ui.notify({
        type: 'bridgeProbe', phase: 'done', available: st?.available === true, reason: typeof st?.reason === 'string' ? st.reason : (st ? null : 'unreachable'),
        canBuild: st?.canBuild === true, built: st?.built === true, preferred,
      });
    };
    const timer = timers.setTimeout(() => done(null), BRIDGE_PROBE_TIMEOUT_MS);
    Promise.resolve()
      .then(() => bridgeFetch('/__bridge/status', { cache: 'no-store' }))
      .then((res) => (res && res.ok ? res.json() : null))
      .then((json) => done(json && typeof json === 'object' ? json : null), () => done(null));
  }

  // ------------------------------------------------------------------------------------------------------- providers
  // The two Joy-Con providers live for the whole page: cooldown and failure counts are in them. `joycon` is Web Bluetooth (Chrome's
  // chooser), `native` the native Bluetooth bridge (docs/native-bridge.md). Only one of them is connected at a time.
  const providers = { joycon: null, native: null };
  let provider = null;
  let providerOff = [];
  let lastState = null;
  let pendingArrival = null; // arrival time of the oldest sample that has not been drawn yet (inputToDrawMs)
  let latencyEma = null;

  const providerLog = (level, message) => log(level === 'error' || level === 'warn' ? 'warn' : 'info', `provider: ${message}`);

  function makeProvider(kind) {
    switch (kind) {
      case 'joycon':
        if (!providers.joycon) {
          providers.joycon = createInputProvider('joycon', {
            clock, log: providerLog, bluetooth: env.bluetooth, document: doc, pageTarget: win, windowTarget: win, timers: env.timers,
          });
        }
        return providers.joycon;
      case 'native':
        if (!providers.native) {
          providers.native = createInputProvider('native', {
            clock, log: providerLog, document: doc, pageTarget: win, timers: env.timers, fetch: bridgeFetch ?? undefined, EventSource: bridgeEventSource ?? undefined,
          });
        }
        return providers.native;
      case 'sim':
        return createInputProvider('sim', {
          clock, target: canvas, windowTarget: win, log: providerLog, timers: env.timers,
          sim: {
            hz: flags.simhz, mount: flags.simmount, side: flags.simside, mirrorGyro: flags.simmirror, gyroScaleTrue: flags.simgyro, seed: flags.simseed,
            accelSign: flags.simaccelsign,
          },
        });
      case 'mouse':
        return createInputProvider('mouse', { clock, target: canvas, windowTarget: win, log: providerLog });
      default:
        throw new RangeError(`unknown provider kind "${kind}"`);
    }
  }

  function providerStatus() {
    return provider ? provider.status : { kind: null, state: null, side: null };
  }

  function notifyProvider(status) {
    if (!provider) {
      ui.notify({ type: 'provider', kind: null, status: null, labels: null, capabilities: null });
      return;
    }
    ui.notify({
      type: 'provider', kind: provider.kind, transport: provider.transport ?? (provider.kind === 'joycon' ? 'bluetooth' : null), status: status ?? provider.status,
      labels: provider.getActionLabels(), capabilities: provider.capabilities,
    });
  }

  function onImu(s) {
    check('ImuSample', s);
    if (pendingArrival === null) pendingArrival = Number.isFinite(s.arrivedAt) ? s.arrivedAt : clock.now();
    motion.pushImu(s);
  }

  function onAim(s) {
    check('AimSample', s);
    if (pendingArrival === null) pendingArrival = Number.isFinite(s.t) ? s.t : clock.now();
    motion.pushAim(s);
  }

  let wasLost = false; // a link loss is pending recovery (the BLE provider goes lost -> connecting -> initializing -> streaming)
  function onStatus(status) {
    check('InputStatus', status);
    const prev = lastState;
    lastState = status.state;
    if (prev === 'streaming' && status.state === 'lost') motion.markDiscontinuity('lost');
    if (status.state === 'lost') wasLost = true;
    // the first valid report after a chooser attempt: the filter of that attempt works on this Mac, keep it for the next connection
    if (status.state === 'streaming' && attemptFilter !== null && provider !== null && provider === providers.joycon) {
      const worked = attemptFilter;
      attemptFilter = null;
      rememberFilter(worked);
    }
    // the path that reached `streaming` is the one the connect screen offers first next time (native bridge or Chrome)
    if (status.state === 'streaming' && prev !== 'streaming' && provider !== null && (provider === providers.native || provider === providers.joycon)) {
      rememberPath(provider === providers.native ? 'native' : 'chrome');
    }
    // after a recovery the Motion pipeline re-references at once; the UI then asks for its quick recentre
    if (status.state === 'streaming' && wasLost) {
      wasLost = false;
      if (provider && provider.kind !== 'mouse') motion.recenter('reconnect');
    } else if (status.state === 'idle' || status.state === 'error') {
      wasLost = false;
    }
    // a (re)connected unit gets the trigger button of the settings again (it survives in the provider, but a new unit may be the other side)
    if (status.state === 'streaming' && prev !== 'streaming') applyTriggerButton(storage.getSettings().triggerButton);
    notifyProvider(status);
  }

  function onBridge(e) {
    ui.notify({ type: 'bridge', phase: e.phase, key: e.key, scanStartedAt: e.scanStartedAt ?? null, scanSeconds: e.scanSeconds ?? null });
  }

  function onTeleport(e) {
    motion.reanchor(e.x, e.y);
  }

  const onAction = (event) => {
    check('ActionEvent', event);
    if (event.action === 'fire') scheduleShotFeedback(event);
    ui.notify({ type: 'action', event });
  };

  // Menu navigation: the analog stick of a Joy-Con (provider event 'nav') and the arrow keys. The UI moves its focus with it.
  const onNav = (event) => {
    check('NavEvent', event);
    ui.notify({ type: 'nav', event });
  };

  function detachProvider() {
    for (const off of providerOff) off();
    providerOff = [];
    const old = provider;
    provider = null;
    lastState = null;
    appliedTrigger = null;
    if (!old) return;
    if (old.kind === 'joycon') {
      // never disposed: the cooldown and the chosen BluetoothDevice must survive a switch to the mouse and back
      old.disconnect();
    } else {
      old.dispose();
    }
  }

  /** Make `kind` the one active provider (creating it when needed). Does not connect. */
  function useProvider(kind) {
    const next = makeProvider(kind);
    if (provider === next) return next;
    detachProvider();
    motion.setAccelSign(accelSignFor(kind)); // before reset() and setCalibration(null), which start the filter and the default scale over
    motion.setGyroScaleOverride(gyroScaleFor(kind));
    motion.setPointerModel(pointerModelFor(kind));
    motion.reset();
    motion.setCalibration(null);
    provider = next;
    providerOff = [
      next.on('sample', onImu),
      next.on('aim', onAim),
      next.on('status', onStatus),
      next.on('action', onAction),
      next.on('nav', onNav),
      // simulator only: its virtual gun jumped (pointer entered, blur, debug teleport); the gyro cannot see it, so Motion is told
      next.on('teleport', onTeleport),
      // native bridge only: progress of the attempt (phase, its string key, when the scan started), shown on the connect screen
      next.on('bridge', onBridge),
    ];
    lastState = next.status.state;
    wasLost = false;
    if (kind === 'sim' && !flags.simcal && next.nominalCalibration) motion.setCalibration(next.nominalCalibration);
    applySettings(); // also the trigger button, which (re)sends the provider fact
    notifyProvider();
    return next;
  }

  // ------------------------------------------------------------------------------- the chooser filter that worked
  // The game starts with INPUT_CONFIG.defaultFilter ('lenient'). When the chooser lists nothing, the connect screen offers "Extended search"
  // (filter 'all'). The filter of every attempt that reached `streaming` is remembered (memory and localStorage) and used the next time.
  // Order of precedence: the filter of the UI intent > ?filter > the remembered filter > INPUT_CONFIG.defaultFilter. UNVERIFIED-ON-HARDWARE (UOH-1).
  let rememberedFilter = null;
  let rememberedLoaded = false;
  let attemptFilter = null; // the filter of the chooser attempt that is in progress, cleared once it was remembered

  function filterStore() {
    return env.localStorage ?? win?.localStorage ?? null;
  }
  function readRememberedFilter() {
    if (rememberedLoaded) return rememberedFilter;
    rememberedLoaded = true;
    try {
      const raw = filterStore()?.getItem(INPUT_CONFIG.filterStorageKey);
      const v = raw ? JSON.parse(raw)?.filter : null;
      if (FILTER_NAMES.includes(v)) rememberedFilter = v;
    } catch {
      /* blocked or corrupt storage: no memory across sessions */
    }
    return rememberedFilter;
  }
  function rememberFilter(filter) {
    if ((readRememberedFilter() ?? INPUT_CONFIG.defaultFilter) === filter) return; // nothing new to keep (the default needs no record)
    rememberedFilter = filter;
    try {
      filterStore()?.setItem(INPUT_CONFIG.filterStorageKey, JSON.stringify({ v: 1, filter }));
    } catch {
      /* the in-memory copy still serves this page */
    }
    log('info', `remembered the chooser filter "${filter}" for the next connection`);
  }

  /** What the UI intent, ?filter, ?mask and ?side ask of the Bluetooth connection. */
  function bluetoothConnectOptions(intentFilter) {
    const o = {};
    o.filter = FILTER_NAMES.includes(intentFilter) ? intentFilter : flags.filter ?? readRememberedFilter() ?? INPUT_CONFIG.defaultFilter;
    if (flags.mask !== null) o.mask = flags.mask;
    if (flags.side !== null) o.side = flags.side;
    return o;
  }

  /**
   * connect() runs synchronously (Web Bluetooth needs the click or key that caused the intent) and never leaves a rejection unhandled.
   * @param {string} kind
   * @param {string} [filter]  Bluetooth only: the filter the UI asks for, see bluetoothConnectOptions
   */
  function connectProvider(kind, filter) {
    const p = useProvider(kind);
    if (p.status.state === 'streaming') return;
    let pr;
    try {
      if (kind === 'native') {
        // no chooser: the bridge finds the Joy-Con itself, so there is no filter; side and mask flags still apply
        const o = {};
        if (flags.mask !== null) o.mask = flags.mask;
        if (flags.side !== null) o.side = flags.side;
        pr = p.connect(o);
      } else if (kind === 'joycon') {
        const o = bluetoothConnectOptions(filter);
        pr = p.connect(o);
        // only an attempt that really opened the chooser can teach the game which filter works (a refusal by the cooldown cannot)
        if (p.status.state === 'requesting') {
          attemptFilter = o.filter;
          log('info', `chooser filter: ${o.filter}`);
        }
      } else pr = p.connect();
    } catch (err) {
      log('error', `connect() threw: ${errText(err)}`);
      return;
    }
    pr.catch((err) => log('warn', `connect failed: ${err && err.code ? `${err.code}: ` : ''}${errText(err)}`));
  }

  function reconnectProvider() {
    if (!provider) return;
    let pr;
    try {
      pr = provider.reconnect();
    } catch (err) {
      log('error', `reconnect() threw: ${errText(err)}`);
      return;
    }
    pr.catch((err) => log('warn', `reconnect failed: ${err && err.code ? `${err.code}: ` : ''}${errText(err)}`));
  }

  /** The wizard needs an IMU. The simulator runs it against its own scripted gun (no human needed); the mouse has nothing to calibrate. */
  function startCalibration() {
    if (!provider || provider.kind === 'mouse') {
      log('info', 'calibration ignored: the mouse needs none');
      return;
    }
    motion.startCalibration({ side: provider.status.side });
    if (provider.kind === 'sim') provider.playCalibrationScript().catch(() => {});
  }

  // ------------------------------------------------------------------------------------------------- UI intents
  function handleIntent(intent) {
    switch (intent.type) {
      case 'startRound': beginRound(intent.mode, { difficulty: intent.difficulty, stage: intent.stage, seed: intent.seed }); break;
      case 'endRound': finishRound(intent.reason); break;
      case 'fire':
        // C-04 / C-05: the UI only sends it while the game is active; a shot that finds no game is dropped
        if (game) queueShot(buildShot(intent.t, intent.source ?? 'debug'));
        break;
      case 'connect': connectProvider(intent.provider, intent.filter); break;
      case 'disconnect': provider?.disconnect(); break;
      case 'reconnect': reconnectProvider(); break;
      case 'useMouse': connectProvider('mouse'); break;
      case 'startCalibration': startCalibration(); break;
      case 'cancelCalibration': motion.cancelCalibration(); break;
      case 'confirmCenter': motion.confirmCenter(); break;
      case 'quickRecenter':
        if (provider && provider.kind !== 'mouse') motion.beginQuickRecenter();
        break;
      case 'clearCalibration': motion.setCalibration(null); break; // another Joy-Con than the calibrated one is streaming
      case 'recenter':
        if (clock.now() - lastFastAt < RECENTER_HOLDOFF_MS) {
          log('info', 'recenter press ignored: the aim is moving fast (a grip press during a swing)');
          break;
        }
        motion.recenter('manual');
        break;
      case 'settingsChanged': applySettings(); break; // the presentation applies the volume itself
      case 'openDiagnostics':
        // A Bluetooth peripheral talks to one central at a time: while this page holds the Joy-Con the diagnostics page cannot find it.
        for (const p of [providers.joycon, providers.native]) {
          try {
            p?.disconnect();
          } catch (err) {
            log('warn', `disconnect before the diagnostics page failed: ${errText(err)}`);
          }
        }
        if (win && typeof win.open === 'function') win.open('diagnostics.html', '_blank', 'noopener');
        break;
      default: log('warn', `unknown UI intent "${intent.type}"`);
    }
  }
  ui.onIntent((intent) => {
    try {
      handleIntent(intent);
    } catch (err) {
      log('error', `intent ${intent && intent.type} failed: ${err && err.stack ? err.stack : err}`);
    }
  });

  // ---------------------------------------------------------------------------------------------- motion -> UI, keyboard
  motion.on('calibration', (event) => ui.notify({ type: 'calibration', event }));
  motion.on('recenter', (e) => {
    // only a manual recentre gets the toast and the sound; soft centring and calibration are silent
    if (e.kind === 'manual') ui.notify({ type: 'recentered', kind: e.kind });
  });
  motion.on('warning', (warning) => {
    ui.notify({ type: 'motionWarning', warning });
    log('warn', `motion: ${warning.code}: ${warning.message}`);
  });
  let lastFastAt = -Infinity; // clock time of the newest pointer sample at RECENTER_BLOCK_DPS or more (recenter hold-off only)
  motion.on('blade', (b) => {
    check('BladeSample', b);
    if (b.speedDps >= RECENTER_BLOCK_DPS) lastFastAt = clock.now();
  });

  const keyboard = createKeyboardActions({ clock, target: win });
  keyboard.on('action', onAction);
  keyboard.on('nav', onNav);

  // page-level listeners; dispose() removes them (tests and embeddings create several apps on one window)
  const pageListeners = [];
  const listenOn = (target, type, fn) => {
    if (!target || typeof target.addEventListener !== 'function') return;
    target.addEventListener(type, fn);
    pageListeners.push([target, type, fn]);
  };
  listenOn(win, 'blur', () => ui.notify({ type: 'blur' }));
  listenOn(win, 'pagehide', () => {
    for (const p of [provider, providers.joycon, providers.native]) {
      try {
        p?.disconnect?.();
      } catch {
        /* pagehide must never throw */
      }
    }
  });
  listenOn(doc, 'visibilitychange', () => {
    shotQueue.length = 0; // a shot from before the tab was hidden belongs to no frame the player saw
    ui.notify({ type: 'visibility', hidden: !!doc.hidden });
  });

  // -------------------------------------------------------------------------------------------------------- the frame
  let lastNow = null;
  let lastScreen = null;
  let loopErrors = 0;
  let clay = null;
  const aimView = { x: FIELD.w / 2, y: FIELD.h / 2, visible: false, trackingOk: false, speedDps: 0 };

  function stepInner() {
    const now = clock.now();
    const dtS = lastNow === null ? 0 : Math.min(MAX_FRAME_S, Math.max(0, (now - lastNow) / 1000));
    lastNow = now;

    // 1 inputs
    clay.injectDue(now);
    if (provider && typeof provider.tick === 'function') provider.tick(now); // simulator: every report due up to now
    motion.poll(now);
    motion.drainSegments(); // C-09: nothing consumes blade segments any more

    // 2 UI state
    const state = ui.getState();
    if (state.screen === 'connect' && lastScreen !== 'connect' && lastScreen !== null) probeBridge(); // the screen opened again: ask once more
    lastScreen = state.screen;
    wake.setWanted(displayMustStayAwake(state), now);

    // 3 the game
    let events = EMPTY;
    if (state.gameActive && game) {
      const shots = shotQueue.length ? shotQueue.splice(0) : EMPTY;
      game.update(dtS, shots, now);
      events = game.drainEvents();
    } else if (shotQueue.length) {
      shotsDropped += shotQueue.length;
      shotQueue.length = 0; // never replayed later
    }
    if (game && !announced && game.isOver()) {
      announced = true;
      const result = game.getResult();
      check('RoundResult', result);
      ui.notify({ type: 'roundOver', result });
    }

    // 4 the crosshair
    const ms = motion.getState();
    const head = motion.headAt(now);
    const providerOk = provider ? provider.status.trackingOk === true : false;
    aimView.x = head ? head.x : ms.x;
    aimView.y = head ? head.y : ms.y;
    aimView.trackingOk = ms.trackingOk === true && (providerOk || clay.aimOverride());
    aimView.visible = head !== null && (aimView.trackingOk || clay.aimOverride());
    aimView.speedDps = Number.isFinite(ms.angularSpeedDps) && ms.angularSpeedDps > 0 ? ms.angularSpeedDps : (Number.isFinite(ms.speedDps) ? ms.speedDps : 0);

    // 5 presentation
    const snapshot = game ? game.snapshot() : null;
    if (flags.debug) {
      if (snapshot) check('GameSnapshot', snapshot);
      for (const e of events) check('GameEvent', e);
    }
    presentation.step({ nowMs: now, dtS, snapshot, events, aim: aimView, debug: flags.debug });

    // 6 rumble (C-08), the tuning screen's measurements, the debug API
    if (events.length && flags.haptics && provider && typeof provider.vibrate === 'function' && storage.getSettings().rumble) {
      for (const e of events) {
        if (e.type === 'shot') {
          try {
            provider.vibrate(RUMBLE_PRESET_SHOT); // rate limited by the provider. UNVERIFIED-ON-HARDWARE
          } catch (err) {
            log('warn', `vibrate failed: ${errText(err)}`);
          }
        }
      }
    }
    if (feedbackDue.length) flushShotFeedback(now);
    clay.afterStep(now, events);
  }

  function runStep() {
    try {
      stepInner();
    } catch (err) {
      loopErrors += 1;
      if (loopErrors <= LOOP_ERROR_LIMIT || loopErrors % 100 === 0) log('error', `frame failed (${loopErrors}): ${err && err.stack ? err.stack : err}`);
    }
  }

  function afterDraw() {
    if (pendingArrival === null || clock.manual) {
      pendingArrival = null;
      return;
    }
    const lat = clock.now() - pendingArrival;
    pendingArrival = null;
    if (lat >= 0 && lat < 1000) latencyEma = latencyEma === null ? lat : latencyEma + LATENCY_SMOOTHING * (lat - latencyEma);
  }

  const raf = env.requestAnimationFrame ?? (win && typeof win.requestAnimationFrame === 'function' ? win.requestAnimationFrame.bind(win) : null);
  let rafId = null;
  function loop() {
    if (disposed || !raf) return;
    rafId = raf(() => {
      if (disposed) return;
      try {
        if (!clock.manual) runStep(); // under the manual clock only advance() steps; this loop just paints
        presentation.draw();
        afterDraw();
      } catch (err) {
        loopErrors += 1;
        if (loopErrors <= LOOP_ERROR_LIMIT || loopErrors % 100 === 0) log('error', `draw failed (${loopErrors}): ${err && err.stack ? err.stack : err}`);
      }
      loop();
    });
  }

  // ------------------------------------------------------------------------------------------------------ debug API
  /** __clay.start and ?mode: a round that skips the menus. `autoLaunch` true = Classic calls every pull itself; false = no automatic launches. */
  function apiStart(mode, { difficulty, stage, seed, skipCountdown = true, autoLaunch } = {}) {
    const g = beginRound(mode, { difficulty, stage, seed });
    if (autoLaunch === true && mode === 'classic') g.debugSetAutoLaunch(true);
    else if (autoLaunch === false) g.debugSetAutoLaunch(false);
    ui.force(skipCountdown ? 'playing' : 'countdown', { roundMode: mode });
    return g;
  }

  clay = createClayApi({
    clock,
    motion,
    presentation,
    flags,
    getGame: () => game,
    getProvider: () => provider,
    runStep,
    startRound: apiStart,
    queueShot,
    buildShot,
    applySettings,
    setSeed: (n) => { seedOverride = n; },
    getConfig: () => ({ game: CONFIG, motion: MOTION_CONFIG, input: INPUT_CONFIG }),
    getInputToDrawMs: () => latencyEma,
    isReady: () => readyDone,
    getLog: () => logRing.slice(),
    getProviderStatus: providerStatus,
    getWakeLock: () => wake.getState(),
    getCounters: () => ({ shotsQueued: shotQueue.length, shotsDropped, loopErrors, game: game?.debugInfo?.() ?? null }),
    getAssets: () => ({
      enabled: !assets.isNull,
      ...assets.status(),
      world: presentation.debug?.getWorldDebug?.() ?? null,
    }),
  });

  let resolveReady;
  clay.api.ready = new Promise((resolve) => { resolveReady = resolve; });
  if (win) win.__clay = clay.api;

  // ------------------------------------------------------------------------------------------------------------ boot
  let started = false;
  let setupOk = false;

  /** Provider, bridge probe. Runs first, whatever the art does. */
  function setup() {
    try {
      applySettings();
      if (flags.input === 'joycon' || flags.input === 'native') useProvider(flags.input); // created, not connected: the connect screen's click connects
      else if (flags.input === 'sim' || flags.input === 'mouse') connectProvider(flags.input);
      else notifyProvider();
      probeBridge();
      setupOk = true;
    } catch (err) {
      log('error', `boot failed: ${err && err.stack ? err.stack : err}`);
    }
  }

  /** The boot screen ends: the UI learns that the game is ready (safety screen, menu or the round of ?mode), and `__clay.ready` resolves. */
  function complete() {
    if (readyDone || disposed) return;
    try {
      if (setupOk) {
        ui.notify({ type: 'ready', skipSafety: flags.skipsafety });
        readyDone = true;
        if (flags.simcal && provider && provider.kind === 'sim') startCalibration(); // the real wizard instead of the nominal calibration
        if (flags.mode) apiStart(flags.mode, { difficulty: flags.difficulty ?? undefined, stage: flags.stage ?? undefined, skipCountdown: flags.skipcountdown });
      }
    } catch (err) {
      log('error', `boot failed: ${err && err.stack ? err.stack : err}`);
    }
    resolveReady();
  }

  /**
   * Preload the group `core` (clays, shards, fx, houses, icons, gun, logo) BEHIND the boot screen. The wait is capped at
   * `loader.bootWaitMs` of REAL time (also under ?clock=manual); the loading goes on in the background. Nothing here can reject or throw.
   */
  function waitForCore() {
    const waitMs = Number.isFinite(assets.config?.loader?.bootWaitMs) ? assets.config.loader.bootWaitMs : 2500;
    let core;
    try {
      core = Promise.resolve(assets.load('core'));
    } catch (err) {
      log('warn', `art: load failed: ${errText(err)}`);
      core = Promise.resolve(null);
    }
    core = core.catch(() => null);
    presentation.setArtLoading?.(true); // shown as a thin bar only if the boot wait runs out before `core` is done
    core.then(() => presentation.setArtLoading?.(false));
    return new Promise((resolve) => {
      let timer = null;
      const finish = () => {
        if (timer !== null) timers.clearTimeout(timer);
        resolve();
      };
      timer = timers.setTimeout(() => { timer = null; finish(); }, waitMs);
      core.then(finish);
    });
  }

  function start() {
    if (started) return clay.api.ready;
    started = true;
    setup();
    if (assets.isNull) {
      complete();
      loop();
    } else {
      loop(); // the boot screen paints while `core` loads
      waitForCore().then(complete, complete);
    }
    return clay.api.ready;
  }

  return {
    flags,
    clock,
    motion,
    presentation,
    storage,
    assets,
    clay: clay.api,
    start,
    /** One frame (tests). */
    step: runStep,
    getGame: () => game,
    getProvider: () => provider,
    getLog: () => logRing.slice(),
    getShotQueue: () => shotQueue.slice(),
    dispose() {
      disposed = true;
      if (rafId !== null && typeof env.cancelAnimationFrame === 'function') env.cancelAnimationFrame(rafId);
      for (const off of providerOff) off();
      providerOff = [];
      try { provider?.dispose(); } catch { /* ignore */ }
      try { providers.joycon?.dispose(); } catch { /* ignore */ }
      try { providers.native?.dispose(); } catch { /* ignore */ }
      keyboard.dispose();
      wake.dispose();
      if (ownsAssets) {
        try { assets.dispose(); } catch { /* ignore */ }
      }
      for (const [target, type, fn] of pageListeners.splice(0)) {
        try {
          target.removeEventListener(type, fn);
        } catch {
          /* ignore */
        }
      }
      presentation.dispose();
    },
  };
}
