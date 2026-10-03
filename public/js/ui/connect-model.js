// What the connect screen shows for a given provider status. OWNER: Presentation engineer.
// Pure function (docs/game-design.md 12.4 state table, docs/architecture.md 5.4 error code -> string mapping).
// UNVERIFIED-ON-HARDWARE (HW-4, HW-5): the pairing wording and the cooldown rule are assumptions until the owner tries a real
// Joy-Con 2; only the strings and the constants change, not this logic.
//
// Two layouts. The LEGACY one (Web Bluetooth only) is what the screen always was. The NATIVE one is shown when the native Bluetooth
// bridge is usable (docs/native-bridge.md): the primary button starts the bridge, Web Bluetooth ("Not working? Try Chrome's Bluetooth") becomes the
// secondary path, and while the bridge works the screen shows one progress line per helper phase, a countdown of the scan
// and a cancel button. Everything the native path needs from outside arrives in `opts` (the facts of app.js): the probe of
// GET /__bridge/status, the last progress event of the provider, the path the player used last.

import { INPUT_CONFIG } from '../input/input-config.js';
import { STRINGS, t } from './strings.en.js';

/** Consecutive failures after which the provider uses the long cooldown (one constant for screen and provider: round 2 finding m5). */
const longCooldown = (status) => status.failures >= INPUT_CONFIG.longCooldownAfterFailures;

/** InputErrorInfo.code -> string key (docs/architecture.md 5.4). 'cooldown' and 'lost_signal' are handled separately. */
export const ERROR_STRING_KEYS = Object.freeze({
  unsupported_browser: 'connect.err.unsupported',
  permission_denied: 'connect.err.permission',
  cancelled: 'connect.err.cancelled',
  not_joycon: 'connect.err.notJoycon',
  gatt_failure: 'connect.err.failed',
  no_data: 'connect.err.noData',
  lost_signal: 'connect.err.failed',
});

/** Bridge reasons (GET /__bridge/status `reason`) for which the native path is missing something the player can install. */
const FIXABLE_REASONS = Object.freeze(['no_compiler', 'helper_missing']);
/** Progress phases after the scan: the screen repeats "keep holding SYNC" there (before them SYNC is not due yet, during the scan the progress text says it). */
const HINT_PHASES = Object.freeze(['connecting', 'discovering', 'initialising', 'waitingData']);
const BUSY_STATES = Object.freeze(['requesting', 'connecting', 'initializing']);

/** Text for the Joy-Con side. */
export function sideText(side) {
  if (side === 'L') return t('connect.side.left');
  if (side === 'R') return t('connect.side.right');
  return t('connect.side.unknown');
}

/** Battery line: percentage when the provider knows one, else the coarse level, else "not available". */
export function batteryText(battery) {
  if (battery && Number.isFinite(battery.pct)) return t('connect.battery', { pct: Math.round(battery.pct) });
  if (battery && (battery.level === 'ok' || battery.level === 'low' || battery.level === 'critical')) return t(`connect.batteryLevel.${battery.level}`);
  return t('connect.batteryUnknown');
}

/** Seconds left of a cooldown, rounded up (never negative). */
export function cooldownSeconds(status, nowMs) {
  if (!status || status.cooldownUntil === null || status.cooldownUntil === undefined) return 0;
  return Math.max(0, Math.ceil((status.cooldownUntil - nowMs) / 1000));
}

/** Player-visible string for an InputErrorInfo, or '' when there is none. The native bridge names its own string key (err.native.key). */
export function errorText(status, nowMs) {
  const err = status?.error;
  if (!err) return '';
  if (err.code === 'cooldown') {
    return longCooldown(status) ? t('connect.cooldown.long') : t('connect.cooldown.wait', { s: Math.max(1, cooldownSeconds(status, nowMs)) });
  }
  const nativeKey = err.native?.key;
  if (typeof nativeKey === 'string' && Object.hasOwn(STRINGS, nativeKey)) return t(nativeKey);
  const key = ERROR_STRING_KEYS[err.code];
  return key ? t(key) : t('connect.err.failed');
}

