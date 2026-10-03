// The UI items of the final QA and code review (docs/qa/final): U-01 to U-09, F7, F11, F14, F16, F18, F19, F21, F25, Reduce motion mid-round.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createManualClock } from '../../public/js/shared/clock.js';
import { SCREEN } from '../../public/js/shared/contracts.js';
import { createPresentationCore } from '../../public/js/ui/presentation-core.js';
import { createStorage } from '../../public/js/ui/storage.js';
import { UI_TIMING } from '../../public/js/ui/ui.js';
import { FakeCanvas, createFakeAudio, createFakeCanvas, createFakeHud, createFakeWorld } from '../../test-support/ui/fakes.js';
import { calFact, makeSnapshot, makeUiHarness, memoryBackend, practiceEvent, providerFact, roundResult } from '../../test-support/ui/fixtures.js';

const COUNTDOWN_MS = 3 * UI_TIMING.countdownNumberMs + UI_TIMING.countdownGoMs + 32;

/** A harness with a calibrated right Joy-Con on the menu. */
function calibratedJoycon() {
  const h = makeUiHarness();
  h.storage.setSafetyAck();
  h.ui.notify({ type: 'ready' });
  h.ui.notify(providerFact('joycon', 'streaming', { side: 'R', deviceName: 'Joy-Con 2 (R)' }));
  h.ui.notify(calFact({ type: 'started', quick: false }));
  h.ui.notify(calFact({ type: 'done', quick: false, calibration: {}, warnings: [] }));
  h.step({ events: [practiceEvent('hit')] });
  assert.equal(h.state().screen, SCREEN.MENU);
  return h;
}

test('U-01 A: an uncalibrated Joy-Con on the connect screen cannot go back to the menu (no BACK button, B ignored)', () => {
  const h = makeUiHarness().toMenuWithMouse();
  h.ui.activate('menu.controller');
  assert.ok(h.ui.findTarget('connect.back'), 'with the mouse the back button is there');
  h.ui.notify(providerFact('joycon', 'connecting'));
  h.ui.notify(providerFact('joycon', 'streaming'));
  h.step();
  assert.equal(h.ui.findTarget('connect.back'), null, 'hidden while the calibration is missing');
  h.press('back', 'joycon');
  assert.equal(h.state().screen, SCREEN.CONNECT);
  h.clear();
  h.advance(UI_TIMING.autoContinueMs + 32);
  assert.equal(h.last().type, 'startCalibration');
});

test('U-01: every road to the menu or to play leads an uncalibrated Joy-Con back to the connect screen first', () => {
  const h = makeUiHarness().toMenuWithSim();
  // a Joy-Con takes over while the menu is up (no calibration yet)
  h.ui.notify(providerFact('joycon', 'streaming'));
  assert.equal(h.state().screen, SCREEN.CONNECT);
  assert.ok(h.view().toast.text, 'says why');
  h.ui.force('menu'); // debug force is the only bypass
  h.clear();
  h.ui.activate('menu.classic');
  assert.equal(h.state().screen, SCREEN.CONNECT, 'setup is gated');
  assert.deepEqual(h.intents.filter((i) => i.type === 'startRound'), []);
});

test('U-01 B: a reconnect to the OTHER Joy-Con mid-round keeps the round paused, runs the wizard and resumes it (no practice round)', () => {
  const h = calibratedJoycon();
  h.startRound('classic');
  assert.equal(h.state().gameActive, true);
  h.ui.notify(providerFact('joycon', 'lost', { side: 'R', deviceName: 'Joy-Con 2 (R)' }));
  assert.equal(h.state().overlay, 'disconnected');
  h.advance(UI_TIMING.discAutoReconnectMs + 32);
  h.ui.notify(providerFact('joycon', 'connecting', { side: 'L', deviceName: 'Joy-Con 2 (L)' }));
  h.clear();
  h.ui.notify(providerFact('joycon', 'streaming', { side: 'L', deviceName: 'Joy-Con 2 (L)' }));
  assert.ok(h.types().includes('clearCalibration'));
  assert.equal(h.last().type, 'startCalibration');
  assert.equal(h.state().overlay, null);
  assert.equal(h.state().screen, SCREEN.PAUSED);
  assert.equal(h.state().gameActive, false);
  assert.equal(h.state().resuming, false, 'never resumed without a crosshair');
  // cancelling the wizard goes back to the pause panel, still paused; Resume asks for the wizard again
  h.ui.notify(calFact({ type: 'started', quick: false }));
  h.press('back');
  assert.equal(h.state().screen, SCREEN.PAUSED);
  assert.equal(h.state().resuming, false);
  h.clear();
  h.ui.activate('pause.resume');
  assert.equal(h.last().type, 'startCalibration');
  assert.equal(h.state().resuming, false);
  // the wizard completes: back to the round with the 3-2-1, and no practice round replaces it
  h.ui.notify(calFact({ type: 'started', quick: false }));
  h.clear();
  h.ui.notify(calFact({ type: 'done', quick: false, calibration: {}, warnings: [] }));
  assert.deepEqual(h.intents.filter((i) => i.type === 'startRound'), []);
  assert.equal(h.state().screen, SCREEN.PLAYING);
  assert.equal(h.state().resuming, true);
  assert.equal(h.state().roundMode, 'classic');
});

