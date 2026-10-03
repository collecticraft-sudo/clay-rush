// Actions and keyboard tests (docs/architecture.md 4.1, C-02, C-03). The button mapping is side specific and rising-edge only.
// Whether ZR is a comfortable trigger and how fast it can be pulled twice is UNVERIFIED-ON-HARDWARE (UOH-10).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createButtonActions, actionForButton, labelsForSide, BUTTON_ACTIONS, ACTION_ORDER, TRIGGER_BUTTONS, buttonActionsFor, normalizeTriggerButton } from '../../public/js/input/actions.js';
import { ACTION_LABELS } from '../../public/js/input/provider-base.js';
import { INPUT_CONFIG } from '../../public/js/input/input-config.js';
import { createKeyboardActions, createInputProvider } from '../../public/js/input/index.js';
import { BUTTON_NAMES, ACTION } from '../../public/js/shared/contracts.js';
import { createManualClock } from '../../public/js/shared/clock.js';
import { assertValid } from '../../public/js/shared/validate.js';
import { makeEvent } from '../../test-support/input/fake-dom.js';

function mapper(side = 'R') {
  const clock = createManualClock(0);
  const out = [];
  const actions = createButtonActions({ clock, getSide: () => side, emit: (e) => out.push(e) });
  const press = (down, sideOverride = side, initial = false) => actions.handle({ t: clock.now(), side: sideOverride, pressed: down, down, up: [], ...(initial ? { initial: true } : {}) });
  return { clock, out, actions, press };
}

test('mapping table, Right Joy-Con (Clay Rush C-02): ZR fires, R recentres', () => {
  const expected = { fire: ['ZR'], confirm: ['A', 'Y', 'X'], back: ['B'], pause: ['PLUS'], recenter: ['R'] };
  assert.deepEqual(BUTTON_ACTIONS.R, expected);
  for (const [action, buttons] of Object.entries(expected)) for (const b of buttons) assert.equal(actionForButton('R', b), action, `${b}`);
});

test('mapping table, Left Joy-Con (Clay Rush C-02): ZL fires, L recentres', () => {
  const expected = { fire: ['ZL'], confirm: ['DOWN', 'RIGHT', 'UP'], back: ['LEFT'], pause: ['MINUS', 'CAPTURE'], recenter: ['L'] };
  assert.deepEqual(BUTTON_ACTIONS.L, expected);
  for (const [action, buttons] of Object.entries(expected)) for (const b of buttons) assert.equal(actionForButton('L', b), action, `${b}`);
});

test('trigger setting R swaps fire and recenter on both units; everything else is unchanged', () => {
  assert.deepEqual(TRIGGER_BUTTONS, ['ZR', 'R']);
  const r = buttonActionsFor('R');
  assert.deepEqual(r.R.fire, ['R']);
  assert.deepEqual(r.R.recenter, ['ZR']);
  assert.deepEqual(r.L.fire, ['L']);
  assert.deepEqual(r.L.recenter, ['ZL']);
  for (const a of ['confirm', 'back', 'pause']) assert.deepEqual(r.R[a], BUTTON_ACTIONS.R[a]);
  assert.equal(buttonActionsFor('ZR'), BUTTON_ACTIONS);
  assert.equal(actionForButton('R', 'R', 'R'), 'fire');
  assert.equal(actionForButton('R', 'ZR', 'R'), 'recenter');
  assert.equal(actionForButton('L', 'L', 'R'), 'fire');
  assert.equal(actionForButton('L', 'ZL', 'R'), 'recenter');
  assert.equal(actionForButton('?', 'ZL', 'R'), 'recenter');
  assert.equal(normalizeTriggerButton('A'), null, 'the design\'s third option A is dropped: A must stay confirm');
  assert.equal(normalizeTriggerButton('R'), 'R');
});

