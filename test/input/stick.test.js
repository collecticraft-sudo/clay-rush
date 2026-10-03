// The analog stick as the menu pointer (input/stick.js, docs/contract-notes.md "Stick navigation"): parsing, the per-session centre, the dead zone, the
// edge-triggered flicks with hysteresis, the Left unit, and the arrow keys. The centre and the noise are MEASURED on the real recording
// (recordings/imu-2026-09-30T18-42-24.jsonl, one Joy-Con 2 Right); the full travel of the stick, its direction and the Left unit are
// UNVERIFIED-ON-HARDWARE (the numbers of INPUT_CONFIG.stick say which are assumed).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createStickTracker, dominantDir, normalizeStick } from '../../public/js/input/stick.js';
import { createReportStream } from '../../public/js/input/report-stream.js';
import { buildInputReport } from '../../public/js/input/joycon2-build.js';
import { hexToBytes, parseInputReport } from '../../public/js/input/joycon2-parse.js';
import { INPUT_CONFIG } from '../../public/js/input/input-config.js';
import { createKeyboardActions } from '../../public/js/input/index.js';
import { createManualClock } from '../../public/js/shared/clock.js';
import { assertValid } from '../../public/js/shared/validate.js';
import { RECORDING_FILE } from '../../test-support/motion/real-recording.js';
import { makeEvent } from '../../test-support/input/fake-dom.js';

const CFG = INPUT_CONFIG.stick;

// ---------------------------------------------------------------------------------------------------------------- the real recording

const rows = readFileSync(RECORDING_FILE, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.hex);
const byStep = (name) => rows.filter((r) => r.step === name).map((r) => parseInputReport(hexToBytes(r.hex), 'R'));
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const sd = (a) => Math.sqrt(mean(a.map((v) => (v - mean(a)) ** 2)));

test('real recording: the Right unit stick field is a 12-bit pair that rests at about 1998 / 2007 (not 2047), with a noise of about half a LSB; the unused left field is a constant 2047', () => {
  const rest = byStep('rest_table');
  assert.equal(rest.length, 399);
  const xs = rest.map((r) => r.stickFields.right.x);
  const ys = rest.map((r) => r.stickFields.right.y);
  // MEASURED: the numbers quoted in docs/contract-notes.md and INPUT_CONFIG.stick
  assert.ok(Math.abs(mean(xs) - 1998.4) < 0.1, `rest x ${mean(xs)}`);
  assert.ok(Math.abs(mean(ys) - 2006.8) < 0.1, `rest y ${mean(ys)}`);
  assert.ok(sd(xs) < 0.7 && sd(ys) < 0.6, `noise sd ${sd(xs).toFixed(2)} / ${sd(ys).toFixed(2)}`);
  assert.deepEqual([Math.min(...xs), Math.max(...xs)], [1996, 2001]);
  assert.deepEqual([Math.min(...ys), Math.max(...ys)], [2006, 2008]);
  assert.ok(xs.every((v) => v >= 0 && v <= 4095) && ys.every((v) => v >= 0 && v <= 4095));
  for (const r of rows) {
    const p = parseInputReport(hexToBytes(r.hex), 'R');
    assert.deepEqual(p.stickFields.left, { x: 2047, y: 2047 }, 'the unused field of a Right unit never moves');
    assert.deepEqual(p.stick, p.stickFields.right, 'side R reports the right field');
  }
  // the nominal 12-bit centre is 49 and 40 LSB away, which is 3 % of the assumed half range: far inside the dead zone, but estimated anyway
  assert.ok(Math.abs(mean(xs) - CFG.nominalCentre) / CFG.halfRange < 0.04);
});

