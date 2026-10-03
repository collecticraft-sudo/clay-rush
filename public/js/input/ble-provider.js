// Joy-Con 2 provider over Web Bluetooth (docs/architecture.md 5.3 to 5.6). OWNER: input engineer.
//
// The connection state machine of section 5.3 on top of ble-transport.js (bytes on the wire) and report-stream.js
// (bytes -> ImuSample). Player-facing behaviour, all of it UNVERIFIED-ON-HARDWARE because nobody on the team can touch a
// Joy-Con 2 (tests use test-support/input/fake-bluetooth.js, which models the protocol document, not the device):
//   * connect() opens Chrome's chooser and must be called synchronously inside a click/keydown handler.
//   * One attempt per call; failures start a cooldown (10 s, then 180 s after 3 consecutive failures) during which
//     connect()/reconnect() reject with code `cooldown` without touching the radio (UOH-11).
//   * A lost link gets ONE silent automatic retry after 2 s on the already chosen device (no chooser). Never a loop.
//   * A chooser closed without a choice is `cancelled`: no failure counted, no cooldown.
//   * The 1 Hz keep-alive and the three-stage no-data watchdog (2 s / 4.5 s / 9 s) come from protocol 5.4 and 5.5.

import { INPUT_ERROR } from '../shared/contracts.js';
import { INPUT_CONFIG } from './input-config.js';
import { resolveTimers } from './timers.js';
import { createProviderBase } from './provider-base.js';
import { createReportStream } from './report-stream.js';
import { createButtonActions, labelsForSide } from './actions.js';
import { makeErrorInfo, errorFromInfo, cooldownIntervalS, COOLDOWN_CODES, batteryLevel } from './status.js';
import { requestJoyCon, classifyRequestError, openLink, LinkError } from './ble-transport.js';

const CAPABILITIES = Object.freeze({
  imu: true, aim: false, buttons: true, needsUserGesture: true, needsCalibration: true, hasBattery: true, canVibrate: true,
});

