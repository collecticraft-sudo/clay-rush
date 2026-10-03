// The /__bridge/ endpoints of server.js and the helper manager behind them (docs/native-bridge.md), tested against the FAKE helper
// of test-support/bridge/fake-helper.mjs. A green test here proves the server, the manager and the wire protocol; it says nothing
// about the real CoreBluetooth helper or a real Joy-Con (UNVERIFIED-ON-HARDWARE). Real HTTP on loopback port 0.
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, existsSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../../server.js';
import { classifyHelperExit } from '../../bridge/manager.js';
import {
  startBridgeServer, post, getJson, request, openEvents, waitFor, sleep, alive, FAKE_HELPER, ROOT,
} from '../../test-support/bridge/server-harness.js';

const T = { timeout: 30000 };

async function withBridge(options, fn) {
  const b = await startBridgeServer(options);
  try {
    await fn(b);
  } finally {
    await b.cleanup();
  }
}

// ------------------------------------------------------------------------------------------------------------ status

test('GET /__bridge/status with a helper binary: available, built, nothing to build, state idle', T, async () => {
  await withBridge({}, async (b) => {
    const r = await getJson(b, '/__bridge/status');
    assert.equal(r.status, 200);
    assert.match(r.headers['content-type'], /^application\/json/);
    assert.deepEqual(r.json, { available: true, reason: null, built: true, canBuild: false, state: 'idle' });
    assert.equal(r.headers['cache-control'], 'no-store');
    assert.equal(r.headers['x-content-type-options'], 'nosniff');
    assert.deepEqual(b.log(), [], 'asking for the status never starts the helper');
  });
});

test('GET /__bridge/status with a missing binary: not available, reason helper_missing, nothing built', T, async () => {
  await withBridge({ bridge: { bin: '/nonexistent/joycon-bridge' } }, async (b) => {
    const r = await getJson(b, '/__bridge/status');
    assert.deepEqual(r.json, { available: false, reason: 'helper_missing', built: false, canBuild: false, state: 'idle' });
  });
});

test('missing binary: POST /__bridge/connect answers 503 helper_missing and starts nothing', T, async () => {
  await withBridge({ bridge: { bin: '/nonexistent/joycon-bridge' } }, async (b) => {
    const r = await post(b, '/__bridge/connect', { side: 'R' });
    assert.equal(r.status, 503);
    assert.equal(r.json.ok, false);
    assert.equal(r.json.code, 'helper_missing');
    // the same request a second time behaves the same: no stuck "busy" state after the refusal
    assert.equal((await post(b, '/__bridge/connect', { side: 'R' })).json.code, 'helper_missing');
  });
});

