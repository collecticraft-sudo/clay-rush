// World renderer (architecture 6.1): every phase draws with and without the art, events make effects that expire, the Reduce motion and
// Reduce flashes twins, the gun and the camera, and a busy scene that allocates nothing new over 600 frames.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorldRenderer } from '../../public/js/render/world.js';
import { NULL_ASSETS } from '../../public/js/render/assets.js';
import { ART_CONFIG } from '../../public/js/render/art-config.js';
import { GAME_PHASE, GAME_EVENT } from '../../public/js/shared/contracts.js';
import { assertValid } from '../../public/js/shared/validate.js';
import { FakeCanvas, createFakeCanvasFactory } from '../../test-support/render/fake-canvas.js';
import { createArtStub } from '../../test-support/render/art-stub.js';
import { allEvents, busyEvents, busyTargets, ev, makeSnapshot, makeTarget } from '../../test-support/render/scenes.js';

const STAGES = ['meadow', 'hills', 'alpine'];

function rig({ art = false, settings = {} } = {}) {
  const factory = createFakeCanvasFactory();
  const assets = art ? createArtStub({ loaded: 'all', createCanvas: factory.createCanvas }) : NULL_ASSETS;
  const world = createWorldRenderer({ assets, createCanvas: factory.createCanvas });
  const canvas = new FakeCanvas(1920, 1080);
  const ctx = canvas.ctx;
  const log = [];
  const drawImage = ctx.drawImage;
  ctx.drawImage = (...a) => {
    log.push({ img: a[0], alpha: ctx.globalAlpha, op: ctx.globalCompositeOperation, args: a.slice(1) });
    drawImage(...a);
  };
  const fillRect = ctx.fillRect;
  const fills = [];
  ctx.fillRect = (...a) => {
    fills.push({ alpha: ctx.globalAlpha, fill: ctx.fillStyle, args: a });
    fillRect(...a);
  };
  const st = { reduceMotion: false, reduceFlash: false, crosshairColor: 'white', ...settings };
  let now = 1000;
  const view = (o = {}) => ({ nowMs: now, snapshot: null, stageId: 'hills', aim: { x: 1100, y: 400, visible: true }, showGun: true, showCrosshair: true, idle: false, settings: st, ...o });
  const frame = (o = {}, dt = 1 / 60) => {
    now += dt * 1000;
    const v = view(o);
    world.update(dt, v);
    log.length = 0;
    fills.length = 0;
    ctx.reset();
    world.draw(ctx, v);
    return v;
  };
  return { world, ctx, factory, assets, log, fills, frame, view, settings: st, get now() { return now; } };
}

test('every phase of every stage draws without throwing, with and without the art, idle included; the snapshots are valid', async () => {
  for (const art of [false, true]) {
    for (const stageId of STAGES) {
      const r = rig({ art });
      if (art) {
        await r.assets.load(`stage:${stageId}`);
        await new Promise((res) => setImmediate(res));
      }
      r.world.setStage(stageId);
      await new Promise((res) => setImmediate(res)); // the stage group settles
      for (const phase of Object.values(GAME_PHASE)) {
        const snapshot = assertValid('GameSnapshot', makeSnapshot({ stageId, phase, targets: phase === 'flight' ? busyTargets(stageId) : [] }));
        assert.doesNotThrow(() => r.frame({ snapshot, stageId }), `${stageId} ${phase} art=${art}`);
        assert.ok(r.ctx.calls.length > 0);
      }
      assert.doesNotThrow(() => { for (let i = 0; i < 30; i++) r.frame({ snapshot: null, stageId, idle: true, showGun: false, showCrosshair: false }); });
      assert.deepEqual(r.ctx.forbidden, [], 'no shadowBlur or filter');
      const d = r.world.getDebug();
      assert.equal(d.stage, stageId);
      if (art) assert.deepEqual(d.layers, { far: true, near: true }, `${stageId}: the art layers are on screen`);
      else assert.deepEqual(d.layers, { far: false, near: false });
    }
  }
});

