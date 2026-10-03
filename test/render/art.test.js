// Procedural painters, the sprite provider and the palette: every picture of the manifest has a painted twin with the same geometry, the
// provider uses the art when loaded and the painter otherwise, its cache is bucketed and allocation free on a hit.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PROC_META, paintBackdropFar, paintBackdropNear, paintSprite } from '../../public/js/render/painters.js';
import { createSprites } from '../../public/js/render/sprites.js';
import { COLORS, CROSSHAIR_COLORS, STAGE_PALETTES } from '../../public/js/render/palette.js';
import { ParticlePool, ObjectPool, createPerfGovernor } from '../../public/js/render/fx.js';
import { FakeCanvas, FakeContext, createFakeCanvasFactory } from '../../test-support/render/fake-canvas.js';
import { MANIFEST, createArtStub } from '../../test-support/render/art-stub.js';

test('every manifest picture except the layers and the logo has a procedural twin with the same canvas, anchor, body and muzzle', () => {
  for (const a of MANIFEST.assets) {
    if (a.kind === 'layer' || a.id === 'logo_title') continue;
    const m = PROC_META[a.id];
    assert.ok(m, `${a.id} has a painter`);
    assert.equal(m.width, a.width, `${a.id} width`);
    assert.equal(m.height, a.height, `${a.id} height`);
    if (a.kind === 'house' || a.kind === 'ui') assert.deepEqual(m.anchor, a.anchor, `${a.id} anchor`);
    if (a.body) assert.ok(m.body && Math.abs(m.body.r - a.body.r) / a.body.r < 0.15 && Math.abs(m.body.cx - a.body.cx) < 2, `${a.id} body`);
    if (a.muzzle) assert.deepEqual(m.muzzle, a.muzzle);
  }
});

test('every painter paints (no exception, real drawing) and never uses shadowBlur or filter', () => {
  for (const id of Object.keys(PROC_META)) {
    const ctx = new FakeContext(new FakeCanvas(PROC_META[id].width, PROC_META[id].height));
    assert.equal(paintSprite(ctx, id), true, id);
    assert.ok(ctx.calls.length > 0, `${id} drew something`);
    assert.deepEqual(ctx.forbidden, [], id);
  }
  assert.equal(paintSprite(new FakeContext(new FakeCanvas(1, 1)), 'nope'), false);
  for (const stage of Object.keys(STAGE_PALETTES)) {
    const far = new FakeContext(new FakeCanvas(2008, 1130));
    paintBackdropFar(far, stage, 2008, 1130, 0.62);
    const near = new FakeContext(new FakeCanvas(2016, 1134));
    paintBackdropNear(near, stage, 2016, 1134);
    assert.ok(far.counts.fill > 50 && near.counts.fill > 100, stage);
    assert.deepEqual([...far.forbidden, ...near.forbidden], []);
  }
});

test('the painters are deterministic: the same id paints the same calls', () => {
  for (const id of ['shard_std_3', 'house_tower', 'gun_ou']) {
    const a = new FakeContext(new FakeCanvas(10, 10));
    const b = new FakeContext(new FakeCanvas(10, 10));
    paintSprite(a, id);
    paintSprite(b, id);
    assert.deepEqual(a.calls, b.calls, id);
  }
});

test('sprites: the procedural picture without art, the generated one when loaded; the geometry follows', async () => {
  const factory = createFakeCanvasFactory();
  const assets = createArtStub({ createCanvas: factory.createCanvas });
  const sprites = createSprites({ assets, createCanvas: factory.createCanvas, density: 2 });
  const ctx = new FakeContext(new FakeCanvas(1920, 1080));
  assert.equal(sprites.isArt('clay_std_tilt'), false);
  assert.equal(sprites.meta('clay_std_tilt'), PROC_META.clay_std_tilt);
  assert.equal(sprites.draw(ctx, 'clay_std_tilt', 500, 300, 0.1), true);
  const procCanvas = ctx.calls.at(-1)[1];
  assert.ok(procCanvas.isFakeCanvas);
  await assets.load('core');
  assert.equal(sprites.isArt('clay_std_tilt'), true);
  assert.equal(sprites.meta('clay_std_tilt').body.r, MANIFEST.assets.find((a) => a.id === 'clay_std_tilt').body.r);
  sprites.draw(ctx, 'clay_std_tilt', 500, 300, 0.1);
  assert.notEqual(ctx.calls.at(-1)[1], procCanvas, 'a new picture after the art arrived (generation changed)');
  assert.equal(assets.calls.scaled, 1, 'the art comes through assets.scaled');
  assert.equal(sprites.draw(ctx, 'nope', 0, 0, 1), false);
});

