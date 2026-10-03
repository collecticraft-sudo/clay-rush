// Pointer helpers shared by the mouse and simulator providers. OWNER: input engineer.

import { ACTION } from '../shared/contracts.js';
import { clientToPlayfield, FIELD, clamp } from '../shared/playfield.js';

/**
 * Event time on the Clock timebase. With the real clock, `event.timeStamp` is used when it is on the performance.now
 * timebase (within one second of the clock) and never later than `now`; otherwise, and always with the manual clock,
 * the clock is read. The result never goes backwards (`lastT`).
 */
export function eventTimeMs(clock, ev, lastT = -Infinity) {
  const now = clock.now();
  let t = now;
  if (!clock.manual && ev && Number.isFinite(ev.timeStamp) && ev.timeStamp > 0 && Math.abs(ev.timeStamp - now) < 1000) {
    t = Math.min(ev.timeStamp, now);
  }
  return t < lastT ? lastT : t;
}

/**
 * Converter from client coordinates to clamped playfield coordinates.
 * @param {{getBoundingClientRect:()=>object}|null} target
 * @param {((cx:number, cy:number) => {x:number,y:number}|null)|undefined} custom  opts.toPlayfield of the provider
 * @returns {{convert:(cx:number,cy:number,rect?:object)=>({x:number,y:number}|null), rect:()=>object|null}}
 */
export function makePlayfieldMapper(target, custom) {
  if (typeof custom === 'function') {
    return {
      rect: () => null,
      convert: (cx, cy) => {
        const p = custom(cx, cy);
        return p ? { x: clamp(p.x, 0, FIELD.w), y: clamp(p.y, 0, FIELD.h) } : null;
      },
    };
  }
  return {
    // One layout read per pointer event (allowed by architecture section 12), reused for every coalesced event.
    rect: () => (target && typeof target.getBoundingClientRect === 'function' ? target.getBoundingClientRect() : null),
    convert: (cx, cy, rect) => (rect ? clientToPlayfield(rect, cx, cy, { clamp: true }) : null),
  };
}

/** Pointer events of one dispatch: the coalesced ones when the browser provides them, else the event itself. */
export function eventsOf(ev) {
  const list = typeof ev.getCoalescedEvents === 'function' ? ev.getCoalescedEvents() : null;
  return list && list.length ? list : [ev];
}

/**
 * Right click = back, middle click = pause, double click = recenter (architecture 5.7, A-11). The left button is not handled
 * here: the mouse and simulator providers turn its PRESS into `fire` themselves (Clay Rush C-03), and its release stays a plain
 * click for the UI, which hit-tests canvas clicks itself. The context menu is suppressed over the target.
 * @param {EventTarget|null} target
 * @param {(action:string)=>void} emitAction
 * @param {{doubleClick?:boolean}} [o]  doubleClick false: no recenter on dblclick (the simulator: two quick trigger presses, an
 *   over-and-under double, are a double click and must not slide the crosshair to the centre; review I-01)
 * @returns {() => void} detach
 */
export function attachClickActions(target, emitAction, o = {}) {
  const withDouble = o.doubleClick !== false;
  if (!target || typeof target.addEventListener !== 'function') return () => {};
  const onDown = (ev) => {
    if (ev.button === 2) emitAction(ACTION.BACK);
    else if (ev.button === 1) {
      if (typeof ev.preventDefault === 'function') ev.preventDefault(); // no middle-click autoscroll
      emitAction(ACTION.PAUSE);
    }
  };
  const onDouble = () => {
    if (withDouble) emitAction(ACTION.RECENTER);
  };
  const onContext = (ev) => {
    if (typeof ev.preventDefault === 'function') ev.preventDefault();
  };
  target.addEventListener('pointerdown', onDown);
  target.addEventListener('dblclick', onDouble);
  target.addEventListener('contextmenu', onContext);
  return () => {
    target.removeEventListener('pointerdown', onDown);
    target.removeEventListener('dblclick', onDouble);
    target.removeEventListener('contextmenu', onContext);
  };
}
