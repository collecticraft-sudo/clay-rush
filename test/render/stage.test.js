// Stage backdrops (render/stage.js): two layers per stage, the procedural twin until the art is ready (and for good without it), a 400 ms
// crossfade between visuals (a cut with Reduce motion), residency and release, parallax offsets, the horizon on WORLD.horizonY.
import test from 'node:test';
import assert from 'node:assert/strict';
import { STAGE_IDS, STAGE_LAYERS, createStage, farRect, layerAssetId, nearRect, stageGroup, zoomRect } from '../../public/js/render/stage.js';
import { ART_CONFIG } from '../../public/js/render/art-config.js';
import { NULL_ASSETS } from '../../public/js/render/assets.js';
import { WORLD } from '../../public/js/shared/world.js';
import { RecordingContext, makeStageRig, screenRect } from '../../test-support/stage/recorder.js';

const isProc = (op) => op.img && op.img.isRecordingCanvas;
const isArt = (op, id) => op.img && op.img.isStub && (id === undefined || op.img.id === id);

test('ids, layers and names: meadow, hills, alpine; far and near; stage:<id> groups and bg_<id>_<layer> ids', () => {
  assert.deepEqual(STAGE_IDS, ['meadow', 'hills', 'alpine']);
  assert.deepEqual(STAGE_LAYERS, ['far', 'near']);
  assert.equal(stageGroup('hills'), 'stage:hills');
  assert.equal(layerAssetId('alpine', 'near'), 'bg_alpine_near');
});

test('farRect puts the horizon of the picture (62 percent) on WORLD.horizonY and overscans both sides; nearRect is centred and covers the field', () => {
  const r = farRect(2560 / 1440, 44, 0.62, {});
  assert.equal(r.x, -44);
  assert.equal(r.w, 1920 + 88);
  assert.ok(Math.abs(r.y + 0.62 * r.h - WORLD.horizonY) < 1e-9);
  assert.ok(r.y <= 0 && r.y + r.h >= 1080, 'covers the field');
  const n = nearRect(16 / 9, 48, {});
  assert.equal(n.x, -48);
  assert.ok(n.y <= 0 && n.y + n.h >= 1080);
  assert.ok(Math.abs(n.y + n.h / 2 - 540) < 1e-9);
});

test('without art (NULL_ASSETS) the stage draws its procedural twin, painted once per stage and layer, never loads anything', () => {
  const ctx = new RecordingContext();
  const made = [];
  const stage = createStage({ assets: NULL_ASSETS, createCanvas: (w, h) => { const c = { width: w, height: h, isRecordingCanvas: true, ctx: new RecordingContext(), getContext() { return this.ctx; } }; made.push(c); return c; } });
  stage.setStage('meadow');
  for (let i = 0; i < 10; i++) {
    ctx.reset();
    assert.equal(stage.draw(ctx, 'far', { nowMs: i * 16 }), true);
    assert.equal(stage.draw(ctx, 'near', { nowMs: i * 16 }), true);
    assert.equal(ctx.images().length, 2);
  }
  assert.equal(made.length, 2, 'one canvas per layer, painted once');
  assert.ok(made.every((c) => c.ctx.pathOps > 50), 'the procedural painters drew into them');
  const st = stage.status();
  assert.equal(st.active, false);
  assert.equal(st.art, false);
  assert.deepEqual(st.layers, { far: false, near: false });
});

test('procedural first, then a 400 ms crossfade to the art when the group is ready; the art far layer lands on the horizon', async () => {
  const rig = makeStageRig({ assets: { auto: false } });
  let f = rig.frame({ stage: 'hills', nowMs: 0 });
  assert.equal(rig.assets.log.loads[0].group, 'stage:hills');
  assert.ok(f.far.every(isProc) && f.far.length === 1, 'procedural far while loading');
  rig.assets.settle('stage:hills');
  await rig.flush();
  f = rig.frame({ nowMs: 100 });
  assert.equal(rig.stage.status().fading, true);
  assert.ok(f.far.every(isProc), 'the fade starts at 0: the art is not drawn yet');
  f = rig.frame({ nowMs: 300 });
  assert.ok(f.far.some(isProc) && f.far.some((o) => isArt(o, 'bg_hills_far')), 'both during the fade');
  const mid = f.far.find((o) => isArt(o, 'bg_hills_far'));
  assert.ok(Math.abs(mid.alpha - 0.5) < 0.01, `half way: ${mid.alpha}`);
  f = rig.frame({ nowMs: 520 });
  assert.equal(rig.stage.status().fading, false);
  assert.equal(f.far.length, 1);
  assert.ok(isArt(f.far[0], 'bg_hills_far'));
  assert.ok(isArt(f.near[0], 'bg_hills_near'));
  const r = screenRect(f.far[0]);
  assert.ok(Math.abs(r.y + ART_CONFIG.stage.farHorizonFrac * r.h - WORLD.horizonY) < 1e-6, 'horizon on 670');
  assert.deepEqual(rig.stage.status().layers, { far: true, near: true });
});

