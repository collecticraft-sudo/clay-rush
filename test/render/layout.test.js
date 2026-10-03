// Layout maths: dpr-aware full-window scaling with 16:9 letterboxing (docs/game-design.md 2.1).
import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_BACKING_SCALE, applyLayoutToCanvas, backingScaleFor, computeLayout, letterboxBars, pointerToPlayfield, readCssSize } from '../../public/js/render/layout.js';
import { clientToPlayfield, playfieldToClient } from '../../public/js/shared/playfield.js';

test('backing scale is min(devicePixelRatio, 2) and 1.0 at degrade level 3', () => {
  assert.equal(backingScaleFor(1), 1);
  assert.equal(backingScaleFor(1.5), 1.5);
  assert.equal(backingScaleFor(2), 2);
  assert.equal(backingScaleFor(3), MAX_BACKING_SCALE);
  assert.equal(backingScaleFor(2, 3), 1);
  assert.equal(backingScaleFor(2, 2), 2);
  assert.equal(backingScaleFor(undefined), 1);
  assert.equal(backingScaleFor(0), 1);
  assert.equal(backingScaleFor(NaN), 1);
});

test('1920x1080 window: no letterbox, k = backing scale', () => {
  const l = computeLayout({ cssW: 1920, cssH: 1080, dpr: 1 });
  assert.equal(l.pixelW, 1920);
  assert.equal(l.pixelH, 1080);
  assert.equal(l.k, 1);
  assert.equal(l.tx, 0);
  assert.equal(l.ty, 0);
  assert.deepEqual(letterboxBars(l), []);
});

test('retina 1440x900 window (dpr 2): letterboxed top and bottom, device pixel size doubles', () => {
  const l = computeLayout({ cssW: 1440, cssH: 900, dpr: 2 });
  assert.equal(l.pixelW, 2880);
  assert.equal(l.pixelH, 1800);
  const scale = 1440 / 1920; // width-limited
  assert.ok(Math.abs(l.fit.scale - scale) < 1e-9);
  assert.ok(Math.abs(l.k - scale * 2) < 1e-9);
  assert.equal(l.tx, 0);
  assert.ok(Math.abs(l.ty - ((900 - 1080 * scale) / 2) * 2) < 1e-6);
  const bars = letterboxBars(l);
  assert.equal(bars.length, 2);
  assert.ok(bars.every((b) => b.w === 2880 && b.h > 0));
  // bars + playfield cover the whole canvas exactly
  const covered = bars.reduce((s, b) => s + b.h, 0) + Math.round(1080 * l.k);
  assert.ok(Math.abs(covered - 1800) <= 2);
});

test('ultrawide window is pillarboxed left and right', () => {
  const l = computeLayout({ cssW: 2560, cssH: 1080, dpr: 1 });
  assert.equal(l.k, 1);
  assert.equal(l.tx, 320);
  const bars = letterboxBars(l);
  assert.equal(bars.length, 2);
  assert.deepEqual(bars.map((b) => [b.x, b.w]), [[0, 320], [2240, 320]]);
});

test('dpr 3 is clamped to a backing scale of 2', () => {
  const l = computeLayout({ cssW: 1000, cssH: 600, dpr: 3 });
  assert.equal(l.backingScale, 2);
  assert.equal(l.pixelW, 2000);
});

test('degenerate sizes never produce zero or NaN', () => {
  const l = computeLayout({ cssW: 0, cssH: NaN, dpr: 2 });
  assert.ok(l.pixelW >= 1 && l.pixelH >= 1);
  assert.ok(Number.isFinite(l.k) && l.k > 0);
});

test('pointerToPlayfield is the inverse of playfieldToClient and honours the letterbox', () => {
  const rect = { left: 10, top: 20, width: 1600, height: 1000 };
  const p = pointerToPlayfield(rect, 10 + 800, 20 + 500);
  assert.ok(Math.abs(p.x - 960) < 1e-6 && Math.abs(p.y - 540) < 1e-6);
  const c = playfieldToClient(rect, 100, 200);
  const back = clientToPlayfield(rect, c.x, c.y);
  assert.ok(Math.abs(back.x - 100) < 1e-6 && Math.abs(back.y - 200) < 1e-6);
  // a click inside the top letterbox bar maps to y < 0 (never activates a target)
  assert.ok(pointerToPlayfield(rect, 810, 22).y < 0);
});

test('applyLayoutToCanvas resizes only when needed (resizing clears the canvas)', () => {
  const canvas = { width: 300, height: 150 };
  const l = computeLayout({ cssW: 1000, cssH: 500, dpr: 1 });
  assert.equal(applyLayoutToCanvas(canvas, l), true);
  assert.equal(canvas.width, 1000);
  assert.equal(applyLayoutToCanvas(canvas, l), false);
});

test('readCssSize reads the canvas rect, then clientWidth / clientHeight', () => {
  assert.deepEqual(readCssSize({ getBoundingClientRect: () => ({ width: 640, height: 360 }) }, null), { cssW: 640, cssH: 360 });
  assert.deepEqual(readCssSize({ clientWidth: 100, clientHeight: 50 }, null), { cssW: 100, cssH: 50 });
});
