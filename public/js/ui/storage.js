// Persistent settings, best scores and flags of Clay Rush. OWNER: UI engineer. docs/architecture.md 8.4.
//
// Rules implemented here:
//   - ONE JSON document under one localStorage key ('clayRush.v1'): { v: 1, best, settings, safetyAck, playMsTotal }. No migration from the
//     keys of the game this one was forked from: Clay Rush starts fresh.
//   - EVERY storage access is inside try/catch. Missing, blocked, throwing or corrupted storage never throws; everything is kept in memory for
//     the session and isPersistent() reports false.
//   - Settings are validated on load and on every update: numbers snap to the nearest legal step inside their range, enums and booleans that
//     are not legal fall back to the previous (legal) value.
//   - Best scores: `best` is a map bestKey -> entry. The helpers (bestKey, emptyBest, sanitizeBest, isNewBest, updateBest) belong to game/
//     (docs/architecture.md 5), which ui/ may not import (rule 3): app.js injects them as `deps.bestHelpers`; without them the local
//     fallback below (same behaviour as the contract describes) is used. See docs/contract-notes.md.

export const STORAGE_KEY = 'clayRush.v1';
export const STORAGE_VERSION = 1;

/** Numeric settings: legal range and step (docs/architecture.md 8.4). */
export const SETTINGS_SPEC = Object.freeze({
  sensitivity: Object.freeze({ min: 0.5, max: 3.0, step: 0.1 }),
  triggerCompMs: Object.freeze({ min: 0, max: 100, step: 10 }),
  volume: Object.freeze({ min: 0, max: 1, step: 0.1 }),
});

/** Enumerated settings and their legal values, in display order. */
export const SETTINGS_ENUMS = Object.freeze({
  aimCurve: Object.freeze(['precise', 'balanced', 'fast']),
  triggerButton: Object.freeze(['ZR', 'R']),
  crosshairColor: Object.freeze(['white', 'yellow', 'green', 'magenta']),
  difficulty: Object.freeze(['easy', 'normal', 'hard']),
  stage: Object.freeze(['meadow', 'hills', 'alpine']),
});

export const SETTINGS_BOOLS = Object.freeze(['rumble', 'aimAssist', 'autoPull', 'autoCenter', 'reduceFlash', 'reduceMotion', 'flipX']);

export const SETTINGS_DEFAULTS = Object.freeze({
  sensitivity: 1.0,
  aimCurve: 'balanced',
  triggerButton: 'ZR',
  triggerCompMs: 40,
  rumble: true,
  aimAssist: false,
  autoPull: false,
  autoCenter: true,
  crosshairColor: 'white',
  difficulty: 'normal',
  stage: 'hills',
  volume: 0.8,
  reduceFlash: false,
  reduceMotion: false,
  flipX: false,
});

/** Snap a number to the nearest legal step inside [min, max]; non-finite input gives `fallback`. */
export function snapToSpec(value, spec, fallback) {
  const v = typeof value === 'number' ? value : Number.NaN;
  if (!Number.isFinite(v)) return fallback;
  const clamped = Math.min(spec.max, Math.max(spec.min, v));
  const snapped = spec.min + Math.round((clamped - spec.min) / spec.step) * spec.step;
  return Number(Math.min(spec.max, Math.max(spec.min, snapped)).toFixed(6));
}

/**
 * Turn arbitrary input into a complete, legal Settings object. Unknown keys are dropped, illegal values fall back to `base` (already legal).
 * @param {any} raw
 * @param {object} [base]
 */
export function sanitizeSettings(raw, base = SETTINGS_DEFAULTS) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const out = {};
  for (const k of Object.keys(SETTINGS_DEFAULTS)) out[k] = base[k] ?? SETTINGS_DEFAULTS[k];
  for (const k of Object.keys(SETTINGS_SPEC)) out[k] = snapToSpec(src[k], SETTINGS_SPEC[k], out[k]);
  for (const [k, values] of Object.entries(SETTINGS_ENUMS)) if (values.includes(src[k])) out[k] = src[k];
  for (const k of SETTINGS_BOOLS) if (typeof src[k] === 'boolean') out[k] = src[k];
  return out;
}

// ---------------------------------------------------------------------------------------------------------------- best-score helpers
// Local fallback of the game/ helpers (docs/architecture.md 5). Entry shape: {score, rank, accuracy, broken, presented, bestStreak, assist, at}.

const BEST_MODES = Object.freeze(['classic', 'timeattack']);
const finiteInt = (v, d = 0) => (Number.isFinite(v) ? Math.max(0, Math.floor(v)) : d);

