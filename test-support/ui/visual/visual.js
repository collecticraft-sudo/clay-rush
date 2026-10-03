// Visual harness: renders one screen of the real presentation (real world renderer, HUD, assets and fonts) for a headless screenshot.
// URL: /?screen=menu&provider=joycon&focus=down,down&mode=timeattack. Test-support only.
import { createPresentation } from './js/ui/presentation.js';
import { createAssets } from './js/render/assets.js';
import { loadFonts } from './js/render/fonts.js';
import { createManualClock } from './js/shared/clock.js';
import { createStorage } from './js/ui/storage.js';

const q = new URLSearchParams(location.search);
const screen = q.get('screen') ?? 'menu';
const providerKind = q.get('provider') ?? 'joycon';
const clock = createManualClock(1000);
const canvas = document.getElementById('stage');
const mem = new Map();
const storage = createStorage({ backend: { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v) } });
storage.setSafetyAck();
if (q.get('best')) {
  for (const [mode, d, st, score, rank] of [['classic', 'normal', null, 12450, 'A'], ['classic', 'hard', null, 9800, 'B'], ['timeattack', 'normal', 'hills', 7200, 'A'], ['timeattack', 'easy', 'meadow', 5100, 'B']]) {
    storage.recordResult({ mode, difficulty: d, stageId: st, score, presented: 36, broken: 30, lost: 6, shots: 40, hits: 30, accuracy: 0.75, bestStreak: 8, doubles: 3, centre: 2, durationS: 180, endReason: 'complete', rank, assist: false });
  }
}
const createCanvas = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };
const assets = q.get('assets') === '0' ? null : createAssets({ createCanvas, createBitmap: null });
const p = createPresentation({ canvas, clock, storage, window, document, createCanvas, assets, hasBluetooth: true });

const labels = { joycon: { confirm: 'A', back: 'B', pause: '+', recenter: 'R', fire: 'ZR' }, mouse: { confirm: 'Click', back: 'Esc', pause: 'P', recenter: 'C', fire: 'Click' }, sim: { confirm: 'Enter', back: 'Esc', pause: 'P', recenter: 'C', fire: 'F' } };
const status = { kind: providerKind, state: 'streaming', side: 'R', battery: { mv: 3700, level: 'ok', pct: null }, trackingOk: true, error: null, cooldownUntil: null, failures: 0, deviceName: 'Joy-Con 2 (R)', packetRateHz: 66, lastPacketAt: 0, featureMask: 0xb7 };
p.ui.notify({ type: 'provider', kind: providerKind, status, labels: labels[providerKind], capabilities: {} });
if (providerKind === 'joycon') p.ui.notify({ type: 'calibration', event: { type: 'done', t: 0, quick: true, calibration: {}, warnings: [] } });

function snapshot(over = {}) {
  return {
    v: 1, mode: 'classic', difficulty: 'normal', seed: 7, phase: 'flight', t: 12, tWorld: 12, alpha: 0.5, timeScale: 1,
    stage: { index: 1, id: 'hills', count: 3, name: 'Golden Hills' }, pull: { index: 3, count: 8, targetsLeft: 1 }, wind: { x: 1.5, gust: 0 },
    shells: { loaded: 1, capacity: 2, reloadingS: 0, infinite: false }, score: 2350, streak: 4, multiplier: 2, multiplierProgress: 0.3,
    timeLeft: null, timeTotal: null,
    targets: [{ id: 3, kind: 'standard', frame: 'tilt', x: 2, y: 6, z: 24, vx: 3, vy: 2, vz: 10, sx: 1100, sy: 380, rPx: 12, rot: 0.3, ageS: 0.6, pullIndex: 3 }],
    houses: [], killCam: null, practice: null, stats: { presented: 14, broken: 11, lost: 3, shots: 16, hits: 11, centre: 2, doubles: 1, bestStreak: 6 },
    assist: false, endReason: null, events: [], ...over,
  };
}

let snap = null;
const opts = { roundMode: q.get('roundMode') ?? 'classic', mode: q.get('mode') ?? 'classic', step: Number(q.get('step') ?? 1) };
if (screen === 'results') {
  opts.result = { mode: q.get('mode') ?? 'classic', difficulty: 'normal', stageId: q.get('mode') === 'timeattack' ? 'hills' : null, score: 12450, presented: 36, broken: 31, lost: 5, shots: 44, hits: 31, accuracy: 0.705, bestStreak: 12, doubles: 4, centre: 6, durationS: 190, endReason: 'complete', rank: 'A', assist: false };
}
if (['playing', 'paused', 'countdown'].includes(screen)) snap = snapshot();
if (screen === 'calibration' && opts.step === 4) snap = snapshot({ mode: 'practice', stage: { index: 0, id: 'hills', count: 1, name: 'Golden Hills' } });
if (screen === 'results' && q.get('newbest')) {
  // a real roundOver so NEW BEST shows
  p.ui.force('playing', { roundMode: opts.result.mode });
  p.ui.notify({ type: 'roundOver', result: opts.result });
} else {
  p.ui.force(screen, opts);
}
if (q.get('overlay') === 'confirm') { p.ui.force('settings'); p.ui.activate('set.reset'); }
for (const d of (q.get('focus') ?? '').split(',').filter(Boolean)) {
  p.ui.notify({ type: 'nav', event: { t: clock.now(), dir: d, phase: 'down', source: providerKind === 'joycon' ? 'joycon' : 'keyboard' } });
  p.ui.notify({ type: 'nav', event: { t: clock.now(), dir: d, phase: 'up', source: providerKind === 'joycon' ? 'joycon' : 'keyboard' } });
}
if (q.get('toast')) p.ui.notify({ type: 'recentered' });

await loadFonts({ timeoutMs: 3000 }).catch(() => {});
if (assets) {
  await assets.load('core').catch(() => {});
  await assets.load('stage:hills').catch(() => {});
  await assets.load('stage:meadow').catch(() => {});
}
const frames = Number(q.get('frames') ?? 90);
for (let i = 0; i < frames; i++) {
  clock.advance(16);
  p.step({ nowMs: clock.now(), dtS: 0.016, snapshot: snap, events: [], aim: { x: 1040, y: 420, visible: true, trackingOk: true, speedDps: 42 } });
}
p.draw();
if (q.get('name')) await fetch(`/save?name=${encodeURIComponent(q.get('name'))}`, { method: 'POST', body: canvas.toDataURL('image/png') });
document.title = 'ready';
