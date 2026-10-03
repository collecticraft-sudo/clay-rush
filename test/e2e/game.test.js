// e2e (headless Chrome over CDP, the real server): boot and offline proof, a bot that plays every stage of Classic through __clay.shootTarget,
// Time Attack, Zen, pause, the keyboard, settings that persist, the simulator calibration with its practice clay, storage failure, the real
// clock with real mouse events, audio. Screenshots of every screen go to E2E_SCREENSHOTS=dir when it is set.
// Without Chrome the suite fails (E2E_OPTIONAL=1: skipped, never "passed"). The simulator and Chrome model docs/joycon2-protocol.md and a
// browser; nothing here verifies the physical Joy-Con (UNVERIFIED-ON-HARDWARE).
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { startE2e } from '../../test-support/e2e/env.js';

const env = await startE2e();
const skip = env.skip;
after(() => env.close());

const Q = 'input=sim&clock=manual&skipsafety=1&mute=1';
const ev = (page, expr) => page.evaluate(expr);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// The HUD notices phase changes and the score when it DRAWS (every frame in real play). A synchronous loop of advance() calls draws nothing, so
// before a picture the tests run a few frames with a draw each, the way the browser would have painted them.
const frames = (page, n, ms = 16) => page.evaluate(([n, ms]) => { for (let i = 0; i < n; i++) { __clay.advance(ms); __clay.debug.draw(); } }, [n, ms]);
const noErrors = (page) => {
  assert.deepEqual(page.consoleErrors(), []);
  assert.deepEqual(page.exceptions, []);
};

test('e2e 1: boot reaches the menu, the page is Clay Rush, no console errors, no failed requests, everything is localhost (offline proof)', { skip }, async (t) => {
  const page = await env.openGame(`${Q}&seed=1&debug=1`);
  const s = await ev(page, '__clay.snapshot()');
  assert.equal(s.screen, 'menu');
  assert.deepEqual({ kind: s.provider.kind, state: s.provider.state }, { kind: 'sim', state: 'streaming' });
  assert.equal(await ev(page, 'document.title'), 'Clay Rush');
  assert.equal(await ev(page, "typeof window['__nin' + 'ja']"), 'undefined', 'the debug API of the old game is gone');
  noErrors(page);
  assert.deepEqual(page.failedRequests, []);
  assert.deepEqual(page.badResponses, []);
  const origin = new URL(env.url).origin;
  const foreign = page.requests.filter((r) => !r.url.startsWith(origin) && !r.url.startsWith('data:') && r.url !== 'about:blank');
  assert.deepEqual(foreign, [], 'nothing is fetched from outside localhost');
  assert.ok(page.requests.filter((r) => r.url.endsWith('.js')).length > 60, 'the ES module graph was loaded over HTTP');
  const font = await page.evaluate(async () => (await fetch('/assets/fonts/range-display.woff2')).headers.get('content-type'));
  assert.equal(font, 'font/woff2', 'server.js serves the fonts with their MIME type');
  t.diagnostic(`Chrome ${env.chrome}: ${page.requests.length} requests, all ${origin}`);
});

test('e2e 1b: the Content-Security-Policy makes the browser refuse any external fetch and any inline script', { skip }, async () => {
  const page = await env.openGame(`${Q}&seed=1`);
  const r = await page.evaluate(async () => {
    const ext = await fetch('https://example.com/').then(() => 'allowed', () => 'blocked');
    window.__inlineRan = false;
    const el = document.createElement('script');
    el.textContent = 'window.__inlineRan = true';
    document.head.append(el);
    await new Promise((res) => setTimeout(res, 50));
    return { ext, inline: window.__inlineRan ? 'allowed' : 'blocked' };
  });
  assert.deepEqual(r, { ext: 'blocked', inline: 'blocked' });
});

