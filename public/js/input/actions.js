// Joy-Con buttons -> actions (docs/architecture.md 4.1, C-02). OWNER: input engineer.
//
// Rising edges only, side specific (a Right unit has A/B/X/Y, a Left unit has the arrow buttons), no auto-repeat, and a
// small contact-bounce guard. HOME and the stick clicks are never mapped (protocol 6.2).
//
// The trigger (Clay Rush): on a Right unit ZR fires and R recentres, on a Left unit ZL fires and L recentres; the trigger setting
// 'R' swaps the two (setTriggerButton). A `fire` ActionEvent carries the time of the report that first showed the button down
// (ButtonsEvent.t = the ImuSample.t of that report), its bounce guard is short (INPUT_CONFIG.action.fireMinIntervalMs, on report
// times) and nothing else delays it. Whether ZR is comfortable as a trigger, how much pulling it jerks the wrist and how fast it can
// be pulled twice are UNVERIFIED-ON-HARDWARE.

import { ACTION, ACTION_SOURCE } from '../shared/contracts.js';
import { INPUT_CONFIG } from './input-config.js';
import { ACTION_LABELS } from './provider-base.js';

/** Order in which simultaneous actions of one ButtonsEvent are emitted: the shot first (it happened at the report time). */
export const ACTION_ORDER = Object.freeze([ACTION.FIRE, ACTION.CONFIRM, ACTION.BACK, ACTION.PAUSE, ACTION.RECENTER]);

/** The trigger settings a provider accepts (C-02). */
export const TRIGGER_BUTTONS = Object.freeze(['ZR', 'R']);

/**
 * Button names per action and Joy-Con side, for the default trigger 'ZR'. The rail buttons (SL / SR) are deliberately NOT mapped
 * (round 2 finding n4 of the previous game): the rail is where a strap or a grip is most likely to touch the Joy-Con. They are still
 * decoded (joycon2-parse.js) and shown by the diagnostics page. UNVERIFIED-ON-HARDWARE (UOH-10).
 */
export const BUTTON_ACTIONS = Object.freeze({
  R: Object.freeze({
    [ACTION.FIRE]: Object.freeze(['ZR']),
    [ACTION.CONFIRM]: Object.freeze(['A', 'Y', 'X']),
    [ACTION.BACK]: Object.freeze(['B']),
    [ACTION.PAUSE]: Object.freeze(['PLUS']),
    [ACTION.RECENTER]: Object.freeze(['R']),
  }),
  L: Object.freeze({
    [ACTION.FIRE]: Object.freeze(['ZL']),
    [ACTION.CONFIRM]: Object.freeze(['DOWN', 'RIGHT', 'UP']),
    [ACTION.BACK]: Object.freeze(['LEFT']),
    [ACTION.PAUSE]: Object.freeze(['MINUS', 'CAPTURE']),
    [ACTION.RECENTER]: Object.freeze(['L']),
  }),
});

/** The same tables with the trigger on R (L on a Left unit): fire and recenter swapped. */
const BUTTON_ACTIONS_R_TRIGGER = Object.freeze({
  R: Object.freeze({ ...BUTTON_ACTIONS.R, [ACTION.FIRE]: BUTTON_ACTIONS.R[ACTION.RECENTER], [ACTION.RECENTER]: BUTTON_ACTIONS.R[ACTION.FIRE] }),
  L: Object.freeze({ ...BUTTON_ACTIONS.L, [ACTION.FIRE]: BUTTON_ACTIONS.L[ACTION.RECENTER], [ACTION.RECENTER]: BUTTON_ACTIONS.L[ACTION.FIRE] }),
});

/** A valid trigger setting, or null. */
export function normalizeTriggerButton(button) {
  return TRIGGER_BUTTONS.includes(button) ? button : null;
}

/** The button tables for a trigger setting ('ZR' default). */
export function buttonActionsFor(triggerButton = 'ZR') {
  return triggerButton === 'R' ? BUTTON_ACTIONS_R_TRIGGER : BUTTON_ACTIONS;
}

/** Action for one button on a given side, or null. Side '?' accepts the buttons of both units. */
export function actionForButton(side, button, triggerButton = 'ZR') {
  const t = buttonActionsFor(triggerButton);
  const tables = side === 'L' ? [t.L] : side === 'R' ? [t.R] : [t.R, t.L];
  for (const table of tables) {
    for (const action of ACTION_ORDER) if (table[action].includes(button)) return action;
  }
  return null;
}