test('a stage change crossfades art to art and releases the old group afterwards; at most two groups are resident', async () => {
  const rig = makeStageRig({ assets: { auto: true } });
  rig.frame({ stage: 'meadow', nowMs: 0 });
  await rig.flush();
  rig.frame({ nowMs: 1000 });
  rig.frame({ stage: 'hills', nowMs: 2000 });
  await rig.flush();
  rig.frame({ nowMs: 2010 });
  assert.equal(rig.stage.status().fading, true);
  assert.ok(rig.assets.loaded().length <= ART_CONFIG.stage.maxResidentStages);
  rig.frame({ nowMs: 2500 });
  assert.equal(rig.stage.status().fading, false);
  assert.deepEqual(rig.assets.log.releases, ['stage:meadow']);
  rig.frame({ stage: 'alpine', nowMs: 3000 });
  await rig.flush();
  rig.frame({ nowMs: 3001 });
  rig.frame({ nowMs: 3500 });
  assert.deepEqual(rig.assets.log.releases, ['stage:meadow', 'stage:hills']);
  assert.deepEqual(rig.assets.loaded(), ['stage:alpine']);
});

test('Reduce motion: a stage change is a cut, never a crossfade', async () => {
  const rig = makeStageRig({ assets: { auto: true } });
  rig.frame({ stage: 'meadow', nowMs: 0, reduceMotion: true });
  await rig.flush();
  const f = rig.frame({ nowMs: 10, reduceMotion: true });
  assert.equal(rig.stage.status().fading, false);
  assert.equal(f.far.length, 1);
  assert.ok(isArt(f.far[0], 'bg_meadow_far'));
});

test('the parallax offsets of the view move each layer by its own amount', async () => {
  const rig = makeStageRig({ assets: { auto: true } });
  rig.frame({ stage: 'hills', nowMs: 0, reduceMotion: true });
  await rig.flush();
  const a = rig.frame({ nowMs: 10 });
  const b = rig.frame({ nowMs: 20, farX: -5, farY: 2, nearX: -24, nearY: 9 });
  const da = screenRect(b.far[0]).x - screenRect(a.far[0]).x;
  const dn = screenRect(b.near[0]).x - screenRect(a.near[0]).x;
  assert.equal(da, -5);
  assert.equal(dn, -24);
  assert.equal(screenRect(b.near[0]).y - screenRect(a.near[0]).y, 9);
});

test('a failed group keeps the procedural twin for good; a group released by someone else falls back to it at once', async () => {
  const rig = makeStageRig({ assets: { auto: true, failGroups: ['stage:alpine'] } });
  rig.frame({ stage: 'alpine', nowMs: 0 });
  await rig.flush();
  let f = rig.frame({ nowMs: 1000 });
  assert.deepEqual(rig.stage.status().failed, ['alpine']);
  assert.ok(f.far.every(isProc));
  const r2 = makeStageRig({ assets: { auto: true } });
  r2.frame({ stage: 'meadow', nowMs: 0, reduceMotion: true });
  await r2.flush();
  f = r2.frame({ nowMs: 10 });
  assert.ok(isArt(f.far[0]));
  r2.assets.release('stage:meadow');
  f = r2.frame({ nowMs: 20 });
  assert.ok(f.far.every(isProc), 'no blank frame');
  assert.equal(r2.stage.status().art, false);
});

