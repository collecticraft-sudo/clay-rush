// storage.js: key clayRush.v1, the settings table of docs/architecture.md 8.4 with clamping and validation, best scores, flags.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createStorage, sanitizeSettings, SETTINGS_DEFAULTS, SETTINGS_SPEC, SETTINGS_ENUMS, STORAGE_KEY, LOCAL_BEST_HELPERS } from '../../public/js/ui/storage.js';
import { memoryBackend, roundResult, throwingBackend } from '../../test-support/ui/fixtures.js';

const noRm = () => ({ matches: false });

test('the key is clayRush.v1 and the defaults are the table of 8.4', () => {
  assert.equal(STORAGE_KEY, 'clayRush.v1');
  assert.deepEqual({ ...SETTINGS_DEFAULTS }, {
    sensitivity: 1.0, aimCurve: 'balanced', triggerButton: 'ZR', triggerCompMs: 40, rumble: true, aimAssist: false, autoPull: false, autoCenter: true,
    crosshairColor: 'white', difficulty: 'normal', stage: 'hills', volume: 0.8, reduceFlash: false, reduceMotion: false, flipX: false,
  });
  assert.deepEqual(SETTINGS_SPEC.sensitivity, { min: 0.5, max: 3.0, step: 0.1 });
  assert.deepEqual(SETTINGS_SPEC.triggerCompMs, { min: 0, max: 100, step: 10 });
  assert.deepEqual(SETTINGS_SPEC.volume, { min: 0, max: 1, step: 0.1 });
  assert.deepEqual([...SETTINGS_ENUMS.aimCurve], ['precise', 'balanced', 'fast']);
  assert.deepEqual([...SETTINGS_ENUMS.triggerButton], ['ZR', 'R']);
  assert.deepEqual([...SETTINGS_ENUMS.crosshairColor], ['white', 'yellow', 'green', 'magenta']);
  const s = createStorage({ backend: memoryBackend(), matchMedia: noRm });
  assert.deepEqual({ ...s.getSettings() }, { ...SETTINGS_DEFAULTS });
});

test('reduceMotion defaults to prefers-reduced-motion', () => {
  const s = createStorage({ backend: memoryBackend(), matchMedia: () => ({ matches: true }) });
  assert.equal(s.getSettings().reduceMotion, true);
});

test('numbers snap to their step and clamp to their range; illegal enums and booleans keep the previous value', () => {
  const s = createStorage({ backend: memoryBackend(), matchMedia: noRm });
  assert.equal(s.updateSettings({ sensitivity: 5 }).sensitivity, 3.0);
  assert.equal(s.updateSettings({ sensitivity: 0.1 }).sensitivity, 0.5);
  assert.equal(s.updateSettings({ sensitivity: 1.23 }).sensitivity, 1.2);
  assert.equal(s.updateSettings({ triggerCompMs: 43 }).triggerCompMs, 40);
  assert.equal(s.updateSettings({ triggerCompMs: 999 }).triggerCompMs, 100);
  assert.equal(s.updateSettings({ triggerCompMs: -5 }).triggerCompMs, 0);
  assert.equal(s.updateSettings({ volume: 0.66 }).volume, 0.7);
  assert.equal(s.updateSettings({ volume: Number.NaN }).volume, 0.7);
  assert.equal(s.updateSettings({ aimCurve: 'wild' }).aimCurve, 'balanced');
  assert.equal(s.updateSettings({ aimCurve: 'fast' }).aimCurve, 'fast');
  assert.equal(s.updateSettings({ triggerButton: 'A' }).triggerButton, 'ZR'); // C-02: "A" was dropped
  assert.equal(s.updateSettings({ triggerButton: 'R' }).triggerButton, 'R');
  assert.equal(s.updateSettings({ crosshairColor: 'red' }).crosshairColor, 'white');
  assert.equal(s.updateSettings({ difficulty: 'insane' }).difficulty, 'normal');
  assert.equal(s.updateSettings({ stage: 'moon' }).stage, 'hills');
  assert.equal(s.updateSettings({ stage: 'alpine' }).stage, 'alpine');
  assert.equal(s.updateSettings({ rumble: 'yes' }).rumble, true);
  assert.equal(s.updateSettings({ rumble: false }).rumble, false);
  assert.equal('bogus' in s.updateSettings({ bogus: 1 }), false);
  assert.ok(Object.isFrozen(s.getSettings()));
});

test('sanitizeSettings turns any input into a complete legal object', () => {
  for (const raw of [null, 5, 'x', [], { sensitivity: '2' }, { volume: Infinity }]) {
    const out = sanitizeSettings(raw);
    assert.deepEqual(Object.keys(out).sort(), Object.keys(SETTINGS_DEFAULTS).sort());
  }
});

test('the document persists under the key and loads back; corrupted JSON starts fresh', () => {
  const be = memoryBackend();
  const a = createStorage({ backend: be, matchMedia: noRm });
  a.updateSettings({ volume: 0.3, aimCurve: 'precise' });
  a.setSafetyAck();
  a.addPlayMs(1234);
  const doc = JSON.parse(be.map.get('clayRush.v1'));
  assert.equal(doc.v, 1);
  assert.deepEqual(Object.keys(doc).sort(), ['best', 'playMsTotal', 'safetyAck', 'settings', 'v']);
  const b = createStorage({ backend: be, matchMedia: noRm });
  assert.equal(b.getSettings().volume, 0.3);
  assert.equal(b.getSettings().aimCurve, 'precise');
  assert.equal(b.getSafetyAck(), true);
  assert.equal(b.getPlayMsTotal(), 1234);
  const c = createStorage({ backend: memoryBackend({ 'clayRush.v1': '{oops' }), matchMedia: noRm });
  assert.equal(c.getSettings().volume, 0.8);
  // the fruit game's key is ignored
  const d = createStorage({ backend: memoryBackend({ 'joyconNinja.v1': JSON.stringify({ v: 2, safetyAck: true }) }), matchMedia: noRm });
  assert.equal(d.getSafetyAck(), false);
});

