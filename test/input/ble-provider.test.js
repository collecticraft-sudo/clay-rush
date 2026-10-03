// BLE provider state machine tests (docs/architecture.md 5.3 to 5.6) against the FAKE Web Bluetooth stack.
// Every test name says "fake device": a green test proves conformance to docs/joycon2-protocol.md, never to the physical
// Joy-Con 2 (UNVERIFIED-ON-HARDWARE: UOH-1 to UOH-5, UOH-11, UOH-14, UOH-15). Timers and clock are virtual: nothing sleeps.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, CH, FRAME } from '../../test-support/input/ble-harness.js';
import { assertValid } from '../../public/js/shared/validate.js';
import { createInputProvider } from '../../public/js/input/index.js';
import { createManualClock } from '../../public/js/shared/clock.js';
import { INPUT_CONFIG } from '../../public/js/input/input-config.js';

const T = { timeout: 30000 };
const count = (frames, hex) => frames.filter((f) => f === hex).length;

// ------------------------------------------------------------------------------------------------ happy path

test('fake device: happy path reaches streaming through the documented states, the chooser opens synchronously', T, async () => {
  const t = setup({ side: 'L', name: 'Joy-Con 2 (L)' });
  const p = t.connect({ side: 'any' });
  assert.equal(t.fake.log.requests.length, 1, 'requestDevice must run inside the user gesture, before any await');
  assert.equal(t.provider.status.state, 'requesting');
  await t.until(() => t.provider.status.state === 'streaming');
  await p;
  assert.deepEqual(t.states(), ['requesting', 'connecting', 'initializing', 'streaming']);
  const st = t.provider.status;
  assert.equal(st.side, 'L');
  assert.equal(st.featureMask, 0xb7, 'the default feature mask is 0xB7 (round 1 finding F1)');
  assert.equal(st.deviceName, 'Joy-Con 2 (L)');
  assert.equal(st.trackingOk, true);
  assert.equal(st.error, null);
  assert.equal(st.failures, 0);
  assert.equal(st.cooldownUntil, null);
  assert.equal(st.battery.level, 'ok');
  assert.equal(st.battery.pct, null);
  for (const s of t.rec.status) assertValid('InputStatus', s);
  for (const s of t.rec.samples) assertValid('ImuSample', s);
  assert.ok(t.rec.samples.length > 0);
  assert.equal(t.rec.samples[0].side, 'L');
  assert.equal(t.rec.samples[0].dtMs, null);
  assert.equal(t.provider.kind, 'joycon');
  assert.deepEqual(t.provider.capabilities, { imu: true, aim: false, buttons: true, needsUserGesture: true, needsCalibration: true, hasBattery: true, canVibrate: true });
  assert.ok(t.fake.onlyCommandWrites());
  t.dispose();
});

test('fake device: the state is streaming BEFORE the first sample is delivered', T, async () => {
  const t = setup();
  const order = [];
  t.provider.on('status', (s) => s.state === 'streaming' && order.push('status:streaming'));
  t.provider.on('sample', () => order.push('sample'));
  await t.connected();
  assert.equal(order[0], 'status:streaming');
  assert.equal(order[1], 'sample');
  t.dispose();
});

test('fake device: chooser options follow the ConnectOptions (side, filter)', T, async () => {
  const t = setup({ chooser: 'cancel' });
  await assert.rejects(t.connect({ side: 'L', filter: 'strict' }));
  await assert.rejects(t.connect({ side: 'R', filter: 'lenient' }));
  await assert.rejects(t.connect({ filter: 'all' }));
  const [a, b, c] = t.fake.log.requests;
  assert.equal(a.filters.length, 1);
  assert.equal(b.filters.length, 2, 'lenient with one side: company 0x0553 and 0x057E');
  assert.equal(c.acceptAllDevices, true);
  for (const r of [a, b, c]) assert.deepEqual(r.optionalServices, [INPUT_CONFIG.service]);
  t.dispose();
});

test('fake device: side comes from the characteristics (L, R) and falls back to the chooser hint and to unknown', T, async () => {
  for (const [side, expected] of [['L', 'L'], ['R', 'R']]) {
    const t = setup({ side });
    await t.connected();
    assert.equal(t.provider.status.side, expected);
    assert.deepEqual(t.provider.getActionLabels(), side === 'L' ? { confirm: 'Down', back: 'Left', pause: '-', recenter: 'L', fire: 'ZL' } : { confirm: 'A', back: 'B', pause: '+', recenter: 'R', fire: 'ZR' });
    t.dispose();
  }
  const hinted = setup({ side: 'none', name: 'DeviceName' });
  await hinted.connected({ side: 'L' });
  assert.equal(hinted.provider.status.side, 'L');
  hinted.dispose();
  const unknown = setup({ side: 'none', name: 'DeviceName' });
  await unknown.connected();
  assert.equal(unknown.provider.status.side, '?');
  assert.equal(unknown.rec.samples[0].side, '?');
  unknown.dispose();
});

test('fake device: connect() is idempotent (same promise in flight, immediate resolve when streaming)', T, async () => {
  const t = setup();
  const p1 = t.provider.connect();
  const p2 = t.provider.connect();
  assert.equal(p1, p2);
  assert.equal(t.fake.log.requests.length, 1);
  await t.until(() => t.provider.status.state === 'streaming');
  await p1;
  await t.provider.connect();
  assert.equal(t.fake.log.requests.length, 1, 'no second chooser while streaming');
  await t.provider.reconnect();
  assert.equal(t.fake.log.connectCalls, 1);
  t.dispose();
});

test('fake device: expert options: feature mask override and keep-alive off', T, async () => {
  const t = setup();
  await t.connected({ mask: 0xff, keepAlive: false });
  assert.deepEqual(t.frames().slice(0, 3), [FRAME.led, FRAME.setFF, FRAME.enableFF]);
  assert.equal(t.provider.status.featureMask, 0xff);
  const n = t.frames().length;
  await t.advance(10_000);
  assert.equal(t.frames().length, n, 'no keep-alive frames with keepAlive:false');
  assert.equal(t.provider.getDiagnostics().keepAlive, false);
  t.provider.setKeepAlive(true);
  await t.advance(3000);
  assert.ok(t.frames().length > n, 'the runtime toggle resumes the keep-alive');
  t.dispose();
});

// ------------------------------------------------------------------------------------------------ errors before the link exists

