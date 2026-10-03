// The UI state machine: every screen and overlay transition of docs/architecture.md 8.2 and the intents it emits (8.3).
import test from 'node:test';
import assert from 'node:assert/strict';
import { SCREEN } from '../../public/js/shared/contracts.js';
import { UI_TIMING } from '../../public/js/ui/ui.js';
import { calFact, makeSnapshot, makeUiHarness, nativeFact, practiceEvent, providerFact, roundResult } from '../../test-support/ui/fixtures.js';

const COUNTDOWN_MS = 3 * UI_TIMING.countdownNumberMs + UI_TIMING.countdownGoMs + 32;

test('boot -> safety (first run) -> connect; the "Got it" button unlocks after the reading time', () => {
  const h = makeUiHarness();
  assert.equal(h.state().screen, SCREEN.BOOT);
  h.ui.notify({ type: 'ready' });
  assert.equal(h.state().screen, SCREEN.SAFETY);
  assert.equal(h.ui.activate('safety.ok'), false, 'locked while the page is read');
  h.advance(UI_TIMING.safetyWaitMs + 20);
  assert.equal(h.ui.activate('safety.toggle'), true);
  assert.equal(h.storage.getSettings().reduceFlash, true);
  assert.equal(h.ui.activate('safety.ok'), true);
  assert.equal(h.state().screen, SCREEN.CONNECT);
  assert.equal(h.storage.getSafetyAck(), true);
});

test('ready with the safety acknowledged (or skipSafety) goes to connect, or to the menu when a simulator / mouse already streams', () => {
  const a = makeUiHarness();
  a.ui.notify({ type: 'ready', skipSafety: true });
  assert.equal(a.state().screen, SCREEN.CONNECT);
  const b = makeUiHarness().toMenuWithSim();
  assert.equal(b.state().screen, SCREEN.MENU);
  const c = makeUiHarness().toMenuWithMouse();
  assert.equal(c.state().screen, SCREEN.MENU);
});

test('connect: simulator and mouse buttons emit connect and the streaming provider opens the menu', () => {
  const h = makeUiHarness();
  h.ui.notify({ type: 'ready', skipSafety: true });
  h.ui.activate('connect.sim');
  assert.deepEqual(h.last('connect'), { type: 'connect', provider: 'sim' });
  h.ui.notify(providerFact('sim', 'streaming'));
  assert.equal(h.state().screen, SCREEN.MENU);
  h.ui.activate('menu.controller');
  assert.equal(h.state().screen, SCREEN.CONNECT);
  h.ui.activate('connect.mouse');
  assert.deepEqual(h.last('connect'), { type: 'connect', provider: 'mouse' });
  h.ui.notify(providerFact('mouse', 'streaming'));
  assert.equal(h.state().screen, SCREEN.MENU);
});

test('connect: the Joy-Con main button, diagnostics, back; the native bridge path and its cancel', () => {
  const h = makeUiHarness();
  h.ui.notify({ type: 'ready', skipSafety: true });
  h.ui.activate('connect.main');
  assert.deepEqual(h.last('connect'), { type: 'connect', provider: 'joycon' });
  h.ui.activate('connect.diagnostics');
  assert.equal(h.last().type, 'openDiagnostics');
  h.ui.notify({ type: 'bridgeProbe', phase: 'done', available: true, reason: null, canBuild: false, built: true, preferred: null });
  h.ui.activate('connect.main');
  assert.deepEqual(h.last('connect'), { type: 'connect', provider: 'native' });
  h.ui.notify(nativeFact('connecting'));
  h.step();
  assert.ok(h.ui.findTarget('connect.cancel'));
  h.press('back');
  assert.equal(h.last().type, 'disconnect');
});

