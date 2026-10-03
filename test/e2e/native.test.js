// e2e (headless Chrome over CDP): the REAL game on the native Bluetooth bridge path, against the REAL server and a FAKE helper process that plays a virtual
// sword (test-support/bridge/fake-helper.mjs). The first-run flow the owner will see, screen by screen; the failure paths; a crash in the middle of a
// game; the diagnostics page in its native mode. Skipped (never "passed") when Chrome is missing.
//
// What this proves: the wiring of the whole chain in a real browser (probe, click, progress per phase, countdown, cancel, calibration wizard through the
// real parser and Motion, Zen round, disconnect panel, reconnect, diagnostics). What it CANNOT prove: anything about CoreBluetooth, the macOS permission, or
// the physical Joy-Con. The fake models docs/native-bridge.md and the protocol document (UNVERIFIED-ON-HARDWARE).
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { startNativeE2e, playCalibration, sleep } from '../../test-support/e2e/native-harness.js';
import { angleDeg } from '../../test-support/e2e/env.js';
import { STRINGS } from '../../public/js/ui/strings.en.js';
import { MOTION_CONFIG } from '../../public/js/motion/motion-config.js';
import { pointerSpeedPxS } from '../../public/js/motion/pointer.js';

// every phase lasts long enough for the page to be seen in it (a sample per animation frame)
const h = await startNativeE2e({ helper: { FAKE_HELPER_HELLO_MS: '400', FAKE_HELPER_WAIT_MS: '350', FAKE_HELPER_SCAN_MS: '2500', FAKE_HELPER_STEP_MS: '250', FAKE_HELPER_STREAM_MS: '500' } });
const skip = h.skip;
after(() => h.close());

const P = (key) => STRINGS[`connect.native.progress.${key}`];
const texts = (seen) => seen.map((s) => s.text);