test('fake device: chooser closed without a choice is `cancelled`: idle, no failure, NO cooldown, immediate retry allowed', T, async () => {
  const t = setup({ chooser: 'cancel' });
  await assert.rejects(t.connect(), (e) => e.code === 'cancelled' && e.info.code === 'cancelled' && e.info.retryable === true);
  const st = t.provider.status;
  assert.equal(st.state, 'idle');
  assert.equal(st.error.code, 'cancelled');
  assert.equal(st.failures, 0);
  assert.equal(st.cooldownUntil, null);
  assert.equal(t.rec.errors.at(-1).code, 'cancelled');
  t.fake.behaviour.chooser = 'select';
  await t.connected();
  assert.equal(t.fake.log.requests.length, 2, 'a second chooser opened at once');
  assert.equal(t.provider.status.error, null, 'the error is cleared by the next streaming');
  t.dispose();
});

test('fake device: connect() without a filter opens the lenient chooser (the default); a cancelled chooser then allows an immediate extended search with acceptAllDevices', T, async () => {
  const t = setup({ chooser: 'empty-unless-all' });
  await assert.rejects(t.connect(), (e) => e.code === 'cancelled');
  const [first] = t.fake.log.requests;
  assert.equal(first.acceptAllDevices, undefined);
  assert.equal(first.filters.length, 4, 'both sides x company 0x0553 and 0x057E: the lenient filter');
  for (const f of first.filters) assert.deepEqual([...f.manufacturerData[0].mask.slice(10)], [0, 0, 0, 0, 0, 0], 'no host address requirement');
  assert.equal(t.provider.status.failures, 0, 'a closed chooser is not a failure');
  assert.equal(t.provider.status.cooldownUntil, null, 'and starts no cooldown');
  const p = t.connect({ filter: 'all' });
  assert.equal(t.fake.log.requests.length, 2, 'the second requestDevice ran synchronously inside connect(), no cooldown in the way');
  assert.deepEqual(t.fake.log.requests[1], { acceptAllDevices: true, optionalServices: [INPUT_CONFIG.service] });
  await t.until(() => t.provider.status.state === 'streaming');
  await p;
  assert.equal(t.provider.status.state, 'streaming');
  assert.equal(t.provider.status.error, null);
  t.dispose();
});

test('fake device: a refused permission is permission_denied without cooldown; an unavailable adapter is gatt_failure without cooldown', T, async () => {
  const a = setup({ chooser: 'permission' });
  await assert.rejects(a.connect(), (e) => e.code === 'permission_denied');
  assert.equal(a.provider.status.state, 'error');
  assert.equal(a.provider.status.cooldownUntil, null);
  assert.equal(a.provider.status.failures, 0);
  const b = setup({ chooser: 'adapter' });
  await assert.rejects(b.connect(), (e) => e.code === 'gatt_failure' && /adapter/i.test(e.message));
  assert.equal(b.provider.status.state, 'error');
  assert.equal(b.provider.status.cooldownUntil, null, 'the chooser stage is not a connection attempt');
  const c = setup({ chooser: 'error' });
  await assert.rejects(c.connect(), (e) => e.code === 'gatt_failure');
  assert.equal(c.provider.status.cooldownUntil, null);
  for (const x of [a, b, c]) x.dispose();
});

test('fake device: unsupported browser: error state at construction, retryable false, no cooldown, connect rejects', T, async () => {
  const t = setup({}, { noBluetooth: true });
  const st = t.provider.status;
  assert.equal(st.state, 'error');
  assert.equal(st.error.code, 'unsupported_browser');
  assert.equal(st.error.retryable, false);
  assert.equal(st.cooldownUntil, null);
  assertValid('InputStatus', st);
  await assert.rejects(t.connect(), (e) => e.code === 'unsupported_browser' && e.info.retryable === false);
  await assert.rejects(t.reconnect(), (e) => e.code === 'unsupported_browser');
  assert.equal(t.provider.status.state, 'error');
  assert.equal(t.provider.status.cooldownUntil, null);
  await t.provider.disconnect();
  assert.equal(t.provider.status.state, 'idle', 'disconnect() never throws');
  t.dispose();
});

test('fake device: reconnect() without a known device rejects', T, async () => {
  const t = setup();
  await assert.rejects(t.reconnect(), (e) => e.code === 'gatt_failure' && /known device/.test(e.message));
  t.dispose();
});

// ------------------------------------------------------------------------------------------------ failures and cooldown

test('fake device: a failed connect is gatt_failure with a 10 s cooldown that refuses attempts without touching the radio', T, async () => {
  const t = setup({ connect: 'fail' });
  const p = t.connect();
  await t.until(() => t.provider.status.state === 'error');
  await assert.rejects(p, (e) => e.code === 'gatt_failure');
  const st = t.provider.status;
  assert.equal(st.failures, 1);
  assert.equal(st.cooldownUntil, st.error.at + 10_000);
  assert.equal(t.rec.errors.at(-1).code, 'gatt_failure');

  const requests = t.fake.log.requests.length;
  const connects = t.fake.log.connectCalls;
  const errorsBefore = t.rec.errors.length;
  await assert.rejects(t.connect(), (e) => e.code === 'cooldown' && e.info.code === 'cooldown' && /wait \d+ s/.test(e.message));
  await assert.rejects(t.reconnect(), (e) => e.code === 'cooldown');
  assert.equal(t.fake.log.requests.length, requests, 'no chooser during the cooldown');
  assert.equal(t.fake.log.connectCalls, connects, 'no radio activity during the cooldown');
  assert.equal(t.provider.status.state, 'error', 'a refusal leaves the state alone');
  assert.equal(t.provider.status.error.code, 'gatt_failure', 'the last real error stays visible for the UI');
  assert.equal(t.rec.errors.length, errorsBefore + 2);
  assert.equal(t.rec.errors.at(-1).code, 'cooldown');

  // after the cooldown a new attempt goes through, and streaming resets the failure count
  t.fake.behaviour.connect = 'ok';
  await t.advance(st.cooldownUntil - t.clock.now() + 1);
  await t.connected();
  assert.equal(t.provider.status.state, 'streaming');
  assert.equal(t.provider.status.failures, 0);
  assert.equal(t.provider.status.cooldownUntil, null);
  t.dispose();
});