function localBestKey(mode, difficulty, stageId) {
  if (mode === 'timeattack') return `timeattack.${difficulty ?? 'normal'}.${stageId ?? 'hills'}`;
  return `${mode}.${difficulty ?? 'normal'}`;
}

function localSanitizeEntry(e) {
  if (!e || typeof e !== 'object' || !Number.isFinite(e.score)) return null;
  return {
    score: finiteInt(e.score),
    rank: ['S', 'A', 'B', 'C', 'D'].includes(e.rank) ? e.rank : null,
    accuracy: Number.isFinite(e.accuracy) ? Math.min(1, Math.max(0, e.accuracy)) : null,
    broken: finiteInt(e.broken),
    presented: finiteInt(e.presented),
    bestStreak: finiteInt(e.bestStreak),
    assist: e.assist === true,
    at: typeof e.at === 'string' ? e.at : '',
  };
}

export const LOCAL_BEST_HELPERS = Object.freeze({
  bestKey: localBestKey,
  emptyBest: () => ({}),
  sanitizeBest(raw) {
    const out = {};
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
    for (const [k, e] of Object.entries(raw)) {
      if (!/^(classic|timeattack)\.(easy|normal|hard)(\.(meadow|hills|alpine))?$/.test(k)) continue;
      const s = localSanitizeEntry(e);
      if (s) out[k] = s;
    }
    return out;
  },
  isNewBest(best, result) {
    if (!result || !BEST_MODES.includes(result.mode) || !(result.score > 0)) return false;
    const prev = best?.[localBestKey(result.mode, result.difficulty, result.stageId)];
    return !prev || result.score > prev.score;
  },
  updateBest(best, result, at = '') {
    const out = { ...(best ?? {}) };
    if (!LOCAL_BEST_HELPERS.isNewBest(best, result)) return out;
    out[localBestKey(result.mode, result.difficulty, result.stageId)] = localSanitizeEntry({
      score: result.score, rank: result.rank, accuracy: result.accuracy, broken: result.broken, presented: result.presented,
      bestStreak: result.bestStreak, assist: result.assist === true, at,
    });
    return out;
  },
});

/** Merge injected game/ helpers over the local fallback (any missing function keeps the local one). */
function resolveBestHelpers(h) {
  const out = { ...LOCAL_BEST_HELPERS };
  if (h && typeof h === 'object') {
    for (const k of Object.keys(LOCAL_BEST_HELPERS)) if (typeof h[k] === 'function') out[k] = h[k];
  }
  return out;
}

/** The score field of a best entry, whatever its exact shape (local fallback or game/ helpers). */
export function bestScoreOf(entry) {
  if (entry === null || entry === undefined) return null;
  if (typeof entry === 'number') return Number.isFinite(entry) ? entry : null;
  return Number.isFinite(entry.score) ? entry.score : null;
}

// ---------------------------------------------------------------------------------------------------------------- the store
function resolveBackend(explicit) {
  if (explicit !== undefined) return explicit;
  try {
    return globalThis.localStorage ?? null; // the getter itself throws when site data is blocked
  } catch {
    return null;
  }
}

function prefersReducedMotion(matchMedia) {
  try {
    const mm = matchMedia ?? globalThis.matchMedia;
    return typeof mm === 'function' ? !!mm.call(globalThis, '(prefers-reduced-motion: reduce)')?.matches : false;
  } catch {
    return false;
  }
}

/**
 * @param {{key?:string, backend?:{getItem:Function,setItem:Function}|null, matchMedia?:Function, now?:()=>string,
 *          overrides?:object, bestHelpers?:object}} [deps]
 *   overrides: settings forced on top of the stored ones and never persisted (?reducemotion=1, ?reduceflash=1).
 *   bestHelpers: {bestKey, emptyBest, sanitizeBest, isNewBest, updateBest} from game/index.js (injected by app.js).
 */