test('e2e native 1: first run, screen by screen: probe, the native button, every progress line in order, the scan countdown, "Connected", the wizard with the virtual Joy-Con, the menu, a Zen round that aims like a mouse and shoots with ZR', { skip, timeout: 180000 }, async () => {
  const page = await h.openNative();
  // the connect screen knows the bridge is there and offers it first
  await h.waitConnect(page, 'c.native === true && c.buttonEnabled', 15000, 'the native layout');
  let v = await h.view(page);
  assert.equal(v.connect.primary, 'native');
  assert.equal(v.connect.buttonText, STRINGS['connect.native.button']);
  assert.equal(v.connect.secondary.text, STRINGS['connect.native.secondary']);
  assert.equal(v.connect.stepTexts.length, 4);
  assert.ok(v.targets.some((t) => t.id === 'connect.main' && t.enabled));
  assert.equal((await page.evaluate('__clay.snapshot().provider')).kind, null, 'nothing is connected before the click');
  await h.screenshot(page, 'native-1-ready');

  await h.startProgress(page);
  await h.click(page, 'connect.main');
  await h.waitConnect(page, "c.mode === 'connected'", 40000, 'Connected');
  await sleep(150); // one more animation frame for the recorder
  const seen = await h.stopProgress(page);
  const t = texts(seen);
  const order = ['starting', 'waitingBluetooth', 'scanning', 'connecting', 'discovering', 'initialising', 'waitingData'].map((k) => t.indexOf(P(k)));
  assert.ok(order.every((i) => i >= 0), `every phase was seen on screen: ${JSON.stringify(t)}`);
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'in the order of the helper');
  const scanning = seen.filter((s) => s.text === P('scanning'));
  const counts = scanning.map((s) => s.countdownS);
  assert.equal(counts[0], 45, 'the countdown starts at 45 s when the scan really starts');
  assert.ok(counts.some((n) => n <= 44), `and counts down: ${counts}`);
  assert.ok(seen.filter((s) => s.mode === 'busy' && s.text !== P('checking')).every((s) => s.cancel), `"Cancel" is offered during the whole attempt (after the first frame, which may still say "Checking"): ${JSON.stringify(seen)}`);
  assert.match(t.at(-1), /^Connected: Joy-Con \(right\)/);
  await h.screenshot(page, 'native-connected');

  // the wizard: the virtual Joy-Con is held the way the screen asks
  await playCalibration(h, page);
  const cal = await page.evaluate('__clay.getCalibration()');
  const truth = { right: { x: 1, y: 0, z: 0 }, forward: { x: 0, y: 1, z: 0 }, up: { x: 0, y: 0, z: 1 } };
  assert.ok(angleDeg(cal.frame.forward, truth.forward) < 3, `forward axis ${angleDeg(cal.frame.forward, truth.forward)} degrees off`);
  assert.ok(angleDeg(cal.frame.up, truth.up) < 3, `up axis ${angleDeg(cal.frame.up, truth.up)} degrees off`);
  assert.equal(cal.side, 'R');
  assert.equal(cal.gyroSign, 1);
  assert.ok(Math.abs(cal.gyroBiasDps.x - 0.8) < 0.3 && Math.abs(cal.gyroBiasDps.y + 0.5) < 0.3, 'the bias of the virtual sensor was found');
  assert.equal((await h.ui(page)).screen, 'menu');

  // A few seconds of Zen. A real Joy-Con points like a mouse in its local frame (docs/motion-contract.md 1): the crosshair moves by the curve of 2.2
  // (dead zone, gain rising with speed) in the direction the Joy-Con turns. The virtual Joy-Con is the simulator's physics, which turns 27.4 degrees
  // per 750 px of aim point, so a glide of dx px in ms is a constant turn rate of (dx / 27.4) / (ms / 1000) deg/s.
  await page.evaluate("__clay.start('zen', { seed: 5, autoLaunch: false })");
  await page.evaluate("__clay.setSetting('autoCenter', false)"); // the crosshair stays where the test puts it while the test talks to the helper
  await h.sword.clearPose();
  const expectedDx = (dx, ms) => Math.sign(dx) * pointerSpeedPxS(Math.abs(dx) / 27.4 / (ms / 1000), 1, { ...MOTION_CONFIG.pointer, ...MOTION_CONFIG.shooter.pointer }) * (ms / 1000);
  const follow = [];
  for (const [dx, ms] of [[600, 600], [-600, 1500], [900, 500]]) {
    await h.sword.moveTo(dx > 0 ? 500 : 1500, 540, 250); // get to the start of the glide (the crosshair is placed afterwards)
    await sleep(500);
    await page.evaluate('__clay.reanchor(960, 540)');
    await sleep(250);
    const before = await page.evaluate('(() => { const m = __clay.getMotionState(); return [m.x, m.y]; })()');
    await h.sword.moveTo((dx > 0 ? 500 : 1500) + dx, 540, ms);
    await sleep(ms + 400);
    const after = await page.evaluate('(() => { const m = __clay.getMotionState(); return [m.x, m.y]; })()');
    follow.push({ dx, ms, expected: Math.round(expectedDx(dx, ms)), got: Math.round(after[0] - before[0]), dy: Math.round(after[1] - before[1]) });
  }
  for (const f of follow) {
    assert.ok(f.got * f.expected > 0, `the crosshair moves the way the Joy-Con turns: ${JSON.stringify(f)}`);
    assert.ok(Math.abs(f.got - f.expected) <= 0.35 * Math.abs(f.expected) + 12, `and by the amount of the pointer curve (motion-contract 2.2): ${JSON.stringify(f)}`);
    assert.ok(Math.abs(f.dy) < 25, `without drifting sideways: ${JSON.stringify(f)}`);
  }
  // and ZR breaks a clay through the whole chain (report -> parser -> fire action at the report time -> UI -> Shot with the trigger compensation -> game)
  const tg = await page.evaluate("(() => { const [id] = __clay.debug.spawn({ kind: 'standard', house: 'trap', pos: { x: 0, y: 3, z: 20 }, vel: { x: 0, y: 0, z: 0 }, still: true }); return id; })()");
  await sleep(100);
  const at = await page.evaluate((id) => { const t = __clay.snapshot().targets.find((x) => x.id === id); __clay.reanchor(t.sx, t.sy); return { x: t.sx, y: t.sy }; }, tg);
  await sleep(300); // more than the 40 ms trigger compensation: the history holds the crosshair on the clay
  await h.sword.button('ZR', 120);
  await page.waitFor((id) => __clay.snapshot().events.some((e) => e.type === 'hit' && e.id === id), { timeoutMs: 4000, pollMs: 30, message: 'the clay broken by ZR' }, tg);
  const shot = await page.evaluate("__clay.snapshot().events.filter((e) => e.type === 'shot').pop()");
  assert.equal(shot.source, 'joycon');
  assert.equal(shot.compMs, 40, 'a real Joy-Con shot is compensated by the setting (default 40 ms, UNVERIFIED-ON-HARDWARE)');
  assert.ok(Math.hypot(shot.x - at.x, shot.y - at.y) < 30, `the shot went where the crosshair was: ${JSON.stringify({ shot, at })}`);
  await h.screenshot(page, 'native-zen');
  assert.equal((await h.ui(page)).screen, 'playing');
  await page.evaluate("__clay.setSetting('autoCenter', true)");

  // the bridge saw exactly one attempt: one connect command, nothing else but the rate-limited keep-alive of the real helper (not modelled here)
  assert.equal(h.helperCommands().filter((c) => c.cmd === 'connect').length, 1);
  assert.deepEqual(h.helperCommands().find((c) => c.cmd === 'connect'), { cmd: 'connect', side: 'any', scanSeconds: 45 });
  assert.deepEqual(page.consoleErrors(), []);
  assert.deepEqual(page.exceptions, []);
  assert.deepEqual(page.failedRequests, []);
  assert.deepEqual(page.badResponses, []);
  assert.ok(page.requests.every((r) => r.url.startsWith(h.url) || r.url.startsWith('data:') || r.url.startsWith('blob:') || r.url === 'about:blank'), 'only this server was contacted (the game stays offline)');
  assert.ok(page.requests.some((r) => r.url.endsWith('/__bridge/status')) && page.requests.some((r) => r.url.endsWith('/__bridge/connect')) && page.requests.some((r) => r.url.endsWith('/__bridge/events')));
  const remembered = await page.evaluate("localStorage.getItem('joyconNinja.path.v1')");
  assert.deepEqual(JSON.parse(remembered), { v: 1, path: 'native' }, 'the path that worked is remembered for the next visit');
  await page.close();
  // closing the page lets go of the controller (the helper gets a disconnect command)
  const t0 = Date.now();
  while (Date.now() - t0 < 8000 && !h.helperCommands().some((c) => c.cmd === 'disconnect')) await sleep(100);
  assert.ok(h.helperCommands().some((c) => c.cmd === 'disconnect'), 'the bridge told the helper to disconnect');
});