test('fake device: after three consecutive failures the cooldown is 180 s', T, async () => {
  const t = setup({ connect: 'fail' });
  const waits = [];
  for (let i = 0; i < 3; i++) {
    const p = t.connect();
    await t.until(() => t.provider.status.state === 'error' && t.provider.status.failures === i + 1);
    await assert.rejects(p, (e) => e.code === 'gatt_failure');
    const st = t.provider.status;
    waits.push(st.cooldownUntil - st.error.at);
    if (i < 2) await t.advance(st.cooldownUntil - t.clock.now() + 1); // wait out the short cooldowns only
  }
  assert.deepEqual(waits, [10_000, 10_000, 180_000]);
  assert.equal(t.provider.status.failures, 3);
  await t.advance(170_000);
  await assert.rejects(t.connect(), (e) => e.code === 'cooldown' && /long cooldown/.test(e.message));
  t.fake.behaviour.connect = 'ok';
  await t.advance(11_000);
  await t.connected();
  assert.equal(t.provider.status.failures, 0);
  t.dispose();
});

test('fake device: connect timeout after 15 s (gatt.connect never answers) is gatt_failure', T, async () => {
  const t = setup({ connect: 'hang' });
  const p = t.connect();
  await t.advance(14_000);
  assert.equal(t.provider.status.state, 'connecting');
  await t.advance(1500);
  await assert.rejects(p, (e) => e.code === 'gatt_failure' && /timeout/.test(e.message));
  assert.equal(t.provider.status.state, 'error');
  assert.equal(t.provider.status.failures, 1);
  t.dispose();
});

test('fake device (n9): a discovery race (NotFoundError once) does not start the cooldown: the Joy-Con connects', T, async () => {
  const t = setup({ serviceNotFoundFirst: 1 });
  await t.connected();
  assert.equal(t.provider.status.state, 'streaming');
  assert.equal(t.provider.status.failures, 0);
  assert.equal(t.provider.status.cooldownUntil, null);
  t.dispose();
});

test('fake device: discovery timeout, missing service and missing characteristics', T, async () => {
  const hang = setup({ service: 'hang' });
  const p = hang.connect();
  await hang.advance(16_000);
  await assert.rejects(p, (e) => e.code === 'gatt_failure' && /discovery/.test(e.message));
  assert.ok(hang.fake.log.disconnectCalls >= 1);

  const missing = setup({ service: 'missing' });
  const q = missing.connect();
  await missing.advance(3000);
  await assert.rejects(q, (e) => e.code === 'not_joycon');
  assert.equal(missing.provider.status.state, 'error');
  assert.equal(missing.provider.status.cooldownUntil, missing.provider.status.error.at + 10_000, 'not_joycon starts the cooldown too');

  const noInput = setup({ omitCharacteristics: [CH.input] });
  const r = noInput.connect();
  await noInput.advance(3000);
  await assert.rejects(r, (e) => e.code === 'not_joycon');
  for (const x of [hang, missing, noInput]) x.dispose();
});

// ------------------------------------------------------------------------------------------------ initialisation watchdog

test('fake device: a silent controller: watchdog stage 1 at 2 s (ENABLE again), stage 2 at 4.5 s (0xFF), default mask 0xB7, stage 3 at 9 s (no_data)', T, async () => {
  const t = setup({ reports: 'none' });
  const p = t.connect();
  await t.until(() => t.fake.log.notifications.some((n) => n.uuid === CH.input));
  const subscribedAt = t.fake.log.notifications.find((n) => n.uuid === CH.input).t;
  assert.equal(t.provider.status.state, 'initializing');
  assert.equal(count(t.frames(), FRAME.enableB7), 1);

  await t.advance(subscribedAt + 1900 - t.clock.now());
  assert.equal(count(t.frames(), FRAME.enableB7), 1, 'nothing before 2 s');
  assert.equal(t.provider.getDiagnostics().watchdogStage, 0);
  await t.advance(300);
  assert.equal(count(t.frames(), FRAME.enableB7), 2, 'stage 1: ENABLE re-sent');
  assert.equal(t.provider.getDiagnostics().watchdogStage, 1);
  assert.equal(t.provider.status.featureMask, 0xb7);

  await t.advance(subscribedAt + 4400 - t.clock.now());
  assert.equal(count(t.frames(), FRAME.setFF), 0);
  await t.advance(300);
  assert.equal(count(t.frames(), FRAME.setFF), 1, 'stage 2: SET(0xFF)');
  await t.advance(700);
  assert.equal(count(t.frames(), FRAME.enableFF), 1, 'stage 2: ENABLE(0xFF)');
  assert.equal(t.provider.getDiagnostics().watchdogStage, 2);
  assert.equal(t.provider.status.featureMask, 0xff);
  assert.equal(t.provider.status.state, 'initializing');

  await t.advance(subscribedAt + 8900 - t.clock.now());
  assert.equal(t.provider.status.state, 'initializing');
  await t.advance(300);
  await assert.rejects(p, (e) => e.code === 'no_data');
  const st = t.provider.status;
  assert.equal(st.state, 'error');
  assert.equal(st.error.code, 'no_data');
  assert.equal(st.failures, 1);
  assert.equal(st.cooldownUntil, st.error.at + 10_000);
  assert.equal(t.provider.getDiagnostics().watchdogStage, 3);
  assert.ok(t.fake.onlyCommandWrites());
  assert.deepEqual(t.fake.log.overlaps, []);
  t.dispose();
});

test('fake device: a controller that only streams with mask 0xFF is rescued by watchdog stage 2', T, async () => {
  const t = setup({ requireMask: 0xff });
  await t.connected();
  assert.equal(t.provider.status.state, 'streaming');
  assert.equal(t.provider.status.featureMask, 0xff);
  assert.equal(t.provider.getDiagnostics().watchdogStage, 2);
  assert.ok(t.rec.logs.some((l) => l.level === 'warn' && /0xff/i.test(l.message)));
  assert.ok(t.rec.samples.length > 0);
  t.dispose();
});

// ---- round 1 findings F1 / M5: the feature mask (0xB7 default, 0x37 expert, 0xFF last resort) and phantom ZL/ZR bits

test('fake device (F1): the default init writes SET and ENABLE with 0xB7 and never a 0x37 frame; the mask in the status is 0xB7', T, async () => {
  const t = setup();
  await t.connected();
  const frames = t.frames();
  assert.equal(count(frames, FRAME.setB7), 1);
  assert.equal(count(frames, FRAME.enableB7), 1);
  assert.equal(count(frames, FRAME.set37) + count(frames, FRAME.enable37), 0, 'the unproven 0x37 is never sent by default');
  assert.equal(count(frames, FRAME.setFF) + count(frames, FRAME.enableFF), 0, 'and 0xFF is only the last resort');
  assert.equal(t.provider.status.featureMask, 0xb7);
  assert.equal(t.provider.getDiagnostics().watchdogStage, 0);
  t.dispose();
});

