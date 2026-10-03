// The whole app on the Bluetooth provider, against the FAKE Web Bluetooth stack of test-support/input. The fake models
// docs/joycon2-protocol.md, NOT the physical controller: a green test here proves the wiring (connect gesture, status facts,
// calibration wizard, disconnect overlay, cooldown) against the protocol document, never against a real Joy-Con 2.
// Everything hardware-dependent stays UNVERIFIED-ON-HARDWARE.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createManualClock } from '../../public/js/shared/clock.js';
import { createFakeTimers } from '../../test-support/input/fake-timers.js';
import { createFakeBluetooth } from '../../test-support/input/fake-bluetooth.js';
import { makeApp } from '../../test-support/app/harness.js';
import { STRINGS } from '../../public/js/ui/strings.en.js';
import { angleDeg } from '../../test-support/motion/harness.js';
import { INPUT_CONFIG } from '../../public/js/input/input-config.js';

/** A localStorage stand-in that records the writes (`sets` all of them, `filterSets` those of the remembered chooser filter, `pathSets` those of the remembered path). */
function memoryStore(initial = {}) {
  const map = new Map(Object.entries(initial));
  const sets = [];
  return {
    map, sets,
    get filterSets() { return sets.filter(([k]) => k === INPUT_CONFIG.filterStorageKey); },
    get pathSets() { return sets.filter(([k]) => k === INPUT_CONFIG.pathStorageKey); },
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { sets.push([k, String(v)]); map.set(k, String(v)); },
  };
}
const FILTER_KEY = INPUT_CONFIG.filterStorageKey;

async function bleApp(behaviour = {}, search = '?input=joycon&clock=manual&skipsafety=1&mute=1', extra = {}) {
  const clock = createManualClock(1000);
  const timers = createFakeTimers(clock);
  const fake = createFakeBluetooth({ clock, timers, behaviour });
  const h = await makeApp(search, { ...extra, env: { clock, timers, bluetooth: fake.bluetooth } });
  const t = {
    h, clock, timers, fake,
    /** advance time in 16 ms frames with the fake timers firing and the app stepping */
    async run(ms) {
      for (let el = 0; el < ms; el += 16) {
        await timers.advance(16);
        h.app.step();
      }
    },
    async until(pred, maxMs = 20000) {
      let el = 0;
      while (!pred() && el < maxMs) {
        await t.run(48);
        el += 48;
      }
    },
    state: () => h.snap().provider.state,
    screen: () => h.screen(),
  };
  return t;
}

const POSE_TIP_UP = () => ({ accelRaw: { x: 0, y: 0, z: 4096 }, gyroRaw: { x: 0, y: 0, z: 0 } });
const POSE_FORWARD = () => ({ accelRaw: { x: 4096, y: 0, z: 0 }, gyroRaw: { x: 0, y: 0, z: 0 } });

test('joycon: ?input=joycon shows the connect screen; Enter is the user gesture that opens the chooser and connects', async () => {
  const t = await bleApp();
  try {
    assert.equal(t.screen(), 'connect');
    assert.equal(t.state(), 'idle');
    assert.equal(t.h.snap().provider.kind, 'joycon');
    t.h.key('Enter');
    assert.equal(t.fake.log.requests.length, 1, 'requestDevice ran synchronously inside the key handler (the user gesture)');
    assert.equal(t.state(), 'requesting');
    await t.until(() => t.state() === 'streaming', 15000);
    assert.equal(t.state(), 'streaming');
    assert.equal(t.h.snap().provider.side, 'R');
    assert.ok(t.fake.onlyCommandWrites(), 'only the command characteristic was ever written');
    assert.deepEqual(t.h.problems().filter((l) => l.level === 'error'), []);
  } finally {
    t.h.dispose();
  }
});

test('joycon: streaming leads to the calibration wizard on its own (1.5 s), which passes its three steps on protocol-model data', async () => {
  const t = await bleApp();
  try {
    t.fake.setMotion(POSE_TIP_UP);
    t.h.key('Enter');
    await t.until(() => t.screen() === 'calibration', 20000);
    assert.equal(t.screen(), 'calibration');
    assert.equal(t.h.c.getUiState().calibrationStep, 1);
    await t.until(() => t.h.c.getUiState().calibrationStep === 2 || t.h.c.getMotionState().calibrationStep === 2, 8000);
    // the player turns the sword towards the screen: gravity moves from the device z axis to the x axis
    t.fake.setMotion(POSE_FORWARD);
    await t.until(() => t.h.c.getUiState().calibrationStep === 4, 20000);
    assert.equal(t.h.c.getUiState().calibrationStep, 4, `the wizard finished (screen ${t.screen()}, step ${t.h.c.getUiState().calibrationStep})`);
    const cal = t.h.c.getCalibration();
    assert.ok(cal, 'Motion holds a Calibration');
    assert.equal(cal.side, 'R');
    assert.equal(t.h.snap().mode, 'practice', 'step 4 is the practice round');
    assert.equal(t.h.snap().calibrated, true);
  } finally {
    t.h.dispose();
  }
});

