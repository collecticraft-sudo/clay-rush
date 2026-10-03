// The whole app (real app.js, real UI, real native provider) against the FAKE page side of the native bridge (test-support/bridge/fake-page-bridge.js):
// the probe of /__bridge/status, the progress facts, the remembered path, the cancel, the link loss, ?input=native. No helper, no Bluetooth, no Joy-Con:
// what the bridge would say is scripted (UNVERIFIED-ON-HARDWARE). The real-browser proof with the fake helper process is test/e2e/native.test.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createManualClock } from '../../public/js/shared/clock.js';
import { createFakeTimers } from '../../test-support/input/fake-timers.js';
import { createFakePageBridge, vectorHex } from '../../test-support/bridge/fake-page-bridge.js';
import { buildInputReport } from '../../public/js/input/joycon2-build.js';
import { bytesToHex } from '../../public/js/input/joycon2-parse.js';
import { makeApp } from '../../test-support/app/harness.js';
import { STRINGS } from '../../public/js/ui/strings.en.js';
import { INPUT_CONFIG } from '../../public/js/input/input-config.js';
import { CONNECT as CONNECT_NATIVE } from '../../public/js/ui/layout-data.js';

const PATH_KEY = INPUT_CONFIG.pathStorageKey;
const MAIN = [1440, CONNECT_NATIVE.main.y];
const SECONDARY = [1440, CONNECT_NATIVE.secondaryY];
const CANCEL = [1440, CONNECT_NATIVE.cancel.y];
const REAL_2 = vectorHex('REAL_R_2');
const synth = (us) => bytesToHex(buildInputReport({ counter: us / 1000, imuTimestampUs: us, batteryMv: 3435, temperatureRaw: 5, accelRaw: { x: -600, y: -700, z: 3960 }, gyroRaw: { x: 0, y: 16, z: -12 }, pressed: [] }));

function memoryStore(initial = {}) {
  const map = new Map(Object.entries(initial));
  const sets = [];
  return { map, sets, getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => { sets.push([k, String(v)]); map.set(k, String(v)); } };
}

/** The app on the real clock flag (so that the probe runs) with a manual clock injected, the fake bridge and fake timers. */
async function nativeApp({ bridge = {}, search = '?skipsafety=1&mute=1', localStorage = null, bluetooth = true, noFetch = false } = {}) {
  const clock = createManualClock(1000);
  const timers = createFakeTimers(clock);
  const fake = createFakePageBridge(bridge);
  const env = { clock, timers, ...(noFetch ? {} : { fetch: fake.fetch, EventSource: fake.EventSource }) };
  const h = await makeApp(search, { env, localStorage, bluetooth });
  const t = {
    h, clock, timers, fake,
    async run(ms) {
      for (let el = 0; el < ms; el += 16) {
        await timers.advance(16);
        h.app.step();
      }
    },
    async until(pred, maxMs = 20000) {
      for (let el = 0; el < maxMs && !pred(); el += 48) await t.run(48);
    },
    state: () => h.snap().provider.state,
    view: () => h.app.presentation.ui.getView(),
    model: () => h.app.presentation.ui.getView().connect,
    statusCalls: () => fake.calls.filter((c) => c.method === 'GET' && c.path === '/status').length,
    /** the helper's side of a normal attempt up to the first report */
    attempts: 0,
    async helperUpTo(state, side = 'R') {
      t.attempts += 1; // wait for the POST of THIS attempt (earlier attempts of the same page already posted theirs)
      await timers.advance(1);
      for (let i = 0; i < 200 && fake.posts('/connect').length < t.attempts; i++) await timers.advance(1);
      const script = {
        waiting: () => fake.status('scanning', { message: 'waiting for Bluetooth' }),
        scanning: () => { fake.status('scanning', { message: 'waiting for Bluetooth' }); fake.status('scanning', { message: 'scanning for a Joy-Con 2' }); },
        connecting: () => { script.scanning(); fake.emit({ type: 'advert', side, pid: 8294, rssi: -40, host: '00 00 00 00 00 00', pairing: true }); fake.status('connecting', { side }); },
        streaming: () => { script.connecting(); fake.status('discovering', { side }); fake.status('initialising', { side }); fake.status('streaming', { side }); },
      };
      script[state]();
      await t.run(32);
    },
    async stream() {
      await t.helperUpTo('streaming');
      fake.report(REAL_2, 5000);
      await t.run(64);
      for (let i = 1; i <= 5; i++) {
        fake.report(synth(764777 + i * 15000), 5000 + i * 15);
        await t.run(16);
      }
    },
  };
  await t.run(64); // the probe answers
  return t;
}