test('getDebug has the contract shape: particles, stage, layers {far, near}, shake, zoom', () => {
  const r = rig();
  r.world.setStage('meadow');
  r.frame({ stageId: 'meadow' });
  const d = r.world.getDebug();
  for (const k of ['particles', 'stage', 'layers', 'shake', 'zoom']) assert.ok(k in d, k);
  assert.equal(typeof d.particles, 'number');
  assert.equal(typeof d.layers.far, 'boolean');
  assert.equal(typeof d.layers.near, 'boolean');
  assert.equal(d.zoom, 1);
  assert.equal(d.shake, 0);
});

test('every GameEvent type is accepted (valid events), and the effects of a busy volley expire', () => {
  const r = rig();
  const events = allEvents();
  for (const e of events) assertValid('GameEvent', e);
  assert.deepEqual(new Set(events.map((e) => e.type)), new Set(Object.values(GAME_EVENT)), 'the fixture covers every type');
  const snapshot = makeSnapshot({ targets: busyTargets('hills') });
  r.frame({ snapshot });
  assert.doesNotThrow(() => r.world.handleEvents(events, r.now));
  assert.doesNotThrow(() => r.world.handleEvents(busyEvents(), r.now));
  r.frame({ snapshot });
  const busy = r.world.getDebug();
  assert.ok(busy.particles > 40, `effects alive: ${busy.particles}`);
  assert.ok(busy.pools.shards >= 6 && busy.pools.shards <= busy.pools.shardsCap, `shards ${busy.pools.shards}`);
  assert.ok(busy.pools.popups >= 1);
  for (let i = 0; i < 240; i++) r.frame({ snapshot: makeSnapshot({ targets: [] }) });
  assert.equal(r.world.getDebug().particles, 0, 'everything expired after 4 s');
  // reset clears at once
  r.world.handleEvents(busyEvents(), r.now);
  r.frame({ snapshot });
  assert.ok(r.world.getDebug().particles > 0);
  r.world.reset();
  assert.equal(r.world.getDebug().particles, 0);
});

test('a hit makes 6 to 10 shards seeded by shardSeed (same seed, same count), a big burst for a centre or a gold hit', () => {
  const count = (fields) => {
    const r = rig();
    r.frame();
    r.world.handleEvents([ev('hit', { id: 1, kind: 'standard', x: 900, y: 400, z: 25, rPx: 10, vx: 0, vy: 0, points: 100, centre: false, firstBarrel: true, multiplier: 1, streak: 1, shardSeed: 77, ...fields })], r.now);
    return r.world.getDebug().pools.shards;
  };
  for (const seed of [1, 2, 3, 99, 12345]) {
    const n = count({ shardSeed: seed });
    assert.ok(n >= ART_CONFIG.fx.shardsMin && n <= ART_CONFIG.fx.shardsMax, `seed ${seed}: ${n}`);
    assert.equal(count({ shardSeed: seed }), n, 'deterministic');
  }
  assert.equal(count({ centre: true }), ART_CONFIG.fx.shardsMax);
  assert.equal(count({ kind: 'gold' }), ART_CONFIG.fx.shardsMax);
});

test('a shot shakes the camera (6 px, gone after 120 ms), blooms the crosshair, kicks the gun back and lights the muzzle; the kick returns in 140 ms', () => {
  const r = rig();
  for (let i = 0; i < 40; i++) r.frame();
  const rest = r.world.getDebug().gun;
  assert.ok(rest.show > 0.99);
  r.world.handleEvents([ev('shot', { x: 1100, y: 400, shell: 0, hitIds: [], source: 'mouse', compMs: 0 })], r.now);
  r.frame({}, 0.02);
  const d = r.world.getDebug();
  assert.ok(d.shake > 0.5 && d.shake <= ART_CONFIG.fx.shakePx + 1e-6, `shake ${d.shake}`);
  assert.ok(Math.hypot(d.gun.x - rest.x, d.gun.y - rest.y) > 2, 'the gun moved back');
  assert.ok(r.log.some((l) => l.op === 'lighter'), 'additive glow and flash');
  for (let i = 0; i < 12; i++) r.frame();
  const after = r.world.getDebug();
  assert.equal(after.shake, 0);
  assert.ok(Math.hypot(after.gun.x - rest.x, after.gun.y - rest.y) < 0.5, 'the kick is back');
  // the muzzle sits at the manifest's muzzle point of the gun picture (procedural meta mirrors it)
  assert.ok(after.gun.muzzleX < 1920 && after.gun.muzzleX > 1000 && after.gun.muzzleY > 200 && after.gun.muzzleY < 900, `muzzle ${after.gun.muzzleX},${after.gun.muzzleY}`);
});