test('real recording: the centre is estimated from the first reports (12 of them) and no flick is ever made while the stick is untouched', () => {
  for (const step of ['rest_table', 'hold_still', 'table_spin_360', 'return_still']) {
    const t = createStickTracker({ side: 'R' });
    let flicks = 0;
    let centredAt = null;
    const reps = byStep(step);
    reps.forEach((r, i) => {
      const { state, events } = t.push(r.stickFields);
      flicks += events.length;
      if (state.centred && centredAt === null) centredAt = i + 1;
    });
    assert.equal(flicks, 0, `${step}: the untouched stick makes no move`);
    assert.ok(centredAt !== null && centredAt <= 40, `${step}: the centre is known after ${centredAt} reports`);
    // a window of reports that agree within 24 LSB is all it takes: the untouched rest step needs exactly the window, the others (the thumb is still
    // leaving the stick in the first reports of return_still) a few more
    if (step === 'rest_table') assert.equal(centredAt, CFG.centre.window, 'at rest: after exactly 12 reports (about 0.4 s of the real 33 Hz stream)');
  }
  const t = createStickTracker({ side: 'R' });
  let last;
  for (const r of byStep('rest_table')) last = t.push(r.stickFields).state;
  assert.ok(Math.abs(last.centre.x - 1998.4) < 1.5 && Math.abs(last.centre.y - 2006.8) < 1.5, `centre ${last.centre.x}, ${last.centre.y}`);
  assert.ok(last.mag < 0.01 && last.deadZone && last.armed && last.held === null);
});

test('real recording: the whole file through the real report stream, side R, is deterministic and every flick is a clean press/release pair', () => {
  const run = () => {
    const events = [];
    const stream = createReportStream({ side: 'R', emit: (type, p) => { if (type === 'nav') events.push(p); } });
    rows.forEach((r, i) => stream.push(hexToBytes(r.hex), 1000 + i * 30));
    return events;
  };
  const a = run();
  assert.deepEqual(run(), a, 'deterministic');
  // presses and releases alternate, a release always names the direction that was pressed
  let held = null;
  for (const e of a) {
    assertValid('NavEvent', e);
    assert.equal(e.source, 'joycon');
    if (e.phase === 'down') { assert.equal(held, null, 'no press while one is held (edge-triggered)'); held = e.dir; } else { assert.equal(held, e.dir); held = null; }
  }
  // while the owner handled the controller the thumb brushed the stick now and then (x down to 726, y up to 2984): a few flicks, not a stream of them
  const downs = a.filter((e) => e.phase === 'down').length;
  assert.ok(downs > 0 && downs < 60, `${downs} flicks in 140 s of handling`);
});

// ---------------------------------------------------------------------------------------------------------------- normalising and flicks

const field = (x, y) => ({ left: { x: 2047, y: 2047 }, right: { x, y } });
const C = { x: 2000, y: 2000 };

/** A tracker already centred at (2000, 2000). */
function centred(side = 'R') {
  const t = createStickTracker({ side });
  for (let i = 0; i < CFG.centre.window; i++) t.push(field(C.x + (i % 2), C.y));
  return t;
}

test('normalisation: (raw - centre) / half range, clamped to -1..1, y positive = up; the dominant direction wins and an exact tie is horizontal', () => {
  const n = normalizeStick({ x: C.x + 750, y: C.y - 300 }, C, CFG);
  assert.ok(Math.abs(n.x - 0.5) < 1e-9 && Math.abs(n.y + 0.2) < 1e-9);
  assert.equal(normalizeStick({ x: 4095, y: 0 }, C, CFG).x, 1);
  assert.equal(normalizeStick({ x: 4095, y: 0 }, C, CFG).y, -1);
  assert.equal(normalizeStick({ x: C.x, y: C.y + 600 }, C, { ...CFG, yUp: -1 }).y < 0, true, 'yUp -1 flips the vertical axis');
  assert.equal(dominantDir(0.6, 0.2), 'right');
  assert.equal(dominantDir(-0.6, 0.2), 'left');
  assert.equal(dominantDir(0.2, 0.6), 'up');
  assert.equal(dominantDir(0.2, -0.6), 'down');
  assert.equal(dominantDir(0.5, 0.5), 'right');
  assert.equal(dominantDir(0, 0), null);
});

