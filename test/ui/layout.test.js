// Layouts: every target is at least 84 px, inside the playfield, clear of the hint line, never overlapping another; and from the default focus
// the stick reaches EVERY enabled item of every screen and overlay.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFocusUnits, moveFocus, nextFocus, unitOfTarget } from '../../public/js/ui/focus.js';
import { HINT_LINE } from '../../public/js/ui/layout-data.js';
import { UI_TIMING } from '../../public/js/ui/ui.js';
import { calFact, makeSnapshot, makeUiHarness, nativeFact, practiceEvent, probeFact, providerFact, roundResult } from '../../test-support/ui/fixtures.js';

/** Every screen / overlay variant worth checking, as a function that puts a harness there. */
const VARIANTS = {
  safety: (h) => { h.ui.force('safety'); h.advance(UI_TIMING.safetyWaitMs + 20); },
  'connect (Web Bluetooth)': (h) => { h.ui.force('connect'); },
  'connect (closed chooser)': (h) => {
    h.ui.force('connect');
    h.ui.notify(providerFact('joycon', 'error', { error: { code: 'cancelled', message: 'm', retryable: true, at: 0 } }));
  },
  'connect (from the menu, Joy-Con connected and calibrated)': (h) => {
    h.ui.notify(providerFact('joycon', 'streaming'));
    h.ui.notify(calFact({ type: 'started', quick: true }));
    h.ui.notify(calFact({ type: 'done', quick: true, calibration: {}, warnings: [] }));
    h.ui.force('menu');
    h.ui.activate('menu.controller');
  },
  'connect (native bridge)': (h) => { h.ui.notify(probeFact('done')); h.ui.force('connect'); },
  'connect (native bridge, busy)': (h) => { h.ui.notify(probeFact('done')); h.ui.force('connect'); h.ui.notify(nativeFact('connecting')); },
  'calibration step 1 (calibrated before)': (h) => {
    h.ui.notify(providerFact('joycon', 'streaming'));
    h.ui.notify(calFact({ type: 'started', quick: true }));
    h.ui.notify(calFact({ type: 'done', quick: true, calibration: {}, warnings: [] }));
    h.ui.notify(calFact({ type: 'started', quick: false }));
  },
  'calibration step 4 (try again)': (h) => {
    h.ui.notify(providerFact('joycon', 'streaming'));
    h.ui.notify(calFact({ type: 'started', quick: false }));
    h.ui.notify(calFact({ type: 'done', quick: false, calibration: {}, warnings: [] }));
    for (let i = 0; i < 3; i++) h.step({ events: [practiceEvent('lost')] });
  },
  menu: (h) => { h.ui.force('menu'); },
  'setup classic': (h) => { h.ui.force('setup', { mode: 'classic' }); },
  'setup timeattack': (h) => { h.ui.force('setup', { mode: 'timeattack' }); },
  'setup zen': (h) => { h.ui.force('setup', { mode: 'zen' }); },
  settings: (h) => { h.ui.force('settings'); },
  tuning: (h) => { h.ui.force('tuning'); },
  best: (h) => { h.ui.force('best'); },
  paused: (h) => { h.ui.force('paused', { roundMode: 'classic' }); },
  results: (h) => { h.ui.force('results', { roundMode: 'classic', result: roundResult() }); h.advance(3000); },
  'confirm overlay': (h) => { h.ui.force('settings'); h.ui.activate('set.reset'); },
  'disconnected overlay (failed)': (h) => {
    h.ui.notify(providerFact('joycon', 'streaming'));
    h.ui.notify(providerFact('joycon', 'lost'));
    h.advance(UI_TIMING.discAutoReconnectMs + UI_TIMING.discNoProgressMs + 64);
  },
  'disconnected overlay (native, reconnecting)': (h) => {
    h.ui.notify(nativeFact('streaming'));
    h.ui.notify(nativeFact('lost'));
    h.ui.activate('disc.retry');
    h.ui.notify(nativeFact('connecting'));
  },
};

