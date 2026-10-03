// The native-bridge InputProvider (public/js/input/native-provider.js) against a FAKE fetch and EventSource (test-support/bridge/fake-page-bridge.js).
// Every test name says what it proves about the provider; none of them says anything about the real CoreBluetooth helper or a real Joy-Con
// (UNVERIFIED-ON-HARDWARE). The REAL captures REAL_R_1 and REAL_R_2 (Joy-Con 2 Right, 2026-09-30) go through the same parser and report
// stream as the Web Bluetooth path. Timers and clock are virtual: nothing sleeps.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setupNative, vectorHex, createFakePageBridge } from '../../test-support/bridge/fake-page-bridge.js';
import { createNativeProvider, NATIVE_ERRORS, NATIVE_STRING_KEYS, NATIVE_PROGRESS_KEYS, describeNativeError } from '../../public/js/input/native-provider.js';
import { createReportStream } from '../../public/js/input/report-stream.js';
import { buildInputReport } from '../../public/js/input/joycon2-build.js';
import { parseInputReport, hexToBytes, bytesToHex } from '../../public/js/input/joycon2-parse.js';
import { INPUT_CONFIG } from '../../public/js/input/input-config.js';
import { INPUT_ERROR } from '../../public/js/shared/contracts.js';
import { createManualClock } from '../../public/js/shared/clock.js';
import { assertValid } from '../../public/js/shared/validate.js';
import { batteryLevel } from '../../public/js/input/status.js';

const T = { timeout: 30000 };
const REAL_1 = vectorHex('REAL_R_1');
const REAL_2 = vectorHex('REAL_R_2');

/** A synthetic report: near rest, IMU timestamp `us`, optional buttons. */
const synth = (us, pressed = []) => bytesToHex(buildInputReport({ counter: us / 1000, imuTimestampUs: us, batteryMv: 3435, temperatureRaw: 5, accelRaw: { x: -600, y: -700, z: 3960 }, gyroRaw: { x: 0, y: 16, z: -12 }, pressed }));

/** Start a connect and bring the helper to `streaming` (no report yet). */
async function startStreamingHelper(opts = {}) {
  const t = setupNative(opts);
  const p = t.connect(opts.connect);
  await t.toHelperStreaming(opts.side ?? 'R');
  return { t, p };
}

/** Deliver a report at the current virtual time, helper time `helperT`. */
const deliver = (t, hex, helperT) => t.bridge.report(hex, helperT);

// ------------------------------------------------------------------------------------------------ interface

test('native provider: same InputProvider interface as the BLE provider, kind joycon, honest capabilities', T, () => {
  const t = setupNative();
  const p = t.provider;
  for (const m of ['connect', 'reconnect', 'disconnect', 'getActionLabels', 'setTriggerButton', 'on', 'off', 'dispose', 'vibrate', 'setKeepAlive', 'getDiagnostics', 'getBridgeInfo']) assert.equal(typeof p[m], 'function', m);
  assert.equal(p.kind, 'joycon');
  assert.deepEqual(p.capabilities, { imu: true, aim: false, buttons: true, needsUserGesture: false, needsCalibration: true, hasBattery: true, canVibrate: true });
  assert.ok(Object.isFrozen(p.capabilities));
  assertValid('InputStatus', p.status);
  assert.equal(p.status.state, 'idle');
  assert.deepEqual(Object.keys(p.getActionLabels()).sort(), ['back', 'confirm', 'fire', 'pause', 'recenter']);
  const off = p.on('status', () => {});
  assert.equal(typeof off, 'function');
  t.dispose();
});

test('native provider: without fetch or EventSource it is unsupported (code unsupported_browser, not retryable) and connect() rejects', T, async () => {
  const clock = createManualClock(0);
  const p = createNativeProvider({ clock, fetch: null, EventSource: null, document: null, pageTarget: null });
  assert.equal(p.status.state, 'error');
  assert.equal(p.status.error.code, 'unsupported_browser');
  assert.equal(p.status.error.retryable, false);
  assertValid('InputStatus', p.status);
  await assert.rejects(p.connect(), (err) => err.code === 'unsupported_browser' && err.info.native.key === 'connect.err.native.unavailable');
  p.dispose();
});

// ------------------------------------------------------------------------------------------------ the real captures

test('REAL captures: REAL_R_1 (IMU bytes still zero) gives imuActive false and no sample; REAL_R_2 gives |accel| about 0.99 g, imuActive true, and streaming', T, async () => {
  const { t, p } = await startStreamingHelper();
  assert.equal(t.provider.status.state, 'initializing', 'the helper says streaming, the provider waits for the first IMU sample');

  deliver(t, REAL_1, 5000);
  await t.flush();
  assert.equal(t.rec.samples.length, 0, 'no ImuSample out of an all-zero IMU');
  assert.equal(t.rec.packets.length, 1);
  assert.equal(t.rec.packets[0].report.imuActive, false);
  assert.equal(t.rec.packets[0].report.imuMarker, 1, 'the IMU marker is set but the motion bytes are zero');
  assert.equal(t.provider.status.state, 'initializing', 'still waiting for real IMU data');
  assert.equal(t.provider.getDiagnostics().stream.inactive, 1);

  await t.advance(15);
  deliver(t, REAL_2, 5015);
  await t.flush();
  assert.equal(t.rec.samples.length, 1);
  const s = t.rec.samples[0];
  assertValid('ImuSample', s);
  assert.equal(s.imuActive, true);
  assert.equal(s.side, 'R');
  assert.equal(s.dtMs, null, 'the first IMU sample has no previous timestamp');
  assert.deepEqual(s.accel, { x: -607 / 4096, y: -698 / 4096, z: 3964 / 4096 });
  assert.deepEqual(s.gyro, { x: 0, y: 16 * 2000 / 32768, z: -12 * 2000 / 32768 });
  const mag = Math.hypot(s.accel.x, s.accel.y, s.accel.z);
  assert.ok(Math.abs(mag - 0.99) < 0.01, `|a| = ${mag}`);
  assert.equal(s.batteryMv, 3435);
  assert.ok(Math.abs(s.tempC - parseInputReport(hexToBytes(REAL_2), 'R').temperatureC) < 1e-9);
  assert.ok(s.tempC > 24 && s.tempC < 30, 'about room temperature');
  assert.equal(t.provider.status.state, 'streaming');
  await p;
  assert.deepEqual(t.states(), ['requesting', 'connecting', 'initializing', 'streaming']);
  const st = t.provider.status;
  assert.equal(st.side, 'R');
  assert.equal(st.featureMask, 0xb7);
  assert.equal(st.error, null);
  assert.equal(st.failures, 0);
  assert.equal(st.cooldownUntil, null);
  assert.equal(st.trackingOk, true);
  assert.equal(st.battery.mv, 3435);
  // The real unit reports 3435 mV, which the CURRENT bands (ok >= 3550 mV) call "low". The provider only applies them; whether the bands are
  // too strict for this unit is an open question (protocol 7.6, UOH-17), reported separately.
  assert.equal(st.battery.level, batteryLevel(3435, INPUT_CONFIG));
  assert.equal(st.battery.pct, null);
  for (const status of t.rec.status) assertValid('InputStatus', status);
  t.dispose();
});