test('joycon: a dropped link during play pauses the round under the overlay; the automatic reconnect re-uses the device and the round resumes', async () => {
  const t = await bleApp();
  try {
    t.fake.setMotion(POSE_TIP_UP);
    t.h.key('Enter');
    await t.until(() => t.h.c.getUiState().calibrationStep === 2 || t.h.c.getMotionState().calibrationStep === 2, 25000);
    t.fake.setMotion(POSE_FORWARD);
    await t.until(() => t.h.c.getUiState().calibrationStep === 4, 20000);
    // leave the practice round the fast way and start a real one
    t.h.c.start('classic', { seed: 3 });
    await t.run(1500);
    const t0 = t.h.snap().t;
    assert.ok(t0 > 1);
    t.fake.dropLink();
    await t.run(100);
    assert.equal(t.state(), 'lost');
    assert.equal(t.screen(), 'paused');
    assert.equal(t.h.snap().overlay, 'disconnected');
    await t.until(() => t.state() === 'streaming', 30000);
    assert.equal(t.state(), 'streaming', 'the single silent retry re-used the known device (no chooser)');
    assert.equal(t.fake.log.requests.length, 1, 'no second chooser');
    await t.until(() => t.h.snap().overlay === null && t.h.ui().gameActive, 30000);
    assert.equal(t.h.snap().overlay, null);
    await t.run(1000);
    assert.ok(t.h.snap().t > t0, 'the round went on after the quick re-centre and the 3-2-1');
  } finally {
    t.h.dispose();
  }
});

test('joycon: a failed connection starts the cooldown, and switching to the mouse and back does NOT reset it (the provider instance is kept)', async () => {
  const t = await bleApp({ connect: 'fail' });
  try {
    t.h.key('Enter');
    await t.until(() => t.state() === 'error', 20000);
    assert.equal(t.state(), 'error');
    const st = t.h.c.debug.getProviderStatus();
    assert.equal(st.error.code, 'gatt_failure');
    assert.ok(st.cooldownUntil > t.clock.now(), 'cooldown running');
    assert.equal(st.failures, 1);
    // use the mouse for a moment
    assert.equal(t.h.app.presentation.ui.activate('connect.mouse'), true);
    await t.run(100);
    assert.equal(t.h.snap().provider.kind, 'mouse');
    // and come back to the Joy-Con: the same instance, still cooling down, no radio activity
    const connectCalls = t.fake.log.connectCalls;
    t.h.app.presentation.ui.force('connect');
    t.h.key('Enter');
    await t.run(100);
    assert.equal(t.h.snap().provider.kind, 'joycon');
    assert.equal(t.fake.log.connectCalls, connectCalls, 'nothing touched the radio during the cooldown');
    assert.equal(t.fake.log.requests.length, 1, 'no new chooser either');
    assert.equal(t.h.c.debug.getProviderStatus().failures, 1);
  } finally {
    t.h.dispose();
  }
});

test('joycon: without Web Bluetooth the connect screen says so and the mouse and simulator still work', async () => {
  const h = await makeApp('?clock=manual&skipsafety=1&mute=1', { bluetooth: false });
  try {
    assert.equal(h.screen(), 'connect');
    assert.equal(h.app.presentation.ui.getView().hasBluetooth, false);
    assert.equal(h.app.presentation.ui.activate('connect.sim'), true);
    h.run(200);
    assert.equal(h.screen(), 'menu');
    assert.equal(h.snap().provider.kind, 'sim');
  } finally {
    h.dispose();
  }
});

test('joycon: the connect screen button for the simulator and the mouse switch providers and calibration follows the provider', async () => {
  const h = await makeApp('?clock=manual&skipsafety=1&mute=1');
  try {
    assert.equal(h.screen(), 'connect');
    assert.equal(h.app.presentation.ui.activate('connect.sim'), true);
    h.run(200);
    assert.equal(h.snap().provider.kind, 'sim');
    assert.equal(h.snap().calibrated, true);
    assert.equal(h.screen(), 'menu', 'the simulator needs no calibration: straight to the menu');
    h.c.debug.forceScreen('connect');
    h.run(600);
    assert.equal(h.app.presentation.ui.activate('connect.mouse'), true);
    h.run(200);
    assert.equal(h.snap().provider.kind, 'mouse');
    assert.equal(h.c.sim, null);
  } finally {
    h.dispose();
  }
});