test('F7: the release of a press made on another screen never clicks (the practice shot ends calibration over a menu card)', () => {
  const h = makeUiHarness();
  h.ui.notify({ type: 'ready', skipSafety: true });
  h.ui.notify(providerFact('sim', 'streaming'));
  h.ui.notify(calFact({ type: 'started', quick: false }));
  h.ui.notify(calFact({ type: 'done', quick: false, calibration: {}, warnings: [] }));
  const card = { x: 960, y: 565 }; // Time Attack card of the menu
  h.ui.pointerDown(card.x, card.y); // the shot
  h.step({ events: [practiceEvent('hit')] });
  assert.equal(h.state().screen, SCREEN.MENU);
  assert.equal(h.ui.pointerUp(card.x, card.y), false);
  assert.equal(h.state().screen, SCREEN.MENU);
  // a full press and release on the card does click; a press on one target and a release on another does not
  h.ui.pointerDown(card.x, card.y);
  h.ui.pointerUp(400, 565);
  assert.equal(h.state().screen, SCREEN.MENU);
  h.ui.pointerDown(card.x, card.y);
  assert.equal(h.ui.pointerUp(card.x, card.y), true);
  assert.equal(h.state().screen, SCREEN.SETUP);
});

test('U-02 and F14: on the practice round the stick reaches "Flip left and right" (A never flips before a stick push); "Calibrate again" sits clear of the trap house', () => {
  const h = calibratedJoycon();
  h.ui.notify(calFact({ type: 'started', quick: false }));
  h.ui.notify(calFact({ type: 'done', quick: false, calibration: {}, warnings: [] }));
  h.advance(UI_TIMING.confirmLockMs + 20);
  h.press('confirm', 'joycon');
  assert.equal(h.storage.getSettings().flipX, false);
  h.nav('down', 'joycon');
  assert.equal(h.view().focus.id, 'cal.flip');
  h.press('confirm', 'joycon');
  assert.equal(h.storage.getSettings().flipX, true);
  for (let i = 0; i < 3; i++) h.step({ events: [practiceEvent('lost')] });
  const retry = h.ui.findTarget('cal.retry');
  assert.ok(retry.x < 700 && retry.y < 900, 'bottom left, away from the house in the middle');
  assert.equal(h.view().focus.id, 'cal.retry', 'the suggested action takes the focus');
  h.nav('down', 'joycon');
  assert.equal(h.view().focus.id, 'cal.flip');
});

test('U-04: losing the window focus freezes the practice round until the next press, which is swallowed', () => {
  const h = calibratedJoycon();
  h.ui.notify(calFact({ type: 'started', quick: false }));
  h.ui.notify(calFact({ type: 'done', quick: false, calibration: {}, warnings: [] }));
  assert.equal(h.state().gameActive, true);
  h.ui.notify({ type: 'blur' });
  assert.equal(h.state().gameActive, false);
  assert.equal(h.state().screen, SCREEN.CALIBRATION);
  h.clear();
  h.press('fire', 'joycon');
  assert.deepEqual(h.intents, [], 'the waking press does not shoot');
  assert.equal(h.state().gameActive, true);
  h.press('fire', 'joycon');
  assert.equal(h.last().type, 'fire');
});

test('U-08: the Zen "End session" fallback never changes the screen under an open overlay', () => {
  const h = makeUiHarness().toMenuWithSim().startRound('zen');
  h.press('pause');
  h.ui.activate('pause.quit');
  h.ui.notify(providerFact('sim', 'lost'));
  assert.equal(h.state().overlay, 'disconnected');
  h.advance(UI_TIMING.zenEndFallbackMs + 100);
  assert.equal(h.state().screen, SCREEN.PAUSED);
});

test('U-09: the hint line names Resume on the pause panel and Recentre during the countdown', () => {
  const h = calibratedJoycon();
  h.ui.activate('menu.classic');
  h.ui.activate('setup.start');
  h.step();
  assert.deepEqual(h.view().hint.items.map((i) => i.label), ['Recentre']);
  h.advance(COUNTDOWN_MS);
  h.press('pause', 'joycon');
  assert.equal(h.view().hint.items.at(-1).label, 'Resume');
});

