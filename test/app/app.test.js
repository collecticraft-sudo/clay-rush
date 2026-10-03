// Whole-app tests: the real app.js (providers, motion pipeline, game, presentation) on a manual clock with fake canvas and window.
// Driven through window.__clay, like an automated agent, and through the fake DOM (pointer, keys). The simulator and the fakes model
// docs/joycon2-protocol.md and a browser; nothing here proves anything about the physical Joy-Con (UNVERIFIED-ON-HARDWARE).
import test from 'node:test';
import assert from 'node:assert/strict';
import { assertValid } from '../../public/js/shared/validate.js';
import { makeApp, botPlay, fingerprint } from '../../test-support/app/harness.js';

const FLAGS = '?input=sim&clock=manual&skipsafety=1&mute=1';
const MOUSE = '?input=mouse&clock=manual&skipsafety=1&mute=1';

async function withApp(search, fn, opts) {
  const h = await makeApp(search, opts);
  try {
    await fn(h);
  } finally {
    h.dispose();
  }
}

/** A target that hangs still at a screen point in front of the trap house (debug spawn, Classic without auto launch). */
function stillTarget(h, z = 20) {
  const [id] = h.c.debug.spawn({ kind: 'standard', house: 'trap', pos: { x: 0, y: 3, z }, vel: { x: 0, y: 0, z: 0 }, still: true });
  h.run(20);
  return h.snap().targets.find((t) => t.id === id);
}

// ------------------------------------------------------------------------------------------------------------- boot

test('boot: ?input=sim reaches the menu with the simulator streaming, a calibration and the whole __clay API (no __ninja any more)', async () => {
  await withApp(`${FLAGS}&seed=1`, async (h) => {
    await h.c.ready;
    assert.equal(h.win.__clay, h.c);
    assert.equal(h.win.__ninja, undefined);
    assert.equal(h.c.version, 1);
    assert.equal(h.c.manualClock, true);
    const s = h.snap();
    assert.equal(s.screen, 'menu');
    assert.deepEqual(s.provider, { kind: 'sim', state: 'streaming', side: 'R' });
    assert.equal(s.calibrated, true, 'the simulator applies its exact nominal calibration');
    assert.equal(s.game, null);
    assert.deepEqual(s.targets, []);
    for (const fn of ['now', 'advance', 'getConfig', 'getSettings', 'setSetting', 'setSeed', 'start', 'snapshot', 'pause', 'resume', 'aim', 'fire',
      'shootTarget', 'callPull', 'press', 'nav', 'getMotionState', 'getUiState', 'getAssets', 'getPerf']) {
      assert.equal(typeof h.c[fn], 'function', fn);
    }
    for (const fn of ['spawn', 'autoLaunch', 'forceScreen', 'getLog', 'getCounters', 'getAudio', 'draw', 'getUiView', 'setCalibration']) {
      assert.equal(typeof h.c.debug[fn], 'function', `debug.${fn}`);
    }
    for (const fn of ['fire', 'setTarget', 'setPose', 'clearPose', 'playCalibrationScript', 'simulateLoss', 'simulateRecovery', 'getTruth']) {
      assert.equal(typeof h.c.sim[fn], 'function', `sim.${fn}`);
    }
    const cfg = h.c.getConfig();
    assert.ok(cfg.game.storage && cfg.motion.shot && cfg.input.service, 'game, motion and input config, JSON-serialisable');
    assert.deepEqual(h.problems(), []);
  });
});

test('boot: without ?skipsafety the safety screen comes first; mouse and simulator skip the connect screen; no ?input shows it', async () => {
  await withApp('?input=sim&clock=manual&mute=1', async (h) => {
    assert.equal(h.screen(), 'safety');
  });
  await withApp(MOUSE, async (h) => {
    assert.equal(h.screen(), 'menu');
    assert.equal(h.snap().provider.kind, 'mouse');
  });
  await withApp('?clock=manual&skipsafety=1&mute=1', async (h) => {
    assert.equal(h.screen(), 'connect');
    assert.equal(h.snap().provider.kind, null);
  });
});