test('boot on a server with the bridge: the probe is asked once, the connect screen shows the native layout with the native main button', async () => {
  const t = await nativeApp();
  try {
    assert.equal(t.h.screen(), 'connect');
    assert.equal(t.statusCalls(), 1, 'one GET /__bridge/status at boot');
    assert.deepEqual(t.fake.calls.filter((c) => c.path === '/status').map((c) => c.method), ['GET']);
    assert.deepEqual([t.model().native, t.model().primary, t.model().buttonText, t.model().buttonEnabled], [true, 'native', STRINGS['connect.native.button'], true]);
    assert.equal(t.model().secondary.text, STRINGS['connect.native.secondary']);
    assert.equal(t.h.snap().provider.kind, null, 'nothing is created or connected until the player clicks');
    assert.equal(t.fake.sources.length, 0, 'no event stream before the click');
    assert.deepEqual(t.h.problems(), []);
  } finally {
    t.h.dispose();
  }
});

test('the probe runs again each time the connect screen opens, and never under ?clock=manual, ?input=sim or ?input=mouse', async () => {
  const t = await nativeApp();
  try {
    t.h.app.presentation.ui.force('menu');
    await t.run(48);
    assert.equal(t.statusCalls(), 1);
    t.h.app.presentation.ui.force('connect');
    await t.run(48);
    assert.equal(t.statusCalls(), 2, 'asked again when the screen opened');
  } finally {
    t.h.dispose();
  }
  for (const search of ['?skipsafety=1&mute=1&clock=manual', '?input=sim&skipsafety=1&mute=1', '?input=mouse&skipsafety=1&mute=1']) {
    const x = await nativeApp({ search });
    try {
      assert.equal(x.statusCalls(), 0, search);
      if (search.includes('manual')) assert.equal(x.model().native, false, 'a scripted run keeps the legacy screen');
    } finally {
      x.h.dispose();
    }
  }
});

test('a server without the bridge (404), a network error, a silent server or a browser without EventSource: the legacy layout and no complaint', async () => {
  for (const [name, bridge, extra] of [
    ['404 (an older server)', { statusHttp: 404, status: { ok: false } }, {}],
    ['not available (no compiler)', { status: { available: false, reason: 'no_compiler', built: false, canBuild: false, state: 'idle' } }, {}],
    ['network error', { statusThrows: true }, {}],
    ['no fetch', {}, { noFetch: true }],
  ]) {
    const t = await nativeApp({ bridge, ...extra });
    try {
      assert.equal(t.model().native, false, name);
      assert.equal(t.model().primary, 'bluetooth', name);
      assert.equal(t.model().buttonText, STRINGS['connect.button'], name);
      assert.equal(t.model().buttonEnabled, true, name);
      assert.deepEqual(t.h.problems().filter((l) => l.level === 'error'), [], name);
    } finally {
      t.h.dispose();
    }
  }
  // a server that never answers: the probe gives up after 2.5 s and the legacy screen is live
  const silent = await nativeApp({ bridge: { statusNever: true } });
  try {
    assert.equal(silent.model().native, true, 'still probing: the native layout with a dead main button');
    assert.equal(silent.model().buttonEnabled, false);
    await silent.run(2600);
    assert.equal(silent.model().native, false);
    assert.equal(silent.model().buttonEnabled, true);
  } finally {
    silent.h.dispose();
  }
  const noCompiler = await nativeApp({ bridge: { status: { available: false, reason: 'no_compiler', built: false, canBuild: false, state: 'idle' } } });
  try {
    assert.equal(noCompiler.model().pillText, STRINGS['connect.native.note.noCompiler'], 'the player is told how to get the bridge');
  } finally {
    noCompiler.h.dispose();
  }
});