test('U-06: a stored document of another version is read but never overwritten', () => {
  const be = memoryBackend({ 'clayRush.v1': JSON.stringify({ v: 2, best: {}, settings: { volume: 0.3 }, safetyAck: true, future: { keep: 1 } }) });
  const s = createStorage({ backend: be, matchMedia: () => ({ matches: false }) });
  assert.equal(s.getSettings().volume, 0.3);
  assert.equal(s.getSafetyAck(), true);
  s.updateSettings({ volume: 0.9 });
  s.recordResult(roundResult({ score: 5 }));
  assert.equal(s.getSettings().volume, 0.9, 'kept in memory for the session');
  assert.deepEqual(JSON.parse(be.map.get('clayRush.v1')).future, { keep: 1 }, 'the newer document survives');
  assert.equal(s.isPersistent(), false);
});

test('U-07: a setting forced by a URL flag is shown locked and cannot be changed', () => {
  const storage = createStorage({ backend: memoryBackend(), matchMedia: () => ({ matches: false }), overrides: { reduceMotion: true } });
  const h = makeUiHarness({ storage }).toMenuWithSim();
  h.ui.activate('menu.settings');
  assert.equal(h.ui.findTarget('set.reduceMotion.opt.off').enabled, false);
  assert.equal(h.ui.activate('set.reduceMotion.opt.off'), false);
  assert.equal(storage.getSettings().reduceMotion, true);
});

function rig() {
  const clock = createManualClock(0);
  const canvas = new FakeCanvas();
  const world = createFakeWorld();
  const hud = createFakeHud();
  const storage = createStorage({ backend: memoryBackend(), matchMedia: () => ({ matches: false }) });
  storage.setSafetyAck();
  const p = createPresentationCore({ canvas, clock, storage, audio: createFakeAudio(), createCanvas: createFakeCanvas }, { createWorldRenderer: () => world, createHud: () => hud });
  const intents = [];
  p.ui.onIntent((i) => intents.push(i));
  let snapshot = null;
  const r = {
    p, clock, canvas, world, hud, storage, intents,
    setSnapshot(s) { snapshot = s; },
    frame(over = {}) { clock.advance(16); p.step({ nowMs: clock.now(), dtS: 0.016, snapshot, events: [], aim: { x: 700, y: 400, visible: true, trackingOk: true }, ...over }); p.draw(); },
    texts: () => canvas.ctx.texts.map((x) => x.text),
  };
  return r;
}

test('F11 and F18: the HUD reads "ZEN · <stage>" / "TIME ATTACK · <stage>" outside Classic, and "CLICK TO CALL PULL!" with the mouse', () => {
  const r = rig();
  r.p.ui.notify(providerFact('mouse', 'streaming'));
  r.p.ui.notify({ type: 'ready' });
  r.p.ui.force('playing', { roundMode: 'zen' });
  r.setSnapshot(makeSnapshot({ mode: 'zen', stage: { index: 0, id: 'hills', count: 1, name: 'GOLDEN HILLS' } }));
  r.frame();
  let d = r.hud.calls.draw.at(-1);
  assert.equal(d.stage, 'ZEN · GOLDEN HILLS');
  assert.equal(d.prompt, 'CLICK TO CALL PULL!');
  r.setSnapshot(makeSnapshot({ mode: 'timeattack', seed: 9, stage: { index: 0, id: 'alpine', count: 1, name: 'ALPINE DUSK' } }));
  r.frame();
  d = r.hud.calls.draw.at(-1);
  assert.equal(d.stage, 'TIME ATTACK · ALPINE DUSK');
  r.setSnapshot(makeSnapshot({ mode: 'classic', seed: 10, stage: { index: 1, id: 'hills', count: 3, name: 'GOLDEN HILLS' } }));
  r.frame();
  assert.equal(r.hud.calls.draw.at(-1).stage, 'STAGE 2: GOLDEN HILLS');
  assert.equal(r.hud.calls.draw.at(-1).t, r.hud.calls.draw.at(-1).t, 'one translator per mode (stable for the HUD memo)');
  r.frame();
  assert.equal(r.hud.calls.draw.at(-1).t, r.hud.calls.draw.at(-2).t);
});

