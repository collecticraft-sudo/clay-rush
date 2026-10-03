#!/usr/bin/env node
// build-audio.mjs: builds the sound of the Clay Rush presentation video (no voice-over) and writes composition/audio/mix.wav.
//   music : "Happy Beats / Business Moves Vol. 10" by Sascha Ende (ende.app), CC BY 4.0: the first TOTAL seconds, fade-in and fade-out
//   sfx   : Kenney sound effects (CC0). Two derived sounds are layered from Kenney files (see SFX below): a shotgun "boom" (pitched down
//           punch + metal transient + short echo) and a clay "crack" (ceramic plate + glass). Every shot and every broken clay of the
//           footage gets its sound at the exact frame, read from video/footage/<clip>.events.json (written by capture-gameplay.mjs);
//           the edit (which part of which clip plays when) comes from composition/edit.json, the same file build-edit.mjs uses.
// Usage: node video/tools/build-audio.mjs      (needs ffmpeg; the loudness to -16 LUFS is set by render-final.sh after the render)
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const video = path.resolve(here, '..');
const comp = path.join(video, 'composition');
const work = path.join(video, 'renders', 'audio'); // intermediate files (gitignored)
// The Kenney SFX (CC0) and the Ende.app music (CC BY 4.0) are not in the repository: point these at your copies.
const ASSET_ROOT = process.env.CLAY_VIDEO_ASSETS ?? path.join(os.homedir(), '.claude/skills/brag/assets');
const KENNEY = path.join(ASSET_ROOT, 'sfx');
const MUSIC_SRC = path.join(ASSET_ROOT, 'music/happy-beats-business-moves-vol-10-by-ende-dot-app.mp3');
const edit = JSON.parse(fs.readFileSync(path.join(comp, 'edit.json'), 'utf8'));
const TOTAL = edit.total;
const ff = (args) => execFileSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', ...args], { stdio: 'inherit' });
fs.mkdirSync(work, { recursive: true });
fs.mkdirSync(path.join(comp, 'audio'), { recursive: true });
const K = (f) => {
  const p = path.join(KENNEY, f);
  if (!fs.existsSync(p)) throw new Error('missing Kenney file ' + p);
  return p;
};
const STD = 'aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo';

// ---- 1. derived sound effects (layered from Kenney CC0 files) ----------------------------------------------------------
const SFX = {
  boom: { files: ['impact/impactPunch_heavy_000.ogg', 'impact/impactMetal_heavy_000.ogg', 'impact/impactWood_heavy_001.ogg'],
    fc: `[0:a]${STD},asetrate=30870,aresample=44100,lowpass=f=2600,volume=1.6[a];[1:a]${STD},highpass=f=1800,volume=0.55[b];[2:a]${STD},asetrate=35280,aresample=44100,volume=0.9[c];`
      + `[a][b][c]amix=inputs=3:normalize=0,aecho=0.7:0.5:70|140:0.28|0.14,afade=t=out:st=0.55:d=0.35,atrim=0:0.9,volume=1.8` },
  crack1: { files: ['impact/impactPlate_light_000.ogg', 'impact/impactGlass_light_001.ogg'],
    fc: `[0:a]${STD},volume=1.0[a];[1:a]${STD},asetrate=48510,aresample=44100,volume=0.7[b];[a][b]amix=inputs=2:normalize=0` },
  crack2: { files: ['impact/impactPlate_light_002.ogg', 'impact/impactGlass_light_003.ogg'],
    fc: `[0:a]${STD},volume=1.0[a];[1:a]${STD},asetrate=48510,aresample=44100,volume=0.7[b];[a][b]amix=inputs=2:normalize=0` },
  crack3: { files: ['impact/impactPlate_light_004.ogg', 'impact/impactGlass_light_002.ogg'],
    fc: `[0:a]${STD},volume=1.0[a];[1:a]${STD},asetrate=48510,aresample=44100,volume=0.7[b];[a][b]amix=inputs=2:normalize=0` },
  thunk: { files: ['impact/impactWood_light_002.ogg'], fc: `[0:a]${STD},asetrate=37485,aresample=44100,lowpass=f=1800` },
  whoosh: { files: ['casino/card-slide-3.ogg'], fc: `[0:a]${STD}` },
  swipe: { files: ['casino/card-slide-1.ogg'], fc: `[0:a]${STD}` },
  stamp: { files: ['impact/impactPunch_heavy_001.ogg', 'impact/impactPlate_medium_001.ogg'],
    fc: `[0:a]${STD},volume=1.2[a];[1:a]${STD},volume=0.5[b];[a][b]amix=inputs=2:normalize=0` },
};
const used = new Set();
for (const [name, s] of Object.entries(SFX)) {
  const args = [];
  s.files.forEach((f) => { args.push('-i', K(f)); used.add(f); });
  ff([...args, '-filter_complex', `${s.fc}[o]`, '-map', '[o]', '-ar', '44100', '-ac', '2', path.join(work, `${name}.wav`)]);
}

