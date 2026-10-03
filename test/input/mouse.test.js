// Mouse provider tests (docs/architecture.md 5.9): one AimSample per pointer event including coalesced events, the
// discontinuity rules, clamping, actions.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createInputProvider } from '../../public/js/input/index.js';
import { createManualClock } from '../../public/js/shared/clock.js';
import { assertValid } from '../../public/js/shared/validate.js';
import { FakeTarget, pointerEvent } from '../../test-support/input/fake-dom.js';

function make({ realClock = false, rect, toPlayfield, windowTarget } = {}) {
  const manual = createManualClock(1000);
  const clock = realClock ? { now: () => manual.now(), manual: false } : manual;
  const target = new FakeTarget(rect);
  const mouse = createInputProvider('mouse', { clock, target, toPlayfield, windowTarget: windowTarget ?? new EventTarget(), strictTransitions: true });
  const aim = [];
  const actions = [];
  const statuses = [];
  mouse.on('aim', (a) => {
    assertValid('AimSample', a);
    aim.push(a);
  });
  mouse.on('action', (a) => actions.push(a));
  mouse.on('status', (s) => statuses.push(s));
  return { manual, clock, target, mouse, aim, actions, statuses };
}

test('capabilities, labels and lifecycle of the mouse provider', async () => {
  const { mouse, statuses } = make();
  assert.deepEqual(mouse.capabilities, { imu: false, aim: true, buttons: false, needsUserGesture: false, needsCalibration: false, hasBattery: false, canVibrate: false });
  assert.equal(mouse.kind, 'mouse');
  assert.equal(mouse.status.state, 'idle');
  assert.deepEqual(mouse.getActionLabels(), { confirm: 'click', back: 'right click', pause: 'middle click', recenter: 'double click', fire: 'Click' });
  mouse.setTriggerButton('R'); // no-op: the left button always fires
  assert.equal(mouse.getActionLabels().fire, 'Click');
  const p = mouse.connect();
  assert.equal(mouse.status.state, 'streaming', 'idle -> streaming synchronously');
  await p;
  await mouse.connect();
  await mouse.reconnect();
  assert.equal(mouse.status.trackingOk, false, 'pointer position unknown until the first event');
  await mouse.disconnect();
  await mouse.disconnect();
  assert.equal(mouse.status.state, 'idle');
  assert.deepEqual(statuses.map((s) => s.state), ['streaming', 'idle']);
  for (const s of statuses) assertValid('InputStatus', s);
});

test('one AimSample per pointer event in playfield px, the first one flagged as a discontinuity', async () => {
  const { mouse, target, aim, manual } = make();
  await mouse.connect();
  target.pointer('pointermove', { clientX: 100, clientY: 200 });
  manual.advance(8);
  target.pointer('pointermove', { clientX: 130, clientY: 210 });
  manual.advance(8);
  target.pointer('pointermove', { clientX: 160, clientY: 220 });
  assert.deepEqual(aim.map((a) => [a.x, a.y, a.discontinuity]), [[100, 200, true], [130, 210, false], [160, 220, false]]);
  assert.deepEqual(aim.map((a) => a.t), [1000, 1008, 1016], 'the manual clock is the time source');
  assert.equal(mouse.status.trackingOk, true);
});

test('coalesced events each produce a sample, in order, with their own timestamps (real clock)', async () => {
  const { mouse, target, aim, manual } = make({ realClock: true });
  await mouse.connect();
  manual.advance(50);
  const now = manual.now();
  target.pointer('pointermove', { clientX: 300, clientY: 300, timeStamp: now }, [
    { clientX: 100, clientY: 100, timeStamp: now - 12 },
    { clientX: 200, clientY: 200, timeStamp: now - 6 },
    { clientX: 300, clientY: 300, timeStamp: now },
  ]);
  assert.deepEqual(aim.map((a) => [a.x, a.t]), [[100, now - 12], [200, now - 6], [300, now]]);
  assert.equal(aim[0].discontinuity, true);
  assert.equal(aim[1].discontinuity, false);
});

test('event.timeStamp is used only when it lies on the performance.now timebase and never after now', async () => {
  const { mouse, target, aim, manual } = make({ realClock: true });
  await mouse.connect();
  manual.advance(100);
  const now = manual.now();
  target.pointer('pointermove', { clientX: 1, clientY: 1, timeStamp: 1_700_000_000_000 }); // epoch based: ignored
  target.pointer('pointermove', { clientX: 2, clientY: 2, timeStamp: now + 500 }); // from the future: clamped
  target.pointer('pointermove', { clientX: 3, clientY: 3, timeStamp: now - 5 }); // older than the previous: never goes backwards
  assert.equal(aim[0].t, now);
  assert.equal(aim[1].t, now);
  assert.equal(aim[2].t, now);
  target.pointer('pointermove', { clientX: 4, clientY: 4, timeStamp: 0 }); // zero: no usable stamp
  assert.equal(aim[3].t, now);
});

