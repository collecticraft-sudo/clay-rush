// Web font loading for the canvas text (architecture C-10 and 6.3). OWNER: Render & Audio engineer.
//
// Three small WOFF2 files ship in public/assets/fonts/ (SIL OFL, Latin subsets): Bebas Neue as the family "ClayDisplay" (one weight, registered
// for the whole range 100 to 900 so that the browser never synthesises a bold), and Barlow SemiBold + Barlow Bold as ONE family "ClayUI" with
// two weight ranges (100 to 650 answers with the 600 file, 651 to 900 with the 700 file). The canvas names them first in every font stack
// (palette.js FONTS) and falls through to the system stacks when a family is not usable yet or at all, so nothing here is required: no file,
// no FontFace (Node, old browsers), `?fonts=0` or `?assets=0`, a failed or slow download all mean "the system fonts".
//
// The loader never rejects, never throws and never blocks a frame. `generation` goes up every time a face becomes usable: the font STRING of
// the canvas is identical before and after the file arrives, so every cache that holds a measurement or a baked text must be dropped then
// (draw-util.js `invalidateTextCaches` is subscribed here; other caches use `onFontsChange` or compare `fontsGeneration()`).
// `loaded` and `failed` of the results list FAMILY names (a family is listed once; ClayUI is usable as soon as one of its two faces is).

import { ART_CONFIG } from './art-config.js';

/** The shipped files, relative to the assets folder (`ART_CONFIG.baseUrl`). `weight` is the range the face answers for: a range that covers
 * every weight keeps the browser from synthesising a bold of the one-weight display face. Mirrors design/fonts/fonts.json and the manifest. */
export const FONT_FILES = Object.freeze([
  Object.freeze({ id: 'display', family: 'ClayDisplay', file: 'fonts/range-display.woff2', weight: '100 900', style: 'normal' }),
  Object.freeze({ id: 'ui600', family: 'ClayUI', file: 'fonts/range-ui-600.woff2', weight: '100 650', style: 'normal' }),
  Object.freeze({ id: 'ui700', family: 'ClayUI', file: 'fonts/range-ui-700.woff2', weight: '651 900', style: 'normal' }),
]);

/** The two family names (palette.js puts them first in its stacks). */
export const FONT_FAMILIES = Object.freeze({ display: 'ClayDisplay', ui: 'ClayUI' });

/** Default time a download may take before the system fonts are accepted (a late file still switches the text when it arrives). */
export const FONT_TIMEOUT_MS = 2500;

let generation = 0;
const listeners = new Set();
const usable = new Set(); // family names that are loaded and registered
const failedFamilies = new Set();
let state = 'idle'; // idle | loading | ready | failed | off
let startedPromise = null;

/** Number of times a family became usable (0 while only the system fonts are in play). Compare it to a stored value to know a cache is stale. */
export const fontsGeneration = () => generation;

/** Call `cb(generation)` every time a family becomes usable. Returns the unsubscribe function. */
export function onFontsChange(cb) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function bump() {
  generation++;
  for (const cb of [...listeners]) {
    try {
      cb(generation);
    } catch {
      // a listener must never break the loader or the frame that triggered it
    }
  }
}

/** {state, loaded, failed, generation}: state is idle (not started), loading, ready (every file loaded), failed (some file did not load) or off. */
export function fontsStatus() {
  return { state, loaded: [...usable], failed: [...failedFamilies], generation };
}

/** True when a family of FONT_FILES is loaded and registered (the canvas then draws it instead of the fallback). */
export const fontUsable = (family) => usable.has(family);

/** Promise of the first load attempt (resolved with {loaded, failed} once it settled), or of an empty result when nothing was started. */
export function fontsReady() {
  return startedPromise ?? Promise.resolve({ loaded: [], failed: [] });
}

const joinUrl = (base, file) => (base === '' || base.endsWith('/') ? base : `${base}/`) + file;

/**
 * Load the fonts. Safe to call more than once: the first call does the work and every later call gets the same promise.
 * @param {object} [env]
 * @param {{fonts?:{add:Function}}} [env.document]  the document whose FontFaceSet receives the faces (default: the global one)
 * @param {string} [env.baseUrl]                    the assets folder (default ART_CONFIG.baseUrl)
 * @param {number} [env.timeoutMs]                  default 2500
 * @param {Function} [env.FontFace]                 the FontFace constructor (default: the global one; tests pass a fake)
 * @param {boolean} [env.enabled]                   false = `?fonts=0` or `?assets=0`: do nothing
 * @param {(ms:number, fn:Function)=>any} [env.setTimeout]  timer (tests); `env.clearTimeout(handle)` cancels it
 * @param {Array<{id:string,family:string,file:string,weight:string,style:string}>} [env.files]  default FONT_FILES
 * @returns {Promise<{loaded:string[], failed:string[]}>}  never rejects
 */