// ---- 2. cue list -------------------------------------------------------------------------------------------------------
const cues = []; // {t, s (sfx name), g}
for (const c of edit.cues || []) cues.push({ t: c.t, s: c.sfx, g: c.gain ?? 1 });
let crackN = 0, nShots = 0, nHits = 0;
for (const seg of edit.segments) {
  if (!seg.events) continue;
  const evFile = path.join(video, 'footage', `${seg.events}.events.json`);
  if (!fs.existsSync(evFile)) throw new Error('missing footage events ' + evFile);
  const g = seg.sfxGain ?? 1;
  for (const e of JSON.parse(fs.readFileSync(evFile, 'utf8'))) {
    if (e.t < seg.mediaStart - 1e-6 || e.t >= seg.mediaStart + seg.dur - 0.02) continue;
    const t = seg.start + (e.t - seg.mediaStart);
    if (e.type === 'shot') { cues.push({ t, s: 'boom', g: 0.95 * g }); nShots++; }
    else if (e.type === 'hit') { cues.push({ t: t + 0.01, s: `crack${(crackN++ % 3) + 1}`, g: 0.6 * g }); nHits++; }
    else if (e.type === 'launch' && seg.launchSound !== false) cues.push({ t, s: 'thunk', g: 0.35 * g });
  }
}
cues.sort((a, b) => a.t - b.t);

// ---- 3. sfx bus and final mix ------------------------------------------------------------------------------------------
{
  const names = [...new Set(cues.map((c) => c.s))];
  const idx = new Map(names.map((n, i) => [n, i]));
  const count = new Map();
  cues.forEach((c) => count.set(c.s, (count.get(c.s) || 0) + 1));
  const args = [];
  names.forEach((n) => args.push('-i', path.join(work, `${n}.wav`)));
  const fc = [];
  names.forEach((n, i) => {
    const k = count.get(n);
    fc.push(k === 1 ? `[${i}:a]anull[s${i}_0]` : `[${i}:a]asplit=${k}${Array.from({ length: k }, (_, j) => `[s${i}_${j}]`).join('')}`);
  });
  const usedK = new Map();
  const labels = [];
  cues.forEach((c, j) => {
    const i = idx.get(c.s);
    const k = usedK.get(c.s) || 0;
    usedK.set(c.s, k + 1);
    const ms = Math.max(0, Math.round(c.t * 1000));
    fc.push(`[s${i}_${k}]volume=${c.g.toFixed(3)},adelay=${ms}|${ms}[c${j}]`);
    labels.push(`[c${j}]`);
  });
  fc.push(`${labels.join('')}amix=inputs=${labels.length}:normalize=0:duration=longest,apad=whole_dur=${TOTAL},atrim=0:${TOTAL}[o]`);
  fs.writeFileSync(path.join(work, 'sfx.filter'), fc.join(';\n'));
  ff([...args, '-/filter_complex', path.join(work, 'sfx.filter'), '-map', '[o]', '-ar', '44100', '-ac', '2', path.join(work, 'sfx.wav')]);
}
const M = edit.music;
ff(['-i', MUSIC_SRC, '-ss', String(M.from ?? 0), '-t', String(TOTAL), '-af', `${STD},afade=t=in:st=0:d=${M.fadeIn},afade=t=out:st=${(TOTAL - M.fadeOut).toFixed(3)}:d=${M.fadeOut},volume=${M.gain}`,
  '-ar', '44100', '-ac', '2', path.join(work, 'music.wav')]);
ff(['-i', path.join(work, 'music.wav'), '-i', path.join(work, 'sfx.wav'), '-filter_complex',
  `[0:a][1:a]amix=inputs=2:normalize=0:duration=first,alimiter=limit=0.5:attack=1:release=60:level=0:asc=1[o]`, '-map', '[o]', '-ar', '48000', '-ac', '2', '-c:a', 'pcm_s16le', path.join(comp, 'audio', 'mix.wav')]);
fs.writeFileSync(path.join(work, 'cues.json'), JSON.stringify({ shots: nShots, hits: nHits, kenneyFiles: [...used].sort(), cues }, null, 1));
console.log(`audio: ${cues.length} cues (${nShots} gunshots, ${nHits} clay cracks), ${used.size} Kenney files -> composition/audio/mix.wav (${TOTAL} s)`);