test('calibration: Joy-Con connects -> auto-continue -> wizard steps 1-3 -> practice round (startRound practice) -> first hit ends it', () => {
  const h = makeUiHarness();
  h.ui.notify({ type: 'ready', skipSafety: true });
  h.ui.notify(providerFact('joycon', 'connecting'));
  h.ui.notify(providerFact('joycon', 'streaming'));
  h.advance(UI_TIMING.autoContinueMs + 32);
  assert.equal(h.last().type, 'startCalibration');
  h.ui.notify(calFact({ type: 'started', quick: false }));
  assert.equal(h.state().screen, SCREEN.CALIBRATION);
  assert.equal(h.state().calibrationStep, 1);
  assert.equal(h.state().gameActive, false);
  h.ui.notify(calFact({ type: 'progress', step: 1, phase: 'holding', progress: 0.5, meanDps: 1, peakDps: 2, accelMagG: 1 }));
  assert.equal(h.view().cal.progress, 0.5);
  h.ui.notify(calFact({ type: 'stepPassed', step: 1 }));
  assert.equal(h.state().calibrationStep, 2);
  h.ui.notify(calFact({ type: 'stepFailed', step: 2, reason: 'moved' }));
  assert.match(h.view().cal.message, /moved/i);
  h.ui.notify(calFact({ type: 'stepPassed', step: 2 }));
  assert.equal(h.state().calibrationStep, 3);
  h.press('confirm', 'joycon');
  assert.equal(h.last().type, 'confirmCenter');
  h.ui.notify(calFact({ type: 'done', quick: false, calibration: {}, warnings: [] }));
  assert.equal(h.state().calibrationStep, 4);
  assert.deepEqual(h.last('startRound'), { type: 'startRound', mode: 'practice', difficulty: 'easy', stage: 'hills' });
  assert.equal(h.state().gameActive, true);
  assert.equal(h.state().roundMode, 'practice');
  h.setSnapshot(makeSnapshot({ mode: 'practice', t: 2 }));
  h.step({ events: [practiceEvent('thrown')] });
  assert.equal(h.state().screen, SCREEN.CALIBRATION);
  h.step({ events: [practiceEvent('hit')] });
  assert.deepEqual(h.last('endRound'), { type: 'endRound', reason: 'finished' });
  assert.equal(h.state().screen, SCREEN.MENU);
  assert.ok(h.view().toast.text);
});

test('calibration step 4: three lost clays (or the timeout) offer "Calibrate again", which restarts the wizard', () => {
  const h = makeUiHarness();
  h.ui.notify({ type: 'ready', skipSafety: true });
  h.ui.notify(providerFact('joycon', 'streaming'));
  h.ui.notify(calFact({ type: 'started', quick: false }));
  h.ui.notify(calFact({ type: 'done', quick: false, calibration: {}, warnings: [] }));
  h.setSnapshot(makeSnapshot({ mode: 'practice', t: 1 }));
  for (let i = 0; i < UI_TIMING.practiceLostForRetry; i++) h.step({ events: [practiceEvent('lost')] });
  assert.equal(h.view().cal.tryAgain, true);
  assert.ok(h.ui.findTarget('cal.retry'));
  h.clear();
  h.ui.activate('cal.retry');
  assert.deepEqual(h.types(), ['endRound', 'startCalibration']);
  const k = makeUiHarness();
  k.ui.notify(providerFact('joycon', 'streaming'));
  k.ui.notify(calFact({ type: 'started', quick: false }));
  k.ui.notify(calFact({ type: 'done', quick: false, calibration: {}, warnings: [] }));
  k.setSnapshot(makeSnapshot({ mode: 'practice', t: UI_TIMING.practiceTimeoutS + 1 }));
  k.step();
  assert.equal(k.view().cal.tryAgain, true);
});

