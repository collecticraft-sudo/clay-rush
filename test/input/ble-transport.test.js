// BLE transport tests: chooser filters, error mapping, side detection, and openLink against the FAKE device.
// The fake models docs/joycon2-protocol.md, not the hardware: passing here means "conforms to the document"
// (UNVERIFIED-ON-HARDWARE: UOH-1 to UOH-5, UOH-15).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildRequestOptions, requestJoyCon, classifyRequestError, classifyGattError, detectSide, openLink, LinkError,
} from '../../public/js/input/ble-transport.js';
import { INPUT_CONFIG } from '../../public/js/input/input-config.js';
import { createManualClock } from '../../public/js/shared/clock.js';
import { createFakeTimers } from '../../test-support/input/fake-timers.js';
import { createFakeBluetooth } from '../../test-support/input/fake-bluetooth.js';

const cfg = INPUT_CONFIG;
const CH = cfg.characteristics;

test('strict filter: pairing-mode adverts of both sides, byte-exact against protocol 3.3 and section 8', () => {
  const o = buildRequestOptions({ side: 'any', filter: 'strict' });
  assert.deepEqual(o.optionalServices, ['ab7de9be-89fe-49ad-828f-118f09df7fd0']);
  assert.equal(o.acceptAllDevices, undefined);
  assert.equal(o.filters.length, 2);
  const mask = Uint8Array.of(0, 0, 0, 0, 0, 0xff, 0xff, 0, 0, 0, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff);
  const [left, right] = o.filters.map((f) => f.manufacturerData[0]);
  assert.equal(left.companyIdentifier, 0x0553);
  assert.deepEqual(left.dataPrefix, Uint8Array.of(0, 0, 0, 0, 0, 0x67, 0x20, 0, 0, 0, 0, 0, 0, 0, 0, 0));
  assert.deepEqual(right.dataPrefix, Uint8Array.of(0, 0, 0, 0, 0, 0x66, 0x20, 0, 0, 0, 0, 0, 0, 0, 0, 0));
  for (const m of [left, right]) {
    assert.deepEqual(m.mask, mask);
    assert.equal(m.mask.length, m.dataPrefix.length, 'mask and dataPrefix must have the same length');
  }
  // never filters by name or service UUID (the advert carries neither)
  for (const f of o.filters) assert.deepEqual(Object.keys(f), ['manufacturerData']);
});

test('strict filter for one side selects that product id only', () => {
  const l = buildRequestOptions({ side: 'L', filter: 'strict' });
  const r = buildRequestOptions({ side: 'R', filter: 'strict' });
  assert.equal(l.filters.length, 1);
  assert.deepEqual([...l.filters[0].manufacturerData[0].dataPrefix.slice(5, 7)], [0x67, 0x20]);
  assert.deepEqual([...r.filters[0].manufacturerData[0].dataPrefix.slice(5, 7)], [0x66, 0x20]);
  for (const o of [l, r]) assert.deepEqual([...o.filters[0].manufacturerData[0].mask.slice(10)], [255, 255, 255, 255, 255, 255], 'strict requires the zero host address');
});

// ---- the DEFAULT filter (first real-hardware test: the strict default listed nothing in Chrome; docs/hardware-findings.md)

