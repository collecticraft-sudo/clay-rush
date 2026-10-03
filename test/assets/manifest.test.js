// public/assets/manifest.json and the shipped files (architecture C-10, C-11, section 7): the ids the contract promises, groups, sizes,
// alpha, the extra fields (clay bodies, house anchors, gun muzzle), the fonts, and that the render code knows every id it draws.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodePng, readPngHeader } from '../../test-support/stage/png.js';
import { FONT_FILES } from '../../public/js/render/fonts.js';
import { PROC_META } from '../../public/js/render/painters.js';
import { FRAME_SPRITE } from '../../public/js/render/world.js';
import { layerAssetId, STAGE_IDS } from '../../public/js/render/stage.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ASSETS = join(ROOT, 'public', 'assets');
const manifest = JSON.parse(readFileSync(join(ASSETS, 'manifest.json'), 'utf8'));
const byId = new Map(manifest.assets.map((a) => [a.id, a]));

const IDS = {
  layers: ['bg_meadow_far', 'bg_meadow_near', 'bg_hills_far', 'bg_hills_near', 'bg_alpine_far', 'bg_alpine_near'],
  targets: ['clay_std_tilt', 'clay_std_below', 'clay_std_edge', 'clay_gold_tilt', 'clay_rabbit'],
  shards: ['shard_std_1', 'shard_std_2', 'shard_std_3', 'shard_std_4', 'shard_std_5', 'shard_std_6', 'shard_gold_1', 'shard_gold_2'],
  fx: ['fx_flash_star', 'fx_flash_side', 'fx_smoke_puff', 'fx_smoke_trail', 'fx_dust_burst', 'fx_shell_casing'],
  houses: ['house_trap', 'house_skeet', 'house_tower'],
  icons: ['icon_shell_full', 'icon_shell_empty', 'icon_clay', 'icon_trophy', 'icon_wind', 'icon_clock', 'icon_star'],
  ui: ['gun_ou', 'logo_title'],
};

/** Width and height of a baseline or progressive JPEG (SOF0..SOF2), and its component count. */
function jpegInfo(buf) {
  let i = 2;
  while (i < buf.length) {
    if (buf[i] !== 0xff) return null;
    const marker = buf[i + 1];
    const len = buf.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xc2) return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7), components: buf[i + 9] };
    i += 2 + len;
  }
  return null;
}

test('schema: version 1, groups core and stage:<id>, every id of architecture section 7 and nothing else', () => {
  assert.equal(manifest.version, 1);
  assert.deepEqual(Object.keys(manifest.groups).sort(), ['core', 'stage:alpine', 'stage:hills', 'stage:meadow']);
  const all = Object.values(IDS).flat();
  assert.deepEqual([...byId.keys()].sort(), [...all].sort());
  for (const id of STAGE_IDS) assert.deepEqual(manifest.groups[`stage:${id}`].sort(), [layerAssetId(id, 'far'), layerAssetId(id, 'near')].sort());
  assert.deepEqual(manifest.groups.core.sort(), all.filter((id) => !IDS.layers.includes(id)).sort());
  for (const a of manifest.assets) assert.ok(manifest.groups[a.group].includes(a.id), `${a.id} is in its group`);
});

test('every entry has a file that exists with its byte size, a sane content box and anchor; sizes of section 7', () => {
  for (const a of manifest.assets) {
    const file = join(ASSETS, a.file);
    assert.ok(existsSync(file), a.file);
    if (a.bytes !== undefined) assert.equal(statSync(file).size, a.bytes, `${a.id} bytes`);
    const cb = a.contentBox;
    assert.ok(cb.x >= 0 && cb.y >= 0 && cb.w > 0 && cb.h > 0 && cb.x + cb.w <= a.width && cb.y + cb.h <= a.height, `${a.id} content box`);
    assert.ok(a.anchor.x >= 0 && a.anchor.x <= a.width && a.anchor.y >= 0 && a.anchor.y <= a.height, `${a.id} anchor`);
  }
  const size = (id) => [byId.get(id).width, byId.get(id).height];
  for (const id of IDS.layers) assert.deepEqual(size(id), id.endsWith('_far') ? [2560, 1440] : [1920, 1080], id);
  for (const id of IDS.targets) assert.deepEqual(size(id), [256, 256], id);
  for (const id of IDS.shards) assert.deepEqual(size(id), [128, 128], id);
  for (const id of IDS.fx) assert.deepEqual(size(id), [256, 256], id);
  for (const id of IDS.houses) assert.deepEqual(size(id), [512, 512], id);
  for (const id of IDS.icons) assert.deepEqual(size(id), [128, 128], id);
});