test('e2e 2: Classic: a bot plays all three stages through shootTarget, breaks most clays, the results show; every snapshot passes the validators', { skip }, async () => {
  const page = await env.openGame(`${Q}&debug=1`);
  await env.screenshot(page, 'menu');
  // the first stage step by step: the ready prompt, "Pull!", the clay in flight, the hit
  const first = await page.evaluate(async () => {
    const { assertValid } = await import('/js/shared/validate.js');
    const C = __clay;
    C.start('classic', { seed: 7, autoLaunch: false });
    C.advance(600);
    const ready = C.snapshot().phase;
    const pull = await C.callPull();
    let s = C.snapshot();
    for (let i = 0; i < 80 && !s.targets.some((t) => t.ageS > 0.3); i++) { C.advance(20); C.debug.draw(); s = C.snapshot(); }
    assertValid('GameSnapshot', s.game);
    return { ready, called: pull.called, targets: s.targets.length, id: s.targets[0] && s.targets[0].id };
  });
  assert.equal(first.ready, 'ready');
  assert.equal(first.called, true);
  assert.equal(first.targets, 1, 'stage 1 throws singles');
  await env.screenshot(page, 'flight');
  const shot = await page.evaluate(async (id) => {
    const r = await __clay.shootTarget(id);
    return { hit: r.hit, types: r.events.map((e) => e.type), score: __clay.snapshot().score, particles: __clay.debug.getWorld().particles };
  }, first.id);
  assert.equal(shot.hit, true);
  assert.ok(shot.types.includes('shot') && shot.types.includes('hit'));
  assert.ok(shot.score > 0, 'the score rose');
  assert.ok(shot.particles > 0, 'shards and dust are in the air');
  await frames(page, 4);
  await env.screenshot(page, 'hit');
  // the whole round
  const r = await page.evaluate(() => __helpers.botPlay('classic', { seed: 7 }));
  assert.equal(r.screen, 'results');
  assert.equal(r.endReason, 'complete');
  assert.deepEqual(r.stats.stages, ['meadow', 'hills', 'alpine']);
  assert.equal(r.snapStats.presented, 36);
  assert.ok(r.snapStats.broken >= 30, `broken ${r.snapStats.broken} of 36`);
  assert.ok(r.score > 10000, `score ${r.score}`);
  await frames(page, 40, 100);
  await env.screenshot(page, 'results');
  const best = await page.evaluate(() => JSON.parse(localStorage.getItem('clayRush.v1')).best);
  assert.equal(best['classic.normal'].score, r.score, 'the best score is stored under clayRush.v1');
  noErrors(page);
});

test('e2e 3: the stage card between stages, shells that deplete, a dry click on an empty gun', { skip }, async () => {
  const page = await env.openGame(Q);
  const r = await page.evaluate(async () => {
    const C = __clay;
    C.start('classic', { seed: 3, autoLaunch: false });
    C.advance(600);
    await C.callPull();
    let s = C.snapshot();
    for (let i = 0; i < 80 && !s.targets.length; i++) { C.advance(20); s = C.snapshot(); }
    const loaded0 = s.shells.loaded;
    const miss1 = await C.fire({ x: 100, y: 100 });
    const loaded1 = C.snapshot().shells.loaded;
    await C.fire({ x: 100, y: 100 });
    const loaded2 = C.snapshot().shells.loaded;
    const dry = await C.fire({ x: 100, y: 100 });
    return { loaded0, loaded1, loaded2, miss: miss1.events.map((e) => e.type), dry: dry.events.map((e) => e.type) };
  });
  assert.deepEqual([r.loaded0, r.loaded1, r.loaded2], [2, 1, 0]);
  assert.ok(r.miss.includes('shot') && !r.miss.includes('hit'));
  assert.ok(r.dry.includes('dryFire'), `an empty gun clicks: ${r.dry}`);
  const card = await page.evaluate(async () => {
    const C = __clay;
    C.start('classic', { seed: 3 });
    let s = C.snapshot();
    for (let i = 0; i < 4000 && !(s.phase === 'stageCard' && s.stage.id === 'hills'); i++) {
      const tg = s.targets.find((t) => t.ageS > 0.15);
      if (tg && s.shells.loaded > 0) await C.shootTarget(tg.id); else C.advance(25);
      s = C.snapshot();
    }
    for (let i = 0; i < 10; i++) { C.advance(80); C.debug.draw(); }
    return { phase: C.snapshot().phase, stage: C.snapshot().stage };
  });
  assert.equal(card.phase, 'stageCard');
  assert.equal(card.stage.name, 'Golden Hills');
  await env.screenshot(page, 'stage-card');
  noErrors(page);
});