test('e2e native 2: a denied permission says exactly what to do, costs no cooldown, and the next click works', { skip, timeout: 90000 }, async () => {
  await sleep(1500); // the previous test's session winds down
  await h.sword.scenario('permission');
  const page = await h.openNative();
  await h.waitConnect(page, 'c.native && c.buttonEnabled', 15000);
  await h.click(page, 'connect.main');
  await h.waitConnect(page, "c.mode === 'error'", 20000, 'the permission error');
  let v = (await h.view(page)).connect;
  assert.equal(v.pillText, STRINGS['connect.err.native.permission']);
  assert.match(v.pillText, /start\.command/);
  assert.match(v.pillText, /System Settings > Privacy & Security > Bluetooth/);
  assert.equal(v.buttonEnabled, true, 'nothing involved the controller: no cooldown');
  assert.equal(v.cooldownS, 0);
  await h.screenshot(page, 'native-err-permission');
  // the owner allowed Bluetooth: the very next click goes through
  await h.sword.scenario('happy');
  await h.click(page, 'connect.main');
  await h.waitConnect(page, "c.mode === 'connected'", 40000, 'Connected after the fix');
  assert.deepEqual(page.consoleErrors(), []);
  await page.close();
});

test('e2e native 3: nothing found after the scan says what to do; "Cancel" (a click, or Esc) gives up at no cost; a crash of the bridge at the very start has its own text', { skip, timeout: 120000 }, async () => {
  await sleep(1500);
  const page = await h.openNative();
  await h.waitConnect(page, 'c.native && c.buttonEnabled', 15000);
  // no_device: SYNC was not held, nothing found (the fake ends the scan early)
  await h.sword.scenario('no_device');
  await h.click(page, 'connect.main');
  await h.waitConnect(page, "c.mode === 'error'", 20000, 'the no_device error');
  let v = (await h.view(page)).connect;
  assert.equal(v.pillText, STRINGS['connect.err.native.noDevice']);
  assert.match(v.pillText, /wait a minute/i);
  assert.deepEqual([v.buttonEnabled, v.cooldownS, v.cancel], [true, 0, false], 'finding nothing starts no cooldown');
  await h.screenshot(page, 'native-err-nodevice');
  // cancel with a click while the scan runs
  await h.sword.scenario('happy');
  await h.click(page, 'connect.main');
  await h.waitConnect(page, `c.mode === 'busy' && c.progressText === ${JSON.stringify(P('scanning'))}`, 20000, 'the scan');
  await h.screenshot(page, 'native-scanning');
  await h.click(page, 'connect.cancel');
  await h.waitConnect(page, "c.mode === 'idle' && c.buttonEnabled", 10000, 'idle after Cancel');
  v = (await h.view(page)).connect;
  assert.deepEqual([v.cooldownS, v.pillText], [0, ''], 'a cancelled attempt costs no cooldown and leaves no error');
  // Esc does the same, and Enter starts again at once
  await page.key('Enter');
  await h.waitConnect(page, "c.mode === 'busy'", 10000, 'a new attempt with Enter');
  await h.waitConnect(page, `c.progressText === ${JSON.stringify(P('scanning'))}`, 20000, 'the scan again');
  await page.key('Enter'); // a second Enter must not undo the first
  await sleep(300);
  assert.equal((await h.view(page)).connect.mode, 'busy');
  await page.key('Escape');
  await h.waitConnect(page, "c.mode === 'idle'", 10000, 'idle after Esc');
  assert.ok(h.helperCommands().filter((c) => c.cmd === 'disconnect').length >= 2, 'the helper was told to disconnect both times');
  // the bridge dies at once (exit code 134 is how macOS stops a process that uses Bluetooth without permission)
  await h.sword.scenario('crash134');
  await page.key('Enter');
  await h.waitConnect(page, "c.mode === 'error'", 20000, 'the crash');
  assert.equal((await h.view(page)).connect.pillText, STRINGS['connect.err.native.permission'], 'code 134 means the permission: the text says so');
  assert.deepEqual(page.consoleErrors(), []);
  await page.close();
});

