// Report stream tests (docs/architecture.md 5.5): bytes + arrival time -> PacketEvent / ButtonsEvent / ImuSample.
// Timing rules of docs/joycon2-protocol.md 7.3. The device behaviour behind them is UNVERIFIED-ON-HARDWARE (UOH-4, UOH-8).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createReportStream } from '../../public/js/input/report-stream.js';
import { buildInputReport } from '../../public/js/input/joycon2-build.js';
import { assertValid } from '../../public/js/shared/validate.js';
import { createRng } from '../../public/js/shared/rng.js';
import { vector } from '../../test-support/input/vectors.js';

function harness(opts = {}) {
  const events = { packet: [], buttons: [], sample: [], order: [] };
  const logs = [];
  const stream = createReportStream({
    side: opts.side ?? 'R',
    log: (level, message) => logs.push({ level, message }),
    emit: (type, payload) => {
      events[type].push(payload);
      events.order.push(type);
    },
  });
  const report = (tsUs, extra = {}) => buildInputReport({ imuTimestampUs: tsUs, counter: Math.round(tsUs / 1000), accelRaw: { x: 0, y: 0, z: 4096 }, ...extra });
  return { stream, events, logs, report, push: (tsUs, at, extra) => stream.push(report(tsUs, extra), at) };
}

test('V1 (real Left capture) becomes a valid ImuSample; events come in the order packet, buttons, sample', () => {
  const { stream, events } = harness({ side: 'L' });
  const v = vector('V1');
  const { report, sample } = stream.push(v.bytes.slice(), 5000);
  assert.equal(report.length, 63);
  assert.deepEqual(events.order, ['packet', 'buttons', 'sample']);
  assertValid('ImuSample', sample);
  assert.equal(sample.seq, 0);
  assert.equal(sample.side, 'L');
  assert.deepEqual(sample.accel, v.expected.accelG);
  assert.deepEqual(sample.gyro, v.expected.gyroDps);
  assert.equal(sample.batteryMv, 3679);
  assert.ok(Math.abs(sample.tempC - v.expected.temperatureC) < 1e-4);
  assert.equal(sample.dtMs, null, 'first sample of a session');
  assert.equal(sample.dtSource, 'device');
  assert.equal(sample.t, 5000);
  assert.equal(sample.arrivedAt, 5000);
  assert.equal(sample.imuActive, true);
  const packet = events.packet[0];
  assert.equal(packet.length, 63);
  assert.equal(packet.arrivedAt, 5000);
  assert.equal(packet.t, sample.t);
  assert.equal(packet.report, report);
  assert.ok(packet.bytes instanceof Uint8Array);
  assert.equal(events.buttons[0].initial, true);
});

test('dt comes from u32 wrap-safe device timestamp deltas (V3: 4294965296 -> 2000 is 4 ms)', () => {
  const { stream, push } = harness();
  const v3 = vector('V3');
  const first = stream.push(v3.bytes.slice(), 1000).sample;
  assert.equal(first.dtMs, null);
  const second = push(2000, 1004).sample;
  assert.equal(second.dtMs, 4);
  assert.equal(second.dtSource, 'device');
  assert.equal(push(17000, 1019).sample.dtMs, 15);
});

test('gaps: a delta of 200 ms or more gives dtMs null and restarts the estimate; the next sample is normal again', () => {
  const { stream, push } = harness();
  push(1_000_000, 100);
  assert.equal(push(1_015_000, 115).sample.dtMs, 15);
  const gap = push(1_215_000, 315).sample;
  assert.equal(gap.dtMs, null);
  assert.equal(push(1_230_000, 330).sample.dtMs, 15);
  assert.equal(stream.getStats().gaps, 1);
  const back = push(1_000_000, 345).sample; // timestamp went backwards
  assert.equal(back.dtMs, null);
  assert.equal(stream.getStats().gaps, 2);
});

test('a duplicate timestamp (delta 0) gives dtMs null and is counted', () => {
  const { stream, push } = harness();
  push(50_000, 10);
  const dup = push(50_000, 25).sample;
  assert.equal(dup.dtMs, null);
  assert.equal(stream.getStats().duplicates, 1);
});