test('e2e 4: Time Attack plays to "TIME!" and the results; Zen breaks clays and "END SESSION" shows the session results', { skip }, async () => {
  const page = await env.openGame(Q);
  const ta = await page.evaluate(() => __helpers.botPlay('timeattack', { seed: 5, stage: 'alpine', missEvery: 4 }));
  assert.equal(ta.screen, 'results');
  assert.equal(ta.endReason, 'timer');
  assert.ok(ta.snapStats.broken > 15, `broken ${ta.snapStats.broken}`);
  await env.screenshot(page, 'timeattack-results');
  const zen = await page.evaluate(async () => {
    const r = await __helpers.botPlay('zen', { seed: 2, stage: 'meadow', maxS: 25 });
    return { r, screen: __clay.getUiState().screen };
  });
  assert.equal(zen.screen, 'playing', 'Zen has no end of its own');
  assert.ok(zen.r.snapStats.broken >= 5, `broken ${zen.r.snapStats.broken}`);
  await env.screenshot(page, 'zen');
  await ev(page, "__clay.pause(); __clay.advance(100)");
  await env.screenshot(page, 'paused');
  const view = await ev(page, '__clay.debug.getUiView()');
  const end = view.targets.find((x) => x.id === 'pause.quit');
  assert.ok(end, 'the pause panel has "END SESSION"');
  await page.mouse.move(end.x, end.y);
  await page.mouse.down(end.x, end.y);
  await page.mouse.up(end.x, end.y);
  await ev(page, '__clay.advance(500)');
  assert.equal((await ev(page, '__clay.getUiState()')).screen, 'results');
  assert.equal((await ev(page, '__clay.snapshot()')).mode, 'zen');
  noErrors(page);
});

test('e2e 5: determinism: two page loads with the same seed and the same bot give identical snapshot hash sequences', { skip }, async () => {
  const play = async (seed) => {
    const page = await env.openGame(`${Q}&seed=${seed}`);
    const prints = await page.evaluate(async () => {
      __clay.start('timeattack');
      const out = [];
      for (let i = 0; i < 300; i++) {
        __clay.advance(50);
        const s = __clay.snapshot();
        out.push(__helpers.fingerprint(s.game));
        const tg = s.targets.find((t) => t.ageS > 0.3);
        if (i % 4 === 0 && tg && s.shells.loaded > 0) await __clay.shootTarget(tg.id);
      }
      return out;
    });
    await page.close();
    return prints;
  };
  const a = await play(5);
  const b = await play(5);
  const c = await play(6);
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, c);
  assert.ok(new Set(a).size > 150);
});

test('e2e 6: keyboard and safety: the safety screen is locked for 2 s, Enter confirms; Enter calls "Pull!", F fires, Escape and P pause', { skip }, async () => {
  const page = await env.openGame('input=sim&clock=manual&mute=1');
  assert.equal((await ev(page, '__clay.getUiState()')).screen, 'safety');
  await env.screenshot(page, 'safety');
  await page.key('Enter');
  assert.equal((await ev(page, '__clay.getUiState()')).screen, 'safety', 'locked');
  await ev(page, '__clay.advance(2100)');
  await page.key('Enter');
  assert.equal((await ev(page, '__clay.getUiState()')).screen, 'menu');
  await ev(page, "__clay.start('classic', {seed: 1, autoLaunch: false}); __clay.advance(800)");
  await env.screenshot(page, 'ready');
  await page.key('Enter');
  await ev(page, '__clay.advance(40)');
  assert.equal((await ev(page, '__clay.snapshot()')).phase, 'pull', 'Enter called "Pull!"');
  await ev(page, '__clay.advance(900)');
  await page.key('f', 'KeyF');
  await ev(page, '__clay.advance(40)');
  const shot = (await ev(page, '__clay.snapshot()')).events.filter((e) => e.type === 'shot').pop();
  assert.equal(shot && shot.source, 'keyboard');
  await page.key('Escape');
  assert.equal((await ev(page, '__clay.getUiState()')).screen, 'paused');
  await page.key('Enter'); // Resume
  await ev(page, '__clay.advance(3300)');
  assert.equal((await ev(page, '__clay.getUiState()')).screen, 'playing');
  await page.key('p', 'KeyP');
  assert.equal((await ev(page, '__clay.getUiState()')).screen, 'paused');
  noErrors(page);
});

