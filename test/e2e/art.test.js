// e2e (headless Chrome over CDP) for the generated art (docs/architecture.md C-11 and section 7): the real files of public/assets/ through the real server,
// then the fallbacks: ?assets=0, a manifest that fails, files that are missing (404), and a manifest that arrives late.
// Skipped (never "passed") when Chrome is missing. Screenshots for a human go to E2E_SCREENSHOTS when it is set (never into public/ or design/).
// Nothing here says anything about the physical Joy-Con (UNVERIFIED-ON-HARDWARE); the numbers of a headless Chrome are not the owner's Mac.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { startE2e } from '../../test-support/e2e/env.js';

const env = await startE2e();
const skip = env.skip;
after(() => env.close());

const REAL = 'input=sim&skipsafety=1&mute=1';
const MANUAL = 'input=sim&clock=manual&skipsafety=1&mute=1';
const manifest = JSON.parse(readFileSync(new URL('../../public/assets/manifest.json', import.meta.url), 'utf8'));
const CORE_TOTAL = manifest.groups.core.length;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll `expression` in the page until it is truthy (real time). */
async function until(page, expression, message, timeoutMs = 10000) {
  return page.waitFor(expression, { timeoutMs, pollMs: 40, message });
}

/** Answer requests under /assets/ by hand: {match: RegExp, status?: number, fail?: true, delayMs?: number}. Everything else goes through. */
async function intercept(page, rules) {
  const seen = [];
  page.conn.on('Fetch.requestPaused', async (p) => {
    const url = p.request.url;
    const rule = rules.find((r) => r.match.test(url));
    try {
      if (rule) seen.push({ url, rule, at: Date.now() });
      if (rule?.delayMs) await sleep(rule.delayMs);
      if (rule && rule.status) await page.send('Fetch.fulfillRequest', { requestId: p.requestId, responseCode: rule.status, responseHeaders: [{ name: 'Content-Type', value: 'text/plain' }], body: '' });
      else if (rule && rule.fail) await page.send('Fetch.failRequest', { requestId: p.requestId, errorReason: 'Failed' });
      else await page.send('Fetch.continueRequest', { requestId: p.requestId });
    } catch {
      /* the page was closed while a request was paused */
    }
  }, page.sessionId);
  await page.send('Fetch.enable', { patterns: [{ urlPattern: '*/assets/*' }] });
  return seen;
}

/** Mean and spread of a coarse grid of the canvas: a blank frame has a spread of 0. */
const CANVAS_STATS = `(() => {
  const c = document.getElementById('stage');
  const ctx = c.getContext('2d');
  const vals = [];
  for (let i = 0; i < 32; i++) for (let j = 0; j < 18; j++) {
    const d = ctx.getImageData(Math.floor(((i + 0.5) * c.width) / 32), Math.floor(((j + 0.5) * c.height) / 18), 1, 1).data;
    vals.push(0.2126 * d[0] + 0.7152 * d[1] + 0.0722 * d[2]);
  }
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  const sd = Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length);
  return { mean, sd, colours: __helpers.canvasColours() };
})()`;

/** How many pixels of the bottom row of the playfield have the vermilion of the thin loading bar (0 when there is no bar). */
const BAR_PIXELS = `(() => {
  const c = document.getElementById('stage');
  const ctx = c.getContext('2d');
  const k = c.width / 1920;
  const d = ctx.getImageData(0, Math.round(1077 * k), c.width, 1).data;
  let n = 0;
  for (let i = 0; i < d.length; i += 4) if (d[i] > 140 && d[i + 1] < 90 && d[i + 2] < 90) n++;
  return n;
})()`;

const onlyBrowserNetworkLines = (lines) => lines.filter((l) => !/Failed to load resource/.test(l));