test('REAL captures: the state is streaming BEFORE the first sample is delivered, and the parsed report is exactly what the shared parser gives', T, async () => {
  const { t } = await startStreamingHelper();
  const order = [];
  t.provider.on('status', (s) => s.state === 'streaming' && order.push('status:streaming'));
  t.provider.on('sample', () => order.push('sample'));
  deliver(t, REAL_2, 100);
  await t.flush();
  assert.deepEqual(order.slice(0, 2), ['status:streaming', 'sample']);
  const direct = parseInputReport(hexToBytes(REAL_2), 'R');
  assert.deepEqual(t.rec.packets[0].report, direct);
  t.dispose();
});

test('the samples are the same as the BLE path: the native provider and a bare report stream with the same bytes and times give identical ImuSamples', T, async () => {
  const { t } = await startStreamingHelper();
  const bare = createReportStream({ config: INPUT_CONFIG, side: 'R' });
  const reference = [];
  const feed = (hex, helperT) => {
    deliver(t, hex, helperT);
    const { sample } = bare.push(hexToBytes(hex), t.clock.now());
    if (sample) reference.push(sample);
  };
  feed(REAL_1, 1000);
  const base = 764777;
  for (let i = 0; i < 60; i++) {
    await t.advance(15);
    feed(i === 0 ? REAL_2 : synth(base + i * 15000, i === 20 ? ['A'] : []), 1015 + i * 15);
  }
  await t.flush();
  assert.equal(t.rec.samples.length, reference.length);
  assert.ok(reference.length >= 60);
  for (let i = 0; i < reference.length; i++) {
    const a = t.rec.samples[i];
    const b = reference[i];
    // seq, arrival time and t can differ only by the clock mapping: here the mapping is the identity (helper time advances with the clock)
    assert.deepEqual({ ...a }, { ...b }, `sample ${i}`);
  }
  assert.ok(t.rec.samples.every((s) => s.dtSource === 'device'));
  assert.equal(t.rec.samples[1].dtMs, 15);
  t.dispose();
});

test('dt comes from the IMU timestamp and survives a u32 wrap; a gap makes dtMs null', T, async () => {
  const { t } = await startStreamingHelper();
  deliver(t, synth(4294965296), 1000);
  await t.advance(4);
  deliver(t, synth(2000), 1004);
  await t.advance(300);
  deliver(t, synth(300000), 1304);
  await t.flush();
  const [a, b, c] = t.rec.samples;
  assert.equal(a.dtMs, null);
  assert.equal(b.dtMs, 4, '4294965296 -> 2000 is 4000 us: the wrap is handled');
  assert.equal(c.dtMs, null, '298 ms is a gap');
  t.dispose();
});

test('fallback: stuck IMU timestamps make dt come from the HELPER\'s clock, not from the jittery arrival of the events', T, async () => {
  const { t } = await startStreamingHelper();
  // the helper sends a report every 20 ms; the events reach the page in bursts of two (pipe and SSE batching), the IMU timestamp is stuck
  let helperT = 500;
  for (let i = 0; i < 48; i++) {
    if (i % 2 === 0) await t.advance(40);
    deliver(t, synth(764777), helperT);
    helperT += 20;
  }
  await t.flush();
  const last = t.rec.samples.slice(-10);
  assert.ok(last.length > 5);
  assert.ok(last.every((s) => s.dtSource === 'arrival'), 'device timestamps are unusable: arrival times are used');
  for (const s of last) assert.ok(Math.abs(s.dtMs - 20) < 0.6, `dtMs ${s.dtMs} follows the helper clock (20 ms), not the burst pattern (0 and 40 ms)`);
  t.dispose();
});

test('clock mapping: t is never after the arrival, non-decreasing, and a late burst does not make it jump', T, async () => {
  const { t } = await startStreamingHelper();
  let helperT = 100;
  for (let i = 0; i < 30; i++) {
    await t.advance(15);
    deliver(t, synth(764777 + i * 15000), helperT);
    helperT += 15;
  }
  // the page stalls for 400 ms; then 26 reports arrive at once
  await t.advance(400);
  for (let i = 0; i < 26; i++) {
    deliver(t, synth(764777 + (30 + i) * 15000), helperT);
    helperT += 15;
  }
  await t.flush();
  let prev = -Infinity;
  for (const s of t.rec.samples) {
    assert.ok(s.t <= s.arrivedAt + 1e-9, 't never after arrivedAt');
    assert.ok(s.t >= prev, 't never goes backwards');
    prev = s.t;
  }
  const burst = t.rec.samples.slice(-26);
  assert.ok(burst[25].t - burst[0].t > 300, 'the burst keeps the helper\'s own spacing (about 15 ms per report) instead of collapsing to one instant');
  t.dispose();
});

test('buttons: a report with A pressed on a Right unit gives a confirm action, rising edge only', T, async () => {
  const { t } = await startStreamingHelper({ side: 'R' });
  deliver(t, synth(1000000), 1000);
  await t.advance(15);
  deliver(t, synth(1015000, ['A']), 1015);
  await t.advance(15);
  deliver(t, synth(1030000, ['A']), 1030);
  await t.advance(200);
  deliver(t, synth(1230000), 1230);
  await t.flush();
  assert.equal(t.rec.actions.length, 1);
  assert.equal(t.rec.actions[0].action, 'confirm');
  assert.equal(t.rec.actions[0].source, 'joycon');
  assert.deepEqual(t.provider.getActionLabels(), { confirm: 'A', back: 'B', pause: '+', recenter: 'R', fire: 'ZR' });
  t.dispose();
});

