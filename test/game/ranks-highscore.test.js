import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CONFIG, rankFor, emptyBest, sanitizeBest, isNewBest, updateBest, bestKey, accuracyPercent, formatDuration,
} from '../../public/js/game/index.js';

const result = (over = {}) => ({
  mode: 'classic', difficulty: 'normal', stageId: null, score: 1000, presented: 36, broken: 30, lost: 6, shots: 50, hits: 30,
  accuracy: 0.6, bestStreak: 9, doubles: 2, centre: 4, durationS: 180, endReason: 'complete', rank: 'B', assist: false, ...over,
});

test('ranks: Classic by percent broken (S 95, A 85, B 70, C 50), Time Attack by score (175k/85k/33k/17k), else null', () => {
  const pct = (broken) => rankFor(result({ broken, presented: 100 }));
  assert.deepEqual([pct(100), pct(95), pct(94), pct(85), pct(84), pct(70), pct(69), pct(50), pct(49), pct(0)],
    ['S', 'S', 'A', 'A', 'B', 'B', 'C', 'C', 'D', 'D']);
  assert.equal(rankFor(result({ presented: 0, broken: 0 })), 'D');
  const ta = (score) => rankFor(result({ mode: 'timeattack', score }));
  assert.deepEqual([ta(175000), ta(174999), ta(85000), ta(33000), ta(17000), ta(16999), ta(0)], ['S', 'A', 'A', 'B', 'C', 'D', 'D']);
  assert.equal(rankFor(result({ mode: 'zen' })), null);
  assert.equal(rankFor(result({ mode: 'practice' })), null);
  assert.equal(rankFor(null), null);
});

test('bestKey: classic.<difficulty>, timeattack.<difficulty>.<stage>; zen and practice keep no best', () => {
  assert.equal(bestKey('classic', 'hard', 'alpine'), 'classic.hard');
  assert.equal(bestKey('timeattack', 'easy', 'hills'), 'timeattack.easy.hills');
  assert.equal(bestKey('timeattack', 'easy', null), null);
  assert.equal(bestKey('zen', 'normal', 'hills'), null);
  assert.equal(bestKey('practice', 'normal', 'hills'), null);
  assert.equal(bestKey('classic', 'insane'), null);
  assert.equal(CONFIG.storage.key, 'clayRush.v1');
});

test('best table: empty, update, new-best rule, assist marked, input never mutated', () => {
  const t0 = emptyBest();
  assert.deepEqual(t0, {});
  const r1 = result({ score: 5000, rank: 'A' });
  assert.equal(isNewBest(t0, r1), true);
  const t1 = updateBest(t0, r1);
  assert.deepEqual(t0, {}, 'not mutated');
  assert.deepEqual(t1['classic.normal'], { score: 5000, rank: 'A', broken: 30, presented: 36, accuracy: 0.6, bestStreak: 9, assist: false });
  assert.equal(isNewBest(t1, result({ score: 5000 })), false, 'a tie is not a record');
  assert.equal(isNewBest(t1, result({ score: 4000 })), false);
  assert.deepEqual(updateBest(t1, result({ score: 4000 })), t1);
  const t2 = updateBest(t1, result({ score: 6000, assist: true }));
  assert.equal(t2['classic.normal'].score, 6000);
  assert.equal(t2['classic.normal'].assist, true);
  assert.equal(isNewBest(t2, result({ score: 1, difficulty: 'hard' })), true, 'per difficulty');
  assert.equal(isNewBest(t2, result({ score: 0, difficulty: 'hard' })), false, 'zero is never a record');
  assert.equal(isNewBest(t2, result({ mode: 'zen', score: 99999 })), false);
  const ta = updateBest(t2, result({ mode: 'timeattack', stageId: 'alpine', score: 7000 }));
  assert.ok(ta['timeattack.normal.alpine']);
});

test('sanitizeBest: untrusted JSON is cleaned, never throws', () => {
  for (const raw of [null, undefined, 42, 'x', [], { 'classic.normal': 'oops' }]) assert.deepEqual(sanitizeBest(raw), {});
  const s = sanitizeBest({
    'classic.normal': { score: 12.7, rank: 'Z', broken: -3, accuracy: 7, bestStreak: 'a', assist: 'yes' },
    'zen.hills': { score: 5 },
    junk: { score: 1 },
  });
  assert.deepEqual(s, { 'classic.normal': { score: 12, rank: null, broken: 0, presented: 0, accuracy: 1, bestStreak: 0, assist: false } });
});

test('accuracyPercent and formatDuration', () => {
  assert.equal(accuracyPercent(result({ accuracy: 0.666 })), 67);
  assert.equal(accuracyPercent(result({ accuracy: null })), null);
  assert.equal(accuracyPercent(0.5), 50);
  assert.equal(formatDuration(0), '0:00');
  assert.equal(formatDuration(65.9), '1:05');
  assert.equal(formatDuration(600), '10:00');
  assert.equal(formatDuration(NaN), '0:00');
});