test('boot: ?mode starts the round with ?difficulty and ?stage; ?skipcountdown skips the 3-2-1', async () => {
  await withApp('?mode=timeattack&difficulty=hard&stage=alpine&skipcountdown=1&clock=manual&mute=1&seed=3', async (h) => {
    assert.equal(h.screen(), 'playing');
    const s = h.snap();
    assert.equal(s.mode, 'timeattack');
    assert.equal(s.difficulty, 'hard');
    assert.equal(s.stage.id, 'alpine');
    assert.equal(s.seed, 3);
    assert.equal(s.provider.kind, 'mouse', '?mode implies the mouse without ?input');
  });
  await withApp('?mode=zen&clock=manual&mute=1', async (h) => {
    assert.equal(h.screen(), 'countdown');
    h.run(3500);
    assert.equal(h.screen(), 'playing');
    assert.equal(h.snap().mode, 'zen');
  });
});

test('boot: the real clock refuses advance(); bad calls throw or reject', async () => {
  await withApp('?input=sim&mute=1&skipsafety=1', async (h) => {
    assert.equal(h.c.manualClock, false);
    assert.throws(() => h.c.advance(10), /manual/);
  });
  await withApp(FLAGS, async (h) => {
    assert.throws(() => h.c.start('arcade'), RangeError);
    assert.throws(() => h.c.debug.spawn({ kind: 'standard' }), /no round/);
    await assert.rejects(h.c.shootTarget(1), /no round/);
    assert.throws(() => h.c.press('slice'), RangeError);
    h.c.start('classic', { seed: 1 });
    await assert.rejects(h.c.shootTarget(9999), /not airborne/);
    assert.throws(() => h.c.aim('a', 1), TypeError);
  });
});

// ------------------------------------------------------------------------------------------------------- a whole round

test('Classic: a bot plays all three stages through shootTarget to the results; snapshots and events pass the validators; best and play time recorded once', async () => {
  await withApp(`${FLAGS}&debug=1`, async (h) => {
    const r = await botPlay(h, { seed: 5 });
    assert.equal(r.snap.screen, 'results');
    assert.equal(r.snap.phase, 'over');
    assert.equal(r.snap.stats.presented, 36, 'every pull of the three stages was presented (10 + 12 + 14)');
    assert.ok(r.snap.stats.broken >= 30, `broken ${r.snap.stats.broken}`);
    assert.ok(r.snap.score > 0);
    assertValid('GameSnapshot', r.snap.game);
    for (const e of r.snap.events) assertValid('GameEvent', e);
    const best = h.app.storage.getBest('classic', 'normal', null);
    assert.equal(best.score, r.snap.score, 'the UI recorded the best score on roundOver');
    const played = h.app.storage.getPlayMsTotal();
    assert.ok(played > 30000, `play time ${played}`);
    h.run(3000);
    assert.equal(h.app.storage.getPlayMsTotal(), played, 'roundOver was sent once: the play time is not added again');
    assert.deepEqual(h.problems(), [], 'debug validation of samples, statuses, shots, snapshots and results logged nothing');
  });
});

test('Classic: the stage card and all three stages come in order (meadow, hills, alpine)', async () => {
  await withApp(FLAGS, async (h) => {
    h.c.start('classic', { seed: 2 });
    const stages = new Set();
    let guard = 0;
    while (h.screen() === 'playing' && guard++ < 20000) {
      const s = h.snap();
      stages.add(s.stage.id);
      const tg = s.targets.find((t) => t.ageS > 0.15 && t.sx > 40 && t.sx < 1880 && t.sy > 40 && t.sy < 1040);
      if (tg && s.shells.loaded > 0) await h.c.shootTarget(tg.id);
      else h.run(50);
    }
    assert.deepEqual([...stages], ['meadow', 'hills', 'alpine']);
  });
});

test('Time Attack: a bot plays to the end of the clock; the results show and the best is kept per stage', async () => {
  await withApp(FLAGS, async (h) => {
    const r = await botPlay(h, { mode: 'timeattack', stage: 'meadow', seed: 9, missEvery: 3 });
    assert.equal(r.snap.screen, 'results');
    assert.equal(r.snap.endReason, 'timer');
    assert.ok(r.snap.stats.broken > 10);
    assert.equal(h.app.storage.getBest('timeattack', 'normal', 'meadow').score, r.snap.score);
  });
});

