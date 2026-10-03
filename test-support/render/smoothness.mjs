// Clay motion smoothness of the REAL game in headless Chrome (dev tool and e2e helper). OWNER: Render & Audio engineer.
//   node test-support/render/smoothness.mjs [--seconds 14] [--frames <dir>] [--json <file>] [--check]
// For each difficulty: a Classic round under ?clock=manual (autoLaunch calls every pull), stepped 1/60 s at a time; after every step the page
// draws and the script reads, per airborne target, what the world renderer DREW (world.getDebug().drawn: centre, width, height, rotation,
// the two sprite frames and their blend) plus the raw snapshot. From the tracks it computes:
//   posJerk   second difference of the drawn centre, px per frame^2 (a ballistic clay at 60 fps stays well under 1 px)
//   sizeJerk  second difference of the drawn width, relative to the width
//   aspectStep  largest change of the drawn height/width ratio between two frames (a frame swap without blend is a pop)
//   rotJerk   second difference of the drawn rotation, rad per frame^2
//   pops      sprite changes between two frames that were not blended (frame A changed while its blend weight was not 0)
// Every few frames a shot at one clay of the pull (press('fire') at the clay) so hits, hit-stop and the second clay of a double are in the
// data; frames during a kill cam are excluded from posJerk (the slow motion is intended) and reported apart.
// With --frames <dir>: a 2 s sequence of consecutive frames (PNG, the area around the clays) of the Normal run.

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startE2e } from '../e2e/env.js';

/** posJerk allows the natural curvature of a projected flight (a clay going away decelerates on screen: about 1.4 px/frame^2 at most). */
export const THRESHOLDS = Object.freeze({ posJerk: 2.5, sizeJerkRel: 0.02, aspectStep: 0.08, rotJerk: 0.02, pops: 0 });

/** The runs: Classic on each difficulty (trap singles cross the horizon: the old frame swaps), Time Attack on the hills (doubles: a hit
 * while the other clay flies, the old hit-stop freeze). */
export const RUNS = Object.freeze([
  { name: 'classic-easy', mode: 'classic', difficulty: 'easy' },
  { name: 'classic-normal', mode: 'classic', difficulty: 'normal' },
  { name: 'classic-hard', mode: 'classic', difficulty: 'hard' },
  { name: 'timeattack-hills-normal', mode: 'timeattack', difficulty: 'normal', stage: 'hills' },
]);

const PAGE_RUN = `(async (o) => {
  const C = window.__clay;
  C.start(o.mode, { difficulty: o.difficulty, seed: o.seed, stage: o.stage, skipCountdown: true, autoLaunch: true });
  const frames = [];
  const dt = 1000 / 60;
  let shotAt = -1;
  for (let f = 0; f < o.frames; f++) {
    C.advance(dt);
    C.debug.draw();
    const s = C.snapshot();
    if (s.screen !== 'playing') break;
    const w = C.debug.getWorld();
    const drawn = (w && w.drawn) ? w.drawn : null;
    frames.push({
      f, timeScale: s.timeScale, killCam: !!s.killCam, phase: s.phase,
      raw: s.targets.map((t) => ({ id: t.id, sx: t.sx, sy: t.sy, rPx: t.rPx, rot: t.rot, frame: t.frame, kind: t.kind, age: t.ageS })),
      drawn,
    });
    // shoot one clay of a pull now and then (centre), so hits and hit-stops are measured too
    const tg = s.targets.find((t) => t.ageS > 0.45 && t.sx > 100 && t.sx < 1820 && t.sy > 80 && t.sy < 1000);
    if (o.shoot && tg && f - shotAt > 50 && s.shells.loaded > 0) { C.aim(tg.sx, tg.sy); C.press('fire'); shotAt = f; }
  }
  return frames;
})`;

function percentile(arr, p) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
}

