// Status store, state guard, cooldown and battery bands (docs/architecture.md 5.3, A-14, A-15).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createStatusStore, canTransition, TRANSITIONS, cooldownIntervalS, batteryLevel, makeErrorInfo, errorFromInfo, COOLDOWN_CODES,
} from '../../public/js/input/status.js';
import { CONN_STATE, INPUT_ERROR } from '../../public/js/shared/contracts.js';
import { INPUT_CONFIG } from '../../public/js/input/input-config.js';
import { assertValid } from '../../public/js/shared/validate.js';
import { createManualClock } from '../../public/js/shared/clock.js';

const clock = createManualClock(0);

test('cooldown: 10 s, then 180 s from the third consecutive failure (UNVERIFIED-ON-HARDWARE, UOH-11)', () => {
  assert.equal(cooldownIntervalS(0), 10);
  assert.equal(cooldownIntervalS(1), 10);
  assert.equal(cooldownIntervalS(2), 10);
  assert.equal(cooldownIntervalS(3), 180);
  assert.equal(cooldownIntervalS(9), 180);
  assert.equal(INPUT_CONFIG.connect.cooldownS, INPUT_CONFIG.cooldownS, 'the design block and the flat constants agree');
  assert.equal(INPUT_CONFIG.connect.autoReconnectDelayS, INPUT_CONFIG.autoReconnectDelayS);
  assert.equal(INPUT_CONFIG.connect.autoReconnectAttempts, INPUT_CONFIG.autoReconnectAttempts);
});

test('cancelled and unsupported_browser never start a cooldown; connection failures and lost links do', () => {
  assert.ok(!COOLDOWN_CODES.includes(INPUT_ERROR.CANCELLED));
  assert.ok(!COOLDOWN_CODES.includes(INPUT_ERROR.UNSUPPORTED_BROWSER));
  assert.ok(!COOLDOWN_CODES.includes(INPUT_ERROR.PERMISSION_DENIED));
  assert.ok(!COOLDOWN_CODES.includes(INPUT_ERROR.COOLDOWN));
  for (const code of [INPUT_ERROR.GATT_FAILURE, INPUT_ERROR.NO_DATA, INPUT_ERROR.NOT_JOYCON, INPUT_ERROR.LOST_SIGNAL]) assert.ok(COOLDOWN_CODES.includes(code));
});

test('battery bands: ok >= 3550 mV, low 3300-3549, critical < 3300, unknown without a packet (no percentage, A-15)', () => {
  assert.equal(batteryLevel(4200), 'ok');
  assert.equal(batteryLevel(3550), 'ok');
  assert.equal(batteryLevel(3549), 'low');
  assert.equal(batteryLevel(3300), 'low');
  assert.equal(batteryLevel(3299), 'critical');
  assert.equal(batteryLevel(null), 'unknown');
  assert.equal(batteryLevel(undefined), 'unknown');
  assert.equal(batteryLevel(0), 'unknown');
  assert.equal(batteryLevel(NaN), 'unknown');
});

test('the transition guard knows every row of the state table of architecture 5.3', () => {
  const S = CONN_STATE;
  const allowed = [
    [S.IDLE, S.REQUESTING], [S.ERROR, S.REQUESTING], [S.LOST, S.REQUESTING],
    [S.REQUESTING, S.CONNECTING], [S.REQUESTING, S.IDLE], [S.CONNECTING, S.INITIALIZING], [S.CONNECTING, S.ERROR],
    [S.INITIALIZING, S.STREAMING], [S.INITIALIZING, S.ERROR], [S.STREAMING, S.LOST], [S.LOST, S.CONNECTING], [S.CONNECTING, S.LOST],
    [S.STREAMING, S.IDLE], [S.CONNECTING, S.IDLE], [S.LOST, S.IDLE], [S.ERROR, S.IDLE], [S.IDLE, S.STREAMING], [S.IDLE, S.ERROR],
  ];
  for (const [from, to] of allowed) assert.ok(canTransition(from, to), `${from} -> ${to}`);
  const forbidden = [
    [S.STREAMING, S.REQUESTING], [S.STREAMING, S.CONNECTING], [S.STREAMING, S.ERROR], [S.IDLE, S.INITIALIZING], [S.IDLE, S.LOST],
    [S.REQUESTING, S.STREAMING], [S.ERROR, S.STREAMING], [S.ERROR, S.LOST], [S.REQUESTING, S.INITIALIZING], [S.LOST, S.INITIALIZING],
  ];
  for (const [from, to] of forbidden) assert.ok(!canTransition(from, to), `${from} -> ${to} must be illegal`);
  assert.ok(canTransition(S.STREAMING, S.STREAMING), 'staying put is always fine');
  assert.deepEqual(Object.keys(TRANSITIONS).sort(), Object.values(S).sort());
});