test('Zen: shots break clays; "End session" on the pause panel ends the round and shows the session results', async () => {
  await withApp(FLAGS, async (h) => {
    h.c.start('zen', { seed: 4, stage: 'hills' });
    let hits = 0;
    for (let i = 0; i < 400 && hits < 3; i += 1) {
      const tg = h.snap().targets.find((t) => t.ageS > 0.15 && t.sx > 40 && t.sx < 1880 && t.sy > 40 && t.sy < 1040);
      if (tg) hits += (await h.c.shootTarget(tg.id)).hit ? 1 : 0;
      else h.run(50);
    }
    assert.equal(hits, 3);
    h.c.pause();
    assert.equal(h.app.presentation.ui.activate('pause.quit'), true, 'Zen: "End session"');
    h.run(200);
    assert.equal(h.screen(), 'results');
    assert.equal(h.snap().mode, 'zen');
    assert.equal(h.snap().endReason, 'complete');
  });
});

test('quit: pause > Quit > Yes drops the round (game.end), shows the menu, records nothing', async () => {
  await withApp(FLAGS, async (h) => {
    h.c.start('classic', { seed: 1 });
    h.run(2000);
    h.c.pause();
    h.app.presentation.ui.activate('pause.quit');
    h.app.presentation.ui.activate('confirm.yes');
    assert.equal(h.screen(), 'menu');
    assert.equal(h.app.getGame(), null);
    h.run(500);
    assert.equal(h.app.storage.getBest('classic', 'normal', null), null);
    assert.equal(h.app.storage.getPlayMsTotal(), 0);
  });
});

test('results: Play again starts a fresh round through the countdown; Menu drops the finished round', async () => {
  await withApp(FLAGS, async (h) => {
    await botPlay(h, { mode: 'timeattack', seed: 3, maxS: 400 });
    assert.equal(h.screen(), 'results');
    h.run(4000);
    const first = h.app.getGame();
    assert.equal(h.app.presentation.ui.activate('results.again'), true);
    assert.equal(h.screen(), 'countdown');
    assert.notEqual(h.app.getGame(), first, 'a new game object');
    h.run(3500);
    assert.equal(h.screen(), 'playing');
    h.c.pause();
    h.app.presentation.ui.activate('pause.quit');
    h.app.presentation.ui.activate('confirm.yes');
    assert.equal(h.app.getGame(), null);
  });
});

test('determinism: same seed and the same bot give the same final snapshot; another seed differs', async () => {
  const run = async (seed) => {
    const h = await makeApp(`${FLAGS}&seed=1`);
    try {
      const r = await botPlay(h, { mode: 'timeattack', seed, missEvery: 4 });
      const { nowMs, aim, ...rest } = r.snap;
      return fingerprint({ ...rest, game: null });
    } finally {
      h.dispose();
    }
  };
  const a = await run(11);
  assert.equal(await run(11), a);
  assert.notEqual(await run(12), a);
});

// ------------------------------------------------------------------------------------------------------- shots (C-04, C-05)

test('C-05: a Joy-Con fire is compensated by triggerCompMs (aim at t - compMs from the history); mouse, keyboard and sim are not', async () => {
  await withApp(FLAGS, async (h) => {
    h.c.start('classic', { seed: 1, autoLaunch: false });
    h.c.sim.setTarget(600, 400, { glideMs: 300 }); // the virtual gun moves, so the history has a path
    h.run(150);
    const t = h.c.now() - 20;
    const fire = (source) => h.app.presentation.ui.notify({ type: 'action', event: { t, action: 'fire', label: 'ZR', source } });
    fire('joycon');
    let q = h.app.getShotQueue();
    assert.equal(q.length, 1);
    assertValid('Shot', q[0]);
    assert.equal(q[0].compMs, 40, 'the default setting');
    assert.equal(q[0].t, t, 'the press time, not the time it was handled');
    const want = h.app.motion.aimAt(t - 40);
    assert.equal(want.valid, true);
    assert.deepEqual({ x: q[0].x, y: q[0].y }, { x: want.x, y: want.y });
    const uncompensated = h.app.motion.aimAt(t);
    assert.notDeepEqual({ x: q[0].x, y: q[0].y }, { x: uncompensated.x, y: uncompensated.y }, 'the gun moved: without compensation the shot would differ');
    h.run(16);
    h.c.setSetting('triggerCompMs', 70);
    fire('joycon');
    assert.equal(h.app.getShotQueue()[0].compMs, 70);
    h.run(16);
    for (const source of ['mouse', 'keyboard', 'sim']) {
      fire(source);
      q = h.app.getShotQueue();
      assert.equal(q[q.length - 1].compMs, 0, source);
    }
  });
});

