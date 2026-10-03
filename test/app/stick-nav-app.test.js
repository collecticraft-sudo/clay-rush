// The whole app (real app.js, real UI, real native provider, REAL parser and report stream) driven only by Joy-Con report bytes that carry a stick position and button
// bits: menu -> settings -> back with the stick, A and B, edge-triggering through the real stream, auto-repeat of a stepper, the Left unit. (C-07: the pointer of a
// real Joy-Con never selects menu items; the stick, A and B do.)
// The reports come from the fake page side of the native bridge (test-support/bridge/fake-page-bridge.js): they model docs/joycon2-protocol.md, not the device
// (UNVERIFIED-ON-HARDWARE). The same walk in a real Chrome against the fake helper process is test/e2e/stick-nav.test.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createManualClock } from '../../public/js/shared/clock.js';
import { createFakeTimers } from '../../test-support/input/fake-timers.js';
import { createFakePageBridge, vectorHex } from '../../test-support/bridge/fake-page-bridge.js';
import { buildInputReport } from '../../public/js/input/joycon2-build.js';
import { bytesToHex } from '../../public/js/input/joycon2-parse.js';
import { makeApp } from '../../test-support/app/harness.js';
import { mountCalibration } from '../../test-support/motion/tip-stream.js';

const REST = { x: 1998, y: 2007 }; // the centre MEASURED on the real recording
const REAL_2 = vectorHex('REAL_R_2');

async function stickApp(side = 'R') {
  const clock = createManualClock(1000);
  const timers = createFakeTimers(clock);
  const fake = createFakePageBridge({});
  const h = await makeApp('?skipsafety=1&mute=1', { env: { clock, timers, fetch: fake.fetch, EventSource: fake.EventSource } });
  let us = 764777;
  let at = 5000;
  const t = {
    h, fake, clock,
    ui: () => h.app.presentation.ui.getView(),
    async run(ms) {
      for (let el = 0; el < ms; el += 16) {
        await timers.advance(16);
        h.app.step();
      }
    },
    /** one report of the controller: the stick field (right field for a Right unit, left for a Left unit) and the buttons held right now */
    async report({ stick = REST, pressed = [] } = {}) {
      us += 15000;
      at += 15;
      const o = { counter: us / 1000, imuTimestampUs: us, batteryMv: 3435, temperatureRaw: 5, accelRaw: { x: -600, y: -700, z: 3960 }, gyroRaw: { x: 0, y: 16, z: -12 }, pressed };
      if (side === 'L') o.leftField = stick; else o.rightField = stick;
      fake.report(bytesToHex(buildInputReport(o)), at);
      await t.run(16);
    },
    async rest(n = 20) { for (let i = 0; i < n; i++) await t.report(); },
    /** push the stick to `dx, dy` LSB from the rest position for `n` reports, then let go */
    async flick(dx, dy, n = 4) {
      for (let i = 0; i < n; i++) await t.report({ stick: { x: REST.x + dx, y: REST.y + dy } });
      await t.rest(4);
    },
    async button(name) {
      await t.report({ pressed: [name] });
      await t.report();
      await t.run(300); // past the 220 ms confirm lock of the new screen
    },
  };
  await t.run(64);
  const main = t.h.target('connect.main');
  t.h.mouse.click(main.x, main.y); // the native main button
  await t.run(16);
  await timers.advance(1);
  for (let i = 0; i < 200 && fake.posts('/connect').length < 1; i++) await timers.advance(1);
  fake.status('scanning', { message: 'waiting for Bluetooth' });
  fake.status('scanning', { message: 'scanning for a Joy-Con 2' });
  fake.emit({ type: 'advert', side, pid: 8294, rssi: -40, host: '00 00 00 00 00 00', pairing: true });
  fake.status('connecting', { side });
  fake.status('discovering', { side });
  fake.status('initialising', { side });
  fake.status('streaming', { side });
  await t.run(32);
  fake.report(REAL_2, 5000);
  await t.run(64);
  await t.rest(20);
  t.h.mouse.move(20, 1060); // the mouse pointer that clicked "Connect" is parked on no button
  // an uncalibrated Joy-Con may not reach the menu (review U-01): these tests are about the stick, so the wizard's result is set directly
  h.app.motion.setCalibration(mountCalibration('faceUp', side));
  h.app.presentation.ui.notify({ type: 'calibration', event: { type: 'done', quick: true } });
  await t.run(32);
  h.app.presentation.ui.force('menu');
  await t.run(300);
  return t;
}

const hint = (t) => t.ui().hint.items.map((x) => `${x.key}: ${x.label}`).join('   ');

