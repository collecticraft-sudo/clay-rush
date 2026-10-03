// Entry point, interface and configuration tests of the input module (docs/architecture.md 2.5, 5.2, 5.11; native bridge: docs/native-bridge.md).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as input from '../../public/js/input/index.js';
import { createInputProvider, createKeyboardActions, INPUT_CONFIG } from '../../public/js/input/index.js';
import { createManualClock } from '../../public/js/shared/clock.js';
import { assertValid } from '../../public/js/shared/validate.js';
import { setup } from '../../test-support/input/ble-harness.js';
import { FakeTarget, pointerEvent } from '../../test-support/input/fake-dom.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const INPUT_DIR = join(ROOT, 'public', 'js', 'input');

test('index.js exports exactly the names of architecture 2.5', () => {
  assert.deepEqual(Object.keys(input).sort(), ['BUTTON_TABLE', 'INPUT_CONFIG', 'SIM_MOUNTS', 'buildInputReport', 'createInputProvider', 'createKeyboardActions', 'createNativeProvider', 'parseInputReport']);
});

test('the native bridge is a provider kind: createInputProvider("native") and the exported createNativeProvider make the same kind of provider', () => {
  const clock = createManualClock(0);
  const a = createInputProvider('native', { clock });
  const b = input.createNativeProvider({ clock });
  for (const p of [a, b]) {
    assert.equal(p.kind, 'joycon', 'the status says joycon: it is the same controller behind another transport');
    assert.equal(p.transport, 'native');
    for (const m of ['connect', 'reconnect', 'disconnect', 'getActionLabels', 'on', 'off', 'dispose', 'vibrate', 'setKeepAlive', 'getBridgeInfo', 'getDiagnostics']) assert.equal(typeof p[m], 'function', m);
    p.dispose();
  }
  assert.equal(createInputProvider('joycon', { clock, bluetooth: null }).transport, undefined, 'Web Bluetooth has no transport field: only the native provider sets one');
});

test('the old reserved name "bridge" is not special any more: it is an unknown kind (a TypeError like any other); unknown kinds and a missing clock are programming errors', () => {
  const clock = createManualClock(0);
  assert.throws(() => createInputProvider('bridge', { clock }), (e) => e instanceof TypeError && /unknown provider kind "bridge" \(expected joycon, native, sim or mouse\)/.test(e.message));
  assert.throws(() => createInputProvider('bridge'), TypeError);
  assert.throws(() => createInputProvider('native'), TypeError, 'a clock is required for native too');
  assert.throws(() => createInputProvider('gamepad', { clock }), TypeError);
  assert.throws(() => createInputProvider('sim'), TypeError);
  assert.throws(() => createInputProvider('sim', {}), TypeError);
  assert.throws(() => createInputProvider('mouse', { clock: {} }), TypeError);
});

test('capabilities per kind are the table of architecture 5.2', () => {
  const clock = createManualClock(0);
  const expected = {
    joycon: { imu: true, aim: false, buttons: true, needsUserGesture: true, needsCalibration: true, hasBattery: true, canVibrate: true },
    sim: { imu: true, aim: false, buttons: false, needsUserGesture: false, needsCalibration: false, hasBattery: false, canVibrate: false },
    mouse: { imu: false, aim: true, buttons: false, needsUserGesture: false, needsCalibration: false, hasBattery: false, canVibrate: false },
    native: { imu: true, aim: false, buttons: true, needsUserGesture: false, needsCalibration: true, hasBattery: true, canVibrate: true },
  };
  for (const kind of ['joycon', 'native', 'sim', 'mouse']) {
    const p = createInputProvider(kind, { clock, bluetooth: null, target: new FakeTarget() });
    assert.deepEqual(p.capabilities, expected[kind], kind);
    assert.equal(p.kind, kind === 'native' ? 'joycon' : kind);
    assert.ok(Object.isFrozen(p.capabilities));
    p.dispose();
  }
});