test('fake device (F1): the expert mask 0x37 is still sent when asked for; if it gives no data the watchdog tries 0xB7 BEFORE the last resort 0xFF', T, async () => {
  const t = setup({ requireMask: 0xb7 }); // a controller that only streams with 0xB7
  await t.connected({ mask: 0x37 });
  const frames = t.frames();
  assert.equal(count(frames, FRAME.set37), 1, 'the expert choice was honoured first');
  assert.equal(count(frames, FRAME.setB7), 1, 'stage 2 went to 0xB7');
  assert.equal(count(frames, FRAME.setFF), 0, '0xFF was never needed');
  assert.equal(t.provider.status.state, 'streaming');
  assert.equal(t.provider.status.featureMask, 0xb7);
  assert.equal(t.provider.getDiagnostics().watchdogStage, 2);
  assert.ok(t.rec.logs.some((l) => l.level === 'warn' && /0xb7/i.test(l.message)));
  t.dispose();
  // a controller that needs 0xFF: from the expert 0x37 the chain is 0x37 -> 0xB7 (stage 2, no data) -> 0xB7 stays, stage 3 fails
  const u = setup({ requireMask: 0xff, reports: 'stream' });
  const p = u.connect({ mask: 0x37 });
  await u.until(() => u.provider.status.state === 'error', 30000);
  await assert.rejects(p, (e) => e.code === 'no_data');
  assert.equal(count(u.frames(), FRAME.setB7), 1);
  u.dispose();
});

test('fake device (F1): phantom ZR right after the watchdog changed the mask is ignored for 1.5 s (no shot, no re-centre), a real press afterwards is not', T, async () => {
  const t = setup({ requireMask: 0xff }); // the default 0xB7 gives no data: stage 2 falls back to 0xFF, the mask that "induces phantom ZL/ZR bits"
  await t.connected();
  assert.equal(t.provider.status.featureMask, 0xff);
  t.fake.setButtons(['ZR']); // the phantom bit appears once the new mask is active
  await t.advance(200);
  t.fake.setButtons([]);
  await t.advance(200);
  t.fake.setButtons(['ZR']);
  await t.advance(200);
  t.fake.setButtons([]);
  await t.advance(200);
  assert.deepEqual(t.rec.actions.filter((a) => a.action === 'fire' || a.action === 'recenter'), [], 'no spurious shot inside the hold-off');
  t.provider.setTriggerButton('R'); // with the trigger on R the phantom-prone ZR is the re-centre: still nothing would have fired
  t.provider.setTriggerButton('ZR');
  await t.advance(1500);
  t.fake.setButtons(['ZR']);
  await t.advance(200);
  assert.equal(t.rec.actions.filter((a) => a.action === 'fire').length, 1, 'a deliberate press after the hold-off works');
  // other actions were never held off
  t.fake.setButtons([]);
  await t.advance(200);
  t.fake.setButtons(['B']);
  await t.advance(200);
  assert.equal(t.rec.actions.at(-1).action, 'back');
  t.dispose();
});

test('fake device (n3): the mask that worked is remembered: after a link loss the reconnect starts with 0xFF and needs no 4.5 s no-data stage', T, async () => {
  const t = setup({ requireMask: 0xff });
  await t.connected();
  assert.equal(t.provider.status.featureMask, 0xff);
  assert.equal(t.provider.getDiagnostics().watchdogStage, 2);
  const firstFrames = t.frames().length;
  t.fake.dropLink();
  const lostAt = t.clock.now();
  await t.until(() => t.provider.status.state === 'streaming', 15000);
  assert.equal(t.provider.status.state, 'streaming');
  const second = t.frames().slice(firstFrames);
  assert.equal(second[0], FRAME.led);
  assert.equal(second[1], FRAME.setFF, 'the second connection starts with the mask that worked');
  assert.equal(second[2], FRAME.enableFF);
  assert.equal(count(second, FRAME.setB7), 0, 'the unproductive default is not repeated');
  assert.equal(t.provider.getDiagnostics().watchdogStage, 0, 'no watchdog stage was needed the second time');
  assert.ok(t.clock.now() - lostAt < 4500, `recovered in ${t.clock.now() - lostAt} ms, not after the 4.5 s stage 2`);
  t.dispose();
});

test('fake device (n2): a LATE first report after watchdog stage 2 still gets a fresh 1.5 s hold-off for phantom ZR bits', T, async () => {
  // the controller needs 0xFF and starts to report 2.6 s after the new mask was written: the hold-off that stage 2 started (1.5 s)
  // is over by then, so it is renewed when the stream starts. The phantom bit shows up right after the first report (the first
  // report itself is only the baseline of the button state).
  const t = setup({ requireMask: 0xff, streamStartDelayMs: 2600 });
  await t.connected();
  assert.equal(t.provider.status.featureMask, 0xff);
  assert.equal(t.provider.getDiagnostics().watchdogStage, 2);
  t.fake.setButtons(['ZR']);
  await t.advance(300);
  t.fake.setButtons([]);
  await t.advance(300);
  t.fake.setButtons(['ZR']);
  await t.advance(300);
  assert.deepEqual(t.rec.actions.filter((a) => a.action === 'fire'), [], 'the phantom ZR of the first reports fired nothing');
  t.fake.setButtons([]);
  await t.advance(1500);
  t.fake.setButtons(['ZR']);
  await t.advance(200);
  assert.equal(t.rec.actions.filter((a) => a.action === 'fire').length, 1, 'a deliberate press after the hold-off works');
  t.dispose();
});

test('fake device (F1): with the default mask working there is no hold-off: an early shot and an early re-centre press are honoured', T, async () => {
  const t = setup();
  await t.connected();
  t.fake.setButtons(['ZR']);
  await t.advance(200);
  assert.equal(t.rec.actions.filter((a) => a.action === 'fire').length, 1);
  t.fake.setButtons(['ZR', 'R']);
  await t.advance(200);
  assert.equal(t.rec.actions.filter((a) => a.action === 'recenter').length, 1);
  t.dispose();
});

test('fake device: reports whose IMU bytes are zero keep the provider in `initializing` until no_data', T, async () => {
  const t = setup({ reports: 'inactive' });
  const p = t.connect();
  await t.until(() => t.provider.status.state === 'error', 30000);
  await assert.rejects(p, (e) => e.code === 'no_data');
  assert.equal(t.rec.samples.length, 0, 'Motion must never see an all-zero IMU');
  assert.ok(t.rec.packets.length > 0, 'packet events still fire for the diagnostics');
  assert.ok(t.rec.packets.every((x) => x.report && x.report.imuActive === false));
  assert.ok(t.rec.logs.some((l) => /all zero/.test(l.message)));
  t.dispose();
});