test('default filter is lenient: no options at all, {} and {side} give the lenient request, never the strict one', () => {
  assert.equal(INPUT_CONFIG.defaultFilter, 'lenient');
  const lenient = buildRequestOptions({ side: 'any', filter: 'lenient' });
  assert.deepEqual(buildRequestOptions(), lenient, 'no argument');
  assert.deepEqual(buildRequestOptions({}), lenient, 'empty options');
  assert.deepEqual(buildRequestOptions({ side: 'any' }), lenient, 'side only');
  assert.deepEqual(buildRequestOptions({ filter: undefined }), lenient, 'filter undefined');
  assert.notDeepEqual(buildRequestOptions(), buildRequestOptions({ filter: 'strict' }));
  const o = buildRequestOptions();
  assert.equal(o.acceptAllDevices, undefined);
  assert.equal(o.filters.length, 4, 'both sides, company 0x0553 and 0x057E');
  assert.deepEqual(o.filters.map((f) => f.manufacturerData[0].companyIdentifier), [0x0553, 0x0553, 0x057e, 0x057e]);
  assert.deepEqual(o.filters.map((f) => f.manufacturerData[0].dataPrefix[5]), [0x67, 0x66, 0x67, 0x66], 'Left then Right product id, per company');
  for (const f of o.filters) {
    const e = f.manufacturerData[0];
    assert.deepEqual([...e.mask], [0, 0, 0, 0, 0, 0xff, 0xff, 0, 0, 0, 0, 0, 0, 0, 0, 0], 'only the product id bytes are compared');
    assert.equal(e.mask.length, e.dataPrefix.length);
    assert.deepEqual(Object.keys(f), ['manufacturerData'], 'no name or service UUID filter');
  }
  assert.deepEqual(o.optionalServices, [cfg.service]);
});

test('default filter for one side: the lenient request for that product id only; an unknown filter name falls back to the default', () => {
  const l = buildRequestOptions({ side: 'L' });
  const r = buildRequestOptions({ side: 'R' });
  assert.deepEqual(l.filters.map((f) => f.manufacturerData[0].companyIdentifier), [0x0553, 0x057e]);
  assert.deepEqual(l.filters.map((f) => [...f.manufacturerData[0].dataPrefix.slice(5, 7)]), [[0x67, 0x20], [0x67, 0x20]]);
  assert.deepEqual(r.filters.map((f) => [...f.manufacturerData[0].dataPrefix.slice(5, 7)]), [[0x66, 0x20], [0x66, 0x20]]);
  assert.deepEqual(buildRequestOptions({ filter: 'pairing' }), buildRequestOptions(), 'unknown name: default, not strict');
  assert.deepEqual(buildRequestOptions({ filter: 'ALL' }), buildRequestOptions(), 'names are exact (flags.js lower-cases them before)');
});

test('the default comes from INPUT_CONFIG.defaultFilter (one constant for the transport, the game and the diagnostics URL)', () => {
  const strictCfg = { ...cfg, defaultFilter: 'strict' };
  assert.deepEqual(buildRequestOptions({}, strictCfg), buildRequestOptions({ filter: 'strict' }));
  const allCfg = { ...cfg, defaultFilter: 'all' };
  assert.deepEqual(buildRequestOptions({ side: 'L' }, allCfg), { acceptAllDevices: true, optionalServices: [cfg.service] });
  assert.deepEqual(buildRequestOptions({ filter: 'strict' }, allCfg), buildRequestOptions({ filter: 'strict' }), 'an explicit filter still wins');
});

/**
 * What the Web Bluetooth specification says a manufacturerData filter means (protocol 3.3; not Chromium's matcher, which nobody here could
 * test): the company id must be present and the data, at least as long as dataPrefix, must equal dataPrefix on every bit the mask sets.
 */
function matchesAdvert(options, companyId, data) {
  if (options.acceptAllDevices) return true;
  return options.filters.some((f) =>
    f.manufacturerData.every((m) => m.companyIdentifier === companyId && data.length >= m.dataPrefix.length && m.dataPrefix.every((p, i) => (data[i] & m.mask[i]) === (p & m.mask[i]))));
}
/** A Joy-Con 2 advert as docs/joycon2-protocol.md 3.1 lays it out; idx 0-6 and the two host-address variants are what the real scan showed. */
function advert(pid, hostAddress) {
  return Uint8Array.of(0x01, 0x00, 0x03, 0x7e, 0x05, pid & 0xff, pid >> 8, 0x00, 0x01, 0x00, ...hostAddress, 0x0f, 0, 0, 0, 0, 0, 0, 0);
}
const ZERO_HOST = [0, 0, 0, 0, 0, 0];
const BONDED_HOST = [0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff]; // a made-up bonded-host address: the real scan before SYNC showed non-zero bytes here

