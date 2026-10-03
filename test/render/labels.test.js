// The label stack (render/label-layout.js): points popups and SMOKED! never overlap, stay in the field and out of the banner strip (QA F5, F13).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createLabelStack, hitLabelSpec } from '../../public/js/render/label-layout.js';
import { ART_CONFIG } from '../../public/js/render/art-config.js';

const spec = (x, y, centre = false) => hitLabelSpec({ x, y, rPx: 10, points: 175, centre, kind: 'standard' });

test('a block that would sit on a live one moves above it (or below near the top); an expired one frees the place', () => {
  const s = createLabelStack();
  const a = { ...s.place(spec(1650, 700, true), 0) };
  const b = { ...s.place(spec(1660, 710, true), 10) };
  assert.ok(b.y < a.y - s.lineH(true), `${b.y} above ${a.y}`);
  // near the banner strip the second block goes below instead of into the strip
  const z = createLabelStack();
  const z1 = { ...z.place(spec(1200, 600, true), 0) };
  const z2 = { ...z.place(spec(1210, 610, true), 1) };
  assert.ok(z2.y > z1.y + z.lineH(true), `${z2.y} below ${z1.y}`);
  const c = { ...s.place(spec(1650, 700, true), 5000) };
  assert.equal(c.y, a.y, 'the old ones expired');
  // near the top there is no room above: it goes below
  const t = createLabelStack();
  const t1 = { ...t.place(spec(300, 260), 0) };
  const t2 = { ...t.place(spec(300, 260), 1) };
  assert.ok(t2.y > t1.y, 'below');
});

test('inside the field horizontally, never in the banner strip, nothing without points', () => {
  const s = createLabelStack();
  const L = ART_CONFIG.fx.labels;
  assert.equal(s.place(spec(5, 600), 0).x, L.w / 2 + L.edge);
  assert.equal(s.place(spec(1919, 700), 0).x, 1920 - L.w / 2 - L.edge);
  const BZ = ART_CONFIG.fx.popupBannerZone;
  const p = s.place(spec(960, 260, true), 0);
  assert.ok(p.y - s.lineH(true) - ART_CONFIG.fx.popupRisePx - L.smokedH >= BZ.bottom - 1e-6, 'below the banner strip');
  assert.equal(hitLabelSpec({ x: 1, y: 1, points: 0 }), null);
});