test('a blocked storage never throws and reports not persistent', () => {
  const s = createStorage({ backend: throwingBackend(), matchMedia: noRm });
  assert.equal(s.isPersistent(), false);
  s.updateSettings({ volume: 0.2 });
  assert.equal(s.getSettings().volume, 0.2);
  assert.equal(s.recordResult(roundResult()).isNewBest, true);
  const n = createStorage({ backend: null, matchMedia: noRm });
  assert.equal(n.isPersistent(), false);
});

test('overrides apply on top and are never persisted', () => {
  const be = memoryBackend();
  const s = createStorage({ backend: be, matchMedia: noRm, overrides: { reduceMotion: true } });
  assert.equal(s.getSettings().reduceMotion, true);
  s.updateSettings({ volume: 0.5 });
  assert.equal(JSON.parse(be.map.get('clayRush.v1')).settings.reduceMotion, false);
});

test('best scores: per mode and difficulty (Time Attack also per stage), new best only when higher, Zen and practice never', () => {
  const s = createStorage({ backend: memoryBackend(), matchMedia: noRm, now: () => '2026-10-01T00:00:00Z' });
  let r = s.recordResult(roundResult({ score: 1000 }));
  assert.equal(r.isNewBest, true);
  assert.equal(s.getBest('classic', 'normal').score, 1000);
  assert.equal(s.getBest('classic', 'hard'), null);
  r = s.recordResult(roundResult({ score: 900 }));
  assert.equal(r.isNewBest, false);
  assert.equal(r.best.score, 1000);
  r = s.recordResult(roundResult({ score: 1500, rank: 'S' }));
  assert.equal(r.isNewBest, true);
  assert.equal(r.previous.score, 1000);
  assert.equal(s.getBest('classic', 'normal').rank, 'S');
  r = s.recordResult(roundResult({ mode: 'timeattack', stageId: 'alpine', score: 300 }));
  assert.equal(r.isNewBest, true);
  assert.equal(s.getBest('timeattack', 'normal', 'alpine').score, 300);
  assert.equal(s.getBest('timeattack', 'normal', 'hills'), null);
  assert.equal(s.recordResult(roundResult({ mode: 'zen', stageId: 'hills', rank: null })).isNewBest, false);
  assert.equal(s.recordResult(roundResult({ mode: 'practice', rank: null })).isNewBest, false);
  assert.equal(s.recordResult(roundResult({ score: 0, difficulty: 'easy' })).isNewBest, false);
  s.resetBest();
  assert.equal(s.getBest('classic', 'normal'), null);
});

test('best scores survive a reload and junk entries are dropped', () => {
  const be = memoryBackend();
  createStorage({ backend: be, matchMedia: noRm }).recordResult(roundResult({ score: 777 }));
  const doc = JSON.parse(be.map.get('clayRush.v1'));
  doc.best['classic.weird'] = { score: 5 };
  doc.best['classic.easy'] = { score: 'x' };
  be.map.set('clayRush.v1', JSON.stringify(doc));
  const s = createStorage({ backend: be, matchMedia: noRm });
  assert.equal(s.getBest('classic', 'normal').score, 777);
  assert.deepEqual(Object.keys(s.getAllBest()), ['classic.normal']);
});

test('injected game/ helpers are used for keys and records (local fallback for missing ones)', () => {
  const calls = [];
  const helpers = {
    bestKey: (m, d, st) => { calls.push('key'); return `${m}|${d}|${st ?? '-'}`; },
    isNewBest: (best, r) => { calls.push('isNew'); return !best[`${r.mode}|${r.difficulty}|${r.stageId ?? '-'}`]; },
    updateBest: (best, r) => { calls.push('update'); return { ...best, [`${r.mode}|${r.difficulty}|${r.stageId ?? '-'}`]: { score: r.score } }; },
  };
  const s = createStorage({ backend: memoryBackend(), matchMedia: noRm, bestHelpers: helpers });
  assert.equal(s.recordResult(roundResult({ score: 10 })).isNewBest, true);
  assert.equal(s.getBest('classic', 'normal').score, 10);
  assert.ok(calls.includes('key') && calls.includes('isNew') && calls.includes('update'));
  assert.equal(typeof LOCAL_BEST_HELPERS.sanitizeBest, 'function');
});

test('with the real game/ helpers injected (what app.js does) the storage keeps the same keys and records', async () => {
  const game = await import('../../public/js/game/index.js');
  const s = createStorage({ backend: memoryBackend(), matchMedia: noRm, bestHelpers: game });
  assert.equal(s.recordResult(roundResult({ score: 2000, rank: 'A' })).isNewBest, true);
  assert.equal(s.getBest('classic', 'normal').score, 2000);
  assert.equal(s.recordResult(roundResult({ mode: 'timeattack', stageId: 'meadow', score: 300 })).isNewBest, true);
  assert.equal(s.getBest('timeattack', 'normal', 'meadow').score, 300);
  assert.equal(s.recordResult(roundResult({ mode: 'zen', stageId: 'hills', rank: null })).isNewBest, false);
  assert.equal(s.getBest('zen', 'normal', 'hills'), null);
  assert.deepEqual(Object.keys(s.getAllBest()).sort(), Object.keys(LOCAL_BEST_HELPERS.updateBest(LOCAL_BEST_HELPERS.updateBest({}, roundResult({ score: 2000 })), roundResult({ mode: 'timeattack', stageId: 'meadow', score: 300 }))).sort());
});
