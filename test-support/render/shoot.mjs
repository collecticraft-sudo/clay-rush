// Screenshots of the render preview in headless Chrome (dev tool). OWNER: Render & Audio engineer.
//   node test-support/render/shoot.mjs [--port 8323] [--out test-support/render/screens] [--scale 0.5] [--only play-hills,idle-hills]
//     [--extra '&nobanner=1&hitAge=300'] [--clip x,y,w,h]   (--only perf-alpine prints the frame timing of a busy scene)
// Serves the project root with server.js on the port, opens test-support/render/preview.html once per scene, waits for window.__done
// and writes <out>/<scene>.png (scaled down by --scale). One headless Chrome at a time; it is closed at the end, the server too.

import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../../server.js';
import { findChrome, launchChrome } from '../e2e/chrome-launcher.js';
import { Page } from '../e2e/cdp.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');

export const SCENES = Object.freeze([
  ['play-meadow', 'scene=play&stage=meadow'],
  ['play-hills', 'scene=play&stage=hills'],
  ['play-alpine', 'scene=play&stage=alpine'],
  ['play-hills-noassets', 'scene=play&stage=hills&assets=0'],
  ['play-alpine-noassets', 'scene=play&stage=alpine&assets=0'],
  ['play-meadow-noassets', 'scene=play&stage=meadow&assets=0'],
  ['idle-hills', 'scene=idle&stage=hills'],
  ['ready-meadow', 'scene=ready&stage=meadow'],
  ['card-hills', 'scene=card&stage=hills'],
  ['killcam-alpine', 'scene=killcam&stage=alpine'],
  ['timeattack-hills', 'scene=timeattack&stage=hills'],
  ['zen-meadow-noassets', 'scene=zen&stage=meadow&assets=0'],
  ['reduce-hills', 'scene=reduce&stage=hills'],
  ['perf-alpine', 'scene=perf&stage=alpine', 'manual'], // timing only (window.__perf): run with --only perf-alpine
]);

const arg = (name, d) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : d;
};

export async function shoot({ port = 8323, out = path.join(HERE, 'screens'), scale = 0.5, only = null, extra = '', clip = null } = {}) {
  if (!findChrome()) throw new Error('Google Chrome not found');
  mkdirSync(out, { recursive: true });
  const server = await startServer({ port, root: ROOT, quiet: true });
  let browser = null;
  const results = [];
  try {
    browser = await launchChrome({ width: 1920, height: 1080 });
    const page = await Page.create(browser.conn, { width: 1920, height: 1080 });
    for (const [name, query, manual] of SCENES) {
      if (only ? !only.includes(name) : manual === 'manual') continue;
      await page.goto(`${server.url}/test-support/render/preview.html?${query}${extra}`);
      await page.waitFor('window.__done === true', { timeoutMs: 30000, message: name });
      const err = await page.evaluate('window.__error || null');
      const dbg = await page.evaluate('JSON.stringify(window.__perf || window.__debug || null)');
      const [cx, cy, cw, ch] = clip ?? [0, 0, 1920, 1080];
      const { data } = await page.send('Page.captureScreenshot', { format: 'png', clip: { x: cx, y: cy, width: cw, height: ch, scale } });
      const file = path.join(out, `${name}.png`);
      const { writeFileSync } = await import('node:fs');
      writeFileSync(file, Buffer.from(data, 'base64'));
      results.push({ name, file, err, dbg });
    }
    results.errors = page.consoleErrors();
    results.exceptions = page.exceptions;
  } finally {
    if (browser) await browser.close().catch(() => {});
    await server.close().catch(() => {});
  }
  return results;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const only = arg('--only') ? arg('--only').split(',') : null;
  const res = await shoot({ port: Number(arg('--port', 8323)), out: arg('--out', path.join(HERE, 'screens')), scale: Number(arg('--scale', 0.5)), only, extra: arg('--extra', ''), clip: arg('--clip') ? arg('--clip').split(',').map(Number) : null });
  for (const r of res) console.log(`${r.name}: ${r.file}${r.err ? `\n  ERROR ${r.err}` : ''}${r.name.startsWith('perf') ? `\n  ${r.dbg}` : ''}`);
  if (res.errors?.length || res.exceptions?.length) console.log('page errors:', res.errors, res.exceptions);
  process.exit(0);
}
