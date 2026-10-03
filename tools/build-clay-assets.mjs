// Build public/assets/ (the OPTIONAL art of Clay Rush) from design/: backdrop layers, sprites, the gun, the logo and the fonts.
// Writes public/assets/manifest.json (the format read by public/js/render/assets.js) and public/assets/PROVENANCE.csv.
// A developer tool: the game never needs it at runtime and runs procedurally without any of these files.
//
// Usage: node tools/build-clay-assets.mjs            (needs ffmpeg on the PATH)
//
// Inputs:  design/raw/bg_<stage>_far_v1.png, bg_<stage>_near_v1.png, gun_v1.png, logo_v1.png (Higgsfield GPT Image 2.5 outputs)
//          design/sprites/*.png (cut from the sheets with design/tools/slice-sheet.mjs)
//          design/PROVENANCE-jobs.csv (Higgsfield job ids)
//          public/assets/fonts/*.woff2 (subset with pyftsubset, see docs/REFERENCE.md)

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RAW = path.join(ROOT, 'design/raw');
const SPRITES = path.join(ROOT, 'design/sprites');
const OUT = path.join(ROOT, 'public/assets');

const STAGES = ['meadow', 'hills', 'alpine'];
const FAR_WIDTH = 2560;
const NEAR_WIDTH = 1920;

function decodePng(buf) {
  let p = 8;
  let w = 0;
  let h = 0;
  let ct = 0;
  let bd = 0;
  const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString('ascii', p + 4, p + 8);
    const data = buf.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
      bd = data[8];
      ct = data[9];
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    p += 12 + len;
  }
  const bpp = ct === 6 ? 4 : ct === 2 ? 3 : 0;
  if (bd !== 8 || !bpp) throw new Error(`unsupported PNG (depth ${bd}, colour type ${ct})`);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * bpp;
  const out = Buffer.alloc(h * stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? out[dst + x - bpp] : 0;
      const b = y > 0 ? out[dst - stride + x] : 0;
      const c = x >= bpp && y > 0 ? out[dst - stride + x - bpp] : 0;
      let v = raw[src + x];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const pp = a + b - c;
        const pa = Math.abs(pp - a);
        const pb = Math.abs(pp - b);
        const pc = Math.abs(pp - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      out[dst + x] = v & 255;
    }
  }
  return { w, h, bpp, data: out };
}

/** Bounding box of the pixels whose alpha is above 24 (the whole image for an opaque file). */
function contentBox(file) {
  const { w, h, bpp, data } = decodePng(fs.readFileSync(file));
  if (bpp === 3) return { width: w, height: h, box: { x: 0, y: 0, w, h } };
  let x0 = w;
  let y0 = h;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (data[(y * w + x) * 4 + 3] > 24) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return { width: w, height: h, box: { x: 0, y: 0, w: 0, h: 0 } };
  return { width: w, height: h, box: { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 } };
}

const ffmpeg = (args) => execFileSync('ffmpeg', ['-loglevel', 'error', '-y', ...args], { stdio: 'inherit' });
const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function kindOf(id) {
  if (id.startsWith('clay_')) return 'target';
  if (id.startsWith('shard_')) return 'shard';
  if (id.startsWith('fx_')) return 'fx';
  if (id.startsWith('house_')) return 'house';
  if (id.startsWith('icon_')) return 'icon';
  return 'ui';
}

fs.mkdirSync(path.join(OUT, 'backgrounds'), { recursive: true });
fs.mkdirSync(path.join(OUT, 'sprites'), { recursive: true });
fs.mkdirSync(path.join(OUT, 'ui'), { recursive: true });

const assets = [];
const groups = { core: [] };
const sources = {}; // id -> raw source file name (for the provenance)

// 1. backdrop layers: far = opaque JPEG at 2560 x 1440, near = transparent PNG at 1920 x 1080
for (const stage of STAGES) {
  const g = `stage:${stage}`;
  groups[g] = [];
  const farSrc = path.join(RAW, `bg_${stage}_far_v1.png`);
  const nearSrc = path.join(RAW, `bg_${stage}_near_v1.png`);
  if (fs.existsSync(farSrc)) {
    const file = `backgrounds/bg_${stage}_far.jpg`;
    ffmpeg(['-i', farSrc, '-vf', `scale=${FAR_WIDTH}:${(FAR_WIDTH * 9) / 16}:flags=lanczos`, '-q:v', '3', path.join(OUT, file)]);
    const w = FAR_WIDTH;
    const h = (FAR_WIDTH * 9) / 16;
    assets.push({ id: `bg_${stage}_far`, file, kind: 'layer', group: g, width: w, height: h, contentBox: { x: 0, y: 0, w, h }, anchor: { x: w / 2, y: h / 2 } });
    groups[g].push(`bg_${stage}_far`);
    sources[`bg_${stage}_far`] = path.basename(farSrc);
  }
  if (fs.existsSync(nearSrc)) {
    const file = `backgrounds/bg_${stage}_near.png`;
    ffmpeg(['-i', nearSrc, '-vf', `scale=${NEAR_WIDTH}:${(NEAR_WIDTH * 9) / 16}:flags=lanczos,format=rgba`, '-compression_level', '9', path.join(OUT, file)]);
    const cb = contentBox(path.join(OUT, file));
    assets.push({ id: `bg_${stage}_near`, file, kind: 'layer', group: g, width: cb.width, height: cb.height, contentBox: cb.box, anchor: { x: cb.width / 2, y: cb.height / 2 } });
    groups[g].push(`bg_${stage}_near`);
    sources[`bg_${stage}_near`] = path.basename(nearSrc);
  }
}

