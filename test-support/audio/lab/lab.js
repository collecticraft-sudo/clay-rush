// Sound lab (dev tool, never shipped): every sound of the game, played live through the REAL engine (public/js/audio/audio.js) and
// rendered offline (OfflineAudioContext) for a waveform, a spectrogram and the levels. OWNER: audio engineer.
// window.__lab is the automation surface used by test-support/audio/render-sounds.mjs: renderAll(), renderOne(), wavBase64().

import { createAudio, masterGainFor } from '/js/audio/audio.js';
import { RECIPES, SOUND_IDS, buildRecipe } from '/js/audio/recipes.js';

const SR = 44100;
const MASTER = masterGainFor(1); // every offline render runs at volume 1 (master gain 0.8); levels are reported before it

/** Seeded randomness so a render is reproducible. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const hit = (i, o = {}) => ({ type: 'hit', id: i, kind: 'standard', x: 700 + 90 * i, y: 400, z: 22, rPx: 11, vx: 0, vy: 0, points: 100, centre: false, firstBarrel: true, multiplier: 1, streak: i, shardSeed: i, ...o });
const shot = (shell, o = {}) => ({ type: 'shot', x: 900, y: 400, shell, hitIds: [], source: 'mouse', compMs: 0, ...o });

/** Single sounds with their interesting parameter variants, then the stress mixes. */
function buildScenarios() {
  const list = [];
  const add = (name, id, params = {}) => list.push({ name, kind: 'sound', id, params });
  add('shot first barrel', 'shot', { shell: 0, x: 960 });
  add('shot second barrel', 'shot', { shell: 1, x: 960 });
  add('clayBreak near', 'clayBreak', { x: 960, z: 16, jitter: 1 });
  add('clayBreak far', 'clayBreak', { x: 960, z: 55, jitter: 1 });
  add('clayBreak centre', 'clayBreak', { x: 960, z: 22, centre: true, jitter: 1 });
  add('goldBreak', 'goldBreak', { x: 960, z: 25, jitter: 1 });
  add('double', 'double', {});
  add('double big (two with one)', 'double', { big: true });
  for (const level of [2, 3, 4]) add(`streakUp x${level}`, 'streakUp', { level });
  add('stageClear', 'stageClear', { perfect: false });
  add('stageClear perfect', 'stageClear', { perfect: true });
  add('timeTick urgent', 'timeTick', { urgent: true });
  for (let s = 0; s < 3; s++) add(`bird ${s}`, 'bird', { species: s, x: 600 });
  for (const n of [3, 2, 1]) add(`countdown ${n}`, 'countdown', { n });
  for (let rank = 1; rank <= 5; rank++) add(`resultsFanfare rank ${rank}`, 'resultsFanfare', { rank });
  add('countTick 0', 'countTick', { progress: 0 });
  add('countTick 1', 'countTick', { progress: 1 });
  add('uiWhoosh reverse', 'uiWhoosh', { reverse: true });
  add('calHold 1.2 s', 'calHold', { ms: 1200 });
  const covered = ['shot', 'clayBreak', 'goldBreak', 'double', 'streakUp', 'stageClear', 'bird', 'countdown', 'resultsFanfare', 'calHold'];
  for (const id of SOUND_IDS) {
    if (covered.includes(id)) continue;
    add(id, id, id === 'timeTick' ? { urgent: false } : {});
  }
  list.push({
    name: 'MIX double: two shots, two breaks, double, streak', kind: 'mix', seconds: 2.6,
    events: [
      [0, (a) => a.handleGameEvent(shot(0))], [0.01, (a) => a.handleGameEvent(hit(1, { centre: true }))],
      [0.22, (a) => a.handleGameEvent(shot(1))], [0.23, (a) => a.handleGameEvent(hit(2))],
      [0.24, (a) => a.handleGameEvent({ type: 'double', points: 100, x: 960, y: 400 })],
      [0.25, (a) => a.handleGameEvent({ type: 'streak', level: 4, streak: 10 })],
    ],
  });
  list.push({
    name: 'MIX gold kill cam', kind: 'mix', seconds: 2.4,
    events: [
      [0, (a) => a.handleGameEvent(shot(0))], [0.01, (a) => a.handleGameEvent(hit(1, { kind: 'gold', centre: true }))],
      [0.02, (a) => a.handleGameEvent({ type: 'killCam', x: 900, y: 400, durationMs: 450, scale: 1.12 })],
      [0.03, (a) => a.handleGameEvent({ type: 'twoWithOne', points: 200, x: 960, y: 400 })],
    ],
  });
  list.push({
    name: 'MIX worst case: shots, perfect stage, time up, go, stamp, fanfare', kind: 'mix', seconds: 3.4,
    events: [
      [0, (a) => a.play('shot', { shell: 0, x: 960 })], [0, (a) => a.play('shot', { shell: 1, x: 960 })], [0, (a) => a.go()], [0, (a) => a.rankStamp()],
      [0, (a) => a.resultsFanfare(5)], [0, (a) => a.handleGameEvent({ type: 'timeUp', score: 9000 })],
      [0, (a) => a.handleGameEvent({ type: 'stageClear', index: 1, perfect: true, bonus: 500 })],
      [0, (a) => a.play('goldBreak', { x: 960, z: 15 })],
    ],
  });
  list.push({
    name: 'MIX Time Attack hail: eight quick shots and breaks', kind: 'mix', seconds: 2.2,
    events: [0, 1, 2, 3, 4, 5, 6, 7].flatMap((i) => [[i * 0.16, (a) => a.handleGameEvent(shot(i % 2))], [i * 0.16 + 0.01, (a) => a.handleGameEvent(hit(i, { x: 300 + 180 * i }))]]),
  });
  return list;
}