test('the gun follows the aim a little: aiming left moves the muzzle left; hidden on menus (idle)', () => {
  const r = rig();
  for (let i = 0; i < 60; i++) r.frame({ aim: { x: 1500, y: 500, visible: true } });
  const right = r.world.getDebug().gun.muzzleX;
  for (let i = 0; i < 60; i++) r.frame({ aim: { x: 300, y: 500, visible: true } });
  const left = r.world.getDebug().gun.muzzleX;
  assert.ok(left < right - 20, `${left} < ${right}`);
  for (let i = 0; i < 40; i++) r.frame({ idle: true, showGun: false, showCrosshair: false });
  const d = r.world.getDebug();
  assert.equal(d.gun.show, 0);
  assert.equal(d.crosshair, 0);
});

test('kill cam: a 1.12 zoom on the point with a letterbox; Reduce motion: no zoom, an 80 ms still flash instead', () => {
  const r = rig();
  r.frame();
  r.world.handleEvents([ev('killCam', { x: 900, y: 400, durationMs: 450, scale: 1.12 })], r.now);
  for (let i = 0; i < 12; i++) r.frame();
  const d = r.world.getDebug();
  assert.ok(d.zoom > 1.1 && d.zoom <= 1.12 + 1e-9, `zoom ${d.zoom}`);
  assert.equal(d.killCam, true);
  assert.ok(r.fills.some((f) => f.args[1] > 900), 'the bottom letterbox bar');
  for (let i = 0; i < 30; i++) r.frame();
  assert.equal(r.world.getDebug().zoom, 1);

  const m = rig({ settings: { reduceMotion: true } });
  m.frame();
  m.world.handleEvents([ev('killCam', { x: 900, y: 400, durationMs: 450, scale: 1.12 })], m.now);
  m.frame();
  assert.equal(m.world.getDebug().zoom, 1);
  assert.equal(m.world.getDebug().stillFlash, true);
  const flash = m.fills.find((f) => f.args[2] >= 1920 && f.args[3] >= 1080);
  assert.ok(flash && flash.alpha <= ART_CONFIG.fx.stillFlashAlpha + 1e-9);
  for (let i = 0; i < 8; i++) m.frame();
  assert.equal(m.world.getDebug().stillFlash, false);
});

test('Reduce motion: no shake, no parallax (the layers stay put whatever the aim), no hit-stop freeze', () => {
  const layerPos = (rr, aim) => {
    rr.frame({ aim });
    return rr.log.filter((l) => l.img && l.img.isFakeCanvas && l.img.width > 1900).map((l) => l.args.slice(-4).join(','));
  };
  const free = rig();
  free.world.setStage('hills');
  const a = layerPos(free, { x: 200, y: 300, visible: true });
  const b = layerPos(free, { x: 1700, y: 800, visible: true });
  assert.ok(a.length >= 2, 'far and near layers drawn');
  assert.notDeepEqual(a, b, 'parallax moves the layers');
  const still = rig({ settings: { reduceMotion: true } });
  still.world.setStage('hills');
  assert.deepEqual(layerPos(still, { x: 200, y: 300, visible: true }), layerPos(still, { x: 1700, y: 800, visible: true }));
  still.world.handleEvents([ev('shot', { x: 900, y: 400, shell: 0, hitIds: [], source: 'mouse', compMs: 0 })], still.now);
  still.frame({}, 0.02);
  assert.equal(still.world.getDebug().shake, 0);
});

test('Reduce flashes: the muzzle flash and glow are dim, the still flash is faint; without it they are bright', () => {
  const peak = (settings) => {
    const r = rig({ settings });
    for (let i = 0; i < 30; i++) r.frame();
    r.world.handleEvents([ev('shot', { x: 900, y: 400, shell: 0, hitIds: [], source: 'mouse', compMs: 0 })], r.now);
    r.frame({}, 0.005);
    return Math.max(0, ...r.log.filter((l) => l.op === 'lighter').map((l) => l.alpha));
  };
  assert.ok(peak({}) >= 0.7, `bright ${peak({})}`);
  assert.ok(peak({ reduceFlash: true }) <= ART_CONFIG.fx.flashReducedAlpha + 1e-9, `dim ${peak({ reduceFlash: true })}`);
});

