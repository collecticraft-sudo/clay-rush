// Minimal DOM fakes for the input tests. Test helper of the input engineer.

/** Event with extra read-only properties (Event.timeStamp and friends have getters in Node, so plain assignment fails). */
export function makeEvent(type, props = {}) {
  const ev = new Event(type, { cancelable: true });
  for (const [key, value] of Object.entries(props)) Object.defineProperty(ev, key, { value, configurable: true });
  return ev;
}

export const pointerEvent = (type, props = {}) => makeEvent(type, { clientX: 0, clientY: 0, button: 0, pointerId: 1, timeStamp: 0, ...props });

/** A canvas-like pointer source. The default rect is exactly the 1920 x 1080 playfield, so client px = playfield px. */
export class FakeTarget extends EventTarget {
  constructor(rect = { left: 0, top: 0, width: 1920, height: 1080 }) {
    super();
    this.rect = rect;
    this.rectReads = 0;
  }

  getBoundingClientRect() {
    this.rectReads++;
    return this.rect;
  }

  /** Dispatch a pointer event; `coalesced` becomes getCoalescedEvents(). */
  pointer(type, props = {}, coalesced) {
    const ev = pointerEvent(type, props);
    if (coalesced) Object.defineProperty(ev, 'getCoalescedEvents', { value: () => coalesced.map((c) => pointerEvent(type, c)) });
    this.dispatchEvent(ev);
    return ev;
  }
}

export class FakeDocument extends EventTarget {
  constructor() {
    super();
    this.hidden = false;
  }

  setHidden(hidden) {
    this.hidden = hidden;
    this.dispatchEvent(makeEvent('visibilitychange'));
  }
}

/** Collects every payload of an emitter-style provider event type. */
export function collect(provider, type) {
  const items = [];
  provider.on(type, (payload) => items.push(payload));
  return items;
}