function offlineContext(seconds) {
  const c = new OfflineAudioContext(2, Math.ceil(seconds * SR), SR);
  // the engine only plays on a running context; an offline context reports 'suspended' until it renders
  Object.defineProperty(c, 'state', { get: () => 'running' });
  return c;
}

function secondsFor(sc) {
  if (sc.seconds) return sc.seconds;
  const r = buildRecipe(sc.id, sc.params);
  return Math.min(4, Math.max(0.7, r.durationMs / 1000 + (r.wet > 0 ? 1.0 : 0.25)));
}

async function renderScenario(sc, seed = 7) {
  const seconds = secondsFor(sc);
  const c = offlineContext(seconds);
  const audio = createAudio({ createContext: () => c, random: mulberry32(seed) });
  audio.setVolume(1);
  audio.unlock();
  if (sc.kind === 'sound') {
    audio.play(sc.id, sc.params);
  } else {
    // events at the same render quantum (128 frames) share one suspend: an offline context allows one suspend per frame
    const byFrame = new Map();
    for (const [t, fn] of sc.events) {
      const frame = t <= 0 ? 0 : Math.max(128, Math.ceil((t * SR) / 128) * 128);
      if (!byFrame.has(frame)) byFrame.set(frame, []);
      byFrame.get(frame).push(fn);
    }
    for (const [frame, fns] of byFrame) {
      if (frame === 0) for (const fn of fns) fn(audio);
      else c.suspend(frame / SR).then(() => { for (const fn of fns) fn(audio); c.resume(); });
    }
  }
  const buf = await c.startRendering();
  return { buf, seconds, debug: audio.getDebug() };
}

// ---------------------------------------------------------------- analysis
const db = (x) => (x > 1e-9 ? 20 * Math.log10(x) : -180);

function fftInPlace(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci;
        const ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti;
        re[a] += tr; im[a] += ti;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

function spectrogram(mono, N = 1024, hop = 512) {
  const frames = [];
  const win = new Float32Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1));
  const re = new Float32Array(N);
  const im = new Float32Array(N);
  for (let s = 0; s + N <= mono.length; s += hop) {
    for (let i = 0; i < N; i++) { re[i] = mono[s + i] * win[i]; im[i] = 0; }
    fftInPlace(re, im);
    const mag = new Float32Array(N / 2);
    for (let k = 0; k < N / 2; k++) mag[k] = Math.hypot(re[k], im[k]) / (N * 0.25);
    frames.push(mag);
  }
  return frames;
}