test('buttons (Clay Rush C-02): ZR fires with t = the sample time of its report, after that sample; setTriggerButton swaps to R', T, async () => {
  const { t } = await startStreamingHelper({ side: 'R' });
  const order = [];
  t.provider.on('sample', (s) => order.push(['sample', s.t]));
  t.provider.on('action', (a) => order.push(['action', a.t, a.action, a.label]));
  deliver(t, synth(1000000), 1000);
  await t.advance(15);
  deliver(t, synth(1015000, ['ZR']), 1015);
  await t.flush();
  const fireAt = order.findIndex((e) => e[0] === 'action');
  assert.ok(fireAt > 0);
  assert.deepEqual(order[fireAt].slice(2), ['fire', 'ZR']);
  assert.equal(order[fireAt - 1][0], 'sample', 'the action comes right after the sample of its report');
  assert.equal(order[fireAt][1], order[fireAt - 1][1], 'fire.t = ImuSample.t of that report');
  t.provider.setTriggerButton('R');
  assert.deepEqual(t.provider.getActionLabels(), { confirm: 'A', back: 'B', pause: '+', recenter: 'ZR', fire: 'R' });
  await t.advance(200);
  deliver(t, synth(1215000, ['R']), 1215);
  await t.flush();
  assert.deepEqual(t.rec.actions.map((a) => [a.action, a.label]), [['fire', 'ZR'], ['fire', 'R']]);
  for (const a of t.rec.actions) assertValid('ActionEvent', a);
  t.dispose();
});

test('the side comes from the helper and switches the action labels; a Left unit gets the Left labels', T, async () => {
  const { t } = await startStreamingHelper({ side: 'L' });
  assert.equal(t.provider.status.side, 'L');
  assert.deepEqual(t.provider.getActionLabels(), { confirm: 'Down', back: 'Left', pause: '-', recenter: 'L', fire: 'ZL' });
  deliver(t, synth(1000000), 1000);
  await t.flush();
  assert.equal(t.rec.samples[0].side, 'L');
  t.dispose();
});

// ------------------------------------------------------------------------------------------------ the request

test('the connect request: bridge checked first, stream opened before the POST, the custom header on every POST, default body', T, async () => {
  const { t } = await startStreamingHelper();
  const b = t.bridge;
  assert.deepEqual(b.calls.map((c) => `${c.method} ${c.path}`), ['GET /status', 'POST /connect']);
  assert.equal(b.sources.length, 1);
  assert.match(b.sources[0].url, /\/__bridge\/events$/);
  assert.equal(b.calls[1].headers['X-Joycon-Ninja'], '1');
  assert.equal(b.calls[1].headers['Content-Type'], 'application/json');
  assert.deepEqual(b.calls[1].body, { side: 'any', scanSeconds: 45 });
  t.dispose();
});

test('connect options: side, mask, keepAlive false, pairingOnly and scanSeconds reach the bridge; the BLE-only filter does not', T, async () => {
  const t = setupNative();
  t.connect({ side: 'L', mask: 0xff, keepAlive: false, pairingOnly: false, scanSeconds: 20, filter: 'strict' });
  await t.posted();
  assert.deepEqual(t.bridge.calls.find((c) => c.path === '/connect').body, { side: 'L', scanSeconds: 20, mask: 255, keepAliveHz: 0, pairingOnly: false });
  t.dispose();
});

test('connect() is idempotent while an attempt runs and resolves at once when already streaming', T, async () => {
  const { t, p } = await startStreamingHelper();
  assert.equal(t.provider.connect(), t.provider.connect());
  deliver(t, REAL_2, 100);
  await p;
  assert.equal(t.provider.status.state, 'streaming');
  await t.provider.connect();
  assert.equal(t.bridge.posts('/connect').length, 1, 'no second request');
  t.dispose();
});

test('progress: the provider announces each phase with its NEW string key, in order', T, async () => {
  const { t } = await startStreamingHelper();
  deliver(t, REAL_2, 100);
  await t.flush();
  assert.deepEqual(t.rec.bridge.map((b) => b.phase), ['checking', 'starting', 'waitingBluetooth', 'scanning', 'connecting', 'discovering', 'initialising', 'waitingData', 'streaming']);
  const scan = t.rec.bridge.find((b) => b.phase === 'scanning');
  assert.equal(scan.scanSeconds, 45, 'the scan length travels with the event (the connect screen counts it down)');
  assert.ok(Number.isFinite(scan.scanStartedAt), 'and the moment the scan really started (the second `scanning` status)');
  assert.equal(t.rec.bridge.find((b) => b.phase === 'waitingBluetooth').scanStartedAt, null, 'the wait for Bluetooth is not part of the scan time');
  for (const b of t.rec.bridge.filter((x) => x.phase !== 'streaming')) assert.equal(b.key, NATIVE_PROGRESS_KEYS[b.phase]);
  assert.equal(t.provider.getBridgeInfo().phase, 'streaming');
  t.dispose();
});

test('the scan phase: the second "scanning" status (or, from a helper that sends only one, the first advert) starts it and stamps scanStartedAt; each attempt starts over; "transport" says native', T, async () => {
  const t = setupNative();
  assert.equal(t.provider.transport, 'native');
  assert.deepEqual([t.provider.getBridgeInfo().scanStartedAt, t.provider.getBridgeInfo().scanSeconds], [null, 45]);
  t.connect();
  await t.posted();
  t.bridge.status('scanning', { message: 'waiting for Bluetooth' });
  await t.advance(3000);
  assert.equal(t.provider.getBridgeInfo().phase, 'waitingBluetooth');
  assert.equal(t.provider.getBridgeInfo().scanStartedAt, null, 'the wait for the macOS prompt is not scan time');
  const at = t.clock.now();
  t.bridge.emit({ type: 'advert', side: 'R', pid: 8294, rssi: -40, host: '00 00 00 00 00 00', pairing: true });
  await t.flush();
  const info = t.provider.getBridgeInfo();
  assert.deepEqual([info.phase, info.scanStartedAt], ['scanning', at], 'an advert proves that the scan runs');
  t.bridge.status('connecting', { side: 'R' });
  await t.flush();
  assert.equal(t.provider.getBridgeInfo().scanStartedAt, at, 'kept for the diagnostics page after the scan');
  await t.provider.disconnect();
  t.connect();
  await t.posted();
  assert.equal(t.provider.getBridgeInfo().scanStartedAt, null, 'a new attempt starts over');
  t.dispose();
});

