// Shared plumbing of the three input providers. OWNER: input engineer.
//
// Every provider gets the same emitter (on/off/dispose), the same status store, the same `log` channel and the same
// action labels handling, so that BLE, simulator and mouse are interchangeable behind one interface (constraint 4).

import { Emitter } from '../shared/emitter.js';
import { createStatusStore } from './status.js';

/**
 * Action labels shown in "Pause: {button}" style hints (architecture 5.7, Clay Rush 4.1). English, as they are player-visible.
 * The Joy-Con tables are those of the default trigger 'ZR'; with setTriggerButton('R') the `fire` and `recenter` labels swap
 * (labelsForSide in actions.js).
 */
export const ACTION_LABELS = Object.freeze({
  joyconRight: Object.freeze({ confirm: 'A', back: 'B', pause: '+', recenter: 'R', fire: 'ZR' }),
  joyconLeft: Object.freeze({ confirm: 'Down', back: 'Left', pause: '-', recenter: 'L', fire: 'ZL' }),
  keyboard: Object.freeze({ confirm: 'Enter', back: 'Esc', pause: 'P', recenter: 'Space', fire: 'F' }),
  mouse: Object.freeze({ confirm: 'click', back: 'right click', pause: 'middle click', recenter: 'double click', fire: 'Click' }),
});

/**
 * @param {object} opts
 * @param {'joycon'|'sim'|'mouse'} opts.kind
 * @param {import('../shared/contracts.js').ProviderCapabilities} opts.capabilities
 * @param {import('../shared/contracts.js').Clock} opts.clock
 * @param {'L'|'R'|'?'} [opts.side]
 * @param {string} [opts.state]
 * @param {(level:string, message:string) => void} [opts.log]   caller supplied log sink (in addition to the 'log' event)
 * @param {boolean} [opts.strict]                                throw on an illegal connection transition (tests)
 */
export function createProviderBase(opts) {
  const emitter = new Emitter();
  const clock = opts.clock;
  const callerLog = opts.log;

  function log(level, message) {
    emitter.emit('log', { t: clock.now(), level, message });
    if (callerLog) {
      try {
        callerLog(level, message);
      } catch {
        /* a broken log sink must never break the input path */
      }
    }
  }

  const store = createStatusStore({
    kind: opts.kind,
    side: opts.side ?? '?',
    state: opts.state,
    clock,
    strict: opts.strict,
    log,
    emit: (status) => emitter.emit('status', status),
  });

  return {
    emitter,
    store,
    log,
    capabilities: Object.freeze({ ...opts.capabilities }),
    on: (type, fn) => emitter.on(type, fn),
    off: (type, fn) => emitter.off(type, fn),
    /** Emit an `error` event for an InputErrorInfo (also logged). */
    emitError(info) {
      log('error', `${info.code}: ${info.message}`);
      emitter.emit('error', info);
    },
  };
}
