// e2e (headless Chrome over CDP): the input providers in a real browser: the simulator IMU path and its trigger (incl. the real calibration
// wizard for every mount preset and the practice clay), the disconnect flow, and real mouse events through Input.dispatchMouseEvent.
// Skipped (never "passed") when Chrome is missing. The simulator models docs/joycon2-protocol.md, not the physical Joy-Con
// (UNVERIFIED-ON-HARDWARE).
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { startE2e, angleDeg } from '../../test-support/e2e/env.js';

const env = await startE2e();
const skip = env.skip;
after(() => env.close());

const Q = 'input=sim&clock=manual&skipsafety=1&mute=1';
const ev = (page, expr) => page.evaluate(expr);

/** A clay hanging still in front of the trap house (debug spawn) and its projected screen position. */
const STILL = "(() => { const [id] = __clay.debug.spawn({ kind: 'standard', house: 'trap', pos: { x: 0, y: 3, z: 20 }, vel: { x: 0, y: 0, z: 0 }, still: true }); __clay.advance(20); return __clay.snapshot().targets.find((t) => t.id === id); })()";

test('e2e 7: simulator IMU path: sim.fire() goes through the byte-exact packets, the real parser, motion.aimAt and the UI: it calls "Pull!", then breaks the clay the virtual gun points at', { skip }, async () => {
  const page = await env.openGame(Q);
  const r = await page.evaluate(async (still) => {
    const C = __clay;
    C.start('classic', { seed: 1, autoLaunch: false });
    C.advance(300);
    C.sim.fire();
    C.advance(40);
    const phase = C.snapshot().phase;
    C.advance(1000);
    const tg = eval(still);
    C.sim.setTarget(tg.sx, tg.sy, { teleport: true });
    C.advance(150);
    const aim = C.snapshot().aim;
    const fire = C.sim.fire();
    C.advance(40);
    const s = C.snapshot();
    return { phase, aimErr: Math.hypot(aim.x - tg.sx, aim.y - tg.sy), fire, hit: s.events.some((e) => e.type === 'hit' && e.id === tg.id), shot: s.events.filter((e) => e.type === 'shot').pop(), rate: C.getMotionState().sampleRateHz };
  }, STILL);
  assert.equal(r.phase, 'pull', 'the first trigger in phase ready called "Pull!"');
  assert.ok(r.aimErr < 8, `the crosshair is on the clay (${r.aimErr.toFixed(1)} px, simulated sensor noise)`);
  assert.equal(r.fire.source, 'sim');
  assert.equal(r.hit, true);
  assert.equal(r.shot.source, 'sim');
  assert.equal(r.shot.compMs, 0, 'the simulator is not trigger-compensated (C-05)');
  assert.ok(r.rate > 50 && r.rate < 80, `simulator rate ${r.rate} Hz (66 Hz nominal, modelled)`);
  assert.deepEqual(page.consoleErrors(), []);
});

const MOUNTS = [
  ['faceUp', ''], ['faceSide', ''], ['upsideDown', ''], ['tipFlipped', ''], ['tilted', ''], ['sideRail', ''],
  ['faceUp', '&simmirror=1'], ['tilted', '&simmirror=1'], ['faceSide', '&simgyro=alt'], ['sideRail', '&simgyro=alt&simmirror=1&simside=L'],
];
for (const [mount, variant] of MOUNTS) {
  test(`e2e 7: ?simcal=1 completes the real wizard (mount ${mount}${variant}); the frame is within 3 degrees of the simulator truth`, { skip }, async () => {
    const page = await env.openGame(`${Q}&simcal=1&simmount=${mount}${variant}&simseed=5`);
    assert.equal((await ev(page, '__clay.getUiState()')).screen, 'calibration');
    const r = await page.evaluate(() => {
      let g = 0;
      while (__clay.getUiState().calibrationStep !== 4 && g++ < 1200) __clay.advance(16);
      return { step: __clay.getUiState().calibrationStep, cal: __clay.getCalibration(), truth: __clay.sim.getTruth(), mode: __clay.snapshot().mode };
    });
    assert.equal(r.step, 4, 'the wizard finished');
    assert.equal(r.mode, 'practice');
    assert.ok(angleDeg(r.cal.frame.forward, r.truth.frame.forward) < 3, `forward ${angleDeg(r.cal.frame.forward, r.truth.frame.forward)}`);
    assert.ok(angleDeg(r.cal.frame.up, r.truth.frame.up) < 3, `up ${angleDeg(r.cal.frame.up, r.truth.frame.up)}`);
    assert.equal(r.cal.gyroSign, r.truth.gyroSign);
    assert.ok(Math.abs(r.cal.gyroScale / r.truth.gyroScaleRatio - 1) < 0.05);
    // the practice clay is shot through the IMU chain (the virtual gun points at it, the simulated trigger) and the game returns to the menu
    const end = await page.evaluate(async () => {
      const C = __clay;
      let g = 0;
      while (!C.snapshot().targets.some((t) => t.ageS > 0.5) && g++ < 400) C.advance(20);
      for (let i = 0; i < 3; i++) { const t = C.snapshot().targets[0]; C.sim.setTarget(t.sx, t.sy, { teleport: true }); C.advance(20); }
      C.sim.fire();
      C.advance(300);
      return { screen: C.getUiState().screen };
    });
    assert.equal(end.screen, 'menu', 'the practice hit ended the calibration');
    assert.deepEqual(page.consoleErrors(), []);
  });
}