test('joycon: the gyro scale saved by the diagnostics page (joyconNinja.imu.v1) is used by the wizard as the stored scale', async () => {
  const store = { 'joyconNinja.imu.v1': JSON.stringify({ gyroScale: 0.12288, measuredAt: '2026-09-30T00:00:00.000Z' }) };
  const t = await bleApp({}, '?input=joycon&clock=manual&skipsafety=1&mute=1', { localStorage: { getItem: (k) => store[k] ?? null } });
  try {
    t.fake.setMotion(POSE_TIP_UP);
    t.h.key('Enter');
    await t.until(() => t.h.c.getUiState().calibrationStep === 2 || t.h.c.getMotionState().calibrationStep === 2, 25000);
    t.fake.setMotion(POSE_FORWARD);
    await t.until(() => t.h.c.getUiState().calibrationStep === 4, 20000);
    const cal = t.h.c.getCalibration();
    assert.equal(cal.gyroScaleSource, 'stored');
    assert.equal(cal.gyroScale, 0.12288);
  } finally {
    t.h.dispose();
  }
});

test('the simulator ignores a gyro scale saved for a real Joy-Con (its own truth is exact)', async () => {
  const store = { 'joyconNinja.imu.v1': JSON.stringify({ gyroScale: 0.5, measuredAt: 'x' }) };
  const h = await makeApp('?input=sim&clock=manual&skipsafety=1&mute=1&simcal=1&simseed=5', { localStorage: { getItem: (k) => store[k] ?? null } });
  try {
    h.until(() => h.c.getUiState().calibrationStep === 4, 16000);
    const cal = h.c.getCalibration();
    assert.notEqual(cal.gyroScaleSource, 'stored');
    assert.ok(Math.abs(cal.gyroScale - 1) < 0.05, `gyro scale ${cal.gyroScale}`);
  } finally {
    h.dispose();
  }
});

test('joycon: after a link loss and recovery Motion re-references (recenter reconnect) before the UI quick re-centre', async () => {
  const t = await bleApp();
  try {
    t.fake.setMotion(POSE_TIP_UP);
    t.h.key('Enter');
    await t.until(() => t.h.c.getUiState().calibrationStep === 2 || t.h.c.getMotionState().calibrationStep === 2, 25000);
    t.fake.setMotion(POSE_FORWARD);
    await t.until(() => t.h.c.getUiState().calibrationStep === 4, 20000);
    const kinds = [];
    t.h.app.motion.on('recenter', (e) => kinds.push(e.kind));
    t.fake.dropLink();
    await t.until(() => t.state() === 'streaming', 30000);
    await t.run(200);
    assert.ok(kinds.includes('reconnect'), `recenter events after the recovery: ${kinds.join(',')}`);
  } finally {
    t.h.dispose();
  }
});

// ---- round 1 findings M5 / F2 / F1: ?filter, ?mask and ?side reach the real connection; F3: the accelerometer sign

const has = (frames, hex) => frames.filter((f) => f === hex).length;
const SET_B7 = '0c91010200040000b7000000';
const SET_37 = '0c9101020004000037000000';
const SET_FF = '0c91010200040000ff000000';

test('joycon: without flags the chooser uses the lenient filter (product id only, the host address is ignored) and the mask 0xB7; a connection with the default leaves nothing in storage', async () => {
  const ls = memoryStore();
  const t = await bleApp({}, undefined, { localStorage: ls });
  try {
    t.h.key('Enter');
    const [req] = t.fake.log.requests;
    assert.equal(req.acceptAllDevices, undefined);
    assert.equal(req.filters.length, 4, 'both sides, company 0x0553 and the alternative 0x057E');
    assert.deepEqual(req.filters.map((f) => f.manufacturerData[0].companyIdentifier), [0x0553, 0x0553, 0x057e, 0x057e]);
    for (const f of req.filters) assert.deepEqual([...f.manufacturerData[0].mask.slice(10)], [0, 0, 0, 0, 0, 0], 'no host address requirement: the advert before SYNC matches too');
    assert.deepEqual(req.optionalServices, [INPUT_CONFIG.service]);
    await t.until(() => t.state() === 'streaming', 15000);
    assert.equal(has(t.fake.commandFrames(), SET_B7), 1);
    assert.equal(t.h.snap().provider.featureMask ?? t.h.c.debug.getProviderStatus().featureMask, 0xb7);
    assert.deepEqual(ls.filterSets, [], 'the default filter needs no record');
    assert.deepEqual(ls.pathSets, [[INPUT_CONFIG.pathStorageKey, JSON.stringify({ v: 1, path: 'chrome' })]], 'the path that reached streaming is remembered for the next visit');
  } finally {
    t.h.dispose();
  }
});

