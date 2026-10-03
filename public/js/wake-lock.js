// Screen wake lock (round 1 finding M2). OWNER: integrator.
//
// Why: the Joy-Con talks to Chrome over Web Bluetooth. macOS does not count that as keyboard or mouse activity, so a player
// who only aims and shoots with the Joy-Con produces no input for the operating system. After the idle timeout the display dims and sleeps,
// the tab is hidden, requestAnimationFrame stops, the game pauses itself, audio is suspended and the Bluetooth keep-alive
// timers are throttled. A page that holds a screen wake lock makes Chrome inhibit display sleep. The launcher also runs
// `caffeinate` (start.command); this is the in-page half, which also covers a game opened without the launcher.
//
// The idle timings of the owner's Mac and whether Chrome honours the lock there are UNVERIFIED-ON-HARDWARE: only the fake
// Navigator of the tests exercises this code.
//
// Behaviour: `setWanted(true, nowMs)` asks for a 'screen' lock as soon as the page is visible; the browser releases it
// whenever the tab is hidden, so it is asked for again on `visibilitychange`. A refusal (no support, insecure page, battery
// saver, policy) is remembered and retried at most every retryMs; it never throws and never blocks the game.

const RETRY_MS = 5000;

/**
 * @param {{navigator?:any, document?:any, log?:(level:string, message:string)=>void, retryMs?:number}} [deps]
 */
export function createWakeLock(deps = {}) {
  const nav = deps.navigator;
  const doc = deps.document;
  const log = deps.log ?? (() => {});
  const retryMs = deps.retryMs ?? RETRY_MS;
  const api = nav && nav.wakeLock && typeof nav.wakeLock.request === 'function' ? nav.wakeLock : null;

  let wanted = false;
  let sentinel = null;
  let pending = false;
  let disposed = false;
  let requests = 0;
  let grants = 0;
  let releases = 0;
  let lastError = null;
  let retryAt = 0;
  let lastNow = 0;

  const hidden = () => !!(doc && doc.hidden);

  function drop(s) {
    if (!s) return;
    try {
      const r = s.release();
      if (r && typeof r.catch === 'function') r.catch(() => {});
    } catch {
      /* already released */
    }
  }

  function acquire() {
    if (sentinel && sentinel.released === true) sentinel = null; // released behind our back without a `release` event
    if (!api || disposed || !wanted || sentinel || pending || hidden() || lastNow < retryAt) return;
    pending = true;
    requests += 1;
    let p;
    try {
      p = Promise.resolve(api.request('screen'));
    } catch (err) {
      p = Promise.reject(err);
    }
    p.then(
      (s) => {
        pending = false;
        if (disposed || !wanted || sentinel) {
          drop(s); // it was released, or is no longer needed, while the browser was deciding
          return;
        }
        sentinel = s;
        grants += 1;
        lastError = null;
        if (s && typeof s.addEventListener === 'function') {
          s.addEventListener('release', () => {
            if (sentinel !== s) return;
            sentinel = null;
            releases += 1;
            // Chrome releases the lock when the tab is hidden: visibilitychange asks again. Any other release is retried by the next sync.
          });
        }
      },
      (err) => {
        pending = false;
        lastError = `${err && err.name ? `${err.name}: ` : ''}${err && err.message ? err.message : err}`;
        retryAt = lastNow + retryMs;
        log('warn', `screen wake lock refused (${lastError}); the display may sleep while nothing touches the keyboard or mouse`);
      },
    );
  }

  const onVisibility = () => {
    if (!hidden()) acquire();
  };
  if (doc && typeof doc.addEventListener === 'function') doc.addEventListener('visibilitychange', onVisibility);

  return {
    /** True when this browser has the Screen Wake Lock API at all. */
    supported: !!api,
    /**
     * Declare whether the display must stay awake. Cheap enough to call every frame: it only acts on a change, or to retry
     * after a refusal or a release. `nowMs` is the app clock (used for the retry delay).
     */
    setWanted(on, nowMs = lastNow) {
      lastNow = Number.isFinite(nowMs) ? nowMs : lastNow;
      const w = !!on;
      if (!w) {
        wanted = false;
        if (sentinel) {
          const s = sentinel;
          sentinel = null;
          drop(s);
        }
        return;
      }
      wanted = true;
      acquire();
    },
    getState: () => ({ supported: !!api, wanted, held: sentinel !== null, pending, requests, grants, releases, lastError }),
    dispose() {
      disposed = true;
      wanted = false;
      if (doc && typeof doc.removeEventListener === 'function') doc.removeEventListener('visibilitychange', onVisibility);
      if (sentinel) {
        const s = sentinel;
        sentinel = null;
        drop(s);
      }
    },
  };
}
