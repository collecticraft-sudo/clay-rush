// End-to-end environment: the game server on a free port plus a headless Google Chrome driven over the DevTools protocol.
// OWNER: integrator. docs/architecture.md 9.4.
//
// If Chrome is missing or cannot start, startE2e() THROWS, so `npm test` fails loudly instead of staying green with no browser test run
// (round 2 finding n1). Only with E2E_OPTIONAL=1 does it return { skip: '<reason>' } and the tests report `skipped`, never `passed`.
// The e2e suite proves the browser side of the wiring (real module loading over HTTP, canvas, timers, storage, pointer events).
// It cannot say anything about the physical Joy-Con: the simulator models docs/joycon2-protocol.md (UNVERIFIED-ON-HARDWARE).

import { mkdirSync } from 'node:fs';
import { startServer } from '../../server.js';
import { findChrome, launchChrome } from './chrome-launcher.js';
import { Page } from './cdp.js';

/** In-page helpers installed before every document: a bot that plays rounds through window.__clay and a snapshot fingerprint. */
export const PAGE_HELPERS = `
(() => {
  const fnv = (str) => { let h = 0x811c9dc5; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return h >>> 0; };
  const shootable = (s, minAge) => s.targets.find((x) => x.ageS > minAge && x.sx > 40 && x.sx < 1880 && x.sy > 40 && x.sy < 1040);
  window.__helpers = {
    fnv,
    fingerprint: (v) => fnv(JSON.stringify(v)),
    /**
     * Play a round under ?clock=manual with a bot that shoots every airborne clay through __clay.shootTarget (the real hit test of the
     * game; Classic calls its pulls with autoLaunch). missEvery: every n-th shot is aimed 400 px off. Resolves on the results screen or at maxS.
     */
    async botPlay(mode, o = {}) {
      const { seed = 7, difficulty = 'normal', stage, maxS = 400, stepMs = 50, missEvery = 0, leadMs = 0, minAge = 0.15 } = o;
      const C = window.__clay;
      C.start(mode, { seed, difficulty, stage });
      const stats = { shots: 0, hits: 0, events: {}, stages: [] };
      let guard = 0;
      while (C.snapshot().screen === 'playing' && guard++ < 40000) {
        const s = C.snapshot();
        if (s.t > maxS) break;
        if (s.stage && !stats.stages.includes(s.stage.id)) stats.stages.push(s.stage.id);
        const tg = shootable(s, minAge);
        if (tg && (s.shells.infinite || s.shells.loaded > 0) && !(s.shells.reloadingS > 0)) {
          stats.shots++;
          const miss = missEvery > 0 && stats.shots % missEvery === 0;
          const r = await C.shootTarget(tg.id, { offsetPx: miss ? 400 : 0, leadMs });
          if (r.hit) stats.hits++;
          for (const e of r.events) stats.events[e.type] = (stats.events[e.type] || 0) + 1;
          continue;
        }
        C.advance(stepMs);
      }
      const s = C.snapshot();
      return { stats, screen: s.screen, t: s.t, score: s.score, phase: s.phase, endReason: s.endReason, snapStats: s.stats, mode: s.mode };
    },
    /** Real time: shoot whatever is shootable for ms (the frames come from requestAnimationFrame). */
    async botRealTime(ms, o = {}) {
      const { minAge = 0.3 } = o;
      const C = window.__clay;
      const t0 = performance.now();
      let shots = 0, hits = 0;
      while (performance.now() - t0 < ms) {
        const s = C.snapshot();
        if (s.screen !== 'playing') break;
        if (s.phase === 'ready') { await C.callPull(); continue; }
        const tg = shootable(s, minAge);
        if (tg && (s.shells.infinite || s.shells.loaded > 0) && !(s.shells.reloadingS > 0)) { shots++; if ((await C.shootTarget(tg.id)).hit) hits++; }
        else await new Promise((r) => setTimeout(r, 30));
      }
      return { shots, hits, snap: C.snapshot() };
    },
    /** How many distinct colours a coarse grid of the canvas shows (a blank or single colour canvas is a rendering failure). */
    canvasColours() {
      const c = document.getElementById('stage');
      const ctx = c.getContext('2d');
      const seen = new Set();
      const cols = 24, rows = 14;
      for (let i = 0; i < cols; i++) for (let j = 0; j < rows; j++) {
        const d = ctx.getImageData(Math.floor(((i + 0.5) * c.width) / cols), Math.floor(((j + 0.5) * c.height) / rows), 1, 1).data;
        seen.add((d[0] >> 3) + ',' + (d[1] >> 3) + ',' + (d[2] >> 3));
      }
      return seen.size;
    },
  };
})();
`;

/**
 * A missing or broken Chrome is an error unless the caller said that a run without the browser tests is acceptable (E2E_OPTIONAL=1).
 * @param {string} reason
 * @returns {{skip:string, close:()=>Promise<void>}}
 */
export function skipOrFail(reason, env = process.env) {
  if (env.E2E_OPTIONAL === '1') return { skip: reason, close: async () => {} };
  throw new Error(`e2e: ${reason}. Install Google Chrome or set CHROME_PATH; set E2E_OPTIONAL=1 to accept a run without the browser tests (they are then reported as skipped).`);
}

/**
 * @param {{width?:number, height?:number, server?:object}} [opts]  `server`: extra options of startServer (the native e2e passes `bridge` with the fake helper)
 * @returns {Promise<{skip:string|false, url?:string, chrome?:string, newPage?:Function, openGame?:Function, close:()=>Promise<void>}>}
 */
export async function startE2e(opts = {}) {
  const bin = findChrome();
  if (!bin) return skipOrFail('Google Chrome not found');
  let server = null;
  let browser = null;
  try {
    server = await startServer({ port: 0, ...(opts.server ?? {}) });
    browser = await launchChrome({ width: opts.width ?? 1920, height: opts.height ?? 1080 });
  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    if (server) await server.close().catch(() => {});
    return skipOrFail(`Chrome could not be started: ${err.message}`);
  }
  const pages = new Set();
  const shotDir = process.env.E2E_SCREENSHOTS || null;
  if (shotDir) mkdirSync(shotDir, { recursive: true });
  const env = {
    skip: false,
    url: server.url,
    chrome: browser.version,
    async newPage(pageOpts = {}) {
      const page = await Page.create(browser.conn, { width: opts.width ?? 1920, height: opts.height ?? 1080, ...pageOpts });
      await page.addInitScript(PAGE_HELPERS);
      pages.add(page);
      return page;
    },
    /** Open the game with URL flags and wait for __clay.ready. `init` scripts run before the page's own scripts. */
    async openGame(query, { init = [], page = null } = {}) {
      const p = page ?? (await env.newPage());
      for (const src of init) await p.addInitScript(src);
      await p.goto(`${server.url}/?${query}`);
      await p.evaluate('window.__clay.ready');
      return p;
    },
    /** Under E2E_SCREENSHOTS=dir: a PNG of the page (1920 x 1080; tools may shrink it). Paints first under the manual clock. */
    async screenshot(page, name) {
      if (!shotDir) return;
      await page.evaluate('window.__clay && window.__clay.manualClock && window.__clay.debug.draw()').catch(() => {});
      await page.screenshot(`${shotDir}/${name}.png`);
    },
    async close() {
      for (const p of pages) await p.close().catch(() => {});
      await browser.close().catch(() => {});
      await server.close().catch(() => {});
    },
  };
  return env;
}

export const angleDeg = (a, b) => (Math.acos(Math.max(-1, Math.min(1, a.x * b.x + a.y * b.y + a.z * b.z))) * 180) / Math.PI;