test('the click on the main button (and Enter) connects through the bridge: no chooser, one POST /connect, the progress texts follow the helper one by one, the countdown starts with the real scan', async () => {
  const t = await nativeApp({ bluetooth: false });
  try {
    t.h.mouse.click(...MAIN);
    assert.equal(t.h.app.getProvider().transport, 'native');
    assert.equal(t.h.snap().provider.kind, 'joycon');
    await t.run(32);
    assert.equal(t.model().mode, 'busy');
    assert.equal(t.model().pillText, STRINGS['connect.native.progress.starting'], 'the stream is open, the bridge starts the helper');
    await t.helperUpTo('waiting');
    assert.equal(t.model().pillText, STRINGS['connect.native.progress.waitingBluetooth']);
    assert.equal(t.model().countdownS, null, 'the wait for Bluetooth is not scan time');
    t.fake.status('scanning', { message: 'scanning for a Joy-Con 2' });
    await t.run(32);
    assert.equal(t.model().pillText, STRINGS['connect.native.progress.scanning']);
    assert.match(t.model().pillText, /Hold SYNC now/);
    assert.equal(t.model().countdownS, 45);
    await t.run(10_000);
    assert.equal(t.model().countdownS, 35, 'a visible countdown');
    t.fake.emit({ type: 'advert', side: 'R', pid: 8294, rssi: -40, host: '00 00 00 00 00 00', pairing: true });
    t.fake.status('connecting', { side: 'R' });
    await t.run(32);
    assert.equal(t.model().pillText, STRINGS['connect.native.progress.connecting']);
    assert.equal(t.model().hintText, STRINGS['connect.native.hint']);
    for (const [state, key] of [['discovering', 'discovering'], ['initialising', 'initialising'], ['streaming', 'waitingData']]) {
      t.fake.status(state, { side: 'R' });
      await t.run(32);
      assert.equal(t.model().pillText, STRINGS[`connect.native.progress.${key}`], state);
    }
    assert.equal(t.fake.posts('/connect').length, 1);
    assert.deepEqual(t.fake.posts('/connect')[0].body, { side: 'any', scanSeconds: 45 });
    assert.equal(t.fake.posts('/connect')[0].headers['X-Joycon-Ninja'], '1');
    assert.deepEqual(t.h.problems().filter((l) => l.level === 'error'), []);
  } finally {
    t.h.dispose();
  }
});

test('Enter is the keyboard way to the native path and a second Enter during the attempt changes nothing', async () => {
  const t = await nativeApp();
  try {
    t.h.key('Enter');
    await t.run(48);
    assert.equal(t.h.app.getProvider().transport, 'native');
    assert.equal(t.fake.posts('/connect').length, 1);
    t.h.key('Enter');
    await t.run(48);
    assert.equal(t.fake.posts('/connect').length, 1, 'still one attempt');
    assert.equal(t.fake.posts('/disconnect').length, 0, 'and it was not cancelled by the second Enter');
  } finally {
    t.h.dispose();
  }
});

test('reaching streaming shows "Connected", moves on to the calibration by itself and remembers the native path in localStorage; the next visit offers it first', async () => {
  const ls = memoryStore();
  const t = await nativeApp({ localStorage: ls });
  try {
    t.h.key('Enter');
    await t.stream();
    assert.equal(t.state(), 'streaming');
    assert.match(t.model().pillText, /^Connected: Joy-Con \(right\)/);
    assert.deepEqual(ls.sets, [[PATH_KEY, JSON.stringify({ v: 1, path: 'native' })]], 'only the path is stored (the chooser filter belongs to Web Bluetooth)');
    await t.until(() => t.h.screen() === 'calibration', 5000);
    assert.equal(t.h.screen(), 'calibration');
  } finally {
    t.h.dispose();
  }
  // a new page load with the record: Chrome was the last path, so Chrome is offered first; with "native" the bridge stays first
  const chrome = await nativeApp({ localStorage: memoryStore({ [PATH_KEY]: JSON.stringify({ v: 1, path: 'chrome' }) }) });
  try {
    assert.deepEqual([chrome.model().primary, chrome.model().buttonText, chrome.model().secondary.path], ['bluetooth', STRINGS['connect.button'], 'native']);
    assert.equal(chrome.model().secondary.text, STRINGS['connect.native.secondaryToNative']);
    chrome.h.key('Enter');
    assert.equal(chrome.h.app.getProvider().transport, undefined, 'Enter starts the path that worked last (Chrome)');
  } finally {
    chrome.h.dispose();
  }
  const junk = await nativeApp({ localStorage: memoryStore({ [PATH_KEY]: '{"v":1,"path":"carrier pigeon"}' }) });
  try {
    assert.equal(junk.model().primary, 'native', 'junk in storage is ignored');
  } finally {
    junk.h.dispose();
  }
  const blocked = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
  const b = await nativeApp({ localStorage: blocked });
  try {
    b.h.key('Enter');
    await b.stream();
    assert.equal(b.state(), 'streaming');
    assert.deepEqual(b.h.problems().filter((l) => l.level === 'error'), [], 'a blocked storage is never an error');
  } finally {
    b.h.dispose();
  }
});