export function loadFonts(env = {}) {
  if (startedPromise) return startedPromise;
  const doc = env.document ?? (typeof document !== 'undefined' ? document : null);
  const FontFaceCtor = env.FontFace ?? (typeof FontFace !== 'undefined' ? FontFace : null);
  if (env.enabled === false) {
    state = 'off';
    startedPromise = Promise.resolve({ loaded: [], failed: [] });
    return startedPromise;
  }
  if (!doc || !doc.fonts || typeof doc.fonts.add !== 'function' || typeof FontFaceCtor !== 'function') {
    state = 'failed';
    startedPromise = Promise.resolve({ loaded: [], failed: [...new Set(FONT_FILES.map((f) => f.family))] });
    return startedPromise;
  }
  const base = typeof env.baseUrl === 'string' ? env.baseUrl : ART_CONFIG.baseUrl;
  const timeoutMs = Number.isFinite(env.timeoutMs) && env.timeoutMs > 0 ? env.timeoutMs : FONT_TIMEOUT_MS;
  const setT = env.setTimeout ?? ((ms, fn) => setTimeout(fn, ms));
  const clearT = env.clearTimeout ?? ((h) => clearTimeout(h));
  const files = env.files ?? FONT_FILES;
  state = 'loading';
  const result = { loaded: [], failed: [] };

  const loadOne = (f) =>
    new Promise((resolve) => {
      let settled = false;
      let timer = null;
      const done = (ok) => {
        if (settled) return;
        settled = true;
        if (timer !== null) clearT(timer);
        if (!ok && !result.failed.includes(f.family)) result.failed.push(f.family);
        resolve();
      };
      let face = null;
      try {
        face = new FontFaceCtor(f.family, `url("${joinUrl(base, f.file)}") format("woff2")`, { weight: f.weight, style: f.style, display: 'swap' });
        Promise.resolve(face.load()).then(
          (loadedFace) => {
            try {
              doc.fonts.add(loadedFace ?? face);
            } catch {
              done(false);
              return;
            }
            usable.add(f.family);
            failedFamilies.delete(f.family);
            if (settled) {
              // arrived after the timeout: the text switches now, the boot did not wait for it
              const i = result.failed.indexOf(f.family);
              if (i >= 0) result.failed.splice(i, 1);
              if (!result.loaded.includes(f.family)) result.loaded.push(f.family);
              state = result.failed.length === 0 ? 'ready' : state;
              bump();
              return;
            }
            if (!result.loaded.includes(f.family)) result.loaded.push(f.family);
            settled = true;
            if (timer !== null) clearT(timer);
            bump();
            resolve();
          },
          () => {
            failedFamilies.add(f.family);
            done(false);
          },
        );
      } catch {
        failedFamilies.add(f.family);
        done(false);
        return;
      }
      if (!settled) {
        timer = setT(timeoutMs, () => {
          timer = null;
          if (!settled) failedFamilies.add(f.family);
          done(false);
        });
      }
    });

  startedPromise = Promise.all(files.map(loadOne)).then(() => {
    state = result.failed.length === 0 ? 'ready' : 'failed';
    return { loaded: [...result.loaded], failed: [...result.failed] };
  });
  return startedPromise;
}

/** Read `?fonts=0` / `?assets=0|off` from a query string (the two switches that turn the files off on purpose). */
export function fontsEnabledByQuery(search) {
  try {
    const q = new URLSearchParams(String(search ?? ''));
    const off = (k) => {
      const v = q.get(k);
      return v !== null && (v === '0' || v === 'off' || v === 'false');
    };
    return !(off('fonts') || off('assets'));
  } catch {
    return true;
  }
}

let autoTried = false;
/**
 * Start loading once, from the globals of a browser (document, location). Called by draw-util.js the first time text is drawn, so the game
 * gets its fonts without the integrator wiring anything: in Node (no document) it only marks itself done. An explicit `loadFonts()` call
 * from app.js before that wins (same promise).
 */
export function ensureFontsStarted() {
  if (autoTried) return startedPromise;
  autoTried = true;
  if (startedPromise) return startedPromise;
  if (typeof document === 'undefined' || typeof FontFace === 'undefined') return null;
  const search = typeof location !== 'undefined' ? location.search : '';
  return loadFonts({ enabled: fontsEnabledByQuery(search) });
}

/** Tests only: forget the loading state (a fresh loader). Listeners stay: draw-util.js subscribed its cache invalidation once, at import. */
export function resetFontsForTests() {
  generation = 0;
  usable.clear();
  failedFamilies.clear();
  state = 'idle';
  startedPromise = null;
  autoTried = false;
}