test('joycon: ?filter=strict is still selectable and gives the strict pairing-mode request', async () => {
  const t = await bleApp({}, '?input=joycon&clock=manual&skipsafety=1&mute=1&filter=strict');
  try {
    assert.deepEqual(t.h.app.flags.warnings, []);
    t.h.key('Enter');
    const [req] = t.fake.log.requests;
    assert.equal(req.filters.length, 2, 'both sides, company 0x0553 only');
    assert.deepEqual([...req.filters[0].manufacturerData[0].mask.slice(10)], [255, 255, 255, 255, 255, 255]);
  } finally {
    t.h.dispose();
  }
});

test('joycon: ?filter=lenient&mask=0x37&side=L makes the game use the lenient filter for the Left unit and the expert mask (the game can now use what the diagnostics page proved)', async () => {
  const t = await bleApp({ side: 'L', name: 'Joy-Con 2 (L)' }, '?input=joycon&clock=manual&skipsafety=1&mute=1&filter=lenient&mask=0x37&side=L');
  try {
    assert.deepEqual(t.h.app.flags.warnings, []);
    t.h.key('Enter');
    const [req] = t.fake.log.requests;
    assert.equal(req.filters.length, 2, 'lenient with one side: company 0x0553 and the alternative 0x057E');
    assert.equal(req.filters[0].manufacturerData[0].dataPrefix[5], 0x67, 'the Left product id only');
    assert.deepEqual([...req.filters[0].manufacturerData[0].mask.slice(10)], [0, 0, 0, 0, 0, 0], 'no host address requirement');
    await t.until(() => t.state() === 'streaming', 15000);
    const frames = t.fake.commandFrames();
    assert.equal(has(frames, SET_37), 1, 'SET(0x37) was sent');
    assert.equal(has(frames, SET_B7) + has(frames, SET_FF), 0);
    assert.equal(t.h.c.debug.getProviderStatus().featureMask, 0x37);
  } finally {
    t.h.dispose();
  }
});

test('joycon: ?filter=all opens the chooser with acceptAllDevices, and the option survives a link loss (the automatic reconnect re-uses the mask)', async () => {
  const t = await bleApp({}, '?input=joycon&clock=manual&skipsafety=1&mute=1&filter=all&mask=0xFF');
  try {
    t.h.key('Enter');
    assert.equal(t.fake.log.requests[0].acceptAllDevices, true);
    await t.until(() => t.state() === 'streaming', 15000);
    assert.equal(has(t.fake.commandFrames(), SET_FF), 1);
    t.fake.dropLink();
    await t.until(() => t.state() === 'streaming', 30000);
    assert.equal(t.fake.log.requests.length, 1, 'the reconnect did not open the chooser again');
    assert.equal(has(t.fake.commandFrames(), SET_FF), 2, 'and it used the same mask');
  } finally {
    t.h.dispose();
  }
});

test('the connection flags are ignored by the mouse and the simulator (they only concern the Bluetooth provider)', async () => {
  for (const input of ['mouse', 'sim']) {
    const h = await makeApp(`?input=${input}&clock=manual&skipsafety=1&mute=1&filter=all&mask=0xFF&side=L&seed=1`);
    try {
      h.run(300);
      assert.equal(h.screen(), 'menu', input);
      assert.deepEqual(h.problems().filter((l) => l.level === 'error'), []);
    } finally {
      h.dispose();
    }
  }
});

// ---- hardware finding 2026-09-30: the chooser can list nothing; the connect screen then offers a REAL button for the extended search

const FALLBACK_BUTTON = [1440, 612]; // playfield px of the connect.fallback target
const fallbackTarget = (t) => t.h.app.presentation.ui.getTargets().find((x) => x.id === 'connect.fallback') ?? null;
const cancelledNow = (t) => t.h.c.debug.getProviderStatus().error?.code === 'cancelled';

