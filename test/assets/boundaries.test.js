// Guards of docs/assets-integration.md 8.7: the art is a skin, never game state; no hard-coded asset path; image loading lives in one file;
// offline. They scan the sources, so they hold for whoever writes the renderer, the stage and the screens.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const JS = join(ROOT, 'public', 'js');
const ASSETS = join(ROOT, 'public', 'assets');

function walk(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.(js|mjs)$/.test(name)) out.push(p);
  }
  return out;
}

const files = walk(JS).map((f) => ({ file: f, rel: relative(JS, f).split(sep).join('/') }));
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
const manifest = JSON.parse(readFileSync(join(ASSETS, 'manifest.json'), 'utf8'));

const LOADER = 'render/assets.js';

test('the art is a skin: game/, motion/, input/ and shared/ import neither assets.js, stage.js nor art-config.js', () => {
  const offenders = [];
  for (const { file, rel } of files) {
    if (!/^(game|motion|input|shared)\//.test(rel)) continue;
    const src = stripComments(readFileSync(file, 'utf8'));
    for (const m of src.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)) {
      if (/(^|\/)(assets|stage|art-config)\.js$/.test(m[1])) offenders.push(`${rel}: imports ${m[1]}`);
    }
    if (/\b(ART_CONFIG|NULL_ASSETS|createAssets|createStage)\b/.test(src)) offenders.push(`${rel}: mentions an art symbol`);
  }
  assert.deepEqual(offenders, []);
  assert.ok(files.some((f) => f.rel.startsWith('game/')), 'the scan found the game modules');
});

test('no hard-coded asset path: no string in public/js names a shipped file, a folder of public/assets or PROVENANCE.csv; images are named by id and found through the manifest', () => {
  const needles = [...manifest.assets.map((a) => a.file), 'PROVENANCE.csv'];
  const folder = /['"`][^'"`\n]*\bassets\/(?:sprites|fx|icons|ui|backgrounds)\b/;
  const extension = /['"`][^'"`\n]*\.(?:png|jpe?g|webp|gif|avif)\b[^'"`\n]*['"`]/i;
  const offenders = [];
  for (const { file, rel } of files) {
    const src = stripComments(readFileSync(file, 'utf8'));
    for (const needle of needles) if (src.includes(needle)) offenders.push(`${rel}: contains "${needle}"`);
    if (folder.test(src)) offenders.push(`${rel}: names a folder of public/assets`);
    if (extension.test(src)) offenders.push(`${rel}: a string literal with an image file extension`);
    if (rel !== LOADER && /['"`]manifest\.json['"`]/.test(src)) offenders.push(`${rel}: only ${LOADER} reads the manifest`);
  }
  assert.deepEqual(offenders, []);
  // the one allowed reference to the folder is the base URL in the data-only config
  const config = readFileSync(join(JS, 'render', 'art-config.js'), 'utf8');
  assert.match(config, /baseUrl:\s*'assets\/'/);
});

test('only the loader creates images: no `new Image` or `createImageBitmap` outside render/assets.js, and no fetch in render/, ui/, audio/, game/, motion/ or shared/ except the loader', () => {
  const offenders = [];
  for (const { file, rel } of files) {
    if (rel === LOADER) continue;
    const src = stripComments(readFileSync(file, 'utf8'));
    if (/\bnew\s+Image\s*\(/.test(src) || /\bcreateImageBitmap\b/.test(src) || /\bImageBitmap\b/.test(src)) offenders.push(`${rel}: creates images`);
    if (/\bnew\s+Audio\s*\(|\bHTMLImageElement\b/.test(src)) offenders.push(`${rel}: media element`);
    // the bridge code in input/ and app.js use fetch for /__bridge/*; nothing that draws may fetch
    if (/^(render|ui|audio|game|motion|shared)\//.test(rel) && /\bfetch\s*\(/.test(src)) offenders.push(`${rel}: calls fetch`);
  }
  assert.deepEqual(offenders, []);
});

test('art-config.js is data only: no import, no function, deeply frozen, and every leaf is a number, string or boolean', async () => {
  const src = stripComments(readFileSync(join(JS, 'render', 'art-config.js'), 'utf8'));
  assert.doesNotMatch(src, /^\s*import\b/m, 'no imports');
  assert.doesNotMatch(src, /=>|\bfunction\b|\bnew\b|\bclass\b|\bMath\./, 'no code, only data');
  const { ART_CONFIG } = await import('../../public/js/render/art-config.js');
  const problems = [];
  const visit = (value, path) => {
    if (value !== null && typeof value === 'object') {
      if (!Object.isFrozen(value)) problems.push(`${path} is not frozen`);
      for (const [k, v] of Object.entries(value)) visit(v, `${path}.${k}`);
    } else if (!['number', 'string', 'boolean'].includes(typeof value)) problems.push(`${path} is a ${typeof value}`);
  };
  visit(ART_CONFIG, 'ART_CONFIG');
  assert.deepEqual(problems, []);
  assert.equal(ART_CONFIG.baseUrl, 'assets/');
  // every stage group of the manifest has a layerAlpha row, and every house sprite the config sizes exists in the manifest
  const stages = Object.keys(manifest.groups).filter((g) => g.startsWith('stage:')).map((g) => g.slice(6));
  assert.deepEqual(stages.sort(), ['alpine', 'hills', 'meadow']);
  for (const stage of stages) assert.ok(ART_CONFIG.stage.layerAlpha[stage], `layerAlpha.${stage}`);
  const ids = new Set(manifest.assets.map((a) => a.id));
  for (const id of Object.keys(ART_CONFIG.houses.widthM)) assert.ok(ids.has(id), `house ${id}`);
});

test('the loader module can be imported in Node with no window, document, Image or fetch (architecture rule 6), and NULL_ASSETS is frozen and inert', async () => {
  for (const name of ['window', 'document', 'Image']) assert.equal(typeof globalThis[name], 'undefined', `Node has no ${name}`);
  const mod = await import('../../public/js/render/assets.js');
  assert.ok(Object.isFrozen(mod.NULL_ASSETS));
  assert.equal(mod.NULL_ASSETS.isNull, true);
  assert.equal(mod.NULL_ASSETS.has('clay_std_tilt'), false);
  assert.equal(mod.NULL_ASSETS.get('clay_std_tilt'), null);
  assert.equal((await mod.NULL_ASSETS.load('core')).state, 'disabled');
});

test('offline: the manifest and the provenance file contain no URL, and nothing in public/assets is a script or a page', () => {
  for (const name of ['manifest.json', 'PROVENANCE.csv']) assert.doesNotMatch(readFileSync(join(ASSETS, name), 'utf8'), /https?:\/\/|\/\/[a-z0-9.-]+\.[a-z]{2,}/i, name);
  const bad = [];
  const scan = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) scan(join(dir, e.name));
      else if (!/\.(png|jpg|json|csv)$/.test(e.name) && !(/[\\/]fonts$/.test(dir) && /\.(woff2|txt)$/.test(e.name))) bad.push(join(dir, e.name));
    }
  };
  scan(ASSETS);
  assert.deepEqual(bad, [], 'only png, jpg, json and csv files ship in public/assets, plus woff2 fonts and their licence texts in fonts/');
});