/** Metrics of one run. `source` 'drawn' (the renderer's records) or 'raw' (the snapshot, i.e. what the old renderer drew). */
export function analyse(frames, source = 'drawn') {
  const tracks = new Map();
  for (const fr of frames) {
    const list = source === 'drawn' && fr.drawn ? fr.drawn : fr.raw.map((t) => ({ id: t.id, x: t.sx, y: t.sy, w: 2 * t.rPx, h: 2 * t.rPx * aspectOfFrame(t.frame), rot: t.rot, a: t.frame, b: t.frame, wB: 0 }));
    for (const d of list) {
      if (!tracks.has(d.id)) tracks.set(d.id, []);
      tracks.get(d.id).push({ ...d, f: fr.f, ts: fr.timeScale, kc: fr.killCam });
    }
  }
  const posJ = [];
  const posJstop = [];
  const sizeJ = [];
  const aspect = [];
  const rotJ = [];
  let pops = 0;
  let worst = null;
  for (const [id, tr] of tracks) {
    for (let i = 1; i < tr.length; i++) {
      const a = tr[i - 1];
      const b = tr[i];
      if (b.f !== a.f + 1) continue;
      aspect.push(Math.abs(b.h / b.w - a.h / a.w));
      if (a.a !== b.a && a.wB !== 1 && b.wB !== 0) pops++; // the base frame changed under a visible blend
      if (a.a !== b.a && a.b === a.a && b.b === b.a) pops++; // a bare swap
      if (i < 2) continue;
      const z = tr[i - 2];
      if (z.f !== a.f - 1) continue;
      const jx = b.x - 2 * a.x + z.x;
      const jy = b.y - 2 * a.y + z.y;
      const j = Math.hypot(jx, jy);
      const slow = (q) => q.kc || (q.ts > 0 && q.ts < 1); // kill-cam slow motion is intended; a hit-stop freeze (ts 0) counts
      const slowed = slow(z) || slow(a) || slow(b);
      (slowed ? posJstop : posJ).push(j);
      if (!slowed && (!worst || j > worst.j)) worst = { id, f: b.f, j };
      sizeJ.push(Math.abs(b.w - 2 * a.w + z.w) / b.w);
      let r = b.rot - 2 * a.rot + z.rot;
      r = Math.atan2(Math.sin(r), Math.cos(r));
      if (!slowed) rotJ.push(Math.abs(r));
    }
  }
  return {
    tracks: tracks.size,
    samples: posJ.length,
    posJerk: { p50: percentile(posJ, 0.5), p99: percentile(posJ, 0.99), max: Math.max(0, ...posJ) },
    posJerkSlowed: { max: Math.max(0, ...posJstop), n: posJstop.length },
    sizeJerkRel: { p99: percentile(sizeJ, 0.99), max: Math.max(0, ...sizeJ) },
    aspectStep: { p99: percentile(aspect, 0.99), max: Math.max(0, ...aspect) },
    rotJerk: { p99: percentile(rotJ, 0.99), max: Math.max(0, ...rotJ) },
    pops,
    worst,
  };
}

/** Height / width of the clay pictures of the manifest (the old renderer swapped between these). */
function aspectOfFrame(frame) {
  return { tilt: 177 / 209, below: 149 / 223, edge: 224 / 76, gold: 172 / 217, rabbit: 232 / 113 }[frame] ?? 1;
}

const round = (o) => JSON.parse(JSON.stringify(o, (k, v) => (typeof v === 'number' ? Math.round(v * 1000) / 1000 : v)));

export async function measure({ seconds = 14, runs = RUNS, framesDir = null, seed = 11, shoot = true } = {}) {
  const env = await startE2e();
  if (env.skip) return { skip: env.skip };
  const out = {};
  try {
    for (const run of runs) {
      const { difficulty } = run;
      const page = await env.openGame(`input=mouse&mode=${run.mode}&difficulty=${difficulty}&seed=${seed}&mute=1&clock=manual&skipsafety=1`);
      const frames = await page.evaluate(`${PAGE_RUN}(${JSON.stringify({ ...run, seed, frames: Math.round(seconds * 60), shoot })})`);
      out[run.name] = { drawn: round(analyse(frames, 'drawn')), raw: round(analyse(frames, 'raw')), frames: frames.length, hasDrawn: frames.some((f) => f.drawn && f.drawn.length > 0) };
      if (framesDir && run.name === 'classic-normal') {
        mkdirSync(framesDir, { recursive: true });
        // replay to a moment with clays in the air and capture 2 s of consecutive frames
        await page.evaluate(`(() => { const C = window.__clay; C.start('classic', { difficulty: 'normal', seed: ${seed}, skipCountdown: true, autoLaunch: true });
          for (let i = 0; i < 600; i++) { C.advance(1000 / 60); if (C.snapshot().targets.some((t) => t.ageS > 0.2)) break; } })()`);
        for (let i = 0; i < 120; i++) {
          await page.evaluate('window.__clay.advance(1000 / 60); window.__clay.debug.draw();');
          const { data } = await page.send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: 1920, height: 1080, scale: 0.5 } });
          writeFileSync(path.join(framesDir, `f${String(i).padStart(3, '0')}.png`), Buffer.from(data, 'base64'));
        }
      }
      await page.close();
    }
  } finally {
    await env.close();
  }
  return out;
}

/** Problems of a measurement against THRESHOLDS (empty = smooth). */
export function problems(res) {
  const bad = [];
  for (const [d, r] of Object.entries(res)) {
    const m = r.drawn;
    if (!r.hasDrawn) bad.push(`${d}: the renderer reported no drawn targets`);
    if (m.posJerk.max > THRESHOLDS.posJerk) bad.push(`${d}: position jerk ${m.posJerk.max} px/frame^2`);
    if (m.sizeJerkRel.max > THRESHOLDS.sizeJerkRel) bad.push(`${d}: size jerk ${m.sizeJerkRel.max}`);
    if (m.aspectStep.max > THRESHOLDS.aspectStep) bad.push(`${d}: aspect step ${m.aspectStep.max}`);
    if (m.rotJerk.max > THRESHOLDS.rotJerk) bad.push(`${d}: rotation jerk ${m.rotJerk.max}`);
    if (m.pops > THRESHOLDS.pops) bad.push(`${d}: ${m.pops} sprite pops`);
  }
  return bad;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const arg = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };
  const res = await measure({ seconds: Number(arg('--seconds', 14)), framesDir: arg('--frames', null) });
  console.log(JSON.stringify(res, null, 1));
  if (arg('--json', null)) writeFileSync(arg('--json'), JSON.stringify(res, null, 1));
  if (process.argv.includes('--check')) {
    const bad = problems(res);
    if (bad.length) { console.error(bad.join('\n')); process.exit(1); }
  }
  process.exit(0);
}