/** @returns {import('../shared/contracts.js').InputProvider & object} */
export function createBleProvider(opts) {
  const { clock } = opts;
  const cfg = opts.config ?? INPUT_CONFIG;
  const timers = resolveTimers(opts.timers);
  const bluetooth = opts.bluetooth ?? (typeof globalThis.navigator !== 'undefined' ? globalThis.navigator.bluetooth : undefined) ?? null;
  const doc = opts.document ?? (typeof globalThis.document !== 'undefined' ? globalThis.document : null);
  const pageTarget = opts.pageTarget ?? (typeof globalThis.window !== 'undefined' ? globalThis.window : null);

  const base = createProviderBase({
    kind: 'joycon', capabilities: CAPABILITIES, clock, log: opts.log, strict: opts.strictTransitions, state: bluetooth ? 'idle' : 'error',
  });
  const { emitter, store, log } = base;

  const stream = createReportStream({
    config: cfg,
    log,
    hasListener: (type) => emitter.listenerCount(type) > 0,
    emit: (type, payload) => {
      // The first IMU sample after init is the moment the state becomes `streaming`: announce it BEFORE the sample.
      if (type === 'sample' && store.state() === 'initializing') becomeStreaming();
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

  // --- attempt bookkeeping
  let attempt = 0; // generation: async continuations of an older attempt bail out
  let inflight = null; // {gen, promise, resolve, reject}
  let link = null;
  let openingClose = null; // close() of the openLink() call that is still in progress
  let device = null; // the BluetoothDevice of the last successful chooser, re-used by reconnect()
  let origin = 'other'; // 'lost' when the running attempt is a reconnect out of the lost state
  let retryTimer = null;
  let autoRetryUsed = false;
  let lastConnectOpts = {};
  let watchdogTimers = [];
  let watchdogStage = 0;
  let initBaseAt = null;
  let watchTimer = null;
  let nextRateAt = 0;
  let lastReportAt = null;
  let lastImuAt = null;
  let visibleSince = clock.now();
  let truncatedWarned = false;
  let inactiveWarned = false;
  let timing = {};

  if (!bluetooth) {
    store.patch({ error: makeErrorInfo(INPUT_ERROR.UNSUPPORTED_BROWSER, 'navigator.bluetooth is not available (Web Bluetooth needs Chrome on a secure context such as localhost)', clock.now()) }, { emit: false });
  }

  const activeMask = () => lastConnectOpts.mask ?? cfg.featureMask;
  /**
   * The mask of watchdog stage 2. 0x37 (only ever an expert choice, no evidence on this channel) first goes to the default 0xB7;
   * anything else goes to the last resort 0xFF, which may induce phantom ZL/ZR bits (protocol audit F1).
   */
  const fallbackMaskFor = (active) => (active === 0x37 ? cfg.featureMask : cfg.fallbackMask);
  // A mask change can make the controller report phantom ZL/ZR bits: hold off the ZL and ZR BUTTONS (not actions) for 1.5 s, whatever
  // they are mapped to. With the default trigger ZR a real shot in that window is dropped too; that is safe because it can only happen
  // in the first 1.5 s of a connection after the 0xFF fallback (the calibration wizard or a resume countdown follows, never live play),
  // and later reconnects start with the working mask (n3), so the stage, and the hold-off, never comes back. With the trigger on R the
  // shots pass. UNVERIFIED-ON-HARDWARE (UOH-10).
  const holdOffRecenter = () => actions.holdOffButtons(['ZL', 'ZR'], cfg.action.recenterHoldOffMs);

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

  function rejectWith(code, message) {
    const info = makeErrorInfo(code, message, clock.now());
    base.emitError(info);
    return errorFromInfo(info);
  }

  /** Cooldown gate (architecture 5.3): the refusal never touches the radio and does not change the state. */
  function cooldownRefusal() {
    const st = store.get();
    const now = clock.now();
    if (st.cooldownUntil === null || now >= st.cooldownUntil) return null;
    const s = Math.ceil((st.cooldownUntil - now) / 1000);
    const long = st.failures >= cfg.longCooldownAfterFailures;
    return rejectWith(INPUT_ERROR.COOLDOWN, `cooling down: wait ${s} s before trying again${long ? ' (long cooldown after repeated failures)' : ''} (UNVERIFIED-ON-HARDWARE, UOH-11)`);
  }

  // --- timers
  function cancelRetryTimer() {
    if (retryTimer !== null) timers.clearTimeout(retryTimer);
    retryTimer = null;
  }
  function stopWatchdog() {
    for (const id of watchdogTimers) timers.clearTimeout(id);
    watchdogTimers = [];
  }
  function stopWatchTick() {
    if (watchTimer !== null) timers.clearInterval(watchTimer);
    watchTimer = null;
  }
  function closeLink() {
    const l = link;
    link = null;
    if (l) l.close();
    const opening = openingClose;
    openingClose = null;
    if (opening) opening(); // an attempt that has not finished opening: abort it (also a pending gatt.connect())
  }

  // --- failure handling
  /**
   * End the running attempt with an error. Counts as a failure (cooldown) when the code says so.
   * @param {number} gen
   * @param {{code:string, message:string}} err
   * @param {{count?:boolean}} [o]  count: this failure reached the connect stage (default: by code)
   */
  function failAttempt(gen, err, o = {}) {
    if (gen !== attempt) return;
    attempt++; // invalidate every continuation of this attempt
    stopWatchdog();
    closeLink();
    const now = clock.now();
    const info = makeErrorInfo(err.code ?? INPUT_ERROR.GATT_FAILURE, err.message ?? String(err), now);
    const count = o.count ?? COOLDOWN_CODES.includes(info.code);
    const patch = { error: info, trackingOk: false, packetRateHz: null };
    if (count) {
      const failures = store.get().failures + 1;
      patch.failures = failures;
      patch.cooldownUntil = now + 1000 * cooldownIntervalS(failures, cfg);
    }
    const to = info.code === INPUT_ERROR.CANCELLED ? 'idle' : origin === 'lost' ? 'lost' : 'error';
    store.transition(to, patch);
    base.emitError(info);
    const d = inflight;
    if (d) d.reject(errorFromInfo(info));
  }

  /** The link went away while streaming: `lost` with a cooldown, then one automatic retry. */
  function goLost(message) {
    const now = clock.now();
    attempt++;
    stopWatchdog();
    stopWatchTick();
    closeLink();
    const info = makeErrorInfo(INPUT_ERROR.LOST_SIGNAL, message, now);
    const failures = store.get().failures + 1;
    store.transition('lost', {
      error: info, failures, cooldownUntil: now + 1000 * cooldownIntervalS(failures, cfg), trackingOk: false, packetRateHz: null,
    });
    base.emitError(info);
    scheduleAutoRetry();
  }

  function scheduleAutoRetry() {
    if (autoRetryUsed || cfg.autoReconnectAttempts < 1 || !device) return;
    if (store.get().failures >= cfg.longCooldownAfterFailures) return;
    cancelRetryTimer();
    retryTimer = timers.setTimeout(() => {
      retryTimer = null;
      if (store.get().state !== 'lost' || inflight) return;
      autoRetryUsed = true;
      log('info', 'link lost: one automatic reconnect to the known device (no chooser)');
      startReconnect(true).catch(() => {}); // the failure is reported through status and the error event
    }, cfg.autoReconnectDelayS * 1000);
  }

  // --- streaming
  function becomeStreaming() {
    stopWatchdog();
    if (watchdogStage >= 2) {
      holdOffRecenter(); // the first reports after a mask change are the ones that can carry phantom bits
      // n3: the fallback mask is the one that works on this device: later reconnects start with it instead of repeating the
      // 4.5 s no-data stage every time (a fresh connect() with its own options still starts from the default)
      const working = store.get().featureMask;
      if (Number.isFinite(working)) lastConnectOpts.mask = working;
    }
    timing.firstReport = clock.now();
    autoRetryUsed = false;
    origin = 'other';
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
      // hidden tabs throttle timers and notifications: hidden time never counts towards the silence limit
      const reference = Math.max(lastReportAt ?? 0, visibleSince);
      if (now - reference > cfg.lostAfterMs) {
        goLost(`no report for ${Math.round(now - reference)} ms (limit ${cfg.lostAfterMs} ms)`);
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

  function startWatchdog(gen) {
    stopWatchdog();
    const t0 = initBaseAt ?? clock.now();
    const [s1, s2, s3] = cfg.watchdogMs;
    const at = (ms, fn) => watchdogTimers.push(timers.setTimeout(fn, Math.max(0, t0 + ms - clock.now())));
    const live = () => gen === attempt && store.get().state === 'initializing';
    at(s1, () => {
      if (!live()) return;
      watchdogStage = 1;
      log('warn', `no IMU data ${s1} ms after enabling: re-sending ENABLE(0x${activeMask().toString(16)}) (UNVERIFIED-ON-HARDWARE, UOH-3)`);
      link?.enable(activeMask()).catch(() => {});
    });
    at(s2, () => {
      if (!live()) return;
      watchdogStage = 2;
      const fallback = fallbackMaskFor(activeMask());
      store.patch({ featureMask: fallback });
      holdOffRecenter(); // a mask change can make the controller report phantom ZL/ZR bits
      log('warn', `no IMU data ${s2} ms after enabling: retrying with feature mask 0x${fallback.toString(16)} (UNVERIFIED-ON-HARDWARE, UOH-3)`);
      link?.configure(fallback).catch(() => {});
    });
    at(s3, () => {
      if (!live()) return;
      watchdogStage = 3;
      failAttempt(gen, new LinkError(INPUT_ERROR.NO_DATA, `no IMU data ${s3} ms after enabling the stream (UNVERIFIED-ON-HARDWARE, UOH-3)`));
    });
  }

  // --- link callbacks
  function onReport(gen, bytes, arrivedAt) {
    if (gen !== attempt) return;
    const { report } = pushReport(bytes, arrivedAt);
    if (!report) {
      if (!truncatedWarned) {
        truncatedWarned = true;
        log('warn', `notification of ${bytes.length} bytes rejected (need >= ${cfg.report.minLength}): truncated by the MTU? (UNVERIFIED-ON-HARDWARE, UOH-3)`);
      }
      return;
    }
    lastReportAt = arrivedAt;
    if (report.imuActive) lastImuAt = arrivedAt;
    else if (!inactiveWarned && store.state() === 'initializing') {
      inactiveWarned = true;
      log('warn', 'reports arrive but the IMU bytes are all zero: waiting for the IMU to switch on (UNVERIFIED-ON-HARDWARE, UOH-3)');
    }
    const mv = report.batteryMv > 0 ? report.batteryMv : null;
    store.setLive(arrivedAt, mv);
    if (mv !== null && batteryLevel(mv, cfg) !== store.batteryLevel()) store.refreshBattery(mv);
  }

  function onStage(gen, stage, info) {
    if (gen !== attempt) return;
    const now = clock.now();
    if (stage === 'connected') timing.connected = now;
    else if (stage === 'discovered') {
      timing.discovered = now;
      stream.setSide(info.side);
      log('info', `service found, side ${info.side} (from ${info.sideSource})`);
      store.transition('initializing', { side: info.side, featureMask: activeMask(), trackingOk: false });
    } else if (stage === 'commands') timing.commands = now;
    else if (stage === 'subscribed') {
      timing.subscribed = now;
      initBaseAt = now;
    }
  }

  function onLinkEvent(gen, event) {
    if (gen !== attempt) return;
    if (event.type === 'warn') log('warn', event.message);
    else if (event.type === 'write') {
      if (event.kind !== 'keepalive') log('info', `write ${event.kind}: ${event.hex}`);
    } else if (event.type === 'disconnected') {
      const state = store.get().state;
      if (state === 'streaming') goLost('link dropped (gattserverdisconnected)');
      else if (state === 'connecting' || state === 'initializing') failAttempt(gen, new LinkError(INPUT_ERROR.GATT_FAILURE, 'link dropped during connection (gattserverdisconnected)'));
    }
  }

  // --- establishing a link on a chosen device
  async function establish(gen, dev) {
    stream.reset();
    actions.reset();
    lastReportAt = null;
    lastImuAt = null;
    truncatedWarned = false;
    inactiveWarned = false;
    watchdogStage = 0;
    initBaseAt = null;
    store.transition('connecting', { trackingOk: false });
    let opened;
    let mine = null; // this attempt's close(); never clear the handle of a newer attempt
    try {
      opened = await openLink(dev, {
        clock, timers, config: cfg, mask: lastConnectOpts.mask, keepAlive: lastConnectOpts.keepAlive, sideHint: lastConnectOpts.side,
        isCancelled: () => gen !== attempt,
        onHandle: (handle) => {
          mine = handle.close;
          if (gen === attempt) openingClose = mine;
          else mine();
        },
        onReport: (bytes, at) => onReport(gen, bytes, at),
        onStage: (stage, info) => onStage(gen, stage, info),
        onEvent: (event) => onLinkEvent(gen, event),
      });
    } catch (err) {
      if (openingClose === mine) openingClose = null;
      failAttempt(gen, err);
      return;
    }
    if (openingClose === mine) openingClose = null;
    if (gen !== attempt) {
      opened.close();
      return;
    }
    link = opened;
    if (store.get().state === 'initializing') startWatchdog(gen);
  }

  function startReconnect(auto) {
    if (inflight) return inflight.promise;
    const st = store.get();
    if (st.state === 'streaming') return Promise.resolve();
    if (!bluetooth) return Promise.reject(rejectWith(INPUT_ERROR.UNSUPPORTED_BROWSER, st.error?.message ?? 'Web Bluetooth is not available'));
    if (!device) return Promise.reject(rejectWith(INPUT_ERROR.GATT_FAILURE, 'no known device: connect() with the chooser first'));
    if (!auto) {
      const refusal = cooldownRefusal();
      if (refusal) return Promise.reject(refusal);
    }
    cancelRetryTimer();
    const gen = ++attempt;
    const d = deferred(gen);
    inflight = d;
    origin = st.state === 'lost' ? 'lost' : 'other';
    timing = { requestStart: clock.now(), chosen: clock.now() };
    establish(gen, device).catch((err) => failAttempt(gen, err));
    return d.promise;
  }

  // --- the provider
  const provider = {
    kind: 'joycon',
    capabilities: base.capabilities,
    get status() {
      return store.get();
    },

    /**
     * Open Chrome's chooser and connect. Must run synchronously inside a click/keydown handler (Web Bluetooth needs
     * the user gesture): everything before requestDevice() is synchronous.
     * @param {import('../shared/contracts.js').ConnectOptions} [connectOpts]
     */
    connect(connectOpts = {}) {
      if (inflight) return inflight.promise;
      const st = store.get();
      if (st.state === 'streaming') return Promise.resolve();
      if (!bluetooth) return Promise.reject(rejectWith(INPUT_ERROR.UNSUPPORTED_BROWSER, st.error?.message ?? 'Web Bluetooth is not available'));
      const refusal = cooldownRefusal();
      if (refusal) return Promise.reject(refusal);
      cancelRetryTimer();
      lastConnectOpts = { ...connectOpts };
      autoRetryUsed = false;
      const gen = ++attempt;
      const d = deferred(gen);
      inflight = d;
      origin = 'other';
      timing = { requestStart: clock.now() };
      store.transition('requesting', { trackingOk: false });
      let chosen;
      try {
        chosen = requestJoyCon(bluetooth, { side: connectOpts.side, filter: connectOpts.filter }, cfg); // synchronous: the gesture is still valid
      } catch (err) {
        chosen = Promise.reject(err);
      }
      chosen.then(
        (dev) => {
          if (gen !== attempt) return; // disconnect() or a newer attempt happened while the chooser was open
          device = dev;
          timing.chosen = clock.now();
          store.patch({ deviceName: dev?.name ?? null });
          establish(gen, dev).catch((err) => failAttempt(gen, err));
        },
        (err) => {
          if (gen !== attempt) return;
          const c = classifyRequestError(err);
          failAttempt(gen, c, { count: false });
        },
      );
      return d.promise;
    },

    /** Re-use the known device without the chooser (subject to the cooldown). */
    reconnect() {
      return startReconnect(false);
    },

    /** User-driven: goes to `idle`, never throws. Also tears the GATT connection down. */
    disconnect() {
      attempt++;
      cancelRetryTimer();
      stopWatchdog();
      stopWatchTick();
      closeLink();
      const d = inflight;
      if (d) d.reject(errorFromInfo(makeErrorInfo(INPUT_ERROR.CANCELLED, 'disconnect() called while connecting', clock.now())));
      actions.reset();
      origin = 'other';
      if (store.get().state !== 'idle') store.transition('idle', { trackingOk: false, error: null, packetRateHz: null, featureMask: null });
      return Promise.resolve();
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

    /** Best effort haptic click (UNVERIFIED-ON-HARDWARE, UOH-13); rate limited to 10 per second, errors swallowed. */
    vibrate(presetId) {
      if (link && store.get().state === 'streaming') link.vibrate(presetId);
    },

    /** Expert toggle of the diagnostics page: stop or resume the 1 Hz keep-alive (UOH-5 experiment). */
    setKeepAlive(on) {
      lastConnectOpts.keepAlive = !!on;
      link?.setKeepAlive(on);
    },

    /** Numbers for the diagnostics page: timings, watchdog stage, writes, stream statistics. */
    getDiagnostics() {
      const now = clock.now();
      const stats = link ? link.stats() : { lastWriteAt: null, writeCount: 0, keepAlive: lastConnectOpts.keepAlive !== false };
      const d = (a, b) => (timing[a] !== undefined && timing[b] !== undefined ? timing[a] - timing[b] : null);
      return {
        kind: 'joycon',
        side: store.get().side,
        timings: {
          requestMs: d('chosen', 'requestStart'), // chooser (includes the time the player took to pick)
          connectMs: d('connected', 'chosen'),
          discoveryMs: d('discovered', 'connected'),
          initMs: d('subscribed', 'discovered'),
          firstReportMs: d('firstReport', 'subscribed'),
          totalMs: d('firstReport', 'chosen'),
        },
        featureMask: store.get().featureMask,
        watchdogStage,
        keepAlive: stats.keepAlive,
        lastWriteAt: stats.lastWriteAt,
        writeCount: stats.writeCount,
        lastReportAt,
        hidden: !!(doc && doc.hidden),
        stream: stream.getStats(now),
      };
    },

    on: base.on,
    off: base.off,
    dispose() {
      provider.disconnect();
      if (pageTarget && typeof pageTarget.removeEventListener === 'function') pageTarget.removeEventListener('pagehide', onPageHide);
      if (doc && typeof doc.removeEventListener === 'function') doc.removeEventListener('visibilitychange', onVisibility);
      emitter.removeAll();
    },
  };

  // --- page lifecycle: close the GATT connection on unload, note hidden tabs
  function onPageHide() {
    provider.disconnect();
  }
  function onVisibility() {
    if (doc.hidden) {
      const state = store.get().state;
      if (state === 'streaming' || state === 'initializing') log('warn', 'tab hidden: Chrome throttles timers (keep-alive, watchdog) and may delay notifications; keep this tab in front while playing');
    } else visibleSince = clock.now();
  }
  if (pageTarget && typeof pageTarget.addEventListener === 'function') pageTarget.addEventListener('pagehide', onPageHide);
  if (doc && typeof doc.addEventListener === 'function') doc.addEventListener('visibilitychange', onVisibility);

  return provider;
}
