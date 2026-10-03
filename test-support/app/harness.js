// Harness for the whole-app tests (test/app): the real app.js wired with the fakes of test-support (fake canvas and window, memory
// storage, manual clock). Nothing here touches a real browser or a real Joy-Con. OWNER: integrator.
//
// Everything runs through window.__clay exactly like an automated agent would. The simulator and the fake canvas model
// docs/joycon2-protocol.md and a browser; they say nothing about the physical Joy-Con (UNVERIFIED-ON-HARDWARE).

import { createApp } from '../../public/js/app.js';
import { FakeCanvas, FakeWindow, createFakeCanvasFactory } from '../render/fake-canvas.js';
import { FakeDocument } from '../input/fake-dom.js';
import { memoryBackend } from '../ui/fixtures.js';

/** FNV-1a 32 bit over a string: a cheap fingerprint of a snapshot. */
export function fingerprint(value) {
  const str = typeof value === 'string' ? value : JSON.stringify(value);
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export const DEFAULT_SEARCH = '?input=sim&clock=manual&skipsafety=1&mute=1&seed=1';

/**
 * @param {string} search  URL flags, e.g. '?input=sim&clock=manual&skipsafety=1&mute=1&seed=1'
 * @param {object} [o]     {storageBackend, localStorage, console, bluetooth, env} extra createApp() env entries
 */
export async function makeApp(search = DEFAULT_SEARCH, o = {}) {
  const canvas = new FakeCanvas();
  const win = new FakeWindow({ bluetooth: o.bluetooth !== false });
  const doc = new FakeDocument();
  const factory = createFakeCanvasFactory();
  const app = createApp({
    window: win, document: doc, canvas, search, createCanvas: factory.createCanvas, requestAnimationFrame: null,
    storageBackend: o.storageBackend ?? memoryBackend(), localStorage: o.localStorage ?? null, console: o.console ?? silentConsole(),
    ...(o.env ?? {}),
  });
  await app.start();
  const c = app.clay;
  const h = {
    app, c, canvas, win, doc,
    snap: () => c.snapshot(),
    ui: () => c.getUiState(),
    screen: () => c.getUiState().screen,
    run: (ms) => c.advance(ms),
    /** advance until predicate(snapshot) holds, at most maxMs; returns the snapshot */
    until(pred, maxMs = 20000, stepMs = 50) {
      let s = c.snapshot();
      for (let el = 0; el < maxMs && !pred(s); el += stepMs) {
        c.advance(stepMs);
        s = c.snapshot();
      }
      return s;
    },
    key: (key) => win.dispatch('keydown', { key, code: key === ' ' ? 'Space' : key, repeat: false }),
    keyUp: (key) => win.dispatch('keyup', { key, code: key === ' ' ? 'Space' : key, repeat: false }),
    mouse: {
      move: (x, y) => canvas.dispatch('pointermove', { clientX: x, clientY: y, pointerId: 1, pointerType: 'mouse' }),
      down: (x, y, button = 0) => canvas.dispatch('pointerdown', { clientX: x, clientY: y, button, pointerId: 1, pointerType: 'mouse' }),
      up: (x, y, button = 0) => canvas.dispatch('pointerup', { clientX: x, clientY: y, button, pointerId: 1, pointerType: 'mouse' }),
      click: (x, y) => {
        canvas.dispatch('pointermove', { clientX: x, clientY: y, pointerId: 1, pointerType: 'mouse' });
        canvas.dispatch('pointerdown', { clientX: x, clientY: y, button: 0, pointerId: 1, pointerType: 'mouse' });
        canvas.dispatch('pointerup', { clientX: x, clientY: y, button: 0, pointerId: 1, pointerType: 'mouse' });
      },
    },
    /** The centre of a UI target (menu button) by id, or null (targets are described by their centre, ui/hit.js). */
    target: (id) => {
      const tg = c.debug.getUiView().targets.find((x) => x.id === id);
      return tg ? { x: tg.x, y: tg.y } : null;
    },
    log: () => app.getLog(),
    problems: () => app.getLog().filter((l) => l.level === 'warn' || l.level === 'error'),
    dispose: () => app.dispose(),
  };
  return h;
}

export function silentConsole() {
  const lines = [];
  const push = (level) => (...a) => lines.push([level, a.join(' ')]);
  return { lines, log: push('log'), info: push('info'), warn: push('warn'), error: push('error') };
}

/**
 * A bot for one Classic round under the manual clock: it calls each pull (or lets autoLaunch call it), then shoots every airborne target
 * through __clay.shootTarget (the real hit test of the game), one shell per target. Returns counters and the final snapshot.
 * @param {object} h  makeApp() harness
 * @param {{mode?:string, seed?:number, difficulty?:string, stage?:string, maxS?:number, stepMs?:number, missEvery?:number, leadMs?:number}} [o]
 */
export async function botPlay(h, o = {}) {
  const { mode = 'classic', seed = 7, difficulty = 'normal', stage, maxS = 400, stepMs = 50, missEvery = 0, leadMs = 0 } = o;
  const c = h.c;
  c.start(mode, { seed, difficulty, stage });
  const stats = { shots: 0, hits: 0, events: {} };
  const tally = (events) => { for (const e of events) stats.events[e.type] = (stats.events[e.type] ?? 0) + 1; };
  let guard = 0;
  while (c.snapshot().screen === 'playing' && guard++ < 40000) {
    const s = c.snapshot();
    if (s.t > maxS) break;
    const tg = s.targets.filter((x) => x.sx > 40 && x.sx < 1880 && x.sy > 40 && x.sy < 1040 && x.ageS > 0.15)[0];
    if (tg && (s.shells?.loaded ?? 1) > 0) {
      stats.shots += 1;
      const miss = missEvery > 0 && stats.shots % missEvery === 0;
      const r = await c.shootTarget(tg.id, { offsetPx: miss ? 400 : 0, leadMs });
      if (r.hit) stats.hits += 1;
      tally(r.events);
      continue;
    }
    c.advance(stepMs);
  }
  return { stats, snap: c.snapshot() };
}