test('status store: immutable objects, a new one per change, events only for meaningful changes', () => {
  const emitted = [];
  const store = createStatusStore({ kind: 'joycon', clock, emit: (s) => emitted.push(s) });
  const first = store.get();
  assert.ok(Object.isFrozen(first));
  assert.ok(Object.isFrozen(first.battery));
  assertValid('InputStatus', first);
  assert.equal(first.state, 'idle');
  assert.equal(first.battery.level, 'unknown');
  assert.equal(first.battery.pct, null);

  const s1 = store.transition('requesting', {});
  assert.notEqual(s1, first);
  assert.equal(first.state, 'idle', 'the old object never changes');
  assert.equal(emitted.length, 1);

  store.patch({ side: 'L' });
  assert.equal(emitted.length, 2);
  store.patch({ side: 'L' });
  assert.equal(emitted.length, 2, 'no event when nothing changed');

  // hot path values do not emit
  store.setLive(123, 3700);
  assert.equal(emitted.length, 2);
  assert.equal(store.get().lastPacketAt, 123);
  assert.equal(store.get().battery.mv, 3700);
  assert.equal(store.get().battery.level, 'unknown', 'the band only moves through refreshBattery');
  assert.equal(emitted.length, 2);

  store.refreshBattery(3700);
  assert.equal(emitted.length, 3);
  assert.equal(store.get().battery.level, 'ok');
  store.refreshBattery(3690);
  assert.equal(emitted.length, 3, 'a millivolt change inside the band is not an event');
  assert.equal(store.get().battery.mv, 3690);
  store.refreshBattery(3400);
  assert.equal(emitted.length, 4);
  assert.equal(store.get().battery.level, 'low');
  assert.equal(store.get().battery.pct, null);
  assert.equal(store.state(), 'requesting');
  assert.equal(store.batteryLevel(), 'low');
  for (const s of emitted) assertValid('InputStatus', s);
});

test('status store: the error field is compared by content, state error requires an error', () => {
  const emitted = [];
  const store = createStatusStore({ kind: 'joycon', clock, emit: (s) => emitted.push(s) });
  const info = makeErrorInfo(INPUT_ERROR.GATT_FAILURE, 'boom', 5);
  store.patch({ error: info });
  store.patch({ error: makeErrorInfo(INPUT_ERROR.GATT_FAILURE, 'boom', 5) });
  assert.equal(emitted.length, 1);
  store.patch({ error: makeErrorInfo(INPUT_ERROR.GATT_FAILURE, 'boom', 6) });
  assert.equal(emitted.length, 2);
  assert.match(JSON.stringify(assertValidCatch({ ...store.get(), state: 'error', error: null })), /requires error/);
});

function assertValidCatch(status) {
  try {
    assertValid('InputStatus', status);
    return 'valid';
  } catch (e) {
    return e.message;
  }
}

test('status store: strict mode throws on an illegal transition, lenient mode logs and applies it', () => {
  const logs = [];
  const strict = createStatusStore({ kind: 'joycon', clock, strict: true, log: (l, m) => logs.push(m) });
  assert.throws(() => strict.transition('streaming-not', {}), /illegal/);
  assert.throws(() => strict.transition('initializing', {}), /illegal connection transition idle -> initializing/);
  const lenient = createStatusStore({ kind: 'joycon', clock, log: (l, m) => logs.push(m) });
  lenient.transition('initializing', {});
  assert.equal(lenient.state(), 'initializing');
  assert.ok(logs.some((m) => /illegal connection transition idle -> initializing/.test(m)));
});

test('cooldownRemainingS rounds up and is 0 outside a cooldown', () => {
  const store = createStatusStore({ kind: 'joycon', clock });
  assert.equal(store.cooldownRemainingS(0), 0);
  store.patch({ cooldownUntil: 10_000 });
  assert.equal(store.cooldownRemainingS(0), 10);
  assert.equal(store.cooldownRemainingS(9_001), 1);
  assert.equal(store.cooldownRemainingS(10_000), 0);
});

test('error info: retryable is false only for unsupported_browser; errorFromInfo carries code and info', () => {
  for (const code of Object.values(INPUT_ERROR)) {
    const info = makeErrorInfo(code, 'm', 1);
    assert.equal(info.retryable, code !== 'unsupported_browser');
    assert.ok(Object.isFrozen(info));
    const err = errorFromInfo(info);
    assert.ok(err instanceof Error);
    assert.equal(err.code, code);
    assert.equal(err.info, info);
    assert.equal(err.message, 'm');
  }
});