test('one flick is one move: the press fires at the move threshold, nothing more until the stick is back below the re-arm level, then the release', () => {
  const t = centred();
  const push = (dx, dy) => t.push(field(C.x + dx, C.y + dy)).events.map((e) => `${e.phase}:${e.dir}`);
  const px = (n) => Math.round(n * CFG.halfRange);
  assert.deepEqual(push(px(0.2), 0), [], 'inside the dead zone');
  assert.deepEqual(push(px(0.5), 0), [], 'past the dead zone but under the move threshold: still nothing');
  assert.deepEqual(push(px(0.56), 0), ['down:right'], 'the flick');
  for (let i = 0; i < 40; i++) assert.deepEqual(push(px(0.9), 0), [], 'a long push never fires again');
  assert.deepEqual(push(px(0.4), 0), [], 'back to 0.4: still above the re-arm level (hysteresis), still held');
  assert.equal(t.getState().held, 'right');
  assert.deepEqual(push(px(0.56), 0), [], 'pushing again without having let go moves nothing');
  assert.deepEqual(push(px(0.29), 0), ['up:right'], 'below the re-arm level: released');
  assert.deepEqual(push(px(0.56), 0), ['down:right'], 'and armed again: the next flick fires');
});

test('turning the stick round without letting go is not a second move: the repeat of the first stops, nothing fires until the stick has been near the centre', () => {
  const t = centred();
  const push = (dx, dy) => t.push(field(C.x + dx, C.y + dy)).events.map((e) => `${e.phase}:${e.dir}`);
  assert.deepEqual(push(1000, 0), ['down:right']);
  assert.deepEqual(push(0, 1000), ['up:right'], 'now mostly up: the held direction is over (the auto-repeat stops) ...');
  assert.deepEqual(push(0, 1100), [], '... but there is no "up" flick');
  assert.deepEqual(push(0, 100), [], 'back to the centre ...');
  assert.deepEqual(push(0, 1000), ['down:up'], '... and now the next flick counts');
  assert.deepEqual(push(0, 0), ['up:up']);
});

test('all four directions, with the raw y of a stick pushed up being larger than the centre (yUp 1)', () => {
  for (const [dx, dy, dir] of [[900, 0, 'right'], [-900, 0, 'left'], [0, 900, 'up'], [0, -900, 'down'], [900, 300, 'right'], [-300, 900, 'up']]) {
    const t = centred();
    assert.deepEqual(t.push(field(C.x + dx, C.y + dy)).events, [{ phase: 'down', dir }], `${dx}, ${dy}`);
  }
});

test('the centre estimate: a stick touched during the first reports is not taken as the centre, one held to a side never is, one at rest is within a LSB', () => {
  // a thumb on the stick from the first report: the window never agrees, the nominal centre is used and nothing breaks
  const t = createStickTracker({ side: 'R' });
  for (let i = 0; i < 40; i++) t.push(field(2047 + (i % 2) * 300, 2047));
  assert.equal(t.getState().centred, false);
  assert.deepEqual(t.getState().centre, { x: CFG.nominalCentre, y: CFG.nominalCentre });
  // let go: 12 stable reports later it is estimated
  for (let i = 0; i < CFG.centre.window; i++) t.push(field(1998 + (i % 3), 2007));
  assert.equal(t.getState().centred, true);
  assert.ok(Math.abs(t.getState().centre.x - 1999) < 1 && Math.abs(t.getState().centre.y - 2007) < 0.01);
  // held steadily to one side (900 LSB off): stable, but beyond maxOffset, so not a centre
  const held = createStickTracker({ side: 'R' });
  for (let i = 0; i < 60; i++) held.push(field(2047 + 900, 2047));
  assert.equal(held.getState().centred, false);
  assert.equal(held.getState().held, 'right', 'and it is a held flick, from the nominal centre');
  // a reset (new link) forgets everything
  t.reset();
  assert.equal(t.getState(), null);
  assert.equal(t.push(field(2047, 2047)).state.centred, false);
});