function analyse(buf, seconds) {
  const L = buf.getChannelData(0);
  const R = buf.numberOfChannels > 1 ? buf.getChannelData(1) : L;
  let peak = 0;
  let sum = 0;
  let dc = 0;
  const mono = new Float32Array(L.length);
  for (let i = 0; i < L.length; i++) {
    const m = (L[i] + R[i]) * 0.5;
    mono[i] = m;
    peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
    sum += m * m;
    dc += m;
  }
  // tail: last 10 ms window above -60 dBFS (pre master)
  const win = Math.floor(SR * 0.01);
  let lastActive = 0;
  for (let s = 0; s + win <= mono.length; s += win) {
    let e = 0;
    for (let i = 0; i < win; i++) e += mono[s + i] * mono[s + i];
    if (db(Math.sqrt(e / win) / MASTER) > -60) lastActive = (s + win) / SR;
  }
  const frames = spectrogram(mono);
  const avg = new Float32Array(512);
  for (const f of frames) for (let k = 0; k < 512; k++) avg[k] += f[k] * f[k];
  let num = 0;
  let den = 0;
  let low = 0;
  let mid = 0;
  let high = 0;
  for (let k = 1; k < 512; k++) {
    const hz = (k * SR) / 1024;
    num += hz * avg[k];
    den += avg[k];
    if (hz < 250) low += avg[k]; else if (hz < 2500) mid += avg[k]; else high += avg[k];
  }
  const tot = low + mid + high || 1;
  return {
    peakOut: peak,
    peakPreDb: db(peak / MASTER),
    rmsPreDb: db(Math.sqrt(sum / mono.length) / MASTER),
    tailS: lastActive,
    clipped: peak >= 0.999,
    dc: dc / mono.length,
    centroidHz: den > 0 ? num / den : 0,
    bandsPct: { low: Math.round((100 * low) / tot), mid: Math.round((100 * mid) / tot), high: Math.round((100 * high) / tot) },
    frames,
    mono,
    seconds,
  };
}

function summarise(sc, a, debug) {
  const recipe = sc.kind === 'sound' ? buildRecipe(sc.id, sc.params) : null;
  const target = recipe ? recipe.levelDb ?? null : null;
  return {
    trim: recipe ? recipe.trim : null,
    name: sc.name,
    id: sc.id ?? null,
    kind: sc.kind,
    targetDb: target,
    peakPreDb: +a.peakPreDb.toFixed(1),
    peakOut: +a.peakOut.toFixed(3),
    deltaDb: target === null ? null : +(a.peakPreDb - target).toFixed(1),
    rmsPreDb: +a.rmsPreDb.toFixed(1),
    tailS: +a.tailS.toFixed(2),
    clipped: a.clipped,
    dc: +a.dc.toFixed(5),
    centroidHz: Math.round(a.centroidHz),
    bandsPct: a.bandsPct,
    voices: debug.stats.played,
    evicted: debug.stats.evicted,
    dropped: debug.stats.dropped,
  };
}