test('which adverts each filter accepts: lenient takes the bonded-host and the zero-address advert, strict only the zero one, the wrong side never', () => {
  const R = cfg.pid.R;
  const L = cfg.pid.L;
  const strict = buildRequestOptions({ side: 'any', filter: 'strict' });
  const lenient = buildRequestOptions({ side: 'any', filter: 'lenient' });
  const all = buildRequestOptions({ filter: 'all' });
  assert.equal(matchesAdvert(strict, 0x0553, advert(R, ZERO_HOST)), true);
  assert.equal(matchesAdvert(strict, 0x0553, advert(R, BONDED_HOST)), false, 'the advert sent before SYNC is invisible to strict');
  assert.equal(matchesAdvert(lenient, 0x0553, advert(R, ZERO_HOST)), true);
  assert.equal(matchesAdvert(lenient, 0x0553, advert(R, BONDED_HOST)), true, 'lenient ignores the host address bytes');
  assert.equal(matchesAdvert(lenient, 0x0553, advert(L, BONDED_HOST)), true);
  assert.equal(matchesAdvert(lenient, 0x057e, advert(R, ZERO_HOST)), true, 'the second company id entry');
  assert.equal(matchesAdvert(lenient, 0x0553, advert(0x2069, ZERO_HOST)), false, 'another Nintendo product (Pro Controller 2) is not offered');
  assert.equal(matchesAdvert(lenient, 0x004c, advert(R, ZERO_HOST)), false, 'another company id');
  const rightOnly = buildRequestOptions({ side: 'R', filter: 'lenient' });
  assert.equal(matchesAdvert(rightOnly, 0x0553, advert(R, BONDED_HOST)), true);
  assert.equal(matchesAdvert(rightOnly, 0x0553, advert(L, BONDED_HOST)), false);
  assert.equal(matchesAdvert(all, 0x004c, Uint8Array.of(1, 2, 3)), true);
  // the default behaves like lenient on every one of these
  const dflt = buildRequestOptions();
  for (const [company, data] of [[0x0553, advert(R, BONDED_HOST)], [0x0553, advert(L, ZERO_HOST)], [0x0553, advert(0x2069, ZERO_HOST)], [0x004c, advert(R, ZERO_HOST)]]) {
    assert.equal(matchesAdvert(dflt, company, data), matchesAdvert(lenient, company, data));
  }
});