test('discontinuity after pointerleave, blur, and 200 ms of silence; not for a slow but steady pointer', async () => {
  const win = new EventTarget();
  const { mouse, target, aim, manual } = make({ windowTarget: win });
  await mouse.connect();
  const move = (x) => target.pointer('pointermove', { clientX: x, clientY: 500 });
  move(10);
  manual.advance(16);
  move(20);
  assert.equal(aim.at(-1).discontinuity, false);
  manual.advance(150);
  move(30);
  assert.equal(aim.at(-1).discontinuity, false, '150 ms is still continuous');
  manual.advance(201);
  move(40);
  assert.equal(aim.at(-1).discontinuity, true, 'more than 200 ms of silence');
  manual.advance(16);
  move(50);
  assert.equal(aim.at(-1).discontinuity, false);
  target.dispatchEvent(pointerEvent('pointerleave'));
  assert.equal(mouse.status.trackingOk, false);
  manual.advance(16);
  move(60);
  assert.equal(aim.at(-1).discontinuity, true, 'first sample after re-entering');
  assert.equal(mouse.status.trackingOk, true);
  manual.advance(16);
  move(70);
  assert.equal(aim.at(-1).discontinuity, false);
  win.dispatchEvent(new Event('blur'));
  manual.advance(16);
  move(80);
  assert.equal(aim.at(-1).discontinuity, true, 'after a window blur');
  manual.advance(16);
  target.dispatchEvent(pointerEvent('pointerenter'));
  move(90);
  assert.equal(aim.at(-1).discontinuity, true, 'pointerenter also breaks the trail');
});

test('positions are clamped to the playfield and follow the letterbox of the canvas', async () => {
  // a 1000 x 1000 canvas shows the 16:9 playfield letterboxed: scale 1000/1920, vertical offset (1000 - 562.5) / 2
  const { mouse, target, aim } = make({ rect: { left: 50, top: 20, width: 1000, height: 1000 } });
  await mouse.connect();
  const scale = 1000 / 1920;
  const offY = (1000 - 1080 * scale) / 2;
  target.pointer('pointermove', { clientX: 50 + 960 * scale, clientY: 20 + offY + 540 * scale });
  assert.ok(Math.abs(aim[0].x - 960) < 1e-9 && Math.abs(aim[0].y - 540) < 1e-9);
  target.pointer('pointermove', { clientX: -9999, clientY: -9999 });
  assert.deepEqual([aim[1].x, aim[1].y], [0, 0]);
  target.pointer('pointermove', { clientX: 99999, clientY: 99999 });
  assert.deepEqual([aim[2].x, aim[2].y], [1920, 1080]);
  target.pointer('pointermove', { clientX: 50 + 500, clientY: 20 + 3 }); // in the letterbox bar above the playfield
  assert.equal(aim[3].y, 0);
});

test('a custom toPlayfield is used (and clamped); null means "ignore this event"', async () => {
  let returnNull = false;
  const { mouse, target, aim } = make({ toPlayfield: (cx, cy) => (returnNull ? null : { x: cx * 2, y: cy * 2 }) });
  await mouse.connect();
  target.pointer('pointermove', { clientX: 100, clientY: 50 });
  target.pointer('pointermove', { clientX: 5000, clientY: 50 });
  returnNull = true;
  target.pointer('pointermove', { clientX: 1, clientY: 1 });
  assert.deepEqual(aim.map((a) => [a.x, a.y]), [[200, 100], [1920, 100]]);
  assert.equal(target.rectReads, 0, 'the custom converter replaces the layout read');
});

test('getBoundingClientRect is read once per pointer event, not once per coalesced event', async () => {
  const { mouse, target } = make();
  await mouse.connect();
  target.pointer('pointermove', { clientX: 5, clientY: 5 }, Array.from({ length: 8 }, (_, i) => ({ clientX: i, clientY: i })));
  target.pointer('pointermove', { clientX: 6, clientY: 6 });
  assert.equal(target.rectReads, 2);
});