test('joycon fallback: a chooser that lists nothing ends as cancelled (no failure, no cooldown); the screen offers "Can\'t see it? Extended search" and never retries by itself', async () => {
  const t = await bleApp({ chooser: 'empty-unless-all' });
  try {
    t.h.key('Enter');
    assert.equal(t.fake.log.requests.length, 1);
    assert.equal(t.fake.log.requests[0].filters.length, 4, 'the first attempt is the default (lenient) one');
    await t.until(() => cancelledNow(t), 2000);
    const st = t.h.c.debug.getProviderStatus();
    assert.deepEqual([st.state, st.error.code, st.failures, st.cooldownUntil], ['idle', 'cancelled', 0, null], 'a closed chooser counts no failure and starts no cooldown');
    assert.equal(t.screen(), 'connect');
    assert.equal(t.h.app.presentation.ui.getView().connect.showFallback, true);
    assert.ok(fallbackTarget(t), 'the button is on the screen');
    assert.equal(t.h.app.presentation.ui.getView().connect.hintText, STRINGS['connect.fallback.hint']);
    await t.run(30_000);
    assert.equal(t.fake.log.requests.length, 1, 'no automatic retry: requestDevice needs a click');
    assert.equal(t.fake.log.connectCalls, 0);
    assert.deepEqual(t.h.problems().filter((l) => l.level === 'error'), []);
  } finally {
    t.h.dispose();
  }
});

test('joycon fallback: the button click calls requestDevice SYNCHRONOUSLY with acceptAllDevices and optionalServices, then connects and streams', async () => {
  const ls = memoryStore();
  const t = await bleApp({ chooser: 'empty-unless-all' }, undefined, { localStorage: ls });
  try {
    t.h.key('Enter');
    await t.until(() => cancelledNow(t), 2000);
    t.h.mouse.click(...FALLBACK_BUTTON); // a real pointer event on the canvas
    assert.equal(t.fake.log.requests.length, 2, 'requestDevice ran inside the click handler, before any await');
    assert.deepEqual(t.fake.log.requests[1], { acceptAllDevices: true, optionalServices: [INPUT_CONFIG.service] });
    assert.equal(t.state(), 'requesting');
    assert.equal(fallbackTarget(t), null, 'hidden while the chooser is open');
    await t.until(() => t.state() === 'streaming', 15000);
    assert.equal(t.state(), 'streaming');
    assert.equal(t.h.snap().provider.side, 'R');
    assert.ok(t.fake.onlyCommandWrites());
    assert.equal(has(t.fake.commandFrames(), SET_B7), 1, 'the mask is unaffected by the filter');
    assert.deepEqual(ls.filterSets, [[FILTER_KEY, JSON.stringify({ v: 1, filter: 'all' })]], 'the filter that worked was remembered');
    assert.deepEqual(t.h.problems().filter((l) => l.level === 'error'), []);
  } finally {
    t.h.dispose();
  }
});

test('joycon fallback: the next time the game uses the filter that worked (from localStorage after a reload, from memory without storage)', async () => {
  // a new page load with the remembered record: the very first chooser is the extended one
  const reload = await bleApp({}, undefined, { localStorage: memoryStore({ [FILTER_KEY]: JSON.stringify({ v: 1, filter: 'all' }) }) });
  try {
    reload.h.key('Enter');
    assert.equal(reload.fake.log.requests[0].acceptAllDevices, true, 'remembered "all" is used from the start');
    await reload.until(() => reload.state() === 'streaming', 15000);
    assert.equal(reload.state(), 'streaming');
  } finally {
    reload.h.dispose();
  }
  // no localStorage at all (blocked storage): the same page still remembers in memory
  const blocked = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
  const t = await bleApp({ chooser: 'empty-unless-all' }, undefined, { localStorage: blocked });
  try {
    t.h.key('Enter');
    await t.until(() => cancelledNow(t), 2000);
    t.h.mouse.click(...FALLBACK_BUTTON);
    await t.until(() => t.state() === 'streaming', 15000);
    assert.equal(t.state(), 'streaming');
    t.h.app.getProvider().disconnect();
    await t.run(100);
    t.h.app.presentation.ui.force('connect');
    t.h.key('Enter');
    assert.equal(t.fake.log.requests.length, 3);
    assert.equal(t.fake.log.requests[2].acceptAllDevices, true, 'the page remembered the extended search without any storage');
    assert.deepEqual(t.h.problems().filter((l) => l.level === 'error'), [], 'a blocked storage is never an error');
  } finally {
    t.h.dispose();
  }
});

