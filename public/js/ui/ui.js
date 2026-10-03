// The UI state machine of Clay Rush: screens, overlays, focus navigation, intents, timers. OWNER: UI engineer.
// docs/architecture.md 8.2 and 8.3 (exact), docs/game-design.md 6 and 9. Pure logic: no canvas, no DOM, no timers; time comes from the injected
// Clock (facts) and from StepInput.nowMs (step). Tests drive it with fake facts and a manual clock.
//
// Contract with app.js (through presentation.js):
//   ui.onIntent(fn)   intents are delivered SYNCHRONOUSLY from inside the handler that caused them (pointerClick, notify) or from inside step()
//                     (timers, countdown end). A `connect` intent from a real click therefore runs in the user gesture (Web Bluetooth needs it).
//   ui.notify(fact)   facts of 8.3 (ready, action, nav, provider, calibration, bridgeProbe, bridge, recentered, roundOver, visibility, blur,
//                     motionWarning, shotFeedback).
//   ui.getState()     {screen, overlay, gameActive, resuming, calibrationStep, systemCursor, roundMode}; gameActive is the single source of truth
//                     for "call game.update" and for the `fire` intent (C-04).
//   ui.step(input)    per frame: {nowMs, dtS, snapshot, events, aim:{x, y, visible, trackingOk, speedDps?}}.
//   ui.getView()      read-only view model for the screen drawing code.
//
// Menus (C-07): the stick / arrow keys move a focus, A / Enter confirms, B / Esc goes back; the MOUSE may click and hover items. The pointer of a
// real Joy-Con never selects anything in a menu (no dwell, no pointer selection at all).
//
// UNVERIFIED-ON-HARDWARE: which Joy-Con buttons are comfortable when the controller is held like a pistol, the connect wording and the
// reconnect behaviour are assumptions; the UI only reacts to the facts it is given.

import { deriveConnectModel, errorText, isBusyState, nativeProgress } from './connect-model.js';
import { pointInTarget, targetAt } from './hit.js';
import { buildFocusUnits, nextFocus, unitOfTarget } from './focus.js';
import { SETTINGS_SPEC, bestScoreOf } from './storage.js';
import { MOTION_CONFIG } from '../motion/motion-config.js';
import { CLASSIC_ORDER, DIFFICULTIES, STAGES, screenTargets } from './layout-data.js';
import { t } from './strings.en.js';

/** Timings that are UI presentation rules (gameplay numbers stay in game/config.js). */
export const UI_TIMING = Object.freeze({
  safetyWaitMs: 2000,
  autoContinueMs: 1500, // connected -> calibration
  countdownNumberMs: 800,
  countdownGoMs: 600,
  resumeNumberMs: 700,
  toastMs: 2500,
  recenteredToastMs: 900,
  batteryToastGapMs: 5 * 60 * 1000,
  hintSeconds: 20, // the hint line shows during the first 20 s of a round
  discAutoReconnectMs: 2000,
  discNoProgressMs: 1500,
  discAttemptMaxMs: 25000,
  confirmLockMs: 220, // a Joy-Con "A" right after a screen or dialog change is ignored (a double tap must not run through two screens)
  navRepeatDelayMs: 450, // a stick held left / right on a stepper row: first repeat after this ...
  navRepeatMs: 120, // ... then one step per this
  navHoldMaxMs: 8000,
  pressedMs: 140,
  resultsSlideMs: 300,
  resultsLockMs: 900, // buttons of the results screen stay inert this long after the panel arrived (a trigger-happy finger must not skip it)
  resultsCountUpMs: 1200,
  resultsStampMs: 260, // the rank stamp lands this long after the count-up ended
  practiceTimeoutS: 20, // calibration step 4: "Calibrate again" appears after this or after 3 lost clays
  practiceLostForRetry: 3,
  zenEndFallbackMs: 1500, // "End session" waits this long for roundOver, then goes to the menu anyway
  calMessageMs: 2500,
  tuneMarkMs: 1200,
  holdMs: Object.freeze({
    1: (MOTION_CONFIG.calibration?.holdS?.pose1 ?? 2) * 1000,
    2: (MOTION_CONFIG.calibration?.holdS?.pose2 ?? 1.5) * 1000,
    3: (MOTION_CONFIG.calibration?.holdS?.autoCentreS ?? 3) * 1000,
    quick: (MOTION_CONFIG.calibration?.holdS?.quickCentre ?? 1.5) * 1000,
  }),
});

/** Fallback glyph labels per device (input/ fills ActionLabels; `fire` is new in Clay Rush, C-02). */
export const DEFAULT_LABELS = Object.freeze({
  joyconR: Object.freeze({ confirm: 'A', back: 'B', pause: '+', recenter: 'R', fire: 'ZR' }),
  joyconL: Object.freeze({ confirm: 'Down', back: 'Left', pause: '-', recenter: 'L', fire: 'ZL' }),
  keyboard: Object.freeze({ confirm: 'Enter', back: 'Esc', pause: 'P', recenter: 'C', fire: 'F' }),
  mouse: Object.freeze({ confirm: 'Click', back: 'Esc', pause: 'P', recenter: 'C', fire: 'Click' }),
});

const DISC_TEXT_MAX = 230;
const MENU_SCREENS = Object.freeze(['safety', 'connect', 'menu', 'setup', 'settings', 'best', 'tuning', 'results']);

/**
 * @param {{clock:import('../shared/contracts.js').Clock, storage:ReturnType<import('./storage.js').createStorage>,
 *          sfx?:(id:string, params?:object)=>void, sfxStop?:(id:string)=>void, hasBluetooth?:boolean}} deps
 */