test('e2e native 4: the bridge dies in the middle of a game: the panel "Joy-Con disconnected" says "hold SYNC, then Reconnect", nothing reconnects by itself, Reconnect brings a new helper up and the game goes on', { skip, timeout: 120000 }, async () => {
  await sleep(1500);
  await h.sword.scenario('happy');
  const page = await h.openNative();
  await h.waitConnect(page, 'c.native && c.buttonEnabled', 15000);
  await h.click(page, 'connect.main');
  await h.waitConnect(page, "c.mode === 'connected'", 40000);
  await playCalibration(h, page); // an uncalibrated Joy-Con may not play (review U-01)
  await page.evaluate("__clay.start('zen', { seed: 9 })");
  await h.waitScreen(page, 'playing', 10000);
  await sleep(800);
  const startsBefore = h.helperStarts();
  await h.sword.crash(1);
  await page.waitFor(() => __clay.getUiState().overlay === 'disconnected', { timeoutMs: 10000, message: 'the disconnect panel' });
  let v = await h.view(page);
  assert.equal(v.disc.native, true);
  assert.equal(v.disc.phase, 'failed', 'the buttons are there at once');
  assert.equal(v.disc.text, STRINGS['connect.err.native.crashed'], 'a crashed bridge is named');
  assert.ok(v.targets.some((t) => t.id === 'disc.retry'));
  assert.equal(v.targets.find((t) => t.id === 'disc.retry').enabled, false, 'the cooldown of a lost link (10 s) applies');
  assert.equal((await h.ui(page)).screen, 'paused', 'the round is paused under the panel');
  await h.screenshot(page, 'native-disconnected');
  await sleep(3500);
  assert.equal(h.helperStarts(), startsBefore, 'nothing reconnects by itself');
  // after the cooldown "Reconnect" is live
  await page.waitFor(() => __clay.debug.getUiView().targets.some((t) => t.id === 'disc.retry' && t.enabled), { timeoutMs: 14000, message: 'Reconnect enabled' });
  await h.click(page, 'disc.retry');
  await page.waitFor(() => __clay.debug.getUiView().disc.phase === 'reconnecting', { timeoutMs: 3000, message: 'the reconnect attempt' });
  await page.waitFor(() => __clay.debug.getUiView().disc.progressText.length > 0 && __clay.debug.getUiView().targets.some((t) => t.id === 'disc.cancel'), { timeoutMs: 10000, message: 'progress and Cancel in the panel' });
  await page.waitFor(() => __clay.getUiState().overlay === null, { timeoutMs: 40000, message: 'the panel closes when the Joy-Con is back' });
  assert.equal(h.helperStarts(), startsBefore + 1, 'a new helper process was started by the reconnect');
  assert.equal((await page.evaluate('__clay.snapshot().provider.state')), 'streaming');
  await page.waitFor(() => __clay.getUiState().gameActive, { timeoutMs: 10000, message: 'the round resumes' });
  assert.deepEqual(page.exceptions, []);
  await page.close();
});

