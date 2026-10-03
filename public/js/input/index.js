// Clay Rush input module: the only names other modules may import (docs/architecture.md 2.5). OWNER: input engineer.
//
// Four providers behind ONE interface (constraint 4):
//   'joycon'  real Joy-Con 2 over Web Bluetooth (needs a user gesture and calibration; UNVERIFIED-ON-HARDWARE)
//   'native'  real Joy-Con 2 over the native Bluetooth bridge: a CoreBluetooth helper that server.js starts, reached with fetch and
//             EventSource (docs/native-bridge.md). No chooser and no Web Bluetooth: any browser will do. Its status reports
//             kind 'joycon' (same controller, same calibration, same report pipeline). UNVERIFIED-ON-HARDWARE end to end.
//   'sim'     mouse -> virtual Joy-Con -> byte-exact Joy-Con packets -> the real parser (any machine, no controller); sim.fire() for bots
//   'mouse'   the cursor is the aim, a left press fires
// Clay Rush (docs/architecture.md 4.1): every provider has setTriggerButton('ZR'|'R') (a no-op without shoulder buttons) and
// getActionLabels() includes `fire`.
// The old reserved name 'bridge' is gone (it was never implemented): it is an unknown kind like any other, use 'native'.

import { createBleProvider } from './ble-provider.js';
import { createNativeProvider } from './native-provider.js';
import { createSimProvider } from './sim-provider.js';
import { createMouseProvider } from './mouse-provider.js';

export { createKeyboardActions } from './keyboard.js';
export { parseInputReport, BUTTON_TABLE } from './joycon2-parse.js';
export { buildInputReport } from './joycon2-build.js';
export { SIM_MOUNTS } from './sim-model.js';
export { INPUT_CONFIG } from './input-config.js';
export { createNativeProvider };

/**
 * @param {'joycon'|'native'|'sim'|'mouse'} kind
 * @param {object} opts  see docs/architecture.md 5.2: clock (required), bluetooth, target, toPlayfield, sim, log
 *   Additional optional hooks (tests and embedding): timers, document, pageTarget, windowTarget, config, strictTransitions;
 *   for 'native' also fetch, EventSource, baseUrl, native, autoRetry.
 * @returns {import('../shared/contracts.js').InputProvider}
 */
export function createInputProvider(kind, opts = {}) {
  if (!opts || !opts.clock || typeof opts.clock.now !== 'function') throw new TypeError('createInputProvider: opts.clock is required');
  switch (kind) {
    case 'joycon':
      return createBleProvider(opts);
    case 'native':
      return createNativeProvider(opts);
    case 'sim':
      return createSimProvider(opts);
    case 'mouse':
      return createMouseProvider(opts);
    default:
      throw new TypeError(`createInputProvider: unknown provider kind "${kind}" (expected joycon, native, sim or mouse)`);
  }
}
