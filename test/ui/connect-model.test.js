// connect-model.js (reused from the forked game): what the connect screen shows for each provider state, both layouts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { batteryText, deriveConnectModel, errorText, nativeProgress, sideText } from '../../public/js/ui/connect-model.js';
import { makeStatus, nativeError } from '../../test-support/ui/connect-fixtures.js';

const jc = (state, over = {}, transport = 'bluetooth') => ({ kind: 'joycon', transport, status: makeStatus({ state, ...over }) });

test('legacy layout: idle, busy, connected, cooldown, unsupported, closed chooser', () => {
  assert.equal(deriveConnectModel(null, 0).mode, 'idle');
  assert.equal(deriveConnectModel(null, 0).buttonText, 'CONNECT JOY-CON');
  assert.equal(deriveConnectModel(jc('requesting'), 0).pillText, 'Searching…');
  const c = deriveConnectModel(jc('streaming', { side: 'L', battery: { mv: 3700, level: 'ok', pct: null } }), 0);
  assert.equal(c.showContinue, true);
  assert.match(c.pillText, /Connected: Joy-Con \(left\)/);
  const cd = deriveConnectModel(jc('error', { cooldownUntil: 5000, error: { code: 'cooldown', message: 'm', retryable: true, at: 0 } }), 1000);
  assert.equal(cd.mode, 'cooldown');
  assert.equal(cd.buttonEnabled, false);
  assert.equal(cd.cooldownS, 4);
  assert.equal(deriveConnectModel(null, 0, { hasBluetooth: false }).mode, 'unsupported');
  const ch = deriveConnectModel(jc('idle', { error: { code: 'cancelled', message: 'm', retryable: true, at: 0 } }), 0);
  assert.equal(ch.showFallback, true);
  assert.ok(ch.hintText.length > 0);
});

test('native layout: the bridge is primary, busy shows progress, countdown and cancel; its own error texts win', () => {
  const opts = { bridge: { probe: 'available' } };
  const idle = deriveConnectModel(null, 0, opts);
  assert.equal(idle.native, true);
  assert.equal(idle.primary, 'native');
  assert.equal(idle.stepTexts.length, 4);
  assert.equal(idle.secondary.show, true);
  const busy = deriveConnectModel(jc('connecting', {}, 'native'), 10000, { ...opts, progress: { phase: 'scanning', key: 'connect.native.progress.scanning', scanStartedAt: 0, scanSeconds: 45 } });
  assert.equal(busy.cancel, true);
  assert.equal(busy.countdownS, 35);
  const err = jc('error', { error: nativeError('gatt_failure', 'no_device', 'connect.err.native.noDevice') }, 'native');
  assert.match(errorText(err.status, 0), /No Joy-Con found/);
  assert.equal(nativeProgress(null, 0).phase, 'checking');
});

test('side and battery texts', () => {
  assert.equal(sideText('R'), 'right');
  assert.equal(sideText('?'), 'side unknown');
  assert.equal(batteryText({ pct: 51.4 }), 'Battery: 51%');
  assert.equal(batteryText({ level: 'low' }), 'Battery: low');
  assert.equal(batteryText(null), 'Battery: not available');
});