test('side: R reads the right field, L the left field, "?" follows whichever field has left the sentinel (the unused field of a unit reads 2047 / 2047)', () => {
  const left = { left: { x: 2047 + 1000, y: 2047 }, right: { x: 2047, y: 2047 } };
  const right = { left: { x: 2047, y: 2047 }, right: { x: 2047 + 1000, y: 2047 } };
  const l = createStickTracker({ side: 'L' });
  assert.deepEqual(l.push(left).events, [{ phase: 'down', dir: 'right' }]);
  assert.deepEqual(createStickTracker({ side: 'L' }).push(right).events, [], 'a Left unit ignores the right field');
  assert.deepEqual(createStickTracker({ side: 'R' }).push(left).events, [], 'a Right unit ignores the left field');
  assert.deepEqual(createStickTracker({ side: '?' }).push(right).events, [{ phase: 'down', dir: 'right' }], 'unknown side, Right unit');
  assert.deepEqual(createStickTracker({ side: '?' }).push(left).events, [{ phase: 'down', dir: 'right' }], 'unknown side, Left unit (the right field is the sentinel)');
  const t = createStickTracker({ side: 'R' });
  t.push(right);
  t.setSide('L');
  assert.equal(t.getState(), null, 'a different unit starts over');
});

test('through the real parser: buildInputReport with a stick field and a button comes out of the report stream as nav and action inputs', () => {
  const events = [];
  const stream = createReportStream({ side: 'R', emit: (type, p) => events.push([type, p]) });
  let ts = 1000000;
  const push = (extra = {}) => stream.push(buildInputReport({ imuTimestampUs: (ts += 15000), counter: ts / 1000, accelRaw: { x: 0, y: 0, z: 4096 }, rightField: { x: 1998, y: 2007 }, ...extra }), ts / 1000);
  for (let i = 0; i < 14; i++) push();
  push({ rightField: { x: 1998 + 1400, y: 2007 } });
  push({ rightField: { x: 1998, y: 2007 }, pressed: ['A'] });
  const nav = events.filter((e) => e[0] === 'nav').map((e) => e[1]);
  assert.deepEqual(nav.map((n) => `${n.phase}:${n.dir}`), ['down:right', 'up:right']);
  assert.ok(nav[0].nx > 0.9 && Math.abs(nav[0].ny) < 0.01);
  assert.deepEqual(events.filter((e) => e[0] === 'buttons').at(-1)[1].down, ['A']);
  assert.ok(stream.getStick().centred);
  // the stream order: packet, buttons, nav, sample
  const order = events.map((e) => e[0]);
  assert.ok(order.indexOf('nav') < order.indexOf('sample', order.indexOf('nav')), 'nav comes before the sample of the same report');
});

// ---------------------------------------------------------------------------------------------------------------- the arrow keys

test('arrow keys are the same navigation events as the stick: a press is `down`, the key release is `up`, held keys do not repeat, the page does not scroll', () => {
  const clock = createManualClock(0);
  const target = { listeners: {}, addEventListener(t, fn) { (this.listeners[t] ??= []).push(fn); }, removeEventListener() {} };
  const kb = createKeyboardActions({ clock, target });
  const got = [];
  kb.on('nav', (e) => got.push(e));
  const fire = (type, key, extra = {}) => { const ev = makeEvent(type, { key, ...extra }); target.listeners[type].forEach((fn) => fn(ev)); return ev; };
  const ev = fire('keydown', 'ArrowLeft');
  assert.equal(ev.defaultPrevented, true);
  fire('keydown', 'ArrowLeft', { repeat: true });
  fire('keyup', 'ArrowLeft');
  fire('keydown', 'ArrowUp');
  fire('keydown', 'ArrowDown', { ctrlKey: true });
  assert.deepEqual(got.map((e) => `${e.phase}:${e.dir}`), ['down:left', 'up:left', 'down:up']);
  for (const e of got) assertValid('NavEvent', e);
  assert.ok(got.every((e) => e.source === 'keyboard'));
  const actions = [];
  kb.on('action', (a) => actions.push(a.action));
  fire('keydown', 'Enter');
  fire('keydown', 'Escape');
  assert.deepEqual(actions, ['confirm', 'back'], 'Enter and Escape are the select and back keys');
});