test('fake device: truncated 20-byte notifications are rejected (MTU), the attempt ends with no_data and the length is visible', T, async () => {
  const t = setup({ reports: 'truncated' });
  const p = t.connect();
  await t.until(() => t.provider.status.state === 'error', 30000);
  await assert.rejects(p, (e) => e.code === 'no_data');
  assert.equal(t.rec.samples.length, 0);
  assert.ok(t.rec.packets.length > 0 && t.rec.packets.every((x) => x.length === 20 && x.report === null));
  assert.ok(t.rec.logs.some((l) => /truncated/.test(l.message)));
  t.dispose();
});

// ------------------------------------------------------------------------------------------------ lost link and retry

test('fake device: a dropped link is `lost` with a cooldown, then ONE automatic retry after 2 s reuses the device (no chooser)', T, async () => {
  const t = setup();
  await t.connected();
  const samples = t.rec.samples.length;
  t.fake.dropLink();
  let st = t.provider.status;
  assert.equal(st.state, 'lost');
  assert.equal(st.error.code, 'lost_signal');
  assert.equal(st.failures, 1);
  assert.equal(st.cooldownUntil, st.error.at + 10_000);
  assert.equal(st.trackingOk, false);
  assert.equal(t.rec.errors.at(-1).code, 'lost_signal');
  const lostAt = t.clock.now();
  assert.equal(t.fake.log.disconnectCalls, 0, 'the browser already dropped it');

  await t.advance(1900);
  assert.equal(t.provider.status.state, 'lost', 'nothing before the 2 s delay');
  assert.equal(t.fake.log.connectCalls, 1);
  await t.advance(200);
  assert.equal(t.provider.status.state, 'connecting');
  await t.until(() => t.provider.status.state === 'streaming');
  assert.ok(t.clock.now() - lostAt < 4000);
  st = t.provider.status;
  assert.equal(st.failures, 0);
  assert.equal(st.error, null);
  assert.equal(st.cooldownUntil, null);
  assert.equal(t.fake.log.requests.length, 1, 'the chooser was not opened again');
  assert.equal(t.fake.log.connectCalls, 2);
  assert.ok(t.rec.samples.length > samples);
  const first = t.rec.samples[samples];
  assert.equal(first.dtMs, null, 'the first sample after a reconnect never integrates across the gap');
  assert.deepEqual(t.states().slice(-4), ['lost', 'connecting', 'initializing', 'streaming']);
  t.dispose();
});

test('fake device: the automatic retry is exactly one; when it fails the state returns to `lost` (never `error`) and the cooldown restarts', T, async () => {
  const t = setup();
  await t.connected();
  t.fake.behaviour.connect = 'fail';
  t.fake.dropLink();
  await t.advance(2000 + 500);
  await t.until(() => t.provider.status.failures === 2, 10_000);
  const st = t.provider.status;
  assert.equal(st.state, 'lost');
  assert.equal(st.error.code, 'gatt_failure');
  assert.equal(st.failures, 2);
  assert.equal(st.cooldownUntil, st.error.at + 10_000);
  assert.equal(t.fake.log.connectCalls, 2);
  await t.advance(60_000);
  assert.equal(t.fake.log.connectCalls, 2, 'no second automatic retry, never a loop');
  assert.equal(t.provider.status.state, 'lost');
  assert.equal(t.fake.log.requests.length, 1);

  // the player retries (cooldown is over): reconnect() re-uses the device and recovers
  t.fake.behaviour.connect = 'ok';
  const again = t.reconnect();
  await t.until(() => t.provider.status.state === 'streaming');
  await again;
  assert.equal(t.provider.status.state, 'streaming');
  assert.equal(t.fake.log.requests.length, 1, 'still no chooser');
  assert.equal(t.provider.status.failures, 0);
  t.dispose();
});

test('fake device: reconnect() during the cooldown after a lost link is refused', T, async () => {
  const t = setup();
  await t.connected();
  t.fake.dropLink();
  t.fake.behaviour.connect = 'fail';
  await t.advance(2500);
  await t.until(() => t.provider.status.failures === 2);
  const connects = t.fake.log.connectCalls;
  await assert.rejects(t.reconnect(), (e) => e.code === 'cooldown');
  assert.equal(t.fake.log.connectCalls, connects);
  assert.equal(t.provider.status.state, 'lost');
  t.dispose();
});

test('fake device: reports stopping for 2.5 s while the link stays up is `lost` (lost_signal)', T, async () => {
  const t = setup();
  await t.connected();
  t.provider.on('status', () => {});
  t.fake.silence(true);
  const silentAt = t.clock.now();
  await t.advance(2000);
  assert.equal(t.provider.status.state, 'streaming');
  await t.until(() => t.provider.status.state === 'lost', 2000);
  const elapsed = t.clock.now() - silentAt;
  assert.ok(elapsed >= 2500 && elapsed <= 2500 + INPUT_CONFIG.watchTickMs + 100 + 100, `lost after ${elapsed} ms`);
  assert.equal(t.provider.status.error.code, 'lost_signal');
  assert.match(t.provider.status.error.message, /no report/);
  assert.equal(t.fake.log.disconnectCalls, 1, 'the provider tears the stalled link down');
  t.dispose();
});

test('fake device: trackingOk drops when samples go stale and returns with fresh ones, without leaving `streaming`', T, async () => {
  const t = setup();
  await t.connected();
  assert.equal(t.provider.status.trackingOk, true);
  t.fake.silence(true);
  await t.advance(900);
  assert.equal(t.provider.status.state, 'streaming');
  assert.equal(t.provider.status.trackingOk, false);
  t.fake.silence(false);
  await t.advance(400);
  assert.equal(t.provider.status.trackingOk, true);
  t.dispose();
});

test('fake device: a hidden tab never counts towards the silence limit (timers are throttled there)', T, async () => {
  const t = setup();
  await t.connected();
  t.document.setHidden(true);
  assert.ok(t.rec.logs.some((l) => l.level === 'warn' && /tab hidden/.test(l.message)));
  t.fake.silence(true);
  await t.advance(15_000);
  assert.equal(t.provider.status.state, 'streaming', 'hidden time is not silence');
  t.document.setHidden(false);
  await t.advance(2000);
  assert.equal(t.provider.status.state, 'streaming', 'the silence limit restarts when the tab is visible again');
  await t.advance(1000);
  assert.equal(t.provider.status.state, 'lost');
  t.dispose();
});

