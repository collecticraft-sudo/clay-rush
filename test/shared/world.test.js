import test from 'node:test';
import assert from 'node:assert/strict';
import { WORLD, project, unproject, groundDepthAt } from '../../public/js/shared/world.js';

test('the camera height projects to the horizon and the axis to the centre', () => {
  const p = project(0, WORLD.camY, 30);
  assert.equal(p.sx, 960);
  assert.equal(p.sy, WORLD.horizonY);
  assert.equal(p.visible, true);
  assert.ok(Math.abs(p.s - WORLD.F / 30) < 1e-9);
});

test('project and unproject are inverse at a known depth', () => {
  for (const [x, y, z] of [[-10, 4, 25], [7, 0.2, 12], [0, 15, 60]]) {
    const p = project(x, y, z);
    const w = unproject(p.sx, p.sy, z);
    assert.ok(Math.abs(w.x - x) < 1e-9 && Math.abs(w.y - y) < 1e-9);
  }
});

test('points in front of zNear are not visible and the out object is reused', () => {
  const out = { sx: 0, sy: 0, s: 0, visible: true };
  assert.equal(project(0, 2, 1, out), out);
  assert.equal(out.visible, false);
  assert.equal(project(0, 2, 10, out).visible, true);
});

test('a 60 degree field of view spans the playfield width', () => {
  const half = Math.tan((30 * Math.PI) / 180) * 50; // x at the left/right edge at 50 m
  assert.ok(Math.abs(project(half, WORLD.camY, 50).sx - 1920) < 2);
  assert.ok(Math.abs(project(-half, WORLD.camY, 50).sx) < 2);
});

test('groundDepthAt inverts the ground projection', () => {
  const p = project(0, 0, 14);
  assert.ok(Math.abs(groundDepthAt(p.sy) - 14) < 1e-9);
  assert.equal(groundDepthAt(WORLD.horizonY - 10), Infinity);
});