test('buttons of the other unit, HOME, stick clicks and the rest are never mapped', () => {
  for (const b of ['DOWN', 'UP', 'LEFT', 'RIGHT', 'L', 'ZL', 'MINUS', 'CAPTURE', 'SL_L', 'SR_L']) assert.equal(actionForButton('R', b), null, `R ignores ${b}`);
  // n4: the rail buttons (where a strap or a grip touches the Joy-Con) never trigger an action, on either side
  for (const side of ['R', 'L', '?']) for (const b of ['SL_R', 'SR_R', 'SL_L', 'SR_L']) assert.equal(actionForButton(side, b), null, `${side} ${b}`);
  for (const b of ['A', 'B', 'X', 'Y', 'R', 'ZR', 'PLUS', 'SL_R', 'SR_R']) assert.equal(actionForButton('L', b), null, `L ignores ${b}`);
  for (const side of ['L', 'R', '?']) for (const b of ['HOME', 'R_STICK', 'L_STICK', 'C', 'GR', 'GL']) assert.equal(actionForButton(side, b), null, `${side} never maps ${b}`);
  // every button name of the contract is either mapped by some side or explicitly unmapped
  const mapped = new Set([...Object.values(BUTTON_ACTIONS.R), ...Object.values(BUTTON_ACTIONS.L)].flat());
  for (const name of mapped) assert.ok(BUTTON_NAMES.includes(name), `${name} is a contract button name`);
});

test('unknown side accepts the buttons of both units', () => {
  assert.equal(actionForButton('?', 'A'), 'confirm');
  assert.equal(actionForButton('?', 'DOWN'), 'confirm');
  assert.equal(actionForButton('?', 'ZL'), 'fire');
  assert.equal(actionForButton('?', 'L'), 'recenter');
  assert.equal(actionForButton('?', 'HOME'), null);
});

test('rising edges only: holding a button fires once, releasing and pressing again fires again', () => {
  const { clock, out, actions, press } = mapper('R');
  press(['ZR']);
  assert.equal(out.length, 1);
  // a held button shows up in later ButtonsEvents only as part of `pressed`, never as `down`
  actions.handle({ t: 1, side: 'R', pressed: ['ZR', 'A'], down: ['A'], up: [] });
  assert.deepEqual(out.map((e) => e.action), ['fire', 'confirm']);
  actions.handle({ t: 2, side: 'R', pressed: ['ZR'], down: [], up: ['A'] });
  assert.equal(out.length, 2, 'a release fires nothing');
  clock.advance(500);
  press(['A']);
  assert.equal(out.length, 3);
});

test('the initial baseline event never fires an action (a button held at connect time, phantom ZL/ZR)', () => {
  const { out, press } = mapper('R');
  press(['ZR', 'A'], 'R', true);
  assert.deepEqual(out, []);
  press(['B']);
  assert.deepEqual(out.map((e) => e.action), ['back']);
});

test('contact-bounce guard: two edges of the same (non-fire) action within 120 ms fire once, other actions are independent', () => {
  const { clock, out, press } = mapper('R');
  press(['R']);
  clock.advance(50);
  press(['R']);
  press(['A']);
  assert.deepEqual(out.map((e) => e.action), ['recenter', 'confirm']);
  clock.advance(100);
  press(['R']);
  assert.equal(out.filter((e) => e.action === 'recenter').length, 2);
});

test('fire: edges pass at least every 70 ms (an over-and-under double), a one-report bounce (< 40 ms) does not', () => {
  const { out, actions } = mapper('R');
  const at = (t, down) => actions.handle({ t, side: 'R', pressed: down, down, up: [] });
  // 33 Hz reports: press, release, press 60 ms later
  at(1000, ['ZR']);
  at(1060, ['ZR']);
  at(1130, ['ZR']);
  at(1200, ['ZR']);
  assert.deepEqual(out.map((e) => e.t), [1000, 1060, 1130, 1200], 'every edge 60 to 70 ms apart passes');
  at(1230, ['ZR']); // 30 ms: a bounce at 33 Hz
  assert.equal(out.length, 4);
  assert.ok(INPUT_CONFIG.action.fireMinIntervalMs < 70, 'the fire guard stays below 70 ms');
  assert.equal(INPUT_CONFIG.action.minIntervalMs, 120, 'other actions keep their 120 ms guard');
  for (const e of out) assertValid('ActionEvent', e);
});