test('joycon fallback: precedence is the button, then ?filter, then the remembered filter, then the default; junk in storage is ignored', async () => {
  const remembered = memoryStore({ [FILTER_KEY]: JSON.stringify({ v: 1, filter: 'all' }) });
  const flagged = await bleApp({}, '?input=joycon&clock=manual&skipsafety=1&mute=1&filter=strict', { localStorage: remembered });
  try {
    flagged.h.key('Enter');
    assert.equal(flagged.fake.log.requests[0].acceptAllDevices, undefined, '?filter=strict beats the remembered "all"');
    assert.equal(flagged.fake.log.requests[0].filters.length, 2);
  } finally {
    flagged.h.dispose();
  }
  // the extended-search button beats ?filter=strict
  const t = await bleApp({ chooser: 'empty-unless-all' }, '?input=joycon&clock=manual&skipsafety=1&mute=1&filter=strict');
  try {
    t.h.key('Enter');
    await t.until(() => cancelledNow(t), 2000);
    t.h.mouse.click(...FALLBACK_BUTTON);
    assert.equal(t.fake.log.requests[1].acceptAllDevices, true);
  } finally {
    t.h.dispose();
  }
  for (const junk of ['not json', JSON.stringify({ v: 1, filter: 'everything' }), JSON.stringify({ filter: 7 }), 'null', JSON.stringify({})]) {
    const j = await bleApp({}, undefined, { localStorage: memoryStore({ [FILTER_KEY]: junk }) });
    try {
      j.h.key('Enter');
      assert.equal(j.fake.log.requests[0].filters.length, 4, `junk "${junk}" falls back to the lenient default`);
    } finally {
      j.h.dispose();
    }
  }
});

test('joycon fallback: only an attempt that reached streaming is remembered (a failed connect, a wrong device or a refused attempt teach nothing); ?filter=lenient later resets a remembered "all"', async () => {
  const failing = memoryStore();
  const t = await bleApp({ connect: 'fail' }, '?input=joycon&clock=manual&skipsafety=1&mute=1&filter=all', { localStorage: failing });
  try {
    t.h.key('Enter');
    await t.until(() => t.state() === 'error', 20000);
    assert.equal(t.state(), 'error');
    assert.deepEqual(failing.sets, [], 'a failed attempt is not remembered (neither its filter nor its path)');
    // the cooldown refuses the next click without touching the radio or the memory
    t.h.app.presentation.ui.force('connect');
    t.h.key('Enter');
    await t.run(100);
    assert.equal(t.fake.log.requests.length, 1);
    assert.deepEqual(failing.sets, []);
  } finally {
    t.h.dispose();
  }
  const reset = memoryStore({ [FILTER_KEY]: JSON.stringify({ v: 1, filter: 'all' }) });
  const r = await bleApp({}, '?input=joycon&clock=manual&skipsafety=1&mute=1&filter=lenient', { localStorage: reset });
  try {
    r.h.key('Enter');
    assert.equal(r.fake.log.requests[0].filters.length, 4, '?filter=lenient overrides the remembered "all"');
    await r.until(() => r.state() === 'streaming', 15000);
    assert.deepEqual(reset.filterSets, [[FILTER_KEY, JSON.stringify({ v: 1, filter: 'lenient' })]], 'and, having worked, replaces the record');
  } finally {
    r.h.dispose();
  }
});

test('joycon fallback: a link loss and the automatic reconnect never open the chooser again and never change the remembered filter', async () => {
  const ls = memoryStore();
  const t = await bleApp({ chooser: 'empty-unless-all' }, undefined, { localStorage: ls });
  try {
    t.h.key('Enter');
    await t.until(() => cancelledNow(t), 2000);
    t.h.mouse.click(...FALLBACK_BUTTON);
    await t.until(() => t.state() === 'streaming', 15000);
    const records = ls.filterSets.length;
    t.fake.dropLink();
    await t.until(() => t.state() === 'streaming', 30000);
    assert.equal(t.fake.log.requests.length, 2, 'no third chooser');
    assert.equal(ls.filterSets.length, records, 'nothing was written again');
  } finally {
    t.h.dispose();
  }
});

const store = (rec) => ({ localStorage: { getItem: (k) => (k === 'joyconNinja.imu.v1' ? rec : null) } });

test('accelerometer sign: default +1; the value saved by the diagnostics page is used; ?accelsign wins over it; the simulator never uses the saved one', async () => {
  const cases = [
    ['?input=joycon&clock=manual&skipsafety=1&mute=1', null, 1],
    ['?input=joycon&clock=manual&skipsafety=1&mute=1', JSON.stringify({ accelSign: -1, measuredAt: 'x' }), -1],
    ['?input=joycon&clock=manual&skipsafety=1&mute=1', JSON.stringify({ gyroScale: 0.12288, accelSign: 1 }), 1],
    ['?input=joycon&clock=manual&skipsafety=1&mute=1&accelsign=1', JSON.stringify({ accelSign: -1 }), 1],
    ['?input=joycon&clock=manual&skipsafety=1&mute=1&accelsign=-1', null, -1],
    ['?input=joycon&clock=manual&skipsafety=1&mute=1', 'not json', 1],
    ['?input=joycon&clock=manual&skipsafety=1&mute=1', JSON.stringify({ accelSign: 7 }), 1],
    ['?input=sim&clock=manual&skipsafety=1&mute=1', JSON.stringify({ accelSign: -1 }), 1],
    ['?input=sim&clock=manual&skipsafety=1&mute=1&accelsign=-1', null, -1],
  ];
  for (const [search, rec, expected] of cases) {
    const h = await makeApp(search, rec === null ? {} : store(rec));
    try {
      assert.equal(h.c.debug.getMotionDebug().accelSign, expected, `${search} with ${rec}`);
    } finally {
      h.dispose();
    }
  }
});