test('A-01: a keyboard fire with an IMU provider uses the newest MEASURED aim (no compensation), never the extrapolated crosshair', async () => {
  await withApp(FLAGS, async (h) => {
    h.c.start('classic', { seed: 1, autoLaunch: false });
    h.c.sim.setTarget(1500, 300, { glideMs: 600 }); // the virtual gun is moving: the extrapolated head is ahead of the newest sample
    h.run(200);
    const t = h.c.now();
    const newest = h.app.motion.latest();
    assert.ok(newest.t < t, 'the press is newer than the newest sample');
    assert.equal(h.app.motion.aimAt(t).valid, false);
    const head = h.app.motion.headAt(t);
    h.app.presentation.ui.notify({ type: 'action', event: { t, action: 'fire', label: 'F', source: 'keyboard' } });
    const q = h.app.getShotQueue();
    const shot = q[q.length - 1];
    assert.equal(shot.compMs, 0);
    assert.deepEqual({ x: shot.x, y: shot.y }, { x: newest.x, y: newest.y });
    assert.notDeepEqual({ x: shot.x, y: shot.y }, { x: head.x, y: head.y }, 'not the extrapolated head');
  });
});

test('the app plays with MOTION_CONFIG.shooter: sensitivity 3.0 survives, and the relative pointer uses the shooter gains (24 px/deg fast, balanced)', async () => {
  const { mountCalibration, createTipStream } = await import('../../test-support/motion/tip-stream.js');
  await withApp(FLAGS, async (h) => {
    h.c.setSetting('sensitivity', 3.0);
    h.run(20);
    assert.equal(h.app.motion.getSettings().sensitivity, 3.0, 'the sword range would clamp it to 2.0');
    h.c.setSetting('sensitivity', 1.0);
    h.run(20);
    const m = h.app.motion;
    m.setPointerModel('relative');
    m.reset();
    m.setCalibration(mountCalibration('faceUp', 'R'));
    const st = createTipStream({ mount: 'faceUp', side: 'R', startMs: h.c.now() + 1 });
    for (const s of st.hold(3, 1000)) m.pushImu(s);
    assert.equal(m.getSettings().aimCurve, 'balanced');
    assert.ok(Math.abs(m.latest().vx / 1000 - 24 * 0.995) < 1e-6, `${m.latest().vx / 1000} px/deg (the sword reference would give ${14 * 0.995})`);
  });
});

test('I-01: a double click with the simulator during play is two shots and never a recentre', async () => {
  await withApp(FLAGS, async (h) => {
    h.c.start('classic', { seed: 1, autoLaunch: false });
    h.run(200);
    const recentres = [];
    h.app.motion.on('recenter', (e) => recentres.push(e));
    h.canvas.dispatch('dblclick', { clientX: 500, clientY: 500, button: 0 });
    h.run(50);
    assert.deepEqual(recentres, []);
  });
});

test('shots queued while the game is not active are dropped, never replayed after the pause', async () => {
  await withApp(FLAGS, async (h) => {
    h.c.start('classic', { seed: 1, autoLaunch: false });
    h.run(500);
    h.c.pause();
    const r = await h.c.fire({ x: 960, y: 500 });
    assert.deepEqual(r.events.filter((e) => e.type === 'shot' || e.type === 'pull'), []);
    assert.equal(h.c.debug.getCounters().shotsDropped, 1);
    h.c.resume();
    h.run(1000);
    assert.equal(h.snap().phase, 'ready', 'the dropped shot did not call the pull later');
  });
});

test('the trigger through the whole simulator chain: sim.fire() -> report time -> motion.aimAt -> UI fire intent -> game hit', async () => {
  await withApp(FLAGS, async (h) => {
    h.c.start('classic', { seed: 1, autoLaunch: false });
    h.c.sim.fire(); // phase ready: the shot calls "Pull!"
    h.run(50);
    assert.equal(h.snap().phase, 'pull');
    h.run(1000);
    const tg = stillTarget(h);
    h.c.sim.setTarget(tg.sx, tg.sy, { teleport: true });
    h.run(120);
    assert.ok(Math.hypot(h.snap().aim.x - tg.sx, h.snap().aim.y - tg.sy) < 8, 'the crosshair is on the clay (the simulated sensor noise moves it a few px)');
    const ev = h.c.sim.fire();
    assert.equal(ev.source, 'sim');
    h.run(50);
    const hits = h.snap().events.filter((e) => e.type === 'hit' && e.id === tg.id);
    assert.equal(hits.length, 1, 'the clay broke');
    const shot = h.snap().events.filter((e) => e.type === 'shot').pop();
    assert.equal(shot.source, 'sim');
    assert.equal(shot.compMs, 0);
  });
});

