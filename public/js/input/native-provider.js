// Joy-Con 2 provider over the NATIVE Bluetooth bridge (docs/native-bridge.md). OWNER: input engineer.
//
// Same InputProvider interface as ble-provider.js (kind 'joycon'), same connection state machine, same error codes and cooldown rules,
// same report pipeline: the bytes of every 63-byte report go through joycon2-parse.js and report-stream.js, so the ImuSamples are
// identical to the Web Bluetooth path. Only the transport differs: a compiled CoreBluetooth helper (bridge/joycon-bridge.m) that
// server.js starts on demand, reached with fetch (commands) and EventSource (every helper line). It exists because Chrome's Web
// Bluetooth chooser listed no device on the owner's Mac while a native CoreBluetooth probe worked end to end (2026-09-30).
//
// What this file adds on top of the BLE provider:
//   * Helper statuses are mapped onto the existing states: scanning -> `requesting` (the UI's "searching" text), connecting and
//     discovering -> `connecting`, initialising -> `initializing`, the helper's `streaming` keeps `initializing` until the first IMU
//     sample arrives (then `streaming`, exactly like the BLE provider).
//   * Helper and bridge failure codes map onto the existing InputErrorInfo codes (NATIVE_ERRORS) and each gets a NEW string key
//     (error.native = {code, key}); the texts are the presentation engineer's (docs/native-bridge.md lists the proposals).
//   * Only failures that involved the controller start the cooldown (connect_failed, gatt_failure, no_data, lost_signal, stalled):
//     Bluetooth off, a denied permission, nothing found, a crashed helper or a missing server never do.
//   * No automatic retry after a lost link by default (`autoRetry`, 0): a lost Joy-Con is not advertising in pairing mode any more, so a
//     silent retry would search for 45 s and only burn the controller's connect budget. The UI offers "reconnect" instead.
//   * The helper's own timestamp `t` (monotonic ms) is mapped onto the Clock with a running minimum of (clock.now() - t), which removes
//     the jitter of pipes and SSE batching, and is handed to the report stream as the arrival time: the stream still takes dt from the
//     IMU timestamp and falls back to these arrival times only when the IMU timestamps are unusable.
//   * Events carry a sequence number `seq`; the answer to the connect request carries the last number BEFORE the attempt. Everything
//     with a lower or equal number (the tail of an earlier session) and every replayed status is ignored.
//
// Everything that needs the real helper or a real Joy-Con is UNVERIFIED-ON-HARDWARE; the tests use test-support/bridge/fake-page-bridge.js
// (a fake fetch and EventSource) and the two real captures REAL_R_1 and REAL_R_2.

import { INPUT_ERROR } from '../shared/contracts.js';
import { INPUT_CONFIG } from './input-config.js';
import { resolveTimers } from './timers.js';
import { createProviderBase } from './provider-base.js';
import { createReportStream } from './report-stream.js';
import { createButtonActions, labelsForSide } from './actions.js';
import { makeErrorInfo, errorFromInfo, cooldownIntervalS, batteryLevel } from './status.js';
import { hexToBytes } from './joycon2-parse.js';
import { createNativeLink, BridgeError } from './native-link.js';

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

const CAPABILITIES = Object.freeze({
  imu: true, aim: false, buttons: true, needsUserGesture: false, needsCalibration: true, hasBattery: true, canVibrate: true,
});

/** Numbers of the native path (the shared ones stay in INPUT_CONFIG). Override with opts.native in tests. */
export const NATIVE_CONFIG = deepFreeze({
  scanSeconds: 45, // how long the helper looks for an advert (it clamps 5..120)
  openTimeoutMs: 5000, // the event stream must open within this long
  helperStartMs: 30000, // after the connect request was accepted: the first status line from the helper
  buildMs: 150000, // while the bridge compiles the helper (first start only)
  stageMs: { connecting: 30000, discovering: 25000, initialising: 22000 }, // the helper's own timeouts (20 s, 15 s, 12 s) plus slack
  scanSlackMs: 10000,
  maxAdverts: 8,
  maxPendingEvents: 200,
});

/**
 * Bridge code -> InputErrorInfo code, whether the failure starts the cooldown, and the NEW player-visible string key.
 * `input` codes only use the existing INPUT_ERROR enum. Keys are proposals for strings.en.js (docs/native-bridge.md lists the texts).
 */