test('sprites: scales are bucketed (a hit makes no canvas), the bucket is the next one up, and bucketScale pins one picture for a growing effect', () => {
  const factory = createFakeCanvasFactory();
  const sprites = createSprites({ createCanvas: factory.createCanvas, density: 1 });
  const ctx = new FakeContext(new FakeCanvas(1920, 1080));
  sprites.draw(ctx, 'fx_smoke_puff', 0, 0, 0.5);
  const n = factory.created.length;
  for (let i = 0; i < 100; i++) sprites.draw(ctx, 'fx_smoke_puff', i, i, 0.5);
  assert.equal(factory.created.length, n, 'cache hits');
  const baked = factory.created.at(-1);
  assert.ok(baked.width >= 256 * 0.5, 'baked at the bucket at or above the scale asked for');
  for (let s = 0.2; s < 1; s += 0.01) sprites.drawIcon(ctx, 'fx_dust_burst', 0, 0, 256 * s, 1, 0, false, 256);
  assert.equal(factory.created.length, n + 1, 'one picture for the whole growth');
  // the destination is the exact scale even when the picture is a bucket larger
  sprites.draw(ctx, 'fx_smoke_puff', 100, 100, 0.47);
  const call = ctx.calls.at(-1);
  assert.ok(Math.abs(call[4] - 256 * 0.47) < 1e-6);
});

test('palette: the design tokens, the crosshair colours, legacy names alias the new tokens', () => {
  assert.equal(COLORS.cream, '#FFF4DC');
  assert.equal(COLORS.slate, '#1B1F24');
  assert.equal(COLORS.orange, '#F26B1D');
  assert.equal(COLORS.gold, '#F2C230');
  assert.equal(COLORS.sky, '#3C7FC8');
  assert.equal(COLORS.olive, '#6B7F3A');
  assert.equal(COLORS.terracotta, '#C8553D');
  assert.equal(COLORS.ink, COLORS.slate);
  assert.equal(COLORS.paper, COLORS.cream);
  assert.equal(COLORS.vermilion, COLORS.orange);
  assert.deepEqual(Object.keys(CROSSHAIR_COLORS), ['white', 'yellow', 'green', 'magenta']);
  assert.deepEqual(Object.keys(STAGE_PALETTES), ['meadow', 'hills', 'alpine']);
});

test('fx pools: fixed capacity, the oldest is recycled when full, update kills expired particles; the governor degrades and recovers', () => {
  const p = new ParticlePool(8, 4);
  for (let i = 0; i < 20; i++) p.spawn(i % 4, i, 0, 0, 0, 1, 1);
  assert.equal(p.count, 8);
  assert.equal(p.dropped, 12);
  p.update(0.5, 100);
  assert.equal(p.count, 8);
  p.update(0.6, 100);
  assert.equal(p.count, 0);
  const pool = new ObjectPool(3, () => ({ v: 0 }));
  const a = pool.take();
  pool.take();
  pool.take();
  assert.equal(pool.live, 3);
  assert.equal(pool.take(), a, 'the oldest is recycled');
  assert.equal(pool.dropped, 1);
  pool.clear();
  assert.equal(pool.live, 0);
  const g = createPerfGovernor({ windowS: 1 });
  let level = null;
  for (let i = 0; i < 40; i++) level = g.sample(0.05) ?? level;
  assert.ok(g.level >= 1);
  for (let i = 0; i < 1200; i++) g.sample(0.01);
  assert.equal(g.level, 0);
});