test('all four providers implement the same InputProvider interface', async () => {
  const clock = createManualClock(0);
  for (const kind of ['joycon', 'native', 'sim', 'mouse']) {
    const p = createInputProvider(kind, { clock, bluetooth: null, target: new FakeTarget() });
    for (const m of ['connect', 'reconnect', 'disconnect', 'getActionLabels', 'setTriggerButton', 'on', 'off', 'dispose']) assert.equal(typeof p[m], 'function', `${kind}.${m}`);
    assertValid('InputStatus', p.status);
    assert.deepEqual(Object.keys(p.getActionLabels()).sort(), ['back', 'confirm', 'fire', 'pause', 'recenter']);
    const seen = [];
    const off = p.on('status', (s) => seen.push(s));
    assert.equal(typeof off, 'function', 'on() returns an unsubscribe function');
    const handler = () => {};
    p.on('sample', handler);
    p.off('sample', handler);
    const promise = p.connect();
    assert.ok(promise instanceof Promise, `${kind}.connect() returns a promise`);
    await promise.catch((e) => assert.ok(e.code && e.info, 'rejections carry .code and .info'));
    await p.disconnect();
    off();
    p.dispose();
  }
  const sim = createInputProvider('sim', { clock });
  assert.equal(typeof sim.tick, 'function');
  assert.ok(sim.nominalCalibration);
  assert.equal(createInputProvider('joycon', { clock, bluetooth: null }).tick, undefined);
  assert.equal(createInputProvider('mouse', { clock }).tick, undefined);
  assert.equal(typeof createInputProvider('joycon', { clock, bluetooth: null }).vibrate, 'function');
  assert.equal(createInputProvider('sim', { clock }).vibrate, undefined);
});

test('provider events and status objects are plain JSON-serialisable data', async () => {
  const t = setup();
  await t.connected();
  t.fake.setButtons(['ZR']);
  await t.advance(500);
  for (const list of [t.rec.status, t.rec.samples, t.rec.actions, t.rec.buttons, t.rec.errors, t.rec.logs]) for (const item of list) JSON.stringify(item);
  for (const p of t.rec.packets) JSON.stringify({ ...p, bytes: Array.from(p.bytes) });
  t.dispose();
});

test('all four providers and the keyboard survive dispose() and later calls without throwing', async () => {
  const clock = createManualClock(0);
  const target = new FakeTarget();
  for (const kind of ['sim', 'mouse', 'joycon', 'native']) {
    const p = createInputProvider(kind, { clock, target, bluetooth: null });
    await p.connect().catch(() => {});
    p.dispose();
    p.dispose();
    await p.disconnect();
    target.dispatchEvent(pointerEvent('pointermove'));
  }
  const kb = createKeyboardActions({ clock, target: new EventTarget() });
  kb.dispose();
  kb.dispose();
});