export const NATIVE_ERRORS = deepFreeze({
  bluetooth_permission: { input: INPUT_ERROR.PERMISSION_DENIED, count: false, key: 'connect.err.native.permission' },
  bluetooth_off: { input: INPUT_ERROR.GATT_FAILURE, count: false, key: 'connect.err.native.bluetoothOff' },
  no_device: { input: INPUT_ERROR.GATT_FAILURE, count: false, key: 'connect.err.native.noDevice' },
  not_pairing: { input: INPUT_ERROR.GATT_FAILURE, count: false, key: 'connect.err.native.notPairing' }, // derived from no_device + adverts
  connect_failed: { input: INPUT_ERROR.GATT_FAILURE, count: true, key: 'connect.err.native.connectFailed' },
  gatt_failure: { input: INPUT_ERROR.GATT_FAILURE, count: true, key: 'connect.err.native.gatt' },
  lost_signal: { input: INPUT_ERROR.LOST_SIGNAL, count: true, key: 'connect.err.native.lost' },
  no_data: { input: INPUT_ERROR.NO_DATA, count: true, key: 'connect.err.native.noData' },
  stalled: { input: INPUT_ERROR.GATT_FAILURE, count: true, key: 'connect.err.native.stalled' },
  helper_crashed: { input: INPUT_ERROR.GATT_FAILURE, count: false, key: 'connect.err.native.crashed' },
  helper_failed: { input: INPUT_ERROR.GATT_FAILURE, count: false, key: 'connect.err.native.helperFailed' },
  build_failed: { input: INPUT_ERROR.GATT_FAILURE, count: false, key: 'connect.err.native.buildFailed' },
  helper_missing: { input: INPUT_ERROR.UNSUPPORTED_BROWSER, count: false, key: 'connect.err.native.unavailable' },
  no_compiler: { input: INPUT_ERROR.UNSUPPORTED_BROWSER, count: false, key: 'connect.err.native.unavailable' },
  not_macos: { input: INPUT_ERROR.UNSUPPORTED_BROWSER, count: false, key: 'connect.err.native.unavailable' },
  bridge_module_error: { input: INPUT_ERROR.UNSUPPORTED_BROWSER, count: false, key: 'connect.err.native.unavailable' },
  bridge_missing: { input: INPUT_ERROR.UNSUPPORTED_BROWSER, count: false, key: 'connect.err.native.oldServer' },
  bridge_unreachable: { input: INPUT_ERROR.GATT_FAILURE, count: false, key: 'connect.err.native.noServer' },
  bridge_busy: { input: INPUT_ERROR.GATT_FAILURE, count: false, key: 'connect.err.native.busy' },
  bridge_refused: { input: INPUT_ERROR.GATT_FAILURE, count: false, key: 'connect.err.native.refused' },
  unknown: { input: INPUT_ERROR.GATT_FAILURE, count: false, key: 'connect.err.native.unknown' },
});

/** Progress phase -> NEW string key (what the connect screen shows while the provider is busy). */
export const NATIVE_PROGRESS_KEYS = deepFreeze({
  checking: 'connect.native.progress.checking',
  starting: 'connect.native.progress.starting',
  building: 'connect.native.progress.building',
  waitingBluetooth: 'connect.native.progress.waitingBluetooth',
  scanning: 'connect.native.progress.scanning',
  connecting: 'connect.native.progress.connecting',
  discovering: 'connect.native.progress.discovering',
  initialising: 'connect.native.progress.initialising',
  waitingData: 'connect.native.progress.waitingData',
});

/** Every new string key this provider can hand to the UI (errors and progress). The button and hint keys are UI-only. */
export const NATIVE_STRING_KEYS = Object.freeze([...new Set([...Object.values(NATIVE_ERRORS).map((e) => e.key), ...Object.values(NATIVE_PROGRESS_KEYS)])]);

/** The mapping entry of a bridge code (unknown codes map to `unknown`). */
export const describeNativeError = (code) => NATIVE_ERRORS[code] ?? NATIVE_ERRORS.unknown;

const HEX = /^[0-9a-fA-F]+$/;
const ORDER = ['requesting', 'connecting', 'initializing', 'streaming'];

