// Screen wake lock (round 1 finding M2): the module against a fake Navigator, and the whole app asking for it at the right
// moments. Chrome's real behaviour and the Mac's idle timings are UNVERIFIED-ON-HARDWARE; these tests prove the wiring only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createWakeLock } from '../../public/js/wake-lock.js';
import { FakeDocument } from '../../test-support/input/fake-dom.js';
import { createManualClock } from '../../public/js/shared/clock.js';
import { createFakeTimers } from '../../test-support/input/fake-timers.js';
import { createFakeBluetooth } from '../../test-support/input/fake-bluetooth.js';
import { makeApp } from '../../test-support/app/harness.js';

/** A Navigator.wakeLock that hands out sentinels; `refuse` makes request() reject, `hold` keeps it pending. */
function fakeWakeLock({ refuse = null } = {}) {
  const wl = { requests: [], sentinels: [], refuse, pendingResolvers: [], hold: false };
  wl.request = (type) => {
    wl.requests.push(type);
    if (wl.refuse) return Promise.reject(Object.assign(new Error(wl.refuse), { name: 'NotAllowedError' }));
    const make = () => {
      const s = new EventTarget();
      s.released = false;
      s.release = () => {
        s.released = true;
        s.dispatchEvent(new Event('release'));
        return Promise.resolve();
      };
      wl.sentinels.push(s);
      return s;
    };
    if (wl.hold) return new Promise((resolve) => wl.pendingResolvers.push(() => resolve(make())));
    return Promise.resolve(make());
  };
  return wl;
}
const tick = () => new Promise((r) => setImmediate(r));

test('wake lock: asks for a screen lock when wanted, releases it when not, and is idempotent', async () => {
  const wl = fakeWakeLock();
  const w = createWakeLock({ navigator: { wakeLock: wl }, document: new FakeDocument() });
  assert.equal(w.supported, true);
  w.setWanted(false, 0);
  assert.equal(wl.requests.length, 0, 'nothing is requested while not wanted');
  w.setWanted(true, 10);
  w.setWanted(true, 20);
  w.setWanted(true, 30);
  await tick();
  assert.deepEqual(wl.requests, ['screen'], 'one request however often it is asked');
  assert.equal(w.getState().held, true);
  w.setWanted(true, 40);
  await tick();
  assert.equal(wl.requests.length, 1, 'no second request while it is held');
  w.setWanted(false, 50);
  assert.equal(wl.sentinels[0].released, true);
  assert.equal(w.getState().held, false);
  w.setWanted(true, 60);
  await tick();
  assert.equal(wl.requests.length, 2, 'wanted again -> a new lock');
});

test('wake lock: the browser drops the lock when the tab is hidden; it is asked for again when the tab is visible', async () => {
  const wl = fakeWakeLock();
  const doc = new FakeDocument();
  const w = createWakeLock({ navigator: { wakeLock: wl }, document: doc });
  w.setWanted(true, 0);
  await tick();
  assert.equal(w.getState().held, true);
  doc.hidden = true;
  wl.sentinels[0].release(); // what Chrome does on a hidden tab
  assert.equal(w.getState().held, false);
  w.setWanted(true, 100); // a hidden page never asks
  await tick();
  assert.equal(wl.requests.length, 1);
  doc.setHidden(false); // visibilitychange
  await tick();
  assert.equal(wl.requests.length, 2, 're-requested on visibilitychange');
  assert.equal(w.getState().held, true);
  assert.equal(w.getState().releases, 1);
});

test('wake lock: a refusal never throws, is reported once per retry window and retried later; no support is a quiet no-op', async () => {
  const wl = fakeWakeLock({ refuse: 'battery saver' });
  const logs = [];
  const w = createWakeLock({ navigator: { wakeLock: wl }, document: new FakeDocument(), log: (l, m) => logs.push([l, m]), retryMs: 5000 });
  w.setWanted(true, 1000);
  await tick();
  assert.equal(wl.requests.length, 1);
  assert.match(w.getState().lastError, /NotAllowedError: battery saver/);
  assert.equal(logs.length, 1);
  assert.equal(logs[0][0], 'warn');
  for (let t = 1016; t < 5000; t += 16) w.setWanted(true, t); // every frame
  await tick();
  assert.equal(wl.requests.length, 1, 'no retry inside the window (no request storm)');
  wl.refuse = null;
  w.setWanted(true, 6100);
  await tick();
  assert.equal(wl.requests.length, 2);
  assert.equal(w.getState().held, true);
  assert.equal(w.getState().lastError, null);

  const none = createWakeLock({ navigator: {}, document: new FakeDocument() });
  assert.equal(none.supported, false);
  none.setWanted(true, 0);
  none.setWanted(false, 1);
  assert.equal(none.getState().requests, 0);
  const missing = createWakeLock({});
  missing.setWanted(true, 0);
  missing.dispose();
});