test('actions: left press = fire (never confirm), right click = back, middle click = pause, double click = recenter', async () => {
  const { mouse, target, actions, manual } = make();
  await mouse.connect();
  const left = target.pointer('pointerdown', { button: 0 });
  assert.equal(left.defaultPrevented, false, 'the press is not prevented: its release still reaches the UI as a click');
  target.pointer('pointerdown', { button: 2 });
  manual.advance(10);
  const middle = target.pointer('pointerdown', { button: 1 });
  target.dispatchEvent(pointerEvent('dblclick'));
  const ctx = pointerEvent('contextmenu');
  target.dispatchEvent(ctx);
  assert.deepEqual(actions.map((a) => [a.action, a.label, a.source]), [['fire', 'Click', 'mouse'], ['back', 'right click', 'mouse'], ['pause', 'middle click', 'mouse'], ['recenter', 'double click', 'mouse']]);
  assert.equal(actions[0].t, 1000);
  assert.equal(actions[2].t, 1010);
  assert.ok(!actions.some((a) => a.action === 'confirm'), 'a press never confirms');
  for (const a of actions) assertValid('ActionEvent', a);
  assert.equal(middle.defaultPrevented, true);
  assert.equal(ctx.defaultPrevented, true);
});

test('disconnect detaches every listener; connect re-attaches; dispose removes all', async () => {
  const { mouse, target, aim, actions } = make();
  await mouse.connect();
  await mouse.disconnect();
  target.pointer('pointermove', { clientX: 1, clientY: 1 });
  target.pointer('pointerdown', { button: 2 });
  assert.equal(aim.length, 0);
  assert.equal(actions.length, 0);
  await mouse.connect();
  target.pointer('pointermove', { clientX: 1, clientY: 1 });
  assert.equal(aim.length, 1);
  assert.equal(aim[0].discontinuity, true, 'a fresh session starts with a discontinuity');
  mouse.dispose();
  target.pointer('pointermove', { clientX: 2, clientY: 2 });
  assert.equal(aim.length, 1);
});

test('a click before any movement reveals a pointer that is already over the canvas', async () => {
  const { mouse, target, aim } = make();
  await mouse.connect();
  assert.equal(mouse.status.trackingOk, false);
  target.pointer('pointerdown', { button: 0, clientX: 700, clientY: 400 });
  assert.equal(mouse.status.trackingOk, true);
  assert.deepEqual(aim.map((a) => [a.x, a.y, a.discontinuity]), [[700, 400, true]]);
  target.pointer('pointerdown', { button: 2, clientX: 710, clientY: 400 });
  assert.equal(aim.length, 1, 'once the pointer is known, a right click is not an extra sample');
  target.pointer('pointerdown', { button: 0, clientX: 720, clientY: 410 });
  assert.deepEqual(aim.map((a) => [a.x, a.y]), [[700, 400], [720, 410]], 'every left press is an aim sample at the press position (C-03)');
});

test('a mouse provider without a target still works as an object (no events)', async () => {
  const mouse = createInputProvider('mouse', { clock: createManualClock(0) });
  await mouse.connect();
  assert.equal(mouse.status.state, 'streaming');
  mouse.dispose();
});

test('a left press (C-03): an aim sample at the press position, then fire; motion.aimAt(fire.t) is exactly the press position', async () => {
  const { createMotionPipeline } = await import('../../public/js/motion/index.js');
  const { mouse, target, aim, actions, manual } = make();
  const motion = createMotionPipeline({ clock: manual });
  const order = [];
  mouse.on('aim', (a) => {
    order.push('aim');
    motion.pushAim(a);
  });
  mouse.on('action', (a) => order.push(a.action));
  await mouse.connect();
  target.pointer('pointermove', { clientX: 100, clientY: 100 });
  manual.advance(30);
  target.pointer('pointermove', { clientX: 400, clientY: 300 });
  manual.advance(16);
  target.pointer('pointerdown', { button: 0, clientX: 420, clientY: 310 });
  assert.deepEqual(order, ['aim', 'aim', 'aim', 'fire']);
  const fire = actions.at(-1);
  assert.deepEqual([fire.action, fire.label, fire.source, fire.t], ['fire', 'Click', 'mouse', manual.now()]);
  assertValid('ActionEvent', fire);
  assert.deepEqual(aim.at(-1), { t: manual.now(), x: 420, y: 310, discontinuity: false });
  assert.deepEqual(motion.aimAt(fire.t), { x: 420, y: 310, valid: true });
  // a right or middle press is not a shot and not an aim sample
  target.pointer('pointerdown', { button: 2, clientX: 900, clientY: 900 });
  assert.equal(actions.filter((a) => a.action === 'fire').length, 1);
  assert.equal(aim.length, 3);
});