/** @returns {import('../shared/contracts.js').InputProvider & object} */
export function createNativeProvider(opts) {
  const { clock } = opts;
  const cfg = opts.config ?? INPUT_CONFIG;
  const ncfg = { ...NATIVE_CONFIG, ...(opts.native ?? {}) };
  const timers = resolveTimers(opts.timers);
  const fetchFn = opts.fetch ?? (typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : null);
  const EventSourceCtor = opts.EventSource ?? (typeof globalThis.EventSource === 'function' ? globalThis.EventSource : null);
  const doc = opts.document ?? (typeof globalThis.document !== 'undefined' ? globalThis.document : null);
  const pageTarget = opts.pageTarget ?? (typeof globalThis.window !== 'undefined' ? globalThis.window : null);
  const autoRetries = opts.autoRetry ?? 0;
  const supported = !!(fetchFn && EventSourceCtor);

  const base = createProviderBase({
    kind: 'joycon', capabilities: CAPABILITIES, clock, log: opts.log, strict: opts.strictTransitions, state: supported ? 'idle' : 'error',
  });
  const { emitter, store, log } = base;

  const stream = createReportStream({
    config: cfg,
    log,
    hasListener: (type) => emitter.listenerCount(type) > 0,
    emit: (type, payload) => {
      // The first IMU sample is the moment the state becomes `streaming`: announce it BEFORE the sample (as the BLE provider does).
      if (type === 'sample' && inflight && store.state() !== 'streaming') {
        advanceTo('initializing');
        becomeStreaming();
      }
      if (type === 'buttons') actions.handle(payload);
      emitter.emit(type, payload);
    },
  });
  // Actions decoded from a report are emitted AFTER the report's 'sample' event (Clay Rush, C-02 / C-05): when the host turns a `fire`
  // (whose t is that report's sample time) into a shot, Motion already holds the sample, so motion.aimAt(t) is covered even at compMs 0.
  let pendingActions = null;
  const actions = createButtonActions({
    clock,
    getSide: () => store.get().side,
    emit: (event) => (pendingActions ? pendingActions.push(event) : emitter.emit('action', event)),
  });
  /** stream.push with the action events of the report deferred until its packet, buttons, nav and sample events are out. */
  function pushReport(bytes, arrivedAt) {
    pendingActions = [];
    try {
      return stream.push(bytes, arrivedAt);
    } finally {
      const list = pendingActions;
      pendingActions = null;
      for (const event of list) emitter.emit('action', event);
    }
  }

  const link = supported
    ? createNativeLink({
      fetch: fetchFn,
      EventSource: EventSourceCtor,
      timers,
      baseUrl: opts.baseUrl ?? '',
      openTimeoutMs: ncfg.openTimeoutMs,
      onEvent: (event) => onBridgeEvent(linkGen, event),
      onStreamError: (err) => onStreamBroken(linkGen, err),
    })
    : null;

  // --- attempt bookkeeping
  let attempt = 0; // generation: async continuations and events of an older attempt are ignored
  let linkGen = 0; // the generation the open event stream belongs to
  let inflight = null;
  let origin = 'other'; // 'lost' when the running attempt is a reconnect out of the lost state
  let retryTimer = null;
  let autoRetryUsed = false;
  let lastConnectOpts = {};
  let keepAlivePref = null; // the diagnostics page's expert toggle: applies to every later connect that does not say otherwise
  let bridgeActive = false; // a connect was posted and no disconnect since
  let ackSeq = null; // null until the connect request is answered; events with seq <= ackSeq are older than this attempt
  let pendingEvents = [];
  let deadlineTimer = null;
  let noDataTimer = null;
  let watchTimer = null;
  let nextRateAt = 0;
  let lastReportAt = null;
  let lastImuAt = null;
  let visibleSince = clock.now();
  let truncatedWarned = false;
  let inactiveWarned = false;
  let lastHapticAt = -Infinity;
  let timing = {};
  // helper time -> Clock time
  let clockOffset = Infinity;
  let lastHelperT = null;
  let lastMapped = -Infinity;
  // what the diagnostics page and the connect screen can show
  const native = {
    phase: 'idle', helperState: 'idle', bridge: null, adverts: [], lastCode: null, dropped: 0, badReports: 0, events: 0, scanSeconds: ncfg.scanSeconds, mask: null,
    scanStatuses: 0, scanStartedAt: null,
  };

  if (!supported) {
    store.patch({ error: nativeInfo('helper_missing', 'fetch or EventSource is not available here, so the native bridge cannot be used') }, { emit: false });
  }

  // ------------------------------------------------------------------------------------------------ errors

  function nativeInfo(bridgeCode, message, overrides = {}) {
    const m = describeNativeError(bridgeCode);
    const info = makeErrorInfo(overrides.input ?? m.input, message, clock.now());
    return Object.freeze({ ...info, native: Object.freeze({ code: bridgeCode, key: m.key }) });
  }

  function deferred(gen) {
    const d = { gen };
    d.promise = new Promise((resolve, reject) => {
      d.resolve = () => {
        if (inflight === d) inflight = null;
        resolve();
      };
      d.reject = (err) => {
        if (inflight === d) inflight = null;
        reject(err);
      };
    });
    return d;
  }

  function rejectWith(bridgeCode, message, overrides) {
    const info = nativeInfo(bridgeCode, message, overrides);
    base.emitError(info);
    return errorFromInfo(info);
  }

  /** Cooldown gate (architecture 5.3): the refusal never touches the bridge and does not change the state. */
  function cooldownRefusal() {
    const st = store.get();
    const now = clock.now();
    if (st.cooldownUntil === null || now >= st.cooldownUntil) return null;
    const s = Math.ceil((st.cooldownUntil - now) / 1000);
    const long = st.failures >= cfg.longCooldownAfterFailures;
    const info = makeErrorInfo(INPUT_ERROR.COOLDOWN, `cooling down: wait ${s} s before trying again${long ? ' (long cooldown after repeated failures)' : ''} (UNVERIFIED-ON-HARDWARE, UOH-11)`, now);
    base.emitError(info);
    return errorFromInfo(info);
  }

  /** The bridge code for a failure, refined with what the adverts said (a Joy-Con that was seen but not in pairing mode). */
  function refine(bridgeCode) {
    if (bridgeCode === 'no_device' && native.adverts.length > 0 && native.adverts.every((a) => !a.pairing)) return 'not_pairing';
    return bridgeCode;
  }

  // ------------------------------------------------------------------------------------------------ timers

  function cancelRetryTimer() {
    if (retryTimer !== null) timers.clearTimeout(retryTimer);
    retryTimer = null;
  }
  function clearDeadline() {
    if (deadlineTimer !== null) timers.clearTimeout(deadlineTimer);
    deadlineTimer = null;
  }
  function clearNoData() {
    if (noDataTimer !== null) timers.clearTimeout(noDataTimer);
    noDataTimer = null;
  }
  function stopWatchTick() {
    if (watchTimer !== null) timers.clearInterval(watchTimer);
    watchTimer = null;
  }

  /** A stage that makes no progress in `ms` ends the attempt (the helper has its own timeouts: this is the belt to its braces). */
  function armDeadline(gen, ms, what) {
    clearDeadline();
    deadlineTimer = timers.setTimeout(() => {
      deadlineTimer = null;
      if (gen !== attempt) return;
      failAttempt(gen, { bridgeCode: 'stalled', message: `the bridge made no progress for ${Math.round(ms / 1000)} s while ${what}` }, { notifyHelper: true });
    }, ms);
  }

  function setPhase(phase, message) {
    if (native.phase === phase && !message) return;
    native.phase = phase;
    emitter.emit('bridge', { phase, helperState: native.helperState, key: NATIVE_PROGRESS_KEYS[phase] ?? null, at: clock.now(), scanStartedAt: native.scanStartedAt, scanSeconds: native.scanSeconds });
    if (message) log('info', message);
  }

  // ------------------------------------------------------------------------------------------------ link management

  /** Close the event stream; tell the helper to disconnect when a connect was posted and `notify` is true. */
  function closeLink(notify, keepalive = false) {
    link?.closeEvents();
    if (notify && bridgeActive) {
      bridgeActive = false;
      link?.disconnect({ keepalive });
    } else if (notify) bridgeActive = false;
  }

  /** Move forward through the legal states (never backwards, never out of a dead attempt). */
  function advanceTo(target, patch = {}) {
    const from = ORDER.indexOf(store.state());
    const to = ORDER.indexOf(target);
    if (from < 0) return;
    if (to <= from) {
      if (to === from && Object.keys(patch).length) store.patch(patch);
      return;
    }
    for (let i = from + 1; i <= to; i++) store.transition(ORDER[i], i === to ? patch : {});
  }

  // ------------------------------------------------------------------------------------------------ failure handling

  /**
   * End the running attempt with an error. `problem` is {bridgeCode, message}.
   * @param {{count?:boolean, notifyHelper?:boolean}} [o]  notifyHelper: tell the helper to disconnect (the failure is ours, not its)
   */
  function failAttempt(gen, problem, o = {}) {
    if (gen !== attempt) return;
    attempt++; // invalidate every continuation and event of this attempt
    clearDeadline();
    clearNoData();
    closeLink(o.notifyHelper === true);
    bridgeActive = false; // the attempt is over: a later disconnect() must not touch a session that is not ours (another tab's)
    const now = clock.now();
    const code = refine(problem.bridgeCode);
    native.lastCode = code;
    const info = nativeInfo(code, problem.message);
    const count = o.count ?? describeNativeError(code).count;
    const patch = { error: info, trackingOk: false, packetRateHz: null };
    if (count) {
      const failures = store.get().failures + 1;
      patch.failures = failures;
      patch.cooldownUntil = now + 1000 * cooldownIntervalS(failures, cfg);
    }
    setPhase('idle');
    const to = info.code === INPUT_ERROR.CANCELLED ? 'idle' : origin === 'lost' ? 'lost' : 'error';
    store.transition(to, patch);
    base.emitError(info);
    const d = inflight;
    if (d) d.reject(errorFromInfo(info));
  }

  /** The link went away while streaming: `lost` with a cooldown, then (optionally) one automatic retry. */
  function goLost(bridgeCode, message, { notifyHelper = false } = {}) {
    const now = clock.now();
    attempt++;
    clearDeadline();
    clearNoData();
    stopWatchTick();
    closeLink(notifyHelper); // a loss WE detected (silence, broken stream) leaves the helper connected: tell it to let go
    bridgeActive = false;
    native.lastCode = bridgeCode;
    const info = nativeInfo(bridgeCode, message, { input: INPUT_ERROR.LOST_SIGNAL });
    const failures = store.get().failures + 1;
    setPhase('idle');
    store.transition('lost', {
      error: info, failures, cooldownUntil: now + 1000 * cooldownIntervalS(failures, cfg), trackingOk: false, packetRateHz: null,
    });
    base.emitError(info);
    scheduleAutoRetry();
  }

  function scheduleAutoRetry() {
    if (autoRetryUsed || autoRetries < 1) return;
    if (store.get().failures >= cfg.longCooldownAfterFailures) return;
    cancelRetryTimer();
    retryTimer = timers.setTimeout(() => {
      retryTimer = null;
      if (store.get().state !== 'lost' || inflight) return;
      autoRetryUsed = true;
      log('info', 'link lost: one automatic reconnect through the bridge');
      begin(lastConnectOpts, 'lost').catch(() => {}); // the failure is reported through status and the error event
    }, cfg.autoReconnectDelayS * 1000);
  }

  // ------------------------------------------------------------------------------------------------ streaming

  function becomeStreaming() {
    clearDeadline();
    clearNoData();
    timing.firstReport = clock.now();
    autoRetryUsed = false;
    origin = 'other';
    setPhase('streaming');
    store.transition('streaming', { error: null, failures: 0, cooldownUntil: null, trackingOk: true });
    startWatchTick();
    const d = inflight;
    if (d) d.resolve();
  }

  function startWatchTick() {
    stopWatchTick();
    nextRateAt = clock.now() + cfg.report.rateWindowMs;
    watchTimer = timers.setInterval(watchTick, cfg.watchTickMs);
  }

  function watchTick() {
    const st = store.get();
    if (st.state !== 'streaming') return;
    const now = clock.now();
    if (!(doc && doc.hidden)) {
      // hidden tabs throttle timers: hidden time never counts towards the silence limit
      const reference = Math.max(lastReportAt ?? 0, visibleSince);
      if (now - reference > cfg.lostAfterMs) {
        goLost('lost_signal', `no report for ${Math.round(now - reference)} ms (limit ${cfg.lostAfterMs} ms)`, { notifyHelper: true });
        return;
      }
    }
    const fresh = lastImuAt !== null && now - lastImuAt <= cfg.trackingStaleMs;
    if (st.trackingOk !== fresh) store.patch({ trackingOk: fresh });
    if (now >= nextRateAt) {
      nextRateAt = now + cfg.report.rateWindowMs;
      store.patch({ packetRateHz: stream.getRateHz(now) });
    }
  }

  /** The helper's monotonic time mapped onto the Clock: running minimum of (now - t), leaking up slowly (drift), never later than now. */
  function arrivalFor(helperT, now) {
    if (typeof helperT !== 'number' || !Number.isFinite(helperT)) return Math.max(now, lastMapped);
    if (lastHelperT !== null && clockOffset !== Infinity) clockOffset += cfg.report.offsetLeakPerMs * Math.max(0, helperT - lastHelperT);
    const candidate = now - helperT;
    if (candidate < clockOffset) clockOffset = candidate;
    lastHelperT = helperT;
    let at = Math.min(now, helperT + clockOffset);
    if (at < lastMapped) at = lastMapped;
    lastMapped = at;
    return at;
  }

  function onReport(ev) {
    const hex = ev.hex;
    if (typeof hex !== 'string' || hex.length < 2 || hex.length % 2 !== 0 || !HEX.test(hex)) {
      native.badReports++;
      return;
    }
    const bytes = hexToBytes(hex);
    const now = clock.now();
    const arrivedAt = arrivalFor(ev.t, now);
    const { report } = pushReport(bytes, arrivedAt);
    if (!report) {
      if (!truncatedWarned) {
        truncatedWarned = true;
        log('warn', `report of ${bytes.length} bytes rejected (need >= ${cfg.report.minLength}) (UNVERIFIED-ON-HARDWARE)`);
      }
      return;
    }
    lastReportAt = now;
    if (report.imuActive) lastImuAt = now;
    else if (!inactiveWarned && store.state() === 'initializing') {
      inactiveWarned = true;
      log('warn', 'reports arrive but the IMU bytes are all zero: waiting for the IMU to switch on (UNVERIFIED-ON-HARDWARE)');
    }
    const mv = report.batteryMv > 0 ? report.batteryMv : null;
    store.setLive(now, mv);
    if (mv !== null && batteryLevel(mv, cfg) !== store.batteryLevel()) store.refreshBattery(mv);
  }

  // ------------------------------------------------------------------------------------------------ events from the bridge

  function onBridgeEvent(gen, ev) {
    if (gen !== attempt || !ev || typeof ev !== 'object') return;
    if (ev.replay) return; // a replayed status describes the past, never this attempt
    if (ev.type === 'bridge') {
      handleEvent(gen, ev); // progress of the server itself (compiling, starting): it arrives WHILE the connect request is still open
      return;
    }
    if (ackSeq === null) {
      // the connect request has not been answered yet: keep the events until we know which ones are ours
      if (pendingEvents.length < ncfg.maxPendingEvents) pendingEvents.push(ev);
      return;
    }
    if (Number.isInteger(ev.seq) && ev.seq <= ackSeq) return; // the tail of an earlier session
    handleEvent(gen, ev);
  }

  function handleEvent(gen, ev) {
    native.events++;
    switch (ev.type) {
      case 'report':
        onReport(ev);
        break;
      case 'status':
        onHelperStatus(gen, ev);
        break;
      case 'advert': {
        if (ev.side !== 'L' && ev.side !== 'R') break;
        if (native.phase === 'waitingBluetooth') startScanPhase(); // an advert proves that the scan is running (a helper that sent one `scanning` status only)
        const pairing = ev.pairing === true;
        const entry = { side: ev.side, rssi: Number.isFinite(ev.rssi) ? ev.rssi : null, pairing, at: clock.now() };
        const i = native.adverts.findIndex((a) => a.side === entry.side && a.pairing === entry.pairing);
        if (i >= 0) native.adverts[i] = entry;
        else if (native.adverts.length < ncfg.maxAdverts) native.adverts.push(entry);
        break;
      }
      case 'bridge':
        if (ev.phase === 'building') {
          setPhase('building', 'the bridge is compiling the helper (first start only)');
          armDeadline(gen, ncfg.buildMs, 'compiling the helper');
        } else if (ev.phase === 'built') {
          log('info', ev.ok === false ? 'the helper build reported a problem' : 'the helper is built');
        } else if (ev.phase === 'starting') {
          setPhase('starting');
          armDeadline(gen, ncfg.helperStartMs, 'starting the helper');
        }
        break;
      default:
        break; // 'response' and 'hello' need no action
    }
  }

  /** The scan really runs: remember when (the connect screen counts the scan seconds down from here) and announce the phase. */
  function startScanPhase() {
    if (native.scanStartedAt !== null) return;
    native.scanStartedAt = clock.now();
    setPhase('scanning');
  }

  function applySide(side) {
    stream.setSide(side);
    if (store.get().side !== side) {
      log('info', `side ${side} (from the helper)`);
      store.patch({ side });
    }
  }

  function onHelperStatus(gen, ev) {
    if (ev.warning) {
      if (ev.warning === 'bad_length') native.dropped = Number.isFinite(ev.dropped) ? ev.dropped : native.dropped + 1;
      log('warn', `bridge warning ${ev.warning}: ${ev.message ?? ''}`.trim());
      return;
    }
    const s = ev.state;
    native.helperState = s;
    if (ev.side === 'L' || ev.side === 'R') applySide(ev.side);
    switch (s) {
      case 'scanning':
        timing.scanning ??= clock.now();
        native.scanStatuses += 1;
        // The helper sends `scanning` twice: when the command is accepted ("waiting for Bluetooth": a macOS permission prompt may be
        // open) and when the scan really starts (the scan time runs from there). Only the second one starts the countdown.
        if (native.scanStatuses === 1) setPhase('waitingBluetooth');
        else startScanPhase();
        armDeadline(gen, native.scanSeconds * 1000 + ncfg.scanSlackMs, 'searching for the Joy-Con');
        break;
      case 'connecting':
        timing.connecting ??= clock.now();
        setPhase('connecting');
        advanceTo('connecting');
        armDeadline(gen, ncfg.stageMs.connecting, 'connecting to the Joy-Con');
        break;
      case 'discovering':
        timing.discovering ??= clock.now();
        setPhase('discovering');
        advanceTo('connecting');
        armDeadline(gen, ncfg.stageMs.discovering, 'reading the services of the Joy-Con');
        break;
      case 'initialising':
        timing.initialising ??= clock.now();
        setPhase('initialising');
        advanceTo('initializing', { featureMask: native.mask, trackingOk: false });
        armDeadline(gen, ncfg.stageMs.initialising, 'initialising the Joy-Con');
        break;
      case 'streaming':
        timing.helperStreaming ??= clock.now();
        setPhase('waitingData');
        advanceTo('initializing', { featureMask: native.mask, trackingOk: false });
        clearDeadline();
        armNoData(gen);
        break;
      case 'disconnected':
        if (store.state() === 'streaming') goLost('lost_signal', 'the bridge reports that the Joy-Con was disconnected');
        else failAttempt(gen, { bridgeCode: 'gatt_failure', message: 'the bridge disconnected the Joy-Con during setup' });
        break;
      case 'error': {
        const code = typeof ev.code === 'string' ? ev.code : 'gatt_failure';
        const message = typeof ev.message === 'string' ? ev.message : code;
        if (store.state() === 'streaming') goLost(code === 'lost_signal' ? code : refine(code), message);
        else failAttempt(gen, { bridgeCode: code, message });
        break;
      }
      default:
        break; // 'idle' (helper startup) and unknown states
    }
  }

  /** The helper says it is streaming: the first IMU sample must follow within watchdogMs[2] (9 s), or the attempt fails with no_data. */
  function armNoData(gen) {
    clearNoData();
    const ms = cfg.watchdogMs[cfg.watchdogMs.length - 1];
    noDataTimer = timers.setTimeout(() => {
      noDataTimer = null;
      if (gen !== attempt || store.state() === 'streaming') return;
      failAttempt(gen, { bridgeCode: 'no_data', message: `no IMU data ${ms} ms after the stream started (UNVERIFIED-ON-HARDWARE)` }, { notifyHelper: true });
    }, ms);
  }

  function onStreamBroken(gen, err) {
    if (gen !== attempt) return;
    if (store.state() === 'streaming') goLost('lost_signal', `${err.message} (the bridge link is gone)`, { notifyHelper: true });
    else failAttempt(gen, { bridgeCode: err.code ?? 'bridge_unreachable', message: err.message }, { notifyHelper: true });
  }

  // ------------------------------------------------------------------------------------------------ an attempt

  function resetAttemptState() {
    stream.reset();
    actions.reset();
    lastReportAt = null;
    lastImuAt = null;
    truncatedWarned = false;
    inactiveWarned = false;
    ackSeq = null;
    pendingEvents = [];
    clockOffset = Infinity;
    lastHelperT = null;
    lastMapped = -Infinity;
    native.helperState = 'idle';
    native.adverts = [];
    native.dropped = 0;
    native.badReports = 0;
    native.events = 0;
    native.lastCode = null;
    native.phase = 'idle';
    native.scanStatuses = 0;
    native.scanStartedAt = null;
  }

  function connectParams(connectOpts) {
    const params = { side: connectOpts.side === 'L' || connectOpts.side === 'R' ? connectOpts.side : 'any', scanSeconds: ncfg.scanSeconds };
    if (Number.isInteger(connectOpts.mask)) params.mask = connectOpts.mask;
    if ((connectOpts.keepAlive ?? keepAlivePref) === false) params.keepAliveHz = 0;
    if (typeof connectOpts.pairingOnly === 'boolean') params.pairingOnly = connectOpts.pairingOnly;
    if (Number.isFinite(connectOpts.scanSeconds)) params.scanSeconds = connectOpts.scanSeconds;
    return params;
  }

  async function startAttempt(gen, params) {
    try {
      setPhase('checking');
      armDeadline(gen, ncfg.openTimeoutMs * 2, 'checking the bridge');
      const status = await link.status();
      if (gen !== attempt) return;
      native.bridge = status;
      if (!status || status.available !== true) {
        failAttempt(gen, { bridgeCode: typeof status?.reason === 'string' ? status.reason : 'helper_missing', message: `the native bridge is not available on this server (${status?.reason ?? 'unknown reason'})` });
        return;
      }
      await link.openEvents();
      if (gen !== attempt) return;
      linkGen = gen;
      bridgeActive = true; // from here on a cancel must tell the helper
      setPhase('starting');
      armDeadline(gen, ncfg.buildMs, 'waiting for the bridge to start the helper');
      const ack = await link.connect(params);
      if (gen !== attempt) return;
      ackSeq = Number.isInteger(ack.seq) ? ack.seq : -1;
      armDeadline(gen, ncfg.helperStartMs, 'waiting for the first status of the helper');
      const buffered = pendingEvents;
      pendingEvents = [];
      for (const ev of buffered) {
        if (gen !== attempt) return;
        if (Number.isInteger(ev.seq) && ev.seq <= ackSeq) continue;
        handleEvent(gen, ev);
      }
    } catch (err) {
      const code = err instanceof BridgeError ? err.code : 'bridge_unreachable';
      failAttempt(gen, { bridgeCode: code, message: err && err.message ? err.message : String(err) }, { notifyHelper: false });
    }
  }

  /** Start an attempt. `from` is the state the attempt starts out of ('lost' keeps failures going back to `lost`). */
  function begin(connectOpts, from) {
    cancelRetryTimer();
    lastConnectOpts = { ...connectOpts };
    if (from !== 'lost') autoRetryUsed = false;
    const gen = ++attempt;
    linkGen = gen;
    const d = deferred(gen);
    inflight = d;
    origin = from === 'lost' ? 'lost' : 'other';
    timing = { requestStart: clock.now() };
    resetAttemptState();
    const params = connectParams(connectOpts);
    native.scanSeconds = params.scanSeconds;
    native.mask = Number.isInteger(params.mask) ? params.mask : cfg.featureMask;
    // a reconnect out of `lost` goes lost -> connecting (the table has no lost -> requesting -> lost round trip), like the BLE provider
    store.transition(from === 'lost' ? 'connecting' : 'requesting', { trackingOk: false, featureMask: null });
    startAttempt(gen, params);
    return d.promise;
  }

  // ------------------------------------------------------------------------------------------------ the provider

  const provider = {
    kind: 'joycon',
    /** The transport behind the 'joycon' kind: lets the UI tell the native bridge from Web Bluetooth (the BLE provider has none). */
    transport: 'native',
    capabilities: base.capabilities,
    get status() {
      return store.get();
    },

    /**
     * Ask the bridge to find, connect and initialise a Joy-Con 2. Needs no user gesture (there is no chooser), but the UI still calls
     * it from a click. One attempt per call; idempotent while one is running.
     * @param {import('../shared/contracts.js').ConnectOptions} [connectOpts]  side, mask, keepAlive as for BLE; `filter` is ignored
     *   (there is no chooser); `pairingOnly` (default true) and `scanSeconds` are native-only expert options.
     */
    connect(connectOpts = {}) {
      if (inflight) return inflight.promise;
      const st = store.get();
      if (st.state === 'streaming') return Promise.resolve();
      if (!supported) return Promise.reject(rejectWith('helper_missing', st.error?.message ?? 'the native bridge is not available'));
      const refusal = cooldownRefusal();
      if (refusal) return Promise.reject(refusal);
      return begin(connectOpts, 'other');
    },

    /** Another attempt with the options of the last connect (subject to the cooldown). The Joy-Con must be in pairing mode again. */
    reconnect() {
      if (inflight) return inflight.promise;
      const st = store.get();
      if (st.state === 'streaming') return Promise.resolve();
      if (!supported) return Promise.reject(rejectWith('helper_missing', st.error?.message ?? 'the native bridge is not available'));
      const refusal = cooldownRefusal();
      if (refusal) return Promise.reject(refusal);
      return begin(lastConnectOpts, st.state === 'lost' ? 'lost' : 'other');
    },

    /** User-driven: goes to `idle`, never throws. Also tells the bridge to disconnect the Joy-Con. */
    disconnect() {
      return disconnectNow(false);
    },

    getActionLabels: () => ({ ...labelsForSide(store.get().side, actions.getTriggerButton()) }),

    /**
     * Clay Rush C-02: which shoulder button is the trigger. 'ZR' (default): ZR (ZL on a Left unit) fires, R (L) recentres; 'R' swaps
     * them. Unknown values are ignored. Takes effect on the next report; getActionLabels() follows it.
     * @param {'ZR'|'R'} button
     */
    setTriggerButton(button) {
      const before = actions.getTriggerButton();
      const now = actions.setTriggerButton(button);
      if (now !== before) log('info', `trigger button: ${now}`);
    },

    /** Best effort haptic click (UNVERIFIED-ON-HARDWARE); rate limited to 10 per second, errors swallowed. */
    vibrate(presetId) {
      if (!link || store.get().state !== 'streaming') return;
      const now = clock.now();
      if (now - lastHapticAt < cfg.hapticMinIntervalMs) return;
      lastHapticAt = now;
      link.rumble(presetId);
    },

    /** Expert toggle of the diagnostics page. The helper fixes the keep-alive when the connection starts: it applies to the NEXT connect. */
    setKeepAlive(on) {
      keepAlivePref = !!on;
      log('info', `keep-alive ${on ? 'on' : 'off'}: applies to the next connect (the native helper reads it at the start)`);
    },

    /** What the connect screen needs while busy: the phase, its string key, the last bridge code, the adverts that were seen. */
    getBridgeInfo() {
      return {
        phase: native.phase,
        key: NATIVE_PROGRESS_KEYS[native.phase] ?? null,
        helperState: native.helperState,
        bridge: native.bridge,
        adverts: native.adverts.map((a) => ({ ...a })),
        scanStartedAt: native.scanStartedAt,
        scanSeconds: native.scanSeconds,
        lastCode: native.lastCode,
        dropped: native.dropped,
        badReports: native.badReports,
      };
    },

    /** Numbers for the diagnostics page (same shape as the BLE provider, plus `native`). */
    getDiagnostics() {
      const now = clock.now();
      const d = (a, b) => (timing[a] !== undefined && timing[b] !== undefined ? timing[a] - timing[b] : null);
      return {
        kind: 'joycon',
        transport: 'native-bridge',
        side: store.get().side,
        timings: {
          requestMs: d('connecting', 'scanning'), // the time the helper waited for the advert (the player's SYNC press)
          connectMs: d('discovering', 'connecting'),
          discoveryMs: d('initialising', 'discovering'),
          initMs: d('helperStreaming', 'initialising'),
          firstReportMs: d('firstReport', 'helperStreaming'),
          totalMs: d('firstReport', 'requestStart'),
        },
        featureMask: store.get().featureMask,
        watchdogStage: 0,
        keepAlive: (lastConnectOpts.keepAlive ?? keepAlivePref) !== false,
        lastWriteAt: null,
        writeCount: null,
        lastReportAt,
        hidden: !!(doc && doc.hidden),
        stream: stream.getStats(now),
        native: { phase: native.phase, helperState: native.helperState, bridge: native.bridge, lastCode: native.lastCode, dropped: native.dropped, badReports: native.badReports, events: native.events },
      };
    },

    on: base.on,
    off: base.off,
    dispose() {
      disconnectNow(false);
      if (pageTarget && typeof pageTarget.removeEventListener === 'function') pageTarget.removeEventListener('pagehide', onPageHide);
      if (doc && typeof doc.removeEventListener === 'function') doc.removeEventListener('visibilitychange', onVisibility);
      emitter.removeAll();
    },
  };

  function disconnectNow(keepalive) {
    attempt++;
    cancelRetryTimer();
    clearDeadline();
    clearNoData();
    stopWatchTick();
    closeLink(true, keepalive);
    const d = inflight;
    if (d) d.reject(errorFromInfo(makeErrorInfo(INPUT_ERROR.CANCELLED, 'disconnect() called while connecting', clock.now())));
    actions.reset();
    origin = 'other';
    setPhase('idle');
    native.helperState = 'idle';
    if (store.get().state !== 'idle') store.transition('idle', { trackingOk: false, error: null, packetRateHz: null, featureMask: null });
    return Promise.resolve();
  }

  // --- page lifecycle: disconnect on unload (the request must outlive the page), note hidden tabs
  function onPageHide() {
    disconnectNow(true);
  }
  function onVisibility() {
    if (doc.hidden) {
      const state = store.get().state;
      if (state === 'streaming' || state === 'initializing') log('warn', 'tab hidden: Chrome throttles timers (silence detection) and may delay events; keep this tab in front while playing');
    } else visibleSince = clock.now();
  }
  if (pageTarget && typeof pageTarget.addEventListener === 'function') pageTarget.addEventListener('pagehide', onPageHide);
  if (doc && typeof doc.addEventListener === 'function') doc.addEventListener('visibilitychange', onVisibility);

  return provider;
}