test('mouse: a left press in play fires at the press position (and is no menu click); menu items are clicked with the mouse', async () => {
  await withApp(MOUSE, async (h) => {
    const p = h.target('menu.classic');
    h.mouse.click(p.x, p.y);
    assert.equal(h.screen(), 'setup', 'the click opened the Classic setup');
    assert.equal(h.app.getGame(), null, 'a press in a menu fires nothing');
    h.c.start('classic', { seed: 1, autoLaunch: false });
    h.mouse.click(960, 600); // ready: calls the pull
    h.run(1200);
    const tg = stillTarget(h);
    h.mouse.move(tg.sx, tg.sy);
    h.mouse.down(tg.sx, tg.sy);
    h.mouse.up(tg.sx, tg.sy);
    h.run(40);
    const shot = h.snap().events.filter((e) => e.type === 'shot').pop();
    assert.equal(shot.source, 'mouse');
    assert.ok(Math.hypot(shot.x - tg.sx, shot.y - tg.sy) < 1, `shot at ${shot.x},${shot.y}`);
    assert.ok(h.snap().events.some((e) => e.type === 'hit' && e.id === tg.id));
    assert.equal(h.screen(), 'playing');
  });
});

test('keyboard: Enter calls "Pull!" in phase ready, F fires, P pauses', async () => {
  await withApp(FLAGS, async (h) => {
    h.c.start('classic', { seed: 1, autoLaunch: false });
    h.run(100);
    h.key('Enter');
    h.run(30);
    assert.equal(h.snap().phase, 'pull');
    h.run(1000);
    h.key('f');
    h.keyUp('f');
    h.run(30);
    assert.equal(h.snap().events.filter((e) => e.type === 'shot').pop()?.source, 'keyboard');
    h.key('p');
    assert.equal(h.screen(), 'paused');
  });
});

test('the recentre hold-off (a grip press while the aim moves fast) never applies to the trigger', async () => {
  await withApp(FLAGS, async (h) => {
    h.c.start('classic', { seed: 1, autoLaunch: false });
    h.c.sim.fire();
    h.run(1000);
    h.c.sim.setTarget(1700, 200, { glideMs: 120 }); // a fast swing
    h.run(60);
    assert.ok(h.c.getMotionState().speedDps >= 100, `speed ${h.c.getMotionState().speedDps}`);
    h.c.press('recenter');
    assert.ok(h.log().some((l) => /recenter press ignored/.test(l.message)), 'the recentre is held off');
    h.c.sim.fire();
    h.run(30);
    assert.ok(h.snap().events.some((e) => e.type === 'shot' && e.source === 'sim'), 'the trigger is not');
  });
});

test('rumble (C-08): vibrate(5) on every shot with the setting on; nothing with the setting off or ?haptics=0', async () => {
  const play = async (search, rumble) => {
    const calls = [];
    await withApp(search, async (h) => {
      h.app.getProvider().vibrate = (id) => calls.push(id);
      h.c.setSetting('rumble', rumble);
      h.c.start('zen', { seed: 1 });
      h.run(1500);
      await h.c.fire({ x: 900, y: 300 });
      await h.c.fire({ x: 800, y: 300 });
    });
    return calls;
  };
  assert.deepEqual(await play(FLAGS, true), [5, 5]);
  assert.deepEqual(await play(FLAGS, false), []);
  assert.deepEqual(await play(`${FLAGS}&haptics=0`, true), []);
});