test('extra fields: a body circle on every clay, the ground point as the anchor of every house, the muzzle of the gun', () => {
  for (const id of IDS.targets) {
    const b = byId.get(id).body;
    assert.ok(b && b.r > 60 && b.r <= 128 && Math.abs(b.cx - 128) < 8 && Math.abs(b.cy - 128) < 8, `${id} body`);
  }
  for (const id of IDS.houses) {
    const h = byId.get(id);
    assert.equal(h.anchor.y, h.contentBox.y + h.contentBox.h, `${id}: anchored on the bottom of its content`);
    assert.ok(Math.abs(h.anchor.x - (h.contentBox.x + h.contentBox.w / 2)) < 2, `${id}: bottom centre`);
  }
  const gun = byId.get('gun_ou');
  assert.deepEqual(gun.anchor, { x: gun.width, y: gun.height }, 'the gun is anchored at its bottom-right corner');
  assert.ok(gun.muzzle.x > 0 && gun.muzzle.x < 0.3 && gun.muzzle.y > 0 && gun.muzzle.y < 0.3, 'the muzzle is at the top left');
});

test('far layers are opaque JPEGs, everything else is a PNG with an alpha channel and transparent pixels outside its content', () => {
  for (const a of manifest.assets) {
    const buf = readFileSync(join(ASSETS, a.file));
    if (a.id.endsWith('_far')) {
      assert.match(a.file, /\.jpg$/);
      const j = jpegInfo(buf);
      assert.ok(j && j.width === a.width && j.height === a.height && j.components === 3, `${a.id} jpeg`);
      continue;
    }
    assert.match(a.file, /\.png$/);
    const h = readPngHeader(buf);
    assert.equal(h.width, a.width);
    assert.equal(h.height, a.height);
    assert.ok(h.colorType === 6 || h.colorType === 4, `${a.id} has alpha`);
    if (a.width * a.height > 1100000) continue; // the near layers: header only (decoding is slow); the alpha is checked on sprites
    const img = decodePng(buf);
    const alphaAt = (x, y) => img.rgba[(y * a.width + x) * 4 + 3];
    const corners = [alphaAt(0, 0), alphaAt(a.width - 1, 0), alphaAt(0, a.height - 1), alphaAt(a.width - 1, a.height - 1)].filter((v) => v < 24).length;
    assert.ok(corners >= 2, `${a.id}: transparent corners (${corners}; the gun reaches its bottom-right corner)`);
    const cb = a.contentBox;
    let opaque = 0;
    for (let y = cb.y; y < cb.y + cb.h; y += 4) for (let x = cb.x; x < cb.x + cb.w; x += 4) if (alphaAt(x, y) >= 24) opaque++;
    assert.ok(opaque > 0, `${a.id}: something inside its content box`);
  }
});

test('fonts: three files, two families (ClayDisplay, ClayUI), the files and hashes match, render/fonts.js asks for exactly them', () => {
  assert.equal(manifest.fonts.length, 3);
  assert.deepEqual([...new Set(manifest.fonts.map((f) => f.family))], ['ClayDisplay', 'ClayUI']);
  for (const f of manifest.fonts) {
    const buf = readFileSync(join(ASSETS, f.file));
    assert.equal(buf.length, f.bytes, f.file);
    assert.equal(crypto.createHash('sha256').update(buf).digest('hex'), f.sha256, f.file);
    assert.equal(buf.subarray(0, 4).toString('latin1'), 'wOF2', `${f.file} is a WOFF2 file`);
    assert.ok(existsSync(join(ASSETS, f.licenseFile)), f.licenseFile);
  }
  assert.deepEqual(FONT_FILES.map((f) => [f.id, f.family, f.file, f.weight]), manifest.fonts.map((f) => [f.id, f.family, f.file, f.weight]));
});

test('the render code knows every picture it draws: every frame sprite and every procedural twin is a manifest id', () => {
  for (const id of Object.values(FRAME_SPRITE)) assert.ok(byId.has(id), id);
  for (const id of Object.keys(PROC_META)) if (!id.startsWith('fx_glow') && id !== 'fx_sparkle' && id !== 'fx_vignette') assert.ok(byId.has(id), id);
});

test('the manifest is plain ASCII JSON and names no URL', () => {
  const text = readFileSync(join(ASSETS, 'manifest.json'), 'utf8');
  assert.match(text, /^[\x09\x0a\x0d\x20-\x7e]*$/);
  assert.doesNotMatch(text, /https?:\/\//);
});