test('fire: the guard runs on report times, so a burst of reports delivered at one clock instant keeps both shots', () => {
  const { clock, out, actions } = mapper('R');
  clock.advance(5000); // the clock does not move between the two deliveries
  actions.handle({ t: 4900, side: 'R', pressed: ['ZR'], down: ['ZR'], up: [] });
  actions.handle({ t: 4960, side: 'R', pressed: ['ZR'], down: ['ZR'], up: [] });
  assert.deepEqual(out.map((e) => [e.action, e.t]), [['fire', 4900], ['fire', 4960]]);
});

test('fire: the ActionEvent t is the report (sample) time of the first report showing the button down, not the handling time', () => {
  const { clock, out, actions } = mapper('L');
  clock.advance(10_000);
  actions.handle({ t: 9_970.5, side: 'L', pressed: ['ZL'], down: ['ZL'], up: [] });
  assert.deepEqual(out, [{ t: 9_970.5, action: 'fire', label: 'ZL', source: 'joycon' }]);
  assertValid('ActionEvent', out[0]);
});

test('phantom-bit hold-off is per BUTTON (ZL/ZR): with the trigger on R the shot passes and the ZR re-centre is dropped; with ZR the reverse', () => {
  const r = mapper('R');
  r.actions.setTriggerButton('R');
  r.actions.holdOffButtons(['ZL', 'ZR'], 1500);
  r.press(['R']);
  r.press(['ZR']);
  assert.deepEqual(r.out.map((e) => [e.action, e.label]), [['fire', 'R']], 'R fires, the held ZR (now the re-centre) is ignored');
  r.clock.advance(1600);
  r.press(['ZR']);
  assert.deepEqual(r.out.map((e) => e.action), ['fire', 'recenter'], 'after the window ZR works again');
  const z = mapper('R');
  z.actions.holdOffButtons(['ZL', 'ZR'], 1500);
  z.press(['ZR']);
  z.press(['R']);
  assert.deepEqual(z.out.map((e) => e.action), ['recenter'], 'trigger ZR: the held ZR shot is dropped, R re-centres');
  z.clock.advance(1600);
  z.press(['ZR']);
  assert.deepEqual(z.out.map((e) => e.action), ['recenter', 'fire']);
  const a = mapper('R');
  a.actions.holdOff(ACTION.RECENTER, 1500);
  a.press(['ZR']);
  assert.deepEqual(a.out.map((e) => e.action), ['fire'], 'an action hold-off of recenter never touches fire');
  a.actions.reset();
  a.actions.holdOffButtons(['ZR'], 1500);
  a.actions.reset();
  a.clock.advance(200);
  a.press(['ZR']);
  assert.equal(a.out.length, 2, 'reset() clears the button hold-off');
});

test('setTriggerButton swaps fire and recenter live, with the labels; unknown values are ignored', () => {
  const { clock, out, actions, press } = mapper('R');
  assert.equal(actions.getTriggerButton(), 'ZR');
  assert.equal(actions.setTriggerButton('R'), 'R');
  press(['R']);
  press(['ZR']);
  assert.deepEqual(out.map((e) => [e.action, e.label]), [['fire', 'R'], ['recenter', 'ZR']]);
  assert.equal(actions.setTriggerButton('A'), 'R', 'ignored');
  assert.equal(actions.setTriggerButton(undefined), 'R');
  actions.reset();
  assert.equal(actions.getTriggerButton(), 'R', 'reset() keeps the setting (it is a user setting, not link state)');
  actions.setTriggerButton('ZR');
  clock.advance(500);
  press(['ZR']);
  assert.equal(out.at(-1).action, 'fire');
  const left = createButtonActions({ clock, getSide: () => 'L', emit: () => {}, triggerButton: 'R' });
  assert.equal(left.getTriggerButton(), 'R', 'the option sets the initial value');
});