/** Visit every screen and overlay with the manual clock and check that each one paints a real frame. */
async function visitEveryScreen(page, label) {
  const shots = [];
  // an overlay dims the frozen frame under a paper panel, so it legitimately has fewer colours and less spread
  const visit = async (name, setup, { colours = 12, spread = 8 } = {}) => {
    await page.evaluate(setup);
    await page.evaluate('__clay.advance(200); __clay.debug.draw();');
    const stats = await page.evaluate(CANVAS_STATS);
    assert.ok(stats.colours > colours, `${label} ${name}: ${stats.colours} colours`);
    assert.ok(stats.sd > spread, `${label} ${name}: the frame is not flat (spread ${stats.sd.toFixed(1)})`);
    await env.screenshot(page, `${label}-${name}`);
    shots.push(name);
  };
  await visit('menu', "__clay.debug.forceScreen('menu')");
  await visit('settings', "__clay.debug.forceScreen('settings')");
  await visit('tuning', "__clay.debug.forceScreen('tuning')");
  await visit('connect', "__clay.debug.forceScreen('connect')");
  await visit('safety', "__clay.debug.forceScreen('safety')");
  for (const step of [1, 2, 3, 4]) await visit(`calibration-${step}`, `__clay.debug.forceScreen('calibration', { step: ${step} })`);
  await visit('setup', "__clay.debug.forceScreen('setup', { mode: 'timeattack' })");
  await visit('best', "__clay.debug.forceScreen('best')");
  await visit('countdown', "__clay.start('classic', { seed: 4, skipCountdown: false })");
  await visit('classic', "__clay.start('classic', { seed: 4 }); __clay.advance(2600)");
  await visit('timeattack', "__clay.start('timeattack', { seed: 4, stage: 'alpine' }); __clay.advance(2600)");
  await visit('zen', "__clay.start('zen', { seed: 4, stage: 'meadow' }); __clay.advance(2600)");
  await visit('paused', "__clay.press('pause')");
  await visit('results', "__clay.debug.forceScreen('results', { roundMode: 'classic' })");
  await visit('disconnected', "__clay.start('classic', { seed: 4 }); __clay.advance(300); __clay.sim.simulateLoss()", { colours: 5, spread: 2 });
  assert.equal(await page.evaluate("__clay.getUiState().overlay"), 'disconnected');
  return shots;
}

const world = (page) => page.evaluate('__clay.debug.getWorld()');

test('e2e art 1: with the real files the art loads (core, then the stage the world asks for), every stage shows its pictures, at most two stages stay decoded', { skip }, async (t) => {
  const page = await env.openGame(`${REAL}&seed=5`);
  const a0 = await page.evaluate('__clay.getAssets()');
  assert.equal(a0.enabled, true);
  await until(page, "__clay.getAssets().groups.core && __clay.getAssets().groups.core.state === 'ready'", 'core ready');
  const a1 = await page.evaluate('__clay.getAssets()');
  assert.equal(a1.manifest, 'ready');
  assert.equal(a1.groups.core.loaded, CORE_TOTAL);
  assert.equal(a1.groups.core.failed, 0);
  await until(page, "__clay.debug.getWorld().stage === 'hills' && __clay.debug.getWorld().layers.far", 'the menu backdrop (hills) shows its art');
  await env.screenshot(page, 'art1-menu');
  let maxResident = 0;
  for (const [mode, stage] of [['classic', 'meadow'], ['timeattack', 'alpine'], ['zen', 'hills']]) {
    await page.evaluate(`__clay.start('${mode}', { seed: 5, stage: '${stage}' })`);
    const t0 = Date.now();
    for (;;) {
      const w = await world(page);
      maxResident = Math.max(maxResident, w.stageStatus ? w.stageStatus.resident.length : 0);
      if (w.stage === stage && w.layers.far && w.layers.near && !(w.stageStatus && w.stageStatus.fading)) break;
      assert.ok(Date.now() - t0 < 8000, `the ${stage} stage did not arrive (${JSON.stringify(w.stageStatus)} ${JSON.stringify(await page.evaluate("__clay.getAssets().groups"))})`);
      await sleep(30);
    }
    t.diagnostic(`${mode} (${stage}): stage on screen ${Date.now() - t0} ms after start (headless Chrome, loopback)`);
    const stats = await page.evaluate(CANVAS_STATS);
    assert.ok(stats.colours > 20 && stats.sd > 8, `${mode}: ${JSON.stringify(stats)}`);
    await env.screenshot(page, `art1-${mode}`);
    await page.evaluate("__clay.debug.forceScreen('menu')");
  }
  assert.ok(maxResident <= 3, `at most a few stages resident, saw ${maxResident}`);
  assert.deepEqual(page.consoleErrors(), []);
  assert.deepEqual(page.exceptions, []);
  assert.deepEqual(page.failedRequests, []);
  assert.deepEqual(page.badResponses, []);
  const asset = page.requests.filter((r) => r.url.includes('/assets/'));
  assert.ok(asset.length > CORE_TOTAL, `${asset.length} asset requests`);
  assert.equal(asset.every((r) => r.url.startsWith(env.url)), true, 'every asset comes from the game server');
  assert.equal(page.console.filter((c) => c.type === 'warning').length, 0, 'no loader warning when everything loads');
});

