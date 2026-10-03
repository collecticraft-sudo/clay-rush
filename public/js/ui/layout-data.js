// Screen layouts as pure data: where every selectable target of Clay Rush lives (logical 1920 x 1080 px). OWNER: UI engineer.
// No canvas access. The UI state machine uses this for hit testing and focus navigation, and the screen drawing code reads the same rectangles,
// so what is drawn is exactly what is clickable.
//
// A Target is described by its CENTRE: {id, shape:'rect', x, y, w, h, enabled, primary?, row?, rowType?, value?, span?}.
//   row      the key of a VALUE ROW the target is a cell of (a settings row, the difficulty or stage choice of the setup screen): focus.js groups
//            the cells of a row into one focus unit; stick left / right then changes the value.
//   rowType  'stepper' (cells "-" and "+") or 'choice' (one cell per option, `value` = the option).
//   span     [x0, x1]: the navigation bounds of the row (the whole column), so the rows above and below find it.
// Every target is at least 84 px high (design 10: minimum target 84 px).

import { SETTINGS_ENUMS } from './storage.js';

export const MODES = Object.freeze(['classic', 'timeattack', 'zen']);
export const DIFFICULTIES = SETTINGS_ENUMS.difficulty;
export const STAGES = SETTINGS_ENUMS.stage;
/** Classic plays the three stages in this order (design 7.1). Local copy: game/config.js owns the real stage table. */
export const CLASSIC_ORDER = Object.freeze(['meadow', 'hills', 'alpine']);

/** The bottom hint line ("[A] Select  [B] Back"), centred on every screen. */
export const HINT_LINE = Object.freeze({ x: 960, y: 1048, h: 52 });
/** Focus ring: distance from the target rectangle, stroke width, corner radius. */
export const FOCUS_RING = Object.freeze({ pad: 8, width: 6, radius: 26 });

// ---------------------------------------------------------------------------------------------------------------- menu
export const MENU_LOGO = Object.freeze({ cx: 960, top: 26, w: 560, h: 286 });
export const MENU_TAGLINE_Y = 352;
export const MENU_CARDS = Object.freeze([
  Object.freeze({ id: 'menu.classic', mode: 'classic', x: 400, y: 565, w: 500, h: 330 }),
  Object.freeze({ id: 'menu.timeattack', mode: 'timeattack', x: 960, y: 565, w: 500, h: 330 }),
  Object.freeze({ id: 'menu.zen', mode: 'zen', x: 1520, y: 565, w: 500, h: 330 }),
]);
export const MENU_BUTTONS = Object.freeze([
  Object.freeze({ id: 'menu.best', x: 520, y: 860, w: 400, h: 92, labelKey: 'menu.bestScores' }),
  Object.freeze({ id: 'menu.settings', x: 960, y: 860, w: 400, h: 92, labelKey: 'menu.settings' }),
  Object.freeze({ id: 'menu.controller', x: 1400, y: 860, w: 400, h: 92, labelKey: 'menu.controller' }),
]);
export const PROVIDER_CHIP = Object.freeze({ x: 1830, y: 60, h: 56 });

// ---------------------------------------------------------------------------------------------------------------- setup
export const SETUP = Object.freeze({
  titleY: 140,
  descY: 196,
  difficultyLabelY: 280,
  difficultyY: 345,
  difficultyCell: Object.freeze({ w: 300, h: 96, gap: 24 }),
  difficultyDescY: 440,
  stageLabelY: 520,
  stageY: 680,
  stageCard: Object.freeze({ w: 460, h: 230, gap: 40 }),
  buttonsY: 920,
  back: Object.freeze({ x: 700, w: 380, h: 100 }),
  start: Object.freeze({ x: 1220, w: 480, h: 100 }),
});

