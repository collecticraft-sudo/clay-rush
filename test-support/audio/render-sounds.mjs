// Offline render of every sound in headless Chrome (real WebAudio, real compressor and reverb) with peak levels. OWNER: audio engineer.
//   node test-support/audio/render-sounds.mjs [--port 8274] [--wav <dir>] [--json <file>] [--shot <png> [--filter <text>]] [--check]
// Starts the sound lab server, renders each scenario with an OfflineAudioContext at volume 1 (master gain 0.8), prints one line per
// sound (peak dBFS before the master gain, the output peak, the target of the direction, the tail) and optionally writes 16-bit WAV
// files, a JSON report and a screenshot of the lab. --check exits 1 when a render clips or a single sound misses its target by more
// than 4 dB. Also imported by test/audio/offline-render.test.js.

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findChrome, launchChrome } from '../e2e/chrome-launcher.js';
import { Page } from '../e2e/cdp.js';
import { LAB_PORT, startLabServer } from './lab-server.mjs';

/**
 * @param {{port?:number, wavDir?:string, shot?:string, filter?:string}} [opts]
 * @returns {Promise<{skip:string}|{results:object[], chrome:string}>}
 */
export async function renderAllSounds(opts = {}) {
  if (!findChrome()) return { skip: 'Google Chrome not found' };
  const server = await startLabServer({ port: opts.port ?? 0 });
  let browser = null;
  try {
    browser = await launchChrome({ width: 1500, height: 1000 });
    const page = await Page.create(browser.conn, { width: 1500, height: 1000 });
    await page.goto(`${server.url}/`);
    await page.waitFor('window.__lab && window.__lab.ready === true', { timeoutMs: 15000, message: 'the sound lab' });
    const results = await page.evaluate('window.__lab.renderAll()');
    if (opts.wavDir) {
      mkdirSync(opts.wavDir, { recursive: true });
      for (const r of results) {
        const b64 = await page.evaluate(`window.__lab.wavBase64(${JSON.stringify(r.name)})`);
        writeFileSync(path.join(opts.wavDir, `${r.name.replace(/[^a-z0-9]+/gi, '_').replace(/^_|_$/g, '').toLowerCase()}.wav`), Buffer.from(b64, 'base64'));
      }
    }
    if (opts.shot) {
      await page.goto(`${server.url}/?auto=1${opts.filter ? `&filter=${encodeURIComponent(opts.filter)}` : ''}`);
      await page.waitFor("document.getElementById('status').textContent.includes('renders at volume')", { timeoutMs: 60000, pollMs: 250, message: 'the lab to paint' });
      const h = await page.evaluate('document.documentElement.scrollHeight');
      await page.send('Emulation.setDeviceMetricsOverride', { width: 1500, height: Math.min(8000, h), deviceScaleFactor: 1, mobile: false });
      await page.screenshot(opts.shot);
    }
    return { results, chrome: browser.version, errors: page.consoleErrors(), exceptions: page.exceptions };
  } finally {
    if (browser) await browser.close().catch(() => {});
    await server.close().catch(() => {});
  }
}

export function formatReport(results) {
  const pad = (s, n) => String(s).padEnd(n);
  const rows = [`${pad('sound', 50)} ${pad('peak(pre)', 10)} ${pad('target', 7)} ${pad('delta', 6)} ${pad('out', 6)} ${pad('rms', 7)} ${pad('tail s', 6)} ${pad('centroid', 8)} clip`];
  for (const r of results) {
    rows.push(`${pad(r.name, 50)} ${pad(r.peakPreDb, 10)} ${pad(r.targetDb ?? '-', 7)} ${pad(r.deltaDb ?? '-', 6)} ${pad(r.peakOut, 6)} ${pad(r.rmsPreDb, 7)} ${pad(r.tailS, 6)} ${pad(r.centroidHz, 8)} ${r.clipped ? 'CLIP' : ''}`);
  }
  return rows.join('\n');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const arg = (name) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; };
  const out = await renderAllSounds({ port: Number(arg('--port')) || LAB_PORT, wavDir: arg('--wav'), shot: arg('--shot'), filter: arg('--filter') });
  if (out.skip) { console.error(out.skip); process.exit(2); }
  console.log(formatReport(out.results));
  console.log(`\nChrome ${out.chrome}; highest output peak ${Math.max(...out.results.map((r) => r.peakOut))}; clipped: ${out.results.filter((r) => r.clipped).length}`);
  if (out.errors.length || out.exceptions.length) console.log('page errors:', out.errors, out.exceptions);
  if (process.argv.includes('--suggest')) {
    console.log('\nsuggested trims (current trim x 10^((target - peak) / 20)); only sounds more than 1.5 dB off:');
    for (const r of out.results) if (r.kind === 'sound' && r.deltaDb !== null && Math.abs(r.deltaDb) > 1.5) console.log(`  ${r.name}: ${r.trim} -> ${+(r.trim * 10 ** (-r.deltaDb / 20)).toFixed(3)}`);
  }
  if (arg('--json')) writeFileSync(arg('--json'), JSON.stringify(out.results, null, 2));
  if (process.argv.includes('--check')) {
    const bad = out.results.filter((r) => r.clipped || (r.kind === 'sound' && r.deltaDb !== null && Math.abs(r.deltaDb) > 4));
    if (bad.length) { console.error(`off target or clipped: ${bad.map((b) => b.name).join(', ')}`); process.exit(1); }
  }
  process.exit(0);
}