test('shotFeedback: 160 ms after a trigger press on the tuning screen (no game running) the UI shows the jerk and displacement', async () => {
  await withApp(FLAGS, async (h) => {
    h.app.presentation.ui.activate('menu.settings');
    h.app.presentation.ui.activate('set.tune');
    assert.equal(h.screen(), 'tuning');
    h.run(200);
    h.c.sim.fire();
    h.run(100);
    assert.equal(h.c.debug.getUiView().tune.lastShot, null, 'not yet: the 80 ms after the press must be in the history');
    h.run(100);
    const s = h.c.debug.getUiView().tune.lastShot;
    assert.ok(s, 'the fact arrived');
    assert.equal(s.valid, true);
    assert.equal(s.compMs, 0, 'the simulator is not compensated');
    assert.ok(Number.isFinite(s.jerkPeakDps) && Number.isFinite(s.displacementPx));
    assert.equal(h.app.getGame(), null);
  });
});

// ------------------------------------------------------------------------------------------------------------ settings

test('settings: sensitivity, aimCurve and flipX reach Motion; auto-centring stays off for the simulator; unknown keys throw', async () => {
  await withApp(FLAGS, async (h) => {
    h.c.setSetting('sensitivity', 1.5);
    assert.equal(h.app.motion.getSettings().sensitivity, 1.5);
    h.c.setSetting('aimCurve', 'fast');
    assert.equal(h.app.motion.getSettings().aimCurve, 'fast');
    h.c.setSetting('flipX', true);
    assert.equal(h.app.motion.getSettings().flipX, true);
    assert.equal(h.app.motion.getSettings().autoCenter, false, 'the simulator never drifts');
    assert.throws(() => h.c.setSetting('cutThreshold', 300), RangeError, 'the sword setting is gone');
  });
});

test('settings: the settings screen reaches Motion and the provider through the settingsChanged intent (trigger button, aim curve)', async () => {
  await withApp('?input=joycon&clock=manual&skipsafety=1&mute=1', async (h) => {
    const p = h.app.getProvider();
    const calls = [];
    const orig = p.setTriggerButton.bind(p);
    p.setTriggerButton = (b) => { calls.push(b); orig(b); };
    assert.equal(h.app.motion.getSettings().autoCenter, true, 'a Joy-Con follows the setting');
    h.app.presentation.ui.force('settings');
    assert.equal(h.app.presentation.ui.activate('set.triggerButton.opt.R'), true);
    assert.deepEqual(calls, ['R']);
    assert.equal(p.getActionLabels().fire, 'R');
    assert.equal(h.app.presentation.ui.getView().labels.fire, 'R', 'the labels the UI shows were refreshed');
    h.app.presentation.ui.activate('set.aimCurve.opt.precise');
    assert.equal(h.app.motion.getSettings().aimCurve, 'precise');
    h.app.presentation.ui.activate('set.sensitivity.plus');
    assert.equal(h.app.motion.getSettings().sensitivity, 1.1);
    h.app.presentation.ui.activate('set.autoCenter.opt.off');
    assert.equal(h.app.motion.getSettings().autoCenter, false);
  });
});

test('boot: persisted settings reach Motion; ?reducemotion and ?reduceflash force the accessibility settings without persisting them', async () => {
  const backend = new Map();
  const store = { getItem: (k) => backend.get(k) ?? null, setItem: (k, v) => backend.set(k, String(v)), removeItem: (k) => backend.delete(k) };
  await withApp(FLAGS, async (h) => {
    h.c.setSetting('sensitivity', 0.7);
    h.c.setSetting('aimCurve', 'precise');
  }, { storageBackend: store });
  assert.ok(backend.has('clayRush.v1'), 'the storage key of Clay Rush');
  await withApp(`${FLAGS}&reducemotion=1&reduceflash=1`, async (h) => {
    assert.equal(h.app.motion.getSettings().sensitivity, 0.7);
    assert.equal(h.app.motion.getSettings().aimCurve, 'precise');
    assert.equal(h.c.getSettings().reduceMotion, true);
    assert.equal(h.c.getSettings().reduceFlash, true);
  }, { storageBackend: store });
  assert.equal(JSON.parse(backend.get('clayRush.v1')).settings.reduceMotion, false);
});

test('storage failure: with every storage call throwing the game boots, plays a round and keeps the best score in memory', async () => {
  const boom = () => { throw new Error('storage blocked'); };
  await withApp(FLAGS, async (h) => {
    assert.equal(h.app.storage.isPersistent(), false);
    const r = await botPlay(h, { mode: 'timeattack', seed: 3 });
    assert.equal(r.snap.screen, 'results');
    assert.equal(h.app.storage.getBest('timeattack', 'normal', 'hills').score, r.snap.score);
    assert.deepEqual(h.problems().filter((l) => l.level === 'error'), []);
  }, { storageBackend: { getItem: boom, setItem: boom, removeItem: boom } });
});