test('the server\'s own progress (building, starting) is shown while the connect request is still open', T, async () => {
  let open;
  const gate = new Promise((resolve) => { open = resolve; });
  const t = setupNative({ bridge: { connectGate: gate } });
  t.connect();
  for (let i = 0; i < 50 && !t.bridge.source?.readyState; i++) await t.flush();
  await t.flush();
  t.bridge.emit({ type: 'bridge', phase: 'building' });
  await t.flush();
  assert.equal(t.provider.getBridgeInfo().phase, 'building', 'progress arrives before the answer');
  t.bridge.emit({ type: 'bridge', phase: 'built', ok: true });
  t.bridge.emit({ type: 'bridge', phase: 'starting' });
  open();
  await t.posted();
  t.bridge.status('scanning');
  await t.flush();
  assert.deepEqual(t.rec.bridge.map((b) => b.phase), ['checking', 'starting', 'building', 'starting', 'waitingBluetooth']);
  t.dispose();
});

// ------------------------------------------------------------------------------------------------ sequence numbers and replays

test('a replayed status and the tail of an earlier session (seq at or below the answer) are ignored; events sent before the answer arrives are kept', T, async () => {
  let open;
  const gate = new Promise((resolve) => { open = resolve; });
  const t = setupNative({ bridge: { connectGate: gate } });
  t.bridge.emit({ type: 'status', state: 'disconnected' }); // the previous session ends: seq 1, before this attempt
  const p = t.connect();
  for (let i = 0; i < 50 && !t.bridge.source?.readyState; i++) await t.flush();
  await t.flush();
  t.bridge.source.message({ type: 'status', state: 'error', code: 'lost_signal', replay: true, seq: 1 }); // the replay of an old failure
  t.bridge.source.message({ type: 'status', state: 'disconnected', seq: 1 }); // a late copy of the earlier session's last line
  t.bridge.emit({ type: 'status', state: 'scanning' }); // sent before the POST is answered, belongs to us
  t.bridge.emit({ type: 'status', state: 'connecting', side: 'R' });
  open();
  await t.posted();
  await t.flush();
  assert.equal(t.provider.status.state, 'connecting', 'the two old events changed nothing; the two new ones were applied in order after the answer');
  assert.deepEqual(t.states(), ['requesting', 'connecting']);
  assert.equal(t.rec.errors.length, 0);
  t.bridge.status('initialising', { side: 'R' });
  t.bridge.status('streaming', { side: 'R' });
  deliver(t, REAL_2, 100);
  await p;
  assert.equal(t.provider.status.state, 'streaming');
  t.dispose();
});

test('a malformed stream message and events of the wrong type are ignored; a report with bad hex is counted, never parsed', T, async () => {
  const { t } = await startStreamingHelper();
  t.bridge.source.raw('not json');
  t.bridge.source.raw('null');
  t.bridge.source.raw('"text"');
  t.bridge.emit({ type: 'report', t: 1, hex: 'zz' });
  t.bridge.emit({ type: 'report', t: 1, hex: 'abc' });
  t.bridge.emit({ type: 'report', t: 1 });
  t.bridge.emit({ type: 'mystery' });
  await t.flush();
  assert.equal(t.rec.packets.length, 0);
  assert.equal(t.provider.getBridgeInfo().badReports, 3);
  deliver(t, REAL_2, 100);
  await t.flush();
  assert.equal(t.provider.status.state, 'streaming');
  t.dispose();
});

test('a report shorter than 60 bytes is rejected by the shared stream (packet event without report), with one warning', T, async () => {
  const { t } = await startStreamingHelper();
  deliver(t, REAL_2.slice(0, 40), 100);
  deliver(t, REAL_2.slice(0, 40), 115);
  await t.flush();
  assert.equal(t.rec.samples.length, 0);
  assert.equal(t.rec.packets.filter((p) => p.report === null).length, 2);
  assert.equal(t.rec.logs.filter((l) => /rejected/.test(l.message)).length, 1);
  t.dispose();
});

test('a status warning (dropped notifications) is logged and counted, it is not a state change', T, async () => {
  const { t } = await startStreamingHelper();
  t.bridge.emit({ type: 'status', state: 'streaming', warning: 'bad_length', message: 'dropped an input notification of 20 bytes (expected 63)', dropped: 4 });
  await t.flush();
  assert.equal(t.provider.getBridgeInfo().dropped, 4);
  assert.ok(t.rec.logs.some((l) => l.level === 'warn' && /bad_length/.test(l.message)));
  assert.equal(t.provider.status.state, 'initializing');
  t.dispose();
});

// ------------------------------------------------------------------------------------------------ errors: permission, no_device, ...

async function failWith(helperEvent, opts = {}) {
  const t = setupNative(opts);
  const p = t.connect();
  await t.posted();
  t.bridge.status('scanning');
  if (opts.adverts) for (const a of opts.adverts) t.bridge.emit({ type: 'advert', side: 'R', pid: 8294, rssi: -50, host: a ? '00 00 00 00 00 00' : 'non-zero', pairing: a });
  t.bridge.emit(helperEvent);
  await assert.rejects(p);
  return { t, p };
}

test('permission error: code permission_denied, NEW key connect.err.native.permission, NO cooldown, the stream is closed, the helper is not asked to disconnect', T, async () => {
  const { t } = await failWith({ type: 'status', state: 'error', code: 'bluetooth_permission', message: 'macOS denied Bluetooth access' });
  const st = t.provider.status;
  assert.equal(st.state, 'error');
  assert.equal(st.error.code, INPUT_ERROR.PERMISSION_DENIED);
  assert.deepEqual({ ...st.error.native }, { code: 'bluetooth_permission', key: 'connect.err.native.permission' });
  assert.equal(st.error.retryable, true);
  assert.equal(st.failures, 0);
  assert.equal(st.cooldownUntil, null);
  assert.equal(t.rec.errors.length, 1);
  assert.ok(t.bridge.sources[0].closed);
  assert.equal(t.bridge.posts('/disconnect').length, 0, 'the failure came from the helper: it has already ended the session');
  assertValid('InputStatus', st);
  // an immediate retry is allowed (no cooldown)
  const again = t.connect();
  await t.posted();
  assert.equal(t.bridge.posts('/connect').length, 2);
  t.bridge.status('scanning');
  t.bridge.status('error', { code: 'bluetooth_permission', message: 'still denied' });
  await assert.rejects(again);
  t.dispose();
});

test('the server\'s crash translation arrives as a normal bluetooth_permission status (source server) and is handled the same way', T, async () => {
  const { t } = await failWith({ type: 'status', state: 'error', code: 'bluetooth_permission', message: 'macOS stopped the Bluetooth helper', source: 'server' });
  assert.equal(t.provider.status.error.native.code, 'bluetooth_permission');
  assert.equal(t.provider.status.cooldownUntil, null);
  t.dispose();
});

