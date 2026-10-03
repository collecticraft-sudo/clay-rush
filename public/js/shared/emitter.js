// Tiny synchronous event emitter used by InputProvider and MotionPipeline. OWNER: architect (frozen).
// Contract: handlers run synchronously in registration order; an exception in one handler is caught and reported with
// console.error so that a broken listener can never stop the sample stream; on() returns an unsubscribe function.

export class Emitter {
  #handlers = new Map();

  /** @param {string} type @param {(payload:any) => void} fn @returns {() => void} unsubscribe */
  on(type, fn) {
    if (typeof fn !== 'function') throw new TypeError('Emitter.on: handler must be a function');
    let set = this.#handlers.get(type);
    if (!set) this.#handlers.set(type, (set = []));
    set.push(fn);
    return () => this.off(type, fn);
  }

  /** @param {string} type @param {(payload:any) => void} fn @returns {() => void} unsubscribe */
  once(type, fn) {
    const off = this.on(type, (payload) => {
      off();
      fn(payload);
    });
    return off;
  }

  off(type, fn) {
    const set = this.#handlers.get(type);
    if (!set) return;
    const i = set.indexOf(fn);
    if (i >= 0) set.splice(i, 1);
    if (set.length === 0) this.#handlers.delete(type);
  }

  emit(type, payload) {
    const set = this.#handlers.get(type);
    if (!set) return;
    for (const fn of set.slice()) {
      try {
        fn(payload);
      } catch (err) {
        if (typeof console !== 'undefined') console.error(`[emitter] handler for "${type}" threw`, err);
      }
    }
  }

  listenerCount(type) {
    return this.#handlers.get(type)?.length ?? 0;
  }

  removeAll() {
    this.#handlers.clear();
  }
}