// -------------------------------------------------------------------------------------------- pause, disconnect, calibration

test('pause() and resume() freeze and continue the game; blur and a hidden tab pause too', async () => {
  await withApp(FLAGS, async (h) => {
    h.c.start('timeattack', { seed: 2 });
    h.run(1500);
    const t1 = h.snap().t;
    h.c.pause();
    assert.equal(h.screen(), 'paused');
    h.run(2000);
    assert.equal(h.snap().t, t1, 'no game time passes while paused');
    h.c.resume();
    h.run(500);
    assert.ok(h.snap().t > t1);
    h.win.dispatch('blur');
    assert.equal(h.screen(), 'paused');
    h.c.resume();
    h.doc.setHidden(true);
    assert.equal(h.screen(), 'paused');
    h.doc.setHidden(false);
  });
});

test('disconnect: a lost link pauses the round under an overlay; recovery resumes the game', async () => {
  await withApp(FLAGS, async (h) => {
    h.c.start('timeattack', { seed: 4 });
    h.run(2000);
    const t0 = h.snap().t;
    h.c.sim.simulateLoss();
    h.run(50);
    assert.equal(h.screen(), 'paused');
    assert.equal(h.snap().overlay, 'disconnected');
    h.run(3000);
    assert.equal(h.snap().t, t0, 'frozen during the outage');
    h.c.sim.simulateRecovery();
    h.until((s) => s.overlay === null, 6000);
    h.until(() => h.ui().gameActive, 6000);
    h.run(500);
    assert.ok(h.snap().t > t0, 'the round continues');
    assert.deepEqual(h.problems().filter((l) => l.level === 'error'), []);
  });
});

test('?simcal=1: the real calibration wizard against the simulator reaches the practice round (step 4); hitting the clay ends it on the menu', async () => {
  await withApp(`${FLAGS}&simcal=1&simseed=5`, async (h) => {
    assert.equal(h.screen(), 'calibration');
    h.until(() => h.ui().calibrationStep === 4, 20000);
    assert.equal(h.ui().calibrationStep, 4, 'the wizard passed steps 1 to 3');
    assert.equal(h.ui().gameActive, true);
    assert.equal(h.snap().mode, 'practice');
    const s = h.until((x) => x.targets.some((t) => t.ageS > 0.3), 6000);
    const tg = s.targets.find((t) => t.ageS > 0.3);
    const r = await h.c.shootTarget(tg.id);
    assert.equal(r.hit, true);
    h.run(200);
    assert.equal(h.screen(), 'menu');
    assert.equal(h.app.getGame(), null, 'the practice round was dropped');
    assert.equal(h.snap().calibrated, true);
  });
});

// ------------------------------------------------------------------------------------------------------------ misc

test('the crosshair: aim() moves it (simulator teleport, mouse aim sample) and snapshot().aim follows', async () => {
  await withApp(FLAGS, async (h) => {
    h.c.aim(300, 200);
    h.run(100);
    assert.ok(Math.hypot(h.snap().aim.x - 300, h.snap().aim.y - 200) < 8, 'within the simulated sensor noise');
  });
  await withApp(MOUSE, async (h) => {
    h.c.aim(1500, 800);
    h.run(20);
    assert.ok(Math.hypot(h.snap().aim.x - 1500, h.snap().aim.y - 800) < 1);
    assert.equal(h.app.presentation.debug.getWorldView().aim.x, 1500);
  });
});

test('getPerf has no NaN; the debug log carries no warnings in a normal session; dispose removes the page listeners', async () => {
  const h = await makeApp(FLAGS);
  await botPlay(h, { mode: 'zen', seed: 2, maxS: 20 });
  const p = h.c.getPerf();
  for (const v of Object.values(p)) assert.ok(v === null || Number.isFinite(v));
  assert.deepEqual(h.problems(), []);
  const before = ['blur', 'pagehide'].map((t) => (h.win.listeners.get(t) ?? []).length);
  h.dispose();
  const after = ['blur', 'pagehide'].map((t) => (h.win.listeners.get(t) ?? []).length);
  assert.ok(after[0] < before[0] && after[1] < before[1], `${before} -> ${after}`);
});