// ---------------------------------------------------------------------------------------------------------------- settings
export const SETTINGS_COLS = Object.freeze({ left: Object.freeze({ x0: 90, x1: 930 }), right: Object.freeze({ x0: 990, x1: 1830 }) });
export const SETTINGS_GRID = Object.freeze({ titleY: 96, groupY: 166, firstY: 230, pitch: 96, cellH: 84, controlW: 480, labelPad: 24, descY: 900, buttonsY: 968 });
/** The rows of the settings screen, column by column (docs/architecture.md 8.4). `options` of a toggle are [false, true]. */
export const SETTINGS_ROWS = Object.freeze([
  Object.freeze({ key: 'sensitivity', type: 'stepper', col: 'left' }),
  Object.freeze({ key: 'aimCurve', type: 'choice', col: 'left', options: SETTINGS_ENUMS.aimCurve }),
  Object.freeze({ key: 'triggerButton', type: 'choice', col: 'left', options: SETTINGS_ENUMS.triggerButton }),
  Object.freeze({ key: 'triggerCompMs', type: 'stepper', col: 'left' }),
  Object.freeze({ key: 'aimAssist', type: 'choice', col: 'left', options: Object.freeze([false, true]), labels: Object.freeze(['settings.aimAssist.off', 'settings.aimAssist.light']) }),
  Object.freeze({ key: 'autoCenter', type: 'toggle', col: 'left' }),
  Object.freeze({ key: 'flipX', type: 'toggle', col: 'left' }),
  Object.freeze({ key: 'autoPull', type: 'toggle', col: 'right' }),
  Object.freeze({ key: 'rumble', type: 'toggle', col: 'right' }),
  Object.freeze({ key: 'crosshairColor', type: 'choice', col: 'right', options: SETTINGS_ENUMS.crosshairColor, swatch: true }),
  Object.freeze({ key: 'volume', type: 'stepper', col: 'right' }),
  Object.freeze({ key: 'reduceFlash', type: 'toggle', col: 'right' }),
  Object.freeze({ key: 'reduceMotion', type: 'toggle', col: 'right' }),
]);
export const SETTINGS_BUTTONS = Object.freeze([
  Object.freeze({ id: 'set.tune', x: 520, w: 640, labelKey: 'settings.tune' }),
  Object.freeze({ id: 'set.reset', x: 1150, w: 480, labelKey: 'settings.reset' }),
  Object.freeze({ id: 'set.back', x: 1620, w: 320, labelKey: 'settings.back' }),
]);
/** Swatch colours of the crosshair choice (the world renderer owns the real crosshair colours). */
export const CROSSHAIR_SWATCH = Object.freeze({ white: '#FFFFFF', yellow: '#FFE14D', green: '#4DFF7A', magenta: '#FF4DE1' });

/** The options of a value row: toggles are [false, true]. */
export function rowOptions(row) {
  if (row.type === 'toggle') return [false, true];
  return row.options ?? [];
}

/** The id part of an option value: booleans are 'off' / 'on'. */
export const optionId = (value) => (value === true ? 'on' : value === false ? 'off' : String(value));

/** Geometry of one settings-style row: label position and the control rectangle (x0..x1 of the column, centre y). */
export function rowGeometry(col, cy, controlW = SETTINGS_GRID.controlW) {
  const cx1 = col.x1 - 10;
  const cx0 = cx1 - controlW;
  return { labelX: col.x0 + SETTINGS_GRID.labelPad, cy, cx0, cx1, ccx: (cx0 + cx1) / 2 };
}

/** The cells of a value row as targets. */
export function rowCells(prefix, row, geo, cellH, span, extra = {}) {
  const out = [];
  const flags = { row: row.key, rowType: row.type === 'stepper' ? 'stepper' : 'choice', span, ...extra };
  if (row.type === 'stepper') {
    out.push(rect(`${prefix}.${row.key}.minus`, geo.cx0 + cellH / 2, geo.cy, cellH, cellH, { ...flags, step: -1 }));
    out.push(rect(`${prefix}.${row.key}.plus`, geo.cx1 - cellH / 2, geo.cy, cellH, cellH, { ...flags, step: +1 }));
    return out;
  }
  const opts = rowOptions(row);
  const gap = 8;
  const w = (geo.cx1 - geo.cx0 - gap * (opts.length - 1)) / opts.length;
  opts.forEach((value, i) => {
    out.push(rect(`${prefix}.${row.key}.opt.${optionId(value)}`, geo.cx0 + w / 2 + i * (w + gap), geo.cy, w, cellH, { ...flags, value, index: i }));
  });
  return out;
}

