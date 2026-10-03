// Render preview (dev tool, never shipped): plays one scripted scene of the REAL world renderer and HUD with a manual clock, then sets
// window.__done so test-support/render/shoot.mjs can take the screenshot. OWNER: Render & Audio engineer.
//   ?scene=play|idle|ready|card|killcam|timeattack|zen|reduce  &stage=meadow|hills|alpine  &assets=0  &at=<ms after the last event>

import { createAssets, NULL_ASSETS } from '../../public/js/render/assets.js';
import { createWorldRenderer } from '../../public/js/render/world.js';
import { createHud } from '../../public/js/render/hud.js';
import { loadFonts } from '../../public/js/render/fonts.js';
import { LABELS, busyEvents, busyTargets, ev, makeSnapshot, makeTarget, makeTranslator } from './scenes.js';

const q = new URLSearchParams(location.search);
const scene = q.get('scene') ?? 'play';
const stageId = q.get('stage') ?? 'hills';
const artOn = q.get('assets') !== '0';
const at = Number(q.get('at') ?? 30);
const reduce = scene === 'reduce';

const canvas = document.getElementById('c');
const ctx = canvas.getContext('2d');
const createCanvas = (w, h) => {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
};

async function main() {
  await loadFonts({ baseUrl: '/public/assets/', enabled: artOn || q.get('fonts') === '1' });
  const assets = artOn ? createAssets({ baseUrl: '/public/assets/', createCanvas }) : NULL_ASSETS;
  if (artOn) {
    await assets.load('core');
    await assets.load(`stage:${stageId}`);
  }
  const world = createWorldRenderer({ assets, createCanvas });
  const hud = createHud({ assets, createCanvas });
  const t = makeTranslator();
  const settings = { reduceMotion: reduce, reduceFlash: reduce, crosshairColor: 'white' };
  let now = 1000;
  const aim = { x: Number(q.get('ax') ?? 1180), y: Number(q.get('ay') ?? 360), visible: true };

  let snapshot = null;
  let idle = false;
  let showGun = true;
  if (scene === 'idle') {
    idle = true;
    showGun = false;
  } else if (scene === 'ready') {
    snapshot = makeSnapshot({ stageId, phase: 'ready', targets: [], shells: { loaded: 2, capacity: 2, reloadingS: 0, infinite: false }, score: 4350, multiplier: 2, multiplierProgress: 0.5 });
    aim.x = 900;
    aim.y = 420;
  } else if (scene === 'card') {
    snapshot = makeSnapshot({ stageId, phase: 'stageCard', targets: [], score: 6200 });
  } else if (scene === 'timeattack' || scene === 'killcam') {
    snapshot = makeSnapshot({ stageId, mode: 'timeattack', timeLeft: 8.4, timeTotal: 90, pull: { index: 0, count: null, targetsLeft: 2 }, targets: busyTargets(stageId), shells: { loaded: 0, capacity: 2, reloadingS: 0.3, infinite: false } });
  } else if (scene === 'zen') {
    snapshot = makeSnapshot({ stageId, mode: 'zen', score: 0, targets: busyTargets(stageId).slice(0, 2), shells: { loaded: 2, capacity: 2, reloadingS: 0, infinite: true } });
  } else {
    snapshot = makeSnapshot({ stageId, targets: busyTargets(stageId), houseFlashS: 0.12 });
  }

  const view = () => ({ nowMs: now, snapshot, stageId, aim, showGun, showCrosshair: !idle, idle, settings });
  const hv = () => ({ nowMs: now, t, labels: LABELS, reduceMotion: reduce, reduceFlash: reduce, battery: scene === 'play' && stageId === 'alpine' ? 'low' : 'ok' });
  const step = (n, events = null) => {
    for (let i = 0; i < n; i++) {
      now += 16;
      if (events && i === 0) {
        world.handleEvents(events, now);
        hud.handleEvents(events, now);
      }
      world.update(0.016, view());
      hud.update(0.016);
      if (i === n - 1 || i % 4 === 0) {
        world.draw(ctx, view());
        if (snapshot) hud.draw(ctx, snapshot, hv());
      }
    }
  };

  world.setStage(stageId);
  await new Promise((r) => setTimeout(r, 60)); // let the stage group settle (the game runs frame by frame, this script does not)
  step(40); // the stage crossfade (400 ms) and the gun slide-in are over
  if (scene === 'play' || scene === 'reduce') {
    step(8, [ev('stageStart', { index: 1, id: stageId, name: 'GOLDEN HILLS', windX: 1.5 })]);
    const evs = q.get('nobanner') === '1' ? busyEvents().filter((e) => e.type !== 'streak') : busyEvents();
    step(Math.max(1, Math.round((Number(q.get('hitAge') ?? 170) - at) / 16)), evs);
    // second barrel: the muzzle flash of this shot is on screen
    step(Math.max(1, Math.round(at / 16)), [ev('shot', { x: 1180, y: 360, shell: 1, hitIds: [], source: 'mouse', compMs: 0 })]);
  } else if (scene === 'ready') {
    step(4, [ev('phase', { phase: 'settle' })]);
    step(30, [ev('ready', { stageIndex: 1, pullIndex: 3 })]);
  } else if (scene === 'card') {
    step(30, [ev('stageStart', { index: 1, id: stageId, name: 'GOLDEN HILLS', windX: 1.5 })]);
  } else if (scene === 'killcam') {
    step(4, busyEvents());
    step(10, [ev('killCam', { x: 1210, y: 330, durationMs: 450, scale: 1.12 })]);
  } else if (scene === 'timeattack') {
    step(4, [ev('reload', { phase: 'start', ms: 600 })]);
    step(12, [ev('timeBonus', { deltaS: 1.5, timeLeft: 8.4 }), ev('tick', { secondsLeft: 8 })]);
  } else if (scene === 'zen') {
    step(10, [ev('shot', { x: 900, y: 300, shell: -1, hitIds: [1], source: 'mouse', compMs: 0 }), ev('hit', { id: 9, kind: 'standard', x: 900, y: 300, z: 30, rPx: 8.3, vx: 0, vy: 0, points: 0, centre: false, firstBarrel: false, multiplier: 1, streak: 1, shardSeed: 3 })]);
  } else if (scene === 'perf') {
    // 600 busy frames, timed: update + draw of the world and the HUD (performance.now is fine in a dev tool)
    const times = [];
    const worldT = [];
    for (let i = 0; i < 400; i++) {
      const evs = i % 8 === 0 ? [ev('shot', { x: 900 + (i % 5) * 60, y: 380, shell: i % 2, hitIds: [1], source: 'mouse', compMs: 0 }), ev('hit', { id: 1, kind: i % 24 === 0 ? 'gold' : 'standard', x: 900, y: 380, z: 25, rPx: 10, vx: 100, vy: -40, points: 175, centre: i % 16 === 0, firstBarrel: true, multiplier: 2, streak: 3, shardSeed: i })] : null;
      await new Promise((r) => requestAnimationFrame(r));
      const t0 = performance.now();
      now += 16;
      if (evs) { world.handleEvents(evs, now); hud.handleEvents(evs, now); }
      aim.x = 960 + Math.sin(i / 40) * 500;
      world.update(0.016, view());
      world.draw(ctx, view());
      const t1 = performance.now();
      hud.update(0.016);
      hud.draw(ctx, snapshot, hv());
      times.push(performance.now() - t0);
      worldT.push(t1 - t0);
    }
    const sorted = times.slice(100).sort((x, y) => x - y);
    const ws = worldT.slice(100).sort((x, y) => x - y);
    window.__perf = { avg: sorted.reduce((x, v) => x + v, 0) / sorted.length, p95: sorted[Math.floor(sorted.length * 0.95)], max: sorted.at(-1), worldAvg: ws.reduce((x, v) => x + v, 0) / ws.length, particles: world.getDebug().particles };
  } else {
    step(200); // idle: drift and an ambient clay
  }
  window.__debug = world.getDebug();
  window.__done = true;
}

main().catch((err) => {
  window.__error = String(err && err.stack ? err.stack : err);
  window.__done = true;
});
void makeTarget;
