#!/usr/bin/env node
// capture-gameplay.mjs: records real gameplay clips of Clay Rush for the presentation video and the README GIF.
// No dependencies beyond the repo's own e2e harness (node 22+, ffmpeg, Google Chrome). Adapted from the 3D Fruit Dojo capture tool.
//
// How it works:
//   1. startE2e() (test-support/e2e/env.js) starts the game server on its own port (default 8380) and one headless Chrome at 1920x1080;
//   2. the game opens with ?input=mouse&skipsafety=1&clock=manual&mute=1: the clock only moves when this script advances it, so a run is
//      a pure function of (scene, difficulty, stage, seed, fps): the same arguments give the same footage, frame for frame;
//   3. a scripted BOT (pageBot below, injected into the page) plays through the public test API window.__clay: every frame it reads
//      __clay.snapshot(), glides the crosshair towards the clay it wants with a smooth spring (__clay.aim every frame, so the REAL crosshair
//      and gun of the game move; it never teleports onto a clay), calls "Pull!" in Classic and pulls the trigger with __clay.press('fire'),
//      the same fire intent the mouse button produces. It never uses fire()/shootTarget(): those advance the manual clock by 150 ms on
//      their own, which would skip frames in the footage;
//   4. every frame advances the game exactly 1000/fps ms, paints (__clay.debug.draw()) and grabs Page.captureScreenshot (JPEG) into ffmpeg
//      (libx264 crf 14, keyframe every 0.5 s). Frames before --from are played but not captured (fast-forward, same game);
//   5. next to the clip, <name>.events.json lists the game events (shot, hit, double, killCam, streak, stageStart, ...) with their time in
//      the clip: tools/build-audio.mjs places the gunshot and the clay crack sounds from it.
//
// Usage:
//   node video/tools/capture-gameplay.mjs --plan --mode classic --seed 7 --seconds 100      (no pictures: prints the event timeline)
//   node video/tools/capture-gameplay.mjs --mode classic --seed 7 --from 3.5 --seconds 6 --name meadow
//   node video/tools/capture-gameplay.mjs --mode classic --difficulty easy --seed 11 --from 0 --seconds 4 --name easy --stills 30,60
// Options: --mode classic|timeattack|zen  --difficulty easy|normal|hard  --stage meadow|hills|alpine  --seed N  --fps 60
//          --from S  --seconds S  --name NAME  --out DIR (default video/footage)  --plan  --stills f1,f2 (JPEG stills of those clip frames)
//          --frames (keep every captured JPEG in <out>/<name>.frames/)  --port 8380  --quality 90  --menu (capture the menu, no round)
//          --hold-aim (between clays the gun stays where it is instead of gliding back to its rest point)  --min-age S  --max S

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');
const { startE2e } = await import(join(ROOT, 'test-support/e2e/env.js'));

function parseArgs(argv) {
  const o = { mode: 'classic', difficulty: 'normal', stage: null, seed: 7, fps: 60, from: 0, seconds: 6, name: null, out: join(ROOT, 'video/footage'),
    plan: false, stills: [], frames: false, port: 8380, quality: 90, menu: false, minAge: 0.32, maxS: 400, holdAim: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = () => argv[++i];
    if (a === '--mode') o.mode = v();
    else if (a === '--difficulty') o.difficulty = v();
    else if (a === '--stage') o.stage = v();
    else if (a === '--seed') o.seed = Number(v());
    else if (a === '--fps') o.fps = Number(v());
    else if (a === '--from') o.from = Number(v());
    else if (a === '--seconds') o.seconds = Number(v());
    else if (a === '--name') o.name = v();
    else if (a === '--out') o.out = resolve(v());
    else if (a === '--plan') o.plan = true;
    else if (a === '--stills') o.stills = v().split(',').map(Number);
    else if (a === '--frames') o.frames = true;
    else if (a === '--port') o.port = Number(v());
    else if (a === '--quality') o.quality = Number(v());
    else if (a === '--menu') o.menu = true;
    else if (a === '--min-age') o.minAge = Number(v());
    else if (a === '--max') o.maxS = Number(v());
    else if (a === '--hold-aim') o.holdAim = true;
    else if (a === '--help' || a === '-h') { console.log(readUsage()); process.exit(0); }
    else throw new Error(`unknown option ${a}`);
  }
  if (!o.name) o.name = `${o.mode}-${o.difficulty}-${o.seed}`;
  return o;
}
function readUsage() { return 'see the header of video/tools/capture-gameplay.mjs'; }

