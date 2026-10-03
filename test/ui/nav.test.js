// Menus (C-07): stick / arrows move the focus, A / Enter confirms, B / Esc goes back, the mouse hovers and clicks. The pointer of a real
// Joy-Con never selects anything. The hint line names the glyphs of the active controller.
import test from 'node:test';
import assert from 'node:assert/strict';
import { UI_TIMING } from '../../public/js/ui/ui.js';
import { makeSnapshot, makeUiHarness, providerFact, calFact } from '../../test-support/ui/fixtures.js';

function joyconMenu() {
  const h = makeUiHarness();
  h.storage.setSafetyAck();
  h.ui.notify({ type: 'ready' });
  h.ui.notify(providerFact('joycon', 'streaming'));
  h.ui.notify(calFact({ type: 'started', quick: false }));
  h.ui.notify(calFact({ type: 'done', quick: true, calibration: {}, warnings: [] }));
  h.ui.force('menu');
  h.advance(UI_TIMING.confirmLockMs + 20);
  return h;
}

test('the menu starts on Classic; the stick moves across the cards and down to the buttons; A selects', () => {
  const h = joyconMenu();
  assert.equal(h.view().focus.id, 'menu.classic');
  h.nav('right', 'joycon');
  assert.equal(h.view().focus.id, 'menu.timeattack');
  h.nav('right', 'joycon');
  assert.equal(h.view().focus.id, 'menu.zen');
  h.nav('right', 'joycon');
  assert.equal(h.view().focus.id, 'menu.zen', 'no wrap');
  h.nav('down', 'joycon');
  assert.equal(h.view().focus.id, 'menu.controller');
  h.nav('left', 'joycon');
  assert.equal(h.view().focus.id, 'menu.settings');
  h.press('confirm', 'joycon');
  assert.equal(h.state().screen, 'settings');
});

test('a Joy-Con A right after a screen change is ignored (double tap guard); Enter is not', () => {
  const h = joyconMenu();
  h.press('confirm', 'joycon');
  assert.equal(h.state().screen, 'setup');
  h.press('confirm', 'joycon');
  assert.equal(h.state().screen, 'setup', 'locked');
  h.advance(UI_TIMING.confirmLockMs + 20);
  h.press('confirm', 'joycon');
  assert.equal(h.state().screen, 'countdown');
});

test('value rows: left / right change the value (steppers repeat while held), A cycles a choice, up / down move between rows', () => {
  const h = makeUiHarness().toMenuWithSim();
  h.ui.activate('menu.settings');
  assert.equal(h.view().focus.valueRow?.key, 'sensitivity', 'F19: settings open on the first row');
  const s0 = h.storage.getSettings().sensitivity;
  h.nav('right');
  assert.equal(h.storage.getSettings().sensitivity, Number((s0 + 0.1).toFixed(3)));
  const back = h.ui.findTarget('set.back');
  h.ui.pointerMove(back.x, back.y);
  assert.equal(h.view().focus.id, 'set.back');
  // up from Back lands in a row of the right column
  h.nav('up');
  assert.equal(h.view().focus.valueRow?.key, 'reduceMotion');
  h.nav('right');
  assert.equal(h.storage.getSettings().reduceMotion, true);
  h.nav('left');
  assert.equal(h.storage.getSettings().reduceMotion, false);
  h.press('confirm');
  assert.equal(h.storage.getSettings().reduceMotion, true, 'A flips a two-option row');
  h.nav('up'); h.nav('up');
  assert.equal(h.view().focus.valueRow?.key, 'volume');
  const v0 = h.storage.getSettings().volume;
  h.ui.notify({ type: 'nav', event: { t: 0, dir: 'left', phase: 'down', source: 'keyboard' } });
  assert.equal(h.storage.getSettings().volume, Number((v0 - 0.1).toFixed(3)));
  h.advance(UI_TIMING.navRepeatDelayMs + 2 * UI_TIMING.navRepeatMs + 10);
  assert.ok(h.storage.getSettings().volume < v0 - 0.25, 'held: repeats');
  h.ui.notify({ type: 'nav', event: { t: 0, dir: 'left', phase: 'up', source: 'keyboard' } });
  const v1 = h.storage.getSettings().volume;
  h.advance(500);
  assert.equal(h.storage.getSettings().volume, v1, 'released: stops');
  h.nav('up');
  assert.equal(h.view().focus.valueRow?.key, 'crosshairColor');
  h.press('confirm');
  assert.equal(h.storage.getSettings().crosshairColor, 'yellow');
  h.nav('right'); h.nav('right'); h.nav('right');
  assert.equal(h.storage.getSettings().crosshairColor, 'magenta', 'bounded at the last option');
  h.press('confirm');
  assert.equal(h.storage.getSettings().crosshairColor, 'white', 'A wraps');
  const changes = h.intents.filter((i) => i.type === 'settingsChanged');
  assert.ok(changes.length >= 6);
  assert.ok(changes.every((c) => c.settings && typeof c.settings === 'object'));
});

