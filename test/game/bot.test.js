import test from 'node:test';
import assert from 'node:assert/strict';
import { assertValid } from '../../public/js/shared/validate.js';
import { playRound } from '../../test-support/game/helpers.js';

test('BOT: a scripted bot aiming at projected targets plays a whole Classic round on Normal and breaks most targets', () => {
  for (const seed of [1, 2024]) {
    const h = playRound('classic', seed, { difficulty: 'normal' }, { validate: true, bot: { offsetPx: 6 } });
    const s = h.snap();
    assert.equal(s.phase, 'over');
    assert.equal(h.game.isOver(), true);
    const r = assertValid('RoundResult', h.game.getResult());
    assert.equal(r.endReason, 'complete');
    assert.equal(r.presented, 36, '10 + 12 + 14 targets');
    assert.equal(r.broken + r.lost, r.presented);
    assert.ok(r.broken >= 0.9 * r.presented, `broke ${r.broken} of ${r.presented}`);
    assert.ok(r.score > 0);
    assert.equal(r.stageId, null);
    assert.ok(['S', 'A'].includes(r.rank));
    assert.ok(r.accuracy > 0.8 && r.accuracy <= 1);
    // the three stages were played in order, with a stage card between them
    assert.deepEqual(h.ofType('stageStart').map((e) => e.id), ['meadow', 'hills', 'alpine']);
    assert.equal(h.ofType('stageClear').length, 3);
    assert.equal(h.events.filter((e) => e.type === 'phase' && e.phase === 'stageCard').length, 2);
    assert.equal(h.ofType('pull').length, 26, '10 + 8 + 8 pulls');
    assert.ok(h.ofType('double').length >= 5, 'doubles broken');
  }
});

test('BOT: Easy shows the same throws closer (bigger clays, bigger pattern on screen); the bot breaks nearly all of them', () => {
  const easy = playRound('classic', 7, { difficulty: 'easy' }, { validate: true });
  const r = easy.game.getResult();
  assert.ok(r.broken >= 0.9 * r.presented, `easy: ${r.broken}`);
  const firstR = (difficulty) => {
    const h = playRound('classic', 7, { difficulty }, { maxS: 0 });
    h.step(1 / 60, (now) => [{ t: now, x: 960, y: 540, source: 'sim', compMs: 0 }]);
    h.until((s) => s.targets.length > 0, 2);
    return h.snap().targets[0];
  };
  const e = firstR('easy');
  const n = firstR('normal');
  const hd = firstR('hard');
  assert.ok(Math.abs(e.rPx / n.rPx - 1 / 0.55) < 0.1, `rPx easy/normal ${e.rPx / n.rPx} (about 1.8)`);
  assert.ok(Math.abs(hd.rPx / n.rPx - 1 / 1.45) < 0.05, `rPx hard/normal ${hd.rPx / n.rPx}`);
  assert.ok(Math.abs(e.z - 0.55 * n.z) < 0.5 && Math.abs(hd.z - 1.45 * n.z) < 0.5, 'same throw, scaled depth');
});

test('BOT: Hard is hard but fair (QA F6): aiming straight at the clay breaks 55 to 75 percent, leading by the pellet time >= 85 percent', () => {
  let straight = 0;
  let lead = 0;
  let presented = 0;
  for (let seed = 1; seed <= 6; seed++) {
    const s = playRound('classic', seed, { difficulty: 'hard' }, { bot: { hard: false, retryS: 99 } }).game.getResult();
    const l = playRound('classic', seed, { difficulty: 'hard' }, { bot: { hard: true, retryS: 99 } }).game.getResult();
    straight += s.broken;
    lead += l.broken;
    presented += s.presented;
  }
  const ps = straight / presented;
  const pl = lead / presented;
  assert.ok(ps >= 0.55 && ps <= 0.75, `straight ${(100 * ps).toFixed(1)} percent`);
  assert.ok(pl >= 0.85, `lead ${(100 * pl).toFixed(1)} percent`);
  // Normal needs no lead at all
  const n = playRound('classic', 1, { difficulty: 'normal' }, { bot: { hard: false, retryS: 99 } }).game.getResult();
  assert.ok(n.broken >= 0.95 * n.presented);
});

test('BOT: Hard needs lead; a bot that leads by the pellet travel time still breaks most targets', () => {
  const h = playRound('classic', 5, { difficulty: 'hard' }, { bot: { hard: true } });
  const r = h.game.getResult();
  assert.ok(r.broken >= 0.8 * r.presented, `broke ${r.broken}`);
  const noLead = playRound('classic', 5, { difficulty: 'hard' }, { bot: { hard: false } }).game.getResult();
  assert.ok(noLead.broken < r.broken, `no lead ${noLead.broken} < lead ${r.broken}`);
});