test('e2e 7: settings: the settings screen changes values with clicks, they persist across a reload, and reach Motion', { skip }, async () => {
  const page = await env.openGame(Q);
  const click = async (id) => {
    const tg = (await ev(page, '__clay.debug.getUiView()')).targets.find((x) => x.id === id);
    assert.ok(tg, id);
    await page.mouse.move(tg.x, tg.y);
    await page.mouse.down(tg.x, tg.y);
    await page.mouse.up(tg.x, tg.y);
    await ev(page, '__clay.advance(50)');
  };
  await ev(page, '__clay.advance(300)');
  await click('menu.settings');
  assert.equal((await ev(page, '__clay.getUiState()')).screen, 'settings');
  await click('set.sensitivity.plus');
  await click('set.aimCurve.opt.precise');
  await click('set.crosshairColor.opt.green');
  await env.screenshot(page, 'settings');
  const m = await ev(page, '__clay.getMotionState()');
  assert.ok(m, 'motion state');
  await click('set.tune');
  assert.equal((await ev(page, '__clay.getUiState()')).screen, 'tuning');
  await ev(page, '__clay.sim.fire(); __clay.advance(300)');
  const tune = (await ev(page, '__clay.debug.getUiView()')).tune;
  assert.ok(tune.lastShot && tune.lastShot.valid, 'shotFeedback reached the tuning screen');
  await env.screenshot(page, 'tuning');
  await page.goto(`${env.url}/?${Q}`);
  await page.evaluate('window.__clay.ready');
  const s = await ev(page, '__clay.getSettings()');
  assert.deepEqual([s.sensitivity, s.aimCurve, s.crosshairColor], [1.1, 'precise', 'green']);
  noErrors(page);
});

test('e2e 8: calibration with the simulator (?simcal=1): the real wizard, then the practice clay of step 4; hitting it ends on the menu', { skip }, async () => {
  const page = await env.openGame(`${Q}&simcal=1&simseed=5`);
  assert.equal((await ev(page, '__clay.getUiState()')).screen, 'calibration');
  await ev(page, '__clay.advance(800)');
  await env.screenshot(page, 'calibration');
  const r = await page.evaluate(async () => {
    const C = __clay;
    let g = 0;
    while (C.getUiState().calibrationStep !== 4 && g++ < 1000) C.advance(50);
    const step = C.getUiState().calibrationStep;
    const mode = C.snapshot().mode;
    while (!C.snapshot().targets.some((t) => t.ageS > 0.4) && g++ < 2000) C.advance(50);
    return { step, mode, id: C.snapshot().targets[0].id };
  });
  assert.equal(r.step, 4);
  assert.equal(r.mode, 'practice');
  await env.screenshot(page, 'calibration-practice');
  const hit = await page.evaluate(async (id) => (await __clay.shootTarget(id)).hit, r.id);
  assert.equal(hit, true);
  await ev(page, '__clay.advance(300)');
  assert.equal((await ev(page, '__clay.getUiState()')).screen, 'menu');
  assert.equal((await ev(page, '__clay.snapshot()')).calibrated, true);
  noErrors(page);
});