test('e2e 8: disconnect flow: simulateLoss pauses the round under the overlay, simulateRecovery re-centres and resumes', { skip }, async () => {
  const page = await env.openGame(Q);
  const r = await page.evaluate(async () => {
    __clay.start('timeattack', { seed: 4 });
    __clay.advance(2000);
    const t0 = __clay.snapshot().t;
    __clay.sim.simulateLoss();
    __clay.advance(50);
    const lost = { screen: __clay.getUiState().screen, overlay: __clay.getUiState().overlay, state: __clay.snapshot().provider.state };
    __clay.advance(4000);
    const frozen = __clay.snapshot().t;
    const stillOverlay = __clay.getUiState().overlay;
    __clay.sim.simulateRecovery();
    let g = 0;
    while (!(__clay.getUiState().overlay === null && __clay.getUiState().gameActive) && g++ < 600) __clay.advance(16);
    __clay.advance(500);
    return { t0, lost, frozen, stillOverlay, resumed: __clay.getUiState().gameActive, tAfter: __clay.snapshot().t, state: __clay.snapshot().provider.state };
  });
  assert.deepEqual(r.lost, { screen: 'paused', overlay: 'disconnected', state: 'lost' });
  assert.equal(r.frozen, r.t0, 'no game time passed during the outage');
  assert.equal(r.stillOverlay, 'disconnected');
  assert.equal(r.state, 'streaming');
  assert.equal(r.resumed, true);
  assert.ok(r.tAfter > r.t0);
  assert.deepEqual(page.consoleErrors(), []);
});

test('e2e 8b (round 1 M1): the gun is lowered and turned while the link is down: after the recovery the tilt estimate is exact and the cursor sits on the centre and stays there', { skip }, async () => {
  const page = await env.openGame('input=sim&clock=manual&skipsafety=1&mute=1&seed=4&simseed=9');
  const r = await page.evaluate(async () => {
    __clay.start('classic', { seed: 4 });
    __clay.advance(1000);
    __clay.sim.setTarget(1500, 250); // the virtual gun rests up and to the right
    __clay.advance(1500);
    const before = __clay.getMotionState();
    __clay.sim.simulateLoss();
    __clay.advance(50);
    __clay.sim.setTarget(500, 850); // lowered and turned left while nothing is delivered
    __clay.advance(4000);
    __clay.sim.simulateRecovery();
    let g = 0;
    while (!(__clay.getUiState().overlay === null && __clay.getUiState().gameActive) && g++ < 900) __clay.advance(16);
    __clay.advance(600);
    const after = __clay.getMotionState();
    const rawPitch = __clay.debug.getMotionDebug().rawPitchDeg;
    __clay.advance(2500);
    const later = __clay.getMotionState();
    return { before, after, later, rawPitch, truth: __clay.sim.getTruth().aim, resumed: __clay.getUiState().gameActive };
  });
  assert.ok(Math.abs(r.before.x - 1500) < 40 && Math.abs(r.before.y - 250) < 40, `the cursor followed the gun before the loss (${r.before.x.toFixed(0)}, ${r.before.y.toFixed(0)})`);
  assert.equal(r.resumed, true);
  assert.ok(Math.abs(r.rawPitch - r.truth.pitchDeg) < 1.5, `raw pitch ${r.rawPitch.toFixed(2)} against the truth ${r.truth.pitchDeg.toFixed(2)} (the old filter would still be about 10 degrees off here)`);
  assert.ok(Math.hypot(r.after.x - 960, r.after.y - 540) < 25, `re-centred after the recovery: ${r.after.x.toFixed(0)}, ${r.after.y.toFixed(0)}`);
  assert.ok(Math.hypot(r.later.x - r.after.x, r.later.y - r.after.y) < 25, `and it stays: ${r.later.x.toFixed(0)}, ${r.later.y.toFixed(0)}`);
  assert.deepEqual(page.consoleErrors(), []);
});

