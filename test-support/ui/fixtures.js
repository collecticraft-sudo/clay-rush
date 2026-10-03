// Fixtures for the UI tests: contract-conforming snapshots, events, results, provider facts, storage backends and a ready-made UI harness.
// OWNER: UI engineer. Builder outputs pass assertValid (test/ui/fixtures.test.js).

import { createManualClock } from '../../public/js/shared/clock.js';
import { createStorage } from '../../public/js/ui/storage.js';
import { createUi } from '../../public/js/ui/ui.js';

export function makeSnapshot(over = {}) {
  return {
    v: 1, mode: 'classic', difficulty: 'normal', seed: 1, phase: 'flight', t: 5, tWorld: 5, alpha: 0.5, timeScale: 1,
    stage: { index: 0, id: 'meadow', count: 3, name: 'Morning Meadow' },
    pull: { index: 2, count: 10, targetsLeft: 1 },
    wind: { x: 0, gust: 0 },
    shells: { loaded: 2, capacity: 2, reloadingS: 0, infinite: false },
    score: 350, streak: 2, multiplier: 1, multiplierProgress: 0.5, timeLeft: null, timeTotal: null, targets: [], houses: [], killCam: null,
    practice: null, stats: { presented: 3, broken: 2, lost: 1, shots: 3, hits: 2, centre: 0, doubles: 0, bestStreak: 2 }, assist: false, endReason: null,
    events: [], ...over,
  };
}

let seq = 0;
const ev = (type, fields) => ({ seq: ++seq, t: 1, type, ...fields });
export const practiceEvent = (phase) => ev('practice', { phase });
export const shotEvent = (over = {}) => ev('shot', { x: 900, y: 400, shell: 0, hitIds: [], source: 'mouse', compMs: 0, ...over });
export const hitEvent = (over = {}) => ev('hit', {
  id: 1, kind: 'standard', x: 900, y: 400, z: 20, rPx: 12, vx: 100, vy: -50, points: 100, centre: false, firstBarrel: true, multiplier: 1, streak: 1, shardSeed: 7, ...over,
});

export function roundResult(over = {}) {
  return {
    mode: 'classic', difficulty: 'normal', stageId: null, score: 4321, presented: 36, broken: 30, lost: 6, shots: 50, hits: 30, accuracy: 0.6,
    bestStreak: 9, doubles: 4, centre: 3, durationS: 180, endReason: 'complete', rank: 'B', assist: false, ...over,
  };
}

export function makeStatus(over = {}) {
  return {
    kind: 'joycon', state: 'idle', side: 'R', battery: { mv: null, level: 'unknown', pct: null }, trackingOk: false, error: null, cooldownUntil: null, failures: 0,
    deviceName: null, packetRateHz: null, lastPacketAt: null, featureMask: null, ...over,
  };
}

export const LABELS = Object.freeze({
  joycon: Object.freeze({ confirm: 'A', back: 'B', pause: '+', recenter: 'R', fire: 'ZR' }),
  keyboard: Object.freeze({ confirm: 'Enter', back: 'Esc', pause: 'P', recenter: 'C', fire: 'F' }),
  mouse: Object.freeze({ confirm: 'Click', back: 'Right click', pause: 'Middle click', recenter: 'Double click', fire: 'Click' }),
});

export function providerFact(kind, state, over = {}) {
  const status = kind ? makeStatus({ kind, state, trackingOk: state === 'streaming', ...over }) : null;
  return {
    type: 'provider', kind, status, labels: kind === 'joycon' ? LABELS.joycon : kind === 'mouse' ? LABELS.mouse : LABELS.keyboard,
    capabilities: { imu: kind !== 'mouse', aim: kind === 'mouse', buttons: kind === 'joycon', needsUserGesture: kind === 'joycon', needsCalibration: kind === 'joycon', hasBattery: kind === 'joycon', canVibrate: kind === 'joycon' },
  };
}

export const actionFact = (action, source = 'keyboard', t = 0) => ({ type: 'action', event: { t, action, label: action, source } });
export const navFact = (dir, source = 'keyboard', phase = 'down') => ({ type: 'nav', event: { t: 0, dir, phase, source } });
export const calFact = (event) => ({ type: 'calibration', event: { t: 0, ...event } });

export const nativeFact = (state, over = {}) => ({ ...providerFact('joycon', state, over), transport: 'native' });
export const probeFact = (phase, over = {}) => (phase === 'checking'
  ? { type: 'bridgeProbe', phase, preferred: over.preferred ?? null }
  : { type: 'bridgeProbe', phase: 'done', available: true, reason: null, canBuild: false, built: true, preferred: null, ...over });

export function memoryBackend(initial = {}) {
  const map = new Map(Object.entries(initial));
  return { map, getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => { map.set(k, String(v)); }, removeItem: (k) => { map.delete(k); } };
}

export function throwingBackend() {
  const boom = () => { throw new Error('storage blocked'); };
  return { getItem: boom, setItem: boom, removeItem: boom };
}

/**
 * A UI with a manual clock, a memory storage and recorders for intents and sounds. `advance(ms)` steps it in 16 ms slices.
 * @param {{startMs?:number, storage?:object, hasBluetooth?:boolean}} [opts]
 */
export function makeUiHarness(opts = {}) {
  const clock = createManualClock(opts.startMs ?? 0);
  const storage = opts.storage ?? createStorage({ backend: memoryBackend(), matchMedia: () => ({ matches: false }) });
  const intents = [];
  const sounds = [];
  const ui = createUi({ clock, storage, hasBluetooth: opts.hasBluetooth ?? true, sfx: (id, p) => sounds.push([id, p]), sfxStop: () => {} });
  ui.onIntent((i) => intents.push(i));
  let snapshot = null;
  const h = {
    ui, clock, storage, intents, sounds,
    view: () => ui.getView(),
    state: () => ui.getState(),
    setSnapshot(s) { snapshot = s; },
    step(over = {}) {
      ui.step({ nowMs: clock.now(), dtS: 0.016, snapshot, events: [], aim: { x: 960, y: 540, visible: true, trackingOk: true }, ...over });
    },
    advance(ms, over = {}) {
      let left = ms;
      while (left > 0) {
        const d = Math.min(16, left);
        clock.advance(d);
        h.step(over);
        left -= d;
      }
    },
    types: () => intents.map((i) => i.type),
    last: (type) => [...intents].reverse().find((i) => !type || i.type === type),
    clear() { intents.length = 0; sounds.length = 0; },
    press(action, source = 'keyboard') { ui.notify(actionFact(action, source, clock.now())); },
    nav(dir, source = 'keyboard') { ui.notify(navFact(dir, source, 'down')); ui.notify(navFact(dir, source, 'up')); },
    /** Boot into the menu with a simulator provider (the ?input=sim path). */
    toMenuWithSim() {
      storage.setSafetyAck();
      ui.notify(providerFact('sim', 'streaming'));
      ui.notify({ type: 'ready' });
      return h;
    },
    toMenuWithMouse() {
      storage.setSafetyAck();
      ui.notify(providerFact('mouse', 'streaming'));
      ui.notify({ type: 'ready' });
      return h;
    },
    /** Menu -> setup -> start: the countdown runs and the round plays. */
    startRound(mode = 'classic') {
      ui.activate(`menu.${mode}`);
      ui.activate('setup.start');
      h.advance(3 * 800 + 600 + 32);
      return h;
    },
  };
  return h;
}
