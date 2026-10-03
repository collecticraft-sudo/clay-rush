// e2e performance smoke (headless Chrome over CDP, real clock, 1920 x 1080, 20 s of Classic with the simulator, WITH the generated art: the run
// first waits for group `core` and the meadow stage, so what is timed is the game with its pictures; ?assets=0 is the second test below).
// It REPORTS average frame time, fps, frame-time percentiles, long tasks and the software input-to-draw latency, and fails hard only
// when the average frame time is above 33 ms (headless GPU and CPU load vary, especially while other test files run in parallel).
// The 60 fps and 50 ms figures are informational here and explicitly NOT a claim about the owner's MacBook or about the Joy-Con:
// the Bluetooth and display parts of the latency are UNVERIFIED-ON-HARDWARE (UOH-18, HW-1).
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { startE2e } from '../../test-support/e2e/env.js';

const env = await startE2e({ width: 1920, height: 1080 });
const skip = env.skip;
after(() => env.close());

test('e2e 14: performance smoke: 20 s of Classic on the real clock with the simulator, 1920x1080', { skip }, async (t) => {
  // times every requestAnimationFrame callback of the game (JavaScript only: step() + draw(); raster and compositing run elsewhere)
  const cpuProbe = `(() => {
    window.__cpu = [];
    const orig = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (cb) => orig((t) => {
      if (cb.__skip) return cb(t);
      const s = performance.now();
      cb(t);
      window.__cpu.push(performance.now() - s);
    });
  })()`;
  const page = await env.openGame('input=sim&skipsafety=1&mute=1&seed=4', { init: [cpuProbe] });
  await page.evaluate(`(() => {
    window.__frames = []; window.__long = 0;
    let last = performance.now();
    const tick = (now) => { window.__frames.push(now - last); last = now; requestAnimationFrame(tick); };
    tick.__skip = true;
    requestAnimationFrame(tick);
    try { new PerformanceObserver((l) => { window.__long += l.getEntries().length; }).observe({ entryTypes: ['longtask'] }); } catch (e) {}
  })()`);
  await page.evaluate(`(async () => { const t0 = performance.now(); while (performance.now() - t0 < 8000 && __clay.getAssets().groups.core?.state !== 'ready') await new Promise((r) => setTimeout(r, 20)); })()`);
  assert.equal(await page.evaluate("__clay.getAssets().groups.core.state"), 'ready', 'the art is loaded before the run: these numbers are the game with its pictures');
  await page.evaluate("__clay.start('classic', { seed: 4 })");
  await page.waitFor("__clay.debug.getWorld().stage === 'meadow' && __clay.debug.getWorld().layers.far", { timeoutMs: 8000, message: 'the meadow stage is on screen' });
  // a bot shoots every reachable clay; every third shot goes through the simulator's trigger (the whole IMU chain)
  const result = await page.evaluate(async () => {
    const n = window.__clay;
    const t0 = performance.now();
    let swings = 0;
    let cuts = 0;
    let i = 0;
    while (performance.now() - t0 < 20000) {
      await new Promise((r) => setTimeout(r, 120));
      const s = n.snapshot();
      if (s.screen !== 'playing') { n.start('classic', { seed: 4 + i }); continue; }
      const o = s.targets.find((q) => q.ageS > 0.25 && q.sx > 40 && q.sx < 1880 && q.sy > 40 && q.sy < 1040);
      if (!o || s.shells.loaded <= 0) continue;
      i++;
      swings++;
      if (i % 3 === 0) {
        n.sim.setTarget(o.sx, o.sy, { teleport: true });
        await new Promise((r) => setTimeout(r, 40));
        const before = n.snapshot().stats.hits;
        n.sim.fire();
        await new Promise((r) => setTimeout(r, 60));
        cuts += n.snapshot().stats.hits > before ? 1 : 0;
      } else if ((await n.shootTarget(o.id)).hit) cuts++;
    }
    const frames = window.__frames.slice(10).sort((a, b) => a - b);
    const avg = frames.reduce((a, b) => a + b, 0) / frames.length;
    const pct = (p) => frames[Math.min(frames.length - 1, Math.floor(frames.length * p))];
    const cpu = window.__cpu.slice(10).sort((a, b) => a - b);
    const cpuAvg = cpu.reduce((a, b) => a + b, 0) / cpu.length;
    return { cpu: { n: cpu.length, avg: cpuAvg, p50: cpu[Math.floor(cpu.length * 0.5)], p95: cpu[Math.floor(cpu.length * 0.95)], p99: cpu[Math.floor(cpu.length * 0.99)], max: cpu[cpu.length - 1] }, swings, cuts, frames: frames.length, avgMs: avg, p50: pct(0.5), p95: pct(0.95), p99: pct(0.99), maxMs: frames[frames.length - 1], longTasks: window.__long, perf: n.getPerf(), screen: n.snapshot().screen, dpr: devicePixelRatio, w: innerWidth, h: innerHeight };
  });
  t.diagnostic(`Chrome ${env.chrome} headless, ${result.w}x${result.h} @${result.dpr}x, ${result.frames} frames in 20 s`);
  t.diagnostic(`rAF interval: avg ${result.avgMs.toFixed(2)} ms (${(1000 / result.avgMs).toFixed(1)} fps), p50 ${result.p50.toFixed(1)}, p95 ${result.p95.toFixed(1)}, p99 ${result.p99.toFixed(1)}, max ${result.maxMs.toFixed(1)} ms, long tasks ${result.longTasks}`);
  t.diagnostic(`game callback (step + draw, JavaScript only): avg ${result.cpu.avg.toFixed(2)} ms, p50 ${result.cpu.p50.toFixed(2)}, p95 ${result.cpu.p95.toFixed(2)}, p99 ${result.cpu.p99.toFixed(2)}, max ${result.cpu.max.toFixed(2)} ms over ${result.cpu.n} frames (budget 6 ms average; measured in headless Chrome, not on the owner's Mac)`);
  t.diagnostic(`game perf: fps ${result.perf.fps && result.perf.fps.toFixed(1)}, avgFrameMs ${result.perf.avgFrameMs && result.perf.avgFrameMs.toFixed(2)}, inputToDrawMs ${result.perf.inputToDrawMs && result.perf.inputToDrawMs.toFixed(1)} (software only)`);
  t.diagnostic(`bot: ${result.swings} shots, ${result.cuts} hits; informational targets: 60 fps at 1080p (16.7 ms), input to draw < 50 ms; NOT claimed for the owner's MacBook (UNVERIFIED-ON-HARDWARE)`);
  assert.ok(result.frames > 200, `only ${result.frames} frames in 20 s`);
  assert.ok(result.avgMs < 33, `average frame interval ${result.avgMs.toFixed(1)} ms is above the 33 ms hard limit`);
  assert.ok(result.cpu.avg < 6, `the step + draw callback averages ${result.cpu.avg.toFixed(2)} ms (budget 6 ms, with the art on)`);
  assert.ok(result.cuts >= 5, `the bot broke only ${result.cuts} clays`);
  assert.ok(result.perf.inputToDrawMs === null || result.perf.inputToDrawMs < 200, `input to draw ${result.perf.inputToDrawMs}`);
  assert.deepEqual(page.consoleErrors(), []);
  assert.deepEqual(page.exceptions, []);
});

