import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG, STAGES } from '../../public/js/game/index.js';
import { HOUSE_ID, TARGET_KIND, STAGE_ID } from '../../public/js/shared/contracts.js';

const GAME_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'public', 'js', 'game');

test('CONFIG is deep-frozen and holds the design numbers', () => {
  assert.ok(Object.isFrozen(CONFIG) && Object.isFrozen(CONFIG.houses.trap) && Object.isFrozen(CONFIG.stages[0].wind));
  assert.equal(CONFIG.time.dt, 1 / 120);
  assert.equal(CONFIG.physics.drag, 0.012);
  assert.deepEqual([CONFIG.shot.r0, CONFIG.shot.spread, CONFIG.shot.centreFrac, CONFIG.shot.pelletSpeed], [0.1, 0.018, 0.35, 750]);
  assert.deepEqual(Object.keys(CONFIG.targets).sort(), Object.values(TARGET_KIND).sort());
  assert.deepEqual(Object.keys(CONFIG.houses).sort(), Object.values(HOUSE_ID).sort());
  assert.deepEqual(CONFIG.streak.steps, [0, 3, 6, 10]);
  assert.equal(CONFIG.timeattack.durationS, 90);
  assert.equal(CONFIG.timeattack.maxS, 120);
  assert.equal(CONFIG.timeattack.roundCapS, 180);
  assert.deepEqual(['easy', 'normal', 'hard'].map((d) => CONFIG.difficulty[d].distanceMul), [0.55, 1, 1.45]);
  assert.deepEqual(['easy', 'normal', 'hard'].map((d) => CONFIG.difficulty[d].speedMul), [0.9, 1, 1]);
  assert.deepEqual(['easy', 'normal', 'hard'].map((d) => CONFIG.difficulty[d].patternMul), [1.15, 1, 1.1]);
  assert.deepEqual(['easy', 'normal', 'hard'].map((d) => CONFIG.difficulty[d].windMul), [0.5, 1, 1.2]);
  assert.equal(CONFIG.zen.distanceMul, CONFIG.difficulty.easy.distanceMul);
  // no house comes inside zNear at the closest world scale
  for (const h of Object.values(CONFIG.houses)) assert.ok(h.z * CONFIG.difficulty.easy.distanceMul > 1.5 * 4, 'zNear with margin');
  assert.equal(CONFIG.juice.hitStopMs, 40);
  assert.equal(CONFIG.storage.key, 'clayRush.v1');
});

test('STAGES: three stages in order with pulls, targets (36 in all), wind and houses', () => {
  assert.deepEqual(STAGES.map((s) => s.id), Object.values(STAGE_ID));
  assert.deepEqual(STAGES.map((s) => s.pulls), [10, 8, 8]);
  assert.equal(STAGES.reduce((n, s) => n + s.targets, 0), 36);
  assert.deepEqual(STAGES.map((s) => s.name), ['Morning Meadow', 'Golden Hills', 'Alpine Dusk']);
  assert.deepEqual(STAGES.map((s) => s.wind.speed), [0, 1.5, 2.5]);
  assert.equal(STAGES[2].wind.gustAmp, 1);
  assert.ok(Object.isFrozen(STAGES[0]));
  for (const s of STAGES) for (const h of s.houses) assert.ok(CONFIG.houses[h]);
});

test('the projection constants are not duplicated in game/ (they come from shared/world.js)', () => {
  for (const f of readdirSync(GAME_DIR)) {
    const code = readFileSync(join(GAME_DIR, f), 'utf8').replace(/\/\/.*$/gm, '');
    assert.doesNotMatch(code, /\b1663\b|\b9\.81\b|\bhorizonY\s*:/, f);
  }
});

test('game/ is pure: no DOM, timers, wall clock or Math.random', () => {
  for (const f of readdirSync(GAME_DIR)) {
    const code = readFileSync(join(GAME_DIR, f), 'utf8').replace(/\/\/.*$/gm, '');
    assert.doesNotMatch(code, /Math\.random|Date\.now|performance\.now|setTimeout|setInterval|\bwindow\b|\bdocument\b|localStorage/, f);
  }
});
