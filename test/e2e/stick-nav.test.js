// e2e (headless Chrome over CDP): the REAL game on the native Bluetooth bridge path against the REAL server and the FAKE helper process (test-support/bridge/fake-helper.mjs),
// walked with the controller's stick and buttons only: the fake helper writes a stick position and button bits into real 63-byte reports, which travel through the server,
// the browser, the real parser, the real report stream and the real UI. Menu -> settings -> back, edge-triggering, a Joy-Con pointer that selects nothing (C-07).
// What this proves: the wiring in a real browser. What it CANNOT prove: the stick of the physical Joy-Con (centre, direction, travel, A and B): UNVERIFIED-ON-HARDWARE.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { startNativeE2e, playCalibration, sleep } from '../../test-support/e2e/native-harness.js';

const h = await startNativeE2e({ helper: { FAKE_HELPER_HELLO_MS: '200', FAKE_HELPER_WAIT_MS: '150', FAKE_HELPER_SCAN_MS: '400', FAKE_HELPER_STEP_MS: '100', FAKE_HELPER_STREAM_MS: '200' } });
const skip = h.skip;
after(() => h.close());

const focus = async (page) => (await h.view(page)).focus;
const hint = async (page) => (await h.view(page)).hint.items.map((x) => `${x.key}: ${x.label}`).join('   ');
const waitFocus = (page, id) => page.waitFor((want) => __clay.debug.getUiView().focus.id === want, { timeoutMs: 6000, pollMs: 30, message: `focus on ${id}` }, id);
const waitScreenNow = (page, screen) => h.waitScreen(page, screen, 8000);

test('e2e stick 1: connect, calibrate (practice clay shot with ZR), then menu -> settings -> back with the stick, A and B; the Joy-Con pointer selects nothing (C-07)', { skip, timeout: 240000 }, async () => {
  const page = await h.openNative();
  await h.waitConnect(page, 'c.native === true && c.buttonEnabled', 15000, 'the native layout');
  await h.click(page, 'connect.main');
  await h.waitConnect(page, "c.mode === 'connected'", 40000, 'Connected');
  await playCalibration(h, page);
  await h.waitScreen(page, 'menu', 20000);
  await page.mouse.move(10, 1070); // the mouse pointer that clicked "Connect" must not rest on a menu card
  await sleep(500);

  // the menu: focus on Classic, the hint line for the Right unit
  assert.equal((await focus(page)).id, 'menu.classic');
  assert.equal(await hint(page), 'STICK: Move   A: Select');
  await h.screenshot(page, 'stick-1-menu');

  // down: "Best scores"; a long push is ONE move (hold the stick for 700 ms, far longer than a flick)
  await h.sword.flick('down', 700);
  await waitFocus(page, 'menu.best');
  await sleep(900);
  assert.equal((await focus(page)).id, 'menu.best', 'a long push moved once');
  await h.sword.flick('right');
  await waitFocus(page, 'menu.settings');
  await sleep(350);
  await h.sword.button('A', 200);
  await waitScreenNow(page, 'settings');
  assert.equal((await focus(page)).id, 'row:sensitivity', 'Settings opens on its first row (QA F19)');
  assert.match(await hint(page), /B: Back$/);
  await sleep(300);
  await h.screenshot(page, 'stick-2-settings');

  // change the value of the focused row with right and left
  const sens0 = await page.evaluate('__clay.getSettings().sensitivity');
  await h.sword.flick('right');
  await page.waitFor(`__clay.getSettings().sensitivity > ${sens0}`, { timeoutMs: 6000, pollMs: 30, message: 'sensitivity up' });
  await sleep(350);
  await h.sword.flick('left');
  await page.waitFor(`Math.abs(__clay.getSettings().sensitivity - ${sens0}) < 1e-9`, { timeoutMs: 6000, pollMs: 30, message: 'sensitivity back' });

  // B goes back to the menu, B on the root menu does nothing
  await sleep(300);
  await h.sword.button('B', 200);
  await waitScreenNow(page, 'menu');
  await sleep(400);
  await h.sword.button('B', 200);
  await sleep(500);
  assert.equal((await h.ui(page)).screen, 'menu', 'B on the root menu does nothing');

  // the Joy-Con pointer resting on a menu card for four seconds starts nothing, and ZR in a menu fires nothing
  await page.evaluate('__clay.reanchor(400, 565)');
  await sleep(4000);
  await h.sword.button('ZR', 150);
  await sleep(400);
  assert.equal((await h.ui(page)).screen, 'menu');
  assert.equal((await h.view(page)).hover, null, 'inert: no hover');

  assert.deepEqual(page.consoleErrors(), []);
  assert.deepEqual(page.exceptions, []);
  assert.deepEqual(page.failedRequests, []);
  await page.close();
});
