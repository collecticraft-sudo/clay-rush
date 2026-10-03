// Keyboard actions (docs/architecture.md 5.7). OWNER: input engineer.
//
// Independent of any provider and active from page load (the safety screen needs Enter before a provider exists):
// main.js owns one createKeyboardActions() for the whole session. Enter = confirm, Escape = back, P = pause,
// Space or C = recenter, F = fire (Clay Rush C-03; the fire's t is the clock at the key press). Held keys never repeat, keys typed into form fields and shortcuts with Ctrl/Alt/Meta are ignored.
// The arrow keys are menu navigation (the same 'nav' events as the stick of a Joy-Con: a press is `down`, the key release is `up`),
// so a keyboard walks the menus exactly like the stick does.

import { Emitter } from '../shared/emitter.js';
import { ACTION, ACTION_SOURCE, NAV_DIR, NAV_PHASE } from '../shared/contracts.js';
import { ACTION_LABELS } from './provider-base.js';

const KEY_ACTIONS = Object.freeze({
  Enter: ACTION.CONFIRM, NumpadEnter: ACTION.CONFIRM,
  Escape: ACTION.BACK,
  KeyP: ACTION.PAUSE, p: ACTION.PAUSE, P: ACTION.PAUSE,
  Space: ACTION.RECENTER, ' ': ACTION.RECENTER, Spacebar: ACTION.RECENTER,
  KeyC: ACTION.RECENTER, c: ACTION.RECENTER, C: ACTION.RECENTER,
  KeyF: ACTION.FIRE, f: ACTION.FIRE, F: ACTION.FIRE,
});

const KEY_NAV = Object.freeze({
  ArrowUp: NAV_DIR.UP, ArrowDown: NAV_DIR.DOWN, ArrowLeft: NAV_DIR.LEFT, ArrowRight: NAV_DIR.RIGHT,
});

const EDITABLE = /^(INPUT|TEXTAREA|SELECT)$/;

function isEditable(target) {
  if (!target) return false;
  return EDITABLE.test(target.tagName ?? '') || target.isContentEditable === true;
}

/**
 * @param {{clock:{now:()=>number}, target?:EventTarget}} opts
 * @returns {{on:Function, off:Function, getLabels:()=>object, dispose:()=>void}}
 */
export function createKeyboardActions(opts) {
  if (!opts || !opts.clock) throw new TypeError('createKeyboardActions: opts.clock is required');
  const emitter = new Emitter();
  const target = opts.target ?? globalThis.window ?? null;

  function onKeyDown(ev) {
    if (ev.repeat || ev.isComposing || ev.ctrlKey || ev.metaKey || ev.altKey) return;
    if (isEditable(ev.target)) return;
    const dir = KEY_NAV[ev.key] ?? KEY_NAV[ev.code];
    if (dir) {
      if (typeof ev.preventDefault === 'function') ev.preventDefault(); // no page scroll
      emitter.emit('nav', { t: opts.clock.now(), dir, phase: NAV_PHASE.DOWN, source: ACTION_SOURCE.KEYBOARD });
      return;
    }
    const action = KEY_ACTIONS[ev.key] ?? KEY_ACTIONS[ev.code];
    if (!action) return;
    if (action === ACTION.RECENTER && typeof ev.preventDefault === 'function') ev.preventDefault(); // no page scroll
    emitter.emit('action', { t: opts.clock.now(), action, label: ACTION_LABELS.keyboard[action], source: ACTION_SOURCE.KEYBOARD });
  }

  function onKeyUp(ev) {
    if (isEditable(ev.target)) return;
    const dir = KEY_NAV[ev.key] ?? KEY_NAV[ev.code];
    if (dir) emitter.emit('nav', { t: opts.clock.now(), dir, phase: NAV_PHASE.UP, source: ACTION_SOURCE.KEYBOARD });
  }

  if (target && typeof target.addEventListener === 'function') {
    target.addEventListener('keydown', onKeyDown);
    target.addEventListener('keyup', onKeyUp);
  }

  return {
    on: (type, fn) => emitter.on(type, fn),
    off: (type, fn) => emitter.off(type, fn),
    getLabels: () => ({ ...ACTION_LABELS.keyboard }),
    dispose() {
      if (target && typeof target.removeEventListener === 'function') {
        target.removeEventListener('keydown', onKeyDown);
        target.removeEventListener('keyup', onKeyUp);
      }
      emitter.removeAll();
    },
  };
}