test('houses stand on their projected ground point; a fresh launch puffs at the door', () => {
  const r = rig({ art: true });
  const snapshot = makeSnapshot({ stageId: 'meadow', houseFlashS: 0.1 });
  r.world.setStage('meadow');
  r.frame({ snapshot, stageId: 'meadow' });
  const trap = snapshot.houses.find((h) => h.id === 'trap');
  const m = r.assets.meta('house_trap');
  const scale = (ART_CONFIG.houses.widthM.house_trap * trap.scale) / m.contentBox.w;
  const want = m.contentBox.w * scale;
  const hit = r.log.find((l) => Math.abs(l.args[2] - want) < 1);
  assert.ok(hit, 'the trap house drawn at its world width');
  const [x, y, w, h] = hit.args.slice(-4);
  assert.ok(Math.abs(y + h - trap.sy - (m.contentBox.y + m.contentBox.h - m.anchor.y) * scale) < 1.5, 'bottom on the ground point');
  assert.ok(Math.abs(x + w / 2 - trap.sx) < Math.abs(m.anchor.x - (m.contentBox.x + m.contentBox.w / 2)) * scale + 1.5);
});

test('idle mode: slow drift and an occasional ambient clay crossing the sky', () => {
  const r = rig();
  r.world.setStage('hills');
  let sawAmbient = false;
  const positions = new Set();
  for (let i = 0; i < 60 * 12; i++) {
    r.frame({ idle: true, showGun: false, showCrosshair: false, snapshot: null });
    if (i % 60 === 0) positions.add(r.log.filter((l) => l.img && l.img.width > 1900).map((l) => Math.round(l.args.at(-4))).join());
    // the ambient clay is a small sprite (a clay picture) in the sky band
    if (r.log.some((l) => l.args.length >= 4 && l.args.at(-2) < 80 && l.args.at(-3) < 700 && l.args.at(-2) > 10)) sawAmbient = true;
  }
  assert.ok(positions.size > 3, 'the backdrop drifts');
  assert.ok(sawAmbient, 'an ambient clay flew by');
});

test('busy scene, 600 frames: pool sizes stay put, no canvas is created in the second half, nothing exceeds its cap', () => {
  const r = rig({ art: false });
  r.world.setStage('alpine');
  const snapshot = makeSnapshot({ stageId: 'alpine', targets: busyTargets('alpine') });
  const caps = ART_CONFIG.fx.caps;
  let created = 0;
  let maxParticles = 0;
  for (let i = 0; i < 600; i++) {
    if (i % 8 === 0) {
      r.world.handleEvents([
        ev('shot', { x: 900 + (i % 5) * 40, y: 380, shell: i % 2, hitIds: [1], source: 'mouse', compMs: 0 }),
        ev('hit', { id: 1, kind: i % 24 === 0 ? 'gold' : 'standard', x: 900, y: 380, z: 25, rPx: 10, vx: 100, vy: -40, points: 175, centre: i % 16 === 0, firstBarrel: true, multiplier: 2, streak: 3, shardSeed: i, }),
        ev('lost', { id: 2, kind: 'standard', x: 400, y: 800, reason: 'ground' }),
      ], r.now);
    }
    if (i % 90 === 45) r.world.handleEvents([ev('phase', { phase: 'settle' })], r.now);
    r.frame({ snapshot, stageId: 'alpine' });
    if (i === 300) created = r.factory.created.length;
    const d = r.world.getDebug();
    maxParticles = Math.max(maxParticles, d.pools.particles);
    assert.ok(d.pools.particles <= caps.particles && d.pools.shards <= caps.shards && d.pools.sprites <= caps.sprites);
    assert.equal(d.pools.particlesCap, caps.particles);
    assert.equal(d.pools.shardsCap, caps.shards);
  }
  assert.equal(r.factory.created.length, created, 'no canvas made after frame 300 (every sprite size bucket and text is cached)');
  assert.ok(maxParticles > 50, `the scene was busy: ${maxParticles}`);
});