// ---------------------------------------------------------------------------------------------------------------- tuning
export const TUNING = Object.freeze({
  titleY: 92,
  introY: 150,
  ring: Object.freeze({ x: 960, y: 500, r: 70 }),
  left: Object.freeze({ x0: 60, x1: 700, top: 210, bottom: 860 }),
  right: Object.freeze({ x0: 1260, x1: 1860, top: 210, bottom: 860 }),
  rowsFirstY: 360,
  rowsPitch: 170,
  controlW: 560,
  back: Object.freeze({ x: 960, y: 965, w: 400, h: 92 }),
});

/** Tuning rows: the label sits above the control (labelY), the control spans the panel. */
export function tuningRowGeometry(i) {
  const T = TUNING;
  const cy = T.rowsFirstY + i * T.rowsPitch;
  const cx0 = (T.left.x0 + T.left.x1) / 2 - T.controlW / 2;
  const cx1 = cx0 + T.controlW;
  return { labelX: cx0, labelY: cy - 64, cy, cx0, cx1, ccx: (cx0 + cx1) / 2 };
}
export const TUNING_ROWS = Object.freeze([
  Object.freeze({ key: 'triggerCompMs', type: 'stepper' }),
  Object.freeze({ key: 'sensitivity', type: 'stepper' }),
  Object.freeze({ key: 'aimCurve', type: 'choice', options: SETTINGS_ENUMS.aimCurve }),
]);

// ---------------------------------------------------------------------------------------------------------------- other screens
export const PAUSE_PANEL = Object.freeze({ x: 960, y: 560, w: 760, h: 720 });
export const PAUSE_BUTTONS = Object.freeze([
  Object.freeze({ id: 'pause.resume', y: 400, labelKey: 'pause.resume', primary: true }),
  Object.freeze({ id: 'pause.recentre', y: 520, labelKey: 'pause.recentre' }),
  Object.freeze({ id: 'pause.settings', y: 640, labelKey: 'pause.settings' }),
  Object.freeze({ id: 'pause.quit', y: 760, labelKey: 'pause.quit' }),
]);
export const RESULTS_PANEL = Object.freeze({ x: 960, y: 520, w: 1320, h: 840 });
export const BEST_PANEL = Object.freeze({ x: 960, y: 520, w: 1480, h: 700 });
export const CONFIRM_PANEL = Object.freeze({ x: 960, y: 540, w: 960, h: 460 });
export const DISCONNECT_PANEL = Object.freeze({ x: 960, y: 540, w: 960, h: 660 });
export const SAFETY = Object.freeze({ panel: Object.freeze({ x: 960, y: 420, w: 1400, h: 600 }), toggle: Object.freeze({ x: 960, y: 808, w: 560, h: 84 }), ok: Object.freeze({ x: 960, y: 930, w: 640, h: 104 }) });

/**
 * The right column of the connect screen. One place for the numbers: the targets below and screens/connect.js both read them.
 * The status pill starts at `pillTop` and grows downwards.
 */
export const CONNECT = Object.freeze({
  titleY: 108,
  subtitleY: 166,
  panel: Object.freeze({ x: 560, y: 560, w: 880, h: 640 }),
  main: Object.freeze({ x: 1440, y: 330, w: 720, h: 120 }),
  pillTop: 420,
  pillWidth: 780,
  secondaryY: 680,
  secondaryYWithFallback: 610,
  fallbackY: 705,
  secondaryW: 800,
  secondaryH: 84,
  cancel: Object.freeze({ x: 1440, y: 690, w: 400, h: 84 }),
  altTitleY: 790,
  sim: Object.freeze({ x: 1240, y: 860, w: 380, h: 96 }),
  mouse: Object.freeze({ x: 1640, y: 860, w: 380, h: 96 }),
  diagnostics: Object.freeze({ x: 560, y: 960, w: 440, h: 84 }),
  back: Object.freeze({ x: 190, y: 90, w: 240, h: 84 }),
});