test('dropped packets appear as a longer dt and are counted for the diagnostics', () => {
  const { stream, push } = harness();
  let ts = 0;
  let at = 100;
  for (let i = 0; i < 20; i++) {
    push(ts, at);
    ts += 15_000;
    at += 15;
  }
  ts += 30_000; // two reports lost
  at += 30;
  const after = push(ts, at).sample;
  assert.equal(after.dtMs, 45);
  assert.equal(stream.getStats().dropped, 2);
});

test('timestamps that disagree with arrival times: after one window dt falls back to arrival deltas with a warning', () => {
  const { stream, push, logs } = harness();
  // the "timestamp" advances 7.5 ms per 15 ms of real time (ratio 0.5): not microseconds
  let ts = 0;
  const samples = [];
  for (let i = 0; i < 120; i++) samples.push(push(ts + i * 7500, 1000 + i * 15).sample);
  assert.equal(stream.getStats().dtSource, 'arrival');
  const late = samples[100];
  assert.equal(late.dtSource, 'arrival');
  assert.ok(Math.abs(late.dtMs - 15) < 0.01, `arrival dt, got ${late.dtMs}`);
  assert.ok(logs.some((l) => l.level === 'warn' && /disagree/.test(l.message)));
  assert.ok(stream.getStats().dtRatio < 0.6);
  // and t follows the arrival clock in that mode
  assert.equal(late.t, late.arrivedAt);
});

test('a ratio inside 0.8..1.25 keeps the device timestamps (a controller clock 10 percent off is tolerated)', () => {
  const { stream, push } = harness();
  let last;
  for (let i = 0; i < 200; i++) last = push(i * 13_636, 1000 + i * 15).sample; // ratio 0.909
  assert.equal(last.dtSource, 'device');
  assert.equal(stream.getStats().dtSource, 'device');
});

test('stuck timestamps: three unusable deltas in a row switch to arrival deltas at once', () => {
  const { stream, push, logs } = harness();
  const out = [];
  for (let i = 0; i < 10; i++) out.push(push(777_000, 100 + i * 15).sample);
  assert.equal(out[0].dtMs, null);
  assert.equal(out[1].dtMs, null);
  assert.equal(out[2].dtMs, null);
  assert.equal(out[3].dtSource, 'arrival', 'after 3 bad deltas');
  assert.ok(Math.abs(out[9].dtMs - 15) < 1e-9);
  assert.ok(logs.some((l) => /unusable/.test(l.message)));
  assert.equal(stream.getStats().dtSource, 'arrival');
});

test('arrival mode: dt is the mean arrival interval, so a burst pair never yields a null or near-zero dt', () => {
  const { push, stream } = harness();
  // stuck timestamps force the arrival fallback; arrivals are 15 ms apart, and every tenth packet is held back and
  // delivered together with its successor (a burst pair: one arrival time)
  const dts = [];
  let last = 0;
  let pairs = 0;
  for (let i = 0; i < 200; i++) {
    const held = i % 10 === 4;
    const at = 100 + 15 * (held ? i + 1 : i);
    if (at === last) pairs++;
    last = at;
    dts.push(push(777_000, at).sample.dtMs);
  }
  assert.ok(pairs >= 15, `${pairs} burst pairs`);
  assert.equal(stream.getStats().dtSource, 'arrival');
  const usable = dts.slice(40);
  assert.ok(usable.every((d) => d > 5 && d < 30), `dts ${usable.slice(0, 12)}`);
  assert.ok(Math.abs(usable.reduce((a, b) => a + b, 0) / usable.length - 15) < 1.5);
  // an arrival gap of 200 ms or more is still a gap
  assert.equal(push(777_000, last + 400).sample.dtMs, null);
  assert.ok(push(777_000, last + 415).sample.dtMs > 0);
});