test('e2e 9: storage failure: with every Storage call throwing the game boots, plays a round to the results and keeps settings in memory', { skip }, async () => {
  const init = `
    for (const m of ['getItem', 'setItem', 'removeItem', 'clear', 'key']) Storage.prototype[m] = function () { throw new Error('storage blocked'); };
    Object.defineProperty(window, 'localStorage', { get() { throw new Error('storage blocked'); } });
    Object.defineProperty(window, 'sessionStorage', { get() { throw new Error('storage blocked'); } });
  `;
  const page = await env.openGame(Q, { init: [init] });
  const r = await page.evaluate(() => __helpers.botPlay('timeattack', { seed: 3 }));
  assert.equal(r.screen, 'results');
  assert.ok(r.score > 0);
  noErrors(page);
  const s = await page.evaluate(() => __clay.setSetting('sensitivity', 1.5));
  assert.equal(s.sensitivity, 1.5);
});

test('e2e 10: the real clock with real mouse events: menu card, setup, countdown, a click calls "Pull!", a click on the clay breaks it', { skip }, async () => {
  const page = await env.openGame('input=mouse&skipsafety=1&mute=1&seed=2');
  const click = async (x, y) => {
    await page.mouse.move(x, y);
    await page.mouse.down(x, y);
    await page.mouse.up(x, y);
  };
  const target = async (id) => (await ev(page, '__clay.debug.getUiView()')).targets.find((x) => x.id === id);
  await sleep(400);
  const card = await target('menu.classic');
  await click(card.x, card.y);
  await sleep(200);
  assert.equal((await ev(page, '__clay.getUiState()')).screen, 'setup');
  await env.screenshot(page, 'setup');
  const start = await target('setup.start');
  await click(start.x, start.y);
  await sleep(1000);
  assert.equal((await ev(page, '__clay.getUiState()')).screen, 'countdown');
  await env.screenshot(page, 'countdown');
  await page.waitFor("__clay.getUiState().screen === 'playing' && __clay.snapshot().phase === 'ready'", { timeoutMs: 6000, message: 'the round' });
  await click(960, 500); // "Pull!"
  await page.waitFor('__clay.snapshot().targets.some((t) => t.ageS > 0.25)', { timeoutMs: 3000, message: 'a clay in flight' });
  const tg = await ev(page, '__clay.snapshot().targets[0]');
  const now = await page.evaluate((id) => { const t = __clay.snapshot().targets.find((x) => x.id === id); return { x: t.sx, y: t.sy }; }, tg.id);
  await click(now.x, now.y);
  await sleep(150);
  const s = await ev(page, '__clay.snapshot()');
  const shot = s.events.filter((e) => e.type === 'shot').pop();
  assert.equal(shot.source, 'mouse');
  assert.ok(Math.hypot(shot.x - now.x, shot.y - now.y) < 2, 'the shot went where the mouse pressed');
  assert.ok(s.stats.hits >= 1, `the clay broke (the clay moves a few px between the read and the click): ${JSON.stringify(s.stats)}`);
  noErrors(page);
});

test('e2e 11: audio: the engine unlocks on the first click and plays the shots and breaks of a real-time round without an error', { skip }, async () => {
  const page = await env.openGame('input=sim&skipsafety=1&seed=5');
  assert.equal((await ev(page, '__clay.debug.getAudio()')).ready, false, 'silent until the first user gesture (browser autoplay rule)');
  await page.mouse.move(900, 120);
  await page.mouse.down(900, 120);
  await page.mouse.up(900, 120);
  await page.waitFor('__clay.debug.getAudio().ready === true', { timeoutMs: 3000, message: 'the audio engine to unlock' });
  await ev(page, "__clay.start('zen', { seed: 5 })");
  const r = await page.evaluate(() => __helpers.botRealTime(7000));
  assert.ok(r.hits >= 2, `hits ${r.hits}`);
  const audio = await ev(page, '__clay.debug.getAudio()');
  assert.equal(audio.ready, true);
  assert.equal(audio.stats.errors, 0);
  assert.ok(audio.stats.played >= r.hits, `sounds played ${audio.stats.played} for ${r.hits} hits`);
  noErrors(page);
});