test('no_device: code gatt_failure without cooldown, key noDevice; when only non-pairing adverts were seen the key is notPairing', T, async () => {
  const a = await failWith({ type: 'status', state: 'error', code: 'no_device', message: 'no Joy-Con 2 advert found within 45 s' });
  assert.equal(a.t.provider.status.error.code, INPUT_ERROR.GATT_FAILURE);
  assert.equal(a.t.provider.status.error.native.key, 'connect.err.native.noDevice');
  assert.equal(a.t.provider.status.cooldownUntil, null);
  assert.equal(a.t.provider.status.failures, 0);
  a.t.dispose();
  const b = await failWith({ type: 'status', state: 'error', code: 'no_device', message: 'seen but not in pairing mode' }, { adverts: [false] });
  assert.equal(b.t.provider.status.error.native.code, 'not_pairing');
  assert.equal(b.t.provider.status.error.native.key, 'connect.err.native.notPairing');
  assert.equal(b.t.provider.status.cooldownUntil, null);
  assert.equal(b.t.provider.getBridgeInfo().adverts.length, 1);
  b.t.dispose();
  const c = await failWith({ type: 'status', state: 'error', code: 'no_device', message: 'x' }, { adverts: [false, true] });
  assert.equal(c.t.provider.status.error.native.code, 'no_device', 'a pairing-mode advert WAS seen, so it is not a "not pairing" case');
  c.t.dispose();
});

test('bluetooth_off: code gatt_failure without cooldown, key bluetoothOff', T, async () => {
  const { t } = await failWith({ type: 'status', state: 'error', code: 'bluetooth_off', message: 'Bluetooth is turned off' });
  assert.equal(t.provider.status.error.native.key, 'connect.err.native.bluetoothOff');
  assert.equal(t.provider.status.cooldownUntil, null);
  t.dispose();
});

test('connect_failed and gatt_failure involve the controller: they count, start the 10 s cooldown, and the 3rd in a row the 180 s one', T, async () => {
  const t = setupNative();
  for (let i = 1; i <= 3; i++) {
    const p = t.connect();
    await t.posted();
    t.bridge.status('scanning');
    t.bridge.status('connecting', { side: 'R' });
    t.bridge.status('error', { code: i === 2 ? 'gatt_failure' : 'connect_failed', message: 'failed' });
    await assert.rejects(p);
    const st = t.provider.status;
    assert.equal(st.failures, i);
    const expected = i >= 3 ? 180 : 10;
    assert.equal(st.cooldownUntil, t.clock.now() + expected * 1000, `cooldown after failure ${i}`);
    assert.equal(st.error.code, INPUT_ERROR.GATT_FAILURE);
    if (i < 3) {
      // during the cooldown connect() is refused without touching the bridge
      const before = t.bridge.calls.length;
      await assert.rejects(t.provider.connect(), (err) => err.code === 'cooldown');
      assert.equal(t.bridge.calls.length, before, 'a refusal never touches the bridge');
      assert.equal(t.provider.status.state, 'error', 'and does not change the state');
      await t.advance(10000);
    }
  }
  assert.equal(t.provider.status.failures, 3);
  await assert.rejects(t.provider.connect(), (err) => err.code === 'cooldown');
  await t.advance(180000);
  const ok = t.connect();
  await t.posted();
  assert.equal(t.bridge.posts('/connect').length, 4, 'after the long cooldown a new attempt is allowed');
  t.dispose();
  void ok;
});

test('a successful connection resets the failure counter and the cooldown', T, async () => {
  const t = setupNative();
  let p = t.connect();
  await t.posted();
  t.bridge.status('scanning');
  t.bridge.status('error', { code: 'connect_failed', message: 'failed' });
  await assert.rejects(p);
  assert.equal(t.provider.status.failures, 1);
  await t.advance(10000);
  p = t.connect();
  await t.toHelperStreaming();
  deliver(t, REAL_2, 100);
  await p;
  assert.equal(t.provider.status.failures, 0);
  assert.equal(t.provider.status.cooldownUntil, null);
  t.dispose();
});

test('helper_crashed (the server says the helper died): gatt_failure, no cooldown, key crashed', T, async () => {
  const { t } = await failWith({ type: 'status', state: 'error', code: 'helper_crashed', message: 'the Bluetooth helper stopped unexpectedly (exit code 1)', source: 'server' });
  assert.equal(t.provider.status.error.native.key, 'connect.err.native.crashed');
  assert.equal(t.provider.status.cooldownUntil, null);
  t.dispose();
});

test('a helper error in the middle of the setup ends the attempt at that stage (connecting, discovering, initialising all work)', T, async () => {
  for (const stage of ['connecting', 'discovering', 'initialising']) {
    const t = setupNative();
    const p = t.connect();
    await t.posted();
    t.bridge.status('scanning');
    for (const s of ['connecting', 'discovering', 'initialising']) {
      t.bridge.status(s, { side: 'R' });
      if (s === stage) break;
    }
    t.bridge.status('error', { code: 'gatt_failure', message: `failed during ${stage}` });
    await assert.rejects(p, (err) => err.code === 'gatt_failure', stage);
    assert.equal(t.provider.status.state, 'error');
    t.dispose();
  }
});

// ------------------------------------------------------------------------------------------------ the bridge itself

test('bridge unreachable (the game server does not answer): gatt_failure, key noServer, no cooldown', T, async () => {
  const t = setupNative({ bridge: { statusThrows: true } });
  const p = t.connect();
  await assert.rejects(p, (err) => err.info.native.code === 'bridge_unreachable');
  assert.equal(t.provider.status.error.native.key, 'connect.err.native.noServer');
  assert.equal(t.provider.status.cooldownUntil, null);
  assert.equal(t.bridge.sources.length, 0, 'no stream was opened');
  t.dispose();
});

test('an older server without bridge endpoints (404): unsupported_browser, not retryable, key oldServer', T, async () => {
  const t = setupNative({ bridge: { statusHttp: 404, status: { ok: false } } });
  await assert.rejects(t.connect(), (err) => err.code === 'unsupported_browser');
  assert.equal(t.provider.status.error.native.key, 'connect.err.native.oldServer');
  assert.equal(t.provider.status.error.retryable, false);
  t.dispose();
});