test('lenient filter masks the product id only and adds a second entry for company id 0x057E', () => {
  const o = buildRequestOptions({ side: 'any', filter: 'lenient' });
  assert.equal(o.filters.length, 4);
  const entries = o.filters.map((f) => f.manufacturerData[0]);
  assert.deepEqual(entries.map((e) => e.companyIdentifier), [0x0553, 0x0553, 0x057e, 0x057e]);
  for (const e of entries) {
    assert.deepEqual([...e.mask], [0, 0, 0, 0, 0, 0xff, 0xff, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    assert.equal(e.mask.length, e.dataPrefix.length);
  }
  assert.deepEqual(o.optionalServices, [cfg.service]);
});

test('"all" is acceptAllDevices with the vendor service as optional service and no filters', () => {
  const o = buildRequestOptions({ filter: 'all' });
  assert.deepEqual(o, { acceptAllDevices: true, optionalServices: [cfg.service] });
});

test('requestJoyCon calls requestDevice synchronously (the user gesture is still valid)', () => {
  let called = false;
  const p = requestJoyCon({ requestDevice: (options) => { called = true; return Promise.resolve(options); } }, { side: 'R' });
  assert.equal(called, true, 'requestDevice must have run before requestJoyCon returned');
  return p.then((options) => assert.equal(options.filters.length, 2, 'the default (lenient) filter for one side: company 0x0553 and 0x057E'));
});

test('requestJoyCon with filter "all" (the extended search) is still one synchronous requestDevice call with acceptAllDevices and optionalServices', () => {
  const seen = [];
  const p = requestJoyCon({ requestDevice: (options) => { seen.push(options); return Promise.resolve(options); } }, { filter: 'all' });
  assert.equal(seen.length, 1, 'requestDevice ran before requestJoyCon returned');
  assert.deepEqual(seen[0], { acceptAllDevices: true, optionalServices: [cfg.service] });
  return p;
});

test('requestDevice errors map to codes (architecture 5.4 guidance)', () => {
  const e = (name, message = 'm') => Object.assign(new Error(message), { name });
  assert.equal(classifyRequestError(e('NotFoundError', 'User cancelled the requestDevice() chooser.')).code, 'cancelled');
  assert.equal(classifyRequestError(e('AbortError')).code, 'cancelled');
  assert.equal(classifyRequestError(e('SecurityError')).code, 'permission_denied');
  assert.equal(classifyRequestError(e('NotFoundError', 'Bluetooth adapter not available.')).code, 'gatt_failure');
  assert.equal(classifyRequestError(e('TypeError', 'bad filters')).code, 'gatt_failure');
  assert.equal(classifyRequestError(undefined).code, 'gatt_failure');
});

test('GATT errors map to codes; discovery NotFound/Security/NotSupported mean "not a Joy-Con"', () => {
  const e = (name) => Object.assign(new Error('m'), { name });
  for (const name of ['NotFoundError', 'SecurityError', 'NotSupportedError']) assert.equal(classifyGattError(e(name), 'discovery').code, 'not_joycon');
  assert.equal(classifyGattError(e('NetworkError'), 'discovery').code, 'gatt_failure');
  assert.equal(classifyGattError(e('NetworkError'), 'connect').code, 'gatt_failure');
  assert.equal(classifyGattError(e('NotFoundError'), 'connect').code, 'gatt_failure', 'NotFound during connect is not a wrong-device signal');
  const link = new LinkError('no_data', 'x');
  assert.equal(classifyGattError(link, 'connect'), link);
});

test('side detection: characteristic presence beats the name, the name beats the chooser hint', () => {
  const only = (...uuids) => new Set(uuids);
  assert.deepEqual(detectSide(only(CH.vibrationLeft), 'Joy-Con 2 (R)', 'R'), { side: 'L', source: 'characteristic' });
  assert.deepEqual(detectSide(only(CH.vibrationRight), 'whatever', 'L'), { side: 'R', source: 'characteristic' });
  assert.deepEqual(detectSide(only(), 'Joy-Con 2 (L)', 'R'), { side: 'L', source: 'name' });
  assert.deepEqual(detectSide(only(), 'Joy-Con 2 (R)', undefined), { side: 'R', source: 'name' });
  assert.deepEqual(detectSide(only(), 'DeviceName', 'R'), { side: 'R', source: 'hint' });
  assert.deepEqual(detectSide(only(), undefined, 'any'), { side: '?', source: 'none' });
  assert.deepEqual(detectSide(only(CH.vibrationLeft, CH.vibrationRight), undefined, undefined), { side: '?', source: 'none' }, 'both characteristics: ambiguous');
});

// ------------------------------------------------------------------------------------------------ openLink

async function link(behaviour = {}, over = {}) {
  const clock = createManualClock(0);
  const timers = createFakeTimers(clock);
  const fake = createFakeBluetooth({ clock, timers, behaviour });
  const device = await fake.bluetooth.requestDevice(buildRequestOptions({}));
  const reports = [];
  const stages = [];
  const events = [];
  const pending = openLink(device, {
    clock, timers, onReport: (bytes, at) => reports.push({ bytes, at }), onStage: (s, i) => stages.push({ s, i, t: clock.now() }),
    onEvent: (ev) => events.push(ev), ...over,
  });
  const result = { clock, timers, fake, device, reports, stages, events, pending };
  pending.catch(() => {}); // failures are asserted by the tests that expect them
  return result;
}

test('openLink: documented order LED, SET, ENABLE, then the input subscription; only the command characteristic is written', async () => {
  const t = await link();
  await t.timers.advance(3000);
  const l = await t.pending;
  assert.equal(l.side, 'R');
  assert.deepEqual(t.stages.map((s) => s.s), ['connected', 'discovered', 'commands', 'subscribed']);
  // the first three frames are the init sequence; later ones can only be keep-alives (the same LED frame)
  const frames = t.fake.commandFrames();
  // the default mask is 0xB7 (round 1 finding F1); 0x37 is an expert option, see the mask tests of ble-provider.test.js
  assert.deepEqual(frames.slice(0, 3), ['09910107000800000100000000000000', '0c91010200040000b7000000', '0c91010400040000b7000000']);
  assert.ok(frames.slice(3).every((h) => h === '09910107000800000100000000000000'));
  assert.ok(t.fake.onlyCommandWrites(), 'never a write to a decoy characteristic (firmware update channel and look-alike)');
  const writes = t.fake.log.writes;
  for (let i = 1; i < writes.length; i++) assert.ok(writes[i].t - writes[i - 1].t >= cfg.writeSpacingMs - 1e-9, `writes ${i - 1} and ${i} are ${writes[i].t - writes[i - 1].t} ms apart`);
  // the response subscription came before the first command, the input subscription after ENABLE
  const subs = t.fake.log.notifications;
  assert.equal(subs[0].uuid, CH.response);
  assert.equal(subs[1].uuid, CH.input);
  assert.ok(subs[0].t <= writes[0].t && subs[1].t >= writes[2].t);
  assert.deepEqual(t.fake.log.overlaps, []);
  assert.equal(t.fake.log.inProgressErrors, 0);
  l.close();
  t.fake.stop();
});

test('n2: a repeated gattserverdisconnected event announces the loss once, and nothing after close()', async () => {
  const t = await link();
  await t.timers.advance(3000);
  const l = await t.pending;
  t.fake.dropLink();
  t.device.dispatchEvent(new Event('gattserverdisconnected')); // Chrome can fire it again (or late)
  t.device.dispatchEvent(new Event('gattserverdisconnected'));
  assert.equal(t.events.filter((e) => e.type === 'disconnected').length, 1, 'one disconnected event, not three');
  assert.equal(l.isAlive(), false);
  l.close();
  t.device.dispatchEvent(new Event('gattserverdisconnected'));
  assert.equal(t.events.filter((e) => e.type === 'disconnected').length, 1, 'nothing after close()');
  t.fake.stop();
});

test('m4: a response subscription that takes longer than its 3 s timeout never overlaps the next GATT operation', async () => {
  const t = await link({ respSubscribeMs: 3600 });
  await t.timers.advance(12000);
  const l = await t.pending;
  assert.deepEqual(t.fake.log.overlaps, [], 'the init write waited for the slow subscription to really finish');
  assert.equal(t.fake.log.inProgressErrors, 0);
  assert.ok(t.events.some((e) => e.type === 'warn' && /no command responses/.test(e.message)), 'the caller gave up at 3 s (optional channel)');
  assert.equal(t.fake.commandFrames().slice(0, 3).length, 3, 'the init sequence still went out');
  l.close();
  t.fake.stop();
});

test('m4: a GATT operation that never finishes blocks the chain for at most serialHangCapMs, then the link goes on', async () => {
  const t = await link({ respSubscribeMs: 600000 });
  await t.timers.advance(40000);
  const l = await t.pending;
  assert.equal(t.fake.commandFrames().length >= 3, true, 'the writes were not blocked for ever by a hung subscription');
  l.close();
  t.fake.stop();
});

test('openLink: without command responses the init still finishes (500 ms per command), responses are optional', async () => {
  const t = await link({ respond: false });
  await t.timers.advance(4000);
  await t.pending;
  const w = t.fake.log.writes;
  assert.ok(w[1].t - w[0].t >= cfg.initSpacingMs - 1);
  assert.ok(w[2].t - w[1].t >= cfg.initSpacingMs - 1);
  (await t.pending).close();
  t.fake.stop();
});

test('openLink: the report handler stamps the arrival, copies the bytes and delivers 63-byte reports', async () => {
  const t = await link({ reuseBuffer: true });
  await t.timers.advance(3000);
  const l = await t.pending;
  await t.timers.advance(200);
  assert.ok(t.reports.length >= 10);
  const first = t.reports[0].bytes;
  const snapshot = first.slice();
  await t.timers.advance(200);
  assert.deepEqual(first, snapshot, 'the byte copy must not change when the browser reuses its buffer');
  assert.equal(first.length, 63);
  for (let i = 1; i < t.reports.length; i++) assert.ok(t.reports[i].at >= t.reports[i - 1].at);
  l.close();
  t.fake.stop();
});

test('openLink: a missing vendor service is not_joycon, a missing required characteristic too', async () => {
  const a = await link({ service: 'missing' });
  await a.timers.advance(2000);
  await assert.rejects(a.pending, (e) => e instanceof LinkError && e.code === 'not_joycon');
  const b = await link({ omitCharacteristics: [CH.input] });
  await b.timers.advance(2000);
  await assert.rejects(b.pending, (e) => e.code === 'not_joycon' && /input/.test(e.message));
  const c = await link({ omitCharacteristics: [CH.command] });
  await c.timers.advance(2000);
  await assert.rejects(c.pending, (e) => e.code === 'not_joycon' && /command/.test(e.message));
});

test('n9: a NotFoundError at service discovery is retried once after the settle time before it counts as "not a Joy-Con"', async () => {
  const t = await link({ serviceNotFoundFirst: 1 });
  await t.timers.advance(4000);
  const l = await t.pending;
  assert.equal(t.fake.log.serviceCalls, 2, 'asked twice: the race was survived');
  assert.equal(l.side, 'R');
  l.close();
  t.fake.stop();
  // a service that really is missing still ends as not_joycon (after the one retry, never a loop)
  const m = await link({ service: 'missing' });
  await m.timers.advance(4000);
  await assert.rejects(m.pending, (e) => e instanceof LinkError && e.code === 'not_joycon');
  // a security error (the origin is not allowed) is final at once: no retry for it
  const sec = await link({ service: 'security' });
  await sec.timers.advance(4000);
  await assert.rejects(sec.pending, (e) => e instanceof LinkError);
});

test('openLink: the command-response characteristic is optional (missing = warning, not failure)', async () => {
  const t = await link({ omitCharacteristics: [CH.response] });
  await t.timers.advance(4000);
  const l = await t.pending;
  assert.equal(l.side, 'R');
  l.close();
  t.fake.stop();
});

test('openLink: connect and discovery time out after 15 s with gatt_failure and tear the link down', async () => {
  const a = await link({ connect: 'hang' });
  await a.timers.advance(14_999);
  let settled = false;
  a.pending.then(() => (settled = true), () => (settled = true));
  await a.timers.advance(0);
  assert.equal(settled, false);
  await a.timers.advance(2);
  await assert.rejects(a.pending, (e) => e.code === 'gatt_failure' && /gatt\.connect/.test(e.message));

  const b = await link({ service: 'hang' });
  await b.timers.advance(16_000);
  await assert.rejects(b.pending, (e) => e.code === 'gatt_failure' && /discovery/.test(e.message));
  assert.equal(b.fake.log.disconnectCalls, 1, 'gatt.disconnect() after a discovery timeout');
});

test('openLink: a failing connect is gatt_failure', async () => {
  const t = await link({ connect: 'fail' });
  await t.timers.advance(1000);
  await assert.rejects(t.pending, (e) => e.code === 'gatt_failure' && /Connection attempt failed/.test(e.message));
});

test('openLink: a link that drops mid-connection reports disconnected and the attempt aborts', async () => {
  const t = await link({ discoveryDelayMs: 1000 });
  await t.timers.advance(500);
  t.fake.dropLink();
  await t.timers.advance(3000);
  assert.ok(t.events.some((e) => e.type === 'disconnected'));
  await assert.rejects(t.pending);
});

test('openLink: isCancelled aborts between steps with code cancelled', async () => {
  let cancel = false;
  const t = await link({}, { isCancelled: () => cancel });
  await t.timers.advance(200);
  cancel = true;
  await t.timers.advance(3000);
  await assert.rejects(t.pending, (e) => e.code === 'cancelled');
  assert.equal(t.fake.log.disconnectCalls, 1);
});

test('keep-alive: the LED frame goes out every second while nothing else is written, and stops on request', async () => {
  const t = await link({ respond: true });
  await t.timers.advance(3000);
  const l = await t.pending;
  await t.timers.advance(2000);
  const base = t.fake.commandFrames().length;
  await t.timers.advance(10_000);
  const frames = t.fake.commandFrames().slice(base);
  assert.ok(frames.length >= 9 && frames.length <= 11, `${frames.length} keep-alive frames in 10 s`);
  assert.ok(frames.every((h) => h === '09910107000800000100000000000000'));
  l.setKeepAlive(false);
  const before = t.fake.commandFrames().length;
  await t.timers.advance(5000);
  assert.equal(t.fake.commandFrames().length, before, 'no keep-alive with the expert flag off');
  assert.equal(l.stats().keepAlive, false);
  l.close();
  t.fake.stop();
});

test('keep-alive is skipped while other writes keep the link busy (only sent after 900 ms without a write)', async () => {
  const t = await link();
  await t.timers.advance(3000);
  const l = await t.pending;
  const base = t.fake.commandFrames().length;
  for (let i = 0; i < 20; i++) {
    l.write(Uint8Array.of(0x0a, 0x91, 0x01, 0x02, 0, 4, 0, 0, 3, 0, 0, 0), 'test'); // completes while the timers advance
    await t.timers.advance(400);
  }
  const frames = t.fake.commandFrames().slice(base);
  assert.ok(!frames.includes('09910107000800000100000000000000'), 'no LED keep-alive between writes 400 ms apart');
  l.close();
  t.fake.stop();
});

test('vibrate: rate limited to 10 per second, errors swallowed', async () => {
  const t = await link({ respond: false });
  await t.timers.advance(4000);
  const l = await t.pending;
  const base = t.fake.commandFrames().length;
  let accepted = 0;
  for (let i = 0; i < 30; i++) {
    if (l.vibrate(3)) accepted++;
    await t.timers.advance(20); // 30 calls over 600 ms
  }
  assert.ok(accepted >= 5 && accepted <= 7, `${accepted} haptic frames accepted in 600 ms`);
  assert.ok(t.fake.commandFrames().slice(base).filter((h) => h === '0a9101020004000003000000').length >= 5);
  t.fake.behaviour.writeFails = true;
  await t.timers.advance(200);
  assert.doesNotThrow(() => l.vibrate(6));
  await t.timers.advance(500);
  l.close();
  t.fake.stop();
});

test('close() stops the timers, removes the listeners and disconnects the GATT server exactly once', async () => {
  const t = await link();
  await t.timers.advance(3000);
  const l = await t.pending;
  l.close();
  l.close();
  assert.equal(t.fake.log.disconnectCalls, 1);
  assert.equal(l.isAlive(), false);
  const events = t.events.length;
  await t.timers.advance(5000);
  assert.equal(t.events.length, events, 'no disconnected event for our own close');
  assert.equal(t.reports.length > 0, true);
  const count = t.reports.length;
  await t.timers.advance(1000);
  assert.equal(t.reports.length, count, 'no more reports after close');
  assert.equal(t.timers.pending() <= 1, true, 'no timer of the link is left running');
  t.fake.stop();
});