test('several buttons in one report fire their actions in a fixed order, the shot first', () => {
  assert.deepEqual(ACTION_ORDER, ['fire', 'confirm', 'back', 'pause', 'recenter']);
  const { out, press } = mapper('R');
  press(['R', 'PLUS', 'B', 'A', 'ZR']);
  assert.deepEqual(out.map((e) => e.action), ['fire', 'confirm', 'back', 'pause', 'recenter']);
  const dedupe = mapper('R');
  dedupe.press(['A', 'X', 'Y']);
  assert.equal(dedupe.out.length, 1, 'three confirm buttons at once are one confirm');
});

test('ActionEvent shape, labels and source', () => {
  const { out, press } = mapper('L');
  press(['MINUS']);
  press(['DOWN']);
  press(['ZL']);
  assert.deepEqual(out.map((e) => [e.action, e.label, e.source]), [['pause', '-', 'joycon'], ['confirm', 'Down', 'joycon'], ['fire', 'ZL', 'joycon']]);
  for (const e of out) assertValid('ActionEvent', e);
  assert.deepEqual(labelsForSide('R'), { confirm: 'A', back: 'B', pause: '+', recenter: 'R', fire: 'ZR' });
  assert.deepEqual(labelsForSide('L'), { confirm: 'Down', back: 'Left', pause: '-', recenter: 'L', fire: 'ZL' });
  assert.deepEqual(labelsForSide('R', 'R'), { confirm: 'A', back: 'B', pause: '+', recenter: 'ZR', fire: 'R' });
  assert.deepEqual(labelsForSide('L', 'R'), { confirm: 'Down', back: 'Left', pause: '-', recenter: 'ZL', fire: 'L' });
  assert.deepEqual(labelsForSide('?'), labelsForSide('R'), 'unknown side falls back to the Right labels');
  assert.deepEqual(ACTION_LABELS.keyboard.fire, 'F');
  assert.deepEqual(ACTION_LABELS.mouse.fire, 'Click');
  for (const table of Object.values(ACTION_LABELS)) assert.deepEqual(Object.keys(table).sort(), ['back', 'confirm', 'fire', 'pause', 'recenter']);
});

test('reset forgets the bounce guard', () => {
  const { out, actions, press } = mapper('R');
  press(['R']);
  actions.reset();
  press(['R']);
  assert.equal(out.length, 2);
});

test('all five actions exist in the contract', () => {
  assert.deepEqual(Object.values(ACTION).sort(), ['back', 'confirm', 'fire', 'pause', 'recenter']);
});

// ------------------------------------------------------------------------------------------------ keyboard

function keyboard() {
  const target = new EventTarget();
  const clock = createManualClock(5);
  const kb = createKeyboardActions({ clock, target });
  const actions = [];
  kb.on('action', (a) => actions.push(a));
  const key = (props) => {
    const ev = makeEvent('keydown', { repeat: false, ctrlKey: false, metaKey: false, altKey: false, ...props });
    target.dispatchEvent(ev);
    return ev;
  };
  return { kb, target, clock, actions, key };
}

test('keyboard: Enter = confirm, Escape = back, P = pause, Space = recenter, with their labels', () => {
  const { actions, key } = keyboard();
  key({ key: 'Enter', code: 'Enter' });
  key({ key: 'Escape', code: 'Escape' });
  key({ key: 'p', code: 'KeyP' });
  key({ key: 'P', code: 'KeyP', shiftKey: true });
  key({ key: ' ', code: 'Space' });
  key({ key: 'Enter', code: 'NumpadEnter' });
  assert.deepEqual(actions.map((a) => [a.action, a.label, a.source, a.t]), [
    ['confirm', 'Enter', 'keyboard', 5], ['back', 'Esc', 'keyboard', 5], ['pause', 'P', 'keyboard', 5], ['pause', 'P', 'keyboard', 5],
    ['recenter', 'Space', 'keyboard', 5], ['confirm', 'Enter', 'keyboard', 5],
  ]);
  for (const a of actions) assertValid('ActionEvent', a);
});