test('continuity: a clay flying from below the horizon up through the underside band never jumps in size, aspect or picture (no frame swap)', () => {
  for (const art of [false, true]) {
    const r = rig({ art });
    for (let i = 0; i < 80; i++) r.frame({ snapshot: makeSnapshot({ targets: [] }) }); // the prewarm of the clay buckets is done
    const created = r.factory.created.length;
    let prev = null;
    let maxAspect = 0;
    let maxSize = 0;
    let sawBelow = false;
    for (let f = 0; f < 150; f++) {
      const tS = f / 60;
      // world path: from the trap at eye level, rising steeply and going away (elevation -5 to beyond +25 degrees)
      const z = 12 + 9 * tS;
      const y = 0.6 + 11 * tS - 1.5 * tS * tS;
      const x = 1.5 * tS;
      const frame = ['tilt', 'edge', 'below'][f % 3]; // whatever the game says, the renderer must not follow a frame swap
      const t = makeTarget(1, 'standard', frame, x, y, z, 1.5, 11 - 3 * tS, 9, 6 * tS);
      r.frame({ snapshot: makeSnapshot({ targets: [t] }) });
      const d = r.world.getDebug().drawn[0];
      assert.ok(d, `frame ${f} drawn`);
      if (d.wB > 0.5) sawBelow = true;
      if (prev) {
        maxAspect = Math.max(maxAspect, Math.abs(d.h / d.w - prev.h / prev.w));
        maxSize = Math.max(maxSize, Math.abs(d.w - prev.w) / d.w);
        assert.equal(d.a, prev.a, 'the base picture never changes');
        assert.ok(Math.abs(d.wB - prev.wB) < 0.08, `blend step ${d.wB - prev.wB}`);
        assert.ok(Math.abs(d.rot - prev.rot) < 0.03, 'the wobble is continuous');
      }
      prev = d;
    }
    assert.ok(sawBelow, 'the underside view blended in');
    assert.ok(maxAspect < 0.08, `aspect step ${maxAspect} (a frame swap was 2.1)`);
    assert.ok(maxSize < 0.05, `size step ${maxSize}`);
    assert.equal(r.factory.created.length, created, 'no bake while the clay flies (prewarmed buckets)');
  }
});

test('difficulty view: the backdrop zooms about the horizon by worldScale (Easy closer, Hard wider, menus 1), eased, a cut with Reduce motion', () => {
  const zoomAfter = (k, o = {}, settings = {}) => {
    const r = rig({ settings });
    r.world.setStage('hills');
    for (let i = 0; i < 200; i++) r.frame({ snapshot: makeSnapshot({ worldScale: k }), ...o });
    return r.world.getDebug().viewZoom;
  };
  const easy = zoomAfter(0.55);
  const hard = zoomAfter(1.45);
  assert.ok(Math.abs(easy - 0.55 ** -0.35) < 1e-3 && easy > 1.2, `easy ${easy}`);
  assert.ok(hard < 0.9, `hard ${hard}`);
  assert.equal(zoomAfter(1), 1);
  assert.equal(zoomAfter(0.55, { idle: true, snapshot: null }), 1, 'menus');
  assert.equal(zoomAfter(undefined), 1, 'no worldScale in the snapshot');
  // eased: right after the round starts it is between 1 and the target
  const r = rig();
  r.frame({ snapshot: makeSnapshot({ worldScale: 0.55 }) });
  const z1 = r.world.getDebug().viewZoom;
  assert.ok(z1 > 1 && z1 < easy);
  const m = rig({ settings: { reduceMotion: true } });
  m.frame({ snapshot: makeSnapshot({ worldScale: 0.55 }) });
  assert.ok(Math.abs(m.world.getDebug().viewZoom - easy) < 1e-3, 'a cut');
  // the far layer is scaled about the horizon point and still covers the field on Hard
  const h = rig();
  h.world.setStage('hills');
  for (let i = 0; i < 90; i++) h.frame({ snapshot: makeSnapshot({ worldScale: 1.45 }), aim: { x: 960, y: 540, visible: true } });
  const far = h.log.find((l) => l.img && l.img.isFakeCanvas && l.img.width > 1900);
  const [x, y, w, hh] = far.args.slice(-4);
  assert.ok(x <= 0 && y <= 0 && x + w >= 1920 && y + hh >= 1080, `covers: ${[x, y, w, hh].map(Math.round)}`);
  assert.ok(Math.abs(y + 0.62 * hh - 670) < 2, 'the horizon stays on 670');
});