/**
 * The progress line of the native bridge and the scan countdown, from the last `bridge` fact of the provider.
 * @param {{phase?:string, key?:string|null, scanStartedAt?:number|null, scanSeconds?:number}|null|undefined} progress
 * @param {number} nowMs
 * @returns {{text:string, phase:string, countdownS:number|null, countdownFrac:number}}
 */
export function nativeProgress(progress, nowMs) {
  const phase = progress?.phase ?? 'checking';
  const key = typeof progress?.key === 'string' && Object.hasOwn(STRINGS, progress.key) ? progress.key : 'connect.native.progress.checking';
  let countdownS = null;
  let countdownFrac = 0;
  if (phase === 'scanning' && Number.isFinite(progress?.scanStartedAt) && Number.isFinite(progress?.scanSeconds) && progress.scanSeconds > 0) {
    const elapsedS = Math.max(0, (nowMs - progress.scanStartedAt) / 1000);
    countdownS = Math.max(0, Math.ceil(progress.scanSeconds - elapsedS));
    countdownFrac = Math.min(1, elapsedS / progress.scanSeconds);
  }
  return { text: t(key), phase, countdownS, countdownFrac };
}

/**
 * @param {{kind:string|null, transport?:string|null, status:import('../shared/contracts.js').InputStatus|null}|null} provider  last `provider` fact
 * @param {number} nowMs
 * @param {{hasBluetooth?:boolean, extendedTried?:boolean,
 *          bridge?:{probe?:'unknown'|'checking'|'available'|'unavailable', reason?:string|null},
 *          progress?:object|null, preferred?:'native'|'chrome'|null}} [opts]
 *   extendedTried: the last attempt was the "Extended search" one. bridge: the probe of /__bridge/status (absent or 'unknown' = the
 *   legacy layout). progress: the last `bridge` fact. preferred: the path the player used last (or asked for with ?input=).
 * @returns {{mode:'idle'|'busy'|'connected'|'cooldown'|'unsupported'|'error', buttonEnabled:boolean, buttonText:string,
 *            showContinue:boolean, pillText:string, longCooldown:boolean, cooldownS:number,
 *            showFallback:boolean, fallbackText:string, hintText:string,
 *            native:boolean, primary:'native'|'bluetooth', stepTexts:string[]|null, progressText:string, countdownS:number|null,
 *            countdownFrac:number, cancel:boolean, cancelText:string, secondary:{show:boolean, enabled:boolean, text:string, path:'native'|'bluetooth'},
 *            noteText:string, warningText:string}}
 *   showFallback: the chooser was closed without a choice (code `cancelled`, which never starts a cooldown), so the screen offers the
 *   extended search (acceptAllDevices) with a hint. It is never set while busy, connected, cooling down or without Web Bluetooth.
 *   native: the native layout (see the header). primary says which path the main button starts; secondary is the other one.
 */