test('Reduce motion switched on mid-round: settingsChanged reaches app.js and the next frame hands it to the world and the HUD', () => {
  const r = rig();
  r.p.ui.notify(providerFact('sim', 'streaming'));
  r.p.ui.notify({ type: 'ready' });
  r.p.ui.force('playing', { roundMode: 'classic' });
  r.setSnapshot(makeSnapshot());
  r.frame();
  r.p.ui.notify({ type: 'action', event: { t: 0, action: 'pause', label: 'P', source: 'keyboard' } });
  r.p.ui.activate('pause.settings');
  r.p.ui.activate('set.reduceMotion.opt.on');
  const ch = r.intents.filter((i) => i.type === 'settingsChanged').at(-1);
  assert.deepEqual(ch.patch, { reduceMotion: true });
  assert.equal(ch.settings.reduceMotion, true);
  r.p.ui.notify({ type: 'action', event: { t: 0, action: 'back', label: 'Esc', source: 'keyboard' } });
  r.p.ui.activate('pause.resume');
  r.frame();
  assert.equal(r.world.calls.update.at(-1).view.settings.reduceMotion, true);
  assert.equal(r.hud.calls.draw.at(-1).reduceMotion, true);
});

test('F25, F21, F16, F17: the menu chip names its difficulty, results are not frozen, tuning without a Joy-Con shows no verdict, Zen results name the stage', () => {
  const r = rig();
  r.storage.recordResult(roundResult({ score: 1234 }));
  r.p.ui.notify(providerFact('mouse', 'streaming'));
  r.p.ui.notify({ type: 'ready' });
  r.frame();
  assert.ok(r.texts().includes('BEST (NORMAL) 1,234'), r.texts().join('|'));
  r.p.ui.force('results', { roundMode: 'classic', result: roundResult() });
  r.frame();
  assert.ok(r.world.calls.update.at(-1).dtS > 0, 'the gun animates away behind the results card');
  r.p.ui.force('tuning');
  r.p.ui.notify({ type: 'shotFeedback', jerkPeakDps: 0, displacementPx: 0, compMs: 0, valid: true });
  r.canvas.ctx.clearTexts();
  r.frame();
  assert.ok(!r.texts().some((x) => /Steady shot/.test(x)));
  assert.equal(r.p.ui.getView().hint.items.filter((i) => i.key === 'CLICK').length, 1, 'one CLICK item');
  r.p.ui.force('results', { roundMode: 'zen', result: roundResult({ mode: 'zen', stageId: 'alpine', rank: null }) });
  r.canvas.ctx.clearTexts();
  r.frame();
  assert.equal(r.texts().filter((x) => x === 'SESSION OVER').length, 1);
  assert.ok(r.texts().includes('ALPINE DUSK'));
});

test('U-05: the disconnect overlay away from a round does not talk about a paused game', () => {
  const r = rig();
  r.p.ui.notify(providerFact('sim', 'streaming'));
  r.p.ui.notify({ type: 'ready' });
  r.frame();
  r.p.ui.notify(providerFact('sim', 'lost'));
  r.canvas.ctx.clearTexts();
  r.frame();
  assert.ok(r.texts().includes('Trying to reconnect…'));
  assert.ok(!r.texts().some((x) => /paused/i.test(x)));
});

test('results: during the count-up a new best shows the PREVIOUS best; the new value comes with the stamp, and RANK fades in after the stamp lands', () => {
  const r = rig();
  r.storage.recordResult(roundResult({ score: 1000 }));
  r.p.ui.notify(providerFact('sim', 'streaming'));
  r.p.ui.notify({ type: 'ready' });
  r.p.ui.force('playing', { roundMode: 'classic' });
  r.frame();
  r.p.ui.notify({ type: 'roundOver', result: roundResult({ score: 5000, rank: 'A' }) });
  r.canvas.ctx.clearTexts();
  r.frame();
  r.frames = (n) => { for (let i = 0; i < n; i++) r.frame(); };
  r.frames(40); // mid count-up
  const v = r.p.ui.getView().results;
  assert.equal(v.stamped, false);
  assert.equal(v.shownBest, 1000);
  assert.ok(r.texts().includes('BEST 1,000'));
  assert.ok(!r.texts().includes('BEST 5,000'), 'never the score just made');
  assert.ok(!r.texts().includes('RANK'));
  r.frames(Math.ceil((UI_TIMING.resultsCountUpMs + UI_TIMING.resultsStampMs) / 16));
  assert.equal(v.stamped, true);
  r.canvas.ctx.clearTexts();
  r.frame();
  assert.ok(r.texts().includes('NEW BEST!'));
  assert.ok(!r.texts().includes('BEST 5,000'));
  r.frames(30);
  r.canvas.ctx.clearTexts();
  r.frame();
  const cap = r.canvas.ctx.texts.find((x) => x.text === 'RANK');
  assert.ok(cap && cap.alpha > 0.99, 'the caption is there once the stamp has landed');
});
