// Screenshots of the same Classic throw at the three difficulties (lead's visual check). Usage: node test-support/e2e/shoot-difficulty.mjs <outDir>
import { startE2e } from './env.js';

const out = process.argv[2];
process.env.E2E_SCREENSHOTS = out;
const env = await startE2e();
const report = {};
try {
  for (const d of ['easy', 'normal', 'hard']) {
    const page = await env.openGame(`input=mouse&mode=classic&difficulty=${d}&seed=11&mute=1&clock=manual`);
    const r = await page.evaluate(`(async () => {
      const c = window.__clay;
      const adv = (ms) => { for (let i = 0; i < ms / 16; i++) c.advance(16); };
      adv(1500);
      for (let i = 0; i < 200 && !(c.snapshot().phase === 'ready' && c.snapshot().shells.loaded === 2); i++) adv(50);
      c.callPull();
      let s;
      for (let i = 0; i < 300; i++) { adv(16); s = c.snapshot(); if (s.targets.some((t) => t.ageS > 0.6)) break; }
      return { phase: s.phase, k: s.worldScale, t: s.targets.map((t) => ({ rPx: +t.rPx.toFixed(1), z: +t.z.toFixed(1), sx: Math.round(t.sx), sy: Math.round(t.sy) })), houses: s.houses.map((h) => ({ id: h.id, z: +h.z.toFixed(1) })) };
    })()`);
    report[d] = r;
    await env.screenshot(page, `flight-${d}`);
    await page.close();
  }
  // Time Attack: airborne never above the shells
  const page = await env.openGame('input=mouse&mode=timeattack&difficulty=normal&stage=hills&seed=5&mute=1&clock=manual');
  report.timeattack = await page.evaluate(`(async () => {
    const c = window.__clay;
    let worst = 0, maxAir = 0, frames = 0, launched = 0;
    for (let i = 0; i < 600 && c.snapshot().screen !== 'playing'; i++) c.advance(16);
    for (let i = 0; i < 200 * 60; i++) {
      frames++;
      c.advance(16);
      const s = c.snapshot();
      if (s.phase === 'over' || s.screen !== 'playing') break;
      const air = s.targets.length;
      maxAir = Math.max(maxAir, air);
      const avail = s.shells.loaded;
      if (air > avail) worst = Math.max(worst, air - avail);
      launched = Math.max(launched, s.stats.presented);
    }
    return { frames, launched, maxAir, worstExcessWithoutShooting: worst, screen: c.snapshot().screen };
  })()`);
  await env.screenshot(page, 'timeattack');
} finally {
  await env.close();
}
console.log(JSON.stringify(report, null, 1));