test('e2e 14b: the same run with ?assets=0 (painted) for comparison: the art does not make the JavaScript cost of a frame worse than the budget', { skip }, async (t) => {
  const cpuProbe = `(() => {
    window.__cpu = [];
    const orig = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (cb) => orig((t) => { const s = performance.now(); cb(t); window.__cpu.push(performance.now() - s); });
  })()`;
  const page = await env.openGame('input=sim&skipsafety=1&mute=1&seed=4&assets=0', { init: [cpuProbe] });
  await page.evaluate("__clay.start('classic', { seed: 4 })");
  const result = await page.evaluate(async () => {
    const n = window.__clay;
    const t0 = performance.now();
    let cuts = 0;
    while (performance.now() - t0 < 8000) {
      await new Promise((r) => setTimeout(r, 120));
      const s = n.snapshot();
      if (s.screen !== 'playing') { n.start('classic', { seed: 5 }); continue; }
      const o = s.targets.find((q) => q.ageS > 0.25 && q.sx > 40 && q.sx < 1880 && q.sy > 40 && q.sy < 1040);
      if (o && s.shells.loaded > 0 && (await n.shootTarget(o.id)).hit) cuts++;
    }
    const cpu = window.__cpu.slice(10);
    return { avg: cpu.reduce((a, b) => a + b, 0) / cpu.length, frames: cpu.length, cuts, enabled: n.getAssets().enabled };
  });
  t.diagnostic(`painted (?assets=0): step + draw callback avg ${result.avg.toFixed(2)} ms over ${result.frames} frames, ${result.cuts} hits`);
  assert.equal(result.enabled, false);
  assert.ok(result.avg < 6, `${result.avg}`);
  assert.deepEqual(page.consoleErrors(), []);
});
