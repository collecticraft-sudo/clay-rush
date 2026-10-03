// The whole chain, every part real except the two ends: native provider (real parser and report stream) -> fetch and an EventSource client
// over real HTTP -> server.js -> bridge/manager.js -> the FAKE helper (a separate process speaking the real protocol). The helper replays
// the REAL captures REAL_R_1 and REAL_R_2. A green test proves the software chain; the real CoreBluetooth helper and a real Joy-Con are
// UNVERIFIED-ON-HARDWARE.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startBridgeServer, sleep, waitFor, alive } from '../../test-support/bridge/server-harness.js';
import { createNodeEventSource } from '../../test-support/bridge/node-event-source.js';
import { createNativeProvider } from '../../public/js/input/native-provider.js';
import { createRealClock } from '../../public/js/shared/clock.js';
import { assertValid } from '../../public/js/shared/validate.js';

const T = { timeout: 30000 };

function page(b, { origin = b.origin } = {}) {
  const fetchWithOrigin = (url, init = {}) => fetch(url, { ...init, headers: { ...(init.headers ?? {}), Origin: origin } });
  const provider = createNativeProvider({
    clock: createRealClock(), baseUrl: b.origin, fetch: fetchWithOrigin, EventSource: createNodeEventSource({ headers: { Origin: origin } }),
    document: null, pageTarget: null, strictTransitions: true,
  });
  const rec = { samples: [], status: [], errors: [], packets: [], bridge: [] };
  provider.on('sample', (s) => rec.samples.push(s));
  provider.on('status', (s) => rec.status.push(s));
  provider.on('error', (e) => rec.errors.push(e));
  provider.on('packet', (p) => rec.packets.push(p));
  provider.on('bridge', (p) => rec.bridge.push(p));
  return { provider, rec };
}

test('end to end: connect through the real server and the fake helper, REAL_R_1 gives no sample, REAL_R_2 gives |a| about 0.99 g, then motion; disconnect stops it all', T, async () => {
  const b = await startBridgeServer({});
  const { provider, rec } = page(b);
  try {
    await provider.connect({ side: 'R' });
    assert.equal(provider.status.state, 'streaming');
    assert.equal(provider.status.side, 'R');
    assert.equal(provider.status.featureMask, 0xb7);
    assert.ok(await waitFor(() => rec.samples.length >= 8, 4000));
    // the first packet is REAL_R_1: the IMU bytes are still zero, so it is a packet but not a sample
    assert.equal(rec.packets[0].report.imuActive, false);
    assert.equal(rec.packets[1].report.imuActive, true);
    const first = rec.samples[0];
    assertValid('ImuSample', first);
    const mag = Math.hypot(first.accel.x, first.accel.y, first.accel.z);
    assert.ok(Math.abs(mag - 0.99) < 0.01, `|a| = ${mag}`);
    assert.deepEqual(first.accel, { x: -607 / 4096, y: -698 / 4096, z: 3964 / 4096 });
    assert.equal(first.batteryMv, 3435);
    // dt from the IMU timestamps (the helper steps them by 15 ms)
    assert.ok(rec.samples.slice(1, 8).every((s) => s.dtMs === 15 && s.dtSource === 'device'));
    assert.deepEqual(rec.bridge.map((x) => x.phase).slice(0, 3), ['checking', 'starting', 'waitingBluetooth']);
    assert.deepEqual(b.commands().find((c) => c.cmd === 'connect'), { cmd: 'connect', side: 'R', scanSeconds: 45 });
    for (const s of rec.status) assertValid('InputStatus', s);

    provider.vibrate(3);
    assert.ok(await waitFor(() => b.log().some((e) => e.event === 'rumble' && e.id === 3), 3000));

    await provider.disconnect();
    assert.equal(provider.status.state, 'idle');
    assert.ok(await waitFor(() => b.commands().some((c) => c.cmd === 'disconnect'), 3000), 'the helper was told to disconnect');
    const n = rec.samples.length;
    await sleep(100);
    assert.equal(rec.samples.length, n, 'no sample after disconnect');
  } finally {
    provider.dispose();
    await b.cleanup();
  }
});