// ---- round 2 finding M3: the values the diagnostics page saved belong to the Bluetooth provider, not to the simulator chosen later

const savedRecord = (rec) => ({ localStorage: { getItem: (k) => (k === 'joyconNinja.imu.v1' ? JSON.stringify(rec) : null) } });

test('M3: a saved accelSign of -1 does not mirror the simulator picked with the connect screen button (the ?input=sim path was the only one covered)', async () => {
  const h = await makeApp('?clock=manual&skipsafety=1&mute=1&seed=1', savedRecord({ accelSign: -1, measuredAt: 'x' }));
  try {
    h.c.debug.forceScreen('connect');
    assert.equal(h.app.presentation.ui.activate('connect.sim'), true);
    h.run(500);
    assert.equal(h.c.debug.getMotionDebug().accelSign, 1, 'the simulator uses its own sensor convention');
    h.c.sim.setTarget(960, 540, { teleport: true });
    h.run(700);
    for (const [x, y] of [[1400, 540], [1400, 200], [500, 200], [500, 900]]) {
      h.c.sim.setTarget(x, y, { glideMs: 600 });
      h.run(1300);
      const b = h.c.snapshot().aim;
      assert.ok(Math.hypot(b.x - x, b.y - y) < 25, `mouse target ${x},${y} gave cursor ${b.x.toFixed(0)},${b.y.toFixed(0)} (both axes were mirrored before the fix)`);
    }
  } finally {
    h.dispose();
  }
});

test('M3: a saved gyro scale is not used as the "stored" scale of the simulator wizard (?simcal=1 runs the real wizard)', async () => {
  const h = await makeApp('?input=sim&simcal=1&clock=manual&skipsafety=1&mute=1&seed=1&simseed=5', savedRecord({ gyroScale: 0.12288, measuredAt: 'x' }));
  try {
    h.until(() => h.c.getUiState().calibrationStep === 4, 16000);
    const cal = h.c.getCalibration();
    assert.notEqual(cal.gyroScaleSource, 'stored', 'the wizard estimated the simulator scale itself');
    assert.ok(Math.abs(cal.gyroScale - 1) < 0.05, `gyro scale ${cal.gyroScale} (truth 1; the saved value 0.12288 was used before the fix)`);
  } finally {
    h.dispose();
  }
});

test('M3: the saved values follow the ACTIVE provider: applied when the Bluetooth button is used from the connect screen, dropped when the simulator or the mouse is chosen next', async () => {
  const t = await bleApp({}, '?clock=manual&skipsafety=1&mute=1', savedRecord({ accelSign: -1, gyroScale: 0.12288, measuredAt: 'x' }));
  try {
    const dbg = () => t.h.c.debug.getMotionDebug();
    assert.equal(t.screen(), 'connect');
    t.h.key('Enter'); // "Connect Joy-Con" on the connect screen: no ?input flag was given
    await t.until(() => t.state() === 'streaming', 15000);
    assert.equal(dbg().accelSign, -1, 'the Bluetooth provider uses the saved sign');
    assert.equal(dbg().gyroScale, 0.12288, 'and the saved scale (until the wizard estimates one)');
    t.h.c.debug.forceScreen('connect');
    await t.run(600);
    assert.equal(t.h.app.presentation.ui.activate('connect.sim'), true);
    await t.run(300);
    assert.equal(t.h.snap().provider.kind, 'sim');
    assert.equal(dbg().accelSign, 1);
    assert.equal(dbg().gyroScale, 1);
    t.h.c.debug.forceScreen('connect');
    await t.run(600);
    assert.equal(t.h.app.presentation.ui.activate('connect.mouse'), true);
    await t.run(300);
    assert.equal(t.h.snap().provider.kind, 'mouse');
    assert.equal(dbg().accelSign, 1);
    // an explicit ?accelsign still wins for every provider
    const forced = await makeApp('?clock=manual&skipsafety=1&mute=1&accelsign=-1', savedRecord({ accelSign: 1 }));
    try {
      forced.c.debug.forceScreen('connect');
      forced.app.presentation.ui.activate('connect.sim');
      forced.run(300);
      assert.equal(forced.c.debug.getMotionDebug().accelSign, -1);
    } finally {
      forced.dispose();
    }
  } finally {
    t.h.dispose();
  }
});