// ------------------------------------------------------------------------------------------------------------------------ the page bot
// Runs inside the page. Pure function of (cfg, game state): no Math.random, no wall clock, so the footage is reproducible.
function pageBot(cfg) {
  const C = window.__clay;
  const DT = 1000 / cfg.fps;
  const FIELD_W = 1920, FIELD_H = 1080;
  const REST = { x: 960, y: 560 }; // where the gun rests between pulls (a little above the trap house)
  const st = { f: 0, ax: REST.x, ay: REST.y, vx: 0, vy: 0, tgtId: null, onFrames: 0, followLeft: 0, readyAt: null, lastSeq: 0,
    prev: new Map(), firedAt: new Map(), screen: null, phase: null, stageId: null };
  const hash = (n) => { let h = (n * 2654435761) >>> 0; h ^= h >>> 15; h = Math.imul(h, 2246822519) >>> 0; h ^= h >>> 13; return (h >>> 0) / 4294967296; };
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

  function chooseTarget(s) {
    // the clay that has flown longest (first out, first shot), once it has flown a natural reaction time
    let best = null;
    for (const t of s.targets) {
      if (st.firedAt.has(t.id)) continue;
      if (t.sx < 60 || t.sx > FIELD_W - 60 || t.sy < 60 || t.sy > FIELD_H - 80) continue;
      if (!best || t.ageS > best.ageS) best = t;
    }
    return best;
  }

  function aimPoint(s, t) {
    // screen velocity from the previous frame (px/s), lead by the pellet travel time on Hard (pellets at ~750 m/s)
    const p = st.prev.get(t.id);
    const vx = p ? (t.sx - p.x) / (DT / 1000) : 0;
    const vy = p ? (t.sy - p.y) / (DT / 1000) : 0;
    const lead = (s.difficulty === 'hard' ? t.z / 750 : 0) + cfg.leadS;
    return { x: t.sx + vx * lead, y: t.sy + vy * lead, vx, vy };
  }

  function control(s) {
    let goal = null, gv = { vx: 0, vy: 0 };
    const playing = s.screen === 'playing' && s.phase !== 'over' && s.phase !== 'ending';
    let fire = false;
    if (playing) {
      // keep the current target while it flies, else pick the next one
      let t = st.tgtId !== null ? s.targets.find((x) => x.id === st.tgtId) : null;
      if (st.followLeft > 0) st.followLeft -= 1;
      if (!t && st.followLeft === 0) { st.tgtId = null; t = null; }
      if (st.tgtId === null || (t && st.firedAt.has(t.id) && st.followLeft === 0)) {
        const n = chooseTarget(s);
        if (n) { st.tgtId = n.id; st.onFrames = 0; t = n; }
      }
      if (t) {
        const p = aimPoint(s, t);
        goal = p; gv = p;
        const minAge = cfg.minAge + 0.18 * hash(t.id + cfg.seed); // a different reaction for every clay
        const d = Math.hypot(st.ax - p.x, st.ay - p.y);
        st.onFrames = d < 6 ? st.onFrames + 1 : 0;
        const shellsOk = s.shells && (s.shells.infinite || s.shells.loaded > 0) && !(s.shells.reloadingS > 0);
        if (!st.firedAt.has(t.id) && s.phase === 'flight' && t.ageS >= minAge && st.onFrames >= 2 && shellsOk) {
          fire = true;
          st.firedAt.set(t.id, st.f);
          st.followLeft = Math.round(0.12 * cfg.fps); // follow through for 120 ms, like a shooter does
        }
      }
      // Classic: call "Pull!" a moment after the gun is loaded
      if (s.mode === 'classic' && s.phase === 'ready') {
        if (st.readyAt === null) st.readyAt = s.nowMs;
        const wait = cfg.pullWaitS * 1000 * (0.8 + 0.4 * hash(st.f));
        if (s.shells.loaded === s.shells.capacity && s.nowMs - st.readyAt >= wait) { fire = true; st.readyAt = null; }
      } else st.readyAt = null;
    }
    // between clays the gun goes back to its rest point, or (--hold-aim) stays where the last shot left it (a calmer picture: the
    // backdrop's parallax follows the aim, so a still gun keeps the frame still, which the README GIF needs to stay small)
    if (!goal) goal = cfg.holdAim ? { x: st.ax, y: st.ay } : { x: REST.x, y: REST.y };
    // smooth glide: exponential approach to the goal plus the goal's own velocity (a human tracking a moving clay), speed capped
    const tau = goal === null || gv.vx === 0 && gv.vy === 0 ? 0.32 : cfg.tauS;
    const k = 1 - Math.exp(-(DT / 1000) / tau);
    let nx = st.ax + (goal.x - st.ax) * k + (gv.vx || 0) * (DT / 1000);
    let ny = st.ay + (goal.y - st.ay) * k + (gv.vy || 0) * (DT / 1000);
    const maxStep = cfg.maxSpeed * (DT / 1000);
    const dx = nx - st.ax, dy = ny - st.ay, dl = Math.hypot(dx, dy);
    if (dl > maxStep) { nx = st.ax + (dx / dl) * maxStep; ny = st.ay + (dy / dl) * maxStep; }
    st.ax = clamp(nx, 0, FIELD_W); st.ay = clamp(ny, 0, FIELD_H);
    if (s.screen === 'playing') C.aim(st.ax, st.ay);
    if (fire) C.press('fire');
    for (const t of s.targets) st.prev.set(t.id, { x: t.sx, y: t.sy });
  }

  function collect(s, out) {
    for (const e of s.events || []) {
      if (e.seq <= st.lastSeq) continue;
      st.lastSeq = e.seq;
      const keep = { f: st.f, type: e.type };
      for (const k of ['id', 'kind', 'x', 'y', 'points', 'centre', 'multiplier', 'streak', 'level', 'ids', 'house', 'double', 'phase', 'name', 'index', 'hitIds', 'shell', 'durationMs', 'deltaS', 'perfect']) if (e[k] !== undefined) keep[k] = e[k];
      out.push(keep);
    }
    if (s.screen !== st.screen) { out.push({ f: st.f, type: 'screen', screen: s.screen }); st.screen = s.screen; }
  }

  function summary(s) {
    return { f: st.f, t: +(st.f / cfg.fps).toFixed(3), screen: s.screen, phase: s.phase, score: s.score, stage: s.stage && s.stage.id, pull: s.pull && s.pull.index,
      broken: s.stats && s.stats.broken, shots: s.stats && s.stats.shots, centre: s.stats && s.stats.centre, doubles: s.stats && s.stats.doubles, streak: s.streak, timeLeft: s.timeLeft };
  }

  return {
    st,
    start() {
      if (cfg.menu) return summary(C.snapshot());
      C.start(cfg.mode, { difficulty: cfg.difficulty, stage: cfg.stage || undefined, seed: cfg.seed, skipCountdown: true, autoLaunch: cfg.mode === 'classic' ? false : undefined });
      return summary(C.snapshot()); // st.stageId stays null: the first frame stops so that the caller waits for the first stage's art
    },
    /** Play n frames. draw: paint the last one. Returns the new events and a summary. */
    run(n, draw) {
      const ev = [];
      let s = C.snapshot();
      let i = 0, stop = null;
      while (i < n) {
        if (!cfg.menu) control(s);
        C.advance(DT);
        st.f += 1;
        i += 1;
        s = C.snapshot();
        collect(s, ev);
        // a new stage: stop so that the caller waits (real time) for its art before the game goes on
        const sid = s.stage && s.stage.id;
        if (sid && sid !== st.stageId) { st.stageId = sid; stop = sid; break; }
      }
      if (draw) C.debug.draw();
      return { events: ev, summary: summary(s), done: i, stop };
    },
  };
}