test('e2e 9: mouse provider: real mouse events (Input.dispatchMouseEvent) move the crosshair, a press fires at the press position and breaks the clay', { skip }, async () => {
  const page = await env.openGame('input=mouse&clock=manual&skipsafety=1&mute=1&seed=1');
  await ev(page, "__clay.start('classic', {seed: 1, autoLaunch: false}); __clay.advance(300)");
  await page.mouse.move(400, 540);
  await ev(page, '__clay.advance(50)');
  const m0 = await ev(page, '__clay.snapshot().aim');
  assert.ok(Math.abs(m0.x - 400) < 2 && Math.abs(m0.y - 540) < 2, `crosshair ${m0.x},${m0.y}`);
  await page.mouse.down(400, 540); // phase ready: "Pull!"
  await page.mouse.up(400, 540);
  await ev(page, '__clay.advance(1000)');
  const tg = await ev(page, STILL);
  await page.mouse.move(tg.sx, tg.sy);
  await page.mouse.down(tg.sx, tg.sy);
  await page.mouse.up(tg.sx, tg.sy);
  await ev(page, '__clay.advance(40)');
  const s = await ev(page, '__clay.snapshot()');
  const shot = s.events.filter((e) => e.type === 'shot').pop();
  assert.equal(shot.source, 'mouse');
  assert.ok(Math.hypot(shot.x - tg.sx, shot.y - tg.sy) < 1.5, `the shot went to the press position: ${shot.x},${shot.y}`);
  assert.ok(s.events.some((e) => e.type === 'hit' && e.id === tg.id), 'the clay broke');
  assert.equal((await ev(page, '__clay.getUiState()')).screen, 'playing', 'the press was not taken for a menu click');
  assert.deepEqual(page.consoleErrors(), []);
});

test('e2e 9: mouse provider: a click on a menu card opens its setup, Start starts the round, a middle click pauses', { skip }, async () => {
  const page = await env.openGame('input=mouse&clock=manual&skipsafety=1&mute=1&seed=1');
  await ev(page, '__clay.advance(700)');
  const at = async (id) => (await ev(page, '__clay.debug.getUiView()')).targets.find((t) => t.id === id);
  const zen = await at('menu.zen');
  await page.mouse.move(zen.x, zen.y);
  await page.mouse.down(zen.x, zen.y);
  await page.mouse.up(zen.x, zen.y);
  assert.equal((await ev(page, '__clay.getUiState()')).screen, 'setup');
  await ev(page, '__clay.advance(300)');
  const start = await at('setup.start');
  await page.mouse.move(start.x, start.y);
  await page.mouse.down(start.x, start.y);
  await page.mouse.up(start.x, start.y);
  const st = await ev(page, '__clay.getUiState()');
  assert.equal(st.screen, 'countdown');
  assert.equal(st.roundMode, 'zen');
  await ev(page, '__clay.advance(3500)');
  assert.equal((await ev(page, '__clay.getUiState()')).screen, 'playing');
  await page.mouse.down(900, 500, 'middle'); // middle click = pause
  await page.mouse.up(900, 500, 'middle');
  assert.equal((await ev(page, '__clay.getUiState()')).screen, 'paused');
});

test('e2e 7b: the simulator follows a real mouse: the pointer entering the window becomes the crosshair, no drift back to the centre', { skip }, async () => {
  const page = await env.openGame(Q);
  await ev(page, '__clay.advance(1000)');
  await page.mouse.move(400, 300);
  await ev(page, '__clay.advance(200)');
  let m = await ev(page, '__clay.getMotionState()');
  assert.ok(Math.hypot(m.x - 400, m.y - 300) < 25, `after entering at 400,300 the cursor is ${m.x},${m.y}`);
  await ev(page, '__clay.advance(5000)');
  m = await ev(page, '__clay.getMotionState()');
  assert.ok(Math.hypot(m.x - 400, m.y - 300) < 25, `5 s later the cursor is ${m.x},${m.y}`);
  await page.mouse.move(1500, 800);
  await ev(page, '__clay.advance(200)');
  m = await ev(page, '__clay.getMotionState()');
  assert.ok(Math.hypot(m.x - 1500, m.y - 800) < 40, `after moving to 1500,800 the cursor is ${m.x},${m.y}`);
});
