// Plain mouse provider (docs/architecture.md 5.9; Clay Rush C-03). OWNER: input engineer.
//
// The cursor position is the aim: one AimSample per pointer event, including the coalesced events the browser merged into it.
// No IMU, no calibration, no user gesture. It also emits the mouse actions: a left-button PRESS fires (an `aim` sample at the
// press position first, then `fire`, so motion.aimAt(t) of the shot is exactly where the button went down); right click = back,
// middle click = pause, double click = recenter. The press is not prevented, so its release still reaches the UI as a click
// (menus are clicked on pointerup), and it never emits `confirm`.

import { ACTION, ACTION_SOURCE } from '../shared/contracts.js';
import { INPUT_CONFIG } from './input-config.js';
import { createProviderBase, ACTION_LABELS } from './provider-base.js';
import { eventTimeMs, eventsOf, makePlayfieldMapper, attachClickActions } from './pointer-util.js';

const CAPABILITIES = Object.freeze({
  imu: false, aim: true, buttons: false, needsUserGesture: false, needsCalibration: false, hasBattery: false, canVibrate: false,
});

/** @returns {import('../shared/contracts.js').InputProvider} */
export function createMouseProvider(opts) {
  const { clock } = opts;
  const cfg = opts.config ?? INPUT_CONFIG;
  const base = createProviderBase({ kind: 'mouse', capabilities: CAPABILITIES, clock, log: opts.log, strict: opts.strictTransitions });
  const { emitter, store } = base;
  const target = opts.target ?? null;
  const mapper = makePlayfieldMapper(target, opts.toPlayfield);
  const windowTarget = opts.windowTarget ?? (typeof globalThis.window !== 'undefined' ? globalThis.window : null);

  let detach = [];
  let inside = false;
  let needDiscontinuity = true;
  let lastT = -Infinity;

  function setTracking(ok) {
    if (store.get().trackingOk !== ok) store.patch({ trackingOk: ok });
  }

  function emitAction(action) {
    emitter.emit('action', { t: clock.now(), action, label: ACTION_LABELS.mouse[action], source: ACTION_SOURCE.MOUSE });
  }

  function onPointerMove(ev) {
    const rect = mapper.rect();
    if (!inside) {
      inside = true;
      needDiscontinuity = true;
    }
    setTracking(true);
    for (const e of eventsOf(ev)) {
      const p = mapper.convert(e.clientX, e.clientY, rect);
      if (!p) continue;
      const t = eventTimeMs(clock, e, lastT);
      if (lastT !== -Infinity && t - lastT > cfg.mouse.silenceMs) needDiscontinuity = true;
      emitter.emit('aim', { t, x: p.x, y: p.y, discontinuity: needDiscontinuity });
      needDiscontinuity = false;
      lastT = t;
    }
  }

  // A click before any movement reveals a pointer that is already over the canvas (no pointermove has fired yet).
  // Left button (C-03): an aim sample at the press position, then `fire` with t = clock.now() at the event.
  function onPointerDown(ev) {
    if (ev.button !== 0) {
      if (!inside) onPointerMove(ev);
      return;
    }
    if (!inside) {
      inside = true;
      needDiscontinuity = true;
    }
    setTracking(true);
    const p = mapper.convert(ev.clientX, ev.clientY, mapper.rect());
    if (p) {
      const t = eventTimeMs(clock, ev, lastT);
      if (lastT !== -Infinity && t - lastT > cfg.mouse.silenceMs) needDiscontinuity = true;
      emitter.emit('aim', { t, x: p.x, y: p.y, discontinuity: needDiscontinuity });
      needDiscontinuity = false;
      lastT = t;
    }
    emitAction(ACTION.FIRE);
  }

  function onPointerEnter() {
    inside = true;
    needDiscontinuity = true;
    setTracking(true);
  }

  function onPointerLeave() {
    inside = false;
    needDiscontinuity = true;
    setTracking(false);
  }

  function onBlur() {
    needDiscontinuity = true;
  }

  function attach() {
    if (target && typeof target.addEventListener === 'function') {
      target.addEventListener('pointermove', onPointerMove);
      target.addEventListener('pointerdown', onPointerDown);
      target.addEventListener('pointerenter', onPointerEnter);
      target.addEventListener('pointerleave', onPointerLeave);
      detach.push(() => {
        target.removeEventListener('pointermove', onPointerMove);
        target.removeEventListener('pointerdown', onPointerDown);
        target.removeEventListener('pointerenter', onPointerEnter);
        target.removeEventListener('pointerleave', onPointerLeave);
      });
      detach.push(attachClickActions(target, emitAction));
    }
    if (windowTarget && typeof windowTarget.addEventListener === 'function') {
      windowTarget.addEventListener('blur', onBlur);
      detach.push(() => windowTarget.removeEventListener('blur', onBlur));
    }
  }

  function detachAll() {
    for (const fn of detach) fn();
    detach = [];
  }

  const provider = {
    kind: 'mouse',
    capabilities: base.capabilities,
    get status() {
      return store.get();
    },
    connect() {
      if (store.get().state === 'streaming') return Promise.resolve();
      attach();
      inside = false;
      needDiscontinuity = true;
      lastT = -Infinity;
      store.transition('streaming', { error: null, trackingOk: false, failures: 0, cooldownUntil: null });
      return Promise.resolve();
    },
    reconnect() {
      return provider.connect();
    },
    disconnect() {
      detachAll();
      inside = false;
      if (store.get().state !== 'idle') store.transition('idle', { trackingOk: false });
      return Promise.resolve();
    },
    getActionLabels: () => ({ ...ACTION_LABELS.mouse }),
    /** C-02: the mouse has no shoulder buttons; the left button always fires. */
    setTriggerButton() {},
    getDiagnostics: () => ({ kind: 'mouse', lastAimAt: lastT === -Infinity ? null : lastT }),
    on: base.on,
    off: base.off,
    dispose() {
      detachAll();
      emitter.removeAll();
    },
  };
  return provider;
}