test('the whole walk with a Right unit: menu -> settings -> back, with the stick, A and B only (real parser, real stream, real app)', async () => {
  const t = await stickApp('R');
  try {
    assert.equal(t.h.snap().provider.kind, 'joycon');
    assert.equal(t.h.screen(), 'menu');
    assert.equal(t.ui().focus.id, 'menu.classic');
    assert.equal(hint(t), 'STICK: Move   A: Select', 'the hint line speaks for the Right unit');
    await t.flick(0, -1400); // down: the row of buttons
    assert.equal(t.ui().focus.id, 'menu.best');
    await t.flick(1400, 0); // right
    assert.equal(t.ui().focus.id, 'menu.settings');
    await t.button('A');
    assert.equal(t.h.screen(), 'settings');
    assert.equal(t.ui().focus.id, 'row:sensitivity', 'Settings opens on its first row (QA F19)');
    assert.match(hint(t), /B: Back$/);
    const s0 = t.h.c.getSettings().sensitivity;
    await t.flick(1400, 0); // right: one step up
    assert.ok(Math.abs(t.h.c.getSettings().sensitivity - (s0 + 0.1)) < 1e-9);
    await t.flick(-1400, 0); // left: back
    assert.ok(Math.abs(t.h.c.getSettings().sensitivity - s0) < 1e-9);
    await t.button('B');
    assert.equal(t.h.screen(), 'menu', 'B goes back');
    await t.button('B');
    assert.equal(t.h.screen(), 'menu', 'B on the root menu does nothing');
    assert.deepEqual(t.h.problems().filter((l) => l.level === 'error'), []);
  } finally {
    t.h.dispose();
  }
});

test('edge-triggering through the real stream: a long push is one move, the stick must come back near the centre for the next, a dead-zone nudge moves nothing', async () => {
  const t = await stickApp('R');
  try {
    await t.flick(500, 0, 6); // 0.33: inside the dead zone
    await t.flick(0, 400, 6);
    assert.equal(t.ui().focus.id, 'menu.classic', 'small touches move nothing');
    for (let i = 0; i < 60; i++) await t.report({ stick: { x: REST.x + 1400, y: REST.y } }); // two seconds of a full push to the right
    assert.equal(t.ui().focus.id, 'menu.timeattack', 'one move, not a run to the end');
    await t.report({ stick: { x: REST.x - 1400, y: REST.y } }); // swung straight over to the left without letting go: no second move
    await t.report({ stick: { x: REST.x - 1400, y: REST.y } });
    assert.equal(t.ui().focus.id, 'menu.timeattack');
    await t.rest(4);
    await t.flick(-1400, 0);
    assert.equal(t.ui().focus.id, 'menu.classic');
  } finally {
    t.h.dispose();
  }
});

test('a settings stepper held on the stick repeats (450 ms, then every 120 ms) and stops when the stick is released', async () => {
  const t = await stickApp('R');
  try {
    t.h.app.presentation.ui.force('settings');
    await t.run(300);
    assert.equal(t.ui().focus.id, 'row:sensitivity', 'Settings opens on the Sensitivity stepper');
    t.h.c.setSetting('sensitivity', 1.0);
    const held = { x: REST.x + 1400, y: REST.y };
    for (let i = 0; i < 33; i++) await t.report({ stick: held }); // 33 reports of 16 ms: about 530 ms
    assert.ok(Math.abs(t.h.c.getSettings().sensitivity - 1.2) < 1e-9, 'the flick is one step, the first repeat comes at 450 ms, the next at 570 ms');
    await t.rest(6);
    await t.run(1500);
    assert.ok(Math.abs(t.h.c.getSettings().sensitivity - 1.2) < 1e-9, 'released: no more steps');
  } finally {
    t.h.dispose();
  }
});

test('the Left unit: the stick field is the left one, Down selects and Left goes back, the hint line says so (UNVERIFIED-ON-HARDWARE: the Left unit was never in a recording)', async () => {
  const t = await stickApp('L');
  try {
    assert.equal(hint(t), 'STICK: Move   Down: Select', 'the Left unit labels: Down selects');
    await t.flick(0, -1400);
    await t.flick(1400, 0);
    assert.equal(t.ui().focus.id, 'menu.settings');
    await t.button('DOWN');
    assert.equal(t.h.screen(), 'settings');
    assert.match(hint(t), /Left: Back$/);
    await t.button('LEFT');
    assert.equal(t.h.screen(), 'menu', 'Left is the back button of this unit');
    // the Right unit buttons mean nothing on a Left unit
    await t.flick(0, -1400);
    await t.flick(1400, 0);
    await t.button('A');
    assert.equal(t.h.screen(), 'menu');
  } finally {
    t.h.dispose();
  }
});
