import test from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG } from '../../public/js/game/index.js';
import { patternRadiusM, patternRadiusPx, targetRadiusPx, assistAim, testHit, projectCandidates } from '../../public/js/game/shot.js';
import { project } from '../../public/js/shared/world.js';
import { createHarness, shotAt } from '../../test-support/game/helpers.js';

test('pattern radius r(z) = 0.10 + 0.018 z metres (0.46 m at 20 m, 0.82 m at 40 m), about 34 to 38 px', () => {
  assert.ok(Math.abs(patternRadiusM(20) - 0.46) < 1e-12);
  assert.ok(Math.abs(patternRadiusM(40) - 0.82) < 1e-12);
  assert.ok(patternRadiusPx(20) > 34 && patternRadiusPx(40) < 38.5);
  assert.ok(Math.abs(targetRadiusPx(0.3, 20) - (0.15 * 1663) / 20) < 1e-12);
});

test('hit test in screen space: hit within pattern + target radius, centre within 0.35 pattern radius', () => {
  const [c] = projectCandidates([{ id: 1, x: 0, y: 5, z: 20, sizeM: 0.3 }], 1);
  const reach = c.patternPx + c.targetPx;
  assert.equal(testHit({ x: c.sx + reach - 0.01, y: c.sy }, c).hit, true);
  assert.equal(testHit({ x: c.sx + reach + 0.01, y: c.sy }, c).hit, false);
  assert.equal(testHit({ x: c.sx, y: c.sy + 0.35 * c.patternPx - 0.01 }, c).centre, true);
  assert.equal(testHit({ x: c.sx, y: c.sy + 0.35 * c.patternPx + 0.01 }, c).centre, false);
  assert.equal(projectCandidates([{ id: 2, x: 0, y: 1.6, z: 3, sizeM: 0.3 }], 1).length, 0, 'closer than zNear: not hittable');
});

test('assist Light: +15 percent pattern and the aim pulled 25 percent towards a target within 1.6 pattern radii', () => {
  const [c] = projectCandidates([{ id: 1, x: 0, y: 5, z: 20, sizeM: 0.3 }], CONFIG.assist.patternMul);
  const aim = { x: c.sx + 1.5 * c.patternPx, y: c.sy };
  const a = assistAim(aim, [c]);
  assert.equal(a.targetId, 1);
  assert.ok(Math.abs(a.x - (aim.x - 0.25 * 1.5 * c.patternPx)) < 1e-9);
  const far = assistAim({ x: c.sx + 1.7 * c.patternPx, y: c.sy }, [c]);
  assert.equal(far.targetId, null);

  // in the game: a shot just outside the plain reach breaks the clay only with assist, and the result says so
  const base = projectCandidates([{ id: 1, x: 0, y: 5, z: 20, sizeM: CONFIG.targets.standard.sizeM }], 1)[0];
  const offset = base.patternPx + base.targetPx + 4;
  const run = (assist) => {
    const h = createHarness('timeattack', 1, { assist });
    h.game.debugSetAutoLaunch(false);
    h.step(0.05);
    h.game.debugSpawn({ still: true, pos: { x: 0, y: 5, z: 20 } });
    const p = project(0, 5, 20);
    h.step(1 / 60, (now) => [shotAt(p.sx + offset, p.sy, now)]);
    return h;
  };
  assert.equal(run(false).ofType('hit').length, 0);
  const h = run(true);
  assert.equal(h.ofType('hit').length, 1);
  assert.ok(h.ofType('shot')[0].x < base.sx + offset, 'the reported shot point is the assisted one');
  assert.equal(h.snap().assist, true);
  h.game.end('quit');
  assert.equal(h.game.getResult().assist, true);
});