test('e2e art 2: every screen and overlay draws a real frame with the art (manual clock), no console error, no page error', { skip }, async () => {
  const page = await env.openGame(`${MANUAL}&seed=6`);
  await until(page, "__clay.getAssets().groups.core && __clay.getAssets().groups.core.state === 'ready'", 'core ready');
  await sleep(500);
  const shots = await visitEveryScreen(page, 'art');
  assert.equal(shots.length, 18);
  assert.deepEqual(page.consoleErrors(), []);
  assert.deepEqual(page.exceptions, []);
  assert.deepEqual(page.badResponses, []);
  const log = await page.evaluate('__clay.debug.getLog()');
  assert.deepEqual(log.filter((l) => l.level === 'error'), []);
});

test('e2e art 3: ?assets=0 is the procedural game: no request under /assets/ (pictures and fonts), the loader is off, every screen still draws, a round plays', { skip }, async () => {
  const page = await env.openGame(`${MANUAL}&seed=6&assets=0`);
  const a = await page.evaluate('__clay.getAssets()');
  assert.equal(a.enabled, false);
  assert.deepEqual(a.groups, {});
  assert.equal(page.requests.filter((r) => r.url.includes('/assets/')).length, 0, 'nothing under /assets/ is requested');
  await page.evaluate('__clay.advance(500); __clay.debug.draw();');
  assert.equal((await world(page)).layers.far, false, 'the painted backdrop');
  await visitEveryScreen(page, 'painted');
  const r = await page.evaluate(() => __helpers.botPlay('classic', { seed: 6, maxS: 25 }));
  assert.ok(r.snapStats.broken >= 5, `the bot broke ${r.snapStats.broken} clays on the painted game`);
  await env.screenshot(page, 'painted-play');
  assert.deepEqual(page.consoleErrors(), []);
  assert.deepEqual(page.exceptions, []);
  assert.equal(page.requests.filter((r2) => r2.url.includes('/assets/')).length, 0);
});

test('e2e art 4: a manifest that fails (network error) leaves the procedural game, one warning line, and every screen still draws', { skip }, async () => {
  const page = await env.newPage();
  const seen = await intercept(page, [{ match: /\/assets\/manifest\.json$/, fail: true }]);
  await page.goto(`${env.url}/?${MANUAL}&seed=6`);
  await page.evaluate('window.__clay.ready');
  const a = await page.evaluate('__clay.getAssets()');
  assert.equal(a.enabled, true, 'the loader exists');
  assert.equal(a.manifest, 'failed');
  assert.equal(seen.filter((x) => /manifest\.json$/.test(x.url)).length, 1);
  assert.equal(await page.evaluate("__clay.getUiState().screen"), 'menu');
  await page.evaluate('__clay.advance(500); __clay.debug.draw();');
  assert.equal((await world(page)).layers.far, false, 'painted backdrop');
  await visitEveryScreen(page, 'nomanifest');
  assert.deepEqual(onlyBrowserNetworkLines(page.consoleErrors()), [], 'only the browser\'s own line about the blocked file');
  assert.deepEqual(page.exceptions, []);
  const warns = page.console.filter((c) => c.type === 'warning' && /^\[clay-rush\] the asset manifest/.test(c.text));
  assert.equal(warns.length, 1, `one loader warning: ${JSON.stringify(page.console)}`);
});