test('INPUT_CONFIG is deep-frozen data with the values of architecture 5.6 and the design connect block', () => {
  const frozen = (o) => Object.isFrozen(o) && Object.values(o).every((v) => v === null || typeof v !== 'object' || frozen(v));
  assert.ok(frozen(INPUT_CONFIG), 'deep frozen');
  const c = INPUT_CONFIG;
  assert.equal(c.service, 'ab7de9be-89fe-49ad-828f-118f09df7fd0');
  assert.equal(c.characteristics.input, 'ab7de9be-89fe-49ad-828f-118f09df7fd2');
  assert.equal(c.characteristics.command, '649d4ac9-8eb7-4e6c-af44-1ea54fe5f005');
  assert.equal(c.characteristics.response, 'c765a961-d9d8-4d36-a20a-5315b111836a');
  assert.equal(c.characteristics.vibrationLeft, '289326cb-a471-485d-a8f4-240c14f18241');
  assert.equal(c.characteristics.vibrationRight, 'fa19b0fb-cd1f-46a7-84a1-bbb09e00c149');
  assert.ok(c.forbiddenCharacteristics.includes('4147423d-fdae-4df7-a4f7-d23e5df59f8d'));
  assert.ok(c.forbiddenCharacteristics.includes('ab7de9be-89fe-49ad-828f-118f09df7fdf'));
  for (const uuid of Object.values(c.characteristics)) assert.ok(!c.forbiddenCharacteristics.includes(uuid));
  assert.deepEqual([c.featureMask, c.fallbackMask], [0xb7, 0xff], 'F1: 0xB7 is the default, 0xFF only the last resort');
  assert.deepEqual([c.connectTimeoutMs, c.discoveryTimeoutMs, c.settleMs, c.initSpacingMs, c.keepAliveMs], [15000, 15000, 300, 500, 1000]);
  assert.deepEqual(c.watchdogMs, [2000, 4500, 9000]);
  assert.deepEqual([c.lostAfterMs, c.autoReconnectAttempts, c.autoReconnectDelayS], [2500, 1, 2]);
  assert.deepEqual([c.cooldownS, c.longCooldownS, c.longCooldownAfterFailures], [10, 180, 3]);
  assert.deepEqual([c.hapticMinIntervalMs, c.batteryLowMv, c.batteryCriticalMv], [100, 3550, 3300]);
  assert.deepEqual([c.companyId, c.altCompanyId, c.pid.L, c.pid.R], [0x0553, 0x057e, 0x2067, 0x2066]);
  assert.deepEqual(c.connect, { cooldownS: 10, autoReconnectAttempts: 1, autoReconnectDelayS: 2, lowBatteryPct: 15 });
  assert.equal(c.sim.hz, 66, 'A-12: the simulator defaults to 66 Hz');
  assert.equal(c.sim.pxPerDeg, 27.4, 'A-22');
  assert.ok(c.sim.followTauMs <= 6, 'the follower time constant is at most 6 ms');
  assert.equal(c.sim.leverM, 0.45);
  assert.equal(c.diagnostics.storageKey, 'joyconNinja.imu.v1');
  assert.throws(() => {
    'use strict';
    INPUT_CONFIG.cooldownS = 1;
  }, TypeError);
});

test('the input files follow the module rules: relative imports with .js, only shared/ and input/, no Math.random, no external URLs, no wall clock', () => {
  const files = readdirSync(INPUT_DIR).filter((f) => f.endsWith('.js'));
  assert.ok(files.length >= 18);
  const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
  for (const f of files) {
    const code = strip(readFileSync(join(INPUT_DIR, f), 'utf8'));
    for (const m of code.matchAll(/(?:import|export)[^'"\n]*from\s+['"]([^'"]+)['"]/g)) {
      assert.ok(m[1].startsWith('./') || m[1].startsWith('../shared/'), `${f}: import "${m[1]}" is outside input/ and shared/`);
      assert.ok(m[1].endsWith('.js'), `${f}: import "${m[1]}" needs an explicit .js`);
    }
    assert.ok(!/Math\.random/.test(code), `${f}: Math.random is not allowed (the simulator is seeded)`);
    assert.ok(!/Date\.now|performance\.now/.test(code), `${f}: time comes from the injected Clock`);
    assert.ok(!/https?:\/\//.test(code), `${f}: no external URLs`);
    assert.ok(!/(?<![\d.])(1300|1190)(?![\d.])/.test(code), `${f}: gravity and spawn line live in game/config.js only`);
  }
  assert.ok(files.includes('native-provider.js') && files.includes('native-link.js'), 'the native bridge provider and its transport are part of the input module');
  assert.ok(!files.includes('bridge.js'), 'the old placeholder name is not used');
});

test('every module of input/ imports in Node with no browser globals at all (rule 6)', () => {
  const list = readdirSync(INPUT_DIR).filter((f) => f.endsWith('.js')).map((f) => join(INPUT_DIR, f));
  const script = `
    delete globalThis.navigator;
    for (const name of ['window', 'document', 'localStorage', 'AudioContext', 'requestAnimationFrame']) if (name in globalThis) throw new Error(name + ' unexpectedly exists');
    const files = ${JSON.stringify(list)};
    for (const f of files) await import(f);
    console.log('imported ' + files.length);
  `;
  const res = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /imported \d+/);
});