test('the bridge says it is not available (no compiler, not macOS, helper missing): unsupported_browser with key unavailable', T, async () => {
  for (const reason of ['no_compiler', 'not_macos', 'helper_missing']) {
    const t = setupNative({ bridge: { status: { available: false, reason, built: false, canBuild: false, state: 'idle' } } });
    await assert.rejects(t.connect(), (err) => err.code === 'unsupported_browser', reason);
    assert.equal(t.provider.status.error.native.code, reason);
    assert.equal(t.provider.status.error.native.key, 'connect.err.native.unavailable');
    assert.equal(t.bridge.sources.length, 0);
    assert.equal(t.bridge.posts('/connect').length, 0);
    t.dispose();
  }
});

test('POST refusals: 409 busy (another tab) does NOT disconnect that session; 403 refused; 503 helper_missing / build_failed / helper_failed; network error', T, async () => {
  const cases = [
    [{ status: 409, body: { ok: false, code: 'busy', message: 'a connection attempt is already running (streaming)' } }, 'bridge_busy', 'connect.err.native.busy'],
    [{ status: 403, body: { ok: false, code: 'forbidden', message: 'cross-origin request refused' } }, 'bridge_refused', 'connect.err.native.refused'],
    [{ status: 503, body: { ok: false, code: 'helper_missing', message: 'not built' } }, 'helper_missing', 'connect.err.native.unavailable'],
    [{ status: 503, body: { ok: false, code: 'build_failed', message: 'compiler exploded' } }, 'build_failed', 'connect.err.native.buildFailed'],
    [{ status: 503, body: { ok: false, code: 'helper_failed', message: 'no hello' } }, 'helper_failed', 'connect.err.native.helperFailed'],
    [{ status: 500, body: { ok: false, code: 'bridge_module_error', message: 'x' } }, 'bridge_module_error', 'connect.err.native.unavailable'],
  ];
  for (const [connectError, code, key] of cases) {
    const t = setupNative({ bridge: { connectError } });
    await assert.rejects(t.connect());
    const st = t.provider.status;
    assert.equal(st.error.native.code, code);
    assert.equal(st.error.native.key, key);
    assert.equal(st.cooldownUntil, null, `${code} starts no cooldown`);
    assert.equal(t.bridge.posts('/disconnect').length, 0, `${code}: the failed request started nothing that has to be undone`);
    assert.ok(t.bridge.sources.every((s) => s.closed));
    t.dispose();
  }
  const t = setupNative({ bridge: { connectThrows: true } });
  await assert.rejects(t.connect(), (err) => err.info.native.code === 'bridge_unreachable');
  t.dispose();
});

test('the event stream cannot be opened: error before open, or no open within 5 s, is bridge_unreachable', T, async () => {
  const a = setupNative({ bridge: { autoOpen: false } });
  const p = a.connect();
  await a.flush();
  a.bridge.source.error();
  await assert.rejects(p, (err) => err.info.native.code === 'bridge_unreachable');
  assert.ok(a.bridge.source.closed, 'and the browser\'s automatic reconnection is never used');
  a.dispose();

  const b = setupNative({ bridge: { autoOpen: false } });
  const q = b.connect();
  await b.flush();
  await b.advance(5000);
  await assert.rejects(q, (err) => err.info.native.code === 'bridge_unreachable');
  assert.equal(b.bridge.posts('/connect').length, 0);
  b.dispose();
});

// ------------------------------------------------------------------------------------------------ stalls, no data, loss

test('no_data: the helper streams but only REAL_R_1 style reports (IMU bytes zero) arrive for 9 s: no_data, counted, and the helper is told to disconnect', T, async () => {
  const { t, p } = await startStreamingHelper();
  for (let i = 0; i < 10; i++) {
    deliver(t, REAL_1, 1000 + i * 30);
    await t.advance(30);
  }
  assert.equal(t.provider.status.state, 'initializing');
  await t.advance(9000);
  await assert.rejects(p, (err) => err.code === 'no_data');
  const st = t.provider.status;
  assert.equal(st.state, 'error');
  assert.equal(st.error.native.key, 'connect.err.native.noData');
  assert.equal(st.failures, 1);
  assert.equal(st.cooldownUntil, st.error.at + 10000);
  assert.equal(t.bridge.posts('/disconnect').length, 1, 'the failure is ours: the helper must let go of the Joy-Con');
  assert.ok(t.bridge.sources[0].closed);
  assert.equal(t.rec.samples.length, 0);
  t.dispose();
});

test('stalled: the helper goes quiet after "connecting": the attempt fails after 30 s, counts, and the helper is told to disconnect', T, async () => {
  const t = setupNative();
  const p = t.connect();
  await t.posted();
  t.bridge.status('scanning');
  t.bridge.status('connecting', { side: 'R' });
  await t.advance(29000);
  assert.equal(t.provider.status.state, 'connecting');
  await t.advance(1500);
  await assert.rejects(p, (err) => err.info.native.code === 'stalled');
  assert.equal(t.provider.status.failures, 1);
  assert.equal(t.bridge.posts('/disconnect').length, 1);
  t.dispose();
});

test('the scan deadline follows the scan time (45 s plus slack), and a helper that never answers after the request fails after 30 s', T, async () => {
  const a = setupNative();
  const pa = a.connect();
  await a.posted();
  a.bridge.status('scanning');
  await a.advance(54000);
  assert.equal(a.provider.status.state, 'requesting', 'still searching at 54 s');
  await a.advance(2000);
  await assert.rejects(pa, (err) => err.info.native.code === 'stalled');
  a.dispose();

  const b = setupNative();
  const pb = b.connect();
  await b.posted();
  await b.advance(31000);
  await assert.rejects(pb, (err) => err.info.native.code === 'stalled');
  b.dispose();
});

test('the helper\'s second "scanning" status (the scan really starts, after a permission prompt) restarts the scan deadline', T, async () => {
  const t = setupNative();
  const p = t.connect();
  await t.posted();
  t.bridge.status('scanning', { message: 'waiting for Bluetooth' });
  await t.advance(40000); // the player takes a while at the macOS permission prompt
  t.bridge.status('scanning', { message: 'scanning for a Joy-Con 2' });
  await t.advance(40000); // 80 s after the request, 40 s into the scan: a deadline counted from the first status would have fired at 55 s
  assert.equal(t.provider.status.state, 'requesting');
  await t.advance(16000);
  await assert.rejects(p, (err) => err.info.native.code === 'stalled');
  t.dispose();
});

