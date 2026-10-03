// e2e (headless Chrome over CDP): the screen wake lock of round 1 finding M2 against the real Screen Wake Lock API. It proves the wiring in a
// real browser (the page asks while a round runs and hands the lock back in the menu). Whether macOS then really keeps the display awake
// for a Joy-Con session is UNVERIFIED-ON-HARDWARE; this test cannot say anything about the owner's Mac.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { startE2e } from '../../test-support/e2e/env.js';

const env = await startE2e();
const skip = env.skip;
after(() => env.close());

test('e2e 13: a round holds a screen wake lock in Chrome and the menu releases it (or a refusal is reported, never thrown)', { skip }, async () => {
  const page = await env.openGame('input=mouse&skipsafety=1&mute=1&seed=3');
  const state = () => page.evaluate('__clay.debug.getWakeLock()');
  const first = await state();
  assert.equal(first.wanted, false, 'nothing to keep awake in the menu with a mouse');
  assert.equal(first.requests, 0);
  if (!first.supported) return; // a Chrome without the API: nothing more to check
  await page.evaluate("__clay.start('classic', { seed: 3 })");
  await page.waitFor('(() => { const w = __clay.debug.getWakeLock(); return w.grants > 0 || w.lastError !== null; })()', { timeoutMs: 5000, message: 'the browser to answer the wake lock request' });
  const playing = await state();
  assert.equal(playing.wanted, true);
  assert.equal(playing.requests >= 1, true);
  if (playing.grants > 0) {
    assert.equal(playing.held, true, 'held while the round runs');
    await page.evaluate("__clay.debug.forceScreen('menu')");
    await page.waitFor('__clay.debug.getWakeLock().held === false', { timeoutMs: 3000, message: 'the lock to be released in the menu' });
    assert.equal((await state()).wanted, false);
  } else {
    assert.match(playing.lastError, /\w/, 'a refusal is recorded');
  }
  assert.deepEqual(page.consoleErrors(), []);
  assert.deepEqual(page.exceptions, []);
});