export const CALIBRATION = Object.freeze({
  flip: Object.freeze({ x: 380, y: 962, w: 560, h: 84 }),
  quick: Object.freeze({ x: 400, y: 962, w: 520, h: 84 }),
  retry: Object.freeze({ x: 380, y: 790, w: 520, h: 96 }), // F14: bottom left, away from the trap house and the gun
});

function rect(id, x, y, w, h, extra) {
  return { id, shape: 'rect', x, y, w, h, enabled: true, ...extra };
}

/** Targets of the overlay dialogs (they replace every screen target while open). */
export function overlayTargets(view) {
  if (view.overlay === 'confirm') {
    return [
      rect('confirm.yes', 740, 660, 400, 100),
      rect('confirm.no', 1180, 660, 400, 100, { primary: true }),
    ];
  }
  if (view.overlay === 'disconnected') {
    if (view.disc.native && view.disc.phase === 'reconnecting') return [rect('disc.cancel', 960, 790, 620, 90)];
    if (view.disc.phase !== 'failed') return [];
    return [
      rect('disc.retry', 960, 590, 640, 90, { enabled: view.disc.retryEnabled, primary: true }),
      rect('disc.mouse', 960, 690, 640, 90),
      rect('disc.menu', 960, 790, 640, 90),
    ];
  }
  return [];
}

function connectTargets(view) {
  const m = view.connect;
  const C = CONNECT;
  const out = [
    rect(m.showContinue ? 'connect.continue' : 'connect.main', C.main.x, C.main.y, C.main.w, C.main.h, { enabled: m.buttonEnabled, primary: true }),
    rect('connect.sim', C.sim.x, C.sim.y, C.sim.w, C.sim.h),
    rect('connect.mouse', C.mouse.x, C.mouse.y, C.mouse.w, C.mouse.h),
    rect('connect.diagnostics', C.diagnostics.x, C.diagnostics.y, C.diagnostics.w, C.diagnostics.h, { link: true }),
  ];
  if (m.native) {
    // while the bridge works the second path gives way to "Cancel" (a click or Esc, never Enter: a second Enter must not undo the first)
    if (m.cancel) out.push(rect('connect.cancel', C.cancel.x, C.cancel.y, C.cancel.w, C.cancel.h));
    else if (m.secondary.show) out.push(rect('connect.secondary', 1440, m.showFallback ? C.secondaryYWithFallback : C.secondaryY, C.secondaryW, C.secondaryH, { enabled: m.secondary.enabled }));
    if (m.showFallback) out.push(rect('connect.fallback', 1440, C.fallbackY, C.secondaryW, C.secondaryH, { enabled: m.buttonEnabled }));
  } else if (m.showFallback) {
    out.push(rect('connect.fallback', 1440, C.secondaryY - 40, C.secondaryW, C.secondaryH, { enabled: m.buttonEnabled }));
  }
  // a connected, calibrated Joy-Con: "Continue" goes to the menu, this button runs the wizard again
  if (m.showContinue && view.connect.calibrated && view.provider?.kind === 'joycon') out.push(rect('connect.calibrate', 1440, C.secondaryY, C.secondaryW, C.secondaryH));
  if (view.connect.cameFromMenu) out.push(rect('connect.back', C.back.x, C.back.y, C.back.w, C.back.h));
  return out;
}