test('wake lock: not wanted any more while the browser is still deciding -> the late lock is released at once; dispose releases', async () => {
  const wl = fakeWakeLock();
  wl.hold = true;
  const w = createWakeLock({ navigator: { wakeLock: wl }, document: new FakeDocument() });
  w.setWanted(true, 0);
  assert.equal(w.getState().pending, true);
  w.setWanted(false, 10);
  wl.pendingResolvers.shift()();
  await tick();
  assert.equal(wl.sentinels[0].released, true, 'the late grant was handed back');
  assert.equal(w.getState().held, false);
  wl.hold = false;
  w.setWanted(true, 20);
  await tick();
  assert.equal(w.getState().held, true);
  w.dispose();
  assert.equal(wl.sentinels[1].released, true);
  w.setWanted(true, 30);
  await tick();
  assert.equal(wl.requests.length, 2, 'a disposed wake lock never asks again');
});

// ------------------------------------------------------------------------------------------------------------------ the app

test('app: the wake lock is held during a round and the calibration and released in the menu with a mouse; never asked for without support', async () => {
  const wl = fakeWakeLock();
  const h = await makeApp('?input=mouse&clock=manual&skipsafety=1&mute=1&seed=1', { env: { navigator: { wakeLock: wl } } });
  try {
    h.run(200);
    await tick();
    assert.equal(h.screen(), 'menu');
    assert.equal(h.c.debug.getWakeLock().held, false, 'menu with a mouse: no lock');
    h.c.start('classic', { seed: 1 });
    h.run(100);
    await tick();
    assert.equal(h.c.debug.getWakeLock().held, true, 'playing: locked');
    h.c.pause();
    h.run(100);
    await tick();
    assert.equal(h.screen(), 'paused');
    assert.equal(h.c.debug.getWakeLock().held, true, 'paused: still locked');
    h.c.debug.forceScreen('menu');
    h.run(100);
    await tick();
    assert.equal(h.c.debug.getWakeLock().held, false, 'back in the menu: released');
    assert.equal(h.c.debug.getWakeLock().grants, 1);
  } finally {
    h.dispose();
  }
  const bare = await makeApp('?input=mouse&clock=manual&skipsafety=1&mute=1&seed=1');
  try {
    bare.c.start('classic', { seed: 1 });
    bare.run(200);
    assert.deepEqual(bare.c.debug.getWakeLock(), { supported: false, wanted: true, held: false, pending: false, requests: 0, grants: 0, releases: 0, lastError: null });
  } finally {
    bare.dispose();
  }
});

test('app: with a Joy-Con the lock is held from the moment the chooser opens until the player disconnects', async () => {
  const wl = fakeWakeLock();
  const clock = createManualClock(1000);
  const timers = createFakeTimers(clock);
  const fake = createFakeBluetooth({ clock, timers, behaviour: {} });
  const h = await makeApp('?input=joycon&clock=manual&skipsafety=1&mute=1', { env: { clock, timers, bluetooth: fake.bluetooth, navigator: { bluetooth: fake.bluetooth, wakeLock: wl } } });
  const run = async (ms) => {
    for (let el = 0; el < ms; el += 16) {
      await timers.advance(16);
      h.app.step();
    }
    await tick();
  };
  try {
    await run(200);
    assert.equal(h.snap().provider.state, 'idle');
    assert.equal(h.c.debug.getWakeLock().held, false, 'nothing to keep awake before the player connects');
    h.key('Enter');
    await run(100);
    assert.equal(h.c.debug.getWakeLock().held, true, 'requesting / connecting');
    await run(9000);
    assert.equal(h.snap().provider.state, 'streaming');
    assert.equal(h.c.debug.getWakeLock().held, true, 'streaming (the calibration screen follows the connection)');
    h.c.debug.forceScreen('menu');
    await run(100);
    assert.equal(h.c.debug.getWakeLock().held, true, 'streaming in the menu: still held, the link is what needs the display awake');
    h.app.getProvider().disconnect();
    await run(100);
    assert.equal(h.c.debug.getWakeLock().held, false, 'released once the link is gone');
  } finally {
    h.dispose();
  }
});