// 2. sprites: copied as cut by slice-sheet.mjs (square canvases, content centred)
const SHEET_OF = { clay: 'sheet_clays_v1.png', shard: 'sheet_shards_v1.png', fx: 'sheet_fx_v1.png', house: 'sheet_houses_v1.png', icon: 'sheet_icons_v1.png' };
for (const name of fs.readdirSync(SPRITES).filter((f) => f.endsWith('.png')).sort()) {
  const id = name.replace(/\.png$/, '');
  const file = `sprites/${name}`;
  fs.copyFileSync(path.join(SPRITES, name), path.join(OUT, file));
  const cb = contentBox(path.join(OUT, file));
  const entry = { id, file, kind: kindOf(id), group: 'core', width: cb.width, height: cb.height, contentBox: cb.box, anchor: { x: cb.width / 2, y: cb.height / 2 } };
  if (entry.kind === 'target') {
    // the body circle that the game's radius maps to: half of the larger content side
    entry.body = { cx: cb.box.x + cb.box.w / 2, cy: cb.box.y + cb.box.h / 2, r: Math.max(cb.box.w, cb.box.h) / 2 };
  }
  if (entry.kind === 'house') {
    // houses stand on the ground: anchor at the middle of the bottom of the content
    entry.anchor = { x: cb.box.x + cb.box.w / 2, y: cb.box.y + cb.box.h };
  }
  assets.push(entry);
  groups.core.push(id);
  sources[id] = SHEET_OF[id.split('_')[0]] ?? '';
}

// 3. the gun and the logo (single images, trimmed to their content plus a margin)
for (const [id, src, maxW] of [['gun_ou', 'gun_v1.png', 1024], ['logo_title', 'logo_v1.png', 1344]]) {
  const srcPath = path.join(RAW, src);
  if (!fs.existsSync(srcPath)) continue;
  const c = contentBox(srcPath).box;
  const m = 6;
  const x = Math.max(0, c.x - m);
  const y = Math.max(0, c.y - m);
  const file = `ui/${id}.png`;
  ffmpeg(['-i', srcPath, '-vf', `crop=${c.w + 2 * m}:${c.h + 2 * m}:${x}:${y},scale='min(${maxW},iw)':-1:flags=lanczos,format=rgba`, '-compression_level', '9', path.join(OUT, file)]);
  const cb = contentBox(path.join(OUT, file));
  const entry = { id, file, kind: 'ui', group: 'core', width: cb.width, height: cb.height, contentBox: cb.box, anchor: { x: cb.width / 2, y: cb.height / 2 } };
  if (id === 'gun_ou') {
    // the muzzle: the top-left end of the barrels (measured on the source: the barrels point up-left), as a fraction of the image
    entry.muzzle = { x: 0.05, y: 0.045 };
    entry.anchor = { x: cb.width, y: cb.height }; // the gun is drawn from the bottom-right corner of the screen
  }
  assets.push(entry);
  groups.core.push(id);
  sources[id] = src;
}

// 4. fonts (already subset): listed with their sizes and hashes
const fonts = [
  { id: 'display', family: 'ClayDisplay', file: 'fonts/range-display.woff2', weight: '100 900', source: 'Bebas Neue (Dharma Type), google/fonts ofl/bebasneue', licenseFile: 'fonts/OFL-bebasneue.txt' },
  { id: 'ui600', family: 'ClayUI', file: 'fonts/range-ui-600.woff2', weight: '100 650', source: 'Barlow SemiBold (Jeremy Tribby), google/fonts ofl/barlow', licenseFile: 'fonts/OFL-barlow.txt' },
  { id: 'ui700', family: 'ClayUI', file: 'fonts/range-ui-700.woff2', weight: '651 900', source: 'Barlow Bold (Jeremy Tribby), google/fonts ofl/barlow', licenseFile: 'fonts/OFL-barlow.txt' },
].filter((f) => fs.existsSync(path.join(OUT, f.file)))
  .map((f) => ({ ...f, format: 'woff2', style: 'normal', license: 'SIL-OFL-1.1', bytes: fs.statSync(path.join(OUT, f.file)).size, sha256: sha256(path.join(OUT, f.file)) }));

for (const a of assets) a.bytes = fs.statSync(path.join(OUT, a.file)).size;
const totalBytes = assets.reduce((s, a) => s + a.bytes, 0);
const manifest = {
  version: 1,
  generator: 'tools/build-clay-assets.mjs',
  totalBytes,
  groups,
  fonts,
  assets,
};
fs.writeFileSync(path.join(OUT, 'manifest.json'), `${JSON.stringify(manifest, null, 1)}\n`);

// provenance: one row per shipped file, with the Higgsfield job id of its source
const jobs = Object.fromEntries(
  fs.readFileSync(path.join(ROOT, 'design/PROVENANCE-jobs.csv'), 'utf8').trim().split('\n').slice(1).map((l) => l.split(','))
    .map(([file, job, model, quality, res]) => [file, `${job},${model},${quality},${res}`]),
);
const rows = ['id,file,bytes,source,higgsfield_job_id,model,quality,resolution'];
for (const a of assets) rows.push(`${a.id},${a.file},${a.bytes},${sources[a.id]},${jobs[sources[a.id]] ?? ',,,'}`);
for (const f of fonts) rows.push(`font_${f.id},${f.file},${f.bytes},"${f.source}",,,,`);
fs.writeFileSync(path.join(OUT, 'PROVENANCE.csv'), `${rows.join('\n')}\n`);

console.log(JSON.stringify({ assets: assets.length, fonts: fonts.length, totalBytes, groups: Object.fromEntries(Object.entries(groups).map(([k, v]) => [k, v.length])) }));
