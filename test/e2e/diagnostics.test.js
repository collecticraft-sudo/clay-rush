// e2e (headless Chrome over CDP): the diagnostics page against the simulator (?input=sim). This is how the page is tested without a
// Joy-Con; on the real controller its numbers are UNVERIFIED-ON-HARDWARE until the owner runs it (docs/GUIDE.md).
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { startE2e } from '../../test-support/e2e/env.js';

const env = await startE2e();
const skip = env.skip;
after(() => env.close());

const text = (page, id) => page.evaluate(`document.getElementById('${id}').textContent`);

test('e2e 11: diagnostics.html?input=sim connects, shows a packet rate near 66 Hz, |a| about 1 g, the battery band and no console errors', { skip }, async () => {
  const page = await env.newPage();
  await page.goto(`${env.url}/diagnostics.html?input=sim`);
  assert.match(await text(page, 'mode-chip'), /Simulator/);
  await page.evaluate("document.getElementById('btn-connect').click()");
  await page.waitFor("document.getElementById('st-state').textContent === 'streaming'", { message: 'the page to reach streaming' });
  await page.waitFor("document.getElementById('rt-1s').textContent.includes('Hz')", { timeoutMs: 8000, message: 'a packet rate' });
  await new Promise((r) => setTimeout(r, 2500));
  const rate = Number.parseFloat(await text(page, 'rt-1s'));
  assert.ok(rate > 55 && rate < 75, `packet rate ${rate} Hz (the simulator models 66 Hz)`);
  const a = /\|a\| = ([\d.]+) g/.exec(await text(page, 'lv-a'));
  assert.ok(a && Math.abs(Number(a[1]) - 1) < 0.05, `|a| ${a && a[1]}`);
  assert.match(await text(page, 'lv-len'), /63/);
  assert.match(await text(page, 'lv-batt'), /3700 mV/);
  assert.equal(await text(page, 'lv-imu'), 'true');
  assert.match(await text(page, 'lv-marker'), /0x01 \(expected\)/, 'F5: the IMU marker byte at 0x29 is shown and is the expected 0x01');
  assert.match(await text(page, 'st-side'), /^R/);
  assert.equal(await text(page, 'st-error'), 'none');
  // the stick rows: the simulator's stick rests at the builder's 2047 / 2047 (the real Right unit rests at 1998 / 2007, test/input/stick.test.js)
  assert.match(await text(page, 'lv-stick-raw'), /used \(right field\)\s+x 2047\s+y 2047/);
  assert.match(await text(page, 'lv-stick-norm'), /x \+0\.00\s+y \+0\.00 \(up = \+\)\s+magnitude 0\.00\s+in the dead zone/);
  assert.match(await text(page, 'lv-stick-centre'), /x 2047\.0\s+y 2047\.0\s+\(estimated from the first untouched reports/);
  assert.match(await text(page, 'lv-stick-dir'), /centred, ready\s+last flick: none\s+flicks so far: 0/);
  assert.equal(await text(page, 'lv-buttons'), 'none');
  assert.match(await text(page, 'rt-dt'), /device timestamps/);
  assert.match(await text(page, 'lat-stats'), /frames/);
  assert.deepEqual(page.consoleErrors(), []);
  assert.deepEqual(page.exceptions, []);
  assert.deepEqual(page.failedRequests, []);
  assert.deepEqual(page.badResponses, []);
  await env.screenshot(page, 'diagnostics');
});

test('e2e 11: the diagnostics page without ?input shows the native bridge mode (?input=joycon is Web Bluetooth), and Disconnect returns the simulator to idle', { skip }, async () => {
  const page = await env.newPage();
  await page.goto(`${env.url}/diagnostics.html`);
  assert.match(await text(page, 'mode-chip'), /Native bridge \(recommended\)/);
  const ble = await env.newPage();
  await ble.goto(`${env.url}/diagnostics.html?input=joycon`);
  assert.match(await text(ble, 'mode-chip'), /Real Joy-Con \(Chrome's Bluetooth\)/);
  assert.equal(await ble.evaluate("getComputedStyle(document.getElementById('opt-filter').parentElement).display !== 'none'"), true, 'the chooser filter is shown for Web Bluetooth');
  assert.equal(await ble.evaluate("getComputedStyle(document.getElementById('opt-pairing').parentElement).display"), 'none', 'the native-only option is not');
  const page2 = await env.newPage();
  await page2.goto(`${env.url}/diagnostics.html?input=sim&simhz=250&simmount=tilted`);
  await page2.evaluate("document.getElementById('btn-connect').click()");
  await page2.waitFor("document.getElementById('st-state').textContent === 'streaming'");
  await new Promise((r) => setTimeout(r, 2200));
  const rate = Number.parseFloat(await text(page2, 'rt-1s'));
  assert.ok(rate > 200 && rate < 280, `?simhz=250 gives ${rate} Hz`);
  await page2.evaluate("document.getElementById('btn-disconnect').click()");
  await page2.waitFor("document.getElementById('st-state').textContent === 'idle'");
});

test('e2e 12 (round 1 F3, M5): the rest check reads the accelerometer sign, saves it for the game, and the page shows the game URL that uses its choices', { skip }, async () => {
  const page = await env.newPage();
  try {
    await accelSignFlow(page);
  } finally {
    await page.evaluate("localStorage.removeItem('joyconNinja.imu.v1')").catch(() => {}); // the profile is shared with the other tests
  }
});

async function accelSignFlow(page) {
  await page.goto(`${env.url}/diagnostics.html?input=sim&simaccelsign=-1`);
  await page.evaluate("document.getElementById('btn-connect').click()");
  await page.waitFor("document.getElementById('st-state').textContent === 'streaming'");
  assert.equal(await page.evaluate("document.getElementById('accel-save').disabled"), true, 'nothing to save before the rest check');
  await page.evaluate("document.getElementById('rest-start').click()");
  await page.waitFor("document.getElementById('rest-z').textContent !== '-'", { timeoutMs: 8000, message: 'the rest check result' });
  assert.match(await text(page, 'rest-z'), /OPPOSITE/, 'Z reads -1 g with a gravity-vector sensor');
  assert.match(await text(page, 'rest-av'), /-(?:1\.0|0\.99\d)/, 'the mean of the vertical axis is about -1 g (the noise of a short rest window on a busy machine can read -0.9998)');
  assert.equal(await page.evaluate("document.getElementById('accel-save').disabled"), false);
  assert.match(await text(page, 'accel-save'), /-1/);
  assert.match(await text(page, 'game-url'), /accelsign=-1/, 'the URL already carries the measured sign');
  await page.evaluate("document.getElementById('accel-save').click()");
  const saved = JSON.parse(await page.evaluate("localStorage.getItem('joyconNinja.imu.v1')"));
  assert.equal(saved.accelSign, -1);
  await page.waitFor("document.getElementById('accel-msg').textContent.startsWith('Saved')", { timeoutMs: 3000, message: 'the saved message' });
  // the game (same browser profile) picks the saved sign up, and ?accelsign=1 still overrides it
  const game = await env.openGame('input=joycon&skipsafety=1&mute=1');
  assert.equal(await game.evaluate('window.__clay.debug.getMotionDebug().accelSign'), -1);
  const forced = await env.openGame('input=joycon&skipsafety=1&mute=1&accelsign=1');
  assert.equal(await forced.evaluate('window.__clay.debug.getMotionDebug().accelSign'), 1);
  const sim = await env.openGame('input=sim&skipsafety=1&mute=1');
  assert.equal(await sim.evaluate('window.__clay.debug.getMotionDebug().accelSign'), 1, 'the simulator never uses the value saved for a real Joy-Con');
  assert.deepEqual(page.consoleErrors(), []);
  assert.deepEqual(page.exceptions, []);
}

test('e2e 12 (round 1 F1, M5): the mask selector offers 0xB7 (default), 0xFF and 0x37; the game URL follows the filter, mask and side choices', { skip }, async () => {
  const page = await env.newPage();
  await page.goto(`${env.url}/diagnostics.html?input=joycon`); // the Web Bluetooth mode (the default mode is the native bridge)
  assert.deepEqual(await page.evaluate("[...document.querySelectorAll('#opt-mask option')].map((o) => o.value)"), ['183', '255', '55']);
  assert.equal(await page.evaluate("document.getElementById('opt-mask').value"), '183', '0xB7 is preselected');
  assert.deepEqual(await page.evaluate("[...document.querySelectorAll('#opt-filter option')].map((o) => o.value)"), ['lenient', 'strict', 'all'], 'lenient first: it is the default');
  assert.equal(await page.evaluate("document.getElementById('opt-filter').value"), 'lenient', 'the recommended (default) filter is preselected');
  assert.deepEqual(await page.evaluate("[...document.querySelectorAll('#opt-filter option')].map((o) => o.textContent)"), ['product id only (recommended)', 'SYNC mode only (stricter)', 'all devices']);
  assert.equal(await page.evaluate("document.getElementById('game-url').getAttribute('href')"), `${env.url}/`, 'the defaults need no flags');
  await page.evaluate(`(() => {
    const set = (id, v) => { const e = document.getElementById(id); e.value = v; e.dispatchEvent(new Event('change')); };
    set('opt-filter', 'strict'); set('opt-mask', '255'); set('opt-side', 'L');
  })()`);
  assert.equal(await page.evaluate("document.getElementById('game-url').getAttribute('href')"), `${env.url}/?filter=strict&mask=0xFF&side=L`);
  assert.equal(await text(page, 'game-url'), `${env.url}/?filter=strict&mask=0xFF&side=L`);
  assert.deepEqual(page.consoleErrors(), []);
});

test('e2e (round 2 m1, n10): the diagnostics page lists the saved values and "Clear the saved values" removes them', { skip }, async () => {
  const page = await env.newPage();
  await page.goto(`${env.url}/diagnostics.html?input=sim`);
  assert.match(await text(page, 'saved-msg'), /No saved values/);
  await page.evaluate(`localStorage.setItem('joyconNinja.imu.v1', JSON.stringify({ gyroScale: 0.12288, accelSign: -1, measuredAt: '2026-09-30T00:00:00.000Z' }))`);
  await page.waitFor("document.getElementById('saved-msg').textContent.includes('0.12288')", { timeoutMs: 6000, message: 'the saved scale to be listed' });
  assert.match(await text(page, 'saved-msg'), /accelerometer sign -1/);
  await page.evaluate("document.getElementById('saved-clear').click()");
  await page.waitFor("document.getElementById('saved-msg').textContent.includes('cleared')", { message: 'the cleared message' });
  assert.equal(await page.evaluate("localStorage.getItem('joyconNinja.imu.v1')"), null);
  assert.deepEqual(page.consoleErrors(), []);
});
