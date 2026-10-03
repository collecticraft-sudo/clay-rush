// Immutable InputStatus store, connection state guard and cooldown logic. OWNER: input engineer.
//
// The state machine itself is the table of docs/architecture.md section 5.3. This module owns the data side of it:
//   - one frozen InputStatus object per change (never mutated afterwards),
//   - a guard that knows which transitions the table allows,
//   - the cooldown arithmetic (10 s, then 180 s after 3 consecutive failures; UNVERIFIED-ON-HARDWARE, UOH-11),
//   - the battery level bands (millivolts only, no percentage: A-15, UOH-17).
// Per-packet values (lastPacketAt, battery mV) are kept as plain variables and only folded into a new status object
// when somebody reads `get()`, so the hot path allocates nothing.

import { CONN_STATE, INPUT_ERROR } from '../shared/contracts.js';
import { INPUT_CONFIG } from './input-config.js';

/** Allowed transitions (architecture 5.3). Staying in the same state is always allowed (only the payload changes). */
export const TRANSITIONS = Object.freeze({
  [CONN_STATE.IDLE]: [CONN_STATE.REQUESTING, CONN_STATE.CONNECTING, CONN_STATE.STREAMING, CONN_STATE.ERROR],
  [CONN_STATE.REQUESTING]: [CONN_STATE.CONNECTING, CONN_STATE.IDLE, CONN_STATE.ERROR],
  [CONN_STATE.CONNECTING]: [CONN_STATE.INITIALIZING, CONN_STATE.ERROR, CONN_STATE.LOST, CONN_STATE.IDLE],
  [CONN_STATE.INITIALIZING]: [CONN_STATE.STREAMING, CONN_STATE.ERROR, CONN_STATE.LOST, CONN_STATE.IDLE],
  [CONN_STATE.STREAMING]: [CONN_STATE.LOST, CONN_STATE.IDLE],
  [CONN_STATE.LOST]: [CONN_STATE.CONNECTING, CONN_STATE.REQUESTING, CONN_STATE.IDLE, CONN_STATE.STREAMING],
  [CONN_STATE.ERROR]: [CONN_STATE.REQUESTING, CONN_STATE.CONNECTING, CONN_STATE.IDLE],
});

export const canTransition = (from, to) => from === to || (TRANSITIONS[from]?.includes(to) ?? false);

/** Error codes that start the cooldown when they end an attempt (architecture 5.3, "Cooldown rule"). */
export const COOLDOWN_CODES = Object.freeze([INPUT_ERROR.GATT_FAILURE, INPUT_ERROR.NO_DATA, INPUT_ERROR.NOT_JOYCON, INPUT_ERROR.LOST_SIGNAL]);

/** Cooldown interval in seconds for a number of consecutive failures. */
export function cooldownIntervalS(failures, cfg = INPUT_CONFIG) {
  return failures >= cfg.longCooldownAfterFailures ? cfg.longCooldownS : cfg.cooldownS;
}

/** @returns {'ok'|'low'|'critical'|'unknown'} */
export function batteryLevel(mv, cfg = INPUT_CONFIG) {
  if (mv === null || mv === undefined || !Number.isFinite(mv) || mv <= 0) return 'unknown';
  if (mv >= cfg.batteryLowMv) return 'ok';
  if (mv >= cfg.batteryCriticalMv) return 'low';
  return 'critical';
}

/** InputErrorInfo builder. `retryable` is false only for unsupported_browser. */
export function makeErrorInfo(code, message, at) {
  return Object.freeze({ code, message, retryable: code !== INPUT_ERROR.UNSUPPORTED_BROWSER, at });
}

/** Error to reject a connect()/reconnect() promise with: `.code` and `.info` as required by architecture 3.4. */
export function errorFromInfo(info) {
  const err = new Error(info.message);
  err.name = 'InputError';
  err.code = info.code;
  err.info = info;
  return err;
}

const sameError = (a, b) => a === b || (a && b && a.code === b.code && a.message === b.message && a.at === b.at);

