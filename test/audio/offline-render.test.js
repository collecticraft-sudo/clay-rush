// Offline render of every sound in headless Chrome (real WebAudio: real compressor, convolver and shaper): no clipping, every sound lands
// on its level target, nothing is silent, tails end, no DC offset; the shot is the loudest, low and long. The test reports "skipped" (never
// "passed") when Chrome is not available. Tool: test-support/audio/render-sounds.mjs (the same numbers as the sound lab).
import test from 'node:test';
import assert from 'node:assert/strict';
import { findChrome } from '../../test-support/e2e/chrome-launcher.js';
import { renderAllSounds } from '../../test-support/audio/render-sounds.mjs';

const skip = findChrome() ? false : 'Google Chrome not found (set CHROME_PATH)';

test('offline render: every sound is audible, on target, never clips, tails end and the worst-case mixes stay under the master ceiling', { skip, timeout: 120000 }, async (t) => {
  const out = await renderAllSounds({ port: 0 });
  if (out.skip) { t.skip(out.skip); return; }
  const { results } = out;
  assert.ok(results.length >= 60, `${results.length} renders`);
  assert.deepEqual(out.exceptions, [], 'no exception in the lab page');
  const singles = results.filter((r) => r.kind === 'sound');
  const mixes = results.filter((r) => r.kind === 'mix');
  assert.equal(mixes.length, 4);
  for (const r of results) {
    assert.equal(r.clipped, false, `${r.name} clips (output peak ${r.peakOut})`);
    assert.ok(r.peakOut <= 0.8 + 1e-3, `${r.name}: output peak ${r.peakOut} is above the master ceiling 0.8`);
    assert.ok(r.peakPreDb > -45, `${r.name} is nearly silent (${r.peakPreDb} dBFS)`);
    assert.ok(r.tailS < 2.6, `${r.name}: tail ${r.tailS} s`);
    assert.ok(Math.abs(r.dc) < 0.01, `${r.name}: DC offset ${r.dc}`);
  }
  // every single lands within 4 dB of its target, except the deliberately quieter far break
  for (const r of singles) if (r.name !== 'clayBreak far') assert.ok(Math.abs(r.deltaDb) <= 4, `${r.name}: peak ${r.peakPreDb} dBFS is ${r.deltaDb} dB from its target ${r.targetDb}`);
  const by = (name) => results.find((r) => r.name === name);
  assert.ok(by('clayBreak far').peakPreDb < by('clayBreak near').peakPreDb - 3, 'a far clay is quieter');
  // the shot is the loudest single: low and long (the thump and the field echo)
  const shot = by('shot first barrel');
  for (const r of singles) if (!r.name.startsWith('shot')) assert.ok(r.peakPreDb <= shot.peakPreDb + 0.5, `${r.name} is not louder than the shot`);
  assert.ok(shot.bandsPct.low >= 40, `the shot has its weight in the low band (${shot.bandsPct.low} %)`);
  assert.ok(shot.tailS >= 0.6, `the shot rings on (${shot.tailS} s)`);
  // UI sounds sit at -17 dBFS or lower, the ambience far below the game
  for (const n of ['uiMove', 'uiSelect', 'uiBack', 'uiError', 'uiWhoosh', 'countTick']) assert.ok(by(n).peakPreDb <= -17, `${n}: ${by(n).peakPreDb}`);
  for (const n of ['bird 0', 'bird 1', 'bird 2', 'cricket']) assert.ok(by(n).peakPreDb <= -24, `${n}: ${by(n).peakPreDb}`);
  // the clay break is bright (a crack), the bird calls are high
  assert.ok(by('clayBreak near').centroidHz > 1500);
  assert.ok(by('bird 1').centroidHz > 3000);
  // all four stress mixes, volume 1: the safety soft clip keeps them at or below the master ceiling
  for (const m of mixes) assert.ok(m.peakOut <= 0.8 + 1e-3 && m.voices >= 2, m.name);
});
