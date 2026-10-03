// C-04: the UI is the only consumer of actions. `fire` becomes a fire intent only while the game is active; in phase 'ready' confirm also
// fires ("Pull!"). Shots never leak from menus, the countdown, the pause panel, a resume countdown or an overlay.
import test from 'node:test';
import assert from 'node:assert/strict';
import { UI_TIMING } from '../../public/js/ui/ui.js';
import { calFact, makeSnapshot, makeUiHarness, providerFact } from '../../test-support/ui/fixtures.js';

const fires = (h) => h.intents.filter((i) => i.type === 'fire');

test('fire in play emits {type:"fire", t, source} with the press time of the action', () => {
  const h = makeUiHarness().toMenuWithSim().startRound('classic');
  h.setSnapshot(makeSnapshot({ phase: 'flight' }));
  h.step();
  h.clear();
  h.ui.notify({ type: 'action', event: { t: 12345.5, action: 'fire', label: 'ZR', source: 'joycon' } });
  assert.deepEqual(fires(h), [{ type: 'fire', t: 12345.5, source: 'joycon' }]);
  h.ui.notify({ type: 'action', event: { t: 12400, action: 'fire', label: 'Click', source: 'mouse' } });
  assert.equal(fires(h).length, 2);
  assert.equal(fires(h)[1].source, 'mouse');
});

test('confirm calls "Pull!" (a fire intent) only in phase ready', () => {
  const h = makeUiHarness().toMenuWithSim().startRound('classic');
  h.setSnapshot(makeSnapshot({ phase: 'ready' }));
  h.step();
  h.clear();
  h.ui.notify({ type: 'action', event: { t: 77, action: 'confirm', label: 'A', source: 'joycon' } });
  assert.deepEqual(fires(h), [{ type: 'fire', t: 77, source: 'joycon' }]);
  h.setSnapshot(makeSnapshot({ phase: 'flight' }));
  h.step();
  h.clear();
  h.press('confirm', 'keyboard');
  assert.deepEqual(fires(h), []);
});

test('no fire intent outside an active game: menus, setup, countdown, pause, resume countdown, overlays, results, tuning', () => {
  const h = makeUiHarness().toMenuWithSim();
  const tryFire = () => h.press('fire', 'joycon');
  tryFire();
  h.ui.activate('menu.classic');
  tryFire();
  h.ui.activate('setup.start');
  tryFire(); // countdown
  h.advance(3 * UI_TIMING.countdownNumberMs + UI_TIMING.countdownGoMs + 32);
  h.press('pause');
  tryFire(); // paused
  h.ui.activate('pause.resume');
  tryFire(); // resuming
  h.advance(3 * UI_TIMING.resumeNumberMs + 32);
  h.press('pause');
  h.ui.activate('pause.quit');
  tryFire(); // confirm overlay
  h.ui.activate('confirm.yes');
  h.ui.activate('menu.settings');
  h.ui.activate('set.tune');
  tryFire(); // tuning: a test shot marker, no intent
  assert.equal(h.view().tune.marks.length, 1);
  assert.deepEqual(fires(h), []);
});

test('fire is live in calibration step 4 (the practice round) and not before', () => {
  const h = makeUiHarness();
  h.ui.notify({ type: 'ready', skipSafety: true });
  h.ui.notify(providerFact('joycon', 'streaming'));
  h.ui.notify(calFact({ type: 'started', quick: false }));
  h.press('fire', 'joycon');
  assert.deepEqual(fires(h), []);
  h.ui.notify(calFact({ type: 'done', quick: false, calibration: {}, warnings: [] }));
  h.press('fire', 'joycon');
  assert.equal(fires(h).length, 1);
});

test('the disconnect overlay stops fire', () => {
  const h = makeUiHarness();
  h.ui.notify({ type: 'ready', skipSafety: true });
  h.ui.notify(providerFact('sim', 'streaming'));
  h.startRound('classic');
  h.ui.notify(providerFact('sim', 'lost'));
  assert.equal(h.state().overlay, 'disconnected');
  h.press('fire', 'sim');
  assert.deepEqual(fires(h), []);
});

test('shotFeedback is shown on the tuning screen; a mouse press over a button is not a test shot', () => {
  const h = makeUiHarness().toMenuWithMouse();
  h.ui.activate('menu.settings');
  h.ui.activate('set.tune');
  h.ui.notify({ type: 'shotFeedback', jerkPeakDps: 210.4, displacementPx: 7.2, compMs: 40, valid: true });
  assert.deepEqual({ ...h.view().tune.lastShot, at: 0 }, { jerkPeakDps: 210.4, displacementPx: 7.2, compMs: 40, valid: true, at: 0 });
  const back = h.ui.findTarget('tune.back');
  h.ui.pointerMove(back.x, back.y);
  h.press('fire', 'mouse');
  assert.equal(h.view().tune.marks.length, 0);
  h.ui.pointerMove(960, 500);
  h.press('fire', 'mouse');
  assert.equal(h.view().tune.marks.length, 1);
});

test('the tuning screen reads the pointer speed from aim.speedDps (or estimates it)', () => {
  const h = makeUiHarness().toMenuWithSim();
  h.ui.activate('menu.settings');
  h.ui.activate('set.tune');
  for (let i = 0; i < 30; i++) { h.clock.advance(16); h.step({ aim: { x: 960, y: 540, visible: true, trackingOk: true, speedDps: 100 } }); }
  assert.ok(Math.abs(h.view().tune.speedDps - 100) < 1);
  assert.equal(h.view().tune.approx, false);
  let x = 900;
  for (let i = 0; i < 30; i++) { x += 8; h.clock.advance(16); h.step({ dtS: 0.016, aim: { x, y: 540, visible: true, trackingOk: true } }); }
  assert.equal(h.view().tune.approx, true);
  assert.ok(h.view().tune.speedDps > 20);
});