// ------------------------------------------------------------------------------------------------ keep-alive, serialisation, whitelist

test('fake device: the 1 Hz keep-alive keeps a link alive that the macOS model would drop after 15 s (UNVERIFIED-ON-HARDWARE, UOH-5)', T, async () => {
  const withKeepAlive = setup({ dropWithoutWriteMs: 15_000 });
  await withKeepAlive.connected();
  await withKeepAlive.advance(60_000);
  assert.equal(withKeepAlive.provider.status.state, 'streaming');
  const frames = withKeepAlive.frames();
  assert.ok(count(frames, FRAME.led) >= 55, `${count(frames, FRAME.led)} LED frames in 60 s`);

  const without = setup({ dropWithoutWriteMs: 15_000 });
  await without.connected({ keepAlive: false });
  const start = without.clock.now();
  await without.until(() => without.provider.status.state === 'lost', 30_000);
  const survived = without.clock.now() - start;
  assert.ok(survived > 10_000 && survived < 20_000, `dropped after ${survived} ms without keep-alive`);
  assert.equal(without.provider.status.error.code, 'lost_signal');
  withKeepAlive.dispose();
  without.dispose();
});

test('fake device: writes go only to the command characteristic and never overlap, even with haptics and keep-alive together', T, async () => {
  const t = setup();
  await t.connected();
  for (let i = 0; i < 100; i++) {
    t.provider.vibrate(i % 2 ? 3 : 6);
    await t.advance(30);
  }
  await t.advance(3000);
  assert.ok(t.fake.onlyCommandWrites(), 'never the firmware channel, never the look-alike characteristic');
  assert.deepEqual(t.fake.log.overlaps, [], 'one GATT operation at a time');
  assert.equal(t.fake.log.inProgressErrors, 0);
  const writes = t.fake.log.writes;
  for (let i = 1; i < writes.length; i++) assert.ok(writes[i].t - writes[i - 1].t >= INPUT_CONFIG.writeSpacingMs - 1e-9);
  const haptics = t.frames().filter((h) => h.startsWith('0a91')).length;
  assert.ok(haptics > 5 && haptics <= 26, `${haptics} vibrate frames for 100 requests in 3 s: rate limited to 10 per second`);
  t.dispose();
});

test('fake device: vibrate() is a no-op unless streaming and swallows write errors', T, async () => {
  const t = setup();
  assert.doesNotThrow(() => t.provider.vibrate(3));
  await t.connected();
  t.fake.behaviour.writeFails = true;
  assert.doesNotThrow(() => t.provider.vibrate(3));
  await t.advance(1500);
  assert.equal(t.provider.status.state, 'streaming', 'a failing haptic write does not touch the stream');
  t.dispose();
});

// ------------------------------------------------------------------------------------------------ disconnect, dispose, page lifecycle

test('fake device: disconnect() from streaming goes to idle, closes GATT, and does not trigger the automatic retry', T, async () => {
  const t = setup();
  await t.connected();
  await t.provider.disconnect();
  const st = t.provider.status;
  assert.equal(st.state, 'idle');
  assert.equal(st.error, null);
  assert.equal(st.trackingOk, false);
  assert.equal(t.fake.log.disconnectCalls, 1);
  const connects = t.fake.log.connectCalls;
  await t.advance(30_000);
  assert.equal(t.fake.log.connectCalls, connects, 'no reconnect after a user disconnect');
  assert.equal(t.provider.status.state, 'idle');
  assert.equal(t.provider.status.failures, 0, 'a user disconnect is not a failure');
  // and it can connect again straight away (no cooldown for a deliberate disconnect)
  await t.connected();
  assert.equal(t.provider.status.state, 'streaming');
  t.dispose();
});

test('fake device: disconnect() while the chooser is open rejects the attempt with `cancelled`; the late choice is ignored', T, async () => {
  const t = setup({ chooserDelayMs: 5000 });
  const p = t.connect();
  await t.advance(1000);
  await t.provider.disconnect();
  await assert.rejects(p, (e) => e.code === 'cancelled');
  assert.equal(t.provider.status.state, 'idle');
  await t.advance(10_000);
  assert.equal(t.fake.log.connectCalls, 0, 'the device chosen after disconnect() is never connected');
  assert.equal(t.provider.status.state, 'idle');
  t.dispose();
});

test('fake device: disconnect() while connecting stops the attempt and closes the half-open link', T, async () => {
  const t = setup({ discoveryDelayMs: 3000 });
  const p = t.connect();
  await t.advance(1000);
  assert.equal(t.provider.status.state, 'connecting');
  await t.provider.disconnect();
  await assert.rejects(p, (e) => e.code === 'cancelled');
  await t.advance(10_000);
  assert.equal(t.provider.status.state, 'idle');
  assert.equal(t.rec.samples.length, 0);
  assert.ok(t.fake.log.disconnectCalls >= 1);
  t.dispose();
});

test('fake device: disconnect() while gatt.connect() is still pending aborts it at once (no dangling connection later)', T, async () => {
  const t = setup({ connect: 'hang' });
  const p = t.connect();
  await t.advance(1000);
  assert.equal(t.provider.status.state, 'connecting');
  assert.equal(t.fake.log.disconnectCalls, 0);
  await t.provider.disconnect();
  await assert.rejects(p, (e) => e.code === 'cancelled');
  assert.equal(t.fake.log.disconnectCalls, 1, 'gatt.disconnect() aborts the pending connect');
  assert.equal(t.provider.status.state, 'idle');
  await t.advance(20_000);
  assert.equal(t.provider.status.state, 'idle', 'the abandoned attempt never comes back');
  assert.equal(t.provider.status.failures, 0);
  t.dispose();
});

test('fake device: a connect that times out is aborted on the GATT server as well', T, async () => {
  const t = setup({ connect: 'hang' });
  const p = t.connect();
  await t.advance(16_000);
  await assert.rejects(p, (e) => e.code === 'gatt_failure');
  assert.equal(t.fake.log.disconnectCalls, 1, 'the pending connect is cancelled, so it cannot complete later');
  t.dispose();
});