test('calibration: back cancels the wizard (steps 1-3) and ends the practice round (step 4); a quick recentre returns where it came from', () => {
  const h = makeUiHarness().toMenuWithSim();
  h.ui.notify(calFact({ type: 'started', quick: false }));
  h.press('back');
  assert.equal(h.last().type, 'cancelCalibration');
  assert.equal(h.state().screen, SCREEN.MENU);
  h.ui.notify(calFact({ type: 'started', quick: false }));
  h.ui.notify(calFact({ type: 'done', quick: false, calibration: {}, warnings: [] }));
  h.press('back');
  assert.deepEqual(h.last(), { type: 'endRound', reason: 'quit' });
  assert.equal(h.state().screen, SCREEN.MENU);
  h.ui.notify(calFact({ type: 'started', quick: true }));
  assert.equal(h.state().calibrationStep, 3);
  h.ui.notify(calFact({ type: 'done', quick: true, calibration: {}, warnings: [] }));
  assert.equal(h.state().screen, SCREEN.MENU);
});

test('menu -> setup for every mode; setup start emits startRound{mode, difficulty, stage} and runs the countdown into playing', () => {
  for (const mode of ['classic', 'timeattack', 'zen']) {
    const h = makeUiHarness().toMenuWithSim();
    h.ui.activate(`menu.${mode}`);
    assert.equal(h.state().screen, SCREEN.SETUP);
    assert.equal(h.view().setup.mode, mode);
    const ids = h.ui.getTargets().map((x) => x.id);
    assert.equal(ids.includes('setup.difficulty.opt.hard'), mode !== 'zen');
    assert.equal(ids.includes('setup.stage.opt.alpine'), mode !== 'classic');
    if (mode !== 'zen') h.ui.activate('setup.difficulty.opt.hard');
    if (mode !== 'classic') h.ui.activate('setup.stage.opt.alpine');
    h.clear();
    h.ui.activate('setup.start');
    const si = h.last('startRound');
    assert.deepEqual(si, { type: 'startRound', mode, difficulty: mode === 'zen' ? 'normal' : 'hard', stage: mode === 'classic' ? 'meadow' : 'alpine' });
    assert.equal(h.state().screen, SCREEN.COUNTDOWN);
    assert.equal(h.state().gameActive, false);
    assert.equal(h.view().countdown.stage, si.stage);
    h.advance(COUNTDOWN_MS);
    assert.equal(h.state().screen, SCREEN.PLAYING);
    assert.equal(h.state().gameActive, true);
    assert.equal(h.state().roundMode, mode);
  }
});

test('setup remembers the last difficulty and stage in the settings; back returns to the menu', () => {
  const h = makeUiHarness().toMenuWithSim();
  h.ui.activate('menu.timeattack');
  h.ui.activate('setup.difficulty.opt.easy');
  h.ui.activate('setup.stage.opt.meadow');
  assert.equal(h.storage.getSettings().difficulty, 'easy');
  assert.equal(h.storage.getSettings().stage, 'meadow');
  assert.ok(h.types().includes('settingsChanged'));
  h.press('back');
  assert.equal(h.state().screen, SCREEN.MENU);
  h.ui.activate('menu.classic');
  assert.equal(h.view().setup.difficulty, 'easy');
});

test('the countdown shows 3, 2, 1, GO with sounds', () => {
  const h = makeUiHarness().toMenuWithSim();
  h.ui.activate('menu.classic');
  h.ui.activate('setup.start');
  h.step();
  assert.equal(h.view().countdown.n, 3);
  h.advance(UI_TIMING.countdownNumberMs);
  assert.equal(h.view().countdown.n, 2);
  h.advance(2 * UI_TIMING.countdownNumberMs);
  assert.equal(h.view().countdown.n, 0);
  const ids = h.sounds.map((s) => s[0]);
  assert.equal(ids.filter((s) => s === 'countdown').length, 3);
  assert.ok(ids.includes('go'));
});