test('the gun opens once per Classic pull and ejects exactly what was fired; nothing flies before the first shot (R-02, QA F26)', () => {
  const r = rig();
  const casings = () => r.world.getDebug().pools.casings;
  for (let i = 0; i < 20; i++) r.frame();
  r.world.handleEvents([ev('ready', { stageIndex: 0, pullIndex: 0 }), ev('reload', { phase: 'start', ms: 400 })], r.now);
  for (let i = 0; i < 30; i++) r.frame();
  r.world.handleEvents([ev('reload', { phase: 'done', ms: 0 })], r.now);
  for (let i = 0; i < 30; i++) r.frame();
  assert.equal(r.world.getDebug().pools.casings, 0, 'no phantom hull at the start of the round');
  r.world.handleEvents([ev('shot', { x: 900, y: 400, shell: 0, hitIds: [], source: 'mouse', compMs: 0 }), ev('shot', { x: 900, y: 400, shell: 1, hitIds: [], source: 'mouse', compMs: 0 })], r.now);
  r.frame();
  r.world.handleEvents([ev('phase', { phase: 'settle' })], r.now);
  let most = 0;
  for (let i = 0; i < 40; i++) { r.frame(); most = Math.max(most, casings()); }
  assert.equal(most, 2, 'two hulls for two shots');
  const yOpen = r.world.getDebug().gun.y;
  r.world.handleEvents([ev('ready', { stageIndex: 0, pullIndex: 1 }), ev('reload', { phase: 'start', ms: 400 })], r.now);
  for (let i = 0; i < 20; i++) { r.frame(); most = Math.max(most, casings()); }
  assert.equal(most, 2, 'the reload start of the next ready does not open the gun again');
  assert.ok(Math.abs(r.world.getDebug().gun.y - yOpen) < 1, 'still open (held) until the shells are in');
  r.world.handleEvents([ev('reload', { phase: 'done', ms: 0 })], r.now);
  for (let i = 0; i < 30; i++) r.frame();
  assert.ok(r.world.getDebug().gun.y < yOpen - 20, 'closed after the shells are in');
});

test('camera shake: one smooth 3 px bump (no jerk for a clay still flying), half while another clay flies, none with Reduce motion (QA F8)', () => {
  const run = (targets) => {
    const r = rig();
    const snapshot = makeSnapshot({ targets });
    for (let i = 0; i < 10; i++) r.frame({ snapshot });
    r.world.handleEvents([ev('shot', { x: 900, y: 400, shell: 0, hitIds: [], source: 'mouse', compMs: 0 })], r.now);
    const ys = [];
    for (let i = 0; i < 12; i++) { r.frame({ snapshot }); ys.push(r.world.getDebug().shake); }
    return ys;
  };
  const one = run(busyTargets('hills').slice(0, 1));
  const two = run(busyTargets('hills').slice(0, 2));
  const peak = (a) => Math.max(...a);
  assert.ok(peak(one) <= ART_CONFIG.fx.shakePx * 1.07 + 1e-9 && peak(one) > 1, `single: ${peak(one)}`);
  assert.ok(peak(two) <= peak(one) * 0.55, `with another clay airborne: ${peak(two)}`);
  for (let i = 1; i < one.length - 1; i++) assert.ok(Math.abs(one[i + 1] - 2 * one[i] + one[i - 1]) < 2.2, 'smooth bump');
  assert.equal(one.at(-1), 0, 'over in 90 ms');
});