// ------------------------------------------------------------------------------------------------------------------------ main
const o = parseArgs(process.argv.slice(2));
const log = (...a) => console.error('[capture]', ...a);
mkdirSync(o.out, { recursive: true });
const cfg = { mode: o.mode, difficulty: o.difficulty, stage: o.stage, seed: o.seed, fps: o.fps, menu: o.menu, minAge: o.minAge,
  pullWaitS: 0.45, tauS: 0.075, maxSpeed: 2600, leadS: 0, holdAim: o.holdAim };

const env = await startE2e({ server: { port: o.port } });
if (env.skip) throw new Error(env.skip);
let ff = null;
try {
  const page = await env.openGame(`input=mouse&skipsafety=1&clock=manual&mute=1&seed=${o.seed}`);
  // wait (real time, the game clock stands still) until the core art and the menu's stage are loaded (the stages load one at a time)
  await page.waitFor(`(() => { window.__clay.debug.draw(); const a = window.__clay.getAssets(); if (!a.enabled) return true;
    const ss = a.world && a.world.stageStatus; return a.groups.core && a.groups.core.state === 'ready' && ss && ss.resident.length > 0 && !ss.loading.length; })()`,
  { timeoutMs: 30000, pollMs: 100, message: 'the core art' });
  const waitArt = (id) => page.waitFor(`(() => { const C = window.__clay; C.debug.draw(); const a = C.getAssets(); if (!a.enabled) return true;
    const g = a.groups['stage:${id}']; const ss = a.world && a.world.stageStatus; return !!(g && g.state === 'ready' && ss && ss.resident.includes('${id}')); })()`,
  { timeoutMs: 30000, pollMs: 50, message: `the art of stage ${id}` });
  await page.evaluate(`window.__bot = (${pageBot.toString()})(${JSON.stringify(cfg)}); true`);
  // the menu dissolves in; give the game one second of its own time before the round starts (same in every pass)
  await page.evaluate(`window.__bot.run(${Math.round(o.fps)}, false)`);
  await page.evaluate(`window.__bot.st.f = 0; window.__bot.st.lastSeq = (window.__clay.snapshot().events.slice(-1)[0] || {seq: 0}).seq; true`);
  const st0 = await page.evaluate('window.__bot.start()');
  log('start', JSON.stringify(st0));

  const fromF = Math.round(o.from * o.fps);
  const nF = Math.round(o.seconds * o.fps);
  const events = [];
  let last = null;
  // fast-forward (or the whole run in --plan mode) in chunks of 10 s
  const ffFrames = o.plan ? Math.round(Math.min(o.maxS, o.from + o.seconds) * o.fps) : fromF;
  for (let done = 0; done < ffFrames;) {
    const k = Math.min(ffFrames - done, Math.round(10 * o.fps));
    const r = await page.evaluate(`window.__bot.run(${k}, false)`);
    events.push(...r.events);
    last = r.summary;
    done += r.done;
    if (r.stop) await waitArt(r.stop);
    if (o.plan && last.screen === 'results' && events.some((e) => e.type === 'screen' && e.screen === 'results' && e.f < done - 4 * o.fps)) break;
  }
  if (o.plan) {
    const fmt = (e) => {
      const t = (e.f / o.fps).toFixed(2);
      const extra = Object.entries(e).filter(([k]) => !['f', 'type'].includes(k)).map(([k, v]) => `${k}=${Array.isArray(v) ? v.join('/') : v}`).join(' ');
      return `${t.padStart(7)}  ${e.type.padEnd(10)} ${extra}`;
    };
    const interesting = new Set(['stageStart', 'pull', 'launch', 'shot', 'hit', 'double', 'killCam', 'streak', 'stageClear', 'twoWithOne', 'timeBonus', 'timeUp', 'lost', 'screen', 'dryFire']);
    for (const e of events) if (interesting.has(e.type) || (e.type === 'phase' && ['stageCard', 'over', 'ending'].includes(e.phase))) console.log(fmt(e));
    console.log('END', JSON.stringify(last));
    writeFileSync(join(o.out, `${o.name}.plan.json`), JSON.stringify(events));
  } else {
    if (fromF > 0) log(`fast-forwarded ${fromF} frames`, JSON.stringify(last));
    const mp4 = join(o.out, `${o.name}.mp4`);
    const framesDir = join(o.out, `${o.name}.frames`);
    if (o.frames) { rmSync(framesDir, { recursive: true, force: true }); mkdirSync(framesDir, { recursive: true }); }
    const gop = Math.max(1, Math.round(o.fps / 2));
    const args = ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'image2pipe', '-framerate', String(o.fps), '-c:v', 'mjpeg', '-i', 'pipe:0',
      '-vf', 'scale=in_range=pc:in_color_matrix=bt601:out_range=tv:out_color_matrix=bt709,format=yuv420p',
      '-c:v', 'libx264', '-preset', 'medium', '-crf', '14', '-g', String(gop), '-keyint_min', String(gop), '-sc_threshold', '0', '-pix_fmt', 'yuv420p',
      '-r', String(o.fps), '-color_range', 'tv', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-movflags', '+faststart', '-an', mp4];
    const child = spawn('ffmpeg', args, { stdio: ['pipe', 'ignore', 'pipe'] });
    ff = child;
    let ffErr = '';
    child.stderr.on('data', (d) => { ffErr = (ffErr + d).slice(-2000); });
    const ffDone = new Promise((res) => child.on('close', res));
    const clipEvents = [];
    const t0 = Date.now();
    for (let k = 0; k < nF; k++) {
      const r = await page.evaluate('window.__bot.run(1, true)');
      if (r.stop) { await waitArt(r.stop); await page.evaluate('window.__clay.debug.draw()'); }
      for (const e of r.events) clipEvents.push({ ...e, t: +((e.f - fromF - 1) / o.fps).toFixed(4), clipFrame: e.f - fromF - 1 });
      last = r.summary;
      const shot = await page.send('Page.captureScreenshot', { format: 'jpeg', quality: o.quality });
      const buf = Buffer.from(shot.data, 'base64');
      if (!child.stdin.write(buf)) await new Promise((res) => child.stdin.once('drain', res));
      if (o.frames) writeFileSync(join(framesDir, `f${String(k).padStart(5, '0')}.jpg`), buf);
      if (o.stills.includes(k)) writeFileSync(join(o.out, `${o.name}.still-${k}.jpg`), buf);
      if (k % 120 === 119) log(`frame ${k + 1}/${nF} (${((k + 1) / ((Date.now() - t0) / 1000)).toFixed(1)} fps)`, JSON.stringify(last));
    }
    child.stdin.end();
    const code = await ffDone;
    ff = null;
    if (code !== 0) throw new Error(`ffmpeg failed: ${ffErr}`);
    // event k is the state after frame f; picture k shows the state after frame fromF + k + 1 - 1 => clip time (f - fromF - 1) / fps
    writeFileSync(join(o.out, `${o.name}.events.json`), JSON.stringify(clipEvents.filter((e) => e.clipFrame >= 0), null, 0));
    const errs = [...page.consoleErrors(), ...page.exceptions.map((e) => e.text)];
    if (errs.length) log('page errors:', errs.slice(0, 3).join(' | '));
    log(`wrote ${mp4} (${nF} frames, ${o.seconds} s at ${o.fps} fps) in ${((Date.now() - t0) / 1000).toFixed(0)} s`, JSON.stringify(last));
  }
} finally {
  if (ff && ff.exitCode === null) ff.kill('SIGKILL');
  await env.close();
}
