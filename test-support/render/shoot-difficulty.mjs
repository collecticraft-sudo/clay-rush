// The same Classic throw at the three difficulties in the REAL game (dev tool). OWNER: Render & Audio engineer.
//   node test-support/render/shoot-difficulty.mjs [--tag after] [--out test-support/render/screens] [--scale 0.4]
// Writes <out>/difficulty-<easy|normal|hard>-<tag>.png and prints the world scale, the backdrop zoom and the clays of each picture.

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startE2e } from '../e2e/env.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const arg = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };
const tag = arg('--tag', 'after');
const out = arg('--out', path.join(HERE, 'screens'));
const scale = Number(arg('--scale', 0.4));
mkdirSync(out, { recursive: true });

const env = await startE2e();
const report = {};
try {
  for (const d of ['easy', 'normal', 'hard']) {
    const page = await env.openGame(`input=mouse&mode=classic&difficulty=${d}&seed=11&mute=1&clock=manual&skipsafety=1`);
    report[d] = await page.evaluate(`(async () => {
      const C = window.__clay;
      C.start('classic', { difficulty: '${d}', seed: 11, skipCountdown: true, autoLaunch: true });
      // the stage art loads in real time: wait for it (the crossfade runs on the manual clock below)
      for (let i = 0; i < 100; i++) { C.advance(16); C.debug.draw(); const w = C.debug.getWorld(); if (w && w.layers && w.layers.far) break; await new Promise((r) => setTimeout(r, 60)); }
      C.start('classic', { difficulty: '${d}', seed: 11, skipCountdown: true, autoLaunch: true });
      let s;
      for (let i = 0; i < 900; i++) { C.advance(1000 / 60); s = C.snapshot(); if (s.targets.some((t) => t.ageS > 0.55)) break; }
      C.aim(1250, 420);
      for (let i = 0; i < 3; i++) C.advance(1000 / 60);
      C.debug.draw();
      const w = C.debug.getWorld();
      s = C.snapshot();
      return { k: s.worldScale, zoom: w && w.viewZoom, layers: w && w.stageStatus && w.stageStatus.zoom, clays: s.targets.map((t) => ({ rPx: +t.rPx.toFixed(1), z: +t.z.toFixed(1) })) };
    })()`);
    const { data } = await page.send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: 1920, height: 1080, scale } });
    writeFileSync(path.join(out, `difficulty-${d}-${tag}.png`), Buffer.from(data, 'base64'));
    await page.close();
  }
} finally {
  await env.close();
}
console.log(JSON.stringify(report));