test('accelerometer sign end to end: a simulated gravity-vector sensor is calibrated right with ?accelsign=-1 and turned round without it (the wizard cannot tell)', async () => {
  const run = async (search) => {
    const h = await makeApp(search);
    try {
      h.until(() => h.c.getUiState().calibrationStep === 4, 20000);
      const cal = h.c.getCalibration();
      assert.ok(cal, `${search}: the wizard finished`);
      return { forward: angleDeg(cal.frame.forward, h.c.sim.getTruth().frame.forward), gyroSign: cal.gyroSign, truthSign: h.c.sim.getTruth().accelSign };
    } finally {
      h.dispose();
    }
  };
  const base = '?input=sim&clock=manual&skipsafety=1&mute=1&simcal=1&simseed=5&simmount=tilted';
  const normal = await run(base);
  const right = await run(`${base}&simaccelsign=-1&accelsign=-1`);
  const wrong = await run(`${base}&simaccelsign=-1`);
  assert.equal(normal.truthSign, 1);
  assert.equal(right.truthSign, -1);
  assert.ok(normal.forward < 3, `normal sensor: forward ${normal.forward.toFixed(1)} deg off`);
  assert.ok(right.forward < 3, `gravity-vector sensor with ?accelsign=-1: forward ${right.forward.toFixed(1)} deg off`);
  assert.ok(wrong.forward > 170, `gravity-vector sensor without it: forward ${wrong.forward.toFixed(1)} deg off (the wizard did not notice)`);
  assert.equal(wrong.gyroSign, normal.gyroSign, 'the gyro sign self-test is blind to it');
});

// ---- round 2 finding R2-01: a resting Joy-Con must never start a round by soft centring + dwell

/**
 * A physically consistent sword for the fake device: it integrates the pitch from the commanded rate and reports the gravity vector
 * for that pitch (the shape of docs/qa/round-2/scripts/t23_consistent.mjs). Sword axis = device z, "up" = device x after the
 * wizard's two poses, so tip-up by `pitch` degrees reads (cos, 0, sin).
 */
function pitchModel(fake) {
  const M = { pitch: 0, rate: 0, pose1: true };
  const period = 1 / 66;
  fake.setMotion(() => {
    if (M.pose1) return { accelRaw: { x: 0, y: 0, z: 4096 }, gyroRaw: { x: 0, y: 0, z: 0 } };
    M.pitch += M.rate * period;
    const r = (M.pitch * Math.PI) / 180;
    return { accelRaw: { x: Math.round(4096 * Math.cos(r)), y: 0, z: Math.round(4096 * Math.sin(r)) }, gyroRaw: { x: 0, y: Math.round(M.rate / 0.06103515625), z: 0 } };
  });
  return M;
}

// ---- round 1 finding M4: the game lets go of the Joy-Con before it opens the diagnostics page

test('joycon: the diagnostics link on the connect screen disconnects the Joy-Con first (one central at a time), then opens the page', async () => {
  const t = await bleApp();
  try {
    const opened = [];
    t.h.win.open = (...args) => opened.push(args);
    t.h.key('Enter');
    await t.until(() => t.state() === 'streaming', 15000);
    t.h.c.debug.forceScreen('connect');
    await t.run(600); // past the 500 ms screen lock
    assert.equal(t.state(), 'streaming');
    const before = t.fake.log.disconnectCalls;
    const link = t.h.target('connect.diagnostics');
    t.h.mouse.click(link.x, link.y); // "Joy-Con diagnostics"
    assert.equal(t.state(), 'idle', 'the game released the controller');
    assert.ok(t.fake.log.disconnectCalls > before, 'the GATT connection was torn down');
    assert.deepEqual(opened, [['diagnostics.html', '_blank', 'noopener']]);
    assert.equal(t.h.c.getUiState().overlay, null, 'a user-driven release is not a link loss: no disconnect overlay');
    // the player can connect again from the same screen
    await t.run(100);
    assert.equal(t.screen(), 'connect');
  } finally {
    t.h.dispose();
  }
});

test('the diagnostics link never fails without a Joy-Con provider (mouse, simulator) or without window.open', async () => {
  const h = await makeApp('?input=mouse&clock=manual&skipsafety=1&mute=1&seed=1');
  try {
    h.c.debug.forceScreen('connect');
    h.run(600);
    h.mouse.click(300, 1030);
    assert.deepEqual(h.problems().filter((l) => l.level === 'error'), []);
  } finally {
    h.dispose();
  }
});