test('a drawable that throws drops the art of that stage and the frame still draws the procedural twin next time', async () => {
  const rig = makeStageRig({ assets: { auto: true } });
  rig.frame({ stage: 'hills', nowMs: 0, reduceMotion: true });
  await rig.flush();
  rig.ctx.throwOnDrawImage = (img) => img && img.isStub;
  assert.doesNotThrow(() => rig.frame({ nowMs: 10 }));
  rig.ctx.throwOnDrawImage = null;
  const f = rig.frame({ nowMs: 20 });
  assert.ok(f.far.every(isProc));
});

test('dispose releases what is resident and unsubscribes', async () => {
  const rig = makeStageRig({ assets: { auto: true } });
  rig.frame({ stage: 'meadow', nowMs: 0 });
  await rig.flush();
  assert.equal(rig.assets.listenerCount('group'), 1);
  rig.stage.dispose();
  assert.equal(rig.assets.listenerCount('group'), 0);
  assert.ok(rig.assets.log.releases.includes('stage:meadow'));
  assert.equal(rig.stage.draw(rig.ctx, 'far', { nowMs: 1 }), false);
});

test('zoomRect scales about the horizon point and never zooms out past what still covers the field (with the margin)', () => {
  const base = () => farRect(16 / 9, 44, 0.62, {}, 1.12);
  const a = base();
  assert.equal(zoomRect(a, 1.25, 14), 1.25);
  assert.ok(Math.abs(a.y + 0.62 * a.h - WORLD.horizonY) < 1e-6, 'horizon kept');
  const b = base();
  const z = zoomRect(b, 0.5, 14);
  assert.ok(z > 0.5 && z < 1, `clamped to ${z}`);
  assert.ok(b.x <= -14 + 1e-6 && b.y <= -14 + 1e-6 && b.x + b.w >= 1934 - 1e-6 && b.y + b.h >= 1094 - 1e-6, 'covers with the margin');
  assert.ok(Math.abs(b.y + 0.62 * b.h - WORLD.horizonY) < 1e-6);
});

test('a stage change keeps the painted backdrop on screen until the new art is decoded, then crossfades: no flat procedural flash (QA F4)', async () => {
  const rig = makeStageRig({ assets: { auto: false } });
  rig.frame({ stage: 'meadow', nowMs: 0 });
  rig.assets.settle('stage:meadow');
  await rig.flush();
  rig.frame({ nowMs: 10, reduceMotion: false });
  rig.frame({ nowMs: 1000 });
  let f = rig.frame({ stage: 'hills', nowMs: 2000 });
  assert.ok(f.far.every((o) => isArt(o, 'bg_meadow_far')), 'still the meadow painting while hills loads');
  f = rig.frame({ nowMs: 2300 });
  assert.ok(f.far.every((o) => isArt(o, 'bg_meadow_far')));
  rig.assets.settle('stage:hills');
  await rig.flush();
  rig.frame({ nowMs: 2400 });
  f = rig.frame({ nowMs: 2600 });
  assert.ok(f.far.some((o) => isArt(o, 'bg_meadow_far')) && f.far.some((o) => isArt(o, 'bg_hills_far')), 'painting to painting');
  assert.ok(!f.far.some(isProc));
  // a load that never arrives: after waitArtMs the procedural twin of the wanted stage shows
  rig.frame({ nowMs: 3500 });
  f = rig.frame({ stage: 'alpine', nowMs: 4000 });
  assert.ok(f.far.every((o) => isArt(o)));
  rig.frame({ nowMs: 4000 + ART_CONFIG.stage.waitArtMs + 10 });
  f = rig.frame({ nowMs: 4000 + ART_CONFIG.stage.waitArtMs + 600 });
  assert.ok(f.far.some(isProc), 'the procedural alpine after the wait');
});

test('prefetch loads the next stage ahead and keeps it resident, so the change finds it ready (QA F4)', async () => {
  const rig = makeStageRig({ assets: { auto: true } });
  rig.frame({ stage: 'meadow', nowMs: 0 });
  await rig.flush();
  rig.frame({ nowMs: 600 });
  rig.stage.prefetch('hills');
  await rig.flush();
  assert.deepEqual(rig.stage.status().resident.sort(), ['hills', 'meadow']);
  const f = rig.frame({ stage: 'hills', nowMs: 1000 });
  assert.equal(rig.stage.status().fading, true, 'an immediate crossfade');
  void f;
});