test('e2e art 5: missing files (a clay sprite and a stage layer answer 404): the game runs, only those pictures are painted, one warning per group', { skip }, async () => {
  const page = await env.newPage();
  const rules = [
    { match: /\/assets\/sprites\/clay_std_tilt\.png$/, status: 404 },
    { match: /\/assets\/backgrounds\/bg_meadow_far\.jpg$/, status: 404 },
  ];
  const seen = await intercept(page, rules);
  await page.goto(`${env.url}/?${REAL}&seed=7`);
  await page.evaluate('window.__clay.ready');
  await until(page, "__clay.getAssets().groups.core && __clay.getAssets().groups.core.state === 'partial'", 'core partial');
  const a = await page.evaluate('__clay.getAssets()');
  assert.equal(a.groups.core.failed, 1, 'the clay sprite');
  assert.equal(a.groups.core.loaded, CORE_TOTAL - 1);
  // Classic starts on the meadow: its far layer is the missing one
  await page.evaluate("__clay.start('classic', { seed: 7 })");
  await until(page, "__clay.getAssets().groups['stage:meadow'] && __clay.getAssets().groups['stage:meadow'].state === 'partial'", 'meadow stage partial');
  const r = await page.evaluate(() => __helpers.botRealTime(5000));
  assert.ok(r.hits >= 1, `the bot broke ${r.hits} clays`);
  await env.screenshot(page, 'missing-files-play');
  assert.ok(seen.length >= 2, `the two files were requested: ${seen.map((x) => x.url)}`);
  assert.deepEqual(onlyBrowserNetworkLines(page.consoleErrors()), [], 'no error from the game itself');
  assert.deepEqual(page.exceptions, []);
  const warns = page.console.filter((c) => c.type === 'warning' && /^\[clay-rush\] asset group/.test(c.text));
  assert.ok(warns.some((w) => /"core"/.test(w.text)) && warns.some((w) => /"stage:meadow"/.test(w.text)), JSON.stringify(warns.map((w) => w.text)));
});

test('e2e art 6: a manifest that arrives late does not hold the game: it starts after the boot wait (2.5 s), the art comes in afterwards', { skip }, async () => {
  const page = await env.newPage();
  const seen = await intercept(page, [{ match: /\/assets\/manifest\.json$/, delayMs: 3300 }]);
  await page.goto(`${env.url}/?${REAL}&seed=8`);
  await page.evaluate('window.__clay.ready');
  const readyAfter = Date.now() - seen[0].at;
  assert.ok(readyAfter >= 1700 && readyAfter < 3200, `ready ${readyAfter} ms after the manifest was requested: the boot wait is 2.5 s, not the 3.3 s the manifest took`);
  const early = await page.evaluate('({ screen: __clay.getUiState().screen, manifest: __clay.getAssets().manifest })');
  assert.equal(early.screen, 'menu', 'the game is playable');
  assert.equal(early.manifest, 'loading');
  await page.evaluate("__clay.start('classic', { seed: 8 })");
  await until(page, "__clay.getAssets().groups.core && __clay.getAssets().groups.core.state === 'ready'", 'core ready after the manifest', 15000);
  await until(page, "__clay.debug.getWorld().layers.far", 'the meadow art after the manifest arrived', 15000);
  assert.deepEqual(page.consoleErrors(), []);
  assert.deepEqual(page.exceptions, []);
});

test('e2e art 7: the art is a skin: the same seeded rounds end in the same state with the art and with ?assets=0 (score, counters, fingerprint of the snapshot)', { skip }, async () => {
  const run = async (extra) => {
    const page = await env.openGame(`${MANUAL}&seed=9${extra}`);
    if (!extra) await until(page, "__clay.getAssets().groups.core && __clay.getAssets().groups.core.state === 'ready'", 'core ready');
    const out = [];
    for (const mode of ['classic', 'timeattack', 'zen']) {
      const r = await page.evaluate(async (m) => {
        const r0 = await window.__helpers.botPlay(m, { seed: 9, maxS: 30, stepMs: 40, missEvery: 3 });
        return { ...r0, fp: window.__helpers.fingerprint(window.__clay.snapshot().game) };
      }, mode);
      out.push({ mode, stats: r.stats, score: r.score, t: Math.round(r.t * 1000), snapStats: r.snapStats, fp: r.fp });
    }
    assert.deepEqual(page.consoleErrors(), []);
    return out;
  };
  const withArt = await run('');
  const painted = await run('&assets=0');
  assert.ok(withArt.some((r) => r.score > 0), 'the bot scored');
  assert.deepEqual(withArt, painted);
});