test('lost link while streaming (helper lost_signal): state lost, code lost_signal, cooldown, NO automatic retry by default; reconnect() after the cooldown works and a failure goes back to lost', T, async () => {
  const { t, p } = await startStreamingHelper();
  deliver(t, REAL_2, 100);
  await p;
  await t.advance(15);
  t.bridge.status('error', { code: 'lost_signal', message: 'the link dropped while streaming' });
  await t.flush();
  const st = t.provider.status;
  assert.equal(st.state, 'lost');
  assert.equal(st.error.code, INPUT_ERROR.LOST_SIGNAL);
  assert.equal(st.error.native.key, 'connect.err.native.lost');
  assert.equal(st.failures, 1);
  assert.equal(st.cooldownUntil, st.error.at + 10000);
  assert.equal(st.trackingOk, false);
  assert.equal(t.rec.errors.at(-1).code, 'lost_signal');
  assert.ok(t.bridge.sources[0].closed);
  await t.advance(5000);
  assert.equal(t.bridge.posts('/connect').length, 1, 'no automatic retry (autoRetry is 0 for the native path)');
  await assert.rejects(t.provider.reconnect(), (err) => err.code === 'cooldown');
  await t.advance(6000);
  const r = t.reconnect();
  await t.posted();
  assert.equal(t.bridge.posts('/connect').length, 2);
  assert.equal(t.provider.status.state, 'connecting', 'a reconnect out of lost is shown as connecting, like the BLE provider');
  t.bridge.status('scanning');
  t.bridge.status('error', { code: 'no_device', message: 'nothing found' });
  await assert.rejects(r);
  assert.equal(t.provider.status.state, 'lost', 'a failed reconnect out of lost goes back to lost, never to error');
  t.dispose();
});

test('helper "disconnected" while streaming, or a helper error like bluetooth_off, is a lost link; the native code is kept', T, async () => {
  for (const [event, nativeCode] of [[{ state: 'disconnected' }, 'lost_signal'], [{ state: 'error', code: 'bluetooth_off', message: 'Bluetooth is turned off' }, 'bluetooth_off']]) {
    const { t, p } = await startStreamingHelper();
    deliver(t, REAL_2, 100);
    await p;
    t.bridge.status(event.state, event);
    await t.flush();
    assert.equal(t.provider.status.state, 'lost');
    assert.equal(t.provider.status.error.code, 'lost_signal');
    assert.equal(t.provider.status.error.native.code, nativeCode);
    t.dispose();
  }
});

test('silence while streaming: no report for 2.5 s is a lost link, the helper is told to disconnect; hidden tab time does not count', T, async () => {
  const { t, p } = await startStreamingHelper();
  deliver(t, REAL_2, 100);
  await p;
  await t.advance(1000);
  deliver(t, synth(764777 + 15000), 1100);
  t.document.setHidden(true);
  await t.advance(10000);
  assert.equal(t.provider.status.state, 'streaming', 'a hidden tab is never declared lost for being silent');
  t.document.setHidden(false);
  await t.advance(3500);
  assert.equal(t.provider.status.state, 'lost');
  assert.equal(t.provider.status.error.code, 'lost_signal');
  assert.equal(t.bridge.posts('/disconnect').length, 1);
  t.dispose();
});

test('the event stream breaking while streaming is a lost link; before streaming it fails the attempt', T, async () => {
  const { t, p } = await startStreamingHelper();
  deliver(t, REAL_2, 100);
  await p;
  t.bridge.source.error();
  await t.flush();
  assert.equal(t.provider.status.state, 'lost');
  assert.equal(t.provider.status.error.native.code, 'lost_signal');
  assert.ok(t.bridge.source.closed);
  t.dispose();

  const u = setupNative();
  const q = u.connect();
  await u.posted();
  u.bridge.status('scanning');
  u.bridge.source.error();
  await assert.rejects(q, (err) => err.info.native.code === 'bridge_unreachable');
  u.dispose();
});

test('autoRetry option: one silent reconnect after the delay, exempt from the short cooldown, at most once', T, async () => {
  const { t, p } = await startStreamingHelper({ provider: { autoRetry: 1 } });
  deliver(t, REAL_2, 100);
  await p;
  t.bridge.status('error', { code: 'lost_signal', message: 'dropped' });
  await t.flush();
  assert.equal(t.provider.status.state, 'lost');
  await t.advance(INPUT_CONFIG.autoReconnectDelayS * 1000 + 50);
  assert.equal(t.bridge.posts('/connect').length, 2, 'one automatic attempt');
  t.bridge.status('scanning');
  t.bridge.status('error', { code: 'no_device', message: 'nothing' });
  await t.flush();
  await t.advance(10000);
  assert.equal(t.bridge.posts('/connect').length, 2, 'never a second automatic attempt');
  t.dispose();
});

// ------------------------------------------------------------------------------------------------ disconnect, vibrate, lifecycle

test('disconnect() during the attempt: connect() rejects with cancelled, the state is idle, the stream is closed, the helper is told', T, async () => {
  const t = setupNative();
  const p = t.connect();
  await t.posted();
  t.bridge.status('scanning');
  t.bridge.status('connecting', { side: 'R' });
  await t.provider.disconnect();
  await assert.rejects(p, (err) => err.code === 'cancelled');
  assert.equal(t.provider.status.state, 'idle');
  assert.equal(t.provider.status.error, null);
  assert.equal(t.bridge.posts('/disconnect').length, 1);
  assert.ok(t.bridge.sources[0].closed);
  assert.equal(t.provider.status.cooldownUntil, null, 'a cancel never starts a cooldown');
  // events that still arrive from the cancelled attempt are ignored
  t.bridge.status('streaming');
  await t.flush();
  assert.equal(t.provider.status.state, 'idle');
  t.dispose();
});

test('disconnect() while the connect request is still open tells the bridge (which cancels the start), and never throws when idle', T, async () => {
  let open;
  const gate = new Promise((resolve) => { open = resolve; });
  const t = setupNative({ bridge: { connectGate: gate } });
  const p = t.connect();
  for (let i = 0; i < 100 && t.bridge.posts('/connect').length === 0; i++) await t.flush();
  await t.provider.disconnect();
  assert.equal(t.bridge.posts('/disconnect').length, 1);
  await assert.rejects(p, (err) => err.code === 'cancelled');
  open();
  await t.flush();
  assert.equal(t.provider.status.state, 'idle');
  // idle: nothing to tear down, nothing is sent
  const before = t.bridge.calls.length;
  await t.provider.disconnect();
  assert.equal(t.bridge.calls.length, before);
  t.dispose();
});