test('t is non-decreasing and never later than arrivedAt, also with jitter and bursts', () => {
  const { push } = harness();
  const rng = createRng(7);
  let lastT = -Infinity;
  let arrival = 1000;
  for (let i = 0; i < 2000; i++) {
    const ts = i * 15_000;
    const jitter = rng.range(0, 8);
    const at = Math.max(arrival, 1000 + i * 15 + jitter);
    arrival = at;
    const s = push(ts, at).sample;
    assert.ok(s.t >= lastT, `t went backwards at ${i}`);
    assert.ok(s.t <= s.arrivedAt + 1e-9, `t after arrival at ${i}`);
    lastT = s.t;
    assertValid('ImuSample', s);
  }
});

test('a burst (two packets, one arrival time, timestamps 15 ms apart) yields two samples with dt 15 and equal t', () => {
  const { stream, push } = harness();
  for (let i = 0; i < 30; i++) push(i * 15_000, 1000 + i * 15);
  const a = push(30 * 15_000, 1000 + 31 * 15).sample; // delayed by one interval
  const b = push(31 * 15_000, 1000 + 31 * 15).sample; // delivered together
  assert.equal(a.dtMs, 15);
  assert.equal(b.dtMs, 15);
  assert.ok(b.t >= a.t);
  assert.ok(b.t <= b.arrivedAt);
  assert.equal(stream.getStats().bursts, 1);
  const c = push(32 * 15_000, 1000 + 32 * 15).sample;
  assert.equal(c.dtMs, 15);
});

test('the clock offset creeps up so that a controller clock running slow cannot make t fall behind without bound', () => {
  const { push } = harness();
  // 20 minutes at 66 Hz; the controller clock runs 100 ppm SLOW relative to the host
  const period = 1000 / 66;
  const rng = createRng(3);
  let worst = 0;
  let last;
  const n = 66 * 60 * 20;
  for (let i = 0; i < n; i++) {
    const hostMs = 10_000 + i * period + rng.range(0, 3);
    const devUs = Math.round(i * period * 1000 * (1 - 100e-6));
    last = push(devUs >>> 0, hostMs).sample;
    if (i > 66 * 30) worst = Math.max(worst, last.arrivedAt - last.t);
  }
  assert.ok(worst < 30, `t lags arrival by up to ${worst.toFixed(1)} ms`);
});

test('reports with the IMU bytes all zero produce no sample, but still a packet and buttons event', () => {
  const { stream, events, push } = harness();
  const bytes = buildInputReport({ accelRaw: { x: 0, y: 0, z: 0 }, pressed: ['A'] });
  const out = stream.push(bytes, 100);
  assert.equal(out.sample, null);
  assert.equal(out.report.imuActive, false);
  assert.deepEqual(events.order, ['packet', 'buttons']);
  assert.equal(events.packet[0].t, null);
  assert.deepEqual(events.buttons[0].down, ['A']);
  assert.equal(stream.getStats().inactive, 1);
  assert.equal(events.sample.length, 0);
  // the next active report starts the timing estimate as the first sample
  assert.equal(push(1000, 115).sample.dtMs, null);
});

test('truncated notifications are rejected: a packet event with report null, no sample', () => {
  const { stream, events } = harness();
  const out = stream.push(buildInputReport({ length: 20 }), 100);
  assert.equal(out.report, null);
  assert.equal(out.sample, null);
  assert.equal(events.packet[0].report, null);
  assert.equal(events.packet[0].length, 20);
  assert.equal(events.packet[0].t, null);
  assert.equal(stream.getStats().rejected, 1);
  assert.equal(events.buttons.length, 0);
});

