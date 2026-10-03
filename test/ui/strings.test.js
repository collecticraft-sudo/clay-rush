// strings.en.js: every key the UI uses exists, the HUD keys of docs/architecture.md 8.5 are there with their texts, display strings are capitals
// (Bebas Neue has no lowercase), English only, and nothing of the fruit game is left.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { STRINGS, t, formatScore } from '../../public/js/ui/strings.en.js';
import { ERROR_STRING_KEYS } from '../../public/js/ui/connect-model.js';
import { MENU_BUTTONS, PAUSE_BUTTONS, SETTINGS_BUTTONS, SETTINGS_ROWS, TUNING_ROWS, rowOptions } from '../../public/js/ui/layout-data.js';
import { optionLabel } from '../../public/js/ui/screens/common.js';
import { resultTitleKey, statTiles } from '../../public/js/ui/screens/results.js';
import { roundResult } from '../../test-support/ui/fixtures.js';
import { findItalian } from '../../test-support/ui/italian-leaks.js';

const UI_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'public', 'js', 'ui');
function walk(dir) {
  const out = [];
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (n.endsWith('.js')) out.push(p);
  }
  return out;
}
const SOURCES = walk(UI_DIR).map((p) => ({ p, src: readFileSync(p, 'utf8') }));
const has = (k) => Object.hasOwn(STRINGS, k);