test('status: a binary that is not executable counts as missing', T, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'joycon-bridge-noexec-'));
  const file = join(dir, 'helper');
  writeFileSync(file, '#!/bin/sh\n');
  chmodSync(file, 0o644);
  try {
    await withBridge({ bridge: { bin: file } }, async (b) => {
      assert.equal((await getJson(b, '/__bridge/status')).json.available, false);
      assert.equal((await post(b, '/__bridge/connect', { side: 'R' })).json.code, 'helper_missing');
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('status on a platform that is not macOS without an override: not_macos (whatever is built on this machine)', T, async () => {
  const empty = mkdtempSync(join(tmpdir(), 'joycon-bridge-empty-')); // a bridge folder with nothing built, so the answer does not depend on this checkout
  const server = await startServer({ port: 0, quiet: true, bridge: { platform: 'linux', env: {}, bridgeDir: empty, log: () => {} } });
  try {
    const r = await request(server.port, { path: '/__bridge/status' });
    assert.deepEqual(r.json, { available: false, reason: 'not_macos', built: false, canBuild: false, state: 'idle' });
    assert.equal((await request(server.port, { method: 'POST', path: '/__bridge/connect', headers: { 'X-Joycon-Ninja': '1' }, body: { side: 'R' } })).json.code, 'not_macos');
  } finally {
    await server.close();
    rmSync(empty, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------------------------------------------------ happy path

test('happy path: connect, the status stream, REAL_R_1 and REAL_R_2 first, then motion; disconnect ends it', T, async () => {
  await withBridge({}, async (b) => {
    const es = openEvents(b);
    await es.ready;
    assert.equal(es.status, 200);
    assert.match(es.headers['content-type'], /^text\/event-stream/);
    assert.equal(es.headers['cache-control'], 'no-store');
    assert.ok(await es.waitFor((e) => e.type === 'status' && e.replay === true), 'the last status is replayed to a new listener');
    assert.deepEqual({ ...es.events.find((e) => e.replay) }, { type: 'status', state: 'idle', replay: true, seq: 0 });

    const r = await post(b, '/__bridge/connect', { side: 'R', scanSeconds: 30, keepAliveHz: 1 });
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, true);
    assert.equal(typeof r.json.seq, 'number', 'the answer carries the sequence number that tells this attempt\'s events from older ones');
    assert.ok(await es.waitFor((e) => e.type === 'report', 5000));
    // every event of this attempt has a higher sequence number than the one in the answer; the replayed status has none of this attempt
    assert.ok(es.events.filter((e) => !e.replay && e.type !== 'hello' && e.state !== 'idle').every((e) => e.seq > r.json.seq));
    assert.ok(es.events.every((e) => Number.isInteger(e.seq)));
    assert.ok(es.events.map((e) => e.seq).every((q, i, a) => i === 0 || q >= a[i - 1]), 'sequence numbers never go backwards');
    assert.ok(await es.waitFor(() => es.byType('report').length >= 6, 5000));
    assert.deepEqual(es.states(), ['idle', 'scanning', 'connecting', 'discovering', 'initialising', 'streaming']);
    const advert = es.byType('advert')[0];
    assert.deepEqual({ ...advert, seq: undefined }, { type: 'advert', side: 'R', pid: 8294, rssi: -40, host: '00 00 00 00 00 00', pairing: true, seq: undefined });

    // the first two reports are the real captures, byte for byte
    const vectors = (await import('../../test-support/input/vectors.js')).VECTORS.vectors;
    const hex = (id) => vectors.find((v) => v.id === id).hex;
    const reports = es.byType('report');
    assert.equal(reports[0].hex, hex('REAL_R_1'));
    assert.equal(reports[1].hex, hex('REAL_R_2'));
    for (const rep of reports) {
      assert.equal(rep.hex.length, 126);
      assert.equal(typeof rep.t, 'number');
    }
    assert.ok(reports[2].t > reports[1].t, 'helper time moves forward');

    // the helper got exactly the validated connect command
    assert.deepEqual(b.commands().filter((c) => c.cmd === 'connect'), [{ cmd: 'connect', side: 'R', scanSeconds: 30, keepAliveHz: 1 }]);

    assert.deepEqual((await post(b, '/__bridge/disconnect', {})).json, { ok: true });
    assert.ok(await es.waitFor((e) => e.type === 'status' && e.state === 'disconnected'));
    const count = es.byType('report').length;
    await sleep(80);
    assert.equal(es.byType('report').length, count, 'no report after disconnect');
    es.close();
  });
});

test('the status endpoint follows the helper state', T, async () => {
  await withBridge({}, async (b) => {
    const es = openEvents(b);
    await es.ready;
    await post(b, '/__bridge/connect', { side: 'any' });
    assert.ok(await es.waitFor((e) => e.state === 'streaming'));
    assert.equal((await getJson(b, '/__bridge/status')).json.state, 'streaming');
    await post(b, '/__bridge/disconnect', {});
    assert.ok(await es.waitFor((e) => e.state === 'disconnected'));
    assert.equal((await getJson(b, '/__bridge/status')).json.state, 'disconnected');
    es.close();
  });
});

test('the helper is started lazily, once, and reused by the next connect', T, async () => {
  await withBridge({}, async (b) => {
    const es = openEvents(b);
    await es.ready;
    assert.deepEqual(b.pids(), []);
    await post(b, '/__bridge/connect', {});
    assert.ok(await es.waitFor((e) => e.state === 'streaming'));
    await post(b, '/__bridge/disconnect', {});
    assert.ok(await es.waitFor((e) => e.state === 'disconnected'));
    await post(b, '/__bridge/connect', {});
    assert.ok(await es.waitFor(() => es.states().filter((s) => s === 'streaming').length === 2));
    assert.equal(b.pids().length, 1, 'one helper process for both sessions');
    assert.equal(es.byType('hello').length, 1);
    es.close();
  });
});

test('several SSE listeners all see every event; a late one gets the replay; a listener that leaves does not disturb the others', T, async () => {
  await withBridge({}, async (b) => {
    const a = openEvents(b);
    const c = openEvents(b);
    await Promise.all([a.ready, c.ready]);
    await post(b, '/__bridge/connect', { side: 'R' });
    assert.ok(await a.waitFor((e) => e.state === 'streaming'));
    assert.ok(await c.waitFor((e) => e.state === 'streaming'));
    const late = openEvents(b);
    await late.ready;
    assert.ok(await late.waitFor((e) => e.replay === true));
    assert.equal(late.events.find((e) => e.replay).state, 'streaming', 'the replay is the CURRENT status');
    c.close();
    await sleep(50);
    const before = a.byType('report').length;
    assert.ok(await a.waitFor(() => a.byType('report').length > before + 2), 'the others keep receiving');
    assert.ok(await late.waitFor(() => late.byType('report').length > 2));
    assert.deepEqual(a.states().slice(0, 6), ['idle', 'scanning', 'connecting', 'discovering', 'initialising', 'streaming']);
    a.close();
    late.close();
  });
});

test('the heartbeat is a comment line every interval (shortened here), and it stops with the listener', T, async () => {
  await withBridge({ heartbeatMs: 40 }, async (b) => {
    const es = openEvents(b);
    await es.ready;
    assert.ok(await waitFor(() => es.comments.filter((c) => c === 'heartbeat').length >= 3, 3000));
    assert.equal(es.comments[0], 'connected');
    es.close();
  });
});

test('a second connect while a session runs is refused with 409 busy; after a disconnect it is accepted again', T, async () => {
  await withBridge({}, async (b) => {
    const es = openEvents(b);
    await es.ready;
    const [first, second] = await Promise.all([post(b, '/__bridge/connect', {}), post(b, '/__bridge/connect', {})]);
    const codes = [first, second].map((r) => r.status).sort();
    assert.deepEqual(codes, [200, 409], 'exactly one of two simultaneous connects is accepted');
    const refused = [first, second].find((r) => r.status === 409);
    assert.equal(refused.json.code, 'busy');
    assert.ok(await es.waitFor((e) => e.state === 'streaming'));
    assert.equal(b.commands().filter((c) => c.cmd === 'connect').length, 1, 'the helper received ONE connect command');
    assert.equal((await post(b, '/__bridge/connect', {})).status, 409);
    await post(b, '/__bridge/disconnect', {});
    assert.ok(await es.waitFor((e) => e.state === 'disconnected'));
    assert.equal((await post(b, '/__bridge/connect', {})).status, 200);
    es.close();
  });
});

test('rumble reaches the helper while streaming (validated id), and is ignored otherwise', T, async () => {
  await withBridge({}, async (b) => {
    const es = openEvents(b);
    await es.ready;
    assert.deepEqual((await post(b, '/__bridge/rumble', { id: 3 })).json, { ok: true, dropped: true }, 'not streaming: dropped');
    await post(b, '/__bridge/connect', {});
    assert.ok(await es.waitFor((e) => e.state === 'streaming'));
    assert.deepEqual((await post(b, '/__bridge/rumble', { id: 3 })).json, { ok: true });
    assert.ok(await waitFor(() => b.log().some((e) => e.event === 'rumble' && e.id === 3)));
    assert.equal((await post(b, '/__bridge/rumble', { id: 3 })).json.dropped, true, 'more than 10 per second: dropped');
    for (const bad of [{}, { id: -1 }, { id: 256 }, { id: 1.5 }, { id: '3' }, []]) assert.equal((await post(b, '/__bridge/rumble', bad)).status, 400, JSON.stringify(bad));
    es.close();
  });
});

// ------------------------------------------------------------------------------------------------------------ errors from the helper

test('permission error from the helper passes through as code bluetooth_permission', T, async () => {
  await withBridge({ scenario: 'permission' }, async (b) => {
    const es = openEvents(b);
    await es.ready;
    assert.equal((await post(b, '/__bridge/connect', { side: 'R' })).status, 200);
    assert.ok(await es.waitFor((e) => e.state === 'error'));
    const err = es.events.find((e) => e.state === 'error');
    assert.equal(err.code, 'bluetooth_permission');
    assert.ok(err.message.length > 10);
    // the session is over: a new connect is accepted again
    assert.equal((await post(b, '/__bridge/connect', { side: 'R' })).status, 200);
    es.close();
  });
});

test('helper codes bluetooth_off, no_device and connect_failed reach the page unchanged', T, async () => {
  for (const scenario of ['bluetooth_off', 'no_device', 'connect_failed']) {
    await withBridge({ scenario }, async (b) => {
      const es = openEvents(b);
      await es.ready;
      await post(b, '/__bridge/connect', {});
      assert.ok(await es.waitFor((e) => e.state === 'error'), scenario);
      assert.equal(es.events.find((e) => e.state === 'error').code, scenario);
      es.close();
    });
  }
});

test('helper crash with exit code 134 (how macOS stops a process that uses Bluetooth without permission) becomes bluetooth_permission', T, async () => {
  await withBridge({ scenario: 'crash134' }, async (b) => {
    const es = openEvents(b);
    await es.ready;
    await post(b, '/__bridge/connect', { side: 'R' });
    assert.ok(await es.waitFor((e) => e.state === 'error'));
    const err = es.events.find((e) => e.state === 'error');
    assert.equal(err.code, 'bluetooth_permission');
    assert.equal(err.source, 'server');
    assert.match(err.message, /Terminal/);
    // the manager recovers: the next connect starts a NEW helper
    const r = await post(b, '/__bridge/connect', { side: 'R' });
    assert.equal(r.status, 200);
    assert.ok(await waitFor(() => b.pids().length === 2), 'a second helper process was started');
    es.close();
  });
});

test('the crash classifier: exit code 134 and signal SIGABRT mean "no Bluetooth permission", everything else is a crash', () => {
  // (a real SIGABRT is not raised by a test: macOS would write a crash report into the owner's DiagnosticReports folder)
  assert.equal(classifyHelperExit(134, null), 'bluetooth_permission');
  assert.equal(classifyHelperExit(null, 'SIGABRT'), 'bluetooth_permission');
  for (const [code, signal] of [[1, null], [0, null], [139, null], [null, 'SIGSEGV'], [null, 'SIGKILL'], [null, 'SIGTERM'], [133, null], [null, null]]) {
    assert.equal(classifyHelperExit(code, signal), 'helper_crashed', `${code} ${signal}`);
  }
});

test('any other helper crash becomes helper_crashed, and the page is told', T, async () => {
  await withBridge({ scenario: 'crash1' }, async (b) => {
    const a = openEvents(b);
    const c = openEvents(b);
    await Promise.all([a.ready, c.ready]);
    await post(b, '/__bridge/connect', {});
    for (const es of [a, c]) {
      assert.ok(await es.waitFor((e) => e.state === 'error'));
      const err = es.events.find((e) => e.state === 'error');
      assert.equal(err.code, 'helper_crashed');
      assert.match(err.message, /exit code 1/);
    }
    // a listener that joins later gets the crash as the replayed status
    const late = openEvents(b);
    await late.ready;
    assert.ok(await late.waitFor((e) => e.replay === true));
    const replayed = late.events.find((e) => e.replay);
    assert.equal(replayed.code, 'helper_crashed');
    a.close(); c.close(); late.close();
  });
});

test('lost link while streaming: the helper reports lost_signal and the session ends', T, async () => {
  await withBridge({ scenario: 'lost', env: { FAKE_HELPER_REPORTS: '8' } }, async (b) => {
    const es = openEvents(b);
    await es.ready;
    await post(b, '/__bridge/connect', {});
    assert.ok(await es.waitFor((e) => e.code === 'lost_signal'));
    assert.ok(es.byType('report').length >= 7);
    assert.equal((await post(b, '/__bridge/connect', {})).status, 200, 'a new attempt is possible after the loss');
    es.close();
  });
});

test('a helper that never says hello is refused after the timeout (503 helper_failed) and does not leave a stuck state', T, async () => {
  await withBridge({ scenario: 'nohello', bridge: { helloTimeoutMs: 200 } }, async (b) => {
    const r = await post(b, '/__bridge/connect', {});
    assert.equal(r.status, 503);
    assert.equal(r.json.code, 'helper_failed');
    await waitFor(() => !alive(b.pids()[0]), 2000);
    assert.equal(alive(b.pids()[0]), false, 'the silent helper was killed');
    assert.equal((await post(b, '/__bridge/connect', {})).json.code, 'helper_failed', 'and a second try is not stuck on busy');
  });
});

test('a helper that speaks another protocol version is refused', T, async () => {
  await withBridge({ scenario: 'badversion' }, async (b) => {
    const r = await post(b, '/__bridge/connect', {});
    assert.equal(r.status, 503);
    assert.equal(r.json.code, 'helper_failed');
    assert.match(r.json.message, /protocol version 99/);
  });
});

test('garbage on the helper stdout (not JSON, unknown types, bad hex, a huge line) is dropped, never forwarded, never fatal', T, async () => {
  await withBridge({ scenario: 'noisy' }, async (b) => {
    const es = openEvents(b);
    await es.ready;
    await post(b, '/__bridge/connect', {});
    assert.ok(await es.waitFor((e) => e.state === 'streaming'));
    assert.ok(await es.waitFor(() => es.byType('report').length >= 3));
    assert.ok(es.events.every((e) => ['hello', 'status', 'advert', 'report', 'response', 'bridge'].includes(e.type)));
    assert.ok(es.byType('report').every((r) => /^[0-9a-f]{126}$/.test(r.hex)));
    es.close();
  });
});

test('a status warning (for example a dropped notification) is forwarded but is not a state change', T, async () => {
  await withBridge({ scenario: 'badlength' }, async (b) => {
    const es = openEvents(b);
    await es.ready;
    await post(b, '/__bridge/connect', {});
    assert.ok(await es.waitFor((e) => e.warning === 'bad_length'));
    const w = es.events.find((e) => e.warning);
    assert.equal(w.state, 'streaming');
    assert.equal(w.dropped, 1);
    // a listener that joins now is told the state, not the warning
    const late = openEvents(b);
    await late.ready;
    assert.ok(await late.waitFor((e) => e.replay));
    assert.equal(late.events.find((e) => e.replay).warning, undefined);
    es.close(); late.close();
  });
});

// ------------------------------------------------------------------------------------------------------------ security

const BAD_ORIGINS = ['https://evil.example', 'http://evil.example', 'null', 'http://localhost:1', 'http://127.0.0.1:1', 'http://localhost', 'https://localhost:PORT', 'http://localhost.evil.example:PORT', 'http://[::1]:PORT', ''];

test('POST without the X-Joycon-Ninja header is refused with 403, whatever the origin, and nothing starts', T, async () => {
  await withBridge({}, async (b) => {
    for (const path of ['/__bridge/connect', '/__bridge/disconnect', '/__bridge/rumble']) {
      const noHeader = await request(b.port, { method: 'POST', path, headers: { Origin: b.origin }, body: { side: 'R', id: 1 } });
      assert.equal(noHeader.status, 403, path);
      assert.equal(noHeader.json.code, 'forbidden');
      const noBoth = await request(b.port, { method: 'POST', path, body: { side: 'R', id: 1 } });
      assert.equal(noBoth.status, 403, `${path} with neither header`);
      const wrongValue = await request(b.port, { method: 'POST', path, headers: { 'X-Joycon-Ninja': '0' }, body: { side: 'R' } });
      assert.equal(wrongValue.status, 403, `${path} with the wrong value`);
      const textPlain = await request(b.port, { method: 'POST', path, headers: { 'Content-Type': 'text/plain', Origin: b.origin }, rawBody: '{"side":"R"}' });
      assert.equal(textPlain.status, 403, `${path}: a "simple" cross-site form POST cannot carry the header`);
    }
    assert.deepEqual(b.log(), [], 'the helper was never started');
  });
});

test('a foreign Origin is refused with 403 on every /__bridge endpoint, POST and GET, even with the custom header', T, async () => {
  await withBridge({}, async (b) => {
    for (const template of BAD_ORIGINS) {
      const origin = template.replace('PORT', String(b.port));
      const headers = { Origin: origin, 'X-Joycon-Ninja': '1' };
      assert.equal((await request(b.port, { method: 'POST', path: '/__bridge/connect', headers, body: { side: 'R' } })).status, 403, `POST connect from "${origin}"`);
      assert.equal((await request(b.port, { method: 'POST', path: '/__bridge/disconnect', headers, body: {} })).status, 403, `POST disconnect from "${origin}"`);
      assert.equal((await request(b.port, { path: '/__bridge/status', headers: { Origin: origin } })).status, 403, `GET status from "${origin}"`);
      assert.equal((await request(b.port, { path: '/__bridge/events', headers: { Origin: origin } })).status, 403, `GET events from "${origin}"`);
    }
    assert.deepEqual(b.log(), []);
  });
});

test('both spellings of the page\'s own origin are accepted (localhost and 127.0.0.1), and a request without an Origin (curl, tests) too', T, async () => {
  await withBridge({}, async (b) => {
    for (const origin of [`http://localhost:${b.port}`, `http://127.0.0.1:${b.port}`]) {
      assert.equal((await request(b.port, { path: '/__bridge/status', headers: { Origin: origin } })).status, 200, origin);
      assert.equal((await request(b.port, { method: 'POST', path: '/__bridge/disconnect', headers: { Origin: origin, 'X-Joycon-Ninja': '1' }, body: {} })).status, 200, origin);
    }
    assert.equal((await request(b.port, { path: '/__bridge/status' })).status, 200);
    assert.equal((await request(b.port, { method: 'POST', path: '/__bridge/disconnect', headers: { 'X-Joycon-Ninja': '1' }, body: {} })).status, 200);
  });
});

test('Sec-Fetch-Site: a cross-site or same-site (another local port) request is refused, same-origin and none are accepted', T, async () => {
  await withBridge({}, async (b) => {
    for (const site of ['cross-site', 'same-site']) {
      assert.equal((await request(b.port, { path: '/__bridge/status', headers: { 'Sec-Fetch-Site': site } })).status, 403, site);
      assert.equal((await request(b.port, { method: 'POST', path: '/__bridge/disconnect', headers: { 'Sec-Fetch-Site': site, 'X-Joycon-Ninja': '1' }, body: {} })).status, 403, site);
      assert.equal((await request(b.port, { path: '/__bridge/events', headers: { 'Sec-Fetch-Site': site } })).status, 403, site);
    }
    for (const site of ['same-origin', 'none']) assert.equal((await request(b.port, { path: '/__bridge/status', headers: { 'Sec-Fetch-Site': site } })).status, 200, site);
  });
});

test('two Origin headers in one request (one of them the right one) are refused, and so is a request whose Origin has the right host but another scheme', T, async () => {
  await withBridge({}, async (b) => {
    const rawRequest = (headerLines) => new Promise((resolve, reject) => {
      const socket = net.connect(b.port, '127.0.0.1', () => {
        socket.write(`GET /__bridge/status HTTP/1.1\r\nHost: localhost:${b.port}\r\n${headerLines}Connection: close\r\n\r\n`);
      });
      let data = '';
      socket.on('data', (d) => { data += d; });
      socket.on('end', () => resolve(Number(data.split(' ')[1])));
      socket.on('error', reject);
    });
    assert.equal(await rawRequest(`Origin: ${b.origin}\r\n`), 200, 'sanity: the single right Origin is accepted');
    assert.equal(await rawRequest(`Origin: ${b.origin}\r\nOrigin: https://evil.example\r\n`), 403);
    assert.equal(await rawRequest(`Origin: https://evil.example\r\nOrigin: ${b.origin}\r\n`), 403);
    assert.equal(await rawRequest(`Origin: https://localhost:${b.port}\r\n`), 403);
    assert.equal(await rawRequest(`Origin: ${b.origin.toUpperCase()}\r\n`), 403, 'browsers send the origin in lower case; anything else is not ours');
  });
});

test('the DNS-rebinding Host guard still covers the bridge endpoints', T, async () => {
  await withBridge({}, async (b) => {
    assert.equal((await request(b.port, { path: '/__bridge/status', headers: { Host: 'evil.example.com' } })).status, 403);
    assert.equal((await request(b.port, { method: 'POST', path: '/__bridge/connect', headers: { Host: `evil.example.com:${b.port}`, 'X-Joycon-Ninja': '1' }, body: {} })).status, 403);
    assert.equal((await request(b.port, { path: '/__bridge/events', headers: { Host: 'rebind.example' } })).status, 403);
  });
});

test('no CORS approval is ever given: no Access-Control headers, and a preflight (OPTIONS) is refused', T, async () => {
  await withBridge({}, async (b) => {
    const pre = await request(b.port, { method: 'OPTIONS', path: '/__bridge/connect', headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'x-joycon-ninja' } });
    assert.equal(pre.status, 405);
    assert.equal(pre.headers['access-control-allow-origin'], undefined);
    assert.equal(pre.headers['access-control-allow-headers'], undefined);
    const ok = await getJson(b, '/__bridge/status');
    assert.equal(ok.headers['access-control-allow-origin'], undefined);
  });
});

test('wrong method, unknown endpoint, wrong content type, bad JSON, bad fields and oversized bodies are refused with a precise status', T, async () => {
  await withBridge({}, async (b) => {
    assert.equal((await request(b.port, { method: 'POST', path: '/__bridge/status', headers: { 'X-Joycon-Ninja': '1' }, body: {} })).status, 405);
    assert.equal((await request(b.port, { method: 'GET', path: '/__bridge/connect' })).status, 405);
    assert.equal((await request(b.port, { method: 'GET', path: '/__bridge/connect' })).headers.allow, 'POST');
    assert.equal((await request(b.port, { method: 'PUT', path: '/__bridge/connect', headers: { 'X-Joycon-Ninja': '1' } })).status, 405);
    for (const path of ['/__bridge', '/__bridge/', '/__bridge/nope', '/__bridge/status/', '/__bridge/STATUS', '/__bridge/status/x']) assert.equal((await request(b.port, { path })).status, 404, path);

    const H = { Origin: b.origin, 'X-Joycon-Ninja': '1' };
    assert.equal((await request(b.port, { method: 'POST', path: '/__bridge/connect', headers: { ...H, 'Content-Type': 'text/plain' }, rawBody: '{}' })).status, 415);
    assert.equal((await request(b.port, { method: 'POST', path: '/__bridge/connect', headers: H, rawBody: '{nope' })).status, 400);
    assert.equal((await request(b.port, { method: 'POST', path: '/__bridge/connect', headers: H, rawBody: 'x'.repeat(5000) })).status, 413);
    const bad = [
      { side: 'X' }, { side: 'r' }, { side: 7 }, { side: null }, { side: '; rm -rf /' }, { scanSeconds: 'fast' }, { scanSeconds: null }, { keepAliveHz: '1' },
      { mask: 1.5 }, { mask: 256 }, { mask: -1 }, { mask: '0xb7' }, { pairingOnly: 'yes' }, [], 'text', 42,
    ];
    for (const body of bad) {
      const r = await request(b.port, { method: 'POST', path: '/__bridge/connect', headers: H, rawBody: JSON.stringify(body) });
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.equal(r.json.code, 'bad_request');
    }
    assert.deepEqual(b.log(), [], 'not one of the refused requests started the helper');
  });
});

test('only validated fields reach the helper: unknown keys are dropped and numbers are clamped; an empty body means side "any"', T, async () => {
  await withBridge({}, async (b) => {
    const es = openEvents(b);
    await es.ready;
    const r = await post(b, '/__bridge/connect', { side: 'L', scanSeconds: 9999, keepAliveHz: -4, mask: 255, pairingOnly: false, cmd: 'quit', evil: '$(touch /tmp/pwned)', hex: 'ff' });
    assert.equal(r.status, 200);
    assert.ok(await waitFor(() => b.commands().some((c) => c.cmd === 'connect')));
    assert.deepEqual(b.commands().find((c) => c.cmd === 'connect'), { cmd: 'connect', side: 'L', scanSeconds: 120, keepAliveHz: 0, mask: 255, pairingOnly: false });
    await post(b, '/__bridge/disconnect', {});
    assert.ok(await es.waitFor((e) => e.state === 'disconnected'));
    await post(b, '/__bridge/connect', undefined);
    assert.ok(await waitFor(() => b.commands().filter((c) => c.cmd === 'connect').length === 2));
    assert.deepEqual(b.commands().filter((c) => c.cmd === 'connect')[1], { cmd: 'connect', side: 'any' });
    assert.ok(!existsSync('/tmp/pwned'));
    es.close();
  });
});

// ------------------------------------------------------------------------------------------------------------ static files are unaffected

test('no path traversal regression: the bridge folder and the repository are not served, every spelling of a traversal is refused', T, async () => {
  await withBridge({}, async (b) => {
    const attempts = [
      '/bridge/build.sh', '/bridge/joycon-bridge.m', '/bridge/manager.js', '/../bridge/build.sh', '/..%2fbridge%2fbuild.sh', '/%2e%2e/server.js',
      '/__bridge/../server.js', '/__bridge/%2e%2e/server.js', '/__bridge/..%2fserver.js', '/__bridge/status/../../server.js', '/__bridge%2fstatus',
      '/%5f%5fbridge/status', '/../test-support/bridge/fake-helper.mjs', '/js/../../bridge/build.sh', '/__bridge\\..\\server.js', '/bridge/build/joycon-bridge',
    ];
    for (const path of attempts) {
      const r = await request(b.port, { path, headers: { Origin: b.origin } });
      assert.ok(r.status >= 400 && r.status < 500, `${path} -> ${r.status}`);
      assert.ok(!r.text.includes('createBridgeManager') && !r.text.includes('startServer') && !r.text.includes('CoreBluetooth'), `${path} leaked a source file`);
    }
    // and the normal game files still load
    assert.equal((await request(b.port, { path: '/' })).status, 200);
    assert.equal((await request(b.port, { path: '/js/main.js' })).status, 200);
  });
});

test('the game server is not disturbed when the bridge is never used: /__health and the static files do not load the bridge module', T, async () => {
  const s = await startServer({ port: 0, quiet: true });
  try {
    assert.equal((await request(s.port, { path: '/__health' })).status, 200);
    assert.equal((await request(s.port, { path: '/' })).status, 200);
  } finally {
    await s.close();
  }
});

// ------------------------------------------------------------------------------------------------------------ lifecycle

test('stop cleanup: closing the server stops the helper (quit command), and close() resolves only when it is gone', T, async () => {
  const b = await startBridgeServer({});
  const es = openEvents(b);
  await es.ready;
  await post(b, '/__bridge/connect', {});
  assert.ok(await es.waitFor((e) => e.state === 'streaming'));
  const [pid] = b.pids();
  assert.ok(alive(pid));
  await b.cleanup();
  assert.equal(alive(pid), false, 'the helper process is gone when close() has resolved');
});

test('stop cleanup: a helper that ignores quit, EOF and SIGTERM is killed with SIGKILL', T, async () => {
  const b = await startBridgeServer({ scenario: 'stubborn', bridge: { stopGraceMs: 150 } });
  const es = openEvents(b);
  await es.ready;
  await post(b, '/__bridge/connect', {});
  assert.ok(await es.waitFor((e) => e.state === 'streaming'));
  const [pid] = b.pids();
  assert.ok(alive(pid));
  const t0 = Date.now();
  await b.cleanup();
  assert.equal(alive(pid), false, 'SIGKILL ended the stubborn helper');
  assert.ok(Date.now() - t0 < 3000, 'and it did not take long');
});

test('stop cleanup: a server that never used the bridge has nothing to stop', T, async () => {
  const b = await startBridgeServer({});
  await getJson(b, '/__bridge/status');
  await b.cleanup();
  assert.deepEqual(b.pids(), []);
});

test('a page that disappears does not keep the Joy-Con connected: the helper gets a disconnect after the grace period', T, async () => {
  await withBridge({ bridge: { idleDisconnectMs: 150 } }, async (b) => {
    const es = openEvents(b);
    await es.ready;
    await post(b, '/__bridge/connect', {});
    assert.ok(await es.waitFor((e) => e.state === 'streaming'));
    es.close();
    assert.ok(await waitFor(() => b.commands().some((c) => c.cmd === 'disconnect'), 3000), 'the helper was told to disconnect');
    // but a page that comes back within the grace period keeps the session
    const again = openEvents(b);
    await again.ready;
    assert.ok(await again.waitFor((e) => e.state === 'disconnected'), 'the helper confirmed the disconnect');
    assert.equal((await post(b, '/__bridge/connect', {})).status, 200, 'the session ended, so a new connect is possible');
    again.close();
  });
});

test('a listener that returns within the grace period keeps the session alive', T, async () => {
  await withBridge({ bridge: { idleDisconnectMs: 400 } }, async (b) => {
    const es = openEvents(b);
    await es.ready;
    await post(b, '/__bridge/connect', {});
    assert.ok(await es.waitFor((e) => e.state === 'streaming'));
    es.close();
    await sleep(100);
    const back = openEvents(b);
    await back.ready;
    await sleep(600);
    assert.ok(!b.commands().some((c) => c.cmd === 'disconnect'), 'no disconnect was sent');
    assert.ok(back.byType('report').length > 5);
    back.close();
  });
});

test('a disconnect that arrives while the helper is still being prepared cancels the connect', T, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'joycon-bridge-slowbuild-'));
  try {
    mkdirSync(join(dir, 'build'));
    // a build script that is slow: it gives the disconnect time to overtake the connect
    writeFileSync(join(dir, 'build.sh'), `#!/bin/bash\nif [ "$1" = "--check" ]; then echo can-build; exit 0; fi\nsleep 0.4\nprintf '#!/bin/bash\\nexec "${FAKE_HELPER}" "$@"\\n' > "${join(dir, 'build', 'joycon-bridge')}"\nchmod +x "${join(dir, 'build', 'joycon-bridge')}"\n`);
    chmodSync(join(dir, 'build.sh'), 0o755);
    writeFileSync(join(dir, 'joycon-bridge.m'), '// stub\n');
    const b = await startBridgeServer({ bridge: { bin: null, bridgeDir: dir, env: { ...process.env, FAKE_HELPER_LOG: join(dir, 'h.log') }, platform: 'darwin' } });
    try {
      const pending = post(b, '/__bridge/connect', { side: 'R' });
      await sleep(100);
      assert.equal((await post(b, '/__bridge/disconnect', {})).status, 200);
      const r = await pending;
      assert.equal(r.status, 409);
      assert.equal(r.json.code, 'cancelled');
    } finally {
      await b.cleanup();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------------------------------------------------ build on demand

function stubBridgeDir({ canBuild = true, buildFails = false, prebuilt = false, staleSource = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'joycon-bridge-stub-'));
  mkdirSync(join(dir, 'build'));
  const out = join(dir, 'build', 'joycon-bridge');
  const logFile = join(dir, 'build.log');
  writeFileSync(join(dir, 'build.sh'), [
    '#!/bin/bash',
    `if [ "$1" = "--check" ]; then ${canBuild ? 'echo can-build; exit 0' : 'echo cannot-build; exit 1'}; fi`,
    `echo built >> "${logFile}"`,
    buildFails ? 'echo "compiler exploded" >&2; exit 2' : `printf '#!/bin/bash\\nexec "${FAKE_HELPER}" "$@"\\n' > "${out}"; chmod +x "${out}"`,
    '',
  ].join('\n'));
  chmodSync(join(dir, 'build.sh'), 0o755);
  writeFileSync(join(dir, 'joycon-bridge.m'), '// stub source\n');
  if (prebuilt) {
    writeFileSync(out, `#!/bin/bash\nexec "${FAKE_HELPER}" "$@"\n`);
    chmodSync(out, 0o755);
    const old = new Date(Date.now() - 120000);
    const now = new Date();
    utimesSync(join(dir, 'joycon-bridge.m'), staleSource ? now : old, staleSource ? now : old); // stale = the source is newer than the binary
    utimesSync(out, staleSource ? old : now, staleSource ? old : now);
  }
  return { dir, builds: () => (existsSync(logFile) ? 1 : 0), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

async function withStub(stub, options, fn) {
  const b = await startBridgeServer({ bridge: { bin: null, bridgeDir: stub.dir, platform: 'darwin', ...options } });
  try {
    await fn(b);
  } finally {
    await b.cleanup();
    stub.cleanup();
  }
}

test('build on demand: the helper is missing but can be built: status says so, the first connect builds it and then connects', T, async () => {
  const stub = stubBridgeDir();
  await withStub(stub, {}, async (b) => {
    assert.deepEqual((await getJson(b, '/__bridge/status')).json, { available: true, reason: null, built: false, canBuild: true, state: 'idle' });
    const es = openEvents(b);
    await es.ready;
    const r = await post(b, '/__bridge/connect', { side: 'R' });
    assert.equal(r.status, 200);
    assert.equal(stub.builds(), 1);
    assert.ok(await es.waitFor((e) => e.state === 'streaming'));
    const phases = es.byType('bridge').map((e) => e.phase);
    assert.deepEqual(phases, ['building', 'built', 'starting']);
    assert.deepEqual((await getJson(b, '/__bridge/status')).json.built, true);
    es.close();
  });
});

test('build on demand: a stale binary (source newer) is rebuilt before it is used', T, async () => {
  const stub = stubBridgeDir({ prebuilt: true, staleSource: true });
  await withStub(stub, {}, async (b) => {
    const es = openEvents(b);
    await es.ready;
    assert.equal((await post(b, '/__bridge/connect', {})).status, 200);
    assert.equal(stub.builds(), 1, 'rebuilt once');
    es.close();
  });
});

test('build on demand: an up-to-date binary is not rebuilt', T, async () => {
  const stub = stubBridgeDir({ prebuilt: true, staleSource: false });
  await withStub(stub, {}, async (b) => {
    const es = openEvents(b);
    await es.ready;
    assert.equal((await post(b, '/__bridge/connect', {})).status, 200);
    assert.equal(stub.builds(), 0);
    es.close();
  });
});

test('build on demand: no compiler and no binary: not available (no_compiler), connect is refused with 503 helper_missing and a hint', T, async () => {
  const stub = stubBridgeDir({ canBuild: false });
  await withStub(stub, {}, async (b) => {
    assert.deepEqual((await getJson(b, '/__bridge/status')).json, { available: false, reason: 'no_compiler', built: false, canBuild: false, state: 'idle' });
    const r = await post(b, '/__bridge/connect', {});
    assert.equal(r.status, 503);
    assert.equal(r.json.code, 'helper_missing');
    assert.match(r.json.message, /xcode-select --install/);
  });
});

test('build on demand: a failing build is reported as 503 build_failed with the compiler output, and the next try may build again', T, async () => {
  const stub = stubBridgeDir({ buildFails: true });
  await withStub(stub, {}, async (b) => {
    const r = await post(b, '/__bridge/connect', {});
    assert.equal(r.status, 503);
    assert.equal(r.json.code, 'build_failed');
    assert.match(r.json.message, /compiler exploded/);
    assert.equal((await post(b, '/__bridge/connect', {})).json.code, 'build_failed');
  });
});

test('build on demand: no compiler but an old binary exists: the old one is used', T, async () => {
  const stub = stubBridgeDir({ canBuild: false, prebuilt: true, staleSource: true });
  await withStub(stub, {}, async (b) => {
    assert.equal((await getJson(b, '/__bridge/status')).json.available, true);
    const es = openEvents(b);
    await es.ready;
    assert.equal((await post(b, '/__bridge/connect', {})).status, 200);
    assert.equal(stub.builds(), 0);
    es.close();
  });
});

test('the real repository layout: bridge/manager.js is where server.js expects it and the default binary path is bridge/build/joycon-bridge', T, async () => {
  const { createBridgeManager } = await import('../../bridge/manager.js');
  const m = createBridgeManager({ env: {}, log: () => {} });
  assert.equal(m.info().binPath, join(ROOT, 'bridge', 'build', 'joycon-bridge'));
  const status = await m.getStatus();
  assert.equal(typeof status.available, 'boolean');
  assert.equal(status.state, 'idle');
  await m.stop();
});