test('only a path that reached streaming is remembered: a failed attempt, a cancelled one and a refusal leave nothing behind', async () => {
  const ls = memoryStore();
  const t = await nativeApp({ localStorage: ls });
  try {
    t.h.key('Enter');
    await t.helperUpTo('scanning');
    t.fake.status('error', { code: 'no_device', message: 'nothing found' });
    await t.run(48);
    assert.equal(t.state(), 'error');
    assert.equal(t.model().pillText, STRINGS['connect.err.native.noDevice']);
    assert.deepEqual(ls.sets, []);
  } finally {
    t.h.dispose();
  }
});

test('"Cancel" (click or Esc) ends the attempt: the provider disconnects, the screen is idle again, no cooldown; Enter during the attempt does nothing', async () => {
  const t = await nativeApp();
  try {
    t.h.key('Enter');
    await t.helperUpTo('scanning');
    assert.ok(t.h.app.presentation.ui.getTargets().some((x) => x.id === 'connect.cancel'));
    t.h.mouse.click(...CANCEL);
    await t.run(48);
    assert.equal(t.fake.posts('/disconnect').length, 1, 'the bridge was told to let go');
    assert.equal(t.state(), 'idle');
    assert.deepEqual([t.model().mode, t.model().buttonEnabled, t.model().cooldownS], ['idle', true, 0]);
    assert.equal(t.h.snap().provider.failures ?? 0, 0);
    // the same with Esc
    t.h.key('Enter');
    await t.helperUpTo('scanning');
    t.h.key('Escape');
    await t.run(48);
    assert.equal(t.fake.posts('/disconnect').length, 2);
    assert.equal(t.state(), 'idle');
    t.h.key('Enter'); // and a new attempt starts at once: a cancel never costs a cooldown
    await t.run(48);
    assert.equal(t.fake.posts('/connect').length, 3);
  } finally {
    t.h.dispose();
  }
});

test('the real errors: each code gets its own text, the failures that involved the controller start the cooldown, the others do not', async () => {
  const cases = [
    ['bluetooth_permission', 'connect.err.native.permission', false],
    ['bluetooth_off', 'connect.err.native.bluetoothOff', false],
    ['no_device', 'connect.err.native.noDevice', false],
    ['connect_failed', 'connect.err.native.connectFailed', true],
    ['gatt_failure', 'connect.err.native.gatt', true],
    ['helper_crashed', 'connect.err.native.crashed', false],
    ['build_failed', 'connect.err.native.buildFailed', false],
  ];
  for (const [code, key, cooldown] of cases) {
    const t = await nativeApp();
    try {
      t.h.key('Enter');
      await t.helperUpTo('scanning');
      t.fake.status('error', { code, message: `fake ${code}` });
      await t.run(48);
      assert.equal(t.model().pillText, STRINGS[key], code);
      assert.equal(t.model().mode, cooldown ? 'cooldown' : 'error', code);
      assert.equal(t.model().buttonEnabled, !cooldown, code);
      if (cooldown) assert.match(t.model().buttonText, /^TRY AGAIN IN \d+ S$/);
    } finally {
      t.h.dispose();
    }
  }
  // the server refuses because the helper is missing: the answer of POST /connect, not a helper status
  const missing = await nativeApp({ bridge: { connectError: { status: 503, body: { ok: false, code: 'build_failed', message: 'clang failed' } } } });
  try {
    missing.h.key('Enter');
    await missing.run(200);
    assert.equal(missing.model().pillText, STRINGS['connect.err.native.buildFailed']);
    assert.equal(missing.model().buttonEnabled, true, 'nothing involved the controller: no cooldown');
  } finally {
    missing.h.dispose();
  }
});