function harnessAt(name) {
  const h = makeUiHarness().toMenuWithSim();
  h.setSnapshot(makeSnapshot());
  VARIANTS[name](h);
  h.step();
  return h;
}

const box = (tg) => ({ x0: tg.x - tg.w / 2, y0: tg.y - tg.h / 2, x1: tg.x + tg.w / 2, y1: tg.y + tg.h / 2 });

for (const name of Object.keys(VARIANTS)) {
  test(`layout of ${name}: sizes, bounds, no overlaps, clear of the hint line`, () => {
    const h = harnessAt(name);
    const targets = h.ui.getTargets();
    assert.ok(targets.length > 0, 'something to select');
    for (const tg of targets) {
      const b = box(tg);
      assert.ok(tg.h >= 84 && tg.w >= 84, `${tg.id} is at least 84 px (${tg.w} x ${tg.h})`);
      assert.ok(b.x0 >= 0 && b.x1 <= 1920 && b.y0 >= 0, `${tg.id} inside the field`);
      assert.ok(b.y1 <= HINT_LINE.y - HINT_LINE.h / 2 - 2, `${tg.id} clear of the hint line (bottom ${b.y1})`);
    }
    for (let i = 0; i < targets.length; i++) {
      for (let j = i + 1; j < targets.length; j++) {
        const a = box(targets[i]);
        const b = box(targets[j]);
        const overlap = a.x0 < b.x1 - 0.5 && b.x0 < a.x1 - 0.5 && a.y0 < b.y1 - 0.5 && b.y0 < a.y1 - 0.5;
        assert.ok(!overlap, `${targets[i].id} overlaps ${targets[j].id}`);
      }
    }
  });

  test(`focus of ${name}: the stick reaches every enabled item from the default focus`, () => {
    const h = harnessAt(name);
    const units = h.ui.getUnits();
    if (!units.length) return; // nothing selectable with the stick on this variant (calibration step 1 without a quick button, ...)
    const start = h.view().focus.id;
    assert.ok(start, 'a default focus exists');
    const seen = new Set([start]);
    const queue = [start];
    while (queue.length) {
      const id = queue.shift();
      for (const dir of ['up', 'down', 'left', 'right']) {
        const next = nextFocus(units, id, dir);
        if (next && !seen.has(next.id)) { seen.add(next.id); queue.push(next.id); }
      }
    }
    const missing = units.filter((u) => u.enabled && !seen.has(u.id)).map((u) => u.id);
    assert.deepEqual(missing, [], `unreachable from ${start}`);
  });
}

test('focus units: the cells of a value row form one unit; left / right never leave a row', () => {
  const units = buildFocusUnits([
    { id: 'a', shape: 'rect', x: 100, y: 100, w: 100, h: 100 },
    { id: 'set.v.minus', shape: 'rect', x: 400, y: 100, w: 84, h: 84, row: 'v', rowType: 'stepper', span: [300, 900] },
    { id: 'set.v.plus', shape: 'rect', x: 800, y: 100, w: 84, h: 84, row: 'v', rowType: 'stepper', span: [300, 900] },
    { id: 'b', shape: 'rect', x: 600, y: 400, w: 200, h: 100, enabled: false },
    { id: 'c', shape: 'rect', x: 600, y: 600, w: 200, h: 100 },
  ]);
  assert.deepEqual(units.map((u) => u.id), ['a', 'row:v', 'b', 'c']);
  assert.deepEqual(units[1].cells, ['set.v.minus', 'set.v.plus']);
  assert.equal(unitOfTarget(units, 'set.v.plus').id, 'row:v');
  assert.equal(nextFocus(units, 'row:v', 'left'), null);
  assert.equal(moveFocus(units, 'row:v', 'left').id, 'a');
  assert.equal(nextFocus(units, 'row:v', 'down').id, 'c', 'disabled units are skipped');
  assert.equal(nextFocus(units, 'c', 'down'), null, 'no wrap');
});