test('buttons: down/up against the previous report, initial flag only on the first, shared frozen empty list', () => {
  const { stream, events, push } = harness();
  push(0, 100);
  push(15_000, 115, { pressed: ['A', 'ZR'] });
  push(30_000, 130, { pressed: ['A', 'ZR'] }); // unchanged: no event
  push(45_000, 145, { pressed: ['ZR'] });
  push(60_000, 160);
  const b = events.buttons;
  assert.equal(b.length, 4);
  assert.deepEqual(b[0], { t: 100, side: 'R', pressed: [], down: [], up: [], initial: true });
  assert.deepEqual([b[1].down, b[1].up, b[1].pressed], [['A', 'ZR'], [], ['A', 'ZR']]);
  assert.deepEqual([b[2].down, b[2].up], [[], ['A']]);
  assert.deepEqual([b[3].down, b[3].up], [[], ['ZR']]);
  assert.equal('initial' in b[1], false);
  assert.ok(Object.isFrozen(b[1].pressed));
  for (const e of b) assertValid('ButtonsEvent', e);
  assert.equal(events.sample[0].buttons, events.sample[4].buttons, 'the same frozen empty array is shared');
  assert.deepEqual(events.sample[1].buttons, ['A', 'ZR']);
});

test('side: setSide changes the side of later samples', () => {
  const { stream, push } = harness({ side: '?' });
  assert.equal(push(0, 100).sample.side, '?');
  stream.setSide('L');
  assert.equal(stream.getSide(), 'L');
  assert.equal(push(15_000, 115).sample.side, 'L');
});

test('packet rate: interval based before one window, count based after, null with fewer than two packets, 0 when stalled', () => {
  const { stream, push } = harness();
  assert.equal(stream.getRateHz(100), null);
  push(0, 100);
  assert.equal(stream.getRateHz(100), null);
  for (let i = 1; i < 200; i++) push(i * 15_000, 100 + i * 15);
  const now = 100 + 199 * 15;
  const rate = stream.getRateHz(now);
  assert.ok(Math.abs(rate - 66.7) < 2, `rate ${rate}`);
  assert.equal(stream.getRateHz(now + 5000), 0);
  assert.ok(Math.abs(stream.getRateHz(now, 10000) - 66.7) < 2, 'a 10 s window that is not covered yet is interval based too');
  assert.ok(Math.abs(stream.getStats(now).rate1sHz - rate) < 1e-9);
});

test('reset forgets the estimators but keeps seq and never lets t go backwards', () => {
  const { stream, events, push } = harness();
  for (let i = 0; i < 5; i++) push(i * 15_000, 1000 + i * 15);
  const before = events.sample[4];
  stream.reset();
  const after = push(9_000_000, 1100).sample; // brand new device epoch
  assert.equal(after.seq, before.seq + 1);
  assert.equal(after.dtMs, null);
  assert.ok(after.t >= before.t);
  assert.equal(events.buttons.filter((b) => b.initial).length, 2, 'the baseline is re-established after a reset');
});

test('hasListener false skips building packet events', () => {
  const emitted = [];
  const stream = createReportStream({ emit: (type) => emitted.push(type), hasListener: () => false });
  stream.push(buildInputReport({ imuTimestampUs: 1 }), 10);
  assert.deepEqual(emitted, ['buttons', 'sample']);
});

test('every emitted sample of a long random run satisfies the ImuSample contract', () => {
  const { push } = harness();
  const rng = createRng(11);
  for (let i = 0; i < 3000; i++) {
    const s = push(i * 15_000 + rng.int(-3000, 3000), 1000 + i * 15 + rng.range(0, 6), {
      accelRaw: { x: rng.int(-8000, 8000), y: rng.int(-8000, 8000), z: rng.int(-8000, 8000) },
      gyroRaw: { x: rng.int(-30000, 30000), y: rng.int(-30000, 30000), z: rng.int(-30000, 30000) },
    }).sample;
    assertValid('ImuSample', s);
  }
});

test('n2: the sample time never goes backwards when arrival stamps do (the t < lastT clamp)', () => {
  const { push } = harness();
  const a = push(1_000_000, 1000).sample;
  const b = push(1_015_000, 990).sample; // the arrival stamp is EARLIER than the previous one (clock jitter)
  assert.ok(b.t >= a.t, `t went backwards: ${a.t} -> ${b.t}`);
  const c = push(1_030_000, 960).sample;
  assert.ok(c.t >= b.t, `t went backwards: ${b.t} -> ${c.t}`);
});
