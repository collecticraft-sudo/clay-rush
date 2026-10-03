// URL flag parsing (docs/architecture.md 9.7).
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFlags, FILTER_NAMES, INPUT_KINDS } from '../../public/js/flags.js';
import { INPUT_CONFIG } from '../../public/js/input/index.js';

test('flags: defaults are all off and nothing warns', () => {
  const f = parseFlags('');
  assert.equal(f.input, null);
  assert.equal(f.seed, null);
  assert.equal(f.mode, null);
  assert.equal(f.clock, 'real');
  for (const k of ['skipsafety', 'skipcountdown', 'debug', 'mute', 'reducemotion', 'reduceflash', 'simmirror', 'simcal']) assert.equal(f[k], false, k);
  assert.equal(f.haptics, true, 'rumble is on unless ?haptics=0');
  assert.equal(f.assets, true);
  assert.equal(f.difficulty, null);
  assert.equal(f.stage, null);
  assert.equal(f.simgyro, 'default');
  assert.deepEqual(f.warnings, []);
});

test('flags: every documented flag is understood', () => {
  const f = parseFlags('?input=sim&seed=42&mode=timeattack&difficulty=hard&stage=alpine&skipsafety=1&skipcountdown=1&clock=manual&debug=1&mute=1&reducemotion=1&reduceflash=1&simhz=250&simmount=tilted&simside=L&simmirror=1&simgyro=alt&simseed=9&simcal=1&haptics=1');
  assert.equal(f.input, 'sim');
  assert.equal(f.seed, 42);
  assert.equal(f.mode, 'timeattack');
  assert.equal(f.difficulty, 'hard');
  assert.equal(f.stage, 'alpine');
  assert.equal(f.clock, 'manual');
  assert.equal(f.simhz, 250);
  assert.equal(f.simmount, 'tilted');
  assert.equal(f.simside, 'L');
  assert.equal(f.simgyro, 'alt');
  assert.equal(f.simseed, 9);
  for (const k of ['skipsafety', 'skipcountdown', 'debug', 'mute', 'reducemotion', 'reduceflash', 'simmirror', 'simcal', 'haptics']) assert.equal(f[k], true, k);
  assert.deepEqual(f.warnings, []);
});

test('flags: ?haptics=0 turns the rumble off; ?difficulty and ?stage outside their lists are ignored with a warning', () => {
  assert.equal(parseFlags('?haptics=0').haptics, false);
  const f = parseFlags('?difficulty=insane&stage=moon&mode=arcade');
  assert.equal(f.difficulty, null);
  assert.equal(f.stage, null);
  assert.equal(f.mode, null, 'the fruit mode "arcade" is gone');
  assert.equal(f.warnings.length, 3);
});

test('flags: ?mode implies ?skipsafety and, without ?input, the mouse provider', () => {
  const f = parseFlags('?mode=zen');
  assert.equal(f.mode, 'zen');
  assert.equal(f.skipsafety, true);
  assert.equal(f.input, 'mouse');
  assert.equal(parseFlags('?mode=zen&input=sim').input, 'sim');
});

test('flags: illegal values are ignored and reported, never thrown', () => {
  const f = parseFlags('?input=gamepad&seed=abc&mode=hard&simhz=5&simmount=sideways&simside=X&clock=fast&debug=maybe');
  assert.equal(f.input, null);
  assert.equal(f.seed, null);
  assert.equal(f.mode, null);
  assert.equal(f.simhz, undefined);
  assert.equal(f.simmount, undefined);
  assert.equal(f.simside, undefined);
  assert.equal(f.clock, 'real');
  assert.equal(f.debug, false);
  assert.ok(f.warnings.length >= 7, f.warnings.join('\n'));
});

test('flags: ?input=native selects the native Bluetooth bridge, like ?input=joycon it creates the provider without connecting', () => {
  assert.equal(parseFlags('?input=native').input, 'native');
  assert.equal(parseFlags('?input=NATIVE').input, 'native');
  assert.deepEqual(parseFlags('?input=native').warnings, []);
  assert.deepEqual([...INPUT_KINDS], ['joycon', 'native', 'sim', 'mouse']);
  const f = parseFlags('?input=native&side=L&mask=0xFF');
  assert.deepEqual([f.input, f.side, f.mask], ['native', 'L', 0xff], 'side and mask reach the native bridge too');
});

test('flags: the old reserved name ?input=bridge is ignored with a warning that names the replacement; nothing is connected', () => {
  const f = parseFlags('?input=bridge');
  assert.equal(f.input, null);
  assert.equal(f.warnings.length, 1);
  assert.match(f.warnings[0], /\?input=bridge ignored.*use \?input=native/);
  assert.match(parseFlags('?input=gamepad').warnings[0], /joycon, native, sim or mouse expected/);
});

test('flags: seeds are coerced to uint32 and a URLSearchParams works too', () => {
  assert.equal(parseFlags('?seed=-1').seed, 4294967295);
  assert.equal(parseFlags(new URLSearchParams('seed=7&input=mouse')).seed, 7);
});

// ---- round 1 findings M5 / F2 / F3: the Bluetooth connection flags and the accelerometer sign

test('flags: ?filter, ?mask and ?side reach the Bluetooth connection; nothing is set by default', () => {
  const none = parseFlags('');
  assert.deepEqual([none.filter, none.mask, none.side, none.accelsign, none.simaccelsign], [null, null, null, null, 1]);
  const f = parseFlags('?filter=lenient&mask=0xB7&side=L');
  assert.deepEqual([f.filter, f.mask, f.side], ['lenient', 0xb7, 'L']);
  assert.deepEqual(f.warnings, []);
  const g = parseFlags('?filter=ALL&mask=0Xff&side=r&accelsign=-1&simaccelsign=-1');
  assert.deepEqual([g.filter, g.mask, g.side, g.accelsign, g.simaccelsign], ['all', 0xff, 'R', -1, -1]);
  assert.deepEqual(g.warnings, []);
  assert.equal(parseFlags('?mask=0x37').mask, 0x37);
  assert.equal(parseFlags('?side=any').side, null, 'any is the default');
  assert.equal(parseFlags('?accelsign=1').accelsign, 1);
});

test('flags: a mask must be written with 0x (a bare "37" would silently mean decimal 37), everything illegal is reported and ignored', () => {
  for (const bad of ['37', 'B7', '0x', '0x100', '0xZZ', '0x0', '183', '-1', '']) {
    const f = parseFlags(`?mask=${bad}`);
    assert.equal(f.mask, null, `mask=${bad}`);
    assert.ok(f.warnings.some((w) => /mask/.test(w)), `mask=${bad} warns`);
  }
  const f = parseFlags('?filter=everything&side=both&accelsign=2&simaccelsign=up');
  assert.deepEqual([f.filter, f.side, f.accelsign, f.simaccelsign], [null, null, null, 1]);
  assert.equal(f.warnings.length, 4, f.warnings.join(' | '));
});

test('flags: the filter names are lenient (the default), strict and all; the warning for an unknown one names them in that order', () => {
  assert.deepEqual([...FILTER_NAMES], ['lenient', 'strict', 'all']);
  assert.equal(FILTER_NAMES[0], INPUT_CONFIG.defaultFilter, 'the first name is the default');
  for (const name of FILTER_NAMES) assert.equal(parseFlags(`?filter=${name}`).filter, name);
  assert.match(parseFlags('?filter=pairing').warnings.join(' '), /lenient, strict or all expected/);
});