function setupTargets(view) {
  const s = view.setup;
  const S = SETUP;
  const out = [];
  if (s.mode !== 'zen') {
    const c = S.difficultyCell;
    DIFFICULTIES.forEach((d, i) => {
      out.push(rect(`setup.difficulty.opt.${d}`, 960 + (i - 1) * (c.w + c.gap), S.difficultyY, c.w, c.h, {
        row: 'difficulty', rowType: 'choice', value: d, index: i, span: [180, 1740],
      }));
    });
  }
  if (s.mode !== 'classic') {
    const c = S.stageCard;
    STAGES.forEach((st, i) => {
      out.push(rect(`setup.stage.opt.${st}`, 960 + (i - 1) * (c.w + c.gap), S.stageY, c.w, c.h, {
        row: 'stage', rowType: 'choice', value: st, index: i, span: [180, 1740],
      }));
    });
  }
  out.push(rect('setup.back', S.back.x, S.buttonsY, S.back.w, S.back.h));
  out.push(rect('setup.start', S.start.x, S.buttonsY, S.start.w, S.start.h, { primary: true }));
  return out;
}

function settingsTargets() {
  const G = SETTINGS_GRID;
  const out = [];
  const idx = { left: 0, right: 0 };
  for (const row of SETTINGS_ROWS) {
    const col = SETTINGS_COLS[row.col];
    const cy = G.firstY + idx[row.col]++ * G.pitch;
    out.push(...rowCells('set', row, rowGeometry(col, cy), G.cellH, [col.x0, col.x1]));
  }
  for (const b of SETTINGS_BUTTONS) out.push(rect(b.id, b.x, G.buttonsY, b.w, 90));
  return out;
}

function tuningTargets() {
  const T = TUNING;
  const out = [];
  TUNING_ROWS.forEach((row, i) => {
    out.push(...rowCells('set', row, tuningRowGeometry(i), 84, [T.left.x0, T.left.x1]));
  });
  out.push(rect('tune.back', T.back.x, T.back.y, T.back.w, T.back.h));
  return out;
}

/**
 * All selectable targets of the current screen. `view` is the UI view model (see ui.js).
 * @returns {Array<object>}
 */
export function screenTargets(view) {
  if (view.overlay) return overlayTargets(view);
  switch (view.screen) {
    case 'safety':
      return [
        rect('safety.toggle', SAFETY.toggle.x, SAFETY.toggle.y, SAFETY.toggle.w, SAFETY.toggle.h),
        rect('safety.ok', SAFETY.ok.x, SAFETY.ok.y, SAFETY.ok.w, SAFETY.ok.h, { enabled: view.safety.ready, primary: true }),
      ];
    case 'connect':
      return connectTargets(view);
    case 'calibration': {
      const step = view.cal.step;
      const C = CALIBRATION;
      const out = [];
      if (step === 3 || step === 4) out.push(rect('cal.flip', C.flip.x, C.flip.y, C.flip.w, C.flip.h));
      if (step === 4 && view.cal.tryAgain) out.push(rect('cal.retry', C.retry.x, C.retry.y, C.retry.w, C.retry.h, { primary: true }));
      if (step === 1 && view.calibrated && !view.cal.quick) out.push(rect('cal.quick', C.quick.x, C.quick.y, C.quick.w, C.quick.h));
      return out;
    }
    case 'menu': {
      const out = MENU_CARDS.map((c) => rect(c.id, c.x, c.y, c.w, c.h, { mode: c.mode, card: true }));
      for (const b of MENU_BUTTONS) out.push(rect(b.id, b.x, b.y, b.w, b.h));
      return out;
    }
    case 'setup':
      return setupTargets(view);
    case 'settings':
      return settingsTargets();
    case 'tuning':
      return tuningTargets();
    case 'best':
      return [rect('best.back', 960, 965, 400, 92)];
    case 'paused':
      if (view.resuming) return [];
      return PAUSE_BUTTONS.map((b) => rect(b.id, PAUSE_PANEL.x, b.y, 620, 100, { primary: b.primary === true }));
    case 'results':
      return [
        rect('results.again', 760, 862, 420, 104, { enabled: !view.results.locked, primary: true }),
        rect('results.menu', 1188, 862, 360, 104, { enabled: !view.results.locked }),
      ];
    default:
      return [];
  }
}