test('pause: back / pause in play opens the pause panel; resume runs a 3-2-1 with the game frozen', () => {
  const h = makeUiHarness().toMenuWithSim().startRound('classic');
  h.press('pause');
  assert.equal(h.state().screen, SCREEN.PAUSED);
  assert.equal(h.state().gameActive, false);
  h.ui.activate('pause.resume');
  assert.equal(h.state().screen, SCREEN.PLAYING);
  assert.equal(h.state().resuming, true);
  assert.equal(h.state().gameActive, false);
  h.advance(3 * UI_TIMING.resumeNumberMs + 20);
  assert.equal(h.state().gameActive, true);
  h.press('back');
  assert.equal(h.state().screen, SCREEN.PAUSED);
  h.press('back');
  assert.equal(h.state().resuming, true);
});

test('pause: recentre emits recenter; settings returns to the pause panel; quit asks first, then endRound quit and the menu', () => {
  const h = makeUiHarness().toMenuWithSim().startRound('timeattack');
  h.press('pause');
  h.ui.activate('pause.recentre');
  assert.equal(h.last().type, 'recenter');
  h.ui.activate('pause.settings');
  assert.equal(h.state().screen, SCREEN.SETTINGS);
  h.press('back');
  assert.equal(h.state().screen, SCREEN.PAUSED);
  h.ui.activate('pause.quit');
  assert.equal(h.state().overlay, 'confirm');
  h.ui.activate('confirm.no');
  assert.equal(h.state().overlay, null);
  h.ui.activate('pause.quit');
  h.ui.activate('confirm.yes');
  assert.deepEqual(h.last(), { type: 'endRound', reason: 'quit' });
  assert.equal(h.state().screen, SCREEN.MENU);
  assert.equal(h.state().roundMode, null);
  // a roundOver that arrives after the player left shows no results
  h.ui.notify({ type: 'roundOver', result: roundResult({ mode: 'timeattack', stageId: 'hills' }) });
  assert.equal(h.state().screen, SCREEN.MENU);
});

test('Zen: "End session" ends the round (finished) and shows the session results; without roundOver it falls back to the menu', () => {
  const h = makeUiHarness().toMenuWithSim().startRound('zen');
  h.press('pause');
  h.ui.activate('pause.quit');
  assert.deepEqual(h.last(), { type: 'endRound', reason: 'finished' });
  assert.equal(h.state().overlay, null);
  h.ui.notify({ type: 'roundOver', result: roundResult({ mode: 'zen', stageId: 'hills', rank: null, endReason: 'quit' }) });
  assert.equal(h.state().screen, SCREEN.RESULTS);
  const k = makeUiHarness().toMenuWithSim().startRound('zen');
  k.press('pause');
  k.ui.activate('pause.quit');
  k.advance(UI_TIMING.zenEndFallbackMs + 32);
  assert.equal(k.state().screen, SCREEN.MENU);
});

test('roundOver -> results: score count-up, rank stamp, NEW BEST, locked buttons, play again and menu', () => {
  const h = makeUiHarness().toMenuWithSim();
  h.ui.activate('menu.timeattack');
  h.ui.activate('setup.stage.opt.alpine');
  h.ui.activate('setup.start');
  h.advance(COUNTDOWN_MS);
  h.ui.notify({ type: 'roundOver', result: roundResult({ mode: 'timeattack', stageId: 'alpine', score: 5000, rank: 'A', endReason: 'timer' }) });
  assert.equal(h.state().screen, SCREEN.RESULTS);
  const r = h.view().results;
  assert.equal(r.isNewBest, true);
  assert.equal(r.locked, true);
  assert.equal(h.ui.activate('results.again'), false);
  h.advance(400);
  assert.ok(r.shownScore > 0 && r.shownScore < 5000);
  h.advance(UI_TIMING.resultsCountUpMs + UI_TIMING.resultsStampMs + 400);
  assert.equal(r.shownScore, 5000);
  assert.equal(r.stamped, true);
  assert.equal(r.locked, false);
  assert.ok(h.sounds.some((s) => s[0] === 'rankStamp'));
  assert.ok(h.sounds.some((s) => s[0] === 'record'));
  assert.equal(h.storage.getBest('timeattack', 'normal', 'alpine').score, 5000);
  assert.ok(h.storage.getPlayMsTotal() > 0);
  h.clear();
  h.ui.activate('results.again');
  assert.deepEqual(h.last('startRound'), { type: 'startRound', mode: 'timeattack', difficulty: 'normal', stage: 'alpine' });
  assert.equal(h.state().screen, SCREEN.COUNTDOWN);
  h.advance(COUNTDOWN_MS);
  h.ui.notify({ type: 'roundOver', result: roundResult({ mode: 'timeattack', stageId: 'alpine', score: 10 }) });
  assert.equal(h.view().results.isNewBest, false);
  h.advance(3000);
  h.ui.activate('results.menu');
  assert.deepEqual(h.last('endRound'), { type: 'endRound', reason: 'finished' });
  assert.equal(h.state().screen, SCREEN.MENU);
  assert.equal(h.view().menuBest.timeattack, 5000, 'the menu card shows the best of the remembered difficulty and stage');
});