test('e2e native 5: the diagnostics page in its native mode: the same live values, the bridge block, the mode selector; the keep-alive experiment starts and stops', { skip, timeout: 90000 }, async () => {
  await sleep(1500);
  await h.sword.scenario('happy');
  const page = await h.newPage();
  await page.goto(`${h.url}/diagnostics.html`);
  const text = (id) => page.evaluate(`document.getElementById('${id}').textContent`);
  assert.equal(await text('mode-chip'), 'Native bridge (recommended)');
  assert.equal(await page.evaluate("document.getElementById('mode-select').value"), 'native');
  assert.deepEqual(await page.evaluate("[...document.getElementById('mode-select').options].map((o) => o.textContent)"), ['Native bridge (recommended)', "Real Joy-Con (Chrome's Bluetooth)", 'Simulator (no Bluetooth)']);
  assert.equal(await page.evaluate("getComputedStyle(document.getElementById('opt-pairing')).display !== 'none'"), true, 'native-only option shown');
  assert.equal(await page.evaluate("getComputedStyle(document.getElementById('opt-filter').parentElement).display"), 'none', 'the chooser filter is Web Bluetooth only');
  await page.waitFor("document.getElementById('nb-status').textContent.startsWith('available')", { timeoutMs: 8000, message: 'the bridge status' });
  await page.evaluate("document.getElementById('btn-connect').click()");
  await page.waitFor("document.getElementById('st-state').textContent === 'streaming'", { timeoutMs: 40000, message: 'streaming' });
  await sleep(3500);
  assert.match(await text('nb-phase'), /^streaming/);
  assert.equal(await text('nb-helper'), 'streaming');
  assert.match(await text('nb-adverts'), /^right -40 dBm in SYNC mode$/);
  assert.match(await text('nb-dropped'), /^0 with the wrong length, 0 with invalid hex$/);
  assert.match(await text('lv-len'), /63/);
  assert.match(await text('lv-batt'), /3435 mV/);
  assert.equal(await text('lv-imu'), 'true');
  const a = /\|a\| = ([\d.]+) g/.exec(await text('lv-a'));
  assert.ok(a && Math.abs(Number(a[1]) - 1) < 0.05, `|a| ${a && a[1]}`);
  const rate = Number.parseFloat(await text('rt-1s'));
  assert.ok(rate > 40 && rate < 80, `packet rate ${rate} Hz (the fake helper sends about 62)`);
  assert.match(await text('rt-dt'), /device timestamps/);
  assert.match(await text('st-side'), /^R/);
  assert.equal(await text('st-error'), 'none');
  assert.match(await text('st-timings'), /request \d+ ms/);
  const url = await text('game-url');
  assert.match(url, /\?input=native$/, 'the link to the game uses the native path');
  const lat = /avg ([\d.]+)/.exec(await text('lat-stats'));
  assert.ok(lat && Number(lat[1]) < 60, `the software part of the delay stays small (${lat && lat[1]} ms)`);
  // the rest check works on the virtual sword (tip up: not flat, so it says so; what matters is that the tool runs on the native stream)
  await page.evaluate("document.getElementById('rest-start').click()");
  await page.waitFor("document.getElementById('rest-a').textContent !== '-'", { timeoutMs: 8000, message: 'the rest check' });
  assert.match(await text('rest-a'), /^0\.99|^1\.0/);
  // vibration goes through the bridge
  await page.evaluate("document.querySelector('[data-vib=\"3\"]').click()");
  const t0 = Date.now();
  while (Date.now() - t0 < 4000 && !h.bridgeLog().some((e) => e.event === 'rumble' && e.id === 3)) await sleep(100);
  assert.ok(h.bridgeLog().some((e) => e.event === 'rumble' && e.id === 3), 'the vibration test reached the helper');
  // the keep-alive experiment: it disconnects, turns the keep-alive off, connects again and counts
  await page.evaluate("document.getElementById('ka-start').click()");
  await page.waitFor("document.getElementById('ka-msg').textContent.includes('without keep-alive')", { timeoutMs: 40000, message: 'the experiment is running' });
  assert.equal(await page.evaluate("document.getElementById('opt-keepalive').checked"), false);
  assert.equal(await page.evaluate("document.getElementById('ka-stop').disabled"), false);
  await page.evaluate("document.getElementById('ka-stop').click()");
  await page.waitFor("document.getElementById('ka-msg').textContent === 'Stopped.'", { timeoutMs: 3000, message: 'the experiment stopped' });
  // the report carries the native block and the three native steps
  await page.evaluate("document.getElementById('btn-report').click()");
  const report = JSON.parse(await page.evaluate("document.getElementById('report-text').value"));
  assert.equal(report.input, 'native');
  assert.equal(report.native.bridge.available, true);
  assert.equal(report.checklist.length, 12);
  assert.ok(report.native.adverts.length >= 1);
  assert.deepEqual(page.consoleErrors(), []);
  assert.deepEqual(page.exceptions, []);
  await h.screenshot(page, 'native-diagnostics');
  // the selector moves to another mode (a new page, the simulator)
  await page.evaluate("(() => { const s = document.getElementById('mode-select'); s.value = 'sim'; s.dispatchEvent(new Event('change')); })()");
  await page.waitFor("location.search === '?input=sim'", { timeoutMs: 5000, message: 'the page moved to the simulator' });
  await page.close();
});