export function deriveConnectModel(provider, nowMs, opts = {}) {
  const hasBluetooth = opts.hasBluetooth !== false;
  const joycon = provider && provider.kind === 'joycon' ? provider : null;
  const status = joycon ? joycon.status : null;
  const nativeActive = joycon?.transport === 'native';
  const probe = opts.bridge?.probe ?? 'unknown';
  const native = probe === 'available' || probe === 'checking' || nativeActive;
  const primary = native && !(opts.preferred === 'chrome' && hasBluetooth && probe === 'available' && !nativeActive) ? 'native' : 'bluetooth';
  const bluetoothText = t('connect.button');
  const nativeText = t('connect.native.button');
  const fixable = probe === 'unavailable' && FIXABLE_REASONS.includes(opts.bridge?.reason) ? t('connect.native.note.noCompiler') : '';
  const base = {
    buttonText: primary === 'native' ? nativeText : bluetoothText, longCooldown: false, cooldownS: 0, showFallback: false, fallbackText: t('connect.fallback.button'), hintText: '',
    native, primary, stepTexts: null, progressText: '', countdownS: null, countdownFrac: 0, cancel: false, cancelText: t('connect.native.cancel'),
    secondary: { show: false, enabled: false, text: '', path: primary === 'native' ? 'bluetooth' : 'native' },
    noteText: native ? '' : fixable, warningText: t('connect.cooldown.warning'),
  };
  if (native) {
    base.stepTexts = primary === 'native'
      ? ['connect.native.step1', 'connect.native.step2', 'connect.native.step3', 'connect.native.step4'].map((k) => t(k, { button: nativeText }))
      : null;
    base.secondary.text = primary === 'native' ? t('connect.native.secondary') : t('connect.native.secondaryToNative');
  }
  // The other path is offered only when it can work: Web Bluetooth needs the browser's API, the bridge needs its probe to have said yes.
  const otherPathPossible = primary === 'native' ? hasBluetooth : probe === 'available';
  const offerSecondary = (enabled) => ({ ...base.secondary, show: native && otherPathPossible, enabled: native && otherPathPossible && enabled });

  if (probe === 'checking' && !nativeActive) {
    // the probe of /__bridge/status is in flight: the native layout with a disabled button, so that no wrong button is ever live
    return { ...base, mode: 'busy', buttonEnabled: false, showContinue: false, pillText: t('connect.native.progress.checking'), progressText: t('connect.native.progress.checking') };
  }
  if (!native && (!hasBluetooth || status?.error?.code === 'unsupported_browser')) {
    return { ...base, mode: 'unsupported', buttonEnabled: false, showContinue: false, pillText: t('connect.err.unsupported') };
  }
  if (!status) {
    return { ...base, mode: 'idle', buttonEnabled: true, showContinue: false, pillText: base.noteText, secondary: offerSecondary(true) };
  }

  switch (status.state) {
    case 'requesting':
    case 'connecting':
    case 'initializing': {
      if (nativeActive) {
        const p = nativeProgress(opts.progress, nowMs);
        return {
          ...base, mode: 'busy', buttonEnabled: false, showContinue: false, pillText: p.text, progressText: p.text, countdownS: p.countdownS, countdownFrac: p.countdownFrac,
          hintText: HINT_PHASES.includes(p.phase) ? t('connect.native.hint') : '', cancel: true,
        };
      }
      return { ...base, mode: 'busy', buttonEnabled: false, showContinue: false, pillText: status.state === 'requesting' ? t('connect.searching') : t('connect.connecting') };
    }
    case 'streaming': {
      const line = `${t('connect.connected', { side: sideText(status.side) })}  ${batteryText(status.battery)}`;
      return { ...base, mode: 'connected', buttonEnabled: true, showContinue: true, pillText: line };
    }
    default: {
      // idle, lost, error
      const cool = cooldownSeconds(status, nowMs);
      const pill = errorText(status, nowMs);
      if (cool > 0) {
        return {
          ...base, mode: 'cooldown', buttonEnabled: false, showContinue: false,
          buttonText: t('connect.cooldown.wait', { s: cool }), pillText: longCooldown(status) ? t('connect.cooldown.long') : pill,
          longCooldown: longCooldown(status), cooldownS: cool, secondary: offerSecondary(false),
        };
      }
      // a closed chooser is the only state that offers the extended search: requestDevice needs a click, so it is a button, never automatic
      const cancelled = status.error?.code === 'cancelled';
      const hintText = cancelled ? t(opts.extendedTried === true ? 'connect.fallback.hintExtended' : 'connect.fallback.hint') : '';
      return {
        ...base, mode: status.error ? 'error' : 'idle', buttonEnabled: true, showContinue: false, pillText: pill || base.noteText, showFallback: cancelled, hintText,
        secondary: offerSecondary(true),
      };
    }
  }
}

/** The provider states in which an attempt is running (the native progress and the cancel button apply). */
export const isBusyState = (state) => BUSY_STATES.includes(state);