/**
 * @param {{kind:string, side?:string, state?:string, clock:{now:()=>number}, emit?:(status:object)=>void,
 *          strict?:boolean, log?:(level:string, message:string)=>void, config?:object, deviceName?:string|null}} opts
 */
export function createStatusStore(opts) {
  const cfg = opts.config ?? INPUT_CONFIG;
  const emitStatus = opts.emit ?? (() => {});
  const log = opts.log ?? (() => {});
  let base = Object.freeze({
    kind: opts.kind,
    state: opts.state ?? CONN_STATE.IDLE,
    side: opts.side ?? '?',
    battery: Object.freeze({ mv: null, level: 'unknown', pct: null }),
    trackingOk: false,
    error: null,
    cooldownUntil: null,
    failures: 0,
    deviceName: opts.deviceName ?? null,
    packetRateHz: null,
    lastPacketAt: null,
    featureMask: null,
  });
  let current = base;
  // hot-path values, folded into `current` lazily
  let liveLastPacketAt = null;
  let liveBatteryMv = null;
  let dirty = false;

  function materialize() {
    if (!dirty) return current;
    dirty = false;
    const level = current.battery.level;
    current = Object.freeze({
      ...current,
      lastPacketAt: liveLastPacketAt,
      battery: liveBatteryMv === current.battery.mv ? current.battery : Object.freeze({ mv: liveBatteryMv, level, pct: null }),
    });
    return current;
  }

  function changed(prev, next) {
    for (const key of Object.keys(next)) {
      if (key === 'battery') {
        if (prev.battery.level !== next.battery.level) return true;
      } else if (key === 'error') {
        if (!sameError(prev.error, next.error)) return true;
      } else if (key === 'lastPacketAt') {
        continue; // never a reason to emit on its own
      } else if (prev[key] !== next[key]) return true;
    }
    return false;
  }

  return {
    /** Latest immutable status. */
    get: materialize,

    /** Hot-path accessors that never allocate (the state and the battery band are always current). */
    state: () => current.state,
    batteryLevel: () => current.battery.level,

    /**
     * Apply a patch. Emits a `status` event when something worth an event changed (state, error, side, trackingOk,
     * cooldown, failures, battery LEVEL, featureMask, deviceName, packet rate) unless `emit` is false.
     * @returns {object} the resulting status
     */
    patch(changes, { emit = true } = {}) {
      const prev = materialize();
      const merged = { ...changes };
      if (merged.battery && !Object.isFrozen(merged.battery)) merged.battery = Object.freeze({ pct: null, ...merged.battery });
      const willEmit = changed(prev, merged);
      current = Object.freeze({ ...prev, ...merged });
      if ('lastPacketAt' in merged) liveLastPacketAt = merged.lastPacketAt;
      if (merged.battery) liveBatteryMv = merged.battery.mv;
      if (emit && willEmit) emitStatus(current);
      return current;
    },

    /** Change state with the guard of architecture 5.3. Illegal edges are logged (and thrown when `strict`). */
    transition(to, changes = {}, options) {
      const from = materialize().state;
      if (!canTransition(from, to)) {
        const message = `illegal connection transition ${from} -> ${to}`;
        log('error', message);
        if (opts.strict) throw new Error(message);
      }
      return this.patch({ ...changes, state: to }, options);
    },

    /** Hot path: remember the arrival of a packet and the battery voltage without allocating. */
    setLive(lastPacketAt, batteryMv) {
      liveLastPacketAt = lastPacketAt;
      liveBatteryMv = batteryMv;
      dirty = true;
    },

    /** Update the battery level band from the latest millivolts and emit when the band changed. */
    refreshBattery(mv) {
      const level = batteryLevel(mv, cfg);
      const prev = materialize();
      if (prev.battery.level === level && prev.battery.mv === mv) return prev;
      return this.patch({ battery: { mv, level, pct: null } });
    },

    /** Remaining cooldown in seconds at `now` (0 when none). */
    cooldownRemainingS(now) {
      const until = materialize().cooldownUntil;
      return until === null || now >= until ? 0 : Math.ceil((until - now) / 1000);
    },
  };
}