test('every literal key passed to t() in public/js/ui exists', () => {
  const missing = [];
  for (const { p, src } of SOURCES) {
    for (const m of src.matchAll(/\bt\(\s*'([\w.]+)'/g)) if (!has(m[1])) missing.push(`${p.split('/ui/')[1]}: ${m[1]}`);
    for (const m of src.matchAll(/labelKey: '([\w.]+)'/g)) if (!has(m[1])) missing.push(`${p.split('/ui/')[1]}: ${m[1]}`);
    for (const m of src.matchAll(/'((?:connect|cal|cal\.s\d)\.[\w.]+)'/g)) if (/^(connect\.step\d|cal\.(moved|badPose|badAccel|timeout|noData|noCalibration|signUnknown))$/.test(m[1]) && !has(m[1])) missing.push(m[1]);
  }
  assert.deepEqual(missing, []);
});

test('every key built at run time exists (modes, difficulties, stages, settings rows and options, calibration steps, results, providers)', () => {
  const keys = [];
  for (const m of ['classic', 'timeattack', 'zen']) keys.push(`menu.${m}`, `menu.${m}.desc`, `mode.${m}`);
  for (const d of ['easy', 'normal', 'hard']) keys.push(`difficulty.${d}`, `difficulty.${d}.desc`);
  for (const s of ['meadow', 'hills', 'alpine']) keys.push(`stage.${s}`, `stage.${s}.desc`);
  for (const row of [...SETTINGS_ROWS, ...TUNING_ROWS]) {
    keys.push(`settings.${row.key}`, `settings.${row.key}.hint`);
    rowOptions(row).forEach((v, i) => assert.ok(optionLabel(row, v, i) && !optionLabel(row, v, i).includes('settings.'), `${row.key} option ${v}`));
  }
  for (const n of [1, 2, 3]) keys.push(`cal.s${n}.title`, `cal.s${n}.text`);
  keys.push('cal.s4.text', 'cal.s4.textClick', 'cal.s4.paused');
  for (const k of ['joycon', 'sim', 'mouse']) keys.push(`menu.provider.${k}`);
  for (const r of [roundResult(), roundResult({ endReason: 'timer' }), roundResult({ endReason: 'quit' }), roundResult({ mode: 'zen' })]) {
    keys.push(resultTitleKey(r));
    for (const [k] of statTiles(r)) keys.push(k);
  }
  keys.push(...Object.values(ERROR_STRING_KEYS));
  keys.push(...MENU_BUTTONS.map((b) => b.labelKey), ...PAUSE_BUTTONS.map((b) => b.labelKey), ...SETTINGS_BUTTONS.map((b) => b.labelKey));
  assert.deepEqual(keys.filter((k) => !has(k)), []);
});

test('the HUD keys of docs/architecture.md 8.5 exist with their texts', () => {
  const HUD = {
    'hud.pull': 'PULL {n}/{total}', 'hud.pullPrompt': 'PRESS {fire} TO CALL PULL!', 'hud.reloading': 'RELOADING', 'hud.wind': '{speed} M/S', 'hud.time': '{s}',
    'hud.stage': 'STAGE {n}: {name}', 'hud.stageCard.title': 'STAGE {n}', 'hud.stageCard.name': '{name}', 'hud.banner.double': 'DOUBLE!',
    'hud.banner.twoWithOne': 'TWO WITH ONE!', 'hud.banner.smoked': 'SMOKED!', 'hud.banner.streak': 'STREAK x{n}', 'hud.banner.perfect': 'PERFECT STAGE',
    'hud.banner.timeUp': 'TIME!', 'hud.banner.newBest': 'NEW BEST!', 'hud.lowBattery': 'Joy-Con battery low', 'hud.zen.stats': '{hits} HITS, {acc}% OF THE LAST 20',
    'hud.dry': 'EMPTY', 'hud.multiplier': 'x{n}',
  };
  for (const [k, v] of Object.entries(HUD)) assert.equal(STRINGS[k], v, k);
  assert.ok(has('hud.score') && has('hud.best'));
  assert.equal(t('hud.pullPrompt', { fire: 'ZR' }), 'PRESS ZR TO CALL PULL!');
});

test('display strings (Bebas Neue, capitals only) contain no lowercase letters', () => {
  const DISPLAY = [
    /^safety\.(title|reduceFlash|wait|ok)$/,
    /^connect\.(title|steps\.title|button|continue|back|calibrate|alt\.sim|alt\.mouse|fallback\.button|native\.button|native\.secondary|native\.secondaryToNative|native\.cancel|cooldown\.wait)$/,
    /^cal\.(title|s\d\.title|s4\.text|s4\.textClick|s4\.paused|retry|quick|flipX\.button)$/,
    /^menu\.(title|classic|timeattack|zen|best|bestFor|best\.none|best\.zen|bestScores|settings|controller)$/,
    /^setup\.(difficulty|stage|start|back)$/, /^difficulty\.(easy|normal|hard)$/, /^stage\.(meadow|hills|alpine)$/, /^mode\./, /^countdown\./,
    /^hud\.(?!lowBattery|recentered|last10)/,
    /^pause\.(title|resume|recentre|settings|quit|endSession|resuming|confirm\.(title|yes|no))$/,
    /^results\.(?!assist|rest)/, /^best\.(title|classic|timeattack|empty|back)$/,
    /^settings\.(title|group\.\w+|on|off|tune|reset|reset\.confirm|reset\.yes|reset\.no|back|aimCurve\.\w+|aimAssist\.\w+|triggerCompMs\.value|percent|triggerButton\.\w+)$/,
    /^tune\.(title|lastShot|speedValue|jerkValue|driftValue|compValue|back)$/,
    /^disc\.(title|wait|retry|useMouse|menu|native\.retry|native\.wait)$/, /^hint\.(stick|arrows|click)$/,
  ];
  const bad = [];
  for (const [k, v] of Object.entries(STRINGS)) {
    if (k.endsWith('.hint') || !DISPLAY.some((re) => re.test(k))) continue;
    // "x{n}" is the multiplier of the contract (8.5): Bebas Neue draws the x as a capital
    if (/[a-z]/.test(v.replace(/x\{\w+\}/g, '').replace(/\{\w+\}/g, ''))) bad.push(`${k}: ${v}`);
  }
  assert.deepEqual(bad, []);
});

test('no word of the fruit game in the strings or anywhere in the UI sources', () => {
  // the fruit is matched in lowercase only: "Apple's developer tools" are the Mac's
  const FRUIT = /\b([Ff]ruits?|[Ss]words?|[Ss]lic\w*|[Ss]lash\w*|[Bb]lades?|[Nn]injas?|[Dd]ojo|[Bb]ombs?|[Kk]atana|apples?|[Mm]elons?|[Ww]atermelon)\b/;
  for (const [k, v] of Object.entries(STRINGS)) assert.ok(!FRUIT.test(v), `${k}: ${v}`);
  for (const { p, src } of SOURCES) {
    const m = FRUIT.exec(src.replace(/\.slice\(/g, ''));
    assert.ok(!m, `${p.split('/public/')[1]} mentions "${m && m[0]}"`);
  }
});

test('English only: no accented letters, no Italian words (the detector of test-support/ui/italian-leaks.js)', () => {
  for (const [k, v] of Object.entries(STRINGS)) {
    assert.ok(!/[àèéìíòóùú]/i.test(v), `${k} has an accented letter`);
    assert.deepEqual(findItalian(v), [], `${k}: ${v}`);
  }
});

test('placeholders resolve; missing keys throw in Node (strict); scores get thousands separators', () => {
  assert.equal(t('hud.pull', { n: 4, total: 10 }), 'PULL 4/10');
  assert.equal(t('cal.s4.text', { fire: 'ZR' }), 'SHOOT THE CLAY: PRESS ZR!');
  assert.throws(() => t('no.such.key'));
  assert.equal(formatScore(1234567), '1,234,567');
  assert.equal(formatScore(-5), '0');
});