test('steppers stop at their bounds without a sound', () => {
  const h = makeUiHarness().toMenuWithSim();
  h.storage.updateSettings({ triggerCompMs: 100 });
  h.ui.activate('menu.settings');
  h.clear();
  assert.equal(h.ui.activate('set.triggerCompMs.plus'), false);
  assert.equal(h.storage.getSettings().triggerCompMs, 100);
  assert.equal(h.ui.activate('set.triggerCompMs.minus'), true);
  assert.equal(h.storage.getSettings().triggerCompMs, 90);
});

test('the mouse: hovering moves the focus, a click activates; clicks on disabled targets do nothing', () => {
  const h = makeUiHarness().toMenuWithMouse();
  const ta = h.ui.findTarget('menu.timeattack');
  h.ui.pointerMove(ta.x, ta.y);
  assert.equal(h.view().focus.id, 'menu.timeattack');
  assert.equal(h.ui.pointerClick(ta.x, ta.y), true);
  assert.equal(h.state().screen, 'setup');
  assert.equal(h.ui.pointerClick(5, 5), false);
  h.ui.force('results', { roundMode: 'classic' });
  h.ui.notify({ type: 'roundOver', result: null });
  h.ui.force('safety');
  const ok = h.ui.findTarget('safety.ok');
  assert.equal(h.ui.pointerClick(ok.x, ok.y), false, 'still locked');
});

test('the Joy-Con pointer (aim) never selects a menu item, however long it rests on one', () => {
  const h = joyconMenu();
  const card = h.ui.findTarget('menu.zen');
  for (let i = 0; i < 300; i++) { h.clock.advance(16); h.step({ aim: { x: card.x, y: card.y, visible: true, trackingOk: true } }); }
  assert.equal(h.state().screen, 'menu');
  assert.equal(h.view().focus.id, 'menu.classic');
  assert.deepEqual(h.intents.filter((i) => i.type === 'startRound'), []);
});

test('the hint line names the active controller: Joy-Con glyphs, keyboard keys after a key press, fire / recentre / pause in play', () => {
  const h = joyconMenu();
  const keys = () => h.view().hint.items.map((i) => i.key);
  assert.deepEqual(keys(), ['STICK', 'A']);
  h.ui.activate('menu.settings');
  assert.deepEqual(keys(), ['STICK', 'B'], 'the first row is a stepper: change + back');
  const back = h.ui.findTarget('set.back');
  h.ui.pointerMove(back.x, back.y);
  assert.deepEqual(keys(), ['STICK', 'A', 'B']);
  h.nav('up', 'keyboard');
  assert.deepEqual(keys(), ['ARROWS', 'Enter', 'Esc'], 'a focused choice row: change, select (cycles), back');
  h.nav('up', 'keyboard'); h.nav('up', 'keyboard');
  assert.equal(h.view().focus.valueRow?.key, 'volume');
  assert.deepEqual(keys(), ['ARROWS', 'Esc'], 'a focused stepper: change + back');
  h.press('back', 'joycon');
  h.ui.activate('menu.classic');
  h.ui.activate('setup.start');
  h.advance(3 * UI_TIMING.countdownNumberMs + UI_TIMING.countdownGoMs + 32);
  assert.deepEqual(keys(), ['ZR', 'R', '+']);
  assert.equal(h.view().labels.fire, 'ZR');
  h.setSnapshot(makeSnapshot({ t: 3, phase: 'ready' }));
  h.step();
  assert.deepEqual(h.view().hint.items.map((i) => i.label), ['Pull!', 'Recentre', 'Pause']);
  h.setSnapshot(makeSnapshot({ t: 60, phase: 'flight' }));
  h.step();
  assert.deepEqual(keys(), [], 'after the first 20 s the play field is clean');
});

test('the hint line of a mouse player says "Click"', () => {
  const h = makeUiHarness().toMenuWithMouse();
  const items = h.view().hint.items;
  assert.deepEqual(items.map((i) => i.key), ['CLICK']);
});

test('safety: the focus moves to "Got it" when it unlocks', () => {
  const h = makeUiHarness();
  h.ui.notify({ type: 'ready' });
  assert.equal(h.view().focus.id, 'safety.toggle');
  h.advance(UI_TIMING.safetyWaitMs + 20);
  assert.equal(h.view().focus.id, 'safety.ok');
  h.advance(UI_TIMING.confirmLockMs);
  h.press('confirm', 'joycon');
  assert.equal(h.state().screen, 'connect');
});