test('keyboard (C-03): F fires and C recentres (Space too); Enter stays confirm; the fire t is the clock at the key press', () => {
  const { actions, key, clock } = keyboard();
  key({ key: 'f', code: 'KeyF' });
  clock.advance(12);
  key({ key: 'F', code: 'KeyF', shiftKey: true });
  key({ key: 'c', code: 'KeyC' });
  key({ key: ' ', code: 'Space' });
  key({ key: 'Enter', code: 'Enter' });
  assert.deepEqual(actions.map((a) => [a.action, a.label, a.source, a.t]), [
    ['fire', 'F', 'keyboard', 5], ['fire', 'F', 'keyboard', 17], ['recenter', 'Space', 'keyboard', 17], ['recenter', 'Space', 'keyboard', 17],
    ['confirm', 'Enter', 'keyboard', 17],
  ]);
  for (const a of actions) assertValid('ActionEvent', a);
  const held = keyboard();
  held.key({ key: 'f', code: 'KeyF', repeat: true });
  assert.equal(held.actions.length, 0, 'a held F does not auto-fire');
});

test('keyboard: no auto-repeat, no shortcuts with Ctrl/Alt/Meta, nothing while typing in a form field, Space does not scroll', () => {
  const { actions, key } = keyboard();
  key({ key: 'Enter', repeat: true });
  key({ key: 'p', metaKey: true });
  key({ key: 'p', ctrlKey: true });
  key({ key: 'p', altKey: true });
  key({ key: 'Enter', isComposing: true });
  key({ key: 'a' });
  key({ key: 'F5' });
  assert.equal(actions.length, 0);
  const target = new EventTarget();
  const kb = createKeyboardActions({ clock: createManualClock(0), target });
  const seen = [];
  kb.on('action', (a) => seen.push(a));
  const ev = makeEvent('keydown', { key: ' ', code: 'Space', repeat: false });
  target.dispatchEvent(ev);
  assert.equal(ev.defaultPrevented, true, 'Space must not scroll the page');
  assert.equal(seen.length, 1);
});

test('keyboard: form fields are ignored (event target is an input, textarea, select or contenteditable)', () => {
  const clock = createManualClock(0);
  const target = new EventTarget();
  const kb = createKeyboardActions({ clock, target });
  const seen = [];
  kb.on('action', (a) => seen.push(a));
  const fire = (el) => {
    const ev = makeEvent('keydown', { key: 'Enter', code: 'Enter', repeat: false });
    Object.defineProperty(ev, 'target', { value: el });
    target.dispatchEvent(ev);
  };
  for (const el of [{ tagName: 'INPUT' }, { tagName: 'TEXTAREA' }, { tagName: 'SELECT' }, { tagName: 'DIV', isContentEditable: true }]) fire(el);
  assert.equal(seen.length, 0);
  fire({ tagName: 'CANVAS' });
  assert.equal(seen.length, 1);
});

test('keyboard: labels, off(), dispose(), and the clock is required', () => {
  const { kb, target, actions, key } = keyboard();
  assert.deepEqual(kb.getLabels(), { confirm: 'Enter', back: 'Esc', pause: 'P', recenter: 'Space', fire: 'F' });
  const extra = [];
  const fn = (a) => extra.push(a);
  kb.on('action', fn);
  key({ key: 'Enter' });
  kb.off('action', fn);
  key({ key: 'Enter' });
  assert.equal(extra.length, 1);
  assert.equal(actions.length, 2);
  kb.dispose();
  key({ key: 'Enter' });
  assert.equal(actions.length, 2);
  assert.ok(target);
  assert.throws(() => createKeyboardActions({}), TypeError);
  assert.throws(() => createKeyboardActions(), TypeError);
});

test('keyboard actions are independent of any provider (the safety screen needs Enter before a provider exists)', () => {
  const clock = createManualClock(0);
  const target = new EventTarget();
  const kb = createKeyboardActions({ clock, target });
  const seen = [];
  kb.on('action', (a) => seen.push(a.action));
  target.dispatchEvent(makeEvent('keydown', { key: 'Enter', repeat: false }));
  assert.deepEqual(seen, ['confirm']);
  const provider = createInputProvider('mouse', { clock });
  assert.equal(provider.status.state, 'idle');
});