test('end to end: a helper that reports a denied permission ends the attempt with permission_denied and no cooldown', T, async () => {
  const b = await startBridgeServer({ scenario: 'permission' });
  const { provider } = page(b);
  try {
    await assert.rejects(provider.connect(), (err) => err.code === 'permission_denied' && err.info.native.key === 'connect.err.native.permission');
    assert.equal(provider.status.cooldownUntil, null);
    assert.equal(provider.status.state, 'error');
  } finally {
    provider.dispose();
    await b.cleanup();
  }
});

test('end to end: a helper crash with exit code 134 reaches the page as permission_denied (the macOS Bluetooth permission abort)', T, async () => {
  const b = await startBridgeServer({ scenario: 'crash134' });
  const { provider } = page(b);
  try {
    await assert.rejects(provider.connect(), (err) => err.info.native.code === 'bluetooth_permission');
    assert.equal(provider.status.error.code, 'permission_denied');
  } finally {
    provider.dispose();
    await b.cleanup();
  }
});

test('end to end: any other crash reaches the page as helper_crashed; nothing found as no_device; a lost link while streaming as lost', T, async () => {
  for (const [scenario, expect] of [['crash1', 'helper_crashed'], ['no_device', 'no_device']]) {
    const b = await startBridgeServer({ scenario });
    const { provider } = page(b);
    try {
      await assert.rejects(provider.connect(), (err) => err.info.native.code === expect, scenario);
    } finally {
      provider.dispose();
      await b.cleanup();
    }
  }
  const b = await startBridgeServer({ scenario: 'lost', env: { FAKE_HELPER_REPORTS: '12' } });
  const { provider, rec } = page(b);
  try {
    await provider.connect();
    assert.ok(await waitFor(() => provider.status.state === 'lost', 4000));
    assert.equal(provider.status.error.code, 'lost_signal');
    assert.ok(rec.samples.length >= 8);
  } finally {
    provider.dispose();
    await b.cleanup();
  }
});

test('end to end: the server refuses a page with a foreign origin (403) and the provider reports it as refused, without starting anything', T, async () => {
  const b = await startBridgeServer({});
  const { provider } = page(b, { origin: 'https://evil.example' });
  try {
    await assert.rejects(provider.connect(), (err) => err.info.native.code === 'bridge_refused');
    assert.deepEqual(b.log(), [], 'the helper was never started');
  } finally {
    provider.dispose();
    await b.cleanup();
  }
});

test('end to end: two pages at the same time: the second is told the bridge is busy and does not disturb the first', T, async () => {
  const b = await startBridgeServer({});
  const one = page(b);
  const two = page(b);
  try {
    await one.provider.connect();
    await assert.rejects(two.provider.connect(), (err) => err.info.native.code === 'bridge_busy');
    assert.equal(one.provider.status.state, 'streaming');
    const n = one.rec.samples.length;
    await sleep(120);
    assert.ok(one.rec.samples.length > n, 'the first page keeps streaming');
    assert.equal(two.provider.status.cooldownUntil, null);
    assert.equal(b.commands().filter((c) => c.cmd === 'disconnect').length, 0, 'the failed attempt of the second page disconnected nothing');
  } finally {
    one.provider.dispose();
    two.provider.dispose();
    await b.cleanup();
  }
});

test('end to end: a page that disappears without a disconnect does not keep the Joy-Con connected (server grace period)', T, async () => {
  const b = await startBridgeServer({ bridge: { idleDisconnectMs: 150 } });
  const Base = createNodeEventSource({ headers: { Origin: b.origin } });
  const streams = [];
  class Recording extends Base {
    constructor(url) {
      super(url);
      streams.push(this);
    }
  }
  const provider = createNativeProvider({ clock: createRealClock(), baseUrl: b.origin, fetch, EventSource: Recording, document: null, pageTarget: null });
  try {
    await provider.connect();
    assert.equal(provider.status.state, 'streaming');
    // a crashed tab: its event stream just vanishes, no POST /disconnect is ever sent
    streams[0].req.destroy();
    assert.ok(await waitFor(() => b.commands().some((c) => c.cmd === 'disconnect'), 3000), 'the server told the helper to let go of the Joy-Con');
  } finally {
    provider.dispose();
    await b.cleanup();
  }
  assert.ok(!alive(b.pids()[0]), 'and the helper is gone with the server');
});