test('practice rounds never open results', () => {
  const h = makeUiHarness().toMenuWithSim();
  h.ui.force('playing', { roundMode: 'classic' });
  h.ui.notify({ type: 'roundOver', result: roundResult({ mode: 'practice', rank: null }) });
  assert.equal(h.state().screen, SCREEN.PLAYING);
});

test('best scores screen lists Classic and Time Attack per stage and difficulty', () => {
  const h = makeUiHarness().toMenuWithSim();
  h.storage.recordResult(roundResult({ score: 1234, difficulty: 'hard', rank: 'S' }));
  h.storage.recordResult(roundResult({ mode: 'timeattack', stageId: 'meadow', score: 99, difficulty: 'easy', assist: true }));
  h.ui.activate('menu.best');
  assert.equal(h.state().screen, SCREEN.BEST);
  const table = h.view().bestTable;
  assert.equal(table.length, 4);
  assert.deepEqual(table[0].cells.map((c) => c.score), [null, null, 1234]);
  assert.equal(table[0].cells[2].rank, 'S');
  assert.equal(table[1].stage, 'meadow');
  assert.equal(table[1].cells[0].assist, true);
  h.press('back');
  assert.equal(h.state().screen, SCREEN.MENU);
});

test('settings: reset best scores asks first (confirm overlay) and deletes on yes; tuning opens and returns', () => {
  const h = makeUiHarness().toMenuWithSim();
  h.storage.recordResult(roundResult({ score: 50 }));
  h.ui.activate('menu.settings');
  assert.equal(h.state().screen, SCREEN.SETTINGS);
  h.ui.activate('set.reset');
  assert.equal(h.state().overlay, 'confirm');
  assert.equal(h.view().confirm.kind, 'reset');
  h.press('back');
  assert.equal(h.state().overlay, null);
  assert.equal(h.storage.getBest('classic', 'normal').score, 50);
  h.ui.activate('set.reset');
  h.ui.activate('confirm.yes');
  assert.equal(h.storage.getBest('classic', 'normal'), null);
  h.ui.activate('set.tune');
  assert.equal(h.state().screen, SCREEN.TUNING);
  h.press('back');
  assert.equal(h.state().screen, SCREEN.SETTINGS);
  h.press('back');
  assert.equal(h.state().screen, SCREEN.MENU);
});

