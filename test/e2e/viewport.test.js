// e2e (headless Chrome over CDP): the canvas in other window shapes: letterboxing keeps the pointer mapping exact, HiDPI gets a
// sharper backing store, and a resize during play keeps the game running. Skipped (never "passed") when Chrome is missing.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { startE2e } from '../../test-support/e2e/env.js';

const env = await startE2e();
const skip = env.skip;
after(() => env.close());

const ev = (page, expr) => page.evaluate(expr);

test('e2e viewport: in a 1000 x 800 window (letterboxed) the pointer still maps exactly onto the playfield and a click selects the right menu card', { skip }, async () => {
  const page = await env.newPage({ width: 1000, height: 800 });
  await env.openGame('input=mouse&clock=manual&skipsafety=1&mute=1&seed=1', { page });
  const scale = Math.min(1000 / 1920, 800 / 1080);
  const offY = (800 - 1080 * scale) / 2;
  const client = (x, y) => [x * scale, offY + y * scale];
  await ev(page, '__clay.advance(700)');
  await page.mouse.move(...client(960, 300));
  await ev(page, '__clay.advance(100)');
  const m = await ev(page, '__clay.getMotionState()');
  assert.ok(Math.abs(m.x - 960) < 2 && Math.abs(m.y - 300) < 2, `cursor ${m.x},${m.y} expected 960,300`);
  const [cx, cy] = client(400, 565); // the Classic card
  await page.mouse.down(cx, cy);
  await page.mouse.up(cx, cy);
  const st = await ev(page, '__clay.getUiState()');
  assert.equal(st.screen, 'setup');
  assert.equal((await ev(page, '__clay.debug.getUiView()')).targets.some((t) => t.id === 'setup.start'), true, 'the Classic setup');
  const dims = await ev(page, '({w: document.getElementById("stage").width, h: document.getElementById("stage").height, cw: innerWidth, ch: innerHeight})');
  assert.equal(dims.w, dims.cw, 'the canvas fills the window width');
  assert.equal(dims.h, dims.ch, 'and its height');
  assert.deepEqual(page.consoleErrors(), []);
});

test('e2e viewport: HiDPI (device pixel ratio 2) draws into a 2x backing store without errors', { skip }, async () => {
  const page = await env.newPage({ width: 1280, height: 720, deviceScaleFactor: 2 });
  await env.openGame('input=sim&clock=manual&skipsafety=1&mute=1&seed=1', { page });
  await ev(page, "__clay.start('classic', {seed: 1}); __clay.advance(1500); __clay.debug.draw();");
  const r = await ev(page, '({w: document.getElementById("stage").width, dpr: devicePixelRatio, colours: __helpers.canvasColours()})');
  assert.equal(r.dpr, 2);
  assert.equal(r.w, 2560);
  assert.ok(r.colours > 20);
  assert.deepEqual(page.consoleErrors(), []);
});

test('e2e viewport: resizing the window during play keeps the game running and the mapping exact', { skip }, async () => {
  const page = await env.newPage({ width: 1600, height: 900 });
  await env.openGame('input=mouse&clock=manual&skipsafety=1&mute=1&seed=1', { page });
  await ev(page, "__clay.start('classic', {seed: 1}); __clay.advance(1000);");
  await page.send('Emulation.setDeviceMetricsOverride', { width: 900, height: 900, deviceScaleFactor: 1, mobile: false });
  await new Promise((r) => setTimeout(r, 300)); // ResizeObserver fires on the next frame
  await ev(page, '__clay.advance(500)');
  const scale = 900 / 1920;
  const offY = (900 - 1080 * scale) / 2;
  await page.mouse.move(600 * scale, offY + 400 * scale);
  await ev(page, '__clay.advance(50)');
  const m = await ev(page, '__clay.getMotionState()');
  assert.ok(Math.abs(m.x - 600) < 3 && Math.abs(m.y - 400) < 3, `cursor ${m.x},${m.y} expected 600,400 after the resize`);
  assert.equal((await ev(page, '__clay.getUiState()')).screen, 'playing');
  assert.deepEqual(page.consoleErrors(), []);
});

test('e2e: window.__clay.getConfig() crosses the CDP boundary as plain data', { skip }, async () => {
  const page = await env.openGame('input=sim&clock=manual&skipsafety=1&mute=1');
  const cfg = await ev(page, '__clay.getConfig()');
  assert.equal(cfg.game.storage.key, 'clayRush.v1');
  assert.ok(cfg.game.classic && cfg.game.timeattack, 'the mode blocks of the game config');
  assert.equal(cfg.motion.pointer.gHiPxDeg, 14, 'the Balanced aim curve');
  assert.ok(cfg.motion.aimCurves.precise && cfg.motion.aimCurves.fast);
  assert.equal(cfg.motion.shot.settleMs, 80);
  assert.equal(cfg.input.service, 'ab7de9be-89fe-49ad-828f-118f09df7fd0');
});