export function createUi(deps) {
  const { clock, storage } = deps;
  const sfx = deps.sfx ?? (() => {});
  const sfxStop = deps.sfxStop ?? (() => {});
  const hasBluetooth = deps.hasBluetooth !== false;
  const handlers = new Set();
  const now = () => clock.now();

  // ---------------------------------------------------------------- state
  let screen = 'boot';
  let overlay = null; // null | 'disconnected' | 'confirm'
  let screenSince = 0;
  let screenGen = 0; // +1 at every screen change and every overlay change: a pointer release only clicks what was pressed in the same generation (F7)
  let roundMode = null;
  let resuming = false;
  let resumeStart = 0;
  let resumeLastN = 0;
  let origin = 'menu'; // where settings returns to: 'menu' | 'paused'
  let dirty = true;
  let stateCache = null;
  let pendingZenEndAt = null;

  let provider = { kind: null, transport: null, status: null, labels: null, capabilities: null };
  let joyconCalibrated = false;
  let calibratedFor = null;
  let sawStreaming = false;
  let autoContinueAt = null;
  let lastBatteryToastAt = -Infinity;
  let cameFromMenu = false;
  let connectWanted = null;
  let extendedTried = false;
  const bridgeInfo = { probe: 'unknown', reason: null, canBuild: false, built: false };
  let preferredPath = null;
  let bridgeProgress = null;
  const connectOpts = () => ({ hasBluetooth, extendedTried, bridge: bridgeInfo, progress: bridgeProgress, preferred: preferredPath });

  const settings0 = storage.getSettings();
  const lastRound = { mode: 'classic', difficulty: settings0.difficulty, stage: settings0.stage };
  const cal = { resumeRound: false, frozen: false, step: 1, phase: 'waiting', progress: 0, message: null, messageUntil: 0, quick: false, tryAgain: false, notice: null, elapsedS: 0, lost: 0, holdStarted: false, returnTo: 'menu' };
  const safety = { ready: false, progress: 0 };
  const setup = { mode: 'classic', difficulty: settings0.difficulty, stage: settings0.stage };
  const countdown = { start: 0, lastN: -1, n: 3, frac: 0, mode: 'classic', difficulty: 'normal', stage: 'meadow' };
  const results = { result: null, mode: null, isNewBest: false, best: null, previous: null, startedAt: 0, locked: true, lockLeft: 1, shownScore: 0, countDone: false, stamped: false, stampAt: 0, recordPlayed: false };
  const disc = { phase: 'waiting', since: 0, issuedAt: null, sawConnecting: false, retryEnabled: false, retryLeftS: 0, pausedGame: false, native: false, text: '', progressText: '', countdownS: null, countdownFrac: 0 };
  const confirm = { kind: null };
  const toast = { text: null, until: 0, from: 0 };
  const pause = { resumeN: 3, cause: 'user' };
  const tune = { speedDps: 0, approx: false, lastShot: null, marks: [], prevAim: null };
  const aim = { x: 960, y: 540, visible: false, trackingOk: false };
  const hover = { id: null };
  let pointer = null;
  let pressed = null; // {id, gen} of the last DOM mouse press (pointerDown / pointerUp)
  let targets = [];
  let pressedUntil = 0;
  const focus = { id: null, saved: null, layerOverlay: null, fallback: false };
  let units = [];
  const navHeld = { dir: null, since: 0, nextAt: 0 };
  let lastInputSource = null; // 'joycon' | 'keyboard' | 'mouse' | 'sim'
  let confirmLockUntil = 0;

  const view = {
    now: 0, screen, overlay, resuming, roundMode, calibrated: false, hasBluetooth, settings: settings0, provider, labels: DEFAULT_LABELS.keyboard,
    safety, connect: { ...deriveConnectModel(null, 0, connectOpts()), cameFromMenu: false }, cal, setup, countdown, results, disc, confirm, toast,
    pause, pausedBlur: false, tune, aim, hover, targets, baseTargets: targets, snapshot: null,
    menuBest: { classic: null, timeattack: null, zen: null },
    bestTable: [],
    focus: { id: null, ids: [], ring: null, valueRow: null },
    hint: { items: [], show: false },
    pressedId: null,
    zenEnding: false,
  };

  const touch = () => { dirty = true; stateCache = null; };

  function emit(intent) {
    for (const h of [...handlers]) {
      try {
        h(intent);
      } catch (err) {
        if (typeof console !== 'undefined') console.error('[clay-rush] intent handler threw', intent?.type, err);
      }
    }
  }

  function showToast(text, ms = UI_TIMING.toastMs) {
    toast.text = text;
    toast.from = now();
    toast.until = toast.from + ms;
  }

  // ---------------------------------------------------------------- labels (glyphs of the active controller)
  function deviceLabels() {
    const k = provider.kind;
    if (k === 'joycon') return provider.status?.side === 'L' ? DEFAULT_LABELS.joyconL : DEFAULT_LABELS.joyconR;
    if (k === 'mouse') return DEFAULT_LABELS.mouse;
    return DEFAULT_LABELS.keyboard;
  }

  /** The labels the hint line and the HUD show: the keyboard's after a key press, else the provider's (with `fire` filled in). */
  function effectiveLabels() {
    if (lastInputSource === 'keyboard' || (!provider.kind && lastInputSource !== 'mouse')) return DEFAULT_LABELS.keyboard;
    const base = deviceLabels();
    const p = provider.labels;
    if (!p) return base;
    return { confirm: p.confirm ?? base.confirm, back: p.back ?? base.back, pause: p.pause ?? base.pause, recenter: p.recenter ?? base.recenter, fire: p.fire ?? base.fire };
  }

  // ---------------------------------------------------------------- best scores
  function refreshBest() {
    const s = storage.getSettings();
    view.menuBest.classic = bestScoreOf(storage.getBest('classic', s.difficulty, null));
    view.menuBest.timeattack = bestScoreOf(storage.getBest('timeattack', s.difficulty, s.stage));
    view.menuBest.zen = null;
    const cellsFor = (mode, stage) => DIFFICULTIES.map((d) => {
      const e = storage.getBest(mode, d, stage);
      const score = bestScoreOf(e);
      return { difficulty: d, score, rank: e && typeof e === 'object' ? e.rank ?? null : null, assist: !!(e && e.assist) };
    });
    view.bestTable = [
      { mode: 'classic', stage: null, cells: cellsFor('classic', null) },
      ...STAGES.map((st) => ({ mode: 'timeattack', stage: st, cells: cellsFor('timeattack', st) })),
    ];
  }

  function aimReady() {
    const s = provider.status;
    if (!s || s.state !== 'streaming') return false;
    if (provider.kind === 'sim' || provider.kind === 'mouse') return true;
    return provider.kind === 'joycon' && joyconCalibrated;
  }

  /**
   * U-01: a real Joy-Con that streams WITHOUT a calibration has no crosshair (Motion never tracks): it must go through the wizard before the menu
   * or any play. True while that is the case.
   */
  const needsCalibration = () => provider.kind === 'joycon' && provider.status?.state === 'streaming' && !joyconCalibrated;
  /** The screens an uncalibrated Joy-Con may not reach (they lead to play). The connect screen is where it waits (its main button calibrates). */
  const GATED_SCREENS = Object.freeze(['menu', 'setup', 'best', 'settings', 'tuning', 'countdown', 'playing']);

  /**
   * Route an uncalibrated Joy-Con to calibration. In a round (playing, countdown, paused): the round stays paused and the wizard starts at once; it
   * returns to the pause panel and resumes the round (no practice round). Elsewhere: the connect screen, whose main button runs the wizard (no
   * back button there while calibration is missing), with a toast that says why.
   */
  function requireCalibration() {
    if (screen === 'playing' || screen === 'countdown' || screen === 'paused') {
      if (screen !== 'paused') {
        resuming = false;
        pause.cause = 'calibration';
        setScreen('paused', { force: true });
      }
      cal.resumeRound = roundMode !== null && roundMode !== 'practice';
      emit({ type: 'startCalibration' });
      return;
    }
    cal.resumeRound = false;
    setScreen('connect', { force: true });
    showToast(t('connect.needCalibration'));
  }

  function setScreen(next, opts = {}) {
    if (!opts.force && GATED_SCREENS.includes(next) && needsCalibration()) {
      if (next === 'countdown' || next === 'playing') { requireCalibration(); return; }
      next = 'connect';
      opts = { force: true };
      showToast(t('connect.needCalibration'));
    }
    const t0 = now();
    screenGen++;
    screen = next;
    screenSince = t0;
    view.pressedId = null;
    focus.id = null; focus.saved = null; navHeld.dir = null; hover.id = null;
    confirmLockUntil = t0 + UI_TIMING.confirmLockMs;
    if (next === 'menu') { refreshBest(); resuming = false; roundMode = null; pendingZenEndAt = null; view.zenEnding = false; }
    if (next === 'best') refreshBest();
    if (next === 'safety') { safety.ready = false; safety.progress = 0; }
    if (next === 'tuning') { tune.lastShot = null; tune.marks.length = 0; }
    if (next === 'connect') { cameFromMenu = !!opts.fromMenu; connectWanted = null; extendedTried = false; }
    if (next === 'results') { results.startedAt = t0; }
    touch();
  }

  // ---------------------------------------------------------------- round control
  function startRound(mode, difficulty, stage) {
    if (needsCalibration()) { requireCalibration(); return; } // U-01
    const s = storage.getSettings();
    const d = DIFFICULTIES.includes(difficulty) ? difficulty : s.difficulty;
    const st = mode === 'classic' ? CLASSIC_ORDER[0] : STAGES.includes(stage) ? stage : s.stage;
    lastRound.mode = mode; lastRound.difficulty = d; lastRound.stage = st;
    roundMode = mode;
    resuming = false;
    countdown.start = now();
    countdown.lastN = -1;
    countdown.n = 3;
    countdown.frac = 0;
    countdown.mode = mode;
    countdown.difficulty = d;
    countdown.stage = st;
    emit({ type: 'startRound', mode, difficulty: d, stage: st });
    setScreen('countdown');
  }

  function beginResume() {
    if (screen !== 'paused') return;
    if (needsCalibration()) { requireCalibration(); return; } // U-01: never resume a round without a crosshair
    setScreen('playing');
    resuming = true;
    resumeStart = now();
    resumeLastN = 0;
    pause.resumeN = 3;
    touch();
  }

  function pauseGame(cause) {
    if (overlay === 'disconnected' && cause !== 'disc') return;
    if (screen === 'calibration' && cal.step === 4 && (cause === 'blur' || cause === 'hidden')) {
      // U-04: the practice round freezes (gameActive false) until the next button press
      cal.frozen = true;
      touch();
      return;
    }
    if (!(screen === 'playing' || (screen === 'countdown' && cause !== 'user'))) return;
    resuming = false;
    pause.cause = cause;
    view.pausedBlur = cause === 'blur' || cause === 'hidden';
    setScreen('paused');
    sfx('uiBack');
  }

  function goMenuFromRound(reason) {
    emit({ type: 'endRound', reason });
    roundMode = null;
    resuming = false;
    setScreen('menu');
  }

  // ---------------------------------------------------------------- settings
  function applySetting(patch) {
    const settings = storage.updateSettings(patch);
    view.settings = settings;
    if ('difficulty' in patch) setup.difficulty = settings.difficulty;
    if ('stage' in patch) setup.stage = settings.stage;
    emit({ type: 'settingsChanged', patch, settings });
    if ('difficulty' in patch || 'stage' in patch) refreshBest();
    touch();
  }

  function stepSetting(key, dir) {
    const spec = SETTINGS_SPEC[key];
    if (!spec) return false;
    const cur = storage.getSettings()[key];
    const next = Number((cur + dir * spec.step).toFixed(3));
    if (next < spec.min - 1e-9 || next > spec.max + 1e-9) return false;
    applySetting({ [key]: next });
    return true;
  }

  function currentValue(rowKey) {
    return storage.getSettings()[rowKey];
  }

  // ---------------------------------------------------------------- calibration
  function resetCal(step, quick) {
    cal.frozen = false;
    cal.navFocus = false;
    cal.step = step; cal.phase = 'waiting'; cal.progress = 0; cal.message = null; cal.quick = !!quick;
    cal.tryAgain = false; cal.notice = null; cal.elapsedS = 0; cal.lost = 0; cal.holdStarted = false;
  }

  function endHoldSound() {
    if (cal.holdStarted) {
      cal.holdStarted = false;
      sfxStop('calHold');
    }
  }

  function leaveCalibration() {
    const back = cal.returnTo;
    cal.resumeRound = false;
    if (back === 'paused') {
      setScreen('paused');
      // still without a calibration (the wizard was cancelled): stay on the pause panel; its Resume runs the wizard again (U-01)
      if (!needsCalibration()) beginResume();
    } else {
      setScreen(back === 'connect' ? 'connect' : 'menu');
    }
  }

  function onCalibration(ev) {
    switch (ev.type) {
      case 'started': {
        if (overlay === 'disconnected' && (disc.phase === 'recovering' || disc.phase === 'recentering')) {
          disc.phase = 'recentering';
          touch();
          return;
        }
        const from = screen;
        cal.returnTo = from === 'paused' ? 'paused' : from === 'connect' ? 'connect' : 'menu';
        // a full wizard from the pause panel resumes the round only when it was started for it (requireCalibration)
        if (!ev.quick && cal.returnTo === 'paused' && !cal.resumeRound) cal.returnTo = 'menu';
        resetCal(ev.quick ? 3 : 1, ev.quick);
        setScreen('calibration');
        break;
      }
      case 'progress': {
        if (overlay === 'disconnected') {
          cal.progress = ev.progress;
          touch();
          return;
        }
        if (screen !== 'calibration' || cal.step === 4) return;
        if (ev.step !== cal.step && !(cal.quick && ev.step === 3)) {
          cal.step = ev.step;
          cal.progress = 0;
          endHoldSound();
        }
        cal.phase = ev.phase;
        cal.progress = ev.progress;
        if (ev.phase === 'holding' && !cal.holdStarted) {
          cal.holdStarted = true;
          sfx('calHold', { ms: cal.quick ? UI_TIMING.holdMs.quick : UI_TIMING.holdMs[ev.step] });
        } else if (ev.phase !== 'holding') {
          endHoldSound();
        }
        if (ev.phase === 'holding' && cal.message && now() >= cal.messageUntil) cal.message = null;
        break;
      }
      case 'stepPassed':
        if (overlay === 'disconnected' || screen !== 'calibration') return;
        endHoldSound();
        sfx('calStep');
        if (ev.step < 3) { cal.step = ev.step + 1; cal.phase = 'transition'; cal.progress = 0; cal.message = null; }
        break;
      case 'stepFailed': {
        if (overlay === 'disconnected') {
          if (ev.reason === 'timeout' || ev.reason === 'no_calibration') finishDisconnect();
          return;
        }
        endHoldSound();
        sfx('calFail');
        const key = { moved: 'cal.moved', bad_pose: 'cal.badPose', bad_accel: 'cal.badAccel', timeout: 'cal.timeout', no_data: 'cal.noData', no_calibration: 'cal.noCalibration' }[ev.reason] ?? 'cal.moved';
        cal.message = t(key);
        cal.messageUntil = now() + UI_TIMING.calMessageMs;
        cal.progress = 0;
        cal.phase = 'waiting';
        if (ev.reason === 'bad_pose') cal.step = 1;
        if (ev.reason === 'no_calibration' && cal.quick) { cal.quick = false; cal.step = 1; }
        break;
      }
      case 'done':
        endHoldSound();
        if (overlay === 'disconnected') {
          if (ev.quick) finishDisconnect();
          return;
        }
        joyconCalibrated = true;
        if (!ev.quick || !calibratedFor) calibratedFor = { side: provider.status?.side ?? '?', deviceName: provider.status?.deviceName ?? null };
        if (ev.quick) {
          sfx('calOk');
          resetCal(3, false);
          leaveCalibration();
        } else if (cal.resumeRound && cal.returnTo === 'paused') {
          // the wizard ran for a paused round (another Joy-Con after a reconnect, U-01): back to it, no practice round
          sfx('calOk');
          resetCal(1, false);
          showToast(t('cal.ok'));
          leaveCalibration();
        } else {
          // C-06: step 4 is a practice round; it ends on the first practice 'hit' event
          sfx('calStep');
          resetCal(4, false);
          if (Array.isArray(ev.warnings) && ev.warnings.includes('gyro sign undetermined')) {
            cal.notice = 'cal.signUnknown';
            cal.tryAgain = true;
          }
          if (screen !== 'calibration') setScreen('calibration');
          roundMode = 'practice';
          emit({ type: 'startRound', mode: 'practice', difficulty: 'easy', stage: 'hills' });
          touch();
        }
        break;
      case 'cancelled':
        endHoldSound();
        if (screen === 'calibration' && cal.step <= 3) leaveCalibration();
        break;
      default:
        break;
    }
    touch();
  }

  function practiceSucceeded() {
    sfx('calOk');
    emit({ type: 'endRound', reason: 'finished' });
    roundMode = null;
    resetCal(1, false);
    showToast(t('cal.ok'));
    setScreen('menu');
  }

  // ---------------------------------------------------------------- disconnect overlay
  function enterDisconnect() {
    if (overlay === 'disconnected') return;
    const t0 = now();
    const inRound = (screen === 'playing' || screen === 'countdown') && roundMode !== null && roundMode !== 'practice';
    if (screen === 'playing' || screen === 'countdown') {
      resuming = false;
      pause.cause = 'disc';
      setScreen('paused');
    } else if (screen === 'calibration') {
      endHoldSound();
      if (cal.step <= 3) emit({ type: 'cancelCalibration' });
      else emit({ type: 'endRound', reason: 'quit' });
      if (cal.step >= 4) roundMode = null; // a wizard run for a paused round keeps that round
      setScreen(cal.returnTo === 'paused' ? 'paused' : 'connect', { force: true });
    }
    overlay = 'disconnected';
    disc.native = provider.transport === 'native';
    disc.phase = disc.native ? 'failed' : 'waiting';
    disc.since = t0;
    disc.issuedAt = null;
    disc.sawConnecting = false;
    disc.retryEnabled = false;
    disc.retryLeftS = 0;
    disc.pausedGame = inRound;
    sfx('disconnect');
    touch();
  }

  function finishDisconnect() {
    if (overlay !== 'disconnected') return;
    overlay = null;
    const resumeGame = disc.pausedGame && screen === 'paused';
    disc.pausedGame = false;
    touch();
    if (resumeGame) beginResume();
  }

  function issueReconnect() {
    disc.phase = 'reconnecting';
    disc.issuedAt = now();
    disc.sawConnecting = false;
    emit({ type: 'reconnect' });
    touch();
  }

  function onProviderFactForDisconnect(prevState) {
    const s = provider.status;
    if (!s) return;
    if (provider.kind === 'mouse' && s.state === 'streaming') { finishDisconnect(); return; }
    if (provider.kind !== 'joycon' && provider.kind !== 'sim') return;
    if (s.state === 'requesting' || s.state === 'connecting' || s.state === 'initializing') {
      disc.phase = 'reconnecting';
      disc.sawConnecting = true;
      touch();
    } else if (s.state === 'streaming') {
      sfx('connectOk');
      if (joyconCalibrated || provider.kind === 'sim') {
        disc.phase = 'recovering';
        emit({ type: 'quickRecenter' });
      } else if (disc.pausedGame && screen === 'paused') {
        // U-01: the link came back on a unit without a calibration (the other Joy-Con): the round stays paused and the wizard runs first
        overlay = null;
        disc.pausedGame = false;
        touch();
        requireCalibration();
      } else {
        finishDisconnect();
      }
      touch();
    } else if ((s.state === 'lost' || s.state === 'error' || s.state === 'idle') && prevState !== s.state
      && (disc.phase === 'reconnecting' || disc.phase === 'recovering' || disc.phase === 'recentering')) {
      disc.phase = 'failed';
      touch();
    }
  }

  // ---------------------------------------------------------------- activation of targets
  function findTarget(id) {
    ensureFresh();
    for (const tg of targets) if (tg.id === id) return tg;
    return null;
  }

  function activate(id, via) {
    const tg = findTarget(id);
    const before = screen;
    const done = activateTarget(tg, via);
    if (done && tg && via !== 'auto' && before === screen) {
      view.pressedId = id;
      pressedUntil = now() + UI_TIMING.pressedMs;
    }
    return done;
  }

  /** A cell of a value row: a stepper step or a choice option. Setup rows (difficulty, stage) are settings too (the last choice is remembered). */
  function activateRowCell(tg) {
    if (tg.rowType === 'stepper') {
      const ok = stepSetting(tg.row, tg.step);
      if (ok) sfx('uiMove');
      return ok;
    }
    if (currentValue(tg.row) === tg.value) return true;
    applySetting({ [tg.row]: tg.value });
    sfx('uiSelect');
    return true;
  }

  function activateTarget(tg, via) {
    if (!tg || tg.enabled === false) return false;
    const id = tg.id;
    const s = storage.getSettings();
    if (tg.row) return activateRowCell(tg);
    switch (id) {
      // ---- safety
      case 'safety.toggle':
        applySetting({ reduceFlash: !s.reduceFlash });
        sfx('uiSelect');
        return true;
      case 'safety.ok':
        if (!safety.ready) return false;
        storage.setSafetyAck();
        sfx('uiSelect');
        setScreen(aimReady() ? 'menu' : 'connect');
        return true;
      // ---- connect
      case 'connect.main':
        extendedTried = false;
        touch();
        emit({ type: 'connect', provider: view.connect.native && view.connect.primary === 'native' ? 'native' : 'joycon' });
        return true;
      case 'connect.secondary':
        extendedTried = false;
        touch();
        emit({ type: 'connect', provider: view.connect.secondary.path === 'native' ? 'native' : 'joycon' });
        sfx('uiSelect');
        return true;
      case 'connect.cancel':
        bridgeProgress = null;
        touch();
        emit({ type: 'disconnect' });
        sfx('uiBack');
        return true;
      case 'connect.fallback':
        extendedTried = true;
        touch();
        emit({ type: 'connect', provider: 'joycon', filter: 'all' });
        return true;
      case 'connect.continue':
        sfx('uiSelect');
        autoContinueAt = null;
        if (joyconCalibrated) setScreen('menu');
        else emit({ type: 'startCalibration' });
        return true;
      case 'connect.calibrate':
        sfx('uiSelect');
        autoContinueAt = null;
        emit({ type: 'startCalibration' });
        return true;
      case 'connect.sim':
        connectWanted = 'sim';
        emit({ type: 'connect', provider: 'sim' });
        sfx('uiSelect');
        return true;
      case 'connect.mouse':
        connectWanted = 'mouse';
        emit({ type: 'connect', provider: 'mouse' });
        sfx('uiSelect');
        return true;
      case 'connect.diagnostics':
        emit({ type: 'openDiagnostics' });
        return true;
      case 'connect.back':
        sfx('uiBack');
        setScreen('menu');
        return true;
      // ---- calibration
      case 'cal.flip':
        applySetting({ flipX: !s.flipX });
        sfx('uiSelect');
        return true;
      case 'cal.retry':
        sfx('uiSelect');
        emit({ type: 'endRound', reason: 'quit' });
        roundMode = null;
        emit({ type: 'startCalibration' });
        resetCal(1, false);
        touch();
        return true;
      case 'cal.quick':
        sfx('uiSelect');
        emit({ type: 'quickRecenter' });
        return true;
      // ---- menu
      case 'menu.classic':
      case 'menu.timeattack':
      case 'menu.zen': {
        sfx('uiSelect');
        setup.mode = id.slice(5);
        setup.difficulty = s.difficulty;
        setup.stage = s.stage;
        setScreen('setup');
        return true;
      }
      case 'menu.best':
        sfx('uiSelect');
        setScreen('best');
        return true;
      case 'menu.settings':
        sfx('uiSelect');
        origin = 'menu';
        setScreen('settings');
        return true;
      case 'menu.controller':
        sfx('uiSelect');
        setScreen('connect', { fromMenu: true });
        return true;
      // ---- setup
      case 'setup.start':
        sfx('uiSelect');
        startRound(setup.mode, setup.difficulty, setup.stage);
        return true;
      case 'setup.back':
        sfx('uiBack');
        setScreen('menu');
        return true;
      // ---- best
      case 'best.back':
        sfx('uiBack');
        setScreen('menu');
        return true;
      // ---- settings
      case 'set.reset':
        sfx('uiSelect');
        confirm.kind = 'reset';
        overlay = 'confirm';
        touch();
        return true;
      case 'set.tune':
        sfx('uiSelect');
        setScreen('tuning');
        return true;
      case 'set.back':
        sfx('uiBack');
        setScreen(origin === 'paused' ? 'paused' : 'menu');
        return true;
      // ---- tuning
      case 'tune.back':
        sfx('uiBack');
        setScreen('settings');
        return true;
      // ---- pause
      case 'pause.resume':
        sfx('uiSelect');
        beginResume();
        return true;
      case 'pause.recentre':
        sfx('uiSelect');
        emit({ type: 'recenter' });
        return true;
      case 'pause.settings':
        sfx('uiSelect');
        origin = 'paused';
        setScreen('settings');
        return true;
      case 'pause.quit':
        sfx('uiSelect');
        if (roundMode === 'zen') {
          // Zen: "End session" shows the session results (the game ends the round, app.js reports roundOver)
          emit({ type: 'endRound', reason: 'finished' });
          pendingZenEndAt = now() + UI_TIMING.zenEndFallbackMs;
          view.zenEnding = true;
          touch();
          return true;
        }
        confirm.kind = 'quit';
        overlay = 'confirm';
        touch();
        return true;
      // ---- results
      case 'results.again':
        if (results.locked) return false;
        sfx('uiSelect');
        startRound(lastRound.mode, lastRound.difficulty, lastRound.stage);
        return true;
      case 'results.menu':
        if (results.locked) return false;
        sfx('uiBack');
        goMenuFromRound('finished');
        return true;
      // ---- confirm dialog
      case 'confirm.yes':
        sfx('uiSelect');
        overlay = null;
        if (confirm.kind === 'quit') {
          goMenuFromRound('quit');
        } else if (confirm.kind === 'reset') {
          storage.resetBest();
          refreshBest();
          showToast(t('settings.reset.done'));
        }
        confirm.kind = null;
        touch();
        return true;
      case 'confirm.no':
        sfx('uiBack');
        overlay = null;
        confirm.kind = null;
        touch();
        return true;
      // ---- disconnect overlay
      case 'disc.retry':
        sfx('uiSelect');
        issueReconnect();
        return true;
      case 'disc.cancel':
        sfx('uiBack');
        bridgeProgress = null;
        emit({ type: 'disconnect' });
        return true;
      case 'disc.mouse':
        sfx('uiSelect');
        disc.phase = 'switching';
        emit({ type: 'useMouse' });
        touch();
        return true;
      case 'disc.menu':
        sfx('uiSelect');
        emit({ type: 'endRound', reason: 'quit' });
        emit({ type: 'disconnect' });
        overlay = null;
        disc.pausedGame = false;
        roundMode = null;
        resuming = false;
        setScreen('menu');
        return true;
      default:
        void via;
        return false;
    }
  }

  // ---------------------------------------------------------------- focus (stick / arrow keys)
  function defaultFocus() {
    if (overlay === 'confirm') return 'confirm.no';
    if (overlay === 'disconnected') {
      if (disc.native && disc.phase === 'reconnecting') return 'disc.cancel';
      return disc.phase === 'failed' ? 'disc.retry' : null;
    }
    switch (screen) {
      case 'safety': return 'safety.ok';
      case 'connect': return targets.some((x) => x.id === 'connect.continue') ? 'connect.continue' : 'connect.main';
      case 'menu': return 'menu.classic';
      case 'setup': return 'setup.start';
      case 'paused': return 'pause.resume';
      case 'results': return 'results.again';
      case 'settings': return 'set.sensitivity.minus'; // F19: the first row
      case 'best': return 'best.back';
      case 'tuning': return 'tune.back';
      case 'calibration': return cal.step === 1 ? 'cal.quick' : cal.step === 4 && cal.tryAgain ? 'cal.retry' : null;
      default: return null;
    }
  }

  function focusTargets() {
    if (overlay) return targets;
    switch (screen) {
      case 'calibration':
        if (cal.step === 1) return targets.filter((x) => x.id === 'cal.quick');
        // step 4 (U-02): "Calibrate again" when offered; "Flip left and right" once the player pushed the stick (an A meant as "Pull!" must
        // never flip the axis by itself)
        if (cal.step !== 4) return [];
        return targets.filter((x) => (x.id === 'cal.retry' && cal.tryAgain) || (x.id === 'cal.flip' && (cal.navFocus || cal.tryAgain)));
      case 'paused': return resuming || view.zenEnding ? [] : targets;
      default: return MENU_SCREENS.includes(screen) ? targets : [];
    }
  }

  function publishFocus() {
    const u = focus.id ? units.find((x) => x.id === focus.id) : null;
    const f = view.focus;
    f.id = u ? u.id : null;
    f.ids = u ? u.cells : [];
    f.ring = u ? u.ring : null;
    f.valueRow = u && u.kind === 'row' ? { key: u.rowKey, type: u.rowType } : null;
  }

  function setFocus(id) {
    if (focus.id !== id) navHeld.dir = null;
    focus.id = id;
    focus.fallback = false;
    publishFocus();
    refreshHint(); // the hint depends on the focused unit (a stepper row has no "select")
  }

  function syncFocus() {
    if (focus.layerOverlay !== overlay) {
      screenGen++; // a dialog opened or closed: a press made before it never clicks inside it
      if (focus.layerOverlay === null) { focus.saved = focus.id; focus.id = null; }
      else if (overlay === null) { focus.id = focus.saved; focus.saved = null; }
      else focus.id = null;
      focus.layerOverlay = overlay;
      navHeld.dir = null;
      confirmLockUntil = now() + UI_TIMING.confirmLockMs;
    }
    units = buildFocusUnits(focusTargets());
    const cur = focus.id ? units.find((u) => u.id === focus.id) : null;
    if (!units.length) {
      focus.id = null;
    } else if (!cur || (!cur.enabled && !(screen === 'connect' && cur.id === 'connect.main'))) {
      // (the connect screen's main button keeps the focus while an attempt disables it: a second Enter does nothing, it never
      // starts the simulator or the mouse instead. Integrator fix, docs/contract-notes.md)
      const pref = defaultFocus();
      const pu = pref ? unitOfTarget(units, pref) : null;
      focus.id = pu && pu.enabled ? pu.id : (units.find((u) => u.enabled) ?? units[0]).id;
      focus.fallback = !(pu && pu.enabled); // the default target was disabled (e.g. "Connect Joy-Con" while the bridge is probed)
      navHeld.dir = null;
    } else if (focus.fallback) {
      // the player has not moved the focus since it fell back: it goes to the default target as soon as that is enabled (Integrator fix,
      // docs/contract-notes.md: Enter on the connect screen started the simulator once the bridge probe had finished)
      const pref = defaultFocus();
      const pu = pref ? unitOfTarget(units, pref) : null;
      if (pu && pu.enabled) {
        focus.id = pu.id;
        focus.fallback = false;
      }
    }
    publishFocus();
  }

  const focusedUnit = () => (focus.id ? units.find((u) => u.id === focus.id) ?? null : null);

  /** Stick left / right on a focused value row: one step of a stepper, the neighbouring option of a choice. True when the value changed. */
  function changeRowValue(unit, dir) {
    const sign = dir === 'left' ? -1 : dir === 'right' ? 1 : 0;
    if (!sign) return false;
    if (unit.rowType === 'stepper') {
      const cell = findTarget(unit.cells.find((c) => c.endsWith(sign < 0 ? '.minus' : '.plus')));
      return cell ? activate(cell.id, 'nav') : false;
    }
    const cells = unit.cells.map((c) => findTarget(c)).filter(Boolean);
    const i = cells.findIndex((c) => c.value === currentValue(unit.rowKey));
    const j = Math.max(0, Math.min(cells.length - 1, (i < 0 ? 0 : i) + sign));
    if (j === i) return false;
    return activate(cells[j].id, 'nav');
  }

  /** A / Enter on the focused unit: a button activates, a choice row moves to its next option (wrapping), a stepper does nothing. */
  function activateFocused() {
    const u = focusedUnit();
    if (!u) return false;
    if (u.kind === 'row') {
      if (u.rowType === 'stepper') return false;
      const cells = u.cells.map((c) => findTarget(c)).filter(Boolean);
      const i = cells.findIndex((c) => c.value === currentValue(u.rowKey));
      return activate(cells[(i + 1) % cells.length].id, 'key');
    }
    return activate(u.cells[0], 'key');
  }

  function noteInput(source) {
    if (source === 'joycon' || source === 'keyboard' || source === 'mouse' || source === 'sim') {
      if (lastInputSource !== source) { lastInputSource = source; touch(); }
    }
  }

  function handleNav(ev) {
    ensureFresh();
    noteInput(ev.source);
    if (ev.phase === 'up') {
      if (navHeld.dir === ev.dir) navHeld.dir = null;
      return;
    }
    if (screen === 'calibration' && cal.frozen) { cal.frozen = false; touch(); return; } // U-04: the first input after a blur only unfreezes
    if (screen === 'calibration' && cal.step === 4 && !cal.navFocus && overlay === null) {
      // the first stick push on the practice round shows the focus (on "Flip left and right")
      cal.navFocus = true;
      touch();
      ensureFresh();
      return;
    }
    const u = focusedUnit();
    if (!u) return;
    if ((ev.dir === 'left' || ev.dir === 'right') && u.kind === 'row') {
      changeRowValue(u, ev.dir);
      if (u.rowType === 'stepper') {
        const t0 = now();
        navHeld.dir = ev.dir;
        navHeld.since = t0;
        navHeld.nextAt = t0 + UI_TIMING.navRepeatDelayMs;
      }
      return;
    }
    navHeld.dir = null;
    const next = nextFocus(units, u.id, ev.dir);
    if (next) {
      setFocus(next.id);
      sfx('uiMove');
    }
  }

  function canGoBack() {
    if (overlay === 'confirm') return true;
    if (overlay === 'disconnected') return disc.native && disc.phase === 'reconnecting';
    switch (screen) {
      case 'settings': case 'tuning': case 'paused': case 'calibration': case 'setup': case 'best': return true;
      case 'connect': return view.connect.cameFromMenu || targets.some((x) => x.id === 'connect.cancel');
      case 'results': return !results.locked;
      default: return false;
    }
  }

  /** The bottom hint line: glyph labels of the active controller and what they do on this screen. */
  function refreshHint() {
    const labels = effectiveLabels();
    view.labels = labels;
    const items = [];
    const keyboard = lastInputSource === 'keyboard';
    const mouseOnly = provider.kind === 'mouse' && !keyboard;
    const moveKey = keyboard || !provider.kind ? t('hint.arrows') : provider.kind === 'joycon' ? t('hint.stick') : null;
    const selectKey = mouseOnly ? t('hint.click') : labels.confirm;
    const state = computeState();
    if (overlay === null && screen === 'calibration' && cal.step === 4 && cal.frozen) {
      items.push({ key: labels.confirm, label: t('hint.continue') });
    } else if (overlay === null && (state.gameActive || (screen === 'playing' && resuming))) {
      const ready = view.snapshot && view.snapshot.phase === 'ready';
      const inRoundHint = screen === 'calibration' || !view.snapshot || view.snapshot.t < UI_TIMING.hintSeconds || ready;
      if (inRoundHint && !resuming) {
        items.push({ key: labels.fire, label: t(ready ? 'hint.pull' : 'hint.fire') });
        if (screen === 'playing') {
          if (provider.kind !== 'mouse' || keyboard) items.push({ key: labels.recenter, label: t('hint.recentre') });
          items.push({ key: labels.pause, label: t('hint.pause') });
        } else {
          // practice round: "Calibrate again" / "Flip left and right" are selectable once focused (U-09)
          if (units.length && !mouseOnly) items.push({ key: labels.confirm, label: t('hint.select') });
          items.push({ key: labels.back, label: t('hint.back') });
        }
      }
    } else if (screen === 'calibration' && overlay === null) {
      if (cal.step === 3) items.push({ key: labels.confirm, label: t('hint.continue') });
      if (units.length && cal.step === 1) items.push({ key: selectKey, label: t('hint.select') });
      items.push({ key: labels.back, label: t('hint.back') });
    } else if (screen === 'countdown' && overlay === null) {
      if (!mouseOnly) items.push({ key: labels.recenter, label: t('hint.recentre') });
    } else if (units.length) {
      const row = view.focus.valueRow;
      if (moveKey && !mouseOnly) items.push({ key: moveKey, label: t(row ? 'hint.change' : 'hint.move') });
      if (!(row && row.type === 'stepper')) items.push({ key: selectKey, label: t('hint.select') });
      // tuning: a test shot (with the mouse a click on the field: one CLICK item says it already, F16)
      if (screen === 'tuning' && !overlay && !mouseOnly) items.push({ key: labels.fire, label: t('hint.fire') });
      // on the pause panel the back button resumes the round (U-09)
      if (canGoBack()) items.push({ key: labels.back, label: t(screen === 'paused' && !overlay ? 'hint.resume' : 'hint.back') });
    }
    view.hint.items = items;
    view.hint.show = items.length > 0;
  }


  // ---------------------------------------------------------------- actions (C-04: the UI is the only consumer of actions)
  function handleAction(ev) {
    ensureFresh();
    const a = ev.action;
    noteInput(ev.source);
    const locked = a === 'confirm' && ev.source === 'joycon' && now() < confirmLockUntil;
    if (screen === 'calibration' && cal.frozen && overlay === null) { cal.frozen = false; touch(); return; } // U-04: swallowed, it only unfreezes
    if (a === 'fire') {
      handleFire(ev);
      return;
    }
    if (overlay === 'confirm') {
      if (a === 'confirm') { if (!locked) activateFocused(); }
      else if (a === 'back') activate('confirm.no', 'key');
      return;
    }
    if (overlay === 'disconnected') {
      if (a === 'confirm' && interactiveContext()) { if (!locked) activateFocused(); }
      else if (a === 'back' && targets.some((x) => x.id === 'disc.cancel')) activate('disc.cancel', 'key');
      return;
    }
    switch (a) {
      case 'confirm': {
        if (screen === 'playing') {
          // C-04: in phase 'ready', A / Enter calls "Pull!" (a fire intent)
          if (getState().gameActive && view.snapshot && view.snapshot.phase === 'ready') emit({ type: 'fire', t: ev.t, source: ev.source });
          return;
        }
        if (screen === 'calibration') {
          if (cal.step === 3) emit({ type: 'confirmCenter' });
          else if (units.length && !locked) activateFocused();
          return;
        }
        if (screen === 'countdown' || screen === 'boot' || locked) return;
        if (units.length) activateFocused();
        return;
      }
      case 'back': {
        switch (screen) {
          case 'playing': pauseGame('user'); break;
          case 'paused': if (view.zenEnding) break; if (!resuming) beginResume(); else pauseGame('user'); break;
          case 'settings': activate('set.back', 'key'); break;
          case 'tuning': activate('tune.back', 'key'); break;
          case 'setup': activate('setup.back', 'key'); break;
          case 'best': activate('best.back', 'key'); break;
          case 'connect':
            if (findTarget('connect.cancel')) activate('connect.cancel', 'key');
            else if (view.connect.cameFromMenu) activate('connect.back', 'key'); // never while the Joy-Con needs its calibration (U-01)
            break;
          case 'calibration':
            endHoldSound();
            if (cal.step <= 3) {
              emit({ type: 'cancelCalibration' });
              leaveCalibration();
            } else {
              emit({ type: 'endRound', reason: 'quit' });
              roundMode = null;
              resetCal(1, false);
              setScreen('menu');
            }
            sfx('uiBack');
            break;
          case 'results': if (!results.locked) activate('results.menu', 'key'); break;
          default: break;
        }
        return;
      }
      case 'pause':
        if (screen === 'playing') pauseGame('user');
        else if (screen === 'paused' && !view.zenEnding) beginResume();
        return;
      case 'recenter':
        if (screen === 'calibration') {
          if (cal.step === 3) emit({ type: 'confirmCenter' });
          else if (cal.step === 4) emit({ type: 'recenter' });
        } else if (screen === 'menu' || screen === 'countdown' || screen === 'playing' || screen === 'paused' || screen === 'tuning' || screen === 'setup') {
          emit({ type: 'recenter' });
        }
        return;
      default:
    }
  }

  /** The trigger (C-04): a `fire` intent only while the game is active; on the tuning screen a test shot marker (no game, no intent). */
  function handleFire(ev) {
    if (overlay !== null) return;
    if (getState().gameActive) {
      emit({ type: 'fire', t: ev.t, source: ev.source });
      return;
    }
    if (screen !== 'tuning') return;
    // a mouse press is also the start of a click: it is a test shot only when it did not land on a button (C-03)
    const at = ev.source === 'mouse' && pointer ? pointer : aim;
    if (ev.source === 'mouse' && targetAt(targets, at.x, at.y)) return;
    tune.marks.push({ x: at.x, y: at.y, at: now() });
    if (tune.marks.length > 6) tune.marks.shift();
    sfx('shot');
  }

  // ---------------------------------------------------------------- facts
  function notify(fact) {
    if (!fact || typeof fact !== 'object') return;
    switch (fact.type) {
      case 'ready': {
        if (screen !== 'boot') return;
        const streaming = provider.status?.state === 'streaming';
        if (!storage.getSafetyAck() && !fact.skipSafety) setScreen('safety');
        else if ((provider.kind === 'sim' || provider.kind === 'mouse') && streaming) setScreen('menu');
        else setScreen('connect');
        break;
      }
      case 'action':
        if (fact.event) handleAction(fact.event);
        break;
      case 'nav':
        if (fact.event) handleNav(fact.event);
        break;
      case 'provider': onProviderFact(fact); break;
      case 'calibration':
        if (fact.event) onCalibration(fact.event);
        break;
      case 'bridgeProbe': {
        bridgeInfo.probe = fact.phase === 'checking' ? 'checking' : fact.available === true ? 'available' : 'unavailable';
        bridgeInfo.reason = typeof fact.reason === 'string' ? fact.reason : null;
        bridgeInfo.canBuild = fact.canBuild === true;
        bridgeInfo.built = fact.built === true;
        if (fact.preferred === 'native' || fact.preferred === 'chrome') preferredPath = fact.preferred;
        else if (fact.preferred === null) preferredPath = null;
        touch();
        break;
      }
      case 'bridge':
        bridgeProgress = { phase: fact.phase, key: fact.key ?? null, scanStartedAt: fact.scanStartedAt ?? null, scanSeconds: fact.scanSeconds ?? null };
        touch();
        break;
      case 'recentered':
        showToast(t('hud.recentered'), UI_TIMING.recenteredToastMs);
        sfx('recenter');
        break;
      case 'roundOver': onRoundOver(fact.result); break;
      case 'shotFeedback':
        tune.lastShot = {
          jerkPeakDps: Number.isFinite(fact.jerkPeakDps) ? fact.jerkPeakDps : null,
          displacementPx: Number.isFinite(fact.displacementPx) ? fact.displacementPx : null,
          compMs: Number.isFinite(fact.compMs) ? fact.compMs : null,
          valid: fact.valid === true,
          at: now(),
        };
        touch();
        break;
      case 'visibility':
        navHeld.dir = null;
        if (fact.hidden) pauseGame('hidden');
        break;
      case 'blur':
        navHeld.dir = null;
        pauseGame('blur');
        break;
      case 'motionWarning':
      default:
        break;
    }
    refreshDerived();
  }

  function onProviderFact(fact) {
    const prevKind = provider.kind;
    const prevState = prevKind === fact.kind ? (provider.status?.state ?? null) : null;
    provider = { kind: fact.kind, transport: fact.transport ?? (fact.kind === 'joycon' ? 'bluetooth' : null), status: fact.status, labels: fact.labels, capabilities: fact.capabilities };
    view.provider = provider;
    if (!isBusyState(fact.status?.state)) bridgeProgress = null;
    if (prevKind !== fact.kind) {
      if (fact.kind !== 'joycon') { joyconCalibrated = false; calibratedFor = null; }
      sawStreaming = false;
    }
    const state = fact.status?.state ?? null;
    if (state !== 'streaming') navHeld.dir = null;
    // another unit (side, device name) than the one calibrated needs its own calibration
    if (fact.kind === 'joycon' && state === 'streaming' && joyconCalibrated && calibratedFor) {
      const side = fact.status.side;
      const name = fact.status.deviceName ?? null;
      const otherSide = side && side !== '?' && calibratedFor.side && calibratedFor.side !== '?' && side !== calibratedFor.side;
      const otherName = name && calibratedFor.deviceName && name !== calibratedFor.deviceName;
      if (otherSide || otherName) {
        joyconCalibrated = false;
        calibratedFor = null;
        emit({ type: 'clearCalibration' });
      }
    }
    if (screen === 'connect' && (fact.kind === 'sim' || fact.kind === 'mouse') && state === 'streaming' && (!cameFromMenu || connectWanted === fact.kind)) {
      sfx('connectOk');
      connectWanted = null;
      setScreen('menu');
    }
    const device = fact.kind === 'joycon' || fact.kind === 'sim';
    if (device && state === 'streaming' && prevState !== 'streaming') {
      if (fact.kind === 'joycon') extendedTried = false;
      if (fact.kind === 'joycon' && screen === 'connect') {
        sfx('connectOk');
        if (!(cameFromMenu && joyconCalibrated)) autoContinueAt = now() + UI_TIMING.autoContinueMs;
      }
      sawStreaming = true;
    }
    if (device && state === 'lost' && prevState !== 'lost' && sawStreaming && overlay !== 'disconnected') enterDisconnect();
    else if (overlay === 'disconnected') onProviderFactForDisconnect(prevState);
    // U-01: a Joy-Con streams without a calibration (a new unit, or the other one after its calibration was cleared) while a gated screen is
    // up: to the wizard (in a round) or to the connect screen, which continues into the wizard by itself
    if (overlay === null && needsCalibration() && GATED_SCREENS.includes(screen)) {
      const inRound = screen === 'playing' || screen === 'countdown';
      requireCalibration();
      if (!inRound && screen === 'connect') autoContinueAt = now() + UI_TIMING.autoContinueMs;
    }
    const lvl = fact.status?.battery?.level;
    if ((lvl === 'low' || lvl === 'critical') && now() - lastBatteryToastAt >= UI_TIMING.batteryToastGapMs && screen !== 'boot') {
      lastBatteryToastAt = now();
      showToast(t('hud.lowBattery'));
    }
    touch();
  }

  function onRoundOver(r) {
    if (!r || r.mode === 'practice') return;
    // a round the player already left (quit to the menu) shows no results
    if (!(screen === 'playing' || screen === 'paused' || screen === 'countdown')) return;
    const rec = storage.recordResult(r);
    storage.addPlayMs(Math.max(0, Math.round((r.durationS ?? 0) * 1000)));
    results.result = r;
    results.mode = r.mode;
    results.isNewBest = rec.isNewBest;
    results.best = bestScoreOf(rec.best);
    results.previous = bestScoreOf(rec.previous);
    results.shownBest = rec.isNewBest ? results.previous : results.best;
    results.locked = true;
    results.lockLeft = 1;
    results.shownScore = 0;
    results.countDone = false;
    results.stamped = false;
    results.stampAt = 0;
    results.recordPlayed = false;
    lastRound.mode = r.mode;
    if (r.difficulty) lastRound.difficulty = r.difficulty;
    if (r.stageId) lastRound.stage = r.stageId;
    resuming = false;
    overlay = overlay === 'confirm' ? null : overlay;
    pendingZenEndAt = null;
    view.zenEnding = false;
    setScreen('results');
    refreshBest();
  }

  // ---------------------------------------------------------------- per-frame
  function interactiveContext() {
    if (overlay === 'confirm') return true;
    if (overlay === 'disconnected') return disc.phase === 'failed' || (disc.native && disc.phase === 'reconnecting');
    if (screen === 'paused') return !resuming && !view.zenEnding;
    if (screen === 'calibration') return cal.step === 1 || (cal.step === 4 && cal.tryAgain);
    return MENU_SCREENS.includes(screen);
  }

  function refreshDiscText(t0) {
    if (!disc.native) return;
    const st = provider.status;
    const own = st && st.error?.native?.code !== 'lost_signal' ? errorText(st, t0) : '';
    disc.text = own && own.length <= DISC_TEXT_MAX ? own : t('disc.native.text');
    if (disc.phase === 'reconnecting') {
      const p = nativeProgress(bridgeProgress, t0);
      disc.progressText = p.text;
      disc.countdownS = p.countdownS;
      disc.countdownFrac = p.countdownFrac;
    }
  }

  function ensureFresh() {
    if (dirty) refreshDerived();
  }

  function refreshDerived() {
    const t0 = now();
    view.now = t0;
    view.screen = screen;
    view.overlay = overlay;
    view.resuming = resuming;
    view.roundMode = roundMode;
    view.calibrated = aimReady() || joyconCalibrated;
    if (screen === 'connect' || dirty) view.connect = { ...deriveConnectModel(provider, t0, connectOpts()), cameFromMenu: cameFromMenu && !needsCalibration(), calibrated: joyconCalibrated };
    if (overlay === 'disconnected') refreshDiscText(t0);
    if (dirty) {
      targets = screenTargets(view);
      // U-07: a setting forced by a URL flag shows its forced value and cannot be changed (a click would store a value the player never sees)
      if (typeof storage.isOverridden === 'function') {
        for (const tg of targets) {
          const key = tg.row ?? (tg.id === 'safety.toggle' ? 'reduceFlash' : null);
          if (key && storage.isOverridden(key)) tg.enabled = false;
        }
      }
      view.targets = targets;
      // the screen under an overlay is still drawn with its controls (not selectable): its own targets, for drawing only
      view.baseTargets = overlay ? screenTargets({ ...view, overlay: null }) : targets;
      stateCache = null;
      dirty = false;
      syncFocus();
    }
    refreshHint();
  }

  function stepTuning(t0, input) {
    const a = input.aim;
    const s = storage.getSettings();
    if (a && Number.isFinite(a.speedDps)) {
      tune.speedDps = tune.speedDps * 0.7 + a.speedDps * 0.3;
      tune.approx = false;
    } else if (a && a.visible && tune.prevAim && input.dtS > 0) {
      // no deg/s from motion: estimate it from the cursor speed and the slow end of the shooting aim curve (I-05: MOTION_CONFIG.shooter)
      const pxs = Math.hypot(a.x - tune.prevAim.x, a.y - tune.prevAim.y) / input.dtS;
      const gLo = MOTION_CONFIG.shooter?.aimCurves?.[s.aimCurve]?.gLoPxDeg ?? MOTION_CONFIG.shooter?.pointer?.gLoPxDeg ?? 8;
      const dps = pxs / (gLo * (s.sensitivity || 1));
      tune.speedDps = tune.speedDps * 0.8 + dps * 0.2;
      tune.approx = true;
    }
    tune.prevAim = a && a.visible ? { x: a.x, y: a.y } : null;
    while (tune.marks.length && t0 - tune.marks[0].at > UI_TIMING.tuneMarkMs) tune.marks.shift();
  }

  /** Advance UI timers. @param {{nowMs:number, dtS:number, snapshot:object|null, events:object[], aim?:object}} input */
  function step(input) {
    const t0 = input.nowMs;
    if (view.pressedId !== null && t0 >= pressedUntil) view.pressedId = null;
    view.snapshot = input.snapshot ?? null;
    view.settings = storage.getSettings();
    const a = input.aim;
    if (a) {
      aim.x = Number.isFinite(a.x) ? a.x : aim.x;
      aim.y = Number.isFinite(a.y) ? a.y : aim.y;
      aim.visible = a.visible === true;
      aim.trackingOk = a.trackingOk === true;
    }
    const snap = view.snapshot;

    // ---- events the UI cares about: the practice round of calibration step 4 (C-06)
    for (const ev of input.events ?? []) {
      if (ev.type !== 'practice' || screen !== 'calibration' || cal.step !== 4 || overlay !== null) continue;
      if (ev.phase === 'hit') { practiceSucceeded(); break; }
      if (ev.phase === 'lost') {
        cal.lost++;
        if (cal.lost >= UI_TIMING.practiceLostForRetry && !cal.tryAgain) { cal.tryAgain = true; touch(); }
      }
    }
    if (screen === 'calibration' && cal.step === 4 && snap && snap.mode === 'practice') {
      cal.elapsedS = snap.t;
      if (snap.t >= UI_TIMING.practiceTimeoutS && !cal.tryAgain) { cal.tryAgain = true; touch(); }
    }

    switch (screen) {
      case 'safety': {
        const el = t0 - screenSince;
        safety.progress = Math.min(1, el / UI_TIMING.safetyWaitMs);
        // when "Got it" unlocks it takes the focus (it was disabled, so the focus had fallen back to the flash switch)
        if (!safety.ready && el >= UI_TIMING.safetyWaitMs) { safety.ready = true; focus.id = null; touch(); }
        break;
      }
      case 'connect':
        if (autoContinueAt !== null && t0 >= autoContinueAt) {
          autoContinueAt = null;
          if (provider.kind === 'joycon' && provider.status?.state === 'streaming') activate('connect.continue', 'auto');
        }
        break;
      case 'countdown': {
        const el = t0 - countdown.start;
        const N = UI_TIMING.countdownNumberMs;
        const total = 3 * N + UI_TIMING.countdownGoMs;
        const n = el < 3 * N ? 3 - Math.floor(Math.max(0, el) / N) : 0;
        countdown.n = n;
        countdown.frac = n > 0 ? (Math.max(0, el) % N) / N : Math.min(1, (el - 3 * N) / UI_TIMING.countdownGoMs);
        if (n !== countdown.lastN) {
          countdown.lastN = n;
          sfx(n > 0 ? 'countdown' : 'go', n > 0 ? { n } : undefined);
        }
        if (el >= total) setScreen('playing');
        break;
      }
      case 'results': {
        const el = t0 - results.startedAt;
        const live = Math.max(0, el - UI_TIMING.resultsSlideMs);
        results.lockLeft = Math.max(0, 1 - live / UI_TIMING.resultsLockMs);
        const wasLocked = results.locked;
        results.locked = live < UI_TIMING.resultsLockMs;
        if (wasLocked && !results.locked) touch();
        const reduced = view.settings.reduceMotion;
        const target = results.result?.score ?? 0;
        const p = reduced ? 1 : Math.min(1, live / UI_TIMING.resultsCountUpMs);
        const shown = Math.round(target * (1 - (1 - p) ** 3));
        if (shown !== results.shownScore && p < 1 && target > 0 && Math.floor(live / 70) !== Math.floor((live - input.dtS * 1000) / 70)) sfx('countTick', { progress: p });
        results.shownScore = shown;
        if (p >= 1 && !results.countDone) { results.countDone = true; results.stampAt = t0 + (reduced ? 0 : UI_TIMING.resultsStampMs); }
        if (results.countDone && !results.stamped && t0 >= results.stampAt) {
          results.stamped = true;
          if (results.result?.rank) sfx('rankStamp');
        }
        // the best line: the previous best until the stamp (a new best then shows NEW BEST!), never the score just made during the count-up
        results.shownBest = results.isNewBest && !results.stamped ? results.previous : results.best;
        if (results.stamped && results.isNewBest && !results.recordPlayed) {
          results.recordPlayed = true;
          sfx('record');
        }
        break;
      }
      case 'tuning':
        stepTuning(t0, input);
        break;
      default:
        break;
    }

    // ---- Zen "End session": no roundOver arrived in time -> the menu
    if (pendingZenEndAt !== null && t0 >= pendingZenEndAt && overlay === null) { // U-08: never under an open overlay
      pendingZenEndAt = null;
      view.zenEnding = false;
      roundMode = null;
      setScreen('menu');
    }

    // ---- resume countdown
    if (resuming) {
      const el = t0 - resumeStart;
      const n = 3 - Math.floor(el / UI_TIMING.resumeNumberMs);
      if (n !== resumeLastN && n >= 1) { resumeLastN = n; sfx('countdown', { n }); }
      if (el >= 3 * UI_TIMING.resumeNumberMs) {
        resuming = false;
        touch();
      }
      pause.resumeN = Math.max(1, n);
    }

    if (toast.text && t0 >= toast.until) toast.text = null;

    // ---- disconnect overlay timers
    if (overlay === 'disconnected') {
      if (disc.phase === 'waiting' && t0 - disc.since >= UI_TIMING.discAutoReconnectMs) issueReconnect();
      if (disc.phase === 'reconnecting' && disc.issuedAt !== null && !disc.native) {
        const since = t0 - disc.issuedAt;
        if ((!disc.sawConnecting && since > UI_TIMING.discNoProgressMs) || since > UI_TIMING.discAttemptMaxMs) { disc.phase = 'failed'; touch(); }
      }
      if (disc.phase === 'failed') {
        const until = provider.status?.cooldownUntil ?? 0;
        const left = Math.max(0, Math.ceil((until - t0) / 1000));
        const enabled = left === 0;
        if (enabled !== disc.retryEnabled || left !== disc.retryLeftS) { disc.retryEnabled = enabled; disc.retryLeftS = left; touch(); }
      }
    }

    if (screen === 'connect') {
      const m = deriveConnectModel(provider, t0, connectOpts());
      const c = view.connect;
      if (m.buttonEnabled !== c.buttonEnabled || m.buttonText !== c.buttonText || m.showContinue !== c.showContinue || m.mode !== c.mode
        || m.showFallback !== c.showFallback || m.hintText !== c.hintText || m.native !== c.native || m.primary !== c.primary
        || m.cancel !== c.cancel || m.secondary.show !== c.secondary.show || m.secondary.enabled !== c.secondary.enabled
        || m.secondary.path !== c.secondary.path || m.pillText !== c.pillText || m.countdownS !== c.countdownS) touch();
    }

    refreshDerived();

    // ---- a stick held left or right on a stepper row: auto-repeat
    if (navHeld.dir !== null) {
      const u = focusedUnit();
      if (!u || u.kind !== 'row' || u.rowType !== 'stepper' || t0 - navHeld.since > UI_TIMING.navHoldMaxMs || !interactiveContext()) {
        navHeld.dir = null;
      } else {
        let n = 0;
        while (t0 >= navHeld.nextAt && n < 4) {
          changeRowValue(u, navHeld.dir);
          navHeld.nextAt += UI_TIMING.navRepeatMs;
          n++;
        }
        if (t0 >= navHeld.nextAt) navHeld.nextAt = t0 + UI_TIMING.navRepeatMs;
      }
    }
    refreshDerived();
  }

  // ---------------------------------------------------------------- pointer events (DOM mouse only, never the Joy-Con pointer: C-07)
  function pointerMove(x, y) {
    pointer = { x, y };
    ensureFresh();
    if (!interactiveContext()) { hover.id = null; return; }
    const tg = targetAt(targets, x, y);
    const id = tg ? tg.id : null;
    if (id !== hover.id) {
      hover.id = id;
      if (tg) {
        const u = unitOfTarget(units, tg.id);
        if (u && u.id !== focus.id) { setFocus(u.id); sfx('uiMove'); }
      }
    }
  }

  /** A click at playfield coordinates. Returns true when it activated a target. Intents fire synchronously. */
  function pointerClick(x, y) {
    pointer = { x, y };
    refreshDerived();
    if (!interactiveContext() && overlay === null && screen !== 'calibration') return false;
    for (const tg of targets) {
      if (tg.enabled !== false && pointInTarget(tg, x, y)) {
        const u = unitOfTarget(units, tg.id);
        if (u) setFocus(u.id);
        const done = activate(tg.id, 'click');
        refreshDerived();
        return done;
      }
    }
    return false;
  }

  /**
   * The DOM mouse button went down at playfield (x, y): remember what it was over and in which screen generation. Only the release of THIS press
   * can click (F7: the press that shoots the practice clay ends calibration; its release must not click the menu card under the cursor).
   */
  function pointerDown(x, y) {
    pointer = { x, y };
    refreshDerived();
    const tg = targetAt(targets, x, y);
    pressed = { id: tg ? tg.id : null, gen: screenGen };
  }

  /** The DOM mouse button came up: a click only when the press started on the same target of the same screen (and dialog). */
  function pointerUp(x, y) {
    const p = pressed;
    pressed = null;
    refreshDerived();
    if (!p || p.gen !== screenGen || p.id === null) return false;
    const tg = targetAt(targets, x, y);
    if (!tg || tg.id !== p.id) return false;
    return pointerClick(x, y);
  }

  // ---------------------------------------------------------------- state / force
  function computeState() {
    const calStepValue = screen === 'calibration' ? cal.step : null;
    const gameActive = (screen === 'playing' || (screen === 'calibration' && cal.step === 4 && !cal.frozen)) && overlay === null && !resuming;
    // the OS cursor shows on every menu; it hides while the world draws the crosshair (play, practice, tuning, countdown)
    const systemCursor = !(gameActive || screen === 'tuning' || screen === 'countdown' || (screen === 'playing' && resuming)) || overlay !== null;
    return { screen, overlay, gameActive, resuming, calibrationStep: calStepValue, systemCursor, roundMode };
  }

  function getState() {
    if (!stateCache) stateCache = computeState();
    return stateCache;
  }

  /** Debug/test only: jump to a screen with no animation and no intents. */
  function force(next, opts = {}) {
    overlay = null;
    resuming = false;
    if (opts.roundMode !== undefined) roundMode = opts.roundMode;
    if (next === 'calibration') resetCal(opts.step ?? 1, !!opts.quick);
    if (next === 'setup') {
      const s = storage.getSettings();
      setup.mode = opts.mode ?? 'classic'; setup.difficulty = s.difficulty; setup.stage = s.stage;
    }
    if (next === 'results' && (!results.result || opts.result)) {
      results.result = opts.result ?? {
        mode: roundMode && roundMode !== 'practice' ? roundMode : 'classic', difficulty: 'normal', stageId: null, score: 0, presented: 0, broken: 0, lost: 0,
        shots: 0, hits: 0, accuracy: null, bestStreak: 0, doubles: 0, centre: 0, durationS: 0, endReason: 'complete', rank: 'D', assist: false,
      };
      results.mode = results.result.mode;
      results.isNewBest = false;
      results.shownBest = results.best;
      results.shownScore = results.result.score;
      results.countDone = true;
      results.stamped = true;
      results.locked = false;
      results.lockLeft = 0;
    }
    if (next === 'safety') safety.ready = false;
    if (next === 'countdown') {
      countdown.start = now();
      countdown.lastN = -1;
      countdown.mode = roundMode ?? 'classic';
      const s = storage.getSettings();
      countdown.difficulty = s.difficulty;
      countdown.stage = countdown.mode === 'classic' ? CLASSIC_ORDER[0] : s.stage;
    }
    setScreen(next, opts);
    if (next === 'results') results.startedAt = now() - UI_TIMING.resultsSlideMs - UI_TIMING.resultsLockMs - UI_TIMING.resultsCountUpMs;
    refreshDerived();
  }

  refreshBest();
  refreshDerived();

  return {
    onIntent(fn) {
      handlers.add(fn);
      return () => handlers.delete(fn);
    },
    notify,
    getState,
    getView: () => { ensureFresh(); return view; },
    toast(text, ms) { showToast(text, ms); },
    force,
    step,
    pointerMove,
    pointerClick,
    pointerDown,
    pointerUp,
    activate: (id) => { ensureFresh(); const done = activate(id, 'key'); refreshDerived(); return done; },
    findTarget,
    getTargets: () => { ensureFresh(); return targets; },
    getUnits: () => { ensureFresh(); return units; },
    getPointer: () => pointer,
  };
}