test('disconnect() from streaming: idle, helper told, no further samples', T, async () => {
  const { t, p } = await startStreamingHelper();
  deliver(t, REAL_2, 100);
  await p;
  await t.provider.disconnect();
  assert.equal(t.provider.status.state, 'idle');
  assert.equal(t.bridge.posts('/disconnect').length, 1);
  const n = t.rec.samples.length;
  deliver(t, synth(764777 + 15000), 115);
  await t.flush();
  assert.equal(t.rec.samples.length, n);
  t.dispose();
});

test('pagehide disconnects with a request that outlives the page (keepalive), a hidden page only logs', T, async () => {
  const { t, p } = await startStreamingHelper();
  deliver(t, REAL_2, 100);
  await p;
  t.document.setHidden(true);
  assert.ok(t.rec.logs.some((l) => l.level === 'warn' && /hidden/.test(l.message)));
  t.document.setHidden(false);
  t.page.dispatchEvent(new Event('pagehide'));
  await t.flush();
  assert.equal(t.provider.status.state, 'idle');
  const post = t.bridge.posts('/disconnect');
  assert.equal(post.length, 1);
  assert.equal(post[0].keepalive, true);
  t.dispose();
});

test('dispose() disconnects, removes the page listeners and every provider listener', T, async () => {
  const { t, p } = await startStreamingHelper();
  deliver(t, REAL_2, 100);
  await p;
  const seen = [];
  t.provider.on('status', (s) => seen.push(s.state));
  t.provider.dispose();
  assert.equal(t.bridge.posts('/disconnect').length, 1);
  t.page.dispatchEvent(new Event('pagehide'));
  await t.flush();
  assert.equal(t.bridge.posts('/disconnect').length, 1, 'the pagehide listener is gone');
  assert.equal(t.timers.pending(), 0, 'no timer left behind');
});

test('vibrate(): only while streaming, at most 10 per second, through POST /rumble with the preset id', T, async () => {
  const { t, p } = await startStreamingHelper();
  t.provider.vibrate(3);
  await t.flush();
  assert.equal(t.bridge.posts('/rumble').length, 0, 'not streaming yet');
  deliver(t, REAL_2, 100);
  await p;
  t.provider.vibrate(3);
  t.provider.vibrate(6);
  await t.flush();
  assert.equal(t.bridge.posts('/rumble').length, 1, 'the second click within 100 ms is dropped');
  await t.advance(120);
  t.provider.vibrate(6);
  await t.flush();
  assert.deepEqual(t.bridge.posts('/rumble').map((c) => c.body), [{ id: 3 }, { id: 6 }]);
  t.dispose();
});

test('setKeepAlive() is applied at the next connect (the helper reads it at the start)', T, async () => {
  const { t, p } = await startStreamingHelper();
  deliver(t, REAL_2, 100);
  await p;
  t.provider.setKeepAlive(false);
  assert.equal(t.provider.getDiagnostics().keepAlive, false);
  await t.provider.disconnect();
  t.connect();
  await t.posted();
  assert.equal(t.bridge.posts('/connect')[1].body.keepAliveHz, 0);
  t.dispose();
});

test('diagnostics: the BLE shape plus a native block, timings from the phases, the packet rate and stream statistics', T, async () => {
  const { t, p } = await startStreamingHelper();
  deliver(t, REAL_1, 100);
  for (let i = 0; i < 40; i++) {
    await t.advance(15);
    deliver(t, i === 0 ? REAL_2 : synth(764777 + i * 15000), 115 + i * 15);
  }
  await p;
  await t.advance(1200);
  const d = t.provider.getDiagnostics();
  assert.equal(d.kind, 'joycon');
  assert.equal(d.transport, 'native-bridge');
  assert.equal(d.side, 'R');
  assert.equal(d.featureMask, 0xb7);
  assert.equal(d.native.phase, 'streaming');
  assert.equal(d.native.helperState, 'streaming');
  assert.deepEqual(d.native.bridge, { available: true, reason: null, built: true, canBuild: false, state: 'idle' });
  assert.ok(d.stream.packets >= 41);
  assert.equal(d.stream.inactive, 1);
  for (const k of ['requestMs', 'connectMs', 'discoveryMs', 'initMs', 'firstReportMs', 'totalMs']) assert.ok(k in d.timings, k);
  assert.ok(Number.isFinite(d.timings.totalMs));
  t.dispose();
});

// ------------------------------------------------------------------------------------------------ the tables

test('the error table: every entry uses an existing InputErrorInfo code and a NEW connect.err.native.* key; every new key is listed', T, () => {
  const codes = new Set(Object.values(INPUT_ERROR));
  for (const [bridgeCode, m] of Object.entries(NATIVE_ERRORS)) {
    assert.ok(codes.has(m.input), `${bridgeCode}: ${m.input}`);
    assert.match(m.key, /^connect\.err\.native\.[A-Za-z]+$/, bridgeCode);
    assert.equal(typeof m.count, 'boolean');
  }
  for (const key of Object.values(NATIVE_PROGRESS_KEYS)) assert.match(key, /^connect\.native\.progress\.[A-Za-z]+$/);
  assert.deepEqual([...NATIVE_STRING_KEYS].sort(), [...new Set([...Object.values(NATIVE_ERRORS).map((e) => e.key), ...Object.values(NATIVE_PROGRESS_KEYS)])].sort());
  assert.equal(describeNativeError('something-new'), NATIVE_ERRORS.unknown);
  // only failures that involved the controller start the cooldown
  const counting = Object.entries(NATIVE_ERRORS).filter(([, m]) => m.count).map(([k]) => k).sort();
  assert.deepEqual(counting, ['connect_failed', 'gatt_failure', 'lost_signal', 'no_data', 'stalled']);
  assert.ok(Object.isFrozen(NATIVE_ERRORS));
});

test('the provider never needs a global fetch or EventSource when they are injected, and its module has no Node or browser-global dependency at import time', T, async () => {
  const src = (await import('node:fs')).readFileSync(new URL('../../public/js/input/native-provider.js', import.meta.url), 'utf8');
  const link = (await import('node:fs')).readFileSync(new URL('../../public/js/input/native-link.js', import.meta.url), 'utf8');
  for (const code of [src, link]) {
    assert.doesNotMatch(code, /from 'node:/);
    assert.doesNotMatch(code.replace(/\/\/.*$/gm, ''), /\bperformance\.now\b|\bDate\.now\b|\bMath\.random\b|\blocalStorage\b/);
  }
  // only the allowed imports of the input module
  for (const m of (src + link).matchAll(/from '(\.[^']+)'/g)) assert.match(m[1], /^\.\.?\/(?:shared\/|[a-z0-9-]+\.js$)/);
  void createFakePageBridge;
});