test('labels of a double never overlap and stay inside the field; with Reduce motion a popup does not rise (QA F5, F13, R-04)', () => {
  const r = rig();
  r.frame();
  const hit = (id, x, y, centre) => ev('hit', { id, kind: 'standard', x, y, z: 25, rPx: 10, vx: 0, vy: 0, points: 175, centre, firstBarrel: true, multiplier: 2, streak: 2, shardSeed: id });
  r.world.handleEvents([hit(1, 1200, 520, true), hit(2, 1230, 540, true), hit(3, 20, 700, false)], r.now);
  r.frame();
  const p = r.world.getDebug().popups;
  assert.equal(p.length, 3);
  assert.ok(Math.abs(p[0].y - p[1].y) > 100, `stacked: ${p[0].y} / ${p[1].y}`);
  assert.ok(p[2].x >= 150, 'kept away from the left edge');
  const m = rig({ settings: { reduceMotion: true } });
  m.frame();
  m.world.handleEvents([hit(1, 900, 600, false)], m.now);
  const popupY = () => m.log.filter((l) => l.img && l.img.isFakeCanvas && l.img.height < 200 && l.img.width < 400).map((l) => l.args[1]).at(-1);
  m.frame();
  const a = popupY();
  for (let i = 0; i < 20; i++) m.frame();
  assert.equal(popupY(), a);
});

test('the gun never hides the crosshair: for aims across the whole field the crosshair is outside the gun silhouette (with its clearance), the muzzle flash stays at the muzzle', () => {
  for (const art of [false, true]) {
    const r = rig({ art });
    let worst = Infinity;
    for (let gx = 0; gx <= 1920; gx += 120) {
      for (let gy = 0; gy <= 1080; gy += 90) {
        const aimAt = { x: gx, y: gy, visible: true };
        for (let i = 0; i < 25; i++) r.frame({ aim: aimAt });
        const d = r.world.getDebug();
        assert.equal(d.gunCovers(gx, gy, 0), false, `aim ${gx},${gy} art=${art}: crosshair under the gun`);
        assert.equal(d.gunCovers(gx, gy, ART_CONFIG.crosshair.r), false, `aim ${gx},${gy}: the ring under the gun`);
        worst = Math.min(worst, d.gun.slide);
      }
    }
    assert.equal(worst, 0, 'no slide when the aim is away from the gun');
  }
  // the barrels turn towards the crosshair; the slide is continuous; recoil and muzzle flash still at the muzzle
  const r = rig();
  for (let i = 0; i < 40; i++) r.frame({ aim: { x: 1700, y: 900, visible: true } });
  const g = r.world.getDebug().gun;
  assert.ok(g.slide > 50, `slid away: ${g.slide}`);
  for (let i = 0; i < 40; i++) r.frame({ aim: { x: 1000, y: 800, visible: true } });
  let prev = null;
  for (let x = 1000; x <= 1900; x += 6) {
    r.frame({ aim: { x, y: 800, visible: true } });
    const s = r.world.getDebug().gun;
    if (prev) assert.ok(Math.hypot(s.x - prev.x, s.y - prev.y) < 25, 'the gun moves smoothly with the aim');
    prev = s;
  }
  r.world.handleEvents([ev('shot', { x: 1900, y: 800, shell: 0, hitIds: [], source: 'mouse', compMs: 0 })], r.now);
  r.frame({ aim: { x: 1900, y: 800, visible: true } }, 0.005);
  const flash = r.log.filter((l) => l.op === 'lighter');
  assert.ok(flash.length > 0, 'the muzzle flash is drawn');
});

test('a clay under the gun makes the gun fade to 35 percent; menus (idle) draw no house', () => {
  const r = rig();
  const t = { ...makeTarget(1, 'standard', 'tilt', 6, 0.3, 12, 0, 0, 1), sx: 1780, sy: 980 }; // low on the right, under the gun's stock
  for (let i = 0; i < 40; i++) r.frame({ aim: { x: 400, y: 300, visible: true }, snapshot: makeSnapshot({ targets: [t] }) });
  const d = r.world.getDebug();
  if (d.gunCovers(t.sx, t.sy, t.rPx)) assert.ok(d.gun.alpha < 0.4, `faded: ${d.gun.alpha}`);
  else assert.fail(`the test clay at ${t.sx},${t.sy} is not under the gun`);
  const idle = rig({ art: true });
  idle.world.setStage('hills');
  idle.frame({ idle: true, showGun: false, showCrosshair: false, snapshot: null });
  const m = idle.assets.meta('house_trap');
  assert.ok(!idle.log.some((l) => l.img && l.img.isFakeCanvas && Math.abs(l.img.width / l.img.height - m.contentBox.w / m.contentBox.h) < 0.02), 'no house picture in idle');
});
