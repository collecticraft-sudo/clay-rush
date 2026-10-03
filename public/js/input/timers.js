// Timer injection. OWNER: input engineer.
//
// Providers never call the global timer functions directly: tests pass fake timers tied to a manual clock
// (test-support/input/fake-timers.js) and the browser gets the real ones. Everything is guarded, so the module is
// importable in Node with no globals (architecture rule 6).

/**
 * @typedef {Object} Timers
 * @property {(fn:()=>void, ms:number) => any} setTimeout
 * @property {(id:any) => void} clearTimeout
 * @property {(fn:()=>void, ms:number) => any} setInterval
 * @property {(id:any) => void} clearInterval
 */

/**
 * @param {Partial<Timers>} [custom]
 * @returns {Timers}
 */
export function resolveTimers(custom) {
  const g = globalThis;
  return {
    setTimeout: custom?.setTimeout ?? ((fn, ms) => g.setTimeout(fn, ms)),
    clearTimeout: custom?.clearTimeout ?? ((id) => g.clearTimeout(id)),
    setInterval: custom?.setInterval ?? ((fn, ms) => g.setInterval(fn, ms)),
    clearInterval: custom?.clearInterval ?? ((id) => g.clearInterval(id)),
  };
}

/** Promise that resolves after `ms` on the given timers. */
export function sleep(timers, ms) {
  return new Promise((resolve) => timers.setTimeout(resolve, ms));
}

/**
 * Race a promise against a timeout. The timer is always cleared, and a late rejection of the losing promise is
 * swallowed (the underlying GATT operation cannot be cancelled).
 * @template T
 * @param {Timers} timers
 * @param {Promise<T>} promise
 * @param {number} ms
 * @param {() => Error} makeError  error to reject with on timeout
 * @returns {Promise<T>}
 */
export function withTimeout(timers, promise, ms, makeError) {
  return new Promise((resolve, reject) => {
    let done = false;
    const id = timers.setTimeout(() => {
      if (done) return;
      done = true;
      reject(makeError());
    }, ms);
    promise.then(
      (value) => {
        if (done) return;
        done = true;
        timers.clearTimeout(id);
        resolve(value);
      },
      (err) => {
        if (done) return;
        done = true;
        timers.clearTimeout(id);
        reject(err);
      },
    );
  });
}