test('disconnected overlay: a lost Joy-Con pauses the round, reconnects, recentres and resumes', () => {
  const h = makeUiHarness();
  h.storage.setSafetyAck();
  h.ui.notify({ type: 'ready' });
  h.ui.notify(providerFact('joycon', 'streaming'));
  h.ui.notify(calFact({ type: 'started', quick: false }));
  h.ui.notify(calFact({ type: 'done', quick: false, calibration: {}, warnings: [] }));
  h.step({ events: [practiceEvent('hit')] });
  h.startRound('classic');
  assert.equal(h.state().gameActive, true);
  h.ui.notify(providerFact('joycon', 'lost'));
  assert.equal(h.state().overlay, 'disconnected');
  assert.equal(h.state().screen, SCREEN.PAUSED);
  assert.equal(h.state().gameActive, false);
  h.advance(UI_TIMING.discAutoReconnectMs + 32);
  assert.equal(h.last().type, 'reconnect');
  h.ui.notify(providerFact('joycon', 'connecting'));
  h.ui.notify(providerFact('joycon', 'streaming'));
  assert.equal(h.last().type, 'quickRecenter');
  h.ui.notify(calFact({ type: 'started', quick: true }));
  h.ui.notify(calFact({ type: 'done', quick: true, calibration: {}, warnings: [] }));
  assert.equal(h.state().overlay, null);
  assert.equal(h.state().resuming, true);
});

test('disconnected overlay: a failed reconnect offers retry, the mouse and the menu', () => {
  const h = makeUiHarness();
  h.ui.notify({ type: 'ready', skipSafety: true });
  h.ui.notify(providerFact('joycon', 'streaming'));
  h.ui.notify(providerFact('joycon', 'lost'));
  assert.equal(h.state().overlay, 'disconnected');
  h.advance(UI_TIMING.discAutoReconnectMs + UI_TIMING.discNoProgressMs + 64);
  assert.equal(h.view().disc.phase, 'failed');
  assert.deepEqual(h.ui.getTargets().map((x) => x.id), ['disc.retry', 'disc.mouse', 'disc.menu']);
  h.ui.activate('disc.mouse');
  assert.equal(h.last().type, 'useMouse');
  h.ui.notify(providerFact('mouse', 'streaming'));
  assert.equal(h.state().overlay, null);
  const k = makeUiHarness();
  k.ui.notify({ type: 'ready', skipSafety: true });
  k.ui.notify(providerFact('joycon', 'streaming'));
  k.ui.notify(providerFact('joycon', 'lost'));
  k.advance(UI_TIMING.discAutoReconnectMs + UI_TIMING.discNoProgressMs + 64);
  k.ui.activate('disc.menu');
  assert.equal(k.state().screen, SCREEN.MENU);
  assert.equal(k.state().overlay, null);
});

test('blur and a hidden tab pause a running round', () => {
  const h = makeUiHarness().toMenuWithSim().startRound('classic');
  h.ui.notify({ type: 'blur' });
  assert.equal(h.state().screen, SCREEN.PAUSED);
  assert.equal(h.view().pausedBlur, true);
  const k = makeUiHarness().toMenuWithSim().startRound('classic');
  k.ui.notify({ type: 'visibility', hidden: true });
  assert.equal(k.state().screen, SCREEN.PAUSED);
});

test('force() reaches every screen of the SCREEN enum without intents', () => {
  const h = makeUiHarness().toMenuWithSim();
  h.clear();
  for (const s of Object.values(SCREEN)) {
    h.ui.force(s, { roundMode: 'classic' });
    h.step();
    assert.equal(h.state().screen, s);
  }
  assert.deepEqual(h.intents.filter((i) => i.type === 'startRound'), []);
});

test('low battery shows a toast at most once per gap; recentered shows a short toast', () => {
  const h = makeUiHarness().toMenuWithSim();
  h.ui.notify(providerFact('joycon', 'streaming', { battery: { mv: 3400, level: 'low', pct: null } }));
  assert.ok(h.view().toast.text);
  h.advance(UI_TIMING.toastMs + 20);
  assert.equal(h.view().toast.text, null);
  h.ui.notify(providerFact('joycon', 'streaming', { battery: { mv: 3400, level: 'low', pct: null } }));
  assert.equal(h.view().toast.text, null);
  h.ui.notify({ type: 'recentered' });
  assert.ok(h.view().toast.text);
});