test('fake device: a stale attempt cannot clear or close the handle of a newer one', T, async () => {
  const t = setup({ connect: 'hang' });
  const first = t.connect();
  await t.advance(500);
  await t.provider.disconnect();
  await assert.rejects(first, (e) => e.code === 'cancelled');
  t.fake.behaviour.connect = 'ok';
  const calls = t.fake.log.disconnectCalls;
  const second = t.connect();
  await t.until(() => t.provider.status.state === 'streaming');
  await second;
  await t.advance(20_000);
  assert.equal(t.provider.status.state, 'streaming', 'the first attempt did not disturb the second');
  assert.equal(t.fake.log.disconnectCalls, calls);
  t.dispose();
});

test('fake device: pagehide tears the GATT connection down', T, async () => {
  const t = setup();
  await t.connected();
  t.page.dispatchEvent(new Event('pagehide'));
  assert.equal(t.provider.status.state, 'idle');
  assert.equal(t.fake.log.disconnectCalls, 1);
  t.dispose();
});

test('fake device: dispose() removes every listener and timer', T, async () => {
  const t = setup();
  await t.connected();
  t.provider.dispose();
  assert.equal(t.fake.log.disconnectCalls, 1);
  const n = t.rec.status.length;
  t.page.dispatchEvent(new Event('pagehide'));
  t.document.setHidden(true);
  await t.advance(10_000);
  assert.equal(t.rec.status.length, n);
  t.fake.stop();
  assert.equal(t.timers.pending(), 0, 'no timer left running');
});

// ------------------------------------------------------------------------------------------------ data flowing through

test('fake device: buttons become actions on rising edges only; a button held at connect time does not fire', T, async () => {
  const t = setup({ side: 'R' });
  t.fake.setButtons(['A']); // held while connecting
  await t.connected();
  await t.advance(300);
  assert.deepEqual(t.rec.actions, [], 'the baseline report never fires an action');
  t.fake.setButtons(['A', 'ZR']);
  await t.advance(100);
  t.fake.setButtons(['A', 'ZR']);
  await t.advance(300);
  assert.equal(t.rec.actions.length, 1);
  assert.deepEqual([t.rec.actions[0].action, t.rec.actions[0].label, t.rec.actions[0].source], ['fire', 'ZR', 'joycon']);
  assertValid('ActionEvent', t.rec.actions[0]);
  t.fake.setButtons([]);
  await t.advance(200);
  t.fake.setButtons(['B']);
  await t.advance(200);
  assert.deepEqual(t.rec.actions.map((a) => a.action), ['fire', 'back']);
  t.fake.setButtons(['PLUS', 'HOME']);
  await t.advance(200);
  assert.equal(t.rec.actions.at(-1).action, 'pause');
  assert.equal(t.rec.actions.filter((a) => a.action === 'pause').length, 1, 'HOME is never mapped');
  t.dispose();
});

test('fake device: a Left unit maps DOWN to confirm and MINUS to pause with the Left labels', T, async () => {
  const t = setup({ side: 'L', name: 'Joy-Con 2 (L)' });
  await t.connected();
  t.fake.setButtons(['DOWN']);
  await t.advance(200);
  t.fake.setButtons(['MINUS']);
  await t.advance(200);
  assert.deepEqual(t.rec.actions.map((a) => [a.action, a.label]), [['confirm', 'Down'], ['pause', '-']]);
  t.dispose();
});

test('fake device: battery millivolts become level bands, an event only when the band changes', T, async () => {
  const t = setup({ batteryMv: 3800 });
  await t.connected();
  assert.equal(t.provider.status.battery.level, 'ok');
  assert.equal(t.provider.status.battery.mv, 3800);
  const events = t.rec.status.length;
  t.fake.behaviour.batteryMv = 3790;
  await t.advance(400);
  assert.equal(t.provider.status.battery.mv, 3790);
  assert.equal(t.rec.status.filter((s) => s.battery.level === 'ok').length > 0, true);
  t.fake.behaviour.batteryMv = 3400;
  await t.advance(400);
  assert.equal(t.provider.status.battery.level, 'low');
  t.fake.behaviour.batteryMv = 3200;
  await t.advance(400);
  assert.equal(t.provider.status.battery.level, 'critical');
  assert.equal(t.provider.status.battery.pct, null);
  assert.ok(t.rec.status.length > events);
  t.dispose();
});

test('fake device: PacketEvent bytes are a private copy (the browser reuses its buffer)', T, async () => {
  const t = setup({ reuseBuffer: true });
  await t.connected();
  await t.advance(300);
  assert.ok(t.rec.packets.length > 5);
  const first = t.rec.packets[2];
  const snapshot = first.bytes.slice();
  await t.advance(500);
  assert.deepEqual(first.bytes, snapshot);
  assert.equal(first.length, 63);
  assert.equal(first.report.length, 63);
  assert.equal(typeof first.arrivedAt, 'number');
  t.dispose();
});

test('fake device: the packet rate is reported about once per second (66 Hz in the fake)', T, async () => {
  const t = setup();
  await t.connected();
  await t.advance(4000);
  const rate = t.provider.status.packetRateHz;
  assert.ok(rate > 62 && rate < 70, `packetRateHz ${rate}`);
  const withRate = t.rec.status.filter((s) => s.packetRateHz !== null);
  assert.ok(withRate.length >= 2 && withRate.length <= 6, `${withRate.length} status events with a rate in 4 s`);
  t.dispose();
});

test('fake device: diagnostics expose timings, mask, writes and stream statistics', T, async () => {
  const t = setup();
  await t.connected();
  await t.advance(2000);
  const d = t.provider.getDiagnostics();
  assert.equal(d.kind, 'joycon');
  assert.equal(d.side, 'R');
  assert.equal(d.timings.connectMs, 50);
  assert.ok(d.timings.discoveryMs >= 300 && d.timings.discoveryMs < 600, `discovery ${d.timings.discoveryMs}`);
  assert.ok(d.timings.initMs > 0 && d.timings.firstReportMs >= 0 && d.timings.totalMs > 0);
  assert.equal(d.featureMask, 0xb7);
  assert.equal(d.watchdogStage, 0);
  assert.equal(d.keepAlive, true);
  assert.ok(d.writeCount >= 3 && d.lastWriteAt > 0);
  assert.ok(d.stream.samples > 100 && d.stream.dtSource === 'device');
  assert.ok(Math.abs(d.stream.dtRatio - 1) < 0.02);
  assert.equal(d.hidden, false);
  JSON.stringify(d);
  t.dispose();
});

