// Virtual timers tied to a manual clock. Test helper of the input engineer.
//
// The BLE provider, the transport and the simulator take their timers as a parameter (public/js/input/timers.js), so a
// test never sleeps: `await timers.advance(ms)` moves the manual clock and fires every due timer in order, letting the
// promise chains that depend on them settle between two firings. `setImmediate` only yields to the event loop; no real
// time passes.

export const flush = () => new Promise((resolve) => setImmediate(resolve));

/**
 * @param {{now:()=>number, set:(ms:number)=>void}} clock  a manual clock from shared/clock.js
 */
export function createFakeTimers(clock) {
  let nextId = 1;
  const timers = new Map(); // id -> {at, fn, every}

  const schedule = (fn, ms, every) => {
    const id = nextId++;
    timers.set(id, { at: clock.now() + Math.max(0, Number(ms) || 0), fn, every });
    return id;
  };

  const api = {
    setTimeout: (fn, ms) => schedule(fn, ms, 0),
    clearTimeout: (id) => {
      timers.delete(id);
    },
    setInterval: (fn, ms) => schedule(fn, ms, Math.max(1, Number(ms) || 1)),
    clearInterval: (id) => {
      timers.delete(id);
    },
    /** Number of timers that are still scheduled. */
    pending: () => timers.size,
    /** Let pending promise continuations run without moving time. */
    flush,
    /** Move the clock forward, firing due timers in order (ties: creation order). */
    async advance(ms) {
      const target = clock.now() + ms;
      await flush();
      for (;;) {
        let best = null;
        let bestId = 0;
        for (const [id, t] of timers) {
          if (t.at <= target && (best === null || t.at < best.at || (t.at === best.at && id < bestId))) {
            best = t;
            bestId = id;
          }
        }
        if (!best) break;
        if (best.at > clock.now()) clock.set(best.at);
        if (best.every) best.at += best.every;
        else timers.delete(bestId);
        best.fn();
        await flush();
      }
      if (target > clock.now()) clock.set(target);
      await flush();
    },
  };
  return api;
}