test('a link loss during play: the panel says "hold SYNC, then Reconnect", nothing reconnects by itself; Reconnect starts ONE attempt with progress and the game resumes when it works', async () => {
  const t = await nativeApp();
  try {
    t.h.key('Enter');
    await t.stream();
    t.h.app.presentation.ui.force('playing', { roundMode: 'classic' });
    t.h.c.start('classic', { seed: 3 });
    await t.run(500);
    const connects = t.fake.posts('/connect').length;
    t.fake.status('error', { code: 'lost_signal', message: 'the link dropped' });
    await t.run(100);
    assert.equal(t.state(), 'lost');
    assert.equal(t.h.snap().overlay, 'disconnected');
    const disc = t.view().disc;
    assert.deepEqual([disc.native, disc.phase], [true, 'failed']);
    assert.equal(disc.text, STRINGS['disc.native.text']);
    await t.run(15_000);
    assert.equal(t.fake.posts('/connect').length, connects, 'no silent retry in 15 s');
    assert.equal(t.view().disc.retryEnabled, true);
    t.h.app.presentation.ui.activate('disc.retry');
    await t.helperUpTo('scanning');
    assert.equal(t.fake.posts('/connect').length, connects + 1);
    assert.equal(t.view().disc.phase, 'reconnecting');
    assert.equal(t.view().disc.progressText, STRINGS['connect.native.progress.scanning']);
    t.fake.emit({ type: 'advert', side: 'R', pid: 8294, rssi: -40, host: '00 00 00 00 00 00', pairing: true });
    t.fake.status('connecting', { side: 'R' });
    t.fake.status('discovering', { side: 'R' });
    t.fake.status('initialising', { side: 'R' });
    t.fake.status('streaming', { side: 'R' });
    t.fake.report(REAL_2, 9000);
    await t.run(64);
    for (let i = 1; i <= 5; i++) {
      t.fake.report(synth(764777 + i * 15000), 9000 + i * 15);
      await t.run(16);
    }
    assert.equal(t.state(), 'streaming');
    assert.deepEqual(t.h.problems().filter((l) => l.level === 'error'), []);
  } finally {
    t.h.dispose();
  }
});

test('?input=native creates the native provider at boot without connecting (like ?input=joycon); ?input=joycon with the bridge available keeps Chrome as the main path', async () => {
  const n = await nativeApp({ search: '?input=native&skipsafety=1&mute=1' });
  try {
    assert.equal(n.h.screen(), 'connect');
    assert.equal(n.h.app.getProvider().transport, 'native');
    assert.equal(n.fake.posts('/connect').length, 0, 'created, not connected');
    assert.equal(n.fake.sources.length, 0);
    assert.equal(n.model().primary, 'native');
  } finally {
    n.h.dispose();
  }
  const j = await nativeApp({ search: '?input=joycon&skipsafety=1&mute=1' });
  try {
    assert.deepEqual([j.model().native, j.model().primary, j.model().secondary.path], [true, 'bluetooth', 'native'], '?input=joycon asks for the Chrome path and gets it first, the bridge is one click away');
    assert.equal(j.h.app.getProvider().transport, undefined);
  } finally {
    j.h.dispose();
  }
});

test('the diagnostics link disconnects the native provider too (one central at a time), and leaving the page tells the bridge to let go', async () => {
  const t = await nativeApp();
  const opened = [];
  t.h.win.open = (...args) => opened.push(args);
  try {
    t.h.key('Enter');
    await t.stream();
    t.h.app.presentation.ui.force('connect');
    await t.run(48);
    const before = t.fake.posts('/disconnect').length;
    const link = t.h.target('connect.diagnostics');
    t.h.mouse.click(link.x, link.y); // "Joy-Con diagnostics"
    await t.run(48);
    assert.equal(opened.length, 1);
    assert.equal(t.state(), 'idle');
    assert.equal(t.fake.posts('/disconnect').length, before + 1, 'the bridge was told to disconnect before the page opened');
  } finally {
    t.h.dispose();
  }
});

test('switching between the two Joy-Con paths: each keeps its own provider (and cooldown) for the page lifetime; the remembered chooser filter is written only by Web Bluetooth', async () => {
  const t = await nativeApp();
  try {
    t.h.key('Enter');
    await t.helperUpTo('scanning');
    t.fake.status('error', { code: 'connect_failed', message: 'no' });
    await t.run(48);
    const native = t.h.app.getProvider();
    assert.equal(native.status.failures, 1);
    t.h.app.presentation.ui.force('connect');
    await t.run(48);
    // the other path is locked with the native one while the native cooldown runs (the controller's own cooldown is the same)
    assert.equal(t.h.app.presentation.ui.getTargets().find((x) => x.id === 'connect.secondary').enabled, false);
    await t.run(10_500);
    assert.equal(t.h.app.presentation.ui.getTargets().find((x) => x.id === 'connect.secondary').enabled, true);
    t.h.mouse.click(...SECONDARY);
    assert.equal(t.h.app.getProvider().transport, undefined, 'the second path is Web Bluetooth');
    assert.notEqual(t.h.app.getProvider(), native);
  } finally {
    t.h.dispose();
  }
});