// ---------------------------------------------------------------- drawing
function drawWave(canvas, a) {
  const g = canvas.getContext('2d');
  const { width: W, height: H } = canvas;
  g.clearRect(0, 0, W, H);
  g.fillStyle = '#10131a';
  g.fillRect(0, 0, W, H);
  const mid = H / 2;
  g.strokeStyle = '#2a3140';
  g.beginPath(); g.moveTo(0, mid); g.lineTo(W, mid); g.stroke();
  const per = a.mono.length / W;
  g.fillStyle = a.clipped ? '#ff5a4a' : '#7fd1f0';
  for (let x = 0; x < W; x++) {
    let lo = 0;
    let hi = 0;
    for (let i = Math.floor(x * per), e = Math.floor((x + 1) * per); i < e; i++) { const v = a.mono[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
    g.fillRect(x, mid - hi * mid, 1, Math.max(1, (hi - lo) * mid));
  }
  g.fillStyle = 'rgba(255,255,255,.55)';
  g.font = '10px system-ui';
  g.fillText(`${a.seconds.toFixed(2)} s`, W - 40, H - 4);
}

const RAMP = [[0, 0, 4], [30, 12, 80], [90, 20, 120], [170, 40, 110], [230, 90, 70], [250, 160, 40], [252, 230, 120]];
function ramp(t) {
  const x = Math.min(0.999, Math.max(0, t)) * (RAMP.length - 1);
  const i = Math.floor(x);
  const f = x - i;
  return RAMP[i].map((v, k) => Math.round(v + (RAMP[i + 1][k] - v) * f));
}

function drawSpec(canvas, a) {
  const g = canvas.getContext('2d');
  const { width: W, height: H } = canvas;
  const img = g.createImageData(W, H);
  const F = a.frames.length;
  const fmin = 50;
  const fmax = 20000;
  for (let y = 0; y < H; y++) {
    const hz = fmin * (fmax / fmin) ** (1 - y / (H - 1));
    const bin = Math.min(511, Math.max(1, Math.round((hz * 1024) / SR)));
    for (let x = 0; x < W; x++) {
      const m = a.frames[Math.min(F - 1, Math.floor((x / W) * F))][bin];
      const t = (db(m / MASTER) + 90) / 80;
      const [r, gg, b] = ramp(t);
      const o = (y * W + x) * 4;
      img.data[o] = r; img.data[o + 1] = gg; img.data[o + 2] = b; img.data[o + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  g.fillStyle = 'rgba(255,255,255,.55)';
  g.font = '10px system-ui';
  for (const hz of [100, 500, 1000, 5000, 10000]) {
    const y = (1 - Math.log(hz / fmin) / Math.log(fmax / fmin)) * (H - 1);
    g.fillRect(0, y, 6, 1);
    g.fillText(hz >= 1000 ? `${hz / 1000}k` : `${hz}`, 8, y + 3);
  }
}

// ---------------------------------------------------------------- WAV
function wavBytes(buf) {
  const ch = buf.numberOfChannels;
  const n = buf.length;
  const out = new DataView(new ArrayBuffer(44 + n * ch * 2));
  const w = (o, s) => { for (let i = 0; i < s.length; i++) out.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); out.setUint32(4, 36 + n * ch * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
  out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, ch, true); out.setUint32(24, SR, true);
  out.setUint32(28, SR * ch * 2, true); out.setUint16(32, ch * 2, true); out.setUint16(34, 16, true); w(36, 'data'); out.setUint32(40, n * ch * 2, true);
  const data = [...Array(ch).keys()].map((c) => buf.getChannelData(c));
  let o = 44;
  for (let i = 0; i < n; i++) for (let c = 0; c < ch; c++) { out.setInt16(o, Math.max(-1, Math.min(1, data[c][i])) * 32767, true); o += 2; }
  return new Uint8Array(out.buffer);
}

const toBase64 = (bytes) => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};

// ---------------------------------------------------------------- page
const scenarios = buildScenarios();
const rendered = new Map(); // name -> {buf, summary}

async function renderOne(name) {
  const sc = scenarios.find((s) => s.name === name);
  const { buf, seconds, debug } = await renderScenario(sc);
  const a = analyse(buf, seconds);
  const summary = summarise(sc, a, debug);
  rendered.set(name, { buf, a, summary });
  return summary;
}

async function renderAll() {
  const out = [];
  for (const sc of scenarios) out.push(await renderOne(sc.name));
  return out;
}

let live = null;
function liveEngine() {
  if (!live) {
    live = createAudio({});
    live.setVolume(Number(document.getElementById('vol').value) / 100);
  }
  live.unlock();
  return live;
}

function playScenarioLive(sc) {
  const a = liveEngine();
  if (sc.kind === 'sound') {
    a.play(sc.id, sc.params);
  } else {
    for (const [t, fn] of sc.events) setTimeout(() => fn(a), t * 1000);
  }
}

function badge(text, cls) {
  const s = document.createElement('span');
  s.className = `badge ${cls}`;
  s.textContent = text;
  return s;
}

function paintCard(card, summary, entry) {
  const stats = card.querySelector('.stats');
  stats.replaceChildren();
  const dev = summary.deltaDb;
  const level = summary.clipped ? 'bad' : dev === null ? 'ok' : Math.abs(dev) <= 2 ? 'good' : Math.abs(dev) <= 4 ? 'ok' : 'bad';
  stats.append(
    badge(`peak ${summary.peakPreDb} dBFS${summary.targetDb === null ? '' : ` (target ${summary.targetDb}, ${dev > 0 ? '+' : ''}${dev})`}`, level),
    badge(`out ${summary.peakOut}`, summary.clipped ? 'bad' : 'ok'),
    badge(`rms ${summary.rmsPreDb}`, 'ok'),
    badge(`tail ${summary.tailS}s`, 'ok'),
    badge(`centroid ${summary.centroidHz} Hz`, 'ok'),
    badge(`L/M/H ${summary.bandsPct.low}/${summary.bandsPct.mid}/${summary.bandsPct.high}%`, 'ok'),
  );
  drawWave(card.querySelector('.wave'), entry.a);
  drawSpec(card.querySelector('.spec'), entry.a);
}

function buildPage() {
  const grid = document.getElementById('grid');
  for (const sc of scenarios) {
    const card = document.createElement('section');
    card.className = `card ${sc.kind}`;
    card.dataset.name = sc.name;
    card.innerHTML = `<header><h2></h2><div class="btns"><button class="live">Play live</button><button class="off">Play render</button></div></header>
      <canvas class="wave" width="520" height="56"></canvas><canvas class="spec" width="520" height="120"></canvas><div class="stats"></div>`;
    card.querySelector('h2').textContent = sc.name;
    card.querySelector('.live').addEventListener('click', () => playScenarioLive(sc));
    card.querySelector('.off').addEventListener('click', async () => {
      if (!rendered.has(sc.name)) await renderOne(sc.name);
      const e = rendered.get(sc.name);
      const ctx = new AudioContext();
      const src = ctx.createBufferSource();
      src.buffer = e.buf;
      src.connect(ctx.destination);
      src.start();
    });
    grid.append(card);
  }
}

async function renderAllIntoPage() {
  const status = document.getElementById('status');
  let n = 0;
  let clipped = 0;
  let worst = 0;
  for (const sc of scenarios) {
    status.textContent = `rendering ${++n}/${scenarios.length}: ${sc.name}`;
    const s = await renderOne(sc.name);
    paintCard(document.querySelector(`[data-name="${CSS.escape(sc.name)}"]`), s, rendered.get(sc.name));
    if (s.clipped) clipped++;
    worst = Math.max(worst, s.peakOut);
  }
  status.textContent = `${scenarios.length} renders at volume 1 (master ${MASTER}); highest output peak ${worst.toFixed(3)}; clipped: ${clipped}`;
}

/** Real-time stress: every scenario started 40 ms apart on the real AudioContext, then a settle; returns the engine counters. */
async function playAllLive() {
  const a = liveEngine();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let maxVoices = 0;
  for (const sc of scenarios) {
    playScenarioLive(sc);
    maxVoices = Math.max(maxVoices, a.getDebug().voiceCount);
    await sleep(40);
  }
  await sleep(1500);
  a.update(0.016, { blade: { cutting: false, speed: 0, cutThreshold: 1000, trackingOk: true, head: { x: 960, y: 500 } }, snapshot: null, screen: 'menu' });
  const d = a.getDebug();
  return { state: a.ready, maxVoices, ...d, played: d.stats.played };
}

window.__lab = {
  playAllLive,
  names: () => scenarios.map((s) => s.name),
  renderOne,
  renderAll,
  wavBase64: (name) => toBase64(wavBytes(rendered.get(name).buf)),
  ready: true,
};

buildPage();
document.getElementById('vol').addEventListener('input', (e) => { if (live) live.setVolume(Number(e.target.value) / 100); });
document.getElementById('all').addEventListener('click', renderAllIntoPage);
document.getElementById('filter').addEventListener('input', (e) => {
  const q = e.target.value.toLowerCase();
  for (const c of document.querySelectorAll('.card')) c.style.display = c.dataset.name.toLowerCase().includes(q) ? '' : 'none';
});
const params = new URLSearchParams(location.search);
if (params.get('filter')) {
  document.getElementById('filter').value = params.get('filter');
  document.getElementById('filter').dispatchEvent(new Event('input'));
}
if (params.has('auto')) renderAllIntoPage();