test('fake device: every emitted object satisfies its contract (statuses, samples, actions, buttons, errors)', T, async () => {
  const t = setup({ connect: 'fail' });
  const failing = t.connect();
  await t.until(() => t.provider.status.state === 'error');
  await assert.rejects(failing);
  t.fake.behaviour.connect = 'ok';
  await t.advance(11_000);
  await t.connected();
  t.fake.setButtons(['R']);
  await t.advance(500);
  t.fake.dropLink();
  await t.advance(8000);
  for (const s of t.rec.status) assertValid('InputStatus', s);
  for (const s of t.rec.samples) assertValid('ImuSample', s);
  for (const a of t.rec.actions) assertValid('ActionEvent', a);
  for (const b of t.rec.buttons) assertValid('ButtonsEvent', b);
  for (const e of t.rec.errors) {
    assert.ok(['unsupported_browser', 'permission_denied', 'cancelled', 'not_joycon', 'cooldown', 'gatt_failure', 'no_data', 'lost_signal'].includes(e.code));
    assert.equal(typeof e.message, 'string');
    assert.equal(typeof e.at, 'number');
    assert.equal(e.retryable, e.code !== 'unsupported_browser');
  }
  assert.ok(t.rec.errors.length >= 2);
  // status objects are immutable snapshots: the first one is untouched by everything that followed
  assert.ok(Object.isFrozen(t.rec.status[0]));
  t.dispose();
});

test('createInputProvider: joycon works with the manual clock and default timers absent (no globals needed at import time)', T, async () => {
  const clock = createManualClock(0);
  const p = createInputProvider('joycon', { clock, bluetooth: null });
  assert.equal(p.status.error.code, 'unsupported_browser');
  p.dispose();
});

// ------------------------------------------------------------------------------------------------ Clay Rush: the trigger (C-02)

test('fake device (C-02): a ZR press is a fire whose t is the sample time of the first report showing it, emitted AFTER that sample', T, async () => {
  const t = setup({ side: 'R' });
  await t.connected();
  await t.advance(200);
  const order = [];
  t.provider.on('sample', (s) => order.push(['sample', s.t, s.buttons.includes('ZR')]));
  t.provider.on('action', (a) => order.push(['action', a.t, a.action]));
  t.fake.setButtons(['ZR']);
  await t.advance(100);
  const firstDown = order.find((e) => e[0] === 'sample' && e[2]);
  const fire = order.find((e) => e[0] === 'action');
  assert.ok(firstDown && fire, 'a sample with ZR down and a fire');
  assert.equal(fire[2], 'fire');
  assert.equal(fire[1], firstDown[1], 'fire.t is the ImuSample.t of the first report with the button down');
  assert.ok(order.indexOf(fire) === order.indexOf(firstDown) + 1, 'the action follows the sample of its own report');
  const ev = t.rec.actions.at(-1);
  assert.deepEqual([ev.action, ev.label, ev.source], ['fire', 'ZR', 'joycon']);
  assertValid('ActionEvent', ev);
  t.dispose();
});

test('fake device (C-02): setTriggerButton("R") swaps the shoulder buttons and the labels; a Left unit fires with ZL', T, async () => {
  const t = setup({ side: 'R' });
  await t.connected();
  t.provider.setTriggerButton('R');
  assert.deepEqual(t.provider.getActionLabels(), { confirm: 'A', back: 'B', pause: '+', recenter: 'ZR', fire: 'R' });
  t.fake.setButtons(['R']);
  await t.advance(200);
  t.fake.setButtons(['ZR']);
  await t.advance(200);
  assert.deepEqual(t.rec.actions.map((a) => [a.action, a.label]), [['fire', 'R'], ['recenter', 'ZR']]);
  t.provider.setTriggerButton('bogus');
  assert.equal(t.provider.getActionLabels().fire, 'R', 'an unknown value is ignored');
  t.provider.setTriggerButton('ZR');
  assert.equal(t.provider.getActionLabels().fire, 'ZR');
  t.dispose();
  const l = setup({ side: 'L' });
  await l.connected();
  l.fake.setButtons(['ZL']);
  await l.advance(200);
  assert.deepEqual(l.rec.actions.map((a) => [a.action, a.label]), [['fire', 'ZL']]);
  l.dispose();
});

test('fake device (C-02): two trigger pulls about 150 ms apart (an over-and-under double) are two shots', T, async () => {
  const t = setup({ side: 'R' });
  await t.connected();
  await t.advance(100);
  t.fake.setButtons(['ZR']);
  await t.advance(70);
  t.fake.setButtons([]);
  await t.advance(80);
  t.fake.setButtons(['ZR']);
  await t.advance(100);
  const fires = t.rec.actions.filter((a) => a.action === 'fire');
  assert.equal(fires.length, 2);
  assert.ok(fires[1].t - fires[0].t >= 70 && fires[1].t - fires[0].t < 250, `${fires[1].t - fires[0].t} ms apart`);
  t.dispose();
});

test('fake device (C-05): when the fire arrives, Motion already holds the sample of its report: aimAt(fire.t) is valid even at compMs 0', T, async () => {
  const { createMotionPipeline } = await import('../../public/js/motion/index.js');
  const { mountCalibration } = await import('../../test-support/motion/tip-stream.js');
  const t = setup({ side: 'R' });
  const motion = createMotionPipeline({ clock: t.clock });
  motion.setCalibration(mountCalibration('faceUp', 'R'));
  const seen = [];
  t.provider.on('sample', (s) => motion.pushImu(s));
  t.provider.on('action', (a) => {
    if (a.action === 'fire') seen.push({ at0: motion.aimAt(a.t), at40: motion.aimAt(a.t - 40) });
  });
  await t.connected();
  await t.advance(300);
  t.fake.setButtons(['ZR']);
  await t.advance(100);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].at0.valid, true, 'compMs 0');
  assert.equal(seen[0].at40.valid, true, 'compMs 40');
  t.dispose();
});

test('fake device (I-03): after the 0xFF fallback the hold-off covers the ZL/ZR buttons only: with the trigger on R a shot in the first 1.5 s fires', T, async () => {
  const t = setup({ requireMask: 0xff });
  t.provider.setTriggerButton('R');
  await t.connected();
  assert.equal(t.provider.status.featureMask, 0xff);
  t.fake.setButtons(['ZR']); // phantom: now the re-centre
  await t.advance(200);
  t.fake.setButtons(['R']); // a real trigger pull inside the window
  await t.advance(200);
  assert.deepEqual(t.rec.actions.map((a) => [a.action, a.label]), [['fire', 'R']]);
  t.dispose();
});
