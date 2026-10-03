import test from 'node:test';
import assert from 'node:assert/strict';
import * as C from '../../public/js/shared/contracts.js';
import { Emitter } from '../../public/js/shared/emitter.js';
import { createManualClock, createRealClock } from '../../public/js/shared/clock.js';
import { mulberry32, hash32, createRng, SEED_XOR } from '../../public/js/shared/rng.js';
import { FIELD, fitRect, clientToPlayfield, playfieldToClient } from '../../public/js/shared/playfield.js';

test('contract enums are frozen and string-valued', () => {
  for (const name of ['PROVIDER_KIND', 'SIDE', 'CONN_STATE', 'INPUT_ERROR', 'ACTION', 'GAME_MODE', 'ROUND_MODE', 'GAME_PHASE', 'DIFFICULTY', 'STAGE_ID', 'TARGET_KIND', 'TARGET_FRAME', 'HOUSE_ID', 'LOST_REASON', 'END_REASON', 'RANK', 'GAME_EVENT', 'SCREEN', 'CAL_STEP_FAIL', 'MOTION_WARNING']) {
    assert.ok(Object.isFrozen(C[name]), `${name} must be frozen`);
    for (const v of Object.values(C[name])) assert.equal(typeof v, 'string');
  }
  assert.ok(Object.isFrozen(C.BUTTON_NAMES));
  assert.equal(new Set(C.BUTTON_NAMES).size, C.BUTTON_NAMES.length);
  assert.equal(C.CONTRACT_VERSION, 1);
});

test('Emitter: order, unsubscribe, once, handler errors are isolated', () => {
  const e = new Emitter();
  const seen = [];
  const off = e.on('a', (p) => seen.push(['1', p]));
  e.on('a', () => { throw new Error('boom'); });
  e.on('a', (p) => seen.push(['3', p]));
  e.once('a', (p) => seen.push(['once', p]));
  const origError = console.error;
  console.error = () => {};
  try {
    e.emit('a', 1);
    e.emit('a', 2);
  } finally {
    console.error = origError;
  }
  assert.deepEqual(seen, [['1', 1], ['3', 1], ['once', 1], ['1', 2], ['3', 2]]);
  off();
  assert.equal(e.listenerCount('a'), 2);
  e.removeAll();
  assert.equal(e.listenerCount('a'), 0);
});

test('manual clock only moves with advance and refuses to go backwards', () => {
  const c = createManualClock(100);
  assert.equal(c.manual, true);
  assert.equal(c.now(), 100);
  c.advance(4);
  assert.equal(c.now(), 104);
  assert.throws(() => c.advance(-1), RangeError);
  assert.throws(() => c.set(50), RangeError);
  const r = createRealClock({ now: () => 7 });
  assert.equal(r.manual, false);
  assert.equal(r.now(), 7);
});

test('rng: deterministic, uniform-ish, streams are independent', () => {
  const a = mulberry32(42), b = mulberry32(42);
  for (let i = 0; i < 100; i++) assert.equal(a(), b());
  const r = createRng(7);
  let sum = 0;
  for (let i = 0; i < 20000; i++) {
    const v = r.next();
    assert.ok(v >= 0 && v < 1);
    sum += v;
  }
  assert.ok(Math.abs(sum / 20000 - 0.5) < 0.01);
  assert.notEqual(hash32(1, 0), hash32(1, 1));
  assert.notEqual(hash32(1, 0), hash32(2, 0));
  assert.equal(hash32(123, 9), hash32(123, 9));
  assert.ok(hash32(5, 5) >= 0 && hash32(5, 5) <= 0xffffffff);
  const w = createRng(1);
  const counts = [0, 0, 0];
  for (let i = 0; i < 30000; i++) counts[w.weightedIndex([1, 2, 7])]++;
  assert.ok(counts[2] > counts[1] && counts[1] > counts[0]);
  assert.equal(new Set(Object.values(SEED_XOR)).size, 3);
  for (let i = 0; i < 1000; i++) { const n = r.int(3, 5); assert.ok(n >= 3 && n <= 5); }
});

test('playfield: aspect-fit and client <-> playfield round trip', () => {
  assert.deepEqual([FIELD.w, FIELD.h], [1920, 1080]);
  const fit = fitRect(1280, 1000);
  assert.ok(Math.abs(fit.scale - 1280 / 1920) < 1e-12);
  assert.ok(fit.offsetY > 0 && fit.offsetX === 0);
  const rect = { left: 10, top: 20, width: 2000, height: 1080 };
  for (const [x, y] of [[0, 0], [960, 540], [1920, 1080], [123.4, 987.6]]) {
    const c = playfieldToClient(rect, x, y);
    const p = clientToPlayfield(rect, c.x, c.y);
    assert.ok(Math.abs(p.x - x) < 1e-9 && Math.abs(p.y - y) < 1e-9);
  }
  const outside = clientToPlayfield(rect, rect.left - 500, rect.top - 500, { clamp: true });
  assert.deepEqual(outside, { x: 0, y: 0 });
});