/** Labels for "Pause: {button}" hints. Unknown side falls back to the Right unit's labels. A new frozen object per call. */
export function labelsForSide(side, triggerButton = 'ZR') {
  const base = side === 'L' ? ACTION_LABELS.joyconLeft : ACTION_LABELS.joyconRight;
  if (triggerButton !== 'R') return base;
  return Object.freeze({ ...base, fire: base.recenter, recenter: base.fire });
}

/**
 * Turns ButtonsEvents into ActionEvents.
 * @param {{clock:{now:()=>number}, emit:(event:object)=>void, getSide:()=>string, minIntervalMs?:number, fireMinIntervalMs?:number,
 *   triggerButton?:'ZR'|'R'}} opts
 */
export function createButtonActions(opts) {
  const minIntervalMs = opts.minIntervalMs ?? INPUT_CONFIG.action.minIntervalMs;
  const fireMinIntervalMs = opts.fireMinIntervalMs ?? INPUT_CONFIG.action.fireMinIntervalMs;
  let triggerButton = normalizeTriggerButton(opts.triggerButton) ?? INPUT_CONFIG.defaultTriggerButton;
  const lastAt = {};
  const holdUntil = {}; // action -> clock time before which its edges are ignored
  const buttonHoldUntil = {}; // button -> clock time before which its edges are ignored (phantom ZL/ZR bits right after a mask change)

  return {
    /** @param {import('../shared/contracts.js').ButtonsEvent & {initial?:boolean}} event */
    handle(event) {
      // The first report after connecting only sets the baseline: a button held at connect time (or a phantom bit,
      // protocol 6.2 / UOH-10) must not fire an action.
      if (event.initial) return;
      const side = event.side ?? opts.getSide();
      const fired = new Set();
      const nowB = opts.clock.now();
      for (const button of event.down) {
        if (buttonHoldUntil[button] !== undefined && nowB < buttonHoldUntil[button]) continue;
        const action = actionForButton(side, button, triggerButton);
        if (action) fired.add(action);
      }
      if (!fired.size) return;
      const labels = labelsForSide(side, triggerButton);
      for (const action of ACTION_ORDER) {
        if (!fired.has(action)) continue;
        const now = opts.clock.now();
        if (holdUntil[action] !== undefined && now < holdUntil[action]) continue;
        // fire: the guard runs on report times (a burst delivers two reports at once), every other action on the clock
        const at = action === ACTION.FIRE && Number.isFinite(event.t) ? event.t : now;
        const gap = action === ACTION.FIRE ? fireMinIntervalMs : minIntervalMs;
        if (lastAt[action] !== undefined && at - lastAt[action] < gap) continue;
        lastAt[action] = at;
        opts.emit({ t: event.t, action, label: labels[action], source: ACTION_SOURCE.JOYCON });
      }
    },
    /** Ignore the edges of one action for the next `ms` milliseconds (a longer hold-off already running is kept). */
    holdOff(action, ms) {
      const until = opts.clock.now() + ms;
      if (holdUntil[action] === undefined || until > holdUntil[action]) holdUntil[action] = until;
    },
    /**
     * Ignore the edges of some BUTTONS for the next `ms` milliseconds, whatever action they are mapped to (phantom ZL/ZR bits after a
     * feature-mask change: with the trigger on R a real R shot still passes, the ZR re-centre does not).
     */
    holdOffButtons(buttons, ms) {
      const until = opts.clock.now() + ms;
      for (const b of buttons) if (buttonHoldUntil[b] === undefined || until > buttonHoldUntil[b]) buttonHoldUntil[b] = until;
    },
    /** 'ZR' (default) or 'R': which shoulder button fires. Unknown values are ignored; returns the setting in force. */
    setTriggerButton(button) {
      const b = normalizeTriggerButton(button);
      if (b) triggerButton = b;
      return triggerButton;
    },
    getTriggerButton: () => triggerButton,
    reset() {
      for (const key of Object.keys(lastAt)) delete lastAt[key];
      for (const key of Object.keys(holdUntil)) delete holdUntil[key];
      for (const key of Object.keys(buttonHoldUntil)) delete buttonHoldUntil[key];
    },
  };
}