export function createStorage(deps = {}) {
  const key = deps.key ?? STORAGE_KEY;
  const backend = resolveBackend(deps.backend);
  const nowIso = deps.now ?? (() => new Date().toISOString());
  const overrides = deps.overrides ?? {};
  const helpers = resolveBestHelpers(deps.bestHelpers);

  let persistent = backend !== null && backend !== undefined;
  let foreign = false; // the stored document has another version: never written (U-06)
  const safeEmpty = () => {
    try {
      const e = helpers.emptyBest();
      return e && typeof e === 'object' ? e : {};
    } catch {
      return {};
    }
  };
  const data = { best: safeEmpty(), settings: null, safetyAck: false, playMsTotal: 0 };

  function load() {
    let text = null;
    try {
      if (!backend) throw new Error('no backend');
      text = backend.getItem(key);
    } catch {
      persistent = false;
      return;
    }
    if (text === null || text === undefined) return;
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      return; // corrupted JSON: start from defaults; the next successful save overwrites it
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
    // U-06: a document of ANOTHER version (a newer game wrote it) is read as far as it is understood but never overwritten: this session
    // keeps its changes in memory, so the newer data (best scores of new modes, new settings) survives
    if (parsed.v !== undefined && parsed.v !== STORAGE_VERSION) foreign = true;
    try {
      data.best = helpers.sanitizeBest(parsed.best) ?? safeEmpty();
    } catch {
      data.best = safeEmpty();
    }
    if (parsed.settings && typeof parsed.settings === 'object') data.settings = parsed.settings;
    data.safetyAck = parsed.safetyAck === true;
    data.playMsTotal = Number.isFinite(parsed.playMsTotal) ? Math.max(0, parsed.playMsTotal) : 0;
  }

  const baseDefaults = () => ({ ...SETTINGS_DEFAULTS, reduceMotion: prefersReducedMotion(deps.matchMedia) });
  load();
  let settings = sanitizeSettings(data.settings, baseDefaults());

  function save() {
    if (!backend || foreign) {
      persistent = false;
      return;
    }
    try {
      backend.setItem(key, JSON.stringify({ v: STORAGE_VERSION, best: data.best, settings, safetyAck: data.safetyAck, playMsTotal: data.playMsTotal }));
      persistent = true;
    } catch {
      persistent = false; // keep working from memory
    }
  }

  // The merged settings are built once per change, not on every call; frozen so they can be shared.
  let effectiveCache = null;
  let effectiveFor = null;
  const effective = () => {
    if (effectiveCache === null || effectiveFor !== settings) {
      effectiveCache = Object.freeze({ ...settings, ...overrides });
      effectiveFor = settings;
    }
    return effectiveCache;
  };

  function keyOf(mode, difficulty, stageId) {
    try {
      return helpers.bestKey(mode, difficulty, stageId);
    } catch {
      return localBestKey(mode, difficulty, stageId);
    }
  }

  return {
    key,
    getSettings: () => effective(),
    updateSettings(patch) {
      settings = sanitizeSettings({ ...settings, ...(patch && typeof patch === 'object' ? patch : {}) }, settings);
      save();
      return effective();
    },
    resetSettings() {
      settings = sanitizeSettings(null, baseDefaults());
      save();
      return effective();
    },
    bestKey: keyOf,
    /** The best entry of a mode, difficulty and stage (stage only for Time Attack), or null. A copy. */
    getBest(mode, difficulty, stageId) {
      const e = data.best?.[keyOf(mode, difficulty, stageId)];
      return e && typeof e === 'object' ? { ...e } : e ?? null;
    },
    /** The whole best map (a shallow copy). */
    getAllBest: () => ({ ...(data.best ?? {}) }),
    /**
     * Record a finished round (RoundResult). Returns {isNewBest, best, previous}. Practice and Zen rounds never set a best.
     * @param {import('../shared/contracts.js').RoundResult} result
     */
    recordResult(result) {
      if (!result || typeof result !== 'object') return { isNewBest: false, best: null, previous: null };
      const k = keyOf(result.mode, result.difficulty, result.stageId);
      const previous = data.best?.[k] ?? null;
      let isNew = false;
      if (result.mode === 'classic' || result.mode === 'timeattack') {
        try {
          isNew = !!helpers.isNewBest(data.best, result);
        } catch {
          isNew = LOCAL_BEST_HELPERS.isNewBest(data.best, result);
        }
      }
      if (isNew) {
        try {
          data.best = helpers.updateBest(data.best, result, nowIso()) ?? data.best;
        } catch {
          data.best = LOCAL_BEST_HELPERS.updateBest(data.best, result, nowIso());
        }
        save();
      }
      return { isNewBest: isNew, best: data.best?.[k] ?? null, previous };
    },
    resetBest() {
      data.best = safeEmpty();
      save();
    },
    getSafetyAck: () => data.safetyAck,
    setSafetyAck() {
      data.safetyAck = true;
      save();
    },
    getPlayMsTotal: () => data.playMsTotal,
    addPlayMs(ms) {
      if (Number.isFinite(ms) && ms > 0) data.playMsTotal += ms;
      save();
      return data.playMsTotal;
    },
    isPersistent: () => persistent && !foreign,
    /** True when a URL flag forces this setting for the session (?reducemotion=1, ?reduceflash=1): the UI shows it locked (U-07). */
    isOverridden: (k) => Object.hasOwn(overrides, k),
  };
}
